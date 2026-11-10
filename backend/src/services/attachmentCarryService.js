/**
 * Files follow the conversation (QA 11-09 #5).
 *
 * When one ticket is closed into another (automatic grouping, a manual merge,
 * a reply that arrived on the closed copy), the files the requester sent must
 * be on the ticket people keep working. Until now they stayed on the closed
 * copy: TP-born example, a screenshot sent with the second e-mail stayed on the
 * copy that grouping closed, and nobody working the surviving ticket saw it.
 *
 * Copies, never moves: the closed ticket keeps its own record, and a blob is
 * never shared between two rows (deleting from one ticket must not destroy the
 * other's file). attachmentService.copyToTicket does the byte copy.
 *
 * Idempotent: a file the surviving ticket already holds (same name and size)
 * is skipped, so a re-run, a retried merge or a second redirect of the same
 * reply never copies it twice. Signature logos (recurringImageService) are
 * left behind: they are on every e-mailed ticket and carry nothing.
 *
 * Never throws: every step is soft, a failed file is counted and logged.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import attachmentService from './attachmentService.js';
import { markRecurring } from './recurringImageService.js';

export const fileKey = (a) => `${String(a?.fileName || '').trim().toLowerCase()}|${Number(a?.sizeBytes) || 0}`;

const soft = (fn, fallback) => Promise.resolve().then(fn).catch((err) => {
  logger.warn(`Attachment carry step failed (non-fatal): ${err.message}`);
  return fallback;
});

/**
 * Copy files from one ticket onto another.
 *
 * @param {object} opts
 * @param {number} opts.workspaceId
 * @param {number} opts.fromTicketId   the ticket that was closed into the other
 * @param {number} opts.toTicketId     the ticket that survives
 * @param {object[]} [opts.attachments] the rows to carry (default: every file on fromTicketId)
 * @param {number|null} [opts.threadEntryId] attach every copy to this entry on the survivor
 * @param {(a: object) => number|null} [opts.entryFor] per-file entry on the survivor (wins over threadEntryId)
 * @param {string|null} [opts.uploadedBy]
 * @returns {Promise<{ ran: boolean, copied: object[], skipped: number, failed: number }>}
 *   `ran` is false when nothing could be tried (no storage configured, or the
 *   survivor's files could not be read); `failed` counts files that stayed behind.
 */
export async function carryAttachments({
  workspaceId, fromTicketId, toTicketId, attachments = null, threadEntryId = null, entryFor = null, uploadedBy = null,
} = {}) {
  const out = { ran: false, copied: [], skipped: 0, failed: 0 };
  if (!fromTicketId || !toTicketId || Number(fromTicketId) === Number(toTicketId)) return out;
  if (!attachmentService.isConfigured()) return out;
  out.ran = true;

  const source = Array.isArray(attachments)
    ? attachments
    : await soft(() => prisma.ticketAttachment.findMany({
      where: { ticketId: Number(fromTicketId), workspaceId: Number(workspaceId) },
      orderBy: { id: 'asc' },
    }), []);
  if (!source?.length) return out;

  const marked = await soft(() => markRecurring(workspaceId, source), source);
  const wanted = (marked || source).filter((a) => a && !a.recurring);
  out.skipped += source.length - wanted.length;
  if (!wanted.length) return out;

  const held = await soft(() => prisma.ticketAttachment.findMany({
    where: { ticketId: Number(toTicketId) },
    select: { fileName: true, sizeBytes: true },
  }), null);
  // Not knowing what the survivor holds means a re-run could double a file:
  // better to copy nothing now than to copy twice.
  if (!Array.isArray(held)) { out.ran = false; return out; }
  const have = new Set(held.map(fileKey));

  for (const a of wanted) {
    const key = fileKey(a);
    if (have.has(key)) { out.skipped += 1; continue; }
    const entryId = typeof entryFor === 'function' ? (entryFor(a) ?? threadEntryId) : threadEntryId;
    try {
      const row = await attachmentService.copyToTicket(a, { ticketId: Number(toTicketId), threadEntryId: entryId || null, uploadedBy });
      have.add(key);
      out.copied.push(row || { fileName: a.fileName, sizeBytes: a.sizeBytes });
    } catch (err) {
      out.failed += 1;
      logger.warn(`Attachment carry: ${a.fileName} from ticket ${fromTicketId} to ${toTicketId} failed (non-fatal): ${err.message}`);
    }
  }
  return out;
}

/**
 * Carry every file, then say so in one private note on the survivor that holds
 * them ("Files from TP-11639, which was combined into this ticket: …"). The
 * copies are made first and re-pointed at the note, so the note never names a
 * file that did not arrive, and a run with nothing new writes no note.
 *
 * @param {object} opts  as carryAttachments, plus
 * @param {string} opts.fromRef   the closed ticket's display ref
 * @param {string} [opts.how]     'combined' | 'merged'
 * @param {(text: string) => Promise<object|null>} opts.writeNote  writes the note; resolves to the entry (or { entry })
 */
export async function carryAttachmentsWithNote({ fromRef, how = 'combined', writeNote, ...opts } = {}) {
  const result = await carryAttachments({ ...opts, threadEntryId: null, entryFor: null });
  if (!result.copied.length || typeof writeNote !== 'function') return { ...result, entryId: null };
  const names = result.copied.map((r) => r.fileName).filter(Boolean);
  const text = `Files from ${fromRef}, which was ${how === 'merged' ? 'merged' : 'combined'} into this ticket: ${names.join(', ')}. They are attached to this note; ${fromRef} keeps its own copies.`;
  const written = await soft(() => writeNote(text), null);
  const entryId = written?.entry?.id ?? written?.id ?? null;
  const ids = result.copied.map((r) => r.id).filter(Number.isInteger);
  if (entryId && ids.length) {
    await soft(() => prisma.ticketAttachment.updateMany({ where: { id: { in: ids } }, data: { threadEntryId: entryId } }), null);
  }
  return { ...result, entryId };
}

export default { carryAttachments, carryAttachmentsWithNote, fileKey };
