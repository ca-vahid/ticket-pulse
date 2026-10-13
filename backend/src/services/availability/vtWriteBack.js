/**
 * Availability → Vacation Tracker write-back (13 Oct 2026, Vahid).
 *
 * While people still look at Vacation Tracker, a request approved in
 * Availability is added there as an approved leave, and cancelled there when
 * it is cancelled here. Ticket Pulse stays the owner of these requests:
 *
 * - the request keeps source 'app' and gets externalId 'vt:<leaveId>';
 * - the hourly Vacation Tracker import skips those leaves (no duplicate
 *   request), and the hourly leave sync skips them too (the request's own
 *   projection already wrote the dashboard rows);
 * - a failed write never blocks the approval. Every attempt is an event on
 *   the request ('vt_written', 'vt_write_failed', 'vt_write_skipped',
 *   'vt_cancelled', 'vt_cancel_failed'); the hourly sweep retries the
 *   failures that can succeed later.
 *
 * Needs an API v2 key with leaves:write and leaves:approve (Settings →
 * Vacation Tracker). The switch is Availability → Settings → General.
 */
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import VacationTrackerV2Client, { describeV2Error, looksLikeV2Key } from '../../integrations/vacationTrackerV2.js';
import { dayKey, toDay } from './availabilityRules.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const CACHE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HALF_DAY = { am: [8, 12], pm: [13, 17] };

export const VT_EXTERNAL_PREFIX = 'vt:';
export const isVtExternalId = (id) => String(id || '').startsWith(VT_EXTERNAL_PREFIX);

/** The Availability leave type a Vacation Tracker type name imports as (same three steps as the import). */
export function avTypeForVtName(vtName, types) {
  const name = lc(vtName);
  const names = (t) => (Array.isArray(t.vtLeaveTypeNames) ? t.vtLeaveTypeNames.map(lc) : []);
  return types.find((t) => names(t).includes(name))
    || types.find((t) => lc(t.name) === name)
    || types.find((t) => names(t).some((n) => name.includes(n)))
    || null;
}

/** The Vacation Tracker type an Availability type is written as: one that imports back as the same type. */
export function vtTypeForAvType(type, vtTypes, allTypes) {
  const names = Array.isArray(type.vtLeaveTypeNames) ? type.vtLeaveTypeNames.map(lc) : [];
  const rank = (vt) => {
    const n = lc(vt.name);
    if (n === lc(type.name)) return 0;
    const i = names.indexOf(n);
    return i >= 0 ? 1 + i : 100;
  };
  return (vtTypes || [])
    .filter((vt) => vt.isActive !== false && avTypeForVtName(vt.name, allTypes)?.id === type.id)
    .sort((a, b) => rank(a) - rank(b))[0] || null;
}

/** The leave as Vacation Tracker wants it. Half days are 08:00–12:00 and 13:00–17:00. */
export function leaveBodyFor(request, { vtUserId, vtLeaveTypeId }) {
  const body = { userId: vtUserId, leaveTypeId: vtLeaveTypeId, startDate: dayKey(request.startDate), endDate: dayKey(request.endDate) };
  const reason = String(request.note || '').replace(/[<>]/g, '').trim().slice(0, 500);
  if (reason) body.reason = reason;
  let span = null;
  if (HALF_DAY[request.dayPart]) span = HALF_DAY[request.dayPart].map((h) => h * 60);
  else if (request.dayPart === 'hours' && Number.isFinite(request.startMinute) && Number.isFinite(request.endMinute)) span = [request.startMinute, request.endMinute];
  if (span) {
    Object.assign(body, {
      isFullDayLeave: false,
      startHour: Math.floor(span[0] / 60), startMinute: span[0] % 60,
      endHour: Math.floor(span[1] / 60), endMinute: span[1] % 60,
    });
  }
  return body;
}

