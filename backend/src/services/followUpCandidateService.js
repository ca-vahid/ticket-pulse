import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { referenceIdentities } from '../utils/subjectIdentity.js';

/**
 * "Looks like a follow-up to an existing ticket" (11 Nov 2026).
 *
 * Following up on an existing case belongs on that case's ticket; when the
 * ticket is closed, somebody decides whether it reopens. Before a mail that
 * matched nothing becomes a NEW ticket, the ingest asks here whether a ticket
 * about the same matter already exists, open or closed. If one does, the mail
 * is held (reason `possible_follow_up`) with the candidates, for Mail review.
 *
 * A ticket is a candidate when, in the same workspace and created or active in
 * the last 120 days, it has
 *   (a) the same normalised subject, with an "N Days" count masked, so
 *       "Reminder: 105 Days Outstanding Invoice - X" and "… 175 Days … - X"
 *       are the same matter; or
 *   (b) a long reference number in its subject that the mail's subject also
 *       carries (an invoice, a PO, a dashed invoice number such as
 *       2-756-67291; utils/subjectIdentity.js referenceIdentities). A project
 *       number (2000010.02.11) is not one: a project carries many matters.
 * Never a candidate: deleted and spam tickets, tickets of the onboarding /
 * offboarding process, and tickets whose top-level category is Security.
 *
 * (c) Invoice match, Live only (24 Nov 2026, invoiceMatchService): the caller
 *     passes `invoiceMatches`, open tickets that already hold a document with
 *     the same invoice number from the same vendor. Each is a candidate (rule
 *     `same_invoice`), listed first and the best guess: it is a hard link, the
 *     same document on an open ticket.
 *
 * Read-only. Never throws: a failed lookup is "no candidates", and the mail
 * goes on to become a ticket as before.
 */
export const FOLLOW_UP_WINDOW_DAYS = 120;
export const FOLLOW_UP_MAX_CANDIDATES = 6;
const MIN_SUBJECT_KEY = 10;
const MAX_NUMBERS = 5;
const FETCH = 80;
const DAY_COUNT = /\b\d{1,4}\s+days?\b/g;
const DAY_MASK = '# days';
// The subjects the onboarding engine (and the account script) gives its tickets.
const FAMILY_SUBJECT = /^\s*(child ticket\b|nh\s+(laptop|workstation)\s*-)/i;
const NOT_OPEN = ['resolved', 'closed'];

const soft = (fn, fallback) => Promise.resolve().then(fn).catch(() => fallback);

/** The subject as a follow-up key: the caller's normalised subject with the day count masked. */
export function followUpSubjectKey(normalizedSubject) {
  return String(normalizedSubject || '').toLowerCase().replace(DAY_COUNT, DAY_MASK).replace(/\s+/g, ' ').trim();
}

/** The longest stretch of the key that holds no masked part: what the database is asked to find. */
function searchFragment(key) {
  return key.split(DAY_MASK).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0] || '';
}

function isSecurity(ticket) {
  const top = ticket.internalCategory?.parent?.name || ticket.internalCategory?.name || '';
  return [top, ticket.category].some((v) => String(v || '').trim().toLowerCase() === 'security');
}

async function onboardingIds(tickets) {
  const out = new Set(tickets.filter((t) => FAMILY_SUBJECT.test(String(t.subject || ''))).map((t) => t.id));
  const rest = tickets.map((t) => t.id).filter((id) => !out.has(id));
  if (!rest.length) return out;
  const [members, parents] = await Promise.all([
    soft(() => prisma.hrLifecycleFamilyMember.findMany({ where: { ticketId: { in: rest } }, select: { ticketId: true }, take: 500 }), []),
    soft(() => prisma.hrLifecycleFamily.findMany({ where: { parentTicketId: { in: rest } }, select: { parentTicketId: true }, take: 500 }), []),
  ]);
  for (const m of members || []) out.add(m.ticketId);
  for (const f of parents || []) out.add(f.parentTicketId);
  return out;
}

/**
 * @param {number} workspaceId
 * @param {object} args
 * @param {string} args.subject            the mail's subject as it arrived
 * @param {(s: string) => string} args.normalize  the ingest's subject normaliser
 * @param {(status: string) => Promise<boolean>} [args.isOpen]  is this status Open or Pending?
 * @param {Array<{ticketId:number, displayRef?:string, vendor?:string, invoiceNumber?:string}>} [args.invoiceMatches]  Live invoice matches (open tickets)
 * @returns {Promise<null | { candidates: {ticketId:number, why:string}[], bestGuessTicketId:number, rules:string[], total:number }>}
 */
