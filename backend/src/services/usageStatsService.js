import crypto from 'crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { actionKeyFor, UI_EVENT_KEYS } from './usageCatalog.js';

/**
 * Site stats collection (Settings -> Site stats, super admins only).
 *
 * Three sources feed one in-memory buffer:
 *   - sign-ins, recorded by /auth/sso and /auth/dev-login;
 *   - actions, recorded from the matched route of every finished request;
 *   - page views and time, sent by the browser to POST /api/usage/batch.
 *
 * The buffer is written every 15 s in ONE transaction on one connection, so
 * usage data never competes with real work for the 9-connection pool, and a
 * request never waits for it. Everything here is best-effort: a failure is
 * logged and dropped, it never reaches the caller.
 *
 * What is stored: page names, route patterns, seconds. Never a raw URL, a
 * ticket's content, search text or an IP address.
 */

export const USAGE_TZ = 'America/Vancouver';
export const FLUSH_MS = 15 * 1000;
export const FLUSH_AT = 200;
export const BUFFER_CAP = 5000;
export const ROLLUP_MS = 10 * 60 * 1000;
export const PRUNE_MS = 6 * 60 * 60 * 1000;
export const RAW_RETENTION_DAYS = 90;
export const SUMMARY_RETENTION_DAYS = 365;
export const MAX_BATCH_EVENTS = 100;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const SIGN_IN_DEDUPE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_KEY_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+){0,3}$/;
const SECTION_RE = /^[a-z0-9][a-z0-9_.-]{0,59}$/i;
const VIEWPORTS = new Set(['phone', 'tablet', 'laptop', 'desktop', 'wide']);

let enabledOverride = null;
/** Collection is on unless USAGE_STATS_ENABLED=false. Off under Jest. */
export function isEnabled() {
  if (enabledOverride !== null) return enabledOverride;
  return process.env.USAGE_STATS_ENABLED !== 'false' && process.env.NODE_ENV !== 'test';
}
export function setEnabledForTests(value) { enabledOverride = value; }

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Pacific day ('YYYY-MM-DD'), hour (0-23) and weekday (0 = Sunday) of an instant. */
export function pacificParts(date) {
  const out = {};
  for (const p of partsFormat.formatToParts(date)) out[p.type] = p.value;
  return { day: `${out.year}-${out.month}-${out.day}`, hour: Number(out.hour) % 24, weekday: WEEKDAYS[out.weekday] ?? 0 };
}
export const pacificDay = (date) => pacificParts(date).day;
/** A Pacific day as the DATE value Prisma stores (UTC midnight of that date). */
export const dayValue = (day) => new Date(`${day}T00:00:00.000Z`);

export function describeAgent(userAgent) {
  const s = String(userAgent || '');
  let browser = 'Other';
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let device = 'desktop';
  if (/iPad|Tablet/.test(s)) device = 'tablet';
  else if (/Mobi|iPhone|Android/.test(s)) device = 'phone';
  return { browser, device };
}

const cleanEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 255);
const wsId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 1_000_000 ? n : 0;
};
const seconds = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 24 * 3600) : 0;
};

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------
let buffer = [];
let flushing = false;
let dropped = 0;
const dirtyDays = new Set();

function enqueue(event) {
  if (buffer.length >= BUFFER_CAP) {
    buffer.shift();
    dropped += 1;
    if (dropped === 1 || dropped % 1000 === 0) logger.warn(`Site stats buffer full: ${dropped} event(s) dropped so far`);
  }
  buffer.push(event);
  if (buffer.length >= FLUSH_AT) flush().catch(() => {});
}

/**
 * A batch from the browser. Returns how many events were accepted; anything
 * that does not look right is skipped without an error (the tracker never
 * retries and never shows a failure).
 */
