// Phase SLA rollout backfill (v3.5.04-preview, QA 08-17 #9): recompute the
// SLA clocks of EXISTING open tickets under the business-hours calendar,
// for workspaces that opted into calendar-aware SLAs.
//
//   node scripts/recompute-sla-calendar.mjs                 # DRY-RUN, dev DB
//   node scripts/recompute-sla-calendar.mjs --apply         # write, dev DB
//   node scripts/recompute-sla-calendar.mjs --prod          # DRY-RUN, prod DB
//   node scripts/recompute-sla-calendar.mjs --prod --apply  # write, prod DB
//   ... --workspace 2                                       # limit to one ws
//
// Scope (deliberately narrow):
//   - only workspaces where workspaces.sla_calendar_aware = true
//   - only Open-BASE tickets (per the workspace status registry) — Pending
//     already pauses, terminal tickets are history and must not move
//   - only tickets with due_by_set_by = 'sla' (the policy clock stamped the
//     date at creation). 'manual' dates are an agent's word — NEVER touched.
//   - frDueBy is recomputed only when the ticket still has one AND first
//     response hasn't happened yet (rewriting a met/late target rewrites
//     history).
//   - dueBySetBy stays 'sla'.
//
// TRIGGER RE-ARM HANDLING (the known side effect): the sla_pre_breach /
// sla_breach time triggers dedupe on stamps that EMBED the dueBy ISO string
// (notificationTimeTriggerService: `sla_pre:<m>m:<dueByISO>` /
// `sla_breach:<dueByISO>`, folded into notification_workflow_runs.dedupe_key
// which is UNIQUE). Changing dueBy therefore re-arms every SLA workflow for
// every moved ticket — a notification burst on the backfill tick. This script
// prevents that: for each moved ticket it finds the live workflow-run rows
// whose dedupe_key ends with the OLD dueBy ISO (i.e. that trigger already
// FIRED for the old date) and inserts a synthetic, already-completed run row
// with the SAME key rewritten to the NEW ISO (status 'completed',
// trigger_source 'sla_calendar_backfill', no steps/deliveries). The engine's
// dedupe then treats the new date as already handled. Tickets whose old date
// never fired keep their re-arm — that is CORRECT behavior (the new, later
// date should still alert when it actually passes).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');
const wsArgIdx = process.argv.indexOf('--workspace');
const ONLY_WS = wsArgIdx > -1 ? Number(process.argv[wsArgIdx + 1]) : null;

// ---- env loading (pa-migration/lib.mjs pattern: dev DB by default) ----
const dotenv = (file) => {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
};
const localEnv = dotenv(path.resolve(__dirname, '../.env'));
for (const [k, v] of Object.entries(localEnv)) if (!(k in process.env)) process.env[k] = v;
if (PROD) {
  const prodEnv = dotenv(path.resolve(__dirname, '.env.prod'));
  if (!prodEnv.PROD_DATABASE_URL) throw new Error('--prod requested but PROD_DATABASE_URL missing from backend/scripts/.env.prod');
  process.env.DATABASE_URL = prodEnv.PROD_DATABASE_URL;
  console.log('TARGET: PROD database');
} else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing (backend/.env)');
  console.log('TARGET: dev database (pass --prod for the production run)');
}
console.log(`MODE: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}\n`);

// Import AFTER DATABASE_URL is wired — these all share the src prisma singleton,
// so dueDatesFor recomputes with the exact production code path (policy lookup
// + calendarMode + workspace flag + business-calendar walk).
const { default: prisma } = await import('../src/services/prisma.js');
const { default: slaPolicyService } = await import('../src/services/slaPolicyService.js');
const { default: statusService } = await import('../src/services/statusService.js');

const SLA_EVENT_TYPES = ['ticket.sla_pre_breach', 'ticket.sla_breach'];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const short = (d) => (d ? iso(d).replace('T', ' ').slice(0, 16) : '—');

