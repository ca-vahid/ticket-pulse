/**
 * "Merge into one PDF" (QA 11-23 #5): several attachments on a ticket become
 * one PDF, built in the browser with pdf-lib and attached as a new file. The
 * originals stay. PDFs go in page by page; JPG and PNG pictures become a page
 * each, fitted to Letter or A4. pdf-lib is loaded only when someone merges.
 * 4.4.08: files are named as people see them (displayName, else fileName).
 */
import { attachmentName, shownFileName } from './attachmentNames';

export const MERGE_LIMIT_BYTES = 40 * 1024 * 1024;

// PDF points (1/72 inch).
export const PAGE_SIZES = {
  letter: { label: 'Letter', width: 612, height: 792 },
  a4: { label: 'A4', width: 595.28, height: 841.89 },
};
const PAGE_MARGIN = 36; // half an inch around a picture

/** Letter for North America, A4 everywhere else. */
export function defaultPageSize(locale = (typeof navigator !== 'undefined' ? navigator.language : '') || '') {
  return /-(US|CA|MX|PH|CL|CO|VE)$/i.test(String(locale)) ? 'letter' : 'a4';
}

/** 'pdf' | 'jpg' | 'png' | 'image' (a picture pdf-lib can't embed) | null, from what the server says. */
export function mergeKind(a) {
  const type = String(a?.contentType || '').toLowerCase();
  const name = String(a?.fileName || '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
  if (/^image\/(jpe?g|pjpeg)$/.test(type) || /\.(jpe?g|jfif)$/.test(name)) return 'jpg';
  if (type === 'image/png' || /\.png$/.test(name)) return 'png';
  if (/^image\//.test(type) || /\.(gif|webp|bmp|svg|heic|heif|avif|tiff?)$/.test(name)) return 'image';
  return null;
}

/** What the bytes really are, whatever the file is called. */
export function sniffKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  // A PDF may carry a few junk bytes before its header; readers allow 1 KB.
  const head = String.fromCharCode(...b.subarray(0, Math.min(b.length, 1024)));
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

const quoted = (name) => `“${name}”`;
const listNames = (items) => items.map((a) => shownFileName(a) || 'unnamed file').join(', ');
const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

/**
 * Why a selection can't be merged, in plain words, or null when it can.
 * Checked before anything is downloaded.
 */
export function mergeBlocker(items) {
  const list = items || [];
  if (list.length < 2) return null;
  const notPictures = list.filter((a) => mergeKind(a) === null);
  const otherPictures = list.filter((a) => mergeKind(a) === 'image');
  if (notPictures.length || otherPictures.length) {
    const parts = [];
    if (notPictures.length) parts.push(`Only PDFs and images can be merged. Take out ${listNames(notPictures)}.`);
    if (otherPictures.length) parts.push(`Pictures must be JPG or PNG. Take out ${listNames(otherPictures)}.`);
    return parts.join(' ');
  }
  const total = list.reduce((sum, a) => sum + (Number(a.sizeBytes) || 0), 0);
  if (total > MERGE_LIMIT_BYTES) {
    return `These files add up to ${mb(total)}. Merging is limited to ${mb(MERGE_LIMIT_BYTES)} in all, so take a file or two out.`;
  }
  return null;
}

/** "Merged - <first file name>.pdf", safe to save on any system. */
export function mergedFileName(firstName) {
  const base = String(firstName || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'attachments';
  return normalisePdfName(`Merged - ${base}`);
}

/** The name the agent typed, cleaned up and ending in .pdf; '' when nothing usable is left. */
export function normalisePdfName(raw) {
  const cleaned = String(raw || '')
    // eslint-disable-next-line no-control-regex -- strip control characters from a file name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.replace(/\.pdf$/i, '').replace(/^\.+/, '').trim();
  if (!base) return '';
  return `${base.slice(0, 180)}.pdf`;
}

export class MergeError extends Error {
  constructor(message, fileName = null) {
    super(message);
    this.name = 'MergeError';
    this.fileName = fileName;
  }
}

function fetchFailure(a, err) {
  const status = err?.response?.status;
  const why = status ? ` (server error ${status})` : '';
  return new MergeError(`${quoted(attachmentName(a))} could not be downloaded${why}, so nothing was merged. Try again, or take it out.`, shownFileName(a) || null);
}

/** A picture's size on the page: shrunk to fit inside the margins, never blown up. */
export function fitImage(imgWidth, imgHeight, pageSize) {
  const landscape = imgWidth > imgHeight;
  const pageW = landscape ? pageSize.height : pageSize.width;
  const pageH = landscape ? pageSize.width : pageSize.height;
  const scale = Math.min(1, (pageW - 2 * PAGE_MARGIN) / imgWidth, (pageH - 2 * PAGE_MARGIN) / imgHeight);
  const width = imgWidth * scale;
  const height = imgHeight * scale;
  return { pageW, pageH, width, height, x: (pageW - width) / 2, y: (pageH - height) / 2 };
}

/**
 * Build the merged PDF.
 * @param items    attachments in the agent's order
 * @param fetchBytes (a, { signal }) => ArrayBuffer
 * @param onProgress (done, total) after each file is downloaded
 * @returns { bytes: Uint8Array, pageCount }
 */
export async function buildMergedPdf(items, { fetchBytes, onProgress, signal, pageSize = 'letter', loadPdfLib } = {}) {
  const blocker = mergeBlocker(items);
  if (blocker) throw new MergeError(blocker);
  const lib = await (loadPdfLib ? loadPdfLib() : import('pdf-lib'));
  const { PDFDocument } = lib;
  const size = PAGE_SIZES[pageSize] || PAGE_SIZES.letter;

  // Download first, so a missing file stops us before any work.
  const files = [];
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (signal?.aborted) throw new MergeError('Merge cancelled. Nothing was attached.');
    const a = items[i];
    let buf;
    try {
      buf = await fetchBytes(a, { signal });
    } catch (err) {
      if (signal?.aborted) throw new MergeError('Merge cancelled. Nothing was attached.');
      throw fetchFailure(a, err);
    }
    const bytes = new Uint8Array(buf);
    total += bytes.byteLength;
    if (total > MERGE_LIMIT_BYTES) {
      throw new MergeError(`These files add up to more than ${mb(MERGE_LIMIT_BYTES)}, the limit for one merge. Take a file or two out.`);
    }
    files.push({ a, bytes });
    onProgress?.(i + 1, items.length);
  }

  const out = await PDFDocument.create();
  for (const { a, bytes } of files) {
    if (signal?.aborted) throw new MergeError('Merge cancelled. Nothing was attached.');
    const declared = mergeKind(a);
    const actual = sniffKind(bytes);
    if (declared === 'pdf' || actual === 'pdf') {
      if (actual !== 'pdf') throw new MergeError(`${quoted(attachmentName(a))} looks damaged: it is not a readable PDF, so nothing was merged.`, shownFileName(a) || null);
      let src;
      try {
        src = await PDFDocument.load(bytes, { updateMetadata: false });
      } catch (err) {
        if (isEncryptedError(err, lib)) {
          throw new MergeError(`${quoted(attachmentName(a))} is password-protected, so it can't be merged. Save a copy without the password, attach that, and merge again.`, shownFileName(a) || null);
        }
        throw new MergeError(`${quoted(attachmentName(a))} looks damaged and could not be read, so nothing was merged.`, shownFileName(a) || null);
      }
      try {
        const pages = await out.copyPages(src, src.getPageIndices());
        if (!pages.length) throw new Error('no pages');
        pages.forEach((p) => out.addPage(p));
      } catch {
        throw new MergeError(`${quoted(attachmentName(a))} looks damaged and its pages could not be copied, so nothing was merged.`, shownFileName(a) || null);
      }
    } else {
      const kind = actual || declared;
      let img;
      try {
        img = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      } catch {
        throw new MergeError(`${quoted(attachmentName(a))} looks damaged: the picture could not be read, so nothing was merged.`, shownFileName(a) || null);
      }
      const fit = fitImage(img.width, img.height, size);
      const page = out.addPage([fit.pageW, fit.pageH]);
      page.drawImage(img, { x: fit.x, y: fit.y, width: fit.width, height: fit.height });
    }
  }
  const bytes = await out.save();
  return { bytes, pageCount: out.getPageCount() };
}

function isEncryptedError(err, lib) {
  if (lib?.EncryptedPDFError && err instanceof lib.EncryptedPDFError) return true;
  return /encrypt/i.test(String(err?.message || ''));
}