export function acceptBatch(user, body, { userAgent, now = Date.now() } = {}) {
  if (!isEnabled()) return 0;
  const email = cleanEmail(user?.email);
  if (!email || !body || !Array.isArray(body.events)) return 0;
  const sentAt = Number(body.sentAt);
  // A browser clock that is far off moves every event by the same amount.
  const offset = Number.isFinite(sentAt) && Math.abs(now - sentAt) > CLOCK_SKEW_MS ? now - sentAt : 0;
  const visitId = UUID_RE.test(String(body.visitId || '')) ? String(body.visitId).toLowerCase() : null;
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 30) : null;
  const viewport = VIEWPORTS.has(body.viewport) ? body.viewport : null;
  const agent = describeAgent(userAgent);
  let accepted = 0;
  for (const raw of body.events.slice(0, MAX_BATCH_EVENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind === 'ui' ? 'ui' : raw.kind === 'page' ? 'page' : null;
    const key = String(raw.key || '');
    if (!kind || !UUID_RE.test(String(raw.id || ''))) continue;
    if (kind === 'page' ? !PAGE_KEY_RE.test(key) : !UI_EVENT_KEYS.has(key)) continue;
    const section = raw.section ? String(raw.section) : '';
    if (section && !SECTION_RE.test(section)) continue;
    let at = Number(raw.t) + offset;
    if (!Number.isFinite(at)) continue;
    if (at > now + 60 * 1000) at = now;
    if (at < now - MAX_EVENT_AGE_MS) continue;
    enqueue({
      eventUuid: String(raw.id).toLowerCase(),
      occurredAt: new Date(at),
      email,
      name: user?.name || null,
      workspaceId: wsId(raw.ws),
      visitId,
      kind,
      key,
      section: section.toLowerCase(),
      engagedSeconds: kind === 'page' ? seconds(raw.eng) : 0,
      openSeconds: kind === 'page' ? seconds(raw.open) : 0,
      appVersion,
      ...agent,
      viewport,
    });
    accepted += 1;
  }
  return accepted;
}

/**
 * Express middleware: one event per finished request that a signed-in person
 * made to change something (plus the few counted reads in usageCatalog).
 * Mounted before the routers; the identity is read when the response ends.
 */
