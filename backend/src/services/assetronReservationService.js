/**
 * Assetron laptop reservations driven by Ticket Pulse approvals (Assetron guide
 * Part B, 24 Sep 2026; Vahid's decisions the same day):
 *
 *   request (hardware category + a laptop picked)  -> POST /reservations (laptop ON_HOLD)
 *   an approver approves                           -> PATCH APPROVED  (laptop ASSIGNED)
 *   an approver rejects                            -> PATCH REJECTED  (hold released)
 *   cancelled / deleted / expired / ticket gone    -> PATCH CANCELLED (hold released)
 *   an expired request is renewed (resubmitted)    -> reserve the same laptop again
 *
 * Assetron has NO expiry: a laptop stays locked until we PATCH. So the outcome
 * is recorded first (pendingOutcome) and a reconciler sends it, retrying with
 * backoff until Assetron confirms — it runs after every approval change and on
 * a 2-minute sweep. A 404/409 from Assetron is not retryable: the row becomes
 * `failed` with a note on the ticket for an admin.
 *
 * Tiered escalation is manual, so ANY approval row of the request group that
 * reaches `approved` is the final approval. Changing the laptop or the
 * recipient on a pending request: admins and the original requester only.
 */
import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import assetronClient, { AssetronError } from '../integrations/assetronClient.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

const SWEEP_MS = 2 * 60 * 1000;
const REVIVE_DAYS = 30;
const OPEN_STATUSES = ['pending', 'info_requested'];

const bad = (msg) => new ValidationError(msg);

/** Shown on the ticket, the approval card and in e-mails — the laptop as a person reads it. */
export function assetLabel(a) {
  if (!a) return 'a laptop';
  const name = [a.make, a.model].filter(Boolean).join(' ') || 'Laptop';
  const spec = [a.cpu, a.ram, a.storage, a.screenSize].filter(Boolean).join(' · ');
  const id = a.assetTag || (a.serialNumber ? `S/N ${a.serialNumber}` : null);
  return [name, id ? `(${id})` : null, spec ? `— ${spec}` : null].filter(Boolean).join(' ');
}