const errorCode = (err) => err?.response?.data?.error?.code || err?.response?.data?.code || null;
const isTransient = (err) => {
  const s = err?.response?.status;
  return !s || s === 429 || s >= 500 || errorCode(err) === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
};

class VtWriteBack {
  constructor() {
    this._cache = new Map(); // workspaceId -> { at, users, types }
    this._sweeping = false;
  }

  /** Test seam. */
  _client(key) {
    return new VacationTrackerV2Client(key);
  }

  /**
   * Production only, unless AVAILABILITY_VT_WRITE_BACK=true: a developer's
   * machine holds the real Vacation Tracker key and must never write its test
   * requests there.
   */
  async enabled() {
    if (process.env.NODE_ENV !== 'production' && process.env.AVAILABILITY_VT_WRITE_BACK !== 'true') return false;
    const s = await prisma.avSettings.findUnique({ where: { id: 1 } });
    return s ? s.vtWriteBackEnabled !== false : true;
  }

  /** Vacation Tracker accounts we hold a v2 key for. */
  async _accounts() {
    const rows = await prisma.vacationTrackerConfig.findMany({ orderBy: { workspaceId: 'asc' } });
    return rows
      .map((r) => ({ workspaceId: r.workspaceId, key: looksLikeV2Key(r.apiKeyV2) ? r.apiKeyV2 : (looksLikeV2Key(r.apiKey) ? r.apiKey : null) }))
      .filter((a) => a.key);
  }

