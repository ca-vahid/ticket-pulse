#!/usr/bin/env node
/**
 * QA 11-09 #1 — dry run: replay the leave notices of the last N days through
 * the NEW leave planner and print, per notice, what was decided then and what
 * the planner decides now.
 *
 * READ-ONLY. Nothing is written: the planner is pure (planLeaveNotice) and the
 * lookups (hr_lifecycle_events, the notice, the person's open leave tickets,
 * their active parks) are reads.
 *
 *   node scripts/hr-leave-change-dryrun.mjs                     # workspace 1 (IT), last 90 days
 *   node scripts/hr-leave-change-dryrun.mjs --days=30 --workspace=1 [--json]
 *
 * Caveats: "today" for each notice is the day it arrived (as the hook saw
 * it), but the person's held tickets are looked up as they are NOW — a
 * ticket closed since then no longer matches, and a merge the new rule would
 * have done is shown against today's state.
 */
import { pathToFileURL } from 'node:url';

const LEAVE_TYPES = ['leave', 'leave_change'];

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const ws = Number(get('workspace')) || 1;
  if ([6, 7, 8, 9].includes(ws)) throw new Error(`Workspace ${ws} is out of bounds for this script`);
  return { workspaceId: ws, days: Number(get('days')) || 90, json: argv.includes('--json') };
}

/**
 * Reads only. `db` is the Prisma client, `hr` the hrLifecycleService.
 * Returns [{ ticketId, ref, person, at, old: { decision, outcome, summary }, next: { decision, summary, warnings, matched, fromReturn, toReturn } }].
 */
export async function replayLeaveNotices(db, hr, { workspaceId = 1, days = 90, now = new Date() } = {}) {
  const ws = Number(workspaceId);
  const since = new Date(now.getTime() - days * 86400e3);
  const settings = await hr.getSettings(ws, { withTechs: false });
  const tz = await hr._timeZone(ws);
  const events = await db.hrLifecycleEvent.findMany({
    where: { workspaceId: ws, noticeType: { in: LEAVE_TYPES }, createdAt: { gte: since }, ticketId: { not: null } },
    orderBy: { id: 'asc' },
    select: { id: true, ticketId: true, mode: true, decision: true, outcome: true, summary: true, person: true, details: true, createdAt: true },
    take: 2000,
  });
  // One row per notice: the Live event when there is one, else the latest.
  const byTicket = new Map();
  for (const e of events) {
    const had = byTicket.get(e.ticketId);
    if (!had || e.mode === 'live' || had.mode !== 'live') byTicket.set(e.ticketId, e);
  }
  const rows = [];
  for (const e of byTicket.values()) {
    const ticket = await hr._loadTicket(e.ticketId, ws);
    const old = { decision: e.decision, outcome: e.outcome, mode: e.mode, summary: e.summary };
    if (!ticket) {
      rows.push({ ticketId: e.ticketId, ref: `ticket ${e.ticketId}`, person: e.person, at: e.createdAt, old, next: { decision: 'ticket_gone', summary: 'The notice ticket is gone', warnings: [] } });
      continue;
    }
    // Re-read the notice (the stored classification predates the removed-record fields).
    const c = hr.classify(ticket, tz) || e.details?.classification || null;
    if (!c) {
      rows.push({ ticketId: ticket.id, ref: refOf(ticket), person: e.person, at: e.createdAt, old, next: { decision: 'not_a_notice', summary: 'No longer reads as a leave notice', warnings: [] } });
      continue;
    }
    const plan = await hr.plan(ticket, c, settings, tz, { shadow: true, asOf: ticket.createdAt || e.createdAt });
    rows.push({
      ticketId: ticket.id,
      ref: refOf(ticket),
      person: c.person || e.person,
      at: e.createdAt,
      old,
      next: {
        decision: plan.decision, summary: plan.summary, warnings: plan.warnings || [],
        matched: plan.matched || null, fromReturn: plan.fromReturn || null, toReturn: plan.toReturn || null,
        candidates: plan.candidates || null,
      },
    });
  }
  return rows;
}

function refOf(t) {
  if (t.origin === 'ticketpulse' && t.nativeNumber) return `TP-${t.nativeNumber}`;
  return t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `ticket ${t.id}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: prisma } = await import('../src/services/prisma.js');
  const { default: hr } = await import('../src/services/hrLifecycleService.js');
  try {
    const rows = await replayLeaveNotices(prisma, hr, args);
    if (args.json) {
      console.log(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
      return;
    }
    console.log(`DRY RUN (read-only) — leave notices, workspace ${args.workspaceId}, last ${args.days} days: ${rows.length}`);
    const pairs = {};
    for (const r of rows) {
      const key = `${r.old.decision} → ${r.next.decision}`;
      pairs[key] = (pairs[key] || 0) + 1;
      const day = r.at ? new Date(r.at).toISOString().slice(0, 10) : '?';
      console.log('');
      console.log(`${r.ref}  ${day}  ${r.person || '?'}${r.old.decision !== r.next.decision ? '  [CHANGED]' : ''}`);
      console.log(`  then (${r.old.mode}, ${r.old.outcome}): ${r.old.decision} — ${r.old.summary || ''}`);
      console.log(`  now:  ${r.next.decision} — ${r.next.summary || ''}`);
      if (r.next.matched) console.log(`        held ticket ${r.next.matched.ref}: return ${r.next.fromReturn || '?'} → ${r.next.toReturn || '?'}`);
      if (r.next.candidates?.length > 1) console.log(`        candidates: ${r.next.candidates.map((x) => x.ref).join(', ')}`);
      for (const w of r.next.warnings) console.log(`        ! ${w}`);
    }
    console.log('');
    console.log('then → now:');
    for (const [k, n] of Object.entries(pairs).sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log('Nothing written (read-only dry run).');
  } finally {
    await prisma.$disconnect?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
