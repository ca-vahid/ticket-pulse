import prisma from './prisma.js';
import logger from '../utils/logger.js';
import attachmentService from './attachmentService.js';
import { noteImageNames, replaceImageMarkers, imagePixelWidth } from './approvalNoteImages.js';
import { inlinePhotoAttachment } from './userPhotoService.js';

/**
 * Pictures inside reply e-mails (23 Oct 2026). A picture pasted into the reply box, or into a
 * mail we received, is kept on the ticket as a file, and the body keeps only "[Image: name]".
 * The ticket page puts the picture back; the e-mail to the requester showed the bare text — a
 * signature logo in the quoted history, a screenshot in the agent's own answer. Here each marker
 * becomes the picture itself, carried inside the message (cid:), so Outlook shows it without a
 * "download pictures" bar. The quoted history's avatars use the person's Entra photo the same way.
 *
 * One budget per e-mail: when it runs out, the rest stay as text (and the reply's own files still
 * go as ordinary attachments). Never throws: a picture that cannot be had costs the picture only.
 */
export const INLINE_BUDGET_BYTES = Math.floor(2.5 * 1024 * 1024);
export const MAX_PICTURE_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_PICTURES = 12;
export const MAX_FACES = 8;
export const FACE_SIZE = '96x96';
const FACE_TIMEOUT_MS = 4000;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (name) => String(name || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').trim().toLowerCase();

/** A fresh budget for one e-mail. `inline` collects the attachments to send; `reused` maps the reply's own file ids to their cid. */
export function createInlineBudget() {
  return { used: 0, pictures: 0, seq: 0, inline: [], reused: new Map(), faces: new Map(), files: null };
}

function take(budget, bytes) {
  if (budget.pictures >= MAX_PICTURES || bytes > MAX_PICTURE_BYTES || budget.used + bytes > INLINE_BUDGET_BYTES) return false;
  budget.used += bytes;
  budget.pictures += 1;
  return true;
}

/** The ticket's image files, read once per e-mail. */
async function ticketImageFiles(budget, ticketId) {
  if (budget.files) return budget.files;
  budget.files = [];
  if (!ticketId || !prisma.ticketAttachment?.findMany) return budget.files;
  try {
    budget.files = await prisma.ticketAttachment.findMany({
      where: { ticketId, contentType: { startsWith: 'image/', mode: 'insensitive' } },
      orderBy: { id: 'asc' },
      take: 300,
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, blobName: true, source: true, threadEntryId: true, createdAt: true },
    }) || [];
  } catch (err) {
    logger.debug(`Reply pictures: files of ticket ${ticketId} unavailable (${err.message})`);
  }
  return budget.files;
}

/**
 * The file a message's "[Image: name]" means. "pasted-image-1.png" comes back in every reply, so
 * the file kept with that message wins; then the newest copy stored by the time it was written.
 */
export function pickPicture(files, name, { entryId = null, at = null } = {}) {
  const same = (files || []).filter((f) => clean(f.fileName) === name);
  if (!same.length) return null;
  if (entryId !== null && entryId !== undefined) {
    const own = same.filter((f) => f.threadEntryId === entryId);
    if (own.length) return own[own.length - 1];
  }
  const limit = at ? new Date(at).getTime() + 2 * 60 * 1000 : Infinity;
  const before = same.filter((f) => !f.createdAt || new Date(f.createdAt).getTime() <= limit);
  return before.length ? before[before.length - 1] : null;
}

function pictureTag(cid, alt, buffer, maxWidth) {
  const natural = imagePixelWidth(buffer);
  // Outlook ignores max-width, so a wide screenshot needs a width of its own.
  const width = natural ? Math.min(natural, maxWidth) : null;
  return `<img src="cid:${cid}" alt="${escapeHtml(alt)}"${width ? ` width="${width}"` : ''}`
    + ' style="display:block;max-width:100%;height:auto;margin:6px 0;border:0;">';
}

