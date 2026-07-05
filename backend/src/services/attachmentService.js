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
    const response = await blob.download();
    return { attachment, stream: response.readableStreamBody };
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
