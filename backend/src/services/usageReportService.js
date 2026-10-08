import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import { actionLabel } from './usageCatalog.js';
import { pacificDay, pacificParts, dayValue } from './usageStatsService.js';

/**
 * Site stats reports (Settings -> Site stats, super admins only).
 *
 * Reads only the daily tables and the small people / sign-in tables, never
 * raw events. Distinct people are always counted over the range (a person
 * active on Monday and Tuesday is one person), and every count is returned
 * with the number of people it is out of.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const clampDays = (value, fallback = 28) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : fallback;
};
const toDay = (value) => new Date(value).toISOString().slice(0, 10);
const shiftDay = (day, delta) => toDay(dayValue(day).getTime() + delta * DAY_MS);
const isWeekday = (day) => { const d = dayValue(day).getUTCDay(); return d !== 0 && d !== 6; };

/** The last `days` Pacific days, oldest first, ending today. */
export function dayRange(days, now = new Date()) {
  const today = pacificDay(now);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDay(today, -i));
  return out;
}

const ROLE_ORDER = ['super admin', 'admin', 'reviewer', 'standard', 'read-only', 'agent'];
const ROLE_LABEL = { admin: 'admin', reviewer: 'reviewer', viewer: 'standard', readonly: 'read-only' };

/**
 * Everyone who can sign in: workspace access rows, super admins, and active
 * technicians (they get the agent pages from their technician profile).
 */
