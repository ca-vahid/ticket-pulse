// Level match replay (26 Oct 2026): what would Level match have done on one day?
/* eslint-disable no-console */
//
// For every ticket the AI auto-assigned in the workspace on --day (local), re-runs
// the ticket through assignmentPipelineService.shadowRun (same prompt, tools and
// model as live; nothing written) to get the level the request needs, then
// applies the Level match rule IN TIME ORDER with simulated loads: each person's
// "today" count is what they really had from other work, plus what the rule
// itself would have given them earlier in the day.
//
//   DATABASE_URL=...connection_limit=4 node --env-file=.env scripts/replay-level-match.mjs \
//     --ws 1 --day 2026-10-26 --out ../../level-match-replay-1026 [--concurrency 3]
//
// Writes <out>.json (resumable: shadow results are cached per ticket).
// Caveats printed with the result: open-ticket counts are today's, not the
// day's; the AI's candidate list reflects loads at replay time.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prisma from '../src/services/prisma.js';
import assignmentPipelineService from '../src/services/assignmentPipelineService.js';
import levelMatchService from '../src/services/assignmentLevelMatch/levelMatchService.js';
import { decide } from '../src/services/assignmentLevelMatch/rules.js';
import { getTodayRange } from '../src/utils/timezone.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WS = Number(arg('--ws', '1'));
const DAY = arg('--day');
const OUT = resolve(arg('--out', `../../level-match-replay-${DAY}`));
const CONCURRENCY = Number(arg('--concurrency', '3'));
if (!DAY) throw new Error('--day YYYY-MM-DD is required');
if (WS >= 6 && WS <= 9) throw new Error('sandbox workspaces are out of scope');

const workspace = await prisma.workspace.findUnique({ where: { id: WS }, select: { defaultTimezone: true } });
const tz = workspace?.defaultTimezone || 'America/Vancouver';
const { start, end } = getTodayRange(tz, new Date(`${DAY}T12:00:00Z`));

// The first automatic assignment of each ticket that day.
const runs = await prisma.$queryRaw`
  select distinct on (r.ticket_id) r.id::int run_id, r.ticket_id::int ticket_id, r.created_at, r.llm_model, r.llm_provider,
    r.assigned_tech_id::int assigned_tech_id, tech.name assigned_name, t.subject, t.native_number::int native_number,
    t.freshservice_ticket_id::text fs_id, t.origin
  from assignment_pipeline_runs r join tickets t on t.id = r.ticket_id left join technicians tech on tech.id = r.assigned_tech_id
  where r.workspace_id = ${WS} and r.decision = 'auto_assigned' and r.created_at >= ${start} and r.created_at <= ${end}
  order by r.ticket_id, r.created_at asc`;
runs.sort((a, b) => a.created_at - b.created_at);
console.log(`${runs.length} auto-assigned tickets in ws${WS} on ${DAY}`);

const state = existsSync(`${OUT}.json`) ? JSON.parse(readFileSync(`${OUT}.json`, 'utf8')) : { shadows: {} };
const save = () => writeFileSync(`${OUT}.json`, JSON.stringify(state, null, 1));

// ---- 1. the AI's judgement (parallel, cached)
const todo = runs.filter((r) => !state.shadows[r.ticket_id]);
let next = 0;
async function worker() {
  while (next < todo.length) {
    const r = todo[next++];
    try {
      const res = await assignmentPipelineService.shadowRun(r.ticket_id, WS, { model: r.llm_model, provider: r.llm_provider || null, liveRunId: r.run_id, triggerSource: 'app_native' });
      const rec = res?.recommendation || {};
      state.shadows[r.ticket_id] = {
        ok: true,
        requiredLevel: rec.requiredLevel || null,
        requiredLevelReason: rec.requiredLevelReason || null,
        internalCategoryId: rec.internalCategoryId ?? null,
        internalSubcategoryId: rec.internalSubcategoryId ?? null,
        recommendations: (rec.recommendations || []).map((x) => ({ rank: x.rank, techId: x.techId, techName: x.techName, score: x.score })),
      };
      console.log(`  ${r.ticket_id}: ${rec.requiredLevel || '(no level)'} — ${(rec.recommendations || []).map((x) => x.techName).join(', ')}`);
    } catch (err) {
      state.shadows[r.ticket_id] = { ok: false, error: err.message.slice(0, 300) };
      console.log(`  ${r.ticket_id}: ERROR ${err.message.slice(0, 120)}`);
    }
    save();
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

// ---- 2. the rule, in time order, with simulated loads
const replayIds = new Set(runs.map((r) => r.ticket_id));
const actualBefore = (techId, t) => runs.filter((r) => r.created_at < t && r.assigned_tech_id === techId).length;
const simulated = new Map();
const rows = [];
for (const r of runs) {
  const sh = state.shadows[r.ticket_id];
  const ref = r.origin === 'ticketpulse' && r.native_number ? `TP-${r.native_number}` : r.fs_id ? `#${r.fs_id}` : `#${r.ticket_id}`;
  const row = { ref, ticketId: r.ticket_id, at: r.created_at, subject: r.subject, actual: r.assigned_name || null };
  if (!sh?.ok) { rows.push({ ...row, outcome: 'error', note: sh?.error || 'no shadow' }); continue; }
  const recommendation = { ...sh, requiredLevel: sh.requiredLevel };
  const candidates = await levelMatchService.loadCandidates({ workspaceId: WS, ticketId: r.ticket_id, recommendation, now: new Date(r.created_at) });
  for (const c of candidates) {
    // Replace the day's real automatic picks with the rule's own picks so far.
    c.today = Math.max(0, c.today - actualBefore(c.techId, r.created_at) + (simulated.get(c.techId) || 0));
  }
  // The rule judges the AI's own first choice in the replay.
  const aiPickId = sh.recommendations[0]?.techId || null;
  const result = aiPickId ? decide({ requiredLevel: sh.requiredLevel, aiPickId, candidates, ...(arg('--margin') ? { scoreMargin: Number(arg('--margin')) } : {}) }) : { outcome: 'no_pick', techId: null };
  const finalId = result.techId || r.assigned_tech_id;
  simulated.set(finalId, (simulated.get(finalId) || 0) + 1);
  const finalName = candidates.find((c) => c.techId === finalId)?.techName || (finalId === r.assigned_tech_id ? r.assigned_name : `#${finalId}`);
  rows.push({
    ...row,
    requiredLevel: sh.requiredLevel,
    reason: sh.requiredLevelReason,
    aiPick: sh.recommendations[0]?.techName || null,
    levelMatch: finalName,
    outcome: result.outcome,
    sentence: result.sentence || null,
    considered: (result.considered || []).map((c) => `${c.techName} (${c.level}, ${c.today} today, ${c.open} open)`).join('; '),
  });
}
state.rows = rows;
state.replayedAt = new Date().toISOString();
save();

const tally = (key) => rows.reduce((m, r) => { const k = r[key] || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('\nactual   :', tally('actual'));
console.log('levelMatch:', tally('levelMatch'));
console.log('levels   :', tally('requiredLevel'));
console.log('outcomes :', tally('outcome'));
console.log(`\nwritten ${OUT}.json (${replayIds.size} tickets)`);
await prisma.$disconnect();
