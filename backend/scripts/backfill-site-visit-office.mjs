#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-off (25 Nov 2026): site visits name their office, and one visit counts once.
 *
 * Part 1, which office. Approved Vacation Pulse site visits (leave types with
 * availability ONSITE) booked before "Which office?" existed carry neither an
 * office nor an "Other site" text. When the booking's note names one of the
 * offices (a whole-word, case-insensitive match on the office name: "Toronto",
 * "toronto office visit", "Toronto site visit with …"), the booking gets that
 * office, and its dashboard rows (technician_leaves: the booking's own
 * 'av:<id>:…' rows, and for a leave imported from Vacation Tracker the leave
 * sync's '<vt leave id>' rows) get the office name and time zone the
 * assigner reads. A note naming no office, or two unrelated ones, is listed
 * and left alone.
 *
 * Part 2, duplicates. The same leave booked in Vacation Tracker AND in
 * Vacation Pulse left two dashboard rows a day: lists every Vacation Tracker
 * row that repeats a Vacation Pulse row (same person, day, kind of leave and
 * part of the day: both full-day, or the same half with the same minutes),
 * and with --apply deletes those Vacation Tracker rows (rows only). It also
 * lists the pairs of requests behind them (imported from Vacation Tracker vs
 * booked here); requests are never deleted or changed: decide those by hand.
 *
 * Note matching can hit an office name that is also a common word, so read
 * the dry run and pass the bookings you checked with --ids.
 *
 * Usage (from backend/):
 *   node scripts/backfill-site-visit-office.mjs                    dry run
 *   node scripts/backfill-site-visit-office.mjs --apply --ids 9001,9002
 *                                                                  write, only for those booking ids
 *   node scripts/backfill-site-visit-office.mjs --apply            write for every match (not advised)
 *   --from 2026-10-01  duplicate scan from this day (default: 30 days ago)
 *   --prod             use PROD_DATABASE_URL from scripts/.env.prod
 * Without --prod it uses DATABASE_URL from the environment, else backend/.env.
 * It prints which database it targets in words, never its address.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PROD = argv.includes('--prod');
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : null;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const ACTOR = 'backfill-site-visit-office script';
const ACTIVE = ['approved', 'pending'];

/** "--ids 9001, 9002" → Set {9001, 9002}; null when not given. Throws on anything else. */
export function parseIds(raw) {
  if (raw === null || raw === undefined) return null;
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const ids = parts.map(Number);
  if (!parts.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('--ids needs a comma list of booking ids, e.g. --ids 9001,9002');
  return new Set(ids);
}

/** The booking id of a Vacation Pulse dashboard row ('av:<id>:w<ws>'), else null. */
const bookingIdOfRow = (row) => {
  const m = /^av:(\d+):/.exec(String(row?.vtLeaveId || ''));
  return m ? Number(m[1]) : null;
};

/**
 * Which database this run targets, in words — never the address, the host or
 * the credentials. `url` is the connection string Prisma will use, `source`
 * where it came from, `prodUrl` the production one when known (to recognise it).
 */
export function describeTarget({ url, source, prodUrl = null }) {
  if (!url) return `no database configured (${source})`;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
  const strip = (u) => String(u || '').replace(/[?&]connection_limit=\d+/, '');
  const where = prodUrl && strip(url) === strip(prodUrl)
    ? 'PRODUCTION database'
    : (/^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/.test(host) ? 'a local database' : 'a remote database');
  return `${where} (${source})`;
}

/** An error message without connection strings or hosts (Prisma names the server it could not reach). */
export function redactConnection(message) {
  return String(message || '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, '<database address>')
    .replace(/`[^`]*:\d+`/g, '<host>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<host>')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|azure\.com|ca)(?::\d+)?\b/gi, '<host>');
}

/**
 * The whole run, with its database and output passed in (tests drive it with
 * a mocked Prisma). `ids` (a Set) limits the writes to those booking ids.
 * Returns what it found and what it wrote.
 */
export async function runBackfill({ prisma, apply = false, ids = null, from = null, now = new Date(), log = console.log } = {}) {
  const { officeFromNote, duplicateLeavePairs, findAppTwin } = await import('../src/services/availability/siteVisit.js');
  const { dayKey, toDay, addDays } = await import('../src/services/availability/availabilityRules.js');
  const since = from ? toDay(from) : addDays(toDay(now), -30);
  if (!since) throw new Error('--from needs a date (YYYY-MM-DD)');
  const chosen = (id) => !ids || ids.has(Number(id));
  log(`${apply ? 'APPLY' : 'DRY-RUN'} — site visit offices, and duplicates from ${dayKey(since)}${ids ? ` · writes limited to bookings ${[...ids].join(', ')}` : ''}`);

  // ---- part 1: which office
  const [offices, types] = await Promise.all([
    prisma.avOffice.findMany({ select: { id: true, name: true, timezone: true, isActive: true } }),
    prisma.avLeaveType.findMany({ select: { id: true, name: true, availability: true, vtLeaveTypeNames: true } }),
  ]);
  const activeOffices = offices.filter((o) => o.isActive !== false);
  const siteTypeIds = types.filter((t) => String(t.availability || '').toUpperCase() === 'ONSITE').map((t) => t.id);
  const requests = siteTypeIds.length
    ? await prisma.avRequest.findMany({
      where: { status: 'approved', leaveTypeId: { in: siteTypeIds }, siteOfficeId: null, siteLocation: null },
      select: { id: true, email: true, note: true, startDate: true, endDate: true, source: true, externalId: true },
      orderBy: { startDate: 'asc' },
    })
    : [];
  log(`\nSite visits with no office: ${requests.length}`);
  const offices1 = [];
  let officesSet = 0;
  let rowsRefreshed = 0;
  for (const r of requests) {
    const office = officeFromNote(r.note, activeOffices);
    const what = `  #${r.id} ${r.email} ${dayKey(r.startDate)}..${dayKey(r.endDate)} (${r.source}) note: ${r.note ? JSON.stringify(r.note) : '(none)'}`;
    if (!office) {
      log(`${what} -> no office named, left alone`);
      continue;
    }
    const rowsWhere = {
      OR: [
        { vtLeaveId: { startsWith: `av:${r.id}:` } },
        ...(String(r.externalId || '').startsWith('vt:') ? [{ vtLeaveId: r.externalId.slice(3) }] : []),
      ],
    };
    const rows = await prisma.technicianLeave.count({ where: rowsWhere });
    const skipped = !chosen(r.id);
    log(`${what} -> ${office.name} (${office.timezone}); ${rows} dashboard row(s) to refresh${skipped ? ' — not in --ids, not written' : ''}`);
    offices1.push({ requestId: r.id, officeId: office.id, officeName: office.name, rows, chosen: !skipped });
    if (!apply || skipped) continue;
    await prisma.avRequest.update({
      where: { id: r.id },
      data: {
        siteOfficeId: office.id,
        events: { create: { kind: 'site_office_set', actor: ACTOR, details: { officeId: office.id, officeName: office.name, from: 'note' } } },
      },
    });
    officesSet += 1;
    const res = await prisma.technicianLeave.updateMany({ where: rowsWhere, data: { siteLocation: office.name, siteTimezone: office.timezone || null } });
    rowsRefreshed += res?.count || 0;
  }

  // ---- part 2: duplicates
  const leaveRows = await prisma.technicianLeave.findMany({
    where: { leaveDate: { gte: since } },
    select: {
      id: true, workspaceId: true, technicianId: true, leaveDate: true, leaveTypeName: true, category: true, vtLeaveId: true,
      isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true,
    },
    orderBy: [{ leaveDate: 'asc' }, { id: 'asc' }],
  });
  const pairs = duplicateLeavePairs(leaveRows, types);
  const toDelete = pairs.filter((p) => chosen(bookingIdOfRow(p.appRow)));
  log(`\nDashboard rows repeated by Vacation Tracker: ${pairs.length}`);
  for (const { vtRow, appRow } of pairs) {
    const skipped = !chosen(bookingIdOfRow(appRow));
    log(`  ws ${vtRow.workspaceId} tech ${vtRow.technicianId} ${dayKey(vtRow.leaveDate)}: row ${vtRow.id} '${vtRow.vtLeaveId}' "${vtRow.leaveTypeName}" repeats '${appRow.vtLeaveId}' "${appRow.leaveTypeName}"${skipped ? ' — booking not in --ids, kept' : ''}`);
  }
  let rowsDeleted = 0;
  if (apply && toDelete.length) {
    const res = await prisma.technicianLeave.deleteMany({ where: { id: { in: toDelete.map((p) => p.vtRow.id) } } });
    rowsDeleted = res?.count || 0;
  }

  const requestSelect = { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, status: true, source: true, externalId: true };
  const [imported, booked] = await Promise.all([
    prisma.avRequest.findMany({ where: { source: 'vacation_tracker', status: { in: ACTIVE }, endDate: { gte: since } }, select: requestSelect }),
    prisma.avRequest.findMany({ where: { source: { not: 'vacation_tracker' }, status: { in: ACTIVE }, endDate: { gte: since } }, select: requestSelect }),
  ]);
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const requestPairs = [];
  for (const r of imported) {
    const twin = findAppTwin(r, booked);
    if (twin) requestPairs.push({ imported: r, booked: twin });
  }
  log(`\nRequests booked twice (never changed by this script; decide by hand): ${requestPairs.length}`);
  for (const { imported: a, booked: b } of requestPairs) {
    log(`  ${a.email} ${typeName.get(a.leaveTypeId) || `type ${a.leaveTypeId}`}: imported #${a.id} (${a.externalId}) ${dayKey(a.startDate)}..${dayKey(a.endDate)} and booked #${b.id} ${dayKey(b.startDate)}..${dayKey(b.endDate)}`);
  }

  const toSet = offices1.filter((o) => o.chosen).length;
  log(apply
    ? `\nDone: ${officesSet} office(s) set, ${rowsRefreshed} dashboard row(s) refreshed, ${rowsDeleted} duplicate row(s) deleted.`
    : `\nDry run: ${toSet} office(s) to set, ${toDelete.length} duplicate row(s) to delete; nothing written — re-run with --apply${ids ? '' : ' --ids <the bookings you checked>'}.`);
  return { offices: offices1, officesSet, rowsRefreshed, duplicateRows: pairs, rowsDeleted, requestPairs };
}

function readEnvValue(file, key) {
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    // "--ids" with nothing after it is an error, never "every booking".
    const ids = parseIds(argv.includes('--ids') ? (argValue('--ids') ?? '') : null);
    const prodUrl = readEnvValue(path.join(here, '.env.prod'), 'PROD_DATABASE_URL');
    let source;
    if (PROD) {
      if (!prodUrl) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
      process.env.DATABASE_URL = prodUrl;
      source = 'scripts/.env.prod';
    } else if (process.env.DATABASE_URL) {
      source = 'DATABASE_URL from the environment';
    } else {
      // The same file Prisma would read by itself; read here so the target is known.
      const local = readEnvValue(path.join(here, '..', '.env'), 'DATABASE_URL');
      if (local) process.env.DATABASE_URL = local;
      source = 'backend/.env';
    }
    // Local scripts never take more than one connection.
    if (process.env.DATABASE_URL && !/connection_limit=/.test(process.env.DATABASE_URL)) {
      process.env.DATABASE_URL += `${process.env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=1`;
    }
    console.log(`TARGET: ${describeTarget({ url: process.env.DATABASE_URL, source, prodUrl })}`);
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ errorFormat: 'minimal' });
    try {
      await runBackfill({ prisma, apply: APPLY, ids, from: argValue('--from') });
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error(`Failed: ${redactConnection(err?.message || err)}`);
    process.exitCode = 1;
  }
}
