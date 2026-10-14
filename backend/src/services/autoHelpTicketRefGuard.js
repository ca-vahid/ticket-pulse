/**
 * Auto-help guard R5: an answer to a requester never carries ANOTHER ticket's
 * reference (that would point them at somebody else's request).
 *
 * QA 10-13 #12 (TP-1888): the requester asked for access to project
 * "#2791 Wesdome Gold Mines - Kiena Mine"; the draft repeated the project
 * number and the old rule (any "#" + 4 digits or more) blocked it as "another
 * ticket (#2791)". A number is another ticket only when it really is one.
 *
 *   Written as        Blocked when
 *   ----------------  ----------------------------------------------------
 *   TP-1234           always, unless it is this ticket (our own format: it
 *                     can only mean a Ticket Pulse ticket, and a requester
 *                     who writes "include TP-1234" must not get it echoed)
 *   INC-1234, SR-1234 unless it is this ticket, or the requester wrote the
 *   "ticket #1234"    same number AND it is not a ticket in this workspace
 *   "ticket 1234"     (a vendor's case number they quoted themselves)
 *   #1234 (bare)      only when it is a ticket in this workspace other than
 *                     this one AND the requester did not write the number
 *                     themselves (a project, PO or invoice number they gave
 *                     us is theirs to hear back, even once a ticket with the
 *                     same number exists)
 *
 * "The requester wrote it" = the same digits stand alone in the subject, the
 * description or one of their replies.
 *
 * "Is a ticket in this workspace" needs a lookup (Ticket Pulse number or
 * FreshService id). When the lookup could not be made the guard fails closed:
 * every number is treated as a ticket, exactly the old behaviour.
 */
import prisma from './prisma.js';

const TP_FORM = /\bTP-(\d{1,7})\b/gi;
const EXPLICIT_FORMS = [
  { re: /\b(INC|SR)-(\d{3,12})\b/gi, group: 2, label: (n, m) => `${m[1].toUpperCase()}-${n}` },
  { re: /\bticket(?:\s+(?:number|no\.?|id|ref(?:erence)?))?\s*[:#]?\s*#?(\d{4,12})\b/gi, group: 1, label: (n) => `ticket #${n}` },
];
const BARE_HASH = /(?:^|[^\w&])#(\d{4,12})\b/g;

function standsAlone(text, digits) {
  if (!text || !digits) return false;
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(String(text));
}

function ownNumbers(ticket) {
  const own = new Set();
  if (!ticket) return own;
  if (ticket.nativeNumber !== null && ticket.nativeNumber !== undefined) own.add(String(ticket.nativeNumber));
  if (ticket.freshserviceTicketId !== null && ticket.freshserviceTicketId !== undefined) own.add(String(ticket.freshserviceTicketId));
  return own;
}

/** Every number the text writes in a form the guard has to judge with a lookup. */
export function ticketLikeNumbers(text) {
  const plain = String(text || '');
  const out = new Set();
  for (const form of EXPLICIT_FORMS) for (const m of plain.matchAll(form.re)) out.add(m[form.group]);
  for (const m of plain.matchAll(BARE_HASH)) out.add(m[1]);
  return [...out];
}

/**
 * Which of these numbers are real tickets in the workspace, other than this
 * ticket. Returns a Set of digit strings, or null when the lookup failed (the
 * guard then treats every number as a ticket).
 */
export async function resolveOtherTicketNumbers(workspaceId, numbers, ticketId = null) {
  const list = [...new Set((numbers || []).map((n) => String(n)).filter((n) => /^\d{1,12}$/.test(n)))].slice(0, 40);
  if (!list.length) return new Set();
  if (!workspaceId) return null;
  try {
    const ints = list.filter((n) => n.length <= 9).map((n) => Number(n));
    const rows = await prisma.ticket.findMany({
      where: {
        workspaceId,
        ...(ticketId ? { id: { not: ticketId } } : {}),
        OR: [
          ...(ints.length ? [{ nativeNumber: { in: ints } }] : []),
          { freshserviceTicketId: { in: list.map((n) => BigInt(n)) } },
        ],
      },
      select: { nativeNumber: true, freshserviceTicketId: true },
      take: 80,
    });
    if (!Array.isArray(rows)) return null;
    const found = new Set();
    for (const r of rows) {
      if (r.nativeNumber !== null && r.nativeNumber !== undefined && list.includes(String(r.nativeNumber))) found.add(String(r.nativeNumber));
      if (r.freshserviceTicketId !== null && r.freshserviceTicketId !== undefined && list.includes(String(r.freshserviceTicketId))) found.add(String(r.freshserviceTicketId));
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * The other-ticket references an answer carries.
 *
 * @param {object} p
 * @param {string} p.text the answer as the requester would read it (subject + plain body)
 * @param {object|null} p.ticket this ticket ({ nativeNumber, freshserviceTicketId })
 * @param {string} [p.requesterText] the requester's own words (subject, description, replies)
 * @param {Set<string>|null} [p.otherTicketNumbers] numbers known to be other tickets
 *   in this workspace; null/undefined = not looked up (every number is then a ticket)
 * @returns {string[]} references to block, in the order of the table above
 */
export function otherTicketRefs({ text, ticket = null, requesterText = '', otherTicketNumbers = null } = {}) {
  const plain = String(text || '');
  const own = ownNumbers(ticket);
  const echoed = (n) => standsAlone(requesterText, n);
  // No lookup = fail closed: every number counts as a ticket.
  const isOtherTicket = (n) => (otherTicketNumbers ? otherTicketNumbers.has(n) : true);
  const refs = [];

  for (const m of plain.matchAll(TP_FORM)) {
    if (!own.has(m[1])) refs.push(`TP-${m[1]}`);
  }
  const judged = new Set();
  for (const form of EXPLICIT_FORMS) {
    for (const m of plain.matchAll(form.re)) {
      const n = m[form.group];
      judged.add(n);
      if (own.has(n)) continue;
      if (echoed(n) && !isOtherTicket(n)) continue;
      refs.push(form.label(n, m));
    }
  }
  for (const m of plain.matchAll(BARE_HASH)) {
    const n = m[1];
    if (judged.has(n)) continue; // already judged in its explicit form
    if (own.has(n) || echoed(n) || !isOtherTicket(n)) continue;
    refs.push(`#${n}`);
  }
  return refs;
}

export default { otherTicketRefs, ticketLikeNumbers, resolveOtherTicketNumbers };