export function usageActionCapture() {
  return (req, res, next) => {
    res.on('finish', () => {
      try {
        if (!isEnabled()) return;
        if (res.statusCode < 200 || res.statusCode >= 400) return;
        if (typeof req.route?.path !== 'string') return;
        const key = actionKeyFor(req.method, `${req.baseUrl || ''}${req.route.path}`);
        if (!key) return;
        const user = req.session?.user ?? req.user ?? null;
        const email = cleanEmail(user?.email);
        if (!email) return;
        enqueue({
          eventUuid: crypto.randomUUID(),
          occurredAt: new Date(),
          email,
          name: user?.name || null,
          workspaceId: wsId(req.headers?.['x-workspace-id'] ?? user?.selectedWorkspaceId),
          visitId: null,
          kind: 'action',
          key,
          section: '',
          engagedSeconds: 0,
          openSeconds: 0,
          appVersion: null,
          ...describeAgent(req.headers?.['user-agent']),
          viewport: null,
        });
      } catch { /* never let stats touch a request */ }
    });
    next();
  };
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------
const recentSignIns = new Map();

/**
 * Called by the sign-in routes after the token is verified. A call that
 * arrived with a live session for the same person is a silent renewal, not a
 * sign-in, and is not recorded. Returns a promise the caller does NOT await.
 */
export function recordSignIn({ email: rawEmail, name = null, method = 'sso', hadSession = false, hasAccess = true, userAgent, now = Date.now() } = {}) {
  if (!isEnabled()) return Promise.resolve(false);
  const email = cleanEmail(rawEmail);
  if (!email || hadSession) return Promise.resolve(false);
  const last = recentSignIns.get(email);
  if (last && now - last < SIGN_IN_DEDUPE_MS) return Promise.resolve(false);
  recentSignIns.set(email, now);
  if (recentSignIns.size > 2000) {
    for (const [key, at] of recentSignIns) if (now - at > SIGN_IN_DEDUPE_MS) recentSignIns.delete(key);
  }
  const at = new Date(now);
  const agent = describeAgent(userAgent);
  return Promise.resolve()
    .then(() => prisma.$transaction([
      prisma.usageSignIn.create({ data: { email, at, method, outcome: hasAccess ? 'success' : 'no_access', ...agent } }),
      prisma.usagePerson.upsert({
        where: { email },
        create: { email, name, firstSeenAt: at, lastSeenAt: at, lastSignInAt: at, signInCount: 1, ...agent },
        update: { lastSeenAt: at, lastSignInAt: at, signInCount: { increment: 1 }, ...(name ? { name } : {}), ...agent },
      }),
    ]))
    .then(() => true)
    .catch((err) => {
      logger.debug(`Site stats: sign-in not recorded (${err.message})`);
      return false;
    });
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------
const toRow = (e) => ({
  eventUuid: e.eventUuid,
  occurredAt: e.occurredAt,
  email: e.email,
  workspaceId: e.workspaceId,
  visitId: e.visitId,
  kind: e.kind,
  key: e.key,
  section: e.section,
  engagedSeconds: e.engagedSeconds,
  openSeconds: e.openSeconds,
  appVersion: e.appVersion,
});

/**
 * Write the buffer. The browser re-sends a page view with larger time
 * counters while the page stays open, so an event that already exists keeps
 * the larger numbers instead of becoming a second row.
 */
export async function flush() {
  if (flushing || !buffer.length) return 0;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const byUuid = new Map();
    for (const e of batch) {
      const seen = byUuid.get(e.eventUuid);
      if (!seen) { byUuid.set(e.eventUuid, { ...e }); continue; }
      seen.engagedSeconds = Math.max(seen.engagedSeconds, e.engagedSeconds);
      seen.openSeconds = Math.max(seen.openSeconds, e.openSeconds);
    }
    const events = [...byUuid.values()];
    const pages = events.filter((e) => e.kind === 'page');
    const stored = pages.length
      ? await prisma.usageEvent.findMany({
        where: { eventUuid: { in: pages.map((e) => e.eventUuid) } },
        select: { eventUuid: true, engagedSeconds: true, openSeconds: true },
        take: pages.length,
      })
      : [];
    const storedByUuid = new Map(stored.map((r) => [r.eventUuid, r]));

    const people = new Map();
    for (const e of events) {
      const p = people.get(e.email) || { first: e.occurredAt, last: e.occurredAt };
      if (e.occurredAt < p.first) p.first = e.occurredAt;
      if (e.occurredAt >= p.last) p.last = e.occurredAt;
      if (e.name) p.name = e.name;
      // Device facts come from the browser batch when there is one.
      if (e.kind !== 'action' || !p.browser) { p.browser = e.browser; p.device = e.device; }
      if (e.viewport) p.viewport = e.viewport;
      people.set(e.email, p);
    }
    const known = await prisma.usagePerson.findMany({
      where: { email: { in: [...people.keys()] } },
      select: { email: true, lastSeenAt: true },
      take: people.size,
    });
    const knownByEmail = new Map(known.map((r) => [r.email, r]));

    const ops = [];
    const fresh = events.filter((e) => !storedByUuid.has(e.eventUuid));
    if (fresh.length) ops.push(prisma.usageEvent.createMany({ data: fresh.map(toRow), skipDuplicates: true }));
    for (const e of pages) {
      const old = storedByUuid.get(e.eventUuid);
      if (!old) continue;
      if (e.engagedSeconds <= old.engagedSeconds && e.openSeconds <= old.openSeconds) continue;
      ops.push(prisma.usageEvent.update({
        where: { eventUuid: e.eventUuid },
        data: {
          engagedSeconds: Math.max(e.engagedSeconds, old.engagedSeconds),
          openSeconds: Math.max(e.openSeconds, old.openSeconds),
        },
      }));
    }
    for (const [email, p] of people) {
      const facts = {
        ...(p.name ? { name: p.name } : {}),
        ...(p.browser ? { browser: p.browser, device: p.device } : {}),
        ...(p.viewport ? { viewport: p.viewport } : {}),
      };
      const old = knownByEmail.get(email);
      const lastSeenAt = old && old.lastSeenAt > p.last ? old.lastSeenAt : p.last;
      ops.push(prisma.usagePerson.upsert({
        where: { email },
        create: { email, firstSeenAt: p.first, lastSeenAt: p.last, ...facts },
        update: { lastSeenAt, ...facts },
      }));
    }
    if (ops.length) await prisma.$transaction(ops);
    for (const e of events) dirtyDays.add(pacificDay(e.occurredAt));
    return events.length;
  } catch (err) {
    // One more try on the next tick, then give up on this batch.
    const retry = batch.filter((e) => !e.retried).map((e) => ({ ...e, retried: true }));
    if (retry.length && buffer.length + retry.length <= BUFFER_CAP) buffer = retry.concat(buffer);
    logger.warn(`Site stats flush failed (non-fatal): ${err.message}`);
    return 0;
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Daily rollup
// ---------------------------------------------------------------------------
/** Pure: the two daily tables' rows for one Pacific day from raw events. */
export function summariseDay(day, events) {
  const users = new Map();
  const items = new Map();
  for (const e of events) {
    const at = new Date(e.occurredAt);
    const parts = pacificParts(at);
    if (parts.day !== day) continue;
    let u = users.get(e.email);
    if (!u) {
      u = { visits: new Set(), engagedSeconds: 0, openSeconds: 0, pageViews: 0, actions: 0, firstAt: at, lastAt: at, hoursMask: 0 };
      users.set(e.email, u);
    }
    if (e.visitId) u.visits.add(e.visitId);
    u.engagedSeconds += e.engagedSeconds || 0;
    u.openSeconds += e.openSeconds || 0;
    if (e.kind === 'page') u.pageViews += 1; else u.actions += 1;
    if (at < u.firstAt) u.firstAt = at;
    if (at > u.lastAt) u.lastAt = at;
    u.hoursMask |= (1 << parts.hour);

    const section = e.section || '';
    const itemKey = [e.email, e.workspaceId || 0, e.kind, e.key, section].join('\u0001');
    let item = items.get(itemKey);
    if (!item) {
      item = { email: e.email, workspaceId: e.workspaceId || 0, kind: e.kind, key: e.key, section, count: 0, engagedSeconds: 0, openSeconds: 0 };
      items.set(itemKey, item);
    }
    item.count += 1;
    item.engagedSeconds += e.engagedSeconds || 0;
    item.openSeconds += e.openSeconds || 0;
  }
  const date = dayValue(day);
  return {
    users: [...users].map(([email, u]) => ({
      day: date,
      email,
      // A day with actions but no page batch (tracker blocked) is still one visit.
      visits: Math.max(u.visits.size, 1),
      engagedSeconds: u.engagedSeconds,
      openSeconds: u.openSeconds,
      pageViews: u.pageViews,
      actions: u.actions,
      firstAt: u.firstAt,
      lastAt: u.lastAt,
      hoursMask: u.hoursMask,
    })),
    items: [...items.values()].map((item) => ({ day: date, ...item })),
  };
}

/** Rebuild one Pacific day in both daily tables. Safe to repeat. */
export async function rollupDay(day) {
  // Pacific time is behind UTC, so Pacific day D lies inside [D 00:00Z, D+2 00:00Z).
  const start = dayValue(day);
  const end = new Date(start.getTime() + 2 * DAY_MS);
  const events = await prisma.usageEvent.findMany({
    where: { occurredAt: { gte: start, lt: end } },
    select: { email: true, workspaceId: true, visitId: true, kind: true, key: true, section: true, engagedSeconds: true, openSeconds: true, occurredAt: true },
    take: 250000,
  });
  const { users, items } = summariseDay(day, events);
  const ops = [
    prisma.usageDailyUser.deleteMany({ where: { day: start } }),
    prisma.usageDailyUserItem.deleteMany({ where: { day: start } }),
  ];
  if (users.length) ops.push(prisma.usageDailyUser.createMany({ data: users }));
  if (items.length) ops.push(prisma.usageDailyUserItem.createMany({ data: items }));
  await prisma.$transaction(ops);
  return { day, people: users.length, items: items.length };
}

export async function runRollups() {
  const days = [...dirtyDays];
  for (const day of days) {
    try {
      dirtyDays.delete(day);
      await rollupDay(day);
    } catch (err) {
      dirtyDays.add(day);
      logger.warn(`Site stats rollup failed for ${day} (non-fatal): ${err.message}`);
      return;
    }
  }
}

export async function prune(now = Date.now()) {
  const rawCutoff = new Date(now - RAW_RETENTION_DAYS * DAY_MS);
  const summaryCutoff = new Date(now - SUMMARY_RETENTION_DAYS * DAY_MS);
  try {
    await prisma.usageEvent.deleteMany({ where: { occurredAt: { lt: rawCutoff } } });
    await prisma.usageDailyUser.deleteMany({ where: { day: { lt: summaryCutoff } } });
    await prisma.usageDailyUserItem.deleteMany({ where: { day: { lt: summaryCutoff } } });
    await prisma.usageSignIn.deleteMany({ where: { at: { lt: summaryCutoff } } });
    await prisma.usageStatsView.deleteMany({ where: { at: { lt: summaryCutoff } } });
    await prisma.usagePerson.deleteMany({ where: { lastSeenAt: { lt: summaryCutoff } } });
  } catch (err) {
    logger.debug(`Site stats prune failed (non-fatal): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
let timers = [];
export function start() {
  if (timers.length || !isEnabled()) return;
  // A restart may have landed between a flush and its rollup.
  const now = Date.now();
  dirtyDays.add(pacificDay(new Date(now)));
  dirtyDays.add(pacificDay(new Date(now - DAY_MS)));
  timers = [
    setInterval(() => { flush().catch(() => {}); }, FLUSH_MS),
    setInterval(() => { runRollups().catch(() => {}); }, ROLLUP_MS),
    setInterval(() => { prune().catch(() => {}); }, PRUNE_MS),
  ];
  for (const t of timers) t.unref?.();
  logger.info('Site stats collection started');
}

export function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

/** Test seam: buffer contents and reset. */
export const internals = {
  buffered: () => buffer.slice(),
  dirtyDays: () => [...dirtyDays],
  reset: () => { buffer = []; flushing = false; dropped = 0; dirtyDays.clear(); recentSignIns.clear(); },
};

export default {
  isEnabled, acceptBatch, usageActionCapture, recordSignIn, flush, rollupDay, runRollups, prune, start, stop,
};
