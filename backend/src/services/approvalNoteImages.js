import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Pictures in an approval request (19 Oct 2026). A picture pasted into "Why
 * are you asking" is uploaded to the ticket, and the note keeps only the text
 * "[Image: pasted-image-1.png]". Before this, the approver's e-mail, the
 * magic-link page and the Teams card all showed that text and no picture.
 * These helpers find the files a note names and put each picture back in place.
 */

// "[Image: a.png]", "[Image:&nbsp;a.png]", optionally wrapped in the <i>/<em> the composer adds.
const MARKER_SRC = String.raw`\[Image:(?:\s|&nbsp;|&#160;)*([^\]<]+?)\]`;
const WRAPPED_RE = new RegExp(String.raw`(?:<(i|em)>\s*)?${MARKER_SRC}(?:\s*</(?:i|em)>)?`, 'gi');
const PLAIN_RE = new RegExp(MARKER_SRC, 'gi');
export const MAX_NOTE_IMAGES = 6;

// The API's public origin: Teams fetches the pictures from there. The same settings as
// graphSubscriptionService.notificationBaseUrl (not imported: it pulls in the Graph client).
const PROD_API_ORIGIN = 'https://api.ticketpulse.bgcsaas.com';
export function apiPublicOrigin(env = process.env) {
  const explicit = String(env.PUBLIC_API_URL || env.GRAPH_NOTIFICATION_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return env.NODE_ENV === 'production' ? PROD_API_ORIGIN : '';
}

const clean = (name) => String(name || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').trim().toLowerCase();
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lower-cased file names the note refers to, in order, without repeats. */
export function noteImageNames(...bodies) {
  const out = [];
  for (const body of bodies) {
    for (const m of String(body || '').matchAll(PLAIN_RE)) {
      const name = clean(m[1]);
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * The ticket's image files the note names. Every request re-uses
 * "pasted-image-1.png", so for each name we take the newest copy uploaded by the
 * time the request was made (the composer uploads just before it asks).
 */
export async function findNoteImages(approval) {
  const names = noteImageNames(approval?.requestNote, approval?.requestNoteHtml);
  if (!names.length || !approval?.ticketId) return [];
  let rows = [];
  try {
    rows = await prisma.ticketAttachment.findMany({
      where: { ticketId: approval.ticketId, workspaceId: approval.workspaceId, contentType: { startsWith: 'image/', mode: 'insensitive' } },
      orderBy: { id: 'asc' },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, blobName: true, source: true, createdAt: true },
    });
  } catch (err) {
    logger.warn(`Approval ${approval.id}: note pictures unavailable (${err.message})`);
    return [];
  }
  const askedAt = approval.createdAt ? new Date(approval.createdAt).getTime() + 2 * 60 * 1000 : Infinity;
  const out = [];
  for (const name of names.slice(0, MAX_NOTE_IMAGES)) {
    const same = rows.filter((r) => clean(r.fileName) === name);
    if (!same.length) continue;
    const before = same.filter((r) => new Date(r.createdAt).getTime() <= askedAt);
    out.push({ ...(before.length ? before[before.length - 1] : same[same.length - 1]), name });
  }
  return out;
}

/**
 * The note as HTML with each "[Image: name]" replaced by the picture.
 * `srcFor(image)` gives the src; `widthFor(image)` an optional pixel width
 * (Outlook ignores max-width, so e-mail passes one). Markers whose file was not
 * found stay as text.
 */
export function noteHtmlWithImages(noteHtml, noteText, images = [], { srcFor, widthFor = null } = {}) {
  const base = noteHtml || (noteText ? escapeHtml(noteText).replace(/\n/g, '<br>') : '');
  if (!base || !images.length) return base;
  const byName = new Map(images.map((img) => [img.name, img]));
  return base.replace(WRAPPED_RE, (whole, _tag, rawName) => {
    const img = byName.get(clean(rawName));
    const src = img ? srcFor(img) : null;
    if (!src) return whole;
    const width = widthFor ? widthFor(img) : null;
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(img.fileName)}"${width ? ` width="${width}"` : ''}`
      + ' style="display:block;max-width:100%;height:auto;margin:6px 0;border:1px solid #e2e8f0;border-radius:6px;">';
  });
}

/**
 * Replace each "[Image: name]" marker (with its <i>/<em> wrapper) by what `replacer(name)` returns;
 * a null return keeps the marker. `name` is cleaned and lower-cased, as noteImageNames gives it.
 */
export function replaceImageMarkers(html, replacer) {
  return String(html || '').replace(WRAPPED_RE, (whole, _tag, rawName) => {
    const out = replacer(clean(rawName));
    return out === null || out === undefined ? whole : out;
  });
}

/** Plain text for previews (Teams, phone): each marker becomes "(picture)". */
export function noteTextForPreview(text) {
  const out = String(text || '').replace(PLAIN_RE, '(picture)').replace(/[ \t]{2,}/g, ' ').trim();
  return out || null;
}

/** Note text with the markers taken out (the pictures are shown on their own). */
export function noteTextWithoutMarkers(text) {
  return String(text || '').replace(PLAIN_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Token-gated address of one note picture, on the API host (absolute when it is known). */
export function noteImagePath(token, imageId, { absolute = false } = {}) {
  const path = `/api/ticket-approvals/public/${encodeURIComponent(token)}/image/${Number(imageId)}`;
  if (!absolute) return path;
  const origin = apiPublicOrigin();
  return origin ? `${origin}${path}` : null;
}

/** The raw token at the end of a decision link (…/approval/<token>), or null. */
export function tokenFromDecisionUrl(url) {
  const m = /\/approval\/([^/?#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Pixel width of a PNG, GIF or JPEG, read from its header. Null when unknown. */
export function imagePixelWidth(buffer) {
  const b = buffer;
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return b.readUInt32BE(16);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return b.readUInt16LE(6);
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return b.readUInt16BE(i + 7);
      i += 2 + len;
    }
  }
  return null;
}

export default {
  noteImageNames, findNoteImages, noteHtmlWithImages, replaceImageMarkers, noteTextForPreview, noteTextWithoutMarkers,
  noteImagePath, tokenFromDecisionUrl, imagePixelWidth, MAX_NOTE_IMAGES,
};
