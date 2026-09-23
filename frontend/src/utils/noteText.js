/**
 * Plain-text notes as people read them (23 Sep 2026).
 *
 * Approval notes were stored with HTML entities left in the plain text —
 * "storage -&nbsp; instead of ordering …" — and every place that shows the
 * text (the ticket's approval card, the Approvals page) printed them as-is.
 * Decode the entities (twice over, for "&amp;nbsp;"), turn non-breaking
 * spaces into spaces, and tidy the whitespace without losing line breaks.
 */
const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeOnce(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key.startsWith('#x')) { const cp = parseInt(key.slice(2), 16); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; }
    if (key.startsWith('#')) { const cp = parseInt(key.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; }
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : whole;
  });
}

export function cleanNoteText(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  for (let i = 0; i < 2 && /&(#x?[0-9a-f]+|[a-z]+);/i.test(s); i += 1) s = decodeOnce(s);
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default cleanNoteText;
