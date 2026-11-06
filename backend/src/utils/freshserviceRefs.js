/**
 * FreshService ticket numbers as they appear in mail (IT intake plan, 12 Oct 2026).
 *
 * The it@ inbox carries three shapes: `[INC-243414]`, `[#SR-246489]` and `[#246332]`
 * (FreshService notification subjects are `[{{ticket.id}}] {{ticket.subject}}`), plus the older
 * "Ticket #12345". The same number appears with both prefixes, so the number alone names the ticket.
 *
 * 6 Nov 2026: a FreshService workspace can number its tickets with its own prefix — Accounting's
 * is `[CASE-251037]`. Such prefixes are read ONLY where that workspace says it uses them
 * (`extraPrefixes`, from the `fs_ticket_prefixes_ws<N>` setting): vendors put their own
 * "Case #CASE-249123" in subjects, and IT's FreshService ids sit in the same range, so reading
 * CASE everywhere would thread a Microsoft or Dell case mail onto an unrelated IT ticket.
 * Returns distinct numbers in the order they appear.
 */
const BASE_PATTERNS = [
  /\[#?(?:INC|SR|CHN|PRB|REL)-(\d{4,})\]/gi,
  /(?<![\w-])#(?:INC|SR)-(\d{4,})\b/gi,
  /\[#(\d{4,})\]/g,
  /\bTicket\s*#(\d{4,})\b/gi,
];

const PREFIX_RE = /^[A-Z]{2,10}$/;

/** A workspace prefix list ("CASE" or "CASE, REQ") → clean upper-case prefixes. */
export function parseTicketPrefixes(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
  return [...new Set(list.map((p) => String(p || '').trim().toUpperCase()).filter((p) => PREFIX_RE.test(p)))];
}

export function freshserviceTicketNumbers(text, { extraPrefixes = [] } = {}) {
  const s = String(text || '');
  const prefixes = parseTicketPrefixes(extraPrefixes);
  // Only the bracketed form FreshService itself writes ([CASE-n], [#CASE-n]) for a workspace prefix.
  const patterns = prefixes.length
    ? [...BASE_PATTERNS, new RegExp(`\\[#?(?:${prefixes.join('|')})-(\\d{4,})\\]`, 'gi')]
    : BASE_PATTERNS;
  const found = [];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) found.push({ at: m.index, n: Number(m[1]) });
  }
  found.sort((a, b) => a.at - b.at);
  const out = [];
  for (const f of found) if (Number.isSafeInteger(f.n) && f.n > 0 && !out.includes(f.n)) out.push(f.n);
  return out;
}

export default freshserviceTicketNumbers;
