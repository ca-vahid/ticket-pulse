import prisma from './prisma.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { resolvePersonName } from './personDirectoryService.js';

/**
 * "Request for Cristian Orellana : Laptop" — an IT agent filing on behalf of
 * someone. Returns the named person (lower-cased) or null. Only a capitalised
 * two-or-three-word name right after "for"/"to"/"on behalf of" counts; an
 * ordinary subject never donates a name.
 */
export function namedRecipientFromSubject(subject) {
  const raw = String(subject || '').trim();
  const m = raw.match(/\b(?:for|to|on behalf of)\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){1,2})(?=\s*(?:[:\-–—(,]|$))/);
  return m ? m[1].replace(/\s+/g, ' ').toLowerCase() : null;
}

/** Does the subject mention this person (full display name, or the bare username as a token)? */
export function subjectNamesPerson(subject, { name = null, username = null } = {}) {
  const s = String(subject || '').toLowerCase();
  if (!s) return false;
  if (name && String(name).trim() && s.includes(String(name).trim().toLowerCase())) return true;
  if (username && new RegExp(`(^|[^a-z0-9])${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(s)) return true;
  return false;
}

/**
 * "Is this person allowed to be handed a laptop?" — one question, one answer.
 *
 * This replaces the ticket-reference approval gate we shipped in 3.8.35. That
 * design asked Assetron for a ticket number and a category name, and measured
 * against production it would have been unusable: of 370 hardware tickets in
 * ws1 over 90 days only 12 carried an approval, so a fail-closed gate keyed on
 * approvals would have denied 97% of real laptop handouts. New hires were worse
 * — 74 of 75 "NH Laptop" tickets have no approval at all, because a new hire's
 * laptop is authorised by the hiring process, not by an IT approval request.
 *
 * So the ticket is the gate and the approval is the exception:
 *
 *   ALLOW      a hardware ticket exists for this person and nothing is holding
 *              it — either it was approved, or it never needed an approval
 *   HOLD       a hardware approval exists and has NOT been granted (pending,
 *              expired, rejected, or an approver asked a question)
 *   NO_TICKET  nothing found — nobody raised a ticket for this handout
 *
 * NO_TICKET is deliberately not a denial. It means Ticket Pulse has no record,
 * which is a process gap to flag to the operator, not proof of wrongdoing.
 */

// Most decisive first — an APPROVED row beats an older REJECTED one, because a
// re-request that succeeded is the current truth.
const PRECEDENCE = Object.freeze(['APPROVED', 'PENDING', 'INFO_REQUESTED', 'EXPIRED', 'REJECTED', 'CANCELLED']);

const STATE_BY_STATUS = Object.freeze({
  approved: 'APPROVED',
  pending: 'PENDING',
  info_requested: 'INFO_REQUESTED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
  // Approvals v2: handed-off rows are closed; the successor rows carry PENDING.
  escalated: 'CANCELLED',
  forwarded: 'CANCELLED',
});

// States that stop a handout. CANCELLED is absent on purpose: a withdrawn
// request, or the sibling of one a colleague decided first, is not a refusal.
const BLOCKING = Object.freeze(new Set(['PENDING', 'INFO_REQUESTED', 'EXPIRED', 'REJECTED']));

// How far back a hardware ticket still counts as "this handout".
export const DEFAULT_WINDOW_DAYS = 180;

function publicBaseUrl() {
  const configured = process.env.PUBLIC_APP_URL
    || process.env.FRONTEND_PUBLIC_URL
    || process.env.FRONTEND_URL
    || process.env.APP_URL
    || process.env.CORS_ORIGIN?.split(',')?.[0]
    || 'http://localhost:5173';
  return String(configured).trim().replace(/\/+$/, '');
}

export function rowState(row, now = new Date()) {
  if (row?.status === 'pending' && row.expiresAt && new Date(row.expiresAt) < now) return 'EXPIRED';
  // Fail closed on an unrecognised status: never treat it as approved.
  return STATE_BY_STATUS[row?.status] || 'CANCELLED';
}

export function deriveState(rows, now = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return 'NOT_REQUESTED';
  const seen = new Set(rows.map((r) => rowState(r, now)));
  return PRECEDENCE.find((s) => seen.has(s)) || 'NOT_REQUESTED';
}

/**
 * Split a caller-supplied person into the two things we can match on.
 * Assetron holds an Entra account, so it may send either form:
 *   "sreguige@bgcengineering.ca" -> { email, username: 'sreguige' }
 *   "SReguige"                   -> { email: null, username: 'sreguige' }
 */
export function parsePerson(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.includes('@')) {
    const [local] = value.split('@');
    return { email: value.toLowerCase(), username: (local || '').toLowerCase() };
  }
  return { email: null, username: value.toLowerCase() };
}

/**
 * The new-hire automation files its tickets under the Ticket Pulse service
 * account, so the requester is never the new hire. The person is in the
 * subject instead, in a machine-generated format:
 *
 *   "NH Laptop - Ottawa - CA - SReguige - 2026-09-21"
 *                               ^^^^^^^^
 *
 * A new hire has no requester row at all — they have never mailed the
 * helpdesk — so the subject is the ONLY place their identity appears.
 */
export function usernameFromSubject(subject) {
  const raw = String(subject || '').trim();
  // Only the new-hire automation's own subjects. Without this guard an
  // ordinary subject that happens to contain " - " would donate a "username".
  if (!/^NH\s/i.test(raw)) return null;

  const parts = raw.split(' - ').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  // The automation has emitted four shapes over time, so the username is found
  // by position from the END, never by a fixed index:
  //   NH Workstation - Victoria - CA - SJones - 2025-09-04   (trailing date)
  //   NH Workstation - HFX - TUser1 - 2026-06-01             (trailing date)
  //   NH Laptop - Vancouver - CA - WLam                      (no date)
  //   NH Workstation - Vancouver - KaLiu (May 5)             (no date, aside)
  let candidate = parts[parts.length - 1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) candidate = parts[parts.length - 2];

  // "KaLiu (May 5)" -> "KaLiu"
  candidate = String(candidate || '').replace(/\s*\(.*\)\s*$/, '').trim();

  // A username, not a date, a country code, or a phrase.
  if (!candidate || /\s/.test(candidate)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

/** The internal (sub)categories an admin has marked as a laptop/desktop handout. */
export async function hardwareCategoryIds(workspaceId) {
  const rows = await prisma.competencyCategory.findMany({
    where: { workspaceId, gatesHardware: true, isActive: true },
    select: { id: true, name: true, parentId: true },
  });
  return rows;
}

function shapeTicket(t) {
  return {
    ref: ticketDisplayRef(t),
    freshserviceId: t.freshserviceTicketId === null || t.freshserviceTicketId === undefined
      ? null : String(t.freshserviceTicketId),
    subject: t.subject || null,
    status: t.status || null,
    category: t.internalCategory?.name || null,
    subcategory: t.internalSubcategory?.name || null,
    createdAt: t.createdAt,
    url: `${publicBaseUrl()}/tickets/${t.id}`,
  };
}

class HardwareHandoutService {
  /**
   * @param {number} workspaceId
   * @param {string} person  email or username
   * @param {{ windowDays?: number, now?: Date }} opts
   */
  async check(workspaceId, person, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
    const parsed = parsePerson(person);
    if (!parsed) return null;

    const cats = await hardwareCategoryIds(workspaceId);
    const catIds = cats.map((c) => c.id);
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    // Two ways in. Either the requester on the ticket is this person, or the
    // new-hire automation named them in the subject. We cannot express the
    // subject form as a Prisma filter cheaply, so candidates are fetched by
    // category window and matched in memory — ws1 sees a few hundred rows.
    const where = {
      workspaceId,
      createdAt: { gte: since },
      ...(catIds.length
        ? { OR: [{ internalCategoryId: { in: catIds } }, { internalSubcategoryId: { in: catIds } }] }
        : { id: -1 }),
    };

    const candidates = catIds.length ? await prisma.ticket.findMany({
      where,
      select: {
        id: true, subject: true, status: true, createdAt: true, origin: true,
        nativeNumber: true, freshserviceTicketId: true,
        requester: { select: { id: true, name: true, email: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
        approvals: {
          select: { id: true, status: true, expiresAt: true, decidedAt: true, approverEmail: true, approverName: true,
            approvalCategory: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    }) : [];

    // Who is an IT agent here? A ticket an agent filed is very often for
    // SOMEONE ELSE ("Request for Cristian Orellana : Laptop", requester =
    // Soheil). Assetron 16 Sep 2026: that ticket cleared a laptop for Soheil.
    // So an agent-requester ticket counts as the agent's own only when its
    // subject names nobody else; and a ticket that names the recipient in the
    // subject counts for the recipient even though the requester is the agent.
    let agentEmails = new Set();
    try {
      const techs = await prisma.technician.findMany({ where: { workspaceId, isActive: true }, select: { email: true } });
      agentEmails = new Set((techs || []).map((x) => String(x.email || '').toLowerCase()).filter(Boolean));
    } catch { /* no technician lane in this test → nobody is an agent */ }

    // The recipient's display name, so "Request for Cristian Orellana" can be
    // matched when Assetron sends corellana@ / corellana.
    let personName = null;
    try {
      let email = parsed.email;
      if (!email) {
        const fromRows = candidates.find((t) => (t.requester?.email || '').toLowerCase().split('@')[0] === parsed.username)?.requester?.email;
        if (fromRows) email = fromRows.toLowerCase();
        else {
          const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { internalDomains: true } }).catch(() => null);
          const domain = ws?.internalDomains?.[0] || null;
          if (domain) email = `${parsed.username}@${domain}`;
        }
      }
      if (email) personName = await resolvePersonName(email);
    } catch { personName = null; }

    const mine = [];
    const excluded = [];
    for (const t of candidates) {
      const email = (t.requester?.email || '').toLowerCase();
      const requesterIsMe = parsed.email ? (email && email === parsed.email) : (email && email.split('@')[0] === parsed.username);
      const nhUsername = usernameFromSubject(t.subject);
      const named = nhUsername ? null : namedRecipientFromSubject(t.subject);
      const namesMe = nhUsername
        ? nhUsername === parsed.username
        : subjectNamesPerson(t.subject, { name: personName, username: parsed.username });
      let matchedBy = null;
      if (nhUsername && nhUsername === parsed.username) matchedBy = 'ticket_subject';
      else if (requesterIsMe && agentEmails.has(email) && named && !namesMe) {
        // Filed by this agent for someone else — not the agent's laptop.
        excluded.push({ ...t, why: `filed by ${t.requester?.name || email} (IT agent) for ${named.replace(/\b\w/g, (c) => c.toUpperCase())}, not for ${parsed.username}` });
        continue;
      } else if (requesterIsMe) matchedBy = 'requester_email';
      else if (namesMe && !nhUsername) matchedBy = 'subject_name';
      if (matchedBy) mine.push({ ...t, matchedBy });
    }
    const excludedOut = excluded.slice(0, 5).map((t) => ({ ...shapeTicket(t), why: t.why }));

    const checkedAt = now.toISOString();
    const scope = {
      workspaceId,
      windowDays,
      categories: cats.map((c) => c.name).sort(),
      categoriesConfigured: cats.length,
    };

    if (mine.length === 0) {
      return {
        person: { query: String(person).trim(), matchedBy: null, email: parsed.email, name: personName },
        decision: 'NO_TICKET',
        isApproved: false,
        approval: { state: 'NOT_REQUESTED', decidedAt: null, decidedBy: null, category: null },
        ticket: null,
        otherTickets: [],
        excluded: excludedOut,
        reason: `No laptop or desktop ticket for "${String(person).trim()}" in the last ${windowDays} days. `
          + 'Ticket Pulse has no record of this handout being asked for — raise a ticket before issuing the asset.'
          + (excludedOut.length ? ` (${excludedOut.length} ticket${excludedOut.length === 1 ? '' : 's'} this person filed as an IT agent for someone else were not counted.)` : ''),
        checkedAt,
        scope,
      };
    }

    // All approval rows across every matching ticket decide the state together:
    // a person with an approved request and an older rejected one is approved.
    const allRows = mine.flatMap((t) => t.approvals || []);
    const state = deriveState(allRows, now);

    // The ticket we name is the one that carries the decisive state, else the
    // most recent — never an arbitrary one.
    const decisive = mine.find((t) => (t.approvals || []).some((r) => rowState(r, now) === state)) || mine[0];
    const decisiveRow = (decisive.approvals || []).find((r) => rowState(r, now) === state) || null;

    const blocking = BLOCKING.has(state);
    const decision = blocking ? 'HOLD' : 'ALLOW';
    const isApproved = state === 'APPROVED';

    let reason;
    if (state === 'APPROVED') {
      reason = `Approved on ${ticketDisplayRef(decisive)}.`;
    } else if (blocking) {
      reason = `${ticketDisplayRef(decisive)} has an approval request that is ${state.toLowerCase().replace('_', ' ')} — do not hand over the asset until it is granted.`;
    } else {
      reason = `${ticketDisplayRef(decisive)} covers this handout and needs no approval. `
        + 'Approval is only required for exceptions (a non-standard machine, an early replacement).';
    }

    return {
      person: {
        query: String(person).trim(),
        matchedBy: decisive.matchedBy,
        // For a subject match the requester is the agent who filed, not the recipient.
        email: decisive.matchedBy === 'requester_email' ? (decisive.requester?.email || parsed.email) : parsed.email,
        name: decisive.matchedBy === 'requester_email' ? (decisive.requester?.name || personName) : personName,
        filedBy: decisive.matchedBy === 'requester_email' ? null : (decisive.requester?.name || decisive.requester?.email || null),
      },
      decision,
      isApproved,
      approval: {
        state,
        decidedAt: decisiveRow?.decidedAt || null,
        decidedBy: decisiveRow?.approverName || decisiveRow?.approverEmail || null,
        category: decisiveRow?.approvalCategory?.name || null,
      },
      ticket: shapeTicket(decisive),
      otherTickets: mine.filter((t) => t.id !== decisive.id).slice(0, 5).map(shapeTicket),
      excluded: excludedOut,
      reason,
      checkedAt,
      scope,
    };
  }
}

export default new HardwareHandoutService();
export { HardwareHandoutService };