  async _directory(account, client) {
    const hit = this._cache.get(account.workspaceId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const [users, types] = await Promise.all([client.listUsers(), client.listLeaveTypes()]);
    const entry = { at: Date.now(), users, types };
    this._cache.set(account.workspaceId, entry);
    return entry;
  }

  /** The account this person is a user of: { account, client, vtUser, types }. */
  async _locate(email, { workspaceId = null } = {}) {
    let accounts = await this._accounts();
    if (workspaceId) accounts = accounts.filter((a) => a.workspaceId === workspaceId);
    if (!accounts.length) return { reason: 'no_key' };
    for (const account of accounts) {
      const client = this._client(account.key);
      const dir = await this._directory(account, client);
      const vtUser = dir.users.find((u) => lc(u.email) === lc(email) && String(u.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
      if (vtUser) return { account, client, vtUser, types: dir.types };
    }
    return { reason: 'no_user' };
  }

  async _event(requestId, kind, details, data = {}) {
    await prisma.avRequest.update({ where: { id: requestId }, data: { ...data, events: { create: { kind, actor: 'vacation_tracker', details } } } });
  }

  /** An approved leave already in Vacation Tracker with the same person, type and dates. */
  async _findExisting(client, body) {
    const leaves = await client.listLeaves({ startDate: body.startDate, endDate: body.endDate, status: 'APPROVED' });
    return leaves.find((l) => l.userId === body.userId && l.leaveTypeId === body.leaveTypeId
      && String(l.startDate).slice(0, 10) === body.startDate && String(l.endDate).slice(0, 10) === body.endDate) || null;
  }

  async _linked(request, leaveId, workspaceId, extra = {}) {
    const externalId = `${VT_EXTERNAL_PREFIX}${leaveId}`;
    const holder = await prisma.avRequest.findFirst({ where: { externalId, id: { not: request.id } }, select: { id: true } });
    // Someone entered it in both places: the imported request keeps the link.
    await this._event(request.id, 'vt_written', { vtLeaveId: leaveId, workspaceId, ...extra, ...(holder ? { heldByRequest: holder.id } : {}) }, holder ? {} : { externalId });
    return { ok: true, vtLeaveId: leaveId, ...extra };
  }

  /**
   * Add an approved Availability request to Vacation Tracker. Never throws.
   * Returns { ok } | { skipped } | { failed, permanent }.
   */
  async pushApproved(requestId) {
    let request = null;
    try {
      request = await prisma.avRequest.findUnique({ where: { id: Number(requestId) } });
      if (!request || request.status !== 'approved' || request.source !== 'app' || request.externalId) return { skipped: 'not_applicable' };
      if (!(await this.enabled())) return { skipped: 'off' };
      const found = await this._locate(request.email);
      if (found.reason === 'no_key') return { skipped: 'no_key' };
      if (found.reason === 'no_user') {
        await this._event(request.id, 'vt_write_skipped', { reason: 'Not a Vacation Tracker user' });
        return { skipped: 'no_user' };
      }
      const { account, client, vtUser, types } = found;
      const allTypes = await prisma.avLeaveType.findMany();
      const type = allTypes.find((t) => t.id === request.leaveTypeId);
      const vtType = type ? vtTypeForAvType(type, types, allTypes) : null;
      if (!vtType) {
        await this._event(request.id, 'vt_write_skipped', { reason: `No Vacation Tracker leave type matches "${type?.name || request.leaveTypeId}"` });
        return { skipped: 'no_type' };
      }
      const body = leaveBodyFor(request, { vtUserId: vtUser.id, vtLeaveTypeId: vtType.id });
      const key = `tp-av-${request.id}`;
      let res;
      try {
        res = await client.createLeave(body, { idempotencyKey: key });
      } catch (err) {
        const code = errorCode(err);
        if (code === 'AUTOMATION_OVERRIDE_REQUIRED') {
          // Approved here already; Vacation Tracker's own limits do not get a second say.
          const codes = (err.response.data.error?.details?.warnings || []).map((w) => w.code).filter(Boolean);
          res = await client.createLeave({ ...body, overrideAutomations: codes }, { idempotencyKey: `${key}-o` });
        } else if (code === 'LEAVE_OVERLAP') {
          const twin = await this._findExisting(client, body);
          if (twin) return await this._linked(request, twin.id, account.workspaceId, { alreadyThere: true });
          throw err;
        } else throw err;
      }
      let leaveId = res?.data?.id || null;
      if (!leaveId) {
        // 202: still being written. Look for it once; the sweep tries again otherwise.
        await new Promise((r) => setTimeout(r, 1500));
        leaveId = (await this._findExisting(client, body))?.id || null;
        if (!leaveId) throw Object.assign(new Error('Vacation Tracker is still writing the leave'), { transient: true });
      }
      const out = await this._linked(request, leaveId, account.workspaceId, { vtLeaveType: vtType.name });
      logger.info(`Availability: request ${request.id} written to Vacation Tracker as ${leaveId}`);
      return out;
    } catch (err) {
      const permanent = !(err.transient || isTransient(err));
      const message = err.response ? describeV2Error(err) : err.message;
      logger.warn(`Availability: Vacation Tracker write failed for request ${requestId}${permanent ? '' : ' (will retry)'}: ${message}`);
      if (request) await this._event(request.id, 'vt_write_failed', { error: String(message).slice(0, 500), code: errorCode(err), permanent }).catch(() => {});
      return { failed: message, permanent };
    }
  }

  /** Cancel in Vacation Tracker the leave this request wrote there. Never throws. */
  async pushCancelled(requestId, reason = null) {
    let request = null;
    try {
      request = await prisma.avRequest.findUnique({ where: { id: Number(requestId) }, include: { events: { where: { kind: 'vt_written' }, orderBy: { id: 'desc' }, take: 1 } } });
      if (!request || request.status !== 'cancelled' || request.source !== 'app' || !isVtExternalId(request.externalId)) return { skipped: 'not_applicable' };
      if (!(await this.enabled())) return { skipped: 'off' };
      const leaveId = request.externalId.slice(VT_EXTERNAL_PREFIX.length);
      const workspaceId = request.events[0]?.details?.workspaceId || null;
      const accounts = (await this._accounts()).filter((a) => !workspaceId || a.workspaceId === workspaceId);
      if (!accounts.length) return { skipped: 'no_key' };
      const client = this._client(accounts[0].key);
      try {
        await client.cancelLeave(leaveId, { reason: reason ? String(reason).replace(/[<>]/g, '').slice(0, 500) : 'Cancelled in Ticket Pulse', idempotencyKey: `tp-av-${request.id}-cancel` });
      } catch (err) {
        // Already cancelled or deleted there: nothing left to do.
        if (!['RESOURCE_NOT_FOUND', 'LEAVE_REQUEST_NOT_EDITABLE'].includes(errorCode(err))) throw err;
      }
      await this._event(request.id, 'vt_cancelled', { vtLeaveId: leaveId });
      logger.info(`Availability: request ${request.id} cancelled in Vacation Tracker (${leaveId})`);
      return { ok: true };
    } catch (err) {
      const permanent = !isTransient(err);
      const message = err.response ? describeV2Error(err) : err.message;
      logger.warn(`Availability: Vacation Tracker cancel failed for request ${requestId}${permanent ? '' : ' (will retry)'}: ${message}`);
      if (request) await this._event(request.id, 'vt_cancel_failed', { error: String(message).slice(0, 500), code: errorCode(err), permanent }).catch(() => {});
      return { failed: message, permanent };
    }
  }

  /**
   * Hourly, after the Vacation Tracker import: write what is still owed.
   * Covers approvals made while Vacation Tracker was unreachable and upcoming
   * leave approved before the write-back existed. One sweep at a time.
   */
  async sweep({ today = new Date(), limit = 100 } = {}) {
    if (this._sweeping) return { skipped: 'running' };
    this._sweeping = true;
    const out = { written: 0, cancelled: 0, failed: 0 };
    try {
      if (!(await this.enabled()) || !(await this._accounts()).length) return { skipped: 'off' };
      const settled = (r, done, fail) => r.events.some((e) => done.includes(e.kind) || (e.kind === fail && e.details?.permanent))
        || r.events.filter((e) => e.kind === fail).length >= MAX_ATTEMPTS;
      const events = { where: { kind: { startsWith: 'vt_' } }, select: { kind: true, details: true } };
      const owed = await prisma.avRequest.findMany({
        where: { status: 'approved', source: 'app', externalId: null, endDate: { gte: toDay(today) } },
        include: { events }, orderBy: { startDate: 'asc' }, take: 500,
      });
      for (const r of owed.filter((x) => !settled(x, ['vt_written', 'vt_write_skipped'], 'vt_write_failed')).slice(0, limit)) {
        const res = await this.pushApproved(r.id);
        if (res.ok) out.written += 1; else if (res.failed) out.failed += 1;
      }
      const since = new Date(today.getTime() - 14 * 86400000);
      const undone = await prisma.avRequest.findMany({
        where: { status: 'cancelled', source: 'app', externalId: { startsWith: VT_EXTERNAL_PREFIX }, updatedAt: { gte: since } },
        include: { events }, take: 200,
      });
      for (const r of undone.filter((x) => !settled(x, ['vt_cancelled'], 'vt_cancel_failed')).slice(0, limit)) {
        const res = await this.pushCancelled(r.id);
        if (res.ok) out.cancelled += 1; else if (res.failed) out.failed += 1;
      }
      if (out.written || out.cancelled || out.failed) logger.info('Availability: Vacation Tracker write-back sweep', out);
      return out;
    } finally {
      this._sweeping = false;
    }
  }

  /** Leave ids Ticket Pulse wrote (or linked) itself: the hourly leave sync leaves these alone. */
  async ownedLeaveIds() {
    const rows = await prisma.avRequest.findMany({
      where: { source: { not: 'vacation_tracker' }, externalId: { startsWith: VT_EXTERNAL_PREFIX }, status: 'approved' },
      select: { externalId: true }, take: 50000,
    });
    return new Set(rows.map((r) => r.externalId.slice(VT_EXTERNAL_PREFIX.length)));
  }
}

export default new VtWriteBack();