/** The asset fields we keep as a snapshot (Assetron's 15-field object). */
function snapshot(a) {
  if (!a || typeof a !== 'object') return null;
  const keep = ['id', 'assetTag', 'serialNumber', 'make', 'model', 'cpu', 'gpu', 'ram', 'storage', 'screenSize', 'touchScreen', 'status', 'condition', 'location', 'warrantyEndDate'];
  return Object.fromEntries(keep.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
}

/**
 * Pure: what must Assetron be told, given the request group's approval rows?
 * rows: [{ status, expiresAt, approverEmail, approverName, decidedAt, decisionNote, conditionNote }]
 * Returns null while a decision is still possible.
 */
export function desiredOutcome(rows, now = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return { outcome: 'CANCELLED', why: 'request_deleted' };
  const approved = rows.find((r) => r.status === 'approved');
  if (approved) {
    return {
      outcome: 'APPROVED', why: 'approved',
      decidedByEmail: approved.approverEmail || null, decidedByName: approved.approverName || null,
      decidedAt: approved.decidedAt || now, reason: approved.conditionNote || approved.decisionNote || null,
    };
  }
  const live = rows.some((r) => OPEN_STATUSES.includes(r.status) && !(r.expiresAt && new Date(r.expiresAt) < now));
  if (live) return null;
  const rejected = rows.find((r) => r.status === 'rejected');
  if (rejected) {
    return {
      outcome: 'REJECTED', why: 'rejected',
      decidedByEmail: rejected.approverEmail || null, decidedByName: rejected.approverName || null,
      decidedAt: rejected.decidedAt || now, reason: rejected.decisionNote || null,
    };
  }
  const expired = rows.some((r) => OPEN_STATUSES.includes(r.status));
  return { outcome: 'CANCELLED', why: expired ? 'expired' : 'cancelled' };
}

const WHY_TEXT = {
  approved: 'approved', rejected: 'not approved', cancelled: 'the approval request was cancelled',
  expired: 'the approval request expired', request_deleted: 'the approval request was deleted',
  ticket_deleted: 'the ticket was deleted', replaced: 'the laptop or recipient was changed',
};

async function ticketNote(ticketId, workspaceId, body) {
  await prisma.ticketThreadEntry.create({
    data: {
      ticketId, workspaceId, source: 'ticketpulse_user', eventType: 'note',
      actorName: 'Assetron', actorEmail: null, authorType: 'system',
      incoming: false, isPrivate: true, visibility: 'private', bodyText: body, content: body, occurredAt: new Date(), mirrorState: null,
      rawPayload: { kind: 'assetron_event', v: 1 },
    },
  }).catch((err) => logger.warn(`Assetron ticket note failed (non-fatal): ${err.message}`));
}

async function resolveEntraId(email) {
  try {
    const { default: azureAdService } = await import('./azureAdService.js');
    const p = await azureAdService.getUserProfile(email);
    return p?.id || null;
  } catch { return null; }
}

class AssetronReservationService {
  constructor() { this._timer = null; this._running = false; }

  isConfigured() { return assetronClient.isConfigured(); }

  /** Validate a picked laptop + recipient from a request body. */
  normalizeHardware(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const assetId = String(raw.assetId || '').trim();
    if (!assetId) return null;
    if (!/^[0-9a-f-]{8,}$/i.test(assetId)) throw bad('That laptop id is not valid — pick the laptop again');
    const email = String(raw.recipient?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Pick who the laptop is for');
    return {
      assetId,
      recipient: {
        email,
        name: raw.recipient?.name ? String(raw.recipient.name).trim().slice(0, 255) : null,
        entraObjectId: raw.recipient?.entraObjectId ? String(raw.recipient.entraObjectId).trim().slice(0, 80) : null,
      },
    };
  }

  /**
   * Reserve before the approval rows are written. Throws a ValidationError
   * carrying Assetron's own agent-safe sentence (laptop taken, recipient not
   * in Assetron…) so nothing is created when the hold fails.
   */
  async reserve({ ticket, requestGroupId, hardware, actor }) {
    if (!this.isConfigured()) throw bad('Assetron is not connected yet — request the approval without a laptop, or ask an admin');
    const entraObjectId = hardware.recipient.entraObjectId || await resolveEntraId(hardware.recipient.email);
    const base = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
    const body = {
      assetId: hardware.assetId,
      requestedFor: { email: hardware.recipient.email, ...(entraObjectId ? { entraObjectId } : {}) },
      ticket: { ref: ticketDisplayRef(ticket), url: `${base}/tickets/${ticket.id}` },
      approvalId: requestGroupId,
      requestedBy: { email: actor?.email || null, displayName: actor?.name || actor?.email || null },
    };
    let res;
    try {
      res = await assetronClient.createReservation(body);
    } catch (err) {
      if (err instanceof AssetronError) {
        if (err.reason === 'USER_NOT_FOUND') {
          // Assetron's own sentence usually says what to do; add it only when it does not.
          throw bad(/sync from entra/i.test(err.message || '') ? err.message : `${err.message} (Assetron needs "Sync from Entra ID" for ${hardware.recipient.email} before this laptop can be reserved.)`);
        }
        throw bad(`Assetron: ${err.message}`);
      }
      throw err;
    }
    const reservationId = res.data?.reservationId;
    if (!reservationId) throw bad('Assetron did not return a reservation — try again');
    let asset = null;
    try { asset = snapshot(await assetronClient.getAsset(hardware.assetId)); } catch { asset = { id: hardware.assetId }; }
    return { reservationId, asset, entraObjectId };
  }

  /** Persist the hold once the approval rows exist. */
  async record({ ticket, requestGroupId, categoryId, hardware, reserved, actor }) {
    await prisma.assetronReservation.create({
      data: {
        workspaceId: ticket.workspaceId, ticketId: ticket.id, requestGroupId, approvalCategoryId: categoryId ?? null,
        reservationId: reserved.reservationId, assetId: hardware.assetId, asset: reserved.asset,
        recipientEmail: hardware.recipient.email, recipientName: hardware.recipient.name, recipientEntraId: reserved.entraObjectId,
        requestedByEmail: actor?.email || null, state: 'reserved',
      },
    });
    await ticketNote(ticket.id, ticket.workspaceId, `Assetron: ${assetLabel(reserved.asset)} is on hold for ${hardware.recipient.name || hardware.recipient.email} until this approval is decided.`);
  }

  /** Undo a hold whose approval request could not be written. */
  async abandon(reservationId, actor) {
    try {
      await assetronClient.decideReservation(reservationId, {
        status: 'CANCELLED', decidedBy: { email: actor?.email || null, displayName: actor?.name || null }, decidedAt: new Date().toISOString(),
        reason: 'The approval request could not be created',
      });
    } catch (err) { logger.warn(`Assetron: could not release reservation ${reservationId} after a failed request: ${err.message}`); }
  }

  /** Called after any approval change on a request group (fire-and-forget). */
  touch(requestGroupId) {
    if (!requestGroupId) return;
    Promise.resolve()
      .then(() => this.reconcile({ requestGroupId }))
      .catch((err) => logger.warn(`Assetron reconcile (${requestGroupId}) failed: ${err.message}`));
  }

  /** Decide + send outcomes. `requestGroupId` limits it to one request. */
  async reconcile({ requestGroupId = null, now = new Date() } = {}) {
    // The sweep reads live holds, plus holds released by EXPIRY in the last
    // 30 days (a renewed or late-approved request takes its laptop back).
    // Every other released row is finished and never read again — reading
    // them all would push new holds past the page as history grows.
    const where = requestGroupId ? { requestGroupId } : {
      OR: [
        { state: 'reserved' },
        { state: 'released', outcomeWhy: 'expired', updatedAt: { gte: new Date(now.getTime() - REVIVE_DAYS * 24 * 60 * 60 * 1000) } },
      ],
    };
    const holds = await prisma.assetronReservation.findMany({ where, take: 200, orderBy: { nextAttemptAt: { sort: 'asc', nulls: 'first' } } });
    let sent = 0;
    for (const hold of holds) {
      if (hold.state === 'failed') continue;
      const rows = await prisma.ticketApproval.findMany({
        where: { requestGroupId: hold.requestGroupId },
        select: { status: true, expiresAt: true, approverEmail: true, approverName: true, decidedAt: true, decisionNote: true, conditionNote: true },
      });
      const ticketAlive = await prisma.ticket.findUnique({ where: { id: hold.ticketId }, select: { id: true } }).catch(() => ({ id: hold.ticketId }));
      const want = ticketAlive ? desiredOutcome(rows, now) : { outcome: 'CANCELLED', why: 'ticket_deleted' };

      if (hold.state === 'assigned') {
        // Assetron cannot take an assignment back through the API. A decision
        // flipped to "rejected" after the laptop was assigned is flagged once.
        if (want && want.outcome !== 'APPROVED' && hold.outcomeWhy !== 'assigned_then_changed') {
          await prisma.assetronReservation.update({ where: { id: hold.id }, data: { outcomeWhy: 'assigned_then_changed' } });
          await ticketNote(hold.ticketId, hold.workspaceId, `Assetron: the approval is no longer approved, but ${assetLabel(hold.asset)} was already assigned to ${hold.recipientName || hold.recipientEmail} in Assetron. Ticket Pulse cannot undo an assignment — return the laptop in Assetron if it should not go out.`);
        }
        continue;
      }
      if (hold.state === 'released') {
        // A released hold comes back when the request is live again after it
        // expired (renewed), or when the request ends up APPROVED after all
        // (approved late in the app, or a rejection changed to an approval).
        const revive = want?.outcome === 'APPROVED' || (want === null && hold.outcomeWhy === 'expired');
        if (!revive) continue;
        if (!(await this._rereserve(hold))) continue;
        if (!want) continue;
        const fresh = await prisma.assetronReservation.findUnique({ where: { id: hold.id } });
        if (!fresh || fresh.state !== 'reserved') continue;
        Object.assign(hold, fresh);
      }
      if (!want) continue; // still undecided
      if (hold.pendingOutcome !== want.outcome) {
        await prisma.assetronReservation.update({
          where: { id: hold.id },
          data: {
            pendingOutcome: want.outcome, outcomeWhy: want.why, decidedByEmail: want.decidedByEmail || null,
            decidedByName: want.decidedByName || null, decidedAt: want.decidedAt ? new Date(want.decidedAt) : now,
            attempts: 0, nextAttemptAt: null,
          },
        });
        Object.assign(hold, { pendingOutcome: want.outcome, outcomeWhy: want.why, decidedByEmail: want.decidedByEmail || null, decidedByName: want.decidedByName || null, decidedAt: want.decidedAt || now, attempts: 0, nextAttemptAt: null });
      }
      if (hold.nextAttemptAt && new Date(hold.nextAttemptAt) > now) continue;
      if (await this._send(hold, want.reason || null)) sent += 1;
    }
    return { checked: holds.length, sent };
  }

  async _send(hold, reason) {
    const decidedBy = hold.decidedByEmail ? { email: hold.decidedByEmail, displayName: hold.decidedByName || hold.decidedByEmail } : { email: null, displayName: 'Ticket Pulse' };
    const why = WHY_TEXT[hold.outcomeWhy] || hold.outcomeWhy || '';
    try {
      const data = await assetronClient.decideReservation(hold.reservationId, {
        status: hold.pendingOutcome,
        decidedBy,
        decidedAt: new Date(hold.decidedAt || Date.now()).toISOString(),
        reason: reason ? String(reason).slice(0, 500) : `Ticket Pulse: ${why}`,
      });
      const assigned = hold.pendingOutcome === 'APPROVED';
      await prisma.assetronReservation.update({
        where: { id: hold.id },
        data: { state: assigned ? 'assigned' : 'released', outcome: hold.pendingOutcome, pendingOutcome: null, completedAt: new Date(), lastError: null, nextAttemptAt: null },
      });
      const to = data?.asset?.assignedTo?.displayName || hold.recipientName || hold.recipientEmail;
      await ticketNote(hold.ticketId, hold.workspaceId, assigned
        ? `Assetron: ${assetLabel(hold.asset)} is now assigned to ${to} (approved by ${hold.decidedByName || hold.decidedByEmail || 'the approver'}).`
        : `Assetron: the hold on ${assetLabel(hold.asset)} was released — ${why}.`);
      return true;
    } catch (err) {
      const ae = err instanceof AssetronError ? err : null;
      if (ae && !ae.retryable && ae.status !== 401 && ae.status !== 403) {
        await prisma.assetronReservation.update({ where: { id: hold.id }, data: { state: 'failed', lastError: `${ae.reason || ae.code}: ${ae.message}` } });
        await ticketNote(hold.ticketId, hold.workspaceId, `Assetron refused to ${hold.pendingOutcome === 'APPROVED' ? 'assign' : 'release'} ${assetLabel(hold.asset)}: ${ae.message} (${ae.reason || ae.code}). An admin needs to sort this out in Assetron.`);
        return false;
      }
      const attempts = (hold.attempts || 0) + 1;
      const waitMin = Math.min(60, 2 ** Math.min(attempts, 6));
      await prisma.assetronReservation.update({
        where: { id: hold.id },
        data: { attempts, nextAttemptAt: new Date(Date.now() + waitMin * 60 * 1000), lastError: String(err.message || err).slice(0, 1000) },
      });
      if (attempts === 5) await ticketNote(hold.ticketId, hold.workspaceId, `Assetron has not confirmed the ${hold.pendingOutcome === 'APPROVED' ? 'assignment' : 'release'} of ${assetLabel(hold.asset)} after 5 tries (${err.message}). Ticket Pulse keeps retrying every hour.`);
      return false;
    }
  }

  async _rereserve(hold) {
    const ticket = await prisma.ticket.findUnique({ where: { id: hold.ticketId }, select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true } });
    if (!ticket) return false;
    try {
      const reserved = await this.reserve({
        ticket, requestGroupId: hold.requestGroupId,
        hardware: { assetId: hold.assetId, recipient: { email: hold.recipientEmail, name: hold.recipientName, entraObjectId: hold.recipientEntraId } },
        actor: { email: hold.requestedByEmail },
      });
      await prisma.assetronReservation.update({
        where: { id: hold.id },
        data: { reservationId: reserved.reservationId, state: 'reserved', outcome: null, outcomeWhy: null, pendingOutcome: null, completedAt: null, attempts: 0, lastError: null },
      });
      await ticketNote(hold.ticketId, hold.workspaceId, `Assetron: the approval request is live again, so ${assetLabel(hold.asset)} is back on hold.`);
      return true;
    } catch (err) {
      await prisma.assetronReservation.update({ where: { id: hold.id }, data: { outcomeWhy: 'not_rereserved', lastError: String(err.message).slice(0, 1000) } });
      await ticketNote(hold.ticketId, hold.workspaceId, `Assetron: the approval request is live again but ${assetLabel(hold.asset)} could not be held again (${err.message}). Pick another laptop on the approval.`);
      return false;
    }
  }

  /**
   * Change the laptop and/or recipient of a PENDING request. Admins and the
   * original requester only. The new hold is taken first; the old one is
   * then released, so the request is never without a laptop.
   */
  async change(ticketId, workspaceId, approvalId, rawHardware, actor) {
    const approval = await prisma.ticketApproval.findFirst({ where: { id: Number(approvalId), ticketId, workspaceId } });
    if (!approval) throw new NotFoundError('Approval not found');
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    const isRequester = actor?.email && String(approval.requestedBy || '').toLowerCase() === String(actor.email).toLowerCase();
    if (!isAdmin && !isRequester) throw bad('Only an admin or the person who requested this approval can change the laptop or who it is for');
    const groupRows = await prisma.ticketApproval.findMany({ where: { requestGroupId: approval.requestGroupId }, select: { status: true } });
    if (!groupRows.some((r) => OPEN_STATUSES.includes(r.status))) throw bad('This approval is already decided — the laptop can no longer be changed');
    const hardware = this.normalizeHardware(rawHardware);
    if (!hardware) throw bad('Pick a laptop and who it is for');
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true } });
    const existing = await prisma.assetronReservation.findUnique({ where: { requestGroupId: approval.requestGroupId } });
    const sameLaptop = existing && existing.state === 'reserved' && existing.assetId === hardware.assetId;
    if (sameLaptop) {
      if (String(existing.recipientEmail || '').toLowerCase() === hardware.recipient.email.toLowerCase()) return this.forGroup(approval.requestGroupId);
      // Assetron answers a second POST for the same ticket + laptop with the
      // EXISTING reservation (and its old recipient). A new person on the same
      // laptop therefore needs the old reservation closed first.
      await assetronClient.decideReservation(existing.reservationId, {
        status: 'CANCELLED', decidedBy: { email: actor?.email || null, displayName: actor?.name || actor?.email || null }, decidedAt: new Date().toISOString(),
        reason: 'Ticket Pulse: the laptop is now for someone else',
      });
      await prisma.assetronReservation.update({ where: { id: existing.id }, data: { state: 'released', outcome: 'CANCELLED', outcomeWhy: 'replaced', completedAt: new Date() } });
    }
    let reserved;
    try {
      reserved = await this.reserve({ ticket, requestGroupId: approval.requestGroupId, hardware, actor });
    } catch (err) {
      if (sameLaptop) {
        await ticketNote(ticketId, workspaceId, `Assetron: ${assetLabel(existing.asset)} was released to change who it is for, but could not be held again for ${hardware.recipient.name || hardware.recipient.email} (${err.message}). Pick the laptop again on the approval.`);
      }
      throw err;
    }
    if (!sameLaptop && existing && existing.state === 'reserved' && existing.reservationId !== reserved.reservationId) {
      try {
        await assetronClient.decideReservation(existing.reservationId, {
          status: 'CANCELLED', decidedBy: { email: actor?.email || null, displayName: actor?.name || null }, decidedAt: new Date().toISOString(),
          reason: 'Ticket Pulse: the laptop or recipient was changed',
        });
      } catch (err) {
        // Keep a separate release record so the reconciler keeps trying.
        await prisma.assetronReservation.create({
          data: {
            workspaceId, ticketId, requestGroupId: `${approval.requestGroupId}:replaced:${crypto.randomUUID().slice(0, 8)}`,
            approvalCategoryId: existing.approvalCategoryId, reservationId: existing.reservationId, assetId: existing.assetId, asset: existing.asset,
            recipientEmail: existing.recipientEmail, recipientName: existing.recipientName, state: 'reserved', pendingOutcome: 'CANCELLED', outcomeWhy: 'replaced',
            attempts: 1, nextAttemptAt: new Date(Date.now() + 2 * 60 * 1000), lastError: String(err.message).slice(0, 1000),
          },
        }).catch(() => {});
      }
    }
    const data = {
      reservationId: reserved.reservationId, assetId: hardware.assetId, asset: reserved.asset,
      recipientEmail: hardware.recipient.email, recipientName: hardware.recipient.name, recipientEntraId: reserved.entraObjectId,
      state: 'reserved', outcome: null, outcomeWhy: null, pendingOutcome: null, completedAt: null, attempts: 0, lastError: null,
    };
    if (existing) await prisma.assetronReservation.update({ where: { id: existing.id }, data });
    else await prisma.assetronReservation.create({ data: { ...data, workspaceId, ticketId, requestGroupId: approval.requestGroupId, approvalCategoryId: approval.approvalCategoryId, requestedByEmail: approval.requestedBy } });
    await ticketNote(ticketId, workspaceId, `Assetron: the request now holds ${assetLabel(reserved.asset)} for ${hardware.recipient.name || hardware.recipient.email} (changed by ${actor?.name || actor?.email}).`);
    return this.forGroup(approval.requestGroupId);
  }

  /** The hold for one request group, shaped for the app. */
  async forGroup(requestGroupId) {
    const r = await prisma.assetronReservation.findUnique({ where: { requestGroupId } });
    return r ? shape(r) : null;
  }

  /** All holds on a ticket, keyed by request group (approval timeline). */
  async forTicket(ticketId, workspaceId) {
    const rows = await prisma.assetronReservation.findMany({ where: { ticketId, workspaceId, NOT: { requestGroupId: { contains: ':replaced:' } } } });
    return Object.fromEntries(rows.map((r) => [r.requestGroupId, shape(r)]));
  }

  /** The laptop behind a ticket's approval verdict (API v1 `asset`), or null. */
  async verdictAsset(ticketId, workspaceId) {
    const r = await prisma.assetronReservation.findFirst({
      where: { ticketId, workspaceId, state: { in: ['reserved', 'assigned'] }, NOT: { requestGroupId: { contains: ':replaced:' } } },
      orderBy: { updatedAt: 'desc' },
    }).catch(() => null);
    if (!r) return null;
    const a = r.asset || {};
    return {
      system: 'ASSETRON', assetId: r.assetId, reservationId: r.reservationId, state: r.state === 'assigned' ? 'ASSIGNED' : 'ON_HOLD',
      serialNumber: a.serialNumber || null, assetTag: a.assetTag || null, make: a.make || null, model: a.model || null,
      recipient: { email: r.recipientEmail, name: r.recipientName || null },
    };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._running || !this.isConfigured()) return;
      this._running = true;
      this.reconcile().catch((err) => logger.warn(`Assetron sweep failed (non-fatal): ${err.message}`)).finally(() => { this._running = false; });
    }, SWEEP_MS);
    if (this._timer.unref) this._timer.unref();
    // One connection check after boot, so the log says straight away whether
    // the token, the role grant and the base URL work (go-live, 26 Sep 2026).
    if (this.isConfigured()) {
      const t = setTimeout(() => { this.checkConnection().catch(() => {}); }, 20_000);
      if (t.unref) t.unref();
    }
  }

  /** Reads filter-options once; logs and returns what happened. */
  async checkConnection() {
    if (!this.isConfigured()) return { ok: false, error: 'not configured' };
    try {
      const options = await assetronClient.filterOptions();
      const keys = Object.keys(options || {});
      logger.info(`Assetron connected: filter-options answered with ${keys.length} filters (${keys.join(', ')})`);
      return { ok: true, filters: keys };
    } catch (err) {
      const why = err instanceof AssetronError ? `${err.status ?? 'no answer'} ${err.code}${err.reason ? ` ${err.reason}` : ''}: ${err.message}` : err.message;
      logger.warn(`Assetron connection check failed — ${why}`);
      return { ok: false, error: why };
    }
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }
}

function shape(r) {
  return {
    requestGroupId: r.requestGroupId, reservationId: r.reservationId, assetId: r.assetId, asset: r.asset || null,
    label: assetLabel(r.asset), recipient: { email: r.recipientEmail, name: r.recipientName || null },
    state: r.state, pendingOutcome: r.pendingOutcome || null, outcome: r.outcome || null, why: r.outcomeWhy || null,
    lastError: r.lastError || null, attempts: r.attempts || 0, requestedBy: r.requestedByEmail || null, updatedAt: r.updatedAt,
  };
}

const assetronReservationService = new AssetronReservationService();
export default assetronReservationService;
export { AssetronReservationService };
