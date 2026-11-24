/**
 * Attachment names (4.4.08): e-mailed documents on Accounting tickets get a
 * readable name ("Acme Supplies_INV-100234_2026_11_23.pdf"). The file in
 * storage keeps its original name; `displayName` is what people see and the
 * name a download is saved under. These helpers are the one place that
 * decides which name to show.
 */

/** The name to show and to save a download under. */
export function attachmentName(a) {
  const shown = String(a?.displayName || '').trim();
  return shown || a?.fileName || a?.originalName || 'attachment';
}

/** displayName || fileName, '' when the file has neither (callers pick their own fallback). */
export function shownFileName(a) {
  return String(a?.displayName || '').trim() || a?.fileName || '';
}

/** The original name, when the file shows under a different one; else null. */
export function originalNameIfRenamed(a) {
  const shown = String(a?.displayName || '').trim();
  const original = a?.originalName || a?.fileName || '';
  if (!shown || !original || shown === original) return null;
  return original;
}

/** A file that shows under a new name can be put back to its original. */
export function canRevertName(a) {
  return Boolean(originalNameIfRenamed(a));
}

/** { base, ext } — ext keeps its dot (".pdf"), '' when the name has none. */
export function splitExtension(name) {
  const s = String(name || '');
  const m = s.match(/^(.*[^.\s])(\.[a-z0-9]{1,8})$/i);
  return m ? { base: m[1], ext: m[2] } : { base: s, ext: '' };
}

// What Windows refuses in a file name (the server strips the same set).
const ILLEGAL = /[\\/:*?"<>|]/g;
// eslint-disable-next-line no-control-regex -- control characters are refused too
const CONTROL = /[\u0000-\u001f\u007f]/;
export const NAME_MAX = 120;

/**
 * Why a typed name (without its extension) can't be saved, in plain words, or
 * null when it can.
 */
export function nameProblem(base) {
  const s = String(base ?? '').trim();
  if (!s) return 'Type a name for the file.';
  const bad = [...new Set(s.match(ILLEGAL) || [])];
  if (bad.length) {
    const list = bad.length === 1 ? bad[0] : `${bad.slice(0, -1).join(' ')} or ${bad[bad.length - 1]}`;
    return `File names can't contain ${list}. Take ${bad.length === 1 ? 'it' : 'them'} out.`;
  }
  if (CONTROL.test(s)) return 'The name has a hidden character in it. Retype it.';
  if (/^\.+$/.test(s)) return 'Type a name, not just dots.';
  if (s.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters or fewer (it has ${s.length}).`;
  return null;
}

/**
 * The full name to save: the typed base (an extension typed again is dropped)
 * plus the file's own extension, which can't be changed.
 */
export function composeName(base, ext) {
  let s = String(base ?? '').replace(/\s+/g, ' ').trim();
  if (ext && s.toLowerCase().endsWith(ext.toLowerCase())) s = s.slice(0, -ext.length).trim();
  return `${s}${ext || ''}`;
}

const METHOD_WORDS = {
  rules: 'from the e-mail subject, sender and file name',
  ai: 'by reading the document',
  'rules+ai': 'from the e-mail, checked by reading the document',
};

/** "Nov 23, 2026" from "2026-11-23" (a calendar date, so no time-zone shift). */
function fmtDocDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The hover text for "named automatically": vendor, number, date and how it was found. */
export function namedAutomaticallyTitle(a) {
  const d = a?.nameDetails && typeof a.nameDetails === 'object' ? a.nameDetails : {};
  const parts = [
    d.vendor ? `Vendor: ${d.vendor}` : null,
    d.invoiceNumber ? `Number: ${d.invoiceNumber}` : null,
    fmtDocDate(d.documentDate) ? `Dated ${fmtDocDate(d.documentDate)}` : (d.dateFrom === 'received' ? 'Date: when the e-mail arrived' : null),
    METHOD_WORDS[d.method] ? `Found ${METHOD_WORDS[d.method]}` : null,
  ].filter(Boolean);
  return parts.length ? `Named automatically. ${parts.join(' · ')}` : 'Named automatically from the e-mail.';
}

/** The name fields to lay over an attachment after a rename / revert answer. */
export function nameFieldsFrom(data, fallback) {
  const src = data && typeof data === 'object' ? data : {};
  const pick = (k) => (Object.prototype.hasOwnProperty.call(src, k) ? src[k] : fallback[k]);
  return {
    displayName: pick('displayName') ?? null,
    nameSource: pick('nameSource') ?? null,
    nameDetails: pick('nameDetails') ?? null,
    ...(src.originalName ? { originalName: src.originalName } : {}),
  };
}
