import prisma from './prisma.js';

/**
 * The single approval verdict for one ticket — the shape an external system
 * gates on. Built for Assetron (BGC IT), which blocks the first assignment of
 * a new laptop unless a ticketing system confirms the request was approved.
 *
 * Design rules, all learned from their FreshService integration:
 *  - `isApproved` and `state` are ALWAYS present on a 200. No field that
 *    decides the outcome may be conditionally absent.
 *  - The state enum is exactly what Ticket Pulse can actually be in. We do not
 *    invent DELEGATE_APPROVED / AUTO_APPROVED / PARTIALLY_APPROVED states for
 *    situations this product does not have — a consumer that hard-codes an
 *    enum is better served by a short honest one.
 *  - The verdict is scoped to an APPROVAL CATEGORY by default. A ticket can
 *    carry approvals from several categories ("New Computer Upgrade", "AI
 *    Premium License Request"...), and an approved licence must never open the
 *    laptop gate. `category=any` is the deliberate opt-in to a ticket-wide
 *    answer.
 */

// Every value this API can return. Stable within /api/v1 (contract, Sep 2026).
export const APPROVAL_STATES = Object.freeze([
  'NOT_REQUESTED',   // no approval was ever requested in scope
  'PENDING',         // requested, nobody has decided
  'INFO_REQUESTED',  // an approver asked the requester a question
  'EXPIRED',         // still pending, and the emailed decision link has lapsed
  'REJECTED',        // an approver declined
  'CANCELLED',       // withdrawn, or a colleague decided first
  'APPROVED',        // an approver said yes — the only value that gates open
]);

// Ticket Pulse has no per-ticket-type approval requirement: approval is a
// manual request against a category. So "no rows" means nobody asked, which is
// indistinguishable from "not needed" — say that instead of guessing a boolean.
export const APPROVAL_REQUIREMENT = 'NOT_MODELLED';

const STATE_BY_STATUS = Object.freeze({
  approved: 'APPROVED',
  pending: 'PENDING',
  info_requested: 'INFO_REQUESTED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
});

// Most decisive first. APPROVED beats an older REJECTED because a re-request
// that succeeded is the current truth; CANCELLED is last because it is what
// siblings become when someone else decides first.
const PRECEDENCE = Object.freeze(['APPROVED', 'PENDING', 'INFO_REQUESTED', 'EXPIRED', 'REJECTED', 'CANCELLED']);

function publicBaseUrl() {
  const configured = process.env.PUBLIC_APP_URL
    || process.env.FRONTEND_PUBLIC_URL
    || process.env.FRONTEND_URL
    || process.env.APP_URL
    || process.env.CORS_ORIGIN?.split(',')?.[0]
    || 'http://localhost:5173';
  return String(configured).trim().replace(/\/+$/, '');
}

/**
 * One row's state. Expiry is derived, not stored: `expiresAt` only disables the
 * emailed magic link (a coordinator can still decide it in-app), so an expired
 * PENDING row is reported EXPIRED — both gate closed, but EXPIRED is the more
 * useful thing to show an agent.
 */
export function rowState(row, now = new Date()) {
  if (row?.status === 'pending' && row.expiresAt && new Date(row.expiresAt) < now) return 'EXPIRED';
  // Fail closed: an unrecognised status is never treated as approved.
  return STATE_BY_STATUS[row?.status] || 'CANCELLED';
}

/** Collapse every in-scope approval row into one state. Pure. */
export function deriveState(rows, now = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return 'NOT_REQUESTED';
  const seen = new Set(rows.map((r) => rowState(r, now)));
  return PRECEDENCE.find((s) => seen.has(s)) || 'NOT_REQUESTED';
}

/**
 * The request group that produced the verdict: the newest row carrying the
 * winning state. Approvals fan out one row per manager and the FIRST decision
 * wins, so the group — not the row — is the unit a human recognises.
 */
export function decisiveGroup(rows, state, now = new Date()) {
  const matching = rows.filter((r) => rowState(r, now) === state);
  if (!matching.length) return [];
  const newest = matching.reduce((a, b) => (b.id > a.id ? b : a));
  if (!newest.requestGroupId) return [newest];
  return rows.filter((r) => r.requestGroupId === newest.requestGroupId);
}

