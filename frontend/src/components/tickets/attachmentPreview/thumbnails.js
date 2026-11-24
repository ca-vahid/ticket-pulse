/**
 * Attachment thumbnails (24 Nov 2026). The Attachments tab's grid showed a
 * picture for images and only an icon for everything else; this draws a
 * small first-page preview for PDFs (pdf.js), Word .docx (mammoth), sheets
 * (SheetJS), plain text and attached e-mails.
 *
 * - Bytes come from the same authenticated download route as the preview
 *   and "Download all" (ticketsAPI.attachmentBytes), cancellable.
 * - At most THUMB_CONCURRENCY builds run at once; the rest wait their turn.
 * - Files over THUMB_MAX_BYTES are never fetched (the icon stays).
 * - Results (failures too) live in a small in-memory LRU for the page
 *   session, so a filter or tab switch never re-fetches.
 * - Word HTML is cut to its first blocks and sanitised with DOMPurify
 *   (a short allow list, no attributes) before it is ever stored; the other
 *   kinds are plain text rendered by React.
 *
 * Every parser is a lazy chunk, so none of this weighs on the ticket page.
 */
import DOMPurify from 'dompurify';
import { ticketsAPI } from '../../../services/api';

// 4 MB (UI Design, 24 Nov 2026): a thumbnail downloads the whole file, so big scans keep the icon.
export const THUMB_MAX_BYTES = 4 * 1024 * 1024;
export const THUMB_CONCURRENCY = 2;
export const THUMB_CACHE_SIZE = 50;

const PDF_CSS_WIDTH = 320; // the widest grid card is about 330 CSS px
const PDF_MAX_DPR = 2;
const SHEET_ROWS = 6;
const SHEET_COLS = 5;
const TEXT_HEAD_BYTES = 8192;
const TEXT_LINES = 14;
const DOC_BLOCKS = 12;
const DOC_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'br', 'table', 'thead', 'tbody', 'tr', 'td', 'th'];

const SHEET_EXT = new Set(['xlsx', 'xls', 'csv', 'tsv', 'ods']);
const TEXT_EXT = new Set(['txt', 'log', 'json', 'xml', 'md', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'sql', 'ps1', 'bat', 'sh', 'ics']);
const SHEET_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const TEXT_TYPES = new Set(['text/plain', 'application/json', 'application/xml', 'text/xml']);

const extOf = (name) => (String(name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();

/** Which thumbnail an attachment gets, or null for the plain icon. */
export function thumbKind(a) {
  const type = String(a?.contentType || a?.mimeType || '').toLowerCase().split(';')[0].trim();
  const e = extOf(a?.fileName);
  if (e === 'pdf' || type === 'application/pdf') return 'pdf';
  if (e === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (SHEET_EXT.has(e) || SHEET_TYPES.has(type)) return 'sheet';
  if (e === 'eml' || e === 'msg' || type === 'message/rfc822') return 'email';
  if (TEXT_EXT.has(e) || TEXT_TYPES.has(type)) return 'text';
  return null;
}

/** True when a thumbnail may be fetched at all (known kind, not over the size cap). */
/** The device asked to save data (mobile data saver): no thumbnails, icons only. */
export function saveDataOn() {
  try { return Boolean(globalThis.navigator?.connection?.saveData); } catch { return false; }
}

export function canThumb(a) {
  return Boolean(thumbKind(a)) && !(Number(a?.sizeBytes) > THUMB_MAX_BYTES) && !saveDataOn();
}

// ---- cache (LRU by insertion order of a Map) --------------------------------

const cache = new Map();
const pending = new Map();
const keyOf = (ticketId, a) => `${ticketId}:${a?.id}`;

function revoke(entry) {
  if (entry?.url) { try { URL.revokeObjectURL(entry.url); } catch { /* already gone */ } }
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > THUMB_CACHE_SIZE) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    revoke(old);
  }
}

/** The cached thumbnail, if any (refreshes its place in the LRU). */
export function peekThumb(ticketId, a) {
  const key = keyOf(ticketId, a);
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

// ---- queue ------------------------------------------------------------------

let active = 0;
const waiting = [];

const abortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

function drain() {
  while (active < THUMB_CONCURRENCY && waiting.length) waiting.shift().start();
}

function schedule(run, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const job = {
      start() {
        signal.removeEventListener('abort', onAbort);
        active += 1;
        Promise.resolve()
          .then(run)
          .then(resolve, reject)
          .finally(() => { active -= 1; drain(); });
      },
    };
    function onAbort() {
      const i = waiting.indexOf(job);
      if (i >= 0) { waiting.splice(i, 1); reject(abortError()); }
    }
    signal.addEventListener('abort', onAbort, { once: true });
    waiting.push(job);
    drain();
  });
}

