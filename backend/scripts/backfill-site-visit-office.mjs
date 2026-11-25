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
 * Part 2, duplicates. The same visit booked in Vacation Tracker AND in
 * Vacation Pulse left two dashboard rows a day: lists every Vacation Tracker
 * row that repeats a Vacation Pulse row (same person, day and kind of leave),
 * and with --apply deletes those Vacation Tracker rows (rows only). It also
 * lists the pairs of requests behind them (imported from Vacation Tracker vs
 * booked here); requests are never deleted or changed: decide those by hand.
 *
 * Usage (from backend/):
 *   node scripts/backfill-site-visit-office.mjs                    dry run, dev DB
 *   node scripts/backfill-site-visit-office.mjs --apply            write, dev DB
 *   node scripts/backfill-site-visit-office.mjs --from 2026-10-01  duplicate scan from this day (default: 30 days ago)
 *   --prod loads PROD_DATABASE_URL from scripts/.env.prod (read the dry run first).
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

/**
 * The whole run, with its database and output passed in (tests drive it with
 * a mocked Prisma). Returns what it found and what it wrote.
 */
export async function runBackfill({ prisma, apply = false, from = null, now = new Date(), log = console.log } = {}) {
  const { officeFromNote, duplicateLeavePairs, findAppTwin } = await import('../src/services/availability/siteVisit.js');
  const { dayKey, toDay, addDays } = await import('../src/services/availability/availabilityRules.js');
  const since = from ? toDay(from) : addDays(toDay(now), -30);
  if (!since) throw new Error('--from needs a date (YYYY-MM-DD)');
  log(`${apply ? 'APPLY' : 'DRY-RUN'} — site visit offices, and duplicates from ${dayKey(since)}`);

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
    log(`${what} -> ${office.name} (${office.timezone}); ${rows} dashboard row(s) to refresh`);
    offices1.push({ requestId: r.id, officeId: office.id, officeName: office.name, rows });
    if (!apply) continue;
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
    select: { id: true, workspaceId: true, technicianId: true, leaveDate: true, leaveTypeName: true, category: true, vtLeaveId: true },
    orderBy: [{ leaveDate: 'asc' }, { id: 'asc' }],
  });
  const pairs = duplicateLeavePairs(leaveRows, types);
  log(`\nDashboard rows repeated by Vacation Tracker: ${pairs.length}`);
  for (const { vtRow, appRow } of pairs) {
    log(`  ws ${vtRow.workspaceId} tech ${vtRow.technicianId} ${dayKey(vtRow.leaveDate)}: row ${vtRow.id} '${vtRow.vtLeaveId}' "${vtRow.leaveTypeName}" repeats '${appRow.vtLeaveId}' "${appRow.leaveTypeName}"`);
  }
  let rowsDeleted = 0;
  if (apply && pairs.length) {
    const res = await prisma.technicianLeave.deleteMany({ where: { id: { in: pairs.map((p) => p.vtRow.id) } } });
    rowsDeleted = res?.count || 0;
  }

  const [imported, booked] = await Promise.all([
    prisma.avRequest.findMany({
      where: { source: 'vacation_tracker', status: { in: ACTIVE }, endDate: { gte: since } },
      select: { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, status: true, source: true, externalId: true },
    }),
    prisma.avRequest.findMany({
      where: { source: { not: 'vacation_tracker' }, status: { in: ACTIVE }, endDate: { gte: since } },
      select: { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, status: true, source: true, externalId: true },
    }),
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

  log(apply
    ? `\nDone: ${officesSet} office(s) set, ${rowsRefreshed} dashboard row(s) refreshed, ${rowsDeleted} duplicate row(s) deleted.`
    : `\nDry run: ${offices1.length} office(s) to set, ${pairs.length} duplicate row(s) to delete; nothing written — re-run with --apply.`);
  return { offices: offices1, officesSet, rowsRefreshed, duplicateRows: pairs, rowsDeleted, requestPairs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (PROD) {
    const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
    const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
    if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
    process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
  }
  // Local scripts never take more than one connection.
  if (process.env.DATABASE_URL && !/connection_limit=/.test(process.env.DATABASE_URL)) {
    process.env.DATABASE_URL += `${process.env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=1`;
  }
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database`);
  try {
    await runBackfill({ prisma, apply: APPLY, from: argValue('--from') });
  } finally {
    await prisma.$disconnect();
  }
}