/**
 * `html` with each "[Image: name]" it can afford replaced by the picture. `own` is the reply's
 * own files ({ attachment, buffer }): those are already going out as attachments, so they are
 * marked inline (budget.reused) instead of being sent twice.
 */
export async function inlinePictures(html, { budget, ticketId, entryId = null, at = null, own = [], maxWidth = 600 } = {}) {
  const source = String(html || '');
  if (!budget || !/\[Image:/i.test(source)) return source;
  const names = noteImageNames(source);
  const chosen = new Map();
  for (const name of names) {
    try {
      const mine = own.find((f) => clean(f?.attachment?.fileName) === name && f.buffer);
      if (mine) {
        const known = budget.reused.get(mine.attachment.id);
        if (known) { chosen.set(name, pictureTag(known, mine.attachment.fileName, mine.buffer, maxWidth)); continue; }
        if (!take(budget, mine.buffer.length)) continue;
        budget.seq += 1;
        const cid = `tp-pic-${budget.seq}`;
        budget.reused.set(mine.attachment.id, cid);
        chosen.set(name, pictureTag(cid, mine.attachment.fileName, mine.buffer, maxWidth));
        continue;
      }
      const file = pickPicture(await ticketImageFiles(budget, ticketId), name, { entryId, at });
      if (!file) continue;
      if (file.sizeBytes && file.sizeBytes > MAX_PICTURE_BYTES) continue;
      const already = budget.inline.find((a) => a.fileId === file.id);
      if (already) { chosen.set(name, pictureTag(already.contentId, file.fileName, already.buffer, maxWidth)); continue; }
      const buffer = await attachmentService.bufferFor(file);
      if (!buffer || !buffer.length || !take(budget, buffer.length)) continue;
      budget.seq += 1;
      const cid = `tp-pic-${budget.seq}`;
      budget.inline.push({
        fileId: file.id,
        buffer,
        name: file.fileName,
        contentType: file.contentType || 'image/png',
        contentBytes: buffer.toString('base64'),
        contentId: cid,
      });
      chosen.set(name, pictureTag(cid, file.fileName, buffer, maxWidth));
    } catch (err) {
      logger.debug(`Reply pictures: "${name}" left as text (${err.message})`);
    }
  }
  if (!chosen.size) return source;
  return replaceImageMarkers(source, (name) => chosen.get(name) ?? null);
}

/** The cid of the person's Entra photo, added to the budget once per address; null without one. */
export async function faceFor(budget, email) {
  const address = String(email || '').trim().toLowerCase();
  if (!budget || !address.includes('@')) return null;
  if (budget.faces.has(address)) return budget.faces.get(address);
  budget.faces.set(address, null);
  if (budget.faces.size > MAX_FACES) return null;
  try {
    const cid = `tp-face-${budget.faces.size}`;
    const photo = await Promise.race([
      inlinePhotoAttachment(address, cid, { size: FACE_SIZE }),
      new Promise((resolve) => { setTimeout(() => resolve(null), FACE_TIMEOUT_MS).unref?.(); }),
    ]);
    if (!photo?.contentBytes) return null;
    const bytes = Math.ceil(photo.contentBytes.length * 0.75);
    if (budget.used + bytes > INLINE_BUDGET_BYTES) return null;
    budget.used += bytes;
    budget.inline.push({ name: photo.name, contentType: photo.contentType, contentBytes: photo.contentBytes, contentId: cid });
    budget.faces.set(address, cid);
    return cid;
  } catch {
    return null;
  }
}

/** The attachments to send for the pictures and photos the budget took (the reply's own files excluded). */
export function inlineAttachments(budget) {
  return (budget?.inline || []).map(({ name, contentType, contentBytes, contentId }) => ({ name, contentType, contentBytes, contentId }));
}

export default { createInlineBudget, pickPicture, inlinePictures, faceFor, inlineAttachments };