/** Test hook: forget every cached thumbnail and queued job. */
export function resetThumbnails() {
  cache.forEach(revoke);
  cache.clear();
  pending.forEach((p) => p.controller.abort());
  pending.clear();
  waiting.length = 0;
  active = 0;
}

// ---- builders ---------------------------------------------------------------

function throwIfAborted(signal) {
  if (signal.aborted) throw abortError();
}

async function pdfThumb(buf, signal) {
  const { openPdf } = await import('./pdfjsLoader');
  throwIfAborted(signal);
  const task = openPdf(new Uint8Array(buf));
  let renderTask = null;
  const onAbort = () => { renderTask?.cancel?.(); task.destroy?.(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    throwIfAborted(signal);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, PDF_MAX_DPR);
    const viewport = page.getViewport({ scale: (PDF_CSS_WIDTH * dpr) / Math.max(1, base.width) });
    // Only the top of the page is ever shown, so draw no more than a square.
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(Math.min(viewport.height, viewport.width)));
    const ctx = canvas.getContext?.('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    throwIfAborted(signal);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0; // free the bitmap now
    canvas.height = 0;
    if (!blob) throw new Error('No image');
    throwIfAborted(signal);
    return { kind: 'pdf', url: URL.createObjectURL(blob) };
  } finally {
    signal.removeEventListener('abort', onAbort);
    task.destroy?.();
  }
}

/** First top-level blocks of some HTML, then sanitised (the last step, always). */
export function docxPreviewHtml(html) {
  const tpl = document.createElement('template'); // inert: nothing loads or runs
  tpl.innerHTML = String(html || '');
  const kept = [...tpl.content.childNodes]
    .filter((n) => n.nodeType === 1 || String(n.textContent || '').trim())
    .slice(0, DOC_BLOCKS);
  const box = document.createElement('div');
  kept.forEach((n) => box.appendChild(n));
  return DOMPurify.sanitize(box.innerHTML, { ALLOWED_TAGS: DOC_TAGS, ALLOWED_ATTR: [] });
}

async function docxThumb(buf) {
  const { default: mammoth } = await import('mammoth/mammoth.browser');
  const converted = await mammoth.convertToHtml({ arrayBuffer: buf });
  const html = docxPreviewHtml(converted?.value);
  const probe = document.createElement('template');
  probe.innerHTML = html;
  if (!String(probe.content.textContent || '').trim()) throw new Error('Empty document');
  return { kind: 'docx', html };
}

async function sheetThumb(buf) {
  const XLSX = await import('xlsx');
  // sheetRows stops SheetJS from reading past the top of a big sheet.
  const wb = XLSX.read(buf, { type: 'array', sheetRows: SHEET_ROWS * 3 });
  const sheet = wb?.Sheets?.[wb?.SheetNames?.[0]];
  if (!sheet) throw new Error('No sheet');
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: false }) || [];
  const rows = raw
    .map((r) => (Array.isArray(r) ? r : []).slice(0, SHEET_COLS).map((c) => String(c ?? '').trim().slice(0, 40)))
    .filter((r) => r.some(Boolean))
    .slice(0, SHEET_ROWS);
  const cols = rows.reduce((n, r) => Math.max(n, r.reduce((m, c, i) => (c ? i + 1 : m), 0)), 0);
  if (!rows.length || !cols) throw new Error('Empty sheet');
  return { kind: 'sheet', rows: rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] || '')) };
}

