import crypto from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors.js';
import { fsGate } from './fsModeService.js';
import { fsConversationEntryIdCandidates, parseFsConversationId } from '../utils/fsEntryId.js';
import { markRecurring } from './recurringImageService.js';
import { NAME_SELECT, withNameFields } from './attachmentNamingRules.js';

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB per file
// 100 since QA 11-16: inbound mail (signature logos, forwarded chains) filled 20 on its own,
// and a full ticket now refuses the agent's whole message up front (draft kept) instead of
// silently dropping the files, so 20 would have blocked any file on those tickets.
export const MAX_ATTACHMENTS_PER_TICKET = 100;
// A FreshService-only file asked for after the workspace was switched off (FreshService exit A1).
export const FS_OFF_FILE_MESSAGE = 'This file was never copied from FreshService, and FreshService is off for this workspace.';

// Executables and scripts are refused outright — everything else is stored
// as-is and always served with download disposition (never rendered inline).
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jar', 'dll', 'sh',
]);

function fileExtension(name) {
  const idx = String(name || '').lastIndexOf('.');
  return idx >= 0 ? String(name).slice(idx + 1).toLowerCase() : '';
}

function sanitizeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  return base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 200) || 'file';
}

/**
 * Ticket attachments on Azure Blob Storage.
 *
 * Dev/prod isolation: one storage account, separate PRIVATE containers —
 * `attachments-prod` when NODE_ENV=production, `attachments-dev` otherwise
 * (overridable via ATTACHMENT_CONTAINER). Public blob access is disabled at
 * the account level; every download streams through the authenticated API.
 */
class AttachmentService {
  constructor() {
    this._containerClient = null;
  }

  /** The per-ticket cap, read by callers that check room before a message stores files. */
  get maxAttachmentsPerTicket() {
    return MAX_ATTACHMENTS_PER_TICKET;
  }