export async function loadRoster() {
  const [workspaces, access, technicians, adminSetting] = await Promise.all([
    prisma.workspace.findMany({ where: { isActive: true }, select: { id: true, name: true }, take: 200 }),
    prisma.workspaceAccess.findMany({ select: { email: true, workspaceId: true, role: true }, take: 5000 }),
    prisma.technician.findMany({
      where: { isActive: true, email: { not: null } },
      select: { email: true, name: true, workspaceId: true },
      take: 5000,
    }),
    Promise.resolve().then(() => settingsRepository.get('admin_emails')).catch(() => null),
  ]);
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const admins = new Set(
    String(adminSetting && adminSetting.trim() ? adminSetting : process.env.ADMIN_EMAILS || '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  const people = new Map();
  const person = (rawEmail) => {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!email) return null;
    if (!people.has(email)) people.set(email, { email, name: null, workspaces: new Map(), roles: new Set() });
    return people.get(email);
  };
  for (const row of access) {
    if (!wsName.has(row.workspaceId)) continue;
    const p = person(row.email);
    if (!p) continue;
    const role = ROLE_LABEL[row.role] || 'standard';
    p.workspaces.set(row.workspaceId, role);
    p.roles.add(role);
  }
  for (const row of technicians) {
    if (!wsName.has(row.workspaceId)) continue;
    const p = person(row.email);
    if (!p) continue;
    if (!p.name) p.name = row.name;
    if (!p.workspaces.has(row.workspaceId)) p.workspaces.set(row.workspaceId, 'agent');
    p.roles.add('agent');
  }
  for (const email of admins) {
    const p = person(email);
    if (p) p.roles.add('super admin');
  }
  const roster = [...people.values()].map((p) => ({
    email: p.email,
    name: p.name,
    role: ROLE_ORDER.find((r) => p.roles.has(r)) || 'standard',
    workspaces: [...p.workspaces].map(([id, role]) => ({ id, name: wsName.get(id), role })),
  }));
  return { roster, workspaces };
}

const inWorkspace = (p, workspaceId) => !workspaceId || p.role === 'super admin' || p.workspaces.some((w) => w.id === workspaceId);

/** Record that a super admin opened a stats view. Never blocks the report. */
export function logView(viewerEmail, view) {
  return Promise.resolve()
    .then(() => prisma.usageStatsView.create({ data: { viewerEmail: String(viewerEmail || 'unknown').toLowerCase().slice(0, 255), view } }))
    .catch((err) => { logger.debug(`Site stats: view not logged (${err.message})`); });
}

async function dailyRows(fromDay, workspaceId) {
  const rows = await prisma.usageDailyUser.findMany({
    where: { day: { gte: dayValue(fromDay) } },
    select: { day: true, email: true, visits: true, engagedSeconds: true, openSeconds: true, pageViews: true, actions: true, hoursMask: true },
    take: 80000,
  });
  if (!workspaceId) return rows.map((r) => ({ ...r, day: toDay(r.day) }));
  // Workspace filter: a person-day counts when the person did something in that workspace.
  const inWs = await prisma.usageDailyUserItem.groupBy({
    by: ['day', 'email'],
    where: { day: { gte: dayValue(fromDay) }, workspaceId },
  });
  const keep = new Set(inWs.map((r) => `${toDay(r.day)}|${r.email}`));
  return rows.map((r) => ({ ...r, day: toDay(r.day) })).filter((r) => keep.has(`${r.day}|${r.email}`));
}

const distinct = (rows, fromDay, toDayExclusive = null) => {
  const set = new Set();
  for (const r of rows) if (r.day >= fromDay && (!toDayExclusive || r.day < toDayExclusive)) set.add(r.email);
  return set;
};

export async function overview({ days: rawDays, workspaceId: rawWs, now = new Date() } = {}) {
  const days = clampDays(rawDays);
  const workspaceId = Number(rawWs) > 0 ? Number(rawWs) : null;
  const range = dayRange(days, now);
  const today = range[range.length - 1];
  const from = range[0];
  // Enough history for the previous period and the "gone quiet" window.
  const historyFrom = shiftDay(today, -Math.max(days * 2, 56));

  const [{ roster, workspaces }, rows, people, signIns, firstRow, wsActive] = await Promise.all([
    loadRoster(),
    dailyRows(historyFrom, workspaceId),
    prisma.usagePerson.findMany({ select: { email: true, name: true, firstSeenAt: true, lastSeenAt: true, browser: true, device: true, viewport: true }, take: 5000 }),
    prisma.usageSignIn.findMany({ where: { at: { gte: new Date(dayValue(from).getTime()) } }, select: { at: true, outcome: true }, take: 20000 }),
    prisma.usageDailyUser.findFirst({ orderBy: { day: 'asc' }, select: { day: true } }),
    prisma.usageDailyUserItem.groupBy({ by: ['workspaceId', 'email'], where: { day: { gte: dayValue(from) } } }),
  ]);

  const scoped = roster.filter((p) => inWorkspace(p, workspaceId));
  const rosterEmails = new Set(scoped.map((p) => p.email));
  const personByEmail = new Map(people.map((p) => [p.email, p]));
  const nameOf = (email) => personByEmail.get(email)?.name || roster.find((p) => p.email === email)?.name || email;
  const inRange = rows.filter((r) => r.day >= from);

  const window = (n) => {
    const start = shiftDay(today, -(n - 1));
    const prevStart = shiftDay(start, -n);
    return { active: distinct(rows, start).size, previous: distinct(rows, prevStart, start).size };
  };

  const byDay = new Map(range.map((day) => [day, { day, weekday: isWeekday(day), active: 0, engagedMinutes: 0, openMinutes: 0 }]));
  const hours = Array.from({ length: 7 }, () => Array(24).fill(0));
  let visits = 0; let engagedSeconds = 0; let openSeconds = 0; let pageViews = 0; let actions = 0;
  for (const r of inRange) {
    const d = byDay.get(r.day);
    if (d) { d.active += 1; d.engagedMinutes += r.engagedSeconds / 60; d.openMinutes += r.openSeconds / 60; }
    visits += r.visits; engagedSeconds += r.engagedSeconds; openSeconds += r.openSeconds; pageViews += r.pageViews; actions += r.actions;
    const weekday = dayValue(r.day).getUTCDay();
    for (let h = 0; h < 24; h += 1) if (r.hoursMask & (1 << h)) hours[weekday][h] += 1;
  }
  const series = [...byDay.values()].map((d) => ({ ...d, engagedMinutes: Math.round(d.engagedMinutes), openMinutes: Math.round(d.openMinutes) }));

  const activeInRange = distinct(rows, from);
  const byWorkspace = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    people: roster.filter((p) => p.workspaces.some((x) => x.id === w.id)).length,
    active: new Set(wsActive.filter((r) => r.workspaceId === w.id).map((r) => r.email)).size,
  })).sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));

  const byRole = ROLE_ORDER.map((role) => {
    const members = scoped.filter((p) => p.role === role);
    return { role, people: members.length, active: members.filter((p) => activeInRange.has(p.email)).length };
  }).filter((r) => r.people > 0);

  const signInHours = Array(24).fill(0);
  let signInCount = 0;
  for (const s of signIns) { signInHours[pacificParts(s.at).hour] += 1; signInCount += 1; }

  const fromInstant = dayValue(from).getTime();
  const newPeople = people
    .filter((p) => new Date(p.firstSeenAt).getTime() >= fromInstant && (!workspaceId || rosterEmails.has(p.email)))
    .map((p) => ({ email: p.email, name: nameOf(p.email), firstSeenAt: p.firstSeenAt }))
    .sort((a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));
  const recent = distinct(rows, shiftDay(today, -13));
  const earlier = distinct(rows, shiftDay(today, -41), shiftDay(today, -13));
  const quiet = [...earlier].filter((email) => !recent.has(email))
    .map((email) => ({ email, name: nameOf(email), lastSeenAt: personByEmail.get(email)?.lastSeenAt || null }));
  const never = scoped.filter((p) => !personByEmail.has(p.email))
    .map((p) => ({ email: p.email, name: p.name || p.email, role: p.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tally = (field) => {
    const counts = new Map();
    for (const email of activeInRange) {
      const value = personByEmail.get(email)?.[field];
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };

  return {
    days,
    from,
    to: today,
    workspaceId,
    collectionStartedOn: firstRow ? toDay(firstRow.day) : null,
    peopleWithAccess: scoped.length,
    active: { today: window(1), week: window(7), month: window(28), range: activeInRange.size },
    totals: { visits, pageViews, actions, engagedMinutes: Math.round(engagedSeconds / 60), openMinutes: Math.round(openSeconds / 60), signIns: signInCount },
    series,
    byWorkspace,
    byRole,
    hours,
    signInHours,
    browsers: tally('browser'),
    devices: tally('device'),
    viewports: tally('viewport'),
    lists: { newPeople: newPeople.slice(0, 50), quiet: quiet.slice(0, 50), never: never.slice(0, 200) },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
  };
}

export async function peopleReport({ workspaceId: rawWs, now = new Date() } = {}) {
  const workspaceId = Number(rawWs) > 0 ? Number(rawWs) : null;
  const today = pacificDay(now);
  const from84 = shiftDay(today, -83);
  const from28 = shiftDay(today, -27);
  const [{ roster }, rows, people, pageItems] = await Promise.all([
    loadRoster(),
    dailyRows(from84, null),
    prisma.usagePerson.findMany({ take: 5000 }),
    prisma.usageDailyUserItem.groupBy({
      by: ['email', 'key', 'section'],
      where: { day: { gte: dayValue(from28) }, kind: 'page' },
      _sum: { count: true, engagedSeconds: true, openSeconds: true },
    }),
  ]);
  const personByEmail = new Map(people.map((p) => [p.email, p]));
  const rowsByEmail = new Map();
  for (const r of rows) {
    if (!rowsByEmail.has(r.email)) rowsByEmail.set(r.email, []);
    rowsByEmail.get(r.email).push(r);
  }
  const pagesByEmail = new Map();
  for (const item of pageItems) {
    if (!pagesByEmail.has(item.email)) pagesByEmail.set(item.email, []);
    pagesByEmail.get(item.email).push({
      key: item.key, section: item.section, views: item._sum.count || 0, openSeconds: item._sum.openSeconds || 0,
    });
  }
  const rosterByEmail = new Map(roster.map((p) => [p.email, p]));
  // People who used the site but no longer have access still show, marked so.
  const emails = new Set([...rosterByEmail.keys(), ...personByEmail.keys()]);
  const out = [];
  for (const email of emails) {
    const member = rosterByEmail.get(email);
    if (workspaceId && !(member && inWorkspace(member, workspaceId))) continue;
    const seen = personByEmail.get(email);
    const mine = rowsByEmail.get(email) || [];
    const last28 = mine.filter((r) => r.day >= from28);
    const weeks = Array(12).fill(0);
    const hourCounts = Array(24).fill(0);
    for (const r of mine) {
      const age = Math.round((dayValue(today) - dayValue(r.day)) / DAY_MS);
      const week = 11 - Math.floor(age / 7);
      if (week >= 0 && week < 12) weeks[week] += 1;
    }
    for (const r of last28) for (let h = 0; h < 24; h += 1) if (r.hoursMask & (1 << h)) hourCounts[h] += 1;
    const sum = (field) => last28.reduce((total, r) => total + r[field], 0);
    const activeDays = last28.length;
    out.push({
      email,
      name: seen?.name || member?.name || email,
      role: member?.role || null,
      hasAccess: Boolean(member),
      workspaces: member?.workspaces || [],
      firstSeenAt: seen?.firstSeenAt || null,
      lastSeenAt: seen?.lastSeenAt || null,
      lastSignInAt: seen?.lastSignInAt || null,
      signInCount: seen?.signInCount || 0,
      browser: seen?.browser || null,
      device: seen?.device || null,
      viewport: seen?.viewport || null,
      activeDays,
      weeks,
      hourCounts,
      visitsPerDay: activeDays ? Math.round((sum('visits') / activeDays) * 10) / 10 : 0,
      openMinutesPerDay: activeDays ? Math.round(sum('openSeconds') / 60 / activeDays) : 0,
      engagedMinutesPerDay: activeDays ? Math.round(sum('engagedSeconds') / 60 / activeDays) : 0,
      actions: sum('actions'),
      topPages: (pagesByEmail.get(email) || []).sort((a, b) => b.openSeconds - a.openSeconds || b.views - a.views).slice(0, 3),
    });
  }
  // Most recently seen first; people never seen at the end, by name.
  out.sort((a, b) => {
    if (a.lastSeenAt && b.lastSeenAt) return new Date(b.lastSeenAt) - new Date(a.lastSeenAt);
    if (a.lastSeenAt) return -1;
    if (b.lastSeenAt) return 1;
    return a.name.localeCompare(b.name);
  });
  return { today, people: out };
}

export async function itemsReport({ days: rawDays, workspaceId: rawWs, now = new Date() } = {}) {
  const days = clampDays(rawDays);
  const workspaceId = Number(rawWs) > 0 ? Number(rawWs) : null;
  const range = dayRange(days, now);
  const grouped = await prisma.usageDailyUserItem.groupBy({
    by: ['kind', 'key', 'section', 'email'],
    where: { day: { gte: dayValue(range[0]) }, ...(workspaceId ? { workspaceId } : {}) },
    _sum: { count: true, engagedSeconds: true, openSeconds: true },
  });
  const items = new Map();
  for (const g of grouped) {
    const id = `${g.kind}|${g.key}|${g.section}`;
    if (!items.has(id)) items.set(id, { kind: g.kind, key: g.key, section: g.section, people: new Set(), count: 0, engagedSeconds: 0, openSeconds: 0 });
    const item = items.get(id);
    item.people.add(g.email);
    item.count += g._sum.count || 0;
    item.engagedSeconds += g._sum.engagedSeconds || 0;
    item.openSeconds += g._sum.openSeconds || 0;
  }
  const rows = [...items.values()].map((item) => ({
    kind: item.kind,
    key: item.key,
    section: item.section,
    label: item.kind === 'action' ? actionLabel(item.key) : null,
    people: item.people.size,
    count: item.count,
    engagedMinutes: Math.round(item.engagedSeconds / 60),
    openMinutes: Math.round(item.openSeconds / 60),
  })).sort((a, b) => b.people - a.people || b.count - a.count);
  return {
    days,
    from: range[0],
    to: range[range.length - 1],
    workspaceId,
    pages: rows.filter((r) => r.kind === 'page'),
    actions: rows.filter((r) => r.kind !== 'page'),
  };
}

export default { overview, peopleReport, itemsReport, loadRoster, logView, dayRange };