const workspaces = await prisma.workspace.findMany({
  where: {
    isActive: true,
    slaCalendarAware: true,
    ...(ONLY_WS ? { id: ONLY_WS } : {}),
  },
  select: { id: true, name: true },
  orderBy: { id: 'asc' },
});
if (!workspaces.length) {
  console.log(ONLY_WS
    ? `Workspace ${ONLY_WS} is not calendar-aware (or inactive) — nothing to do.`
    : 'No workspaces have sla_calendar_aware = true — nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

const totals = { scanned: 0, moved: 0, unchanged: 0, skippedNoPolicy: 0, frMoved: 0, stampsCloned: 0, stampsExisting: 0 };

for (const ws of workspaces) {
  console.log(`=== workspace #${ws.id} "${ws.name}" ===`);
  const openNames = await statusService.statusNamesForBase(ws.id, 'Open');
  const tickets = await prisma.ticket.findMany({
    where: {
      workspaceId: ws.id,
      origin: 'ticketpulse',
      dueBySetBy: 'sla', // 'manual' NEVER touched; terminal excluded via status
      status: { in: openNames },
      dueBy: { not: null },
    },
    select: {
      id: true, nativeNumber: true, priority: true, ticketType: true, status: true,
      createdAt: true, dueBy: true, frDueBy: true, firstPublicAgentReplyAt: true,
    },
    orderBy: { id: 'asc' },
  });
  console.log(`open-base 'sla'-stamped tickets: ${tickets.length}`);
  if (!tickets.length) { console.log(''); continue; }

  const rows = [];
  for (const t of tickets) {
    totals.scanned += 1;
    const next = await slaPolicyService.dueDatesFor(ws.id, t.priority, new Date(t.createdAt), { typeName: t.ticketType });
    if (!next.dueBy) {
      totals.skippedNoPolicy += 1;
      rows.push({ t, skip: 'no active policy resolves a dueBy anymore' });
      continue;
    }
    const dueMoved = iso(next.dueBy) !== iso(t.dueBy);
    const frEligible = t.frDueBy && !t.firstPublicAgentReplyAt && next.frDueBy;
    const frMoved = frEligible && iso(next.frDueBy) !== iso(t.frDueBy);
    if (!dueMoved && !frMoved) { totals.unchanged += 1; continue; }

    // Pre-stamp planning: live run rows whose dedupe key ends with the OLD
    // dueBy ISO — those triggers already fired for the old date.
    const firedRuns = dueMoved
      ? await prisma.notificationWorkflowRun.findMany({
        where: {
          ticketId: t.id,
          eventType: { in: SLA_EVENT_TYPES },
          executionMode: 'live',
          dryRun: false,
          dedupeKey: { endsWith: `:${iso(t.dueBy)}` },
        },
        select: { id: true, workspaceId: true, workflowId: true, workflowVersionId: true, eventType: true, dedupeKey: true },
      })
      : [];

    rows.push({ t, next, dueMoved, frMoved, firedRuns });
    if (dueMoved) totals.moved += 1;
    if (frMoved) totals.frMoved += 1;
  }

  // Per-ticket old→new table (dry-run AND apply — the audit trail).
  console.log('  ticket   prio  created           dueBy (old → new)                        frDueBy (old → new)                pre-stamps');
  for (const row of rows) {
    const { t } = row;
    const ref = `TP-${t.nativeNumber ?? t.id}`.padEnd(8);
    if (row.skip) {
      console.log(`  ${ref} P${t.priority}    ${short(t.createdAt)}  SKIP: ${row.skip}`);
      continue;
    }
    const due = row.dueMoved ? `${short(t.dueBy)} → ${short(row.next.dueBy)}` : `${short(t.dueBy)} (unchanged)`;
    const fr = row.frMoved ? `${short(t.frDueBy)} → ${short(row.next.frDueBy)}` : (t.frDueBy ? `${short(t.frDueBy)} (kept)` : '—');
    console.log(`  ${ref} P${t.priority}    ${short(t.createdAt)}  ${due.padEnd(40)} ${fr.padEnd(34)} ${row.firedRuns.length}`);
  }

  if (APPLY) {
    for (const row of rows) {
      if (row.skip) continue;
      const { t } = row;
      await prisma.ticket.update({
        where: { id: t.id },
        data: {
          ...(row.dueMoved ? { dueBy: row.next.dueBy } : {}), // dueBySetBy stays 'sla'
          ...(row.frMoved ? { frDueBy: row.next.frDueBy } : {}),
        },
      });
      for (const run of row.firedRuns) {
        const oldSuffix = `:${iso(t.dueBy)}`;
        const newKey = run.dedupeKey.slice(0, run.dedupeKey.length - oldSuffix.length) + `:${iso(row.next.dueBy)}`;
        try {
          await prisma.notificationWorkflowRun.create({
            data: {
              workspaceId: run.workspaceId,
              workflowId: run.workflowId,
              workflowVersionId: run.workflowVersionId,
              ticketId: t.id,
              eventType: run.eventType,
              eventContext: {
                preStamped: true,
                source: 'sla_calendar_backfill',
                note: 'Synthetic dedupe stamp: the old dueBy already fired this trigger; the calendar backfill moved dueBy and this row keeps the engine from re-firing for the new date.',
                oldDueBy: iso(t.dueBy),
                newDueBy: iso(row.next.dueBy),
                clonedFromRunId: run.id,
              },
              status: 'completed',
              triggerSource: 'sla_calendar_backfill',
              completedAt: new Date(),
              durationMs: 0,
              dedupeKey: newKey.slice(0, 255),
              dryRun: false,
              executionMode: 'live',
            },
          });
          totals.stampsCloned += 1;
        } catch (err) {
          if (err?.code === 'P2002') { totals.stampsExisting += 1; continue; } // already stamped — fine
          throw err;
        }
      }
    }
    console.log(`  applied: ${rows.filter((r) => !r.skip).length} ticket updates`);
  } else {
    const wouldStamp = rows.reduce((n, r) => n + (r.firedRuns?.length || 0), 0);
    console.log(`  DRY-RUN: would update ${rows.filter((r) => !r.skip).length} tickets and pre-stamp ${wouldStamp} fired trigger runs`);
  }
  console.log('');
}

console.log('=== totals ===');
console.log(totals);
if (!APPLY) console.log('\nDry-run only — nothing was written. Re-run with --apply.');
await prisma.$disconnect();