  isConfigured() {
    return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);
  }

  containerName() {
    return process.env.ATTACHMENT_CONTAINER
      || (process.env.NODE_ENV === 'production' ? 'attachments-prod' : 'attachments-dev');
  }

  _container() {
    if (this._containerClient) return this._containerClient;
    if (!this.isConfigured()) {
      throw new ValidationError('Attachment storage is not configured (AZURE_STORAGE_CONNECTION_STRING)');
    }
    const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    this._containerClient = service.getContainerClient(this.containerName());
    return this._containerClient;
  }

  validateUpload({ fileName, sizeBytes }) {
    const ext = fileExtension(fileName);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new ValidationError(`.${ext} files are not allowed as attachments`);
    }
    if (!sizeBytes || sizeBytes <= 0) throw new ValidationError('Empty file');
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError(`Attachments are limited to ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
    }
  }

  /**
   * Store a buffer and record the attachment row.
   * Blob path: ws-<workspaceId>/ticket-<ticketId>/<random>-<safe-name>
   */
  async upload({ workspaceId, ticketId, threadEntryId = null, fileName, contentType, buffer, uploadedBy = null, source = 'upload', names = null }) {
    const safeName = sanitizeFileName(fileName);
    this.validateUpload({ fileName: safeName, sizeBytes: buffer?.length || 0 });

    const count = await prisma.ticketAttachment.count({ where: { ticketId } });
    if (count >= MAX_ATTACHMENTS_PER_TICKET) {
      throw new ValidationError(`A ticket can hold at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`);
    }

    const blobName = `ws-${workspaceId}/ticket-${ticketId}/${crypto.randomBytes(8).toString('hex')}-${safeName}`;
    const blockBlob = this._container().getBlockBlobClient(blobName);
    await blockBlob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType || 'application/octet-stream',
        blobContentDisposition: `attachment; filename="${safeName.replace(/"/g, '')}"`,
      },
    });

    const attachment = await prisma.ticketAttachment.create({
      data: {
        workspaceId,
        ticketId,
        threadEntryId,
        fileName: safeName,
        contentType: contentType || 'application/octet-stream',
        sizeBytes: buffer.length,
        blobName,
        source,
        uploadedBy,
        // A merge/split copy keeps the file's display name (4.4.08 review).
        ...(names?.nameSource ? {
          displayName: names.displayName ?? null,
          nameSource: names.nameSource,
          nameDetails: names.nameDetails ?? undefined,
          namedAt: names.namedAt ?? null,
          namedBy: names.namedBy ?? null,
        } : {}),
      },
    });
    logger.info(`Attachment stored: ${safeName} (${buffer.length} bytes) → ${this.containerName()}/${blobName}`);
    return attachment;
  }

  /**
   * Copy an attachment onto another ticket as an independent row + blob
   * (QA 09-15 #2: a split carries the parent's description attachments to the
   * child). Blob names are unique per row, so a copy — never a shared blob —
   * keeps deletes local to one ticket. FS-ingested rows fetch their bytes on
   * demand exactly as a download would.
   */
  async copyToTicket(attachment, { ticketId, threadEntryId = null, uploadedBy = null }) {
    let buffer;
    try {
      const response = await this._container().getBlockBlobClient(attachment.blobName).download();
      buffer = await streamToBuffer(response.readableStreamBody);
    } catch (err) {
      if (attachment.source === 'freshservice' && err?.statusCode === 404) {
        buffer = await this._fetchAndCacheFsAttachment(attachment);
      } else {
        throw err;
      }
    }
    return this.upload({
      workspaceId: attachment.workspaceId,
      ticketId,
      threadEntryId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      buffer,
      uploadedBy,
      source: 'copy',
      // The copy shows the same name as the original (and a Revert there still
      // gives back the vendor's original file name).
      names: attachment.nameSource ? {
        displayName: attachment.displayName,
        nameSource: attachment.nameSource,
        nameDetails: attachment.nameDetails,
        namedAt: attachment.namedAt,
        namedBy: attachment.namedBy,
      } : null,
    });
  }

  // ---- FreshService attachment ingestion (QA 07-08) ----------------------
  // FS attachments were never synced: FS-born tickets showed "Attachments (0)"
  // while the FS side had files. Sync time records METADATA only (FS's
  // attachment_url is a short-lived signed link, and eagerly downloading every
  // file for every synced ticket would be wasteful); the first download
  // fetches a fresh URL from FS, caches the bytes in blob storage, and streams.

  /**
   * Record an FS attachment as a metadata-only row. blobName doubles as the
   * dedupe key (`fs/ws-<ws>/att-<fsId>-<name>`), so re-syncs are no-ops.
   * Returns the row, or null when skipped (duplicate / blocked type).
   */
  async ingestFreshServiceAttachment({ workspaceId, ticketId, threadEntryId = null, fsAttachment }) {
    const fsId = Number(fsAttachment?.id);
    if (!fsId) return null;
    const safeName = sanitizeFileName(fsAttachment.name);
    if (BLOCKED_EXTENSIONS.has(fileExtension(safeName))) return null;
    const blobName = `fs/ws-${workspaceId}/att-${fsId}-${safeName}`.slice(0, 500);
    // FreshService's copy of a file an agent uploaded in Ticket Pulse (the reply
    // or note was mirrored to FS, the conversation sync brings it back) is the
    // same file — the message already has it. Same entry + name + size = skip
    // (2 Oct 2026: 73 messages showed every pasted picture twice).
    if (threadEntryId) {
      const twin = await prisma.ticketAttachment.findFirst({
        where: { threadEntryId, fileName: safeName, sizeBytes: Number(fsAttachment.size) || 0 },
        select: { id: true },
      }).catch(() => null);
      if (twin) return null;
    }
    try {
      return await prisma.ticketAttachment.create({
        data: {
          workspaceId,
          ticketId,
          threadEntryId,
          fileName: safeName,
          contentType: fsAttachment.content_type || 'application/octet-stream',
          sizeBytes: Number(fsAttachment.size) || 0,
          blobName,
          source: 'freshservice',
          uploadedBy: null,
        },
      });
    } catch (err) {
      if (err?.code === 'P2002') return null; // already ingested
      logger.warn(`FS attachment ingest failed for ticket ${ticketId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Ingest every attachment from an FS ticket detail + its conversations.
   * Conversation files attach to their thread entry (rendered inline in the
   * conversation); ticket-level files attach to the ticket itself.
   */
  async ingestForFsTicket(ticket, { fsTicket = null, conversations = null } = {}) {
    let ingested = 0;
    for (const att of (fsTicket?.attachments || [])) {
      const row = await this.ingestFreshServiceAttachment({
        workspaceId: ticket.workspaceId, ticketId: ticket.id, fsAttachment: att,
      });
      if (row) ingested += 1;
    }
    if (Array.isArray(conversations) && conversations.length) {
      // Keyed by the FS conversation id so rows on either stamp (canonical
      // `fs-conversation:` or legacy `fs-conv-`, Phase DR1) link their files.
      const entryIds = new Map(); // fs conversation id (string) -> thread entry id
      const rows = await prisma.ticketThreadEntry.findMany({
        where: {
          ticketId: ticket.id,
          externalEntryId: { in: conversations.flatMap((c) => (c?.id ? fsConversationEntryIdCandidates(c.id) : [])) },
        },
        select: { id: true, externalEntryId: true },
      });
      for (const r of rows) {
        const convId = parseFsConversationId(r.externalEntryId);
        if (convId && !entryIds.has(convId)) entryIds.set(convId, r.id);
      }
      for (const conv of conversations) {
        const threadEntryId = entryIds.get(String(conv.id)) || null;
        for (const att of (conv.attachments || [])) {
          const row = await this.ingestFreshServiceAttachment({
            workspaceId: ticket.workspaceId, ticketId: ticket.id, threadEntryId, fsAttachment: att,
          });
          if (row) ingested += 1;
        }
      }
    }
    return ingested;
  }

  /**
   * Resolve a fresh signed URL for an FS attachment (they expire quickly) by
   * re-reading the ticket and, if needed, its conversations.
   */
  async _resolveFsAttachmentUrl(attachment) {
    const fsAttId = Number((attachment.blobName.match(/\/att-(\d+)-/) || [])[1]);
    if (!fsAttId) throw new NotFoundError('FreshService attachment reference is malformed');
    const ticket = await prisma.ticket.findUnique({
      where: { id: attachment.ticketId },
      select: { freshserviceTicketId: true, workspaceId: true },
    });
    if (!ticket?.freshserviceTicketId) throw new NotFoundError('Ticket has no FreshService copy');
    const client = await this._fsClientFor(ticket.workspaceId);
    const fsTicketId = Number(ticket.freshserviceTicketId);
    const detail = await client.getTicket(fsTicketId);
    const fsTicket = detail?.ticket || detail;
    let found = (fsTicket?.attachments || []).find((a) => Number(a.id) === fsAttId);
    if (!found && attachment.threadEntryId) {
      const conversations = await client.fetchTicketConversations(fsTicketId, { maxEntries: 100 });
      for (const conv of (conversations || [])) {
        found = (conv.attachments || []).find((a) => Number(a.id) === fsAttId);
        if (found) break;
      }
    }
    if (!found?.attachment_url) throw new NotFoundError('Attachment no longer exists in FreshService');
    return found.attachment_url;
  }

  /**
   * The interactive FreshService client for a workspace, or a 409 when the
   * workspace is switched off (FreshService exit A1): a file that was never
   * copied into Ticket Pulse cannot be fetched any more. Shadow counts it.
   */
  async _fsClientFor(workspaceId) {
    if (!(await fsGate(workspaceId, 'attachment'))) throw new ConflictError(FS_OFF_FILE_MESSAGE);
    const { default: mirrorService } = await import('./mirrorService.js');
    const client = await mirrorService.getInteractiveClient(workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');
    return client;
  }

  /**
   * Download and store every FreshService-only file of ONE ticket, while
   * FreshService still answers (FreshService exit A3: adoption pre-stores the
   * adopted tickets' files, which would otherwise die with FreshService).
   * Best effort: one ticket read (plus its conversations when a file sits on
   * one), then one download per file not yet in storage; a failure is counted,
   * never thrown. Returns { total, stored, alreadyStored, failed }.
   */
  async storeFsAttachmentsForTicket(ticketId) {
    const out = { total: 0, stored: 0, alreadyStored: 0, failed: 0 };
    if (!this.isConfigured()) return { ...out, skipped: 'storage_not_configured' };
    const rows = await prisma.ticketAttachment.findMany({
      where: { ticketId: Number(ticketId), source: 'freshservice' },
      orderBy: { id: 'asc' },
    });
    out.total = rows.length;
    if (rows.length === 0) return out;

    const missing = [];
    for (const row of rows) {
      let exists = false;
      try {
        exists = await this._container().getBlockBlobClient(row.blobName).exists();
      } catch { /* treat as missing */ }
      if (exists) out.alreadyStored += 1;
      else missing.push(row);
    }
    if (missing.length === 0) return out;

    let urls;
    try {
      urls = await this._fsAttachmentUrlsForTicket(Number(ticketId), missing.some((r) => r.threadEntryId));
    } catch (err) {
      logger.warn(`FS attachment pre-store for ticket ${ticketId} could not read FreshService: ${err.message}`);
      out.failed = missing.length;
      return { ...out, error: err.message };
    }
    const { default: axios } = await import('axios');
    for (const row of missing) {
      const fsAttId = Number((String(row.blobName).match(/\/att-(\d+)-/) || [])[1]);
      const url = urls.get(fsAttId);
      if (!url) { out.failed += 1; continue; }
      try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_ATTACHMENT_BYTES });
        await this._storeFsBytes(row, Buffer.from(response.data));
        out.stored += 1;
      } catch (err) {
        out.failed += 1;
        logger.warn(`FS attachment pre-store failed for "${row.fileName}" (id ${row.id}): ${err.message}`);
      }
    }
    logger.info(`FS attachments pre-stored for ticket ${ticketId}: ${out.stored} stored, ${out.alreadyStored} already stored, ${out.failed} failed`);
    return out;
  }

  /**
   * How many FreshService-hosted files in a workspace have NO stored copy in
   * Ticket Pulse (FreshService exit preflight: these die with FreshService).
   * "Stored" is the test openDownload/bufferFor use: a blob exists under the
   * row's blobName. One database query for the rows, then the stored blobs are
   * LISTED per `fs/ws-<n>/` prefix (one paged listing, not a call per file).
   * No FreshService call. Without blob storage nothing can be stored, so every
   * row counts.
   */
  async countUnstoredFsAttachments(workspaceId) {
    const rows = await prisma.ticketAttachment.findMany({
      where: { workspaceId: Number(workspaceId), source: 'freshservice' },
      select: { blobName: true },
    });
    if (rows.length === 0) return 0;
    if (!this.isConfigured()) return rows.length;
    const prefixes = new Set();
    for (const r of rows) {
      const m = String(r.blobName || '').match(/^(fs\/ws-[^/]+\/)/);
      prefixes.add(m ? m[1] : 'fs/');
    }
    const stored = new Set();
    const container = this._container();
    for (const prefix of prefixes) {
      for await (const item of container.listBlobsFlat({ prefix })) stored.add(item.name);
    }
    return rows.filter((r) => !stored.has(r.blobName)).length;
  }

  /** fsAttachmentId -> fresh signed URL, for every file on the FS ticket (and its conversations). */
  async _fsAttachmentUrlsForTicket(ticketId, withConversations) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { freshserviceTicketId: true, workspaceId: true },
    });
    if (!ticket?.freshserviceTicketId) throw new NotFoundError('Ticket has no FreshService copy');
    const client = await this._fsClientFor(ticket.workspaceId);
    const fsTicketId = Number(ticket.freshserviceTicketId);
    const urls = new Map();
    const detail = await client.getTicket(fsTicketId);
    for (const a of ((detail?.ticket || detail)?.attachments || [])) if (a?.attachment_url) urls.set(Number(a.id), a.attachment_url);
    if (withConversations) {
      const conversations = await client.fetchTicketConversations(fsTicketId, { maxEntries: 500 });
      for (const conv of (conversations || [])) {
        for (const a of (conv?.attachments || [])) if (a?.attachment_url) urls.set(Number(a.id), a.attachment_url);
      }
    }
    return urls;
  }

  /**
   * Download the FS file (signed URL needs no FS auth) and cache it in blob
   * storage so subsequent downloads never touch FS again.
   */
  async _fetchAndCacheFsAttachment(attachment) {
    const url = await this._resolveFsAttachmentUrl(attachment);
    const { default: axios } = await import('axios');
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: MAX_ATTACHMENT_BYTES,
    });
    const buffer = Buffer.from(response.data);
    await this._storeFsBytes(attachment, buffer);
    return buffer;
  }

  /** Cache an FS file's bytes under its row's blob name (and fill a missing size). */
  async _storeFsBytes(attachment, buffer) {
    const blockBlob = this._container().getBlockBlobClient(attachment.blobName);
    await blockBlob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: attachment.contentType || 'application/octet-stream',
        blobContentDisposition: `attachment; filename="${attachment.fileName.replace(/"/g, '')}"`,
      },
    });
    if (!attachment.sizeBytes && buffer.length) {
      await prisma.ticketAttachment.update({
        where: { id: attachment.id }, data: { sizeBytes: buffer.length },
      }).catch(() => {});
    }
    logger.info(`FS attachment cached: ${attachment.fileName} (${buffer.length} bytes) → ${attachment.blobName}`);
  }

  // ---- Scheduled-ticket staging (gap plan 2 P2) --------------------------
  // Files uploaded before the ticket exists: blob lives under a schedule
  // prefix; at activation the SAME blob is adopted by a real attachment row.

  async stageForSchedule({ workspaceId, scheduledTicketId, fileName, contentType, buffer, uploadedBy = null }) {
    const safeName = sanitizeFileName(fileName);
    this.validateUpload({ fileName: safeName, sizeBytes: buffer?.length || 0 });
    const count = await prisma.scheduledTicketAttachment.count({ where: { scheduledTicketId } });
    if (count >= MAX_ATTACHMENTS_PER_TICKET) {
      throw new ValidationError(`A scheduled ticket can hold at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`);
    }
    const blobName = `ws-${workspaceId}/scheduled-${scheduledTicketId}/${crypto.randomBytes(8).toString('hex')}-${safeName}`;
    const blockBlob = this._container().getBlockBlobClient(blobName);
    await blockBlob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType || 'application/octet-stream',
        blobContentDisposition: `attachment; filename="${safeName.replace(/"/g, '')}"`,
      },
    });
    return prisma.scheduledTicketAttachment.create({
      data: {
        workspaceId,
        scheduledTicketId,
        fileName: safeName,
        contentType: contentType || 'application/octet-stream',
        sizeBytes: buffer.length,
        blobName,
        uploadedBy,
      },
    });
  }

  async listStaged(scheduledTicketId, workspaceId) {
    return prisma.scheduledTicketAttachment.findMany({
      where: { scheduledTicketId, workspaceId },
      orderBy: { id: 'asc' },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
    });
  }

  async removeStaged(id, scheduledTicketId, workspaceId) {
    const row = await prisma.scheduledTicketAttachment.findFirst({ where: { id, scheduledTicketId, workspaceId } });
    if (!row) throw new NotFoundError('Staged attachment not found');
    await this._container().getBlockBlobClient(row.blobName).deleteIfExists().catch(() => {});
    await prisma.scheduledTicketAttachment.delete({ where: { id: row.id } });
    return { deleted: true };
  }

  /** Activation: staged files become real attachments on the created ticket (same blob). */
  async adoptStaged(scheduledTicketId, ticketId, workspaceId) {
    const staged = await prisma.scheduledTicketAttachment.findMany({ where: { scheduledTicketId, workspaceId } });
    const adopted = [];
    for (const row of staged) {
      const attachment = await prisma.ticketAttachment.create({
        data: {
          workspaceId,
          ticketId,
          fileName: row.fileName,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          blobName: row.blobName,
          source: 'scheduled',
          uploadedBy: row.uploadedBy,
        },
      });
      adopted.push(attachment);
    }
    if (staged.length) {
      await prisma.scheduledTicketAttachment.deleteMany({ where: { scheduledTicketId } });
    }
    return adopted;
  }

  /** Cancel/delete cleanup: remove staged blobs + rows. */
  async discardStaged(scheduledTicketId, workspaceId) {
    const staged = await prisma.scheduledTicketAttachment.findMany({ where: { scheduledTicketId, workspaceId } });
    for (const row of staged) {
      await this._container().getBlockBlobClient(row.blobName).deleteIfExists().catch(() => {});
    }
    if (staged.length) await prisma.scheduledTicketAttachment.deleteMany({ where: { scheduledTicketId } });
    return { discarded: staged.length };
  }

  async listForTicket(ticketId, workspaceId) {
    const rows = await prisma.ticketAttachment.findMany({
      where: { ticketId, workspaceId },
      orderBy: { id: 'asc' },
      select: {
        id: true, fileName: true, contentType: true, sizeBytes: true,
        threadEntryId: true, source: true, uploadedBy: true, createdAt: true,
        ...NAME_SELECT,
      },
    });
    // Signature logos seen on many tickets carry `recurring: true` (19 Oct 2026).
    // 4.4.08: displayName / originalName / nameSource / nameDetails on every row.
    return (await markRecurring(workspaceId, rows)).map(withNameFields);
  }

  /** One stored file's bytes (blob, or FreshService on first use). Null when gone. */
  async bufferFor(attachment) {
    if (!attachment?.blobName || !this.isConfigured()) return null;
    try {
      return await this._container().getBlockBlobClient(attachment.blobName).downloadToBuffer();
    } catch (err) {
      if (attachment.source === 'freshservice' && err?.statusCode === 404) {
        return this._fetchAndCacheFsAttachment(attachment).catch(() => null);
      }
      logger.warn(`Attachment ${attachment.id} bytes unavailable: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch stored attachment bytes for a single thread entry as in-memory buffers.
   * Used by the FreshService mirror to re-attach TP-born reply/note files to the
   * FS copy (the original multer buffers are long gone by the time the async
   * mirror job runs). Best-effort: a blob that fails to download is skipped.
   */
  async buffersForThreadEntry(threadEntryId) {
    if (!this.isConfigured()) return [];
    const rows = await prisma.ticketAttachment.findMany({
      where: { threadEntryId },
      orderBy: { id: 'asc' },
      select: { id: true, fileName: true, contentType: true, blobName: true },
    });
    const out = [];
    for (const row of rows) {
      try {
        const buffer = await this._container().getBlockBlobClient(row.blobName).downloadToBuffer();
        out.push({ filename: row.fileName, buffer, contentType: row.contentType });
      } catch (err) {
        logger.warn(`Mirror attachment fetch failed for "${row.fileName}" (id ${row.id}): ${err.message}`);
      }
    }
    return out;
  }

  /**
   * Delete every attachment attached to a thread entry (blobs + rows). Used when
   * an admin deletes a note — the caller has already authorized the action, so
   * no per-file permission check here. Best-effort on the blob side.
   */
  async removeForThreadEntry(threadEntryId, workspaceId) {
    const rows = await prisma.ticketAttachment.findMany({
      where: { threadEntryId, workspaceId },
      select: { id: true, blobName: true, fileName: true },
    });
    for (const row of rows) {
      if (this.isConfigured()) {
        try {
          await this._container().getBlockBlobClient(row.blobName).deleteIfExists();
        } catch (err) {
          logger.warn(`Blob delete failed for "${row.fileName}" (id ${row.id}): ${err.message}`);
        }
      }
    }
    if (rows.length > 0) {
      await prisma.ticketAttachment.deleteMany({ where: { threadEntryId, workspaceId } });
    }
    return rows.length;
  }

  /** Authenticated download: returns the row + a readable stream from Blob. */
  async openDownload(attachmentId, ticketId, workspaceId) {
    const attachment = await prisma.ticketAttachment.findFirst({
      where: { id: attachmentId, ticketId, workspaceId },
    });
    if (!attachment) throw new NotFoundError('Attachment not found');
    const blob = this._container().getBlockBlobClient(attachment.blobName);
    try {
      const response = await blob.download();
      return { attachment, stream: response.readableStreamBody };
    } catch (err) {
      // FS-ingested rows are metadata-only until first download — fetch a
      // fresh signed URL from FreshService, cache the bytes, then serve.
      if (attachment.source === 'freshservice' && err?.statusCode === 404) {
        const buffer = await this._fetchAndCacheFsAttachment(attachment);
        const { Readable } = await import('node:stream');
        return { attachment, stream: Readable.from(buffer) };
      }
      // The row exists but the file is gone from storage: an ordinary
      // "not found", not a crash (2 Oct 2026: two "consider restarting" lines).
      if (err?.statusCode === 404) throw new NotFoundError('This attachment is no longer in storage');
      throw err;
    }
  }

  async remove(attachmentId, ticketId, workspaceId, actor) {
    const attachment = await prisma.ticketAttachment.findFirst({
      where: { id: attachmentId, ticketId, workspaceId },
    });
    if (!attachment) throw new NotFoundError('Attachment not found');
    const isUploader = actor?.email && attachment.uploadedBy === actor.email;
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isUploader && !isAdmin) {
      throw new ValidationError('Only the uploader or an admin can remove an attachment');
    }
    await this._container().getBlockBlobClient(attachment.blobName).deleteIfExists();
    await prisma.ticketAttachment.delete({ where: { id: attachment.id } });
    logger.info(`Attachment removed: ${attachment.fileName} (id ${attachment.id}) by ${actor?.email || 'unknown'}`);
    return { removed: true };
  }
}

const attachmentService = new AttachmentService();

/** FreshService exit A3: pre-store one ticket's FreshService-only files (see the method). */
export function storeFsAttachmentsForTicket(ticketId) {
  return attachmentService.storeFsAttachmentsForTicket(ticketId);
}

/** FreshService exit preflight: FS-hosted files in the workspace with no stored copy. */
export function countUnstoredFsAttachments(workspaceId) {
  return attachmentService.countUnstoredFsAttachments(workspaceId);
}

export default attachmentService;
