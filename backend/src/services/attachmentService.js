import crypto from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB per file
export const MAX_ATTACHMENTS_PER_TICKET = 20;

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
  async upload({ workspaceId, ticketId, threadEntryId = null, fileName, contentType, buffer, uploadedBy = null, source = 'upload' }) {
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
      },
    });
    logger.info(`Attachment stored: ${safeName} (${buffer.length} bytes) → ${this.containerName()}/${blobName}`);
    return attachment;
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
      const entryIds = new Map(); // fs conversation external id -> thread entry id
      const rows = await prisma.ticketThreadEntry.findMany({
        where: { ticketId: ticket.id, externalEntryId: { in: conversations.map((c) => `fs-conversation:${c.id}`) } },
        select: { id: true, externalEntryId: true },
      });
      for (const r of rows) entryIds.set(r.externalEntryId, r.id);
      for (const conv of conversations) {
        const threadEntryId = entryIds.get(`fs-conversation:${conv.id}`) || null;
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
    const { default: mirrorService } = await import('./mirrorService.js');
    const client = await mirrorService.getInteractiveClient(ticket.workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');
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
    return buffer;
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
    return prisma.ticketAttachment.findMany({
      where: { ticketId, workspaceId },
      orderBy: { id: 'asc' },
      select: {
        id: true, fileName: true, contentType: true, sizeBytes: true,
        threadEntryId: true, source: true, uploadedBy: true, createdAt: true,
      },
    });
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

export default new AttachmentService();