function textThumb(buf) {
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, TEXT_HEAD_BYTES));
  const utf16 = head[0] === 0xff && head[1] === 0xfe;
  const decoded = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(head);
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded; // drop a byte-order mark
  if (text.includes(String.fromCharCode(0))) throw new Error('Binary file');
  const lines = text.split(/\r?\n/).slice(0, TEXT_LINES).map((l) => l.replace(/\t/g, '  ').slice(0, 160));
  if (!lines.join('').trim()) throw new Error('Empty file');
  return { kind: 'text', text: lines.join('\n') };
}

function htmlToText(html) {
  // A DOMParser document has no browsing context: no scripts, no requests.
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('style, script, head').forEach((n) => n.remove());
  return doc.body?.innerText || doc.body?.textContent || '';
}

async function emailThumb(buf) {
  const { parseEmailFile } = await import('./parseEmail');
  const mail = await parseEmailFile(buf);
  const body = String(mail?.text || '').trim() || htmlToText(mail?.html);
  const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 10).map((s) => s.slice(0, 160));
  const subject = String(mail?.subject || '').trim().slice(0, 160);
  if (!subject && !lines.length) throw new Error('Empty e-mail');
  return { kind: 'email', subject, from: String(mail?.from || '').slice(0, 120), text: lines.join('\n') };
}

const BUILDERS = { pdf: pdfThumb, docx: docxThumb, sheet: sheetThumb, text: textThumb, email: emailThumb };

async function buildThumb(ticketId, a, signal) {
  const kind = thumbKind(a);
  const buf = await ticketsAPI.attachmentBytes(ticketId, a.id, { signal });
  throwIfAborted(signal);
  if (!buf || !(buf.byteLength > 0) || buf.byteLength > THUMB_MAX_BYTES) throw new Error('Not previewable');
  const result = await BUILDERS[kind](buf, signal);
  if (signal.aborted) { revoke(result); throw abortError(); }
  return result;
}

/**
 * Load (or reuse) one attachment's thumbnail. Resolves to
 * { kind: 'pdf', url } | { kind: 'docx', html } | { kind: 'sheet', rows }
 * | { kind: 'text', text } | { kind: 'email', subject, from, text }
 * | { kind: 'none' } (could not be built: show the icon). Rejects only with an
 * AbortError when `signal` fires; the build itself is cancelled once nobody
 * is waiting for it any more.
 */
export function loadThumb(ticketId, a, { signal } = {}) {
  if (!canThumb(a)) return Promise.resolve({ kind: 'none' });
  const key = keyOf(ticketId, a);
  const hit = peekThumb(ticketId, a);
  if (hit) return Promise.resolve(hit);

  let job = pending.get(key);
  if (!job) {
    const controller = new AbortController();
    job = { controller, refs: 0 };
    const current = job;
    job.promise = schedule(() => buildThumb(ticketId, a, controller.signal), controller.signal)
      .then(
        (result) => { remember(key, result); return result; },
        () => {
          if (controller.signal.aborted) throw abortError();
          // Any failure means "show the icon" — and don't try again this session.
          const none = { kind: 'none' };
          remember(key, none);
          return none;
        },
      )
      .finally(() => { if (pending.get(key) === current) pending.delete(key); });
    pending.set(key, job);
  }

  const shared = job;
  shared.refs += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      shared.refs -= 1;
      if (shared.refs <= 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
    };
    if (signal) {
      if (signal.aborted) { release(); reject(abortError()); return; }
      signal.addEventListener('abort', () => { release(); reject(abortError()); }, { once: true });
    }
    shared.promise.then(
      (value) => { settled = true; resolve(value); },
      (err) => { settled = true; reject(err); },
    );
  });
}