export async function findFollowUpCandidates(workspaceId, { subject, normalize, isOpen = null, now = Date.now(), invoiceMatches = [] } = {}) {
  try {
    const invoice = invoiceCandidates(invoiceMatches);
    const key = followUpSubjectKey(typeof normalize === 'function' ? normalize(subject) : subject);
    const numbers = referenceIdentities(subject, { now }).slice(0, MAX_NUMBERS);
    const fragment = key.length >= MIN_SUBJECT_KEY ? searchFragment(key) : '';
    const or = [
      ...(fragment.length >= MIN_SUBJECT_KEY ? [{ subject: { contains: fragment, mode: 'insensitive' } }] : []),
      ...numbers.map((n) => ({ subject: { contains: n } })),
    ];
    if (!or.length) return invoice.length ? withInvoice(null, invoice) : null;
    const since = new Date(now - FOLLOW_UP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.ticket.findMany({
      where: {
        workspaceId: Number(workspaceId),
        status: { notIn: ['Deleted', 'Spam'] },
        AND: [{ OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] }, { OR: or }],
      },
      select: {
        id: true, subject: true, status: true, createdAt: true, category: true,
        internalCategory: { select: { name: true, parent: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: FETCH,
    });
    if (!Array.isArray(rows) || !rows.length) return withInvoice(null, invoice);

    const matched = [];
    for (const t of rows) {
      if (['Deleted', 'Spam'].includes(t.status) || isSecurity(t)) continue;
      const sameSubject = fragment.length >= MIN_SUBJECT_KEY && followUpSubjectKey(typeof normalize === 'function' ? normalize(t.subject) : t.subject) === key;
      const theirs = referenceIdentities(t.subject, { now });
      const shared = numbers.filter((n) => theirs.includes(n));
      if (!sameSubject && !shared.length) continue;
      matched.push({
        ticket: t,
        rules: [...(sameSubject ? ['same_subject'] : []), ...(shared.length ? ['shared_number'] : [])],
        why: [sameSubject ? 'same subject' : null, shared.length ? `same reference number ${shared.join(', ')}` : null].filter(Boolean).join('; '),
      });
    }
    if (!matched.length) return withInvoice(null, invoice);
    const family = await onboardingIds(matched.map((m) => m.ticket));
    const kept = matched.filter((m) => !family.has(m.ticket.id));
    if (!kept.length) return withInvoice(null, invoice);

    // Newest first (the query's order). The best guess: an open one, else the newest.
    const open = [];
    for (const m of kept) {
      const yes = typeof isOpen === 'function'
        ? await soft(() => isOpen(m.ticket.status), false)
        : !NOT_OPEN.includes(String(m.ticket.status || '').toLowerCase());
      if (yes) open.push(m);
    }
    const best = open[0] || kept[0];
    return withInvoice({
      candidates: kept.slice(0, FOLLOW_UP_MAX_CANDIDATES).map((m) => ({ ticketId: m.ticket.id, why: m.why })),
      bestGuessTicketId: best.ticket.id,
      bestGuessOpen: open.length > 0,
      rules: [...new Set(kept.flatMap((m) => m.rules))],
      total: kept.length,
    }, invoice);
  } catch (err) {
    logger.warn(`followUpCandidateService: lookup failed (treated as no candidates): ${err.message}`);
    return null;
  }
}

/** Live invoice matches as candidates: [{ ticketId, why }], one per ticket. */
function invoiceCandidates(matches) {
  const out = [];
  for (const m of Array.isArray(matches) ? matches : []) {
    const ticketId = Number(m?.ticketId);
    if (!Number.isInteger(ticketId) || ticketId <= 0 || out.some((c) => c.ticketId === ticketId)) continue;
    const from = m.vendor ? ` from ${m.vendor}` : ' from the same sender';
    out.push({ ticketId, why: `same invoice number ${m.invoiceNumber || ''}${from} on an open ticket`.replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * The subject / number result with the invoice matches added: invoice
 * candidates first (they are open and a hard link), the best guess the newest
 * of them, rule `same_invoice`. A ticket found both ways keeps one row with
 * both reasons.
 */
function withInvoice(result, invoice) {
  if (!invoice.length) return result;
  const rest = (result?.candidates || []).filter((c) => !invoice.some((i) => i.ticketId === c.ticketId));
  const merged = invoice.map((i) => {
    const also = (result?.candidates || []).find((c) => c.ticketId === i.ticketId);
    return also ? { ticketId: i.ticketId, why: `${i.why}; ${also.why}` } : i;
  });
  const candidates = [...merged, ...rest];
  return {
    candidates: candidates.slice(0, FOLLOW_UP_MAX_CANDIDATES),
    bestGuessTicketId: invoice[0].ticketId,
    bestGuessOpen: true,
    rules: [...new Set(['same_invoice', ...(result?.rules || [])])],
    total: candidates.length,
    invoiceTicketIds: invoice.map((i) => i.ticketId),
  };
}

export default { findFollowUpCandidates, followUpSubjectKey, FOLLOW_UP_WINDOW_DAYS, FOLLOW_UP_MAX_CANDIDATES };