function approverShape(row, now) {
  return {
    name: row.approverName || null,
    email: row.approverEmail,
    decision: rowState(row, now),
    decidedAt: row.decidedAt || null,
    // 'link' = decided from the emailed approval page, 'app' = inside Ticket Pulse.
    decidedVia: row.decidedVia || null,
  };
}

class ApprovalVerdictService {
  /** Active approval categories, for error messages and discovery. */
  async listCategories(workspaceId) {
    return prisma.approvalCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Case-insensitive category lookup. Deactivated categories still resolve —
   * historical approvals on them must keep answering.
   */
  async findCategory(workspaceId, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    const all = await prisma.approvalCategory.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    return all.find((c) => c.name.trim().toLowerCase() === wanted) || null;
  }

  /**
   * @param {number} ticketId
   * @param {number} workspaceId
   * @param {{category: {id:number,name:string}|null, echo: string|null}} opts
   *   `category: null` = ticket-wide verdict (the `any` scope).
   * @returns {Promise<object|null>} null when the ticket is not in the workspace.
   */
  async verdict(ticketId, workspaceId, { category = null, echo = null } = {}) {
    const now = new Date();
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: {
        id: true, subject: true, status: true, ticketType: true, origin: true,
        nativeNumber: true, freshserviceTicketId: true, createdAt: true, updatedAt: true,
        requester: { select: { name: true, email: true } },
      },
    });
    if (!ticket) return null;

    const rows = await prisma.ticketApproval.findMany({
      where: { ticketId, workspaceId, ...(category ? { approvalCategoryId: category.id } : {}) },
      select: {
        id: true, status: true, approverEmail: true, approverName: true,
        decidedAt: true, decidedVia: true, expiresAt: true, createdAt: true,
        requestGroupId: true,
        approvalCategory: { select: { id: true, name: true } },
      },
      orderBy: { id: 'desc' },
    });

    const state = deriveState(rows, now);
    const group = decisiveGroup(rows, state, now);
    const decided = group
      .filter((r) => r.decidedAt)
      .sort((a, b) => new Date(b.decidedAt) - new Date(a.decidedAt))[0] || null;
    const pendingRow = group.find((r) => r.status === 'pending') || null;
    const ref = ticket.origin === 'ticketpulse' && ticket.nativeNumber
      ? `TP-${ticket.nativeNumber}`
      : `#${ticket.freshserviceTicketId || ticket.id}`;

    return {
      ticket: {
        id: ticket.id,
        ref,
        // What the caller sent, echoed back so one log line ties the two together.
        reference: echo,
        type: ticket.ticketType || null,
        subject: ticket.subject || null,
        status: ticket.status,
        url: `${publicBaseUrl()}/tickets/${ticket.id}`,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        // TP-born tickets are mirrored into FreshService, so one request
        // usually exists in both systems and either number resolves here.
        externalReferences: ticket.freshserviceTicketId
          ? [{ system: 'FRESHSERVICE', id: String(ticket.freshserviceTicketId) }]
          : [],
      },
      approval: {
        state,
        isApproved: state === 'APPROVED',
        requirement: APPROVAL_REQUIREMENT,
        scope: category ? 'category' : 'ticket',
        category: category ? category.name : (group[0]?.approvalCategory?.name || null),
        decidedAt: decided?.decidedAt || null,
        // Only a PENDING/EXPIRED request carries an expiry. A GRANTED approval
        // never goes stale in Ticket Pulse — apply your own age policy to
        // decidedAt if you need one.
        expiresAt: pendingRow?.expiresAt || null,
        approvers: group.map((r) => approverShape(r, now)),
        // How many distinct approval requests exist in scope, ever.
        requestCount: new Set(rows.map((r) => r.requestGroupId || `row:${r.id}`)).size,
      },
      requester: ticket.requester
        ? { name: ticket.requester.name || null, email: ticket.requester.email || null }
        : null,
      // Ticket Pulse holds no serial numbers or asset tags. Always null —
      // present so the field never appears or disappears between responses.
      asset: null,
    };
  }
}

export default new ApprovalVerdictService();
