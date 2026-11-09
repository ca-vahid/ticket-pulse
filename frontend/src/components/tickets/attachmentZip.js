import { strToU8, zip } from 'fflate';

/**
 * "Download all" for the Attachments tab (QA 11-06 #5): fetch each listed file
 * through the normal authenticated download path, zip them in the browser and
 * save one .zip. No new endpoint — FreshService metadata-only rows are fetched
 * from FS by the same download route the single-file button uses.
 *
 * One file failing never sinks the zip: it is listed in missing-files.txt
 * inside the archive and returned to the caller to show on screen.
 */

export const MISSING_FILES_NAME = 'missing-files.txt';
// The zip is built in the browser's memory (UI Design review): ask above 200 MB,
// refuse above 1 GB, where a tab would run out of memory.
export const SIZE_CONFIRM_BYTES = 200 * 1024 * 1024;
export const SIZE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const ZIP_CONCURRENCY = 3;

// Formats that are already compressed: storing them (level 0) is as small and much faster.
const STORED_EXT = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif',
  'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'zst',
  'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'vsdx', 'odt', 'ods', 'odp', 'epub',
  'mp3', 'm4a', 'aac', 'ogg', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv',
]);

const extOf = (name) => (String(name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();

/** 0 for already-compressed types, 6 for everything else. */
export function compressionLevel(fileName, contentType = '') {
  if (STORED_EXT.has(extOf(fileName))) return 0;
  if (/^(video|audio)\//i.test(contentType)) return 0;
  if (/^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(contentType)) return 0;
  return 6;
}

// Characters Windows refuses in file names, plus control characters.
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name that is safe on Windows/macOS/Linux; `fallback` when nothing is left. */
export function sanitizeFileName(name, fallback = 'attachment', max = 150) {
  let s = String(name ?? '').replace(INVALID, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = fallback;
  if (s.length > max) {
    const e = extOf(s);
    const tail = e ? `.${e}` : '';
    s = `${s.slice(0, max - tail.length).replace(/[.\s]+$/, '')}${tail}`;
  }
  const stem = s.replace(/\.[^.]*$/, '');
  if (RESERVED.test(stem)) s = `_${s}`;
  return s;
}

/**
 * Entry names for the zip, in the order given: sanitized, and a clash gets
 * " (2)", " (3)"… before the extension (case-insensitive, as on Windows).
 * `reserved` names (missing-files.txt) are never handed out.
 */
export function uniqueZipNames(names, reserved = [MISSING_FILES_NAME]) {
  const taken = new Set(reserved.map((n) => n.toLowerCase()));
  return names.map((raw, i) => {
    const clean = sanitizeFileName(raw, `attachment-${i + 1}`);
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const tail = dot > 0 ? clean.slice(dot) : '';
    let candidate = clean;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${tail}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** "TP-11375 QA TEST - Macros Testing - attachments.zip" — Windows-safe and capped. */
export function zipFileName(ticketRef, subject) {
  const base = [ticketRef, subject].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  const suffix = ' - attachments';
  const head = sanitizeFileName(base, '', 120);
  return `${head ? `${head}${suffix}` : 'attachments'}.zip`;
}

function reasonOf(err) {
  const status = err?.response?.status;
  if (status === 404) return 'not found';
  if (status === 403) return 'not allowed';
  if (status) return `server error ${status}`;
  if (err?.code === 'ECONNABORTED') return 'timed out';
  return err?.message || 'could not be downloaded';
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data || []); // ArrayBuffer (any realm)
}

function zipMtime(at) {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1980 ? d : undefined;
}

function zipAsync(files, signal) {
  return new Promise((resolve, reject) => {
    const terminate = zip(files, (err, out) => (err ? reject(err) : resolve(out)));
    signal?.addEventListener('abort', () => {
      try { terminate?.(); } catch { /* already done */ }
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * Fetch every attachment (limited concurrency) and zip them.
 *
 * @param {object[]} attachments  rows with id, fileName, contentType, createdAt
 * @param {object}   opts
 * @param {(a, {signal}) => Promise<ArrayBuffer|Uint8Array|Blob>} opts.fetchBytes
 * @param {(done:number, total:number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ blob: Blob|null, included: string[], missing: {fileName, reason}[] }>}
 *   `blob` is null when nothing could be fetched.
 */
export async function buildAttachmentsZip(attachments, { fetchBytes, onProgress, signal, concurrency = ZIP_CONCURRENCY } = {}) {
  const list = [...attachments];
  const names = uniqueZipNames(list.map((a) => a.fileName));
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  onProgress?.(0, list.length);

  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      if (signal?.aborted) return;
      const a = list[i];
      try {
        results[i] = { ok: true, bytes: await toBytes(await fetchBytes(a, { signal })) };
      } catch (err) {
        if (signal?.aborted) return;
        results[i] = { ok: false, reason: reasonOf(err) };
      }
      done += 1;
      onProgress?.(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const files = {};
  const included = [];
  const missing = [];
  list.forEach((a, i) => {
    const r = results[i];
    if (r?.ok) {
      files[names[i]] = [r.bytes, { level: compressionLevel(a.fileName, a.contentType), mtime: zipMtime(a.createdAt) }];
      included.push(names[i]);
    } else {
      missing.push({ fileName: a.fileName || names[i], reason: r?.reason || 'could not be downloaded' });
    }
  });
  if (!included.length) return { blob: null, included, missing };

  if (missing.length) {
    const text = [
      `${missing.length} of ${list.length} attachments could not be included in this zip:`,
      '',
      ...missing.map((m) => `- ${m.fileName} (${m.reason})`),
      '',
      'Open the ticket and download these one at a time, or try "Download all" again later.',
      '',
    ].join('\r\n');
    // Re-wrap: TextEncoder can hand back another realm's Uint8Array, which fflate would read as a folder.
    files[MISSING_FILES_NAME] = [new Uint8Array(strToU8(text)), { level: 6 }];
  }

  const out = await zipAsync(files, signal);
  return { blob: new Blob([out], { type: 'application/zip' }), included, missing };
}
