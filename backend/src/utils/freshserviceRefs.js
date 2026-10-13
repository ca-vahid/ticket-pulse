/**
 * FreshService ticket numbers as they appear in mail (IT intake plan, 12 Oct 2026).
 *
 * The it@ inbox carries three shapes: `[INC-243414]`, `[#SR-246489]` and `[#246332]`
 * (FreshService notification subjects are `[{{ticket.id}}] {{ticket.subject}}`), plus the older
 * "Ticket #12345". The same number appears with both prefixes, so the number alone names the ticket.
 * Returns distinct numbers in the order they appear.
 */
const PATTERNS = [
  /\[#?(?:INC|SR|CHN|PRB|REL)-(\d{4,})\]/gi,
  /(?<![\w-])#(?:INC|SR)-(\d{4,})\b/gi,
  /\[#(\d{4,})\]/g,
  /\bTicket\s*#(\d{4,})\b/gi,
];

export function freshserviceTicketNumbers(text) {
  const s = String(text || '');
  const found = [];
  for (const re of PATTERNS) {
    for (const m of s.matchAll(re)) found.push({ at: m.index, n: Number(m[1]) });
  }
  found.sort((a, b) => a.at - b.at);
  const out = [];
  for (const f of found) if (Number.isSafeInteger(f.n) && f.n > 0 && !out.includes(f.n)) out.push(f.n);
  return out;
}

export default freshserviceTicketNumbers;
