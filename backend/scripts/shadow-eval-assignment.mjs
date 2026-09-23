// Assignment model shadow evaluation (AI cost plan Phase C, §5, 23 Sep 2026).
/* eslint-disable no-console */
//
// Takes a stratified sample of recent LIVE assignment runs per workspace and
// re-runs each ticket through assignmentPipelineService.shadowRun — the live
// pipeline's own prompt assembly, tools and loop — once per model, the models
// side by side at the same moment (ticket state has moved on since the live
// run, so the comparison is between the two shadows, not against the live
// run). Nothing is written: no run/step rows, no ticket fields, no
// FreshService write-back, no provider-attempt rows, no provider health.
//
//   DATABASE_URL=... node --env-file=.env scripts/shadow-eval-assignment.mjs \
//     --ws 1,2 --n 150 --hours 48 --models claude-sonnet-5,gpt-6-sol \
//     --concurrency 3 --out ../qa/evidence-ai-cost/phase-c-shadow
//
// Writes <out>.json (every verdict, resumable) and <out>.html (gates first,
// then the disagreement table with ticket links).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import prisma from '../src/services/prisma.js';
import assignmentPipelineService from '../src/services/assignmentPipelineService.js';
import { costUsdFor } from '../src/services/tokenUsageService.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WORKSPACES = String(arg('--ws', '1,2')).split(',').map(Number).filter(Boolean);
const N = Number(arg('--n', '150'));
const HOURS = Number(arg('--hours', '48'));
const MODELS = String(arg('--models', 'claude-sonnet-5,gpt-6-sol')).split(',').map((s) => s.trim()).filter(Boolean);
const [BASE, CANDIDATE] = MODELS;
const CONCURRENCY = Number(arg('--concurrency', '3'));
const OUT = resolve(arg('--out', '../qa/evidence-ai-cost/phase-c-shadow'));
const APP = 'https://ticketpulse.bgcsaas.com';
const INVOICE_RE = /\b(invoice|bill|billing|statement|remittance|payment|receipt|credit memo|past due|overdue)\b/i;
const AGREEMENT_GATE = { 1: 0.85, 2: 0.90 };
if (WORKSPACES.some((ws) => ws >= 6 && ws <= 8)) throw new Error('sandbox workspaces 6/7/8 are out of scope');

mkdirSync(dirname(OUT), { recursive: true });
const state = existsSync(`${OUT}.json`) ? JSON.parse(readFileSync(`${OUT}.json`, 'utf8')) : { rows: [] };
const save = () => writeFileSync(`${OUT}.json`, JSON.stringify(state, null, 1));

// ---------------------------------------------------------------- sample
// Latest live run per ticket in the window, bucketed so the rare, risky shapes
// are over-represented: noise dismissals, low-confidence runs and after-hours
// priority runs each get up to a quarter of the sample; the rest is ordinary.
async function sampleWorkspace(ws) {
  const rows = await prisma.$queryRaw`
    select distinct on (r.ticket_id) r.id::int run_id, r.ticket_id::int ticket_id, r.trigger_source, r.decision,
      r.recommendation->>'confidence' confidence, r.llm_model, t.subject, t.freshservice_ticket_id::text fs_id
    from assignment_pipeline_runs r join tickets t on t.id = r.ticket_id
    where r.workspace_id = ${ws} and r.status = 'completed' and r.decision is not null
      and r.created_at > now() - make_interval(hours => ${HOURS}::int)
      and r.trigger_source <> 'classification_only'
    order by r.ticket_id, r.created_at desc
    limit 2000`;
  const bucketOf = (r) => (r.decision === 'noise_dismissed' ? 'noise'
    : String(r.trigger_source).includes('after_hours') ? 'after_hours'
      : r.confidence === 'low' ? 'low_confidence' : 'ordinary');
  const buckets = {};
  for (const r of rows.sort(() => Math.random() - 0.5)) (buckets[bucketOf(r)] ||= []).push({ ...r, bucket: bucketOf(r) });
  const quarter = Math.ceil(N / 4);
  const picked = ['noise', 'after_hours', 'low_confidence'].flatMap((b) => (buckets[b] || []).slice(0, quarter));
  const rest = Object.values(buckets).flat().filter((r) => !picked.includes(r));
  return [...picked, ...rest].slice(0, N).map((r) => ({ ...r, ws }));
}

if (!state.rows.length) {
  for (const ws of WORKSPACES) state.rows.push(...await sampleWorkspace(ws));
  state.sampledAt = new Date().toISOString();
  save();
}
console.log(`sample: ${WORKSPACES.map((ws) => `ws${ws} ${state.rows.filter((r) => r.ws === ws).length}`).join(', ')}; models ${MODELS.join(' vs ')}`);

// ---------------------------------------------------------------- run
function summarise(model, res) {
  const rec = res.recommendation || {};
  const top = rec.recommendations?.[0] || null;
  const provider = res.provider || (model.startsWith('claude') ? 'anthropic' : 'openai');
  return {
    ok: true,
    isNoise: res.isNoise,
    noiseVetoed: res.noiseVetoed,
    nonActionable: res.flaggedNonActionable,
    topTechId: top?.techId ?? null,
    topTechName: top?.techName || top?.name || null,
    categoryId: rec.internalCategoryId ?? null,
    subcategoryId: rec.internalSubcategoryId ?? null,
    categoryName: rec.suggestedInternalCategoryName || null,
    confidence: rec.confidence || null,
    priority: rec.assessedPriority || null,
    reasoning: String(rec.overallReasoning || '').slice(0, 600),
    toolCalls: res.toolCalls,
    turns: res.turns,
    ms: res.durationMs,
    usd: costUsdFor({
      provider,
      model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      cacheCreationInputTokens: res.cacheCreationInputTokens,
      cacheReadInputTokens: res.cacheReadInputTokens,
    }),
  };
}

async function runOne(row, model) {
  if (row.results?.[model]?.ok) return;
  try {
    const res = await assignmentPipelineService.shadowRun(row.ticket_id, row.ws, {
      model, liveRunId: row.run_id, triggerSource: row.trigger_source,
    });
    (row.results ||= {})[model] = summarise(model, res);
  } catch (err) {
    (row.results ||= {})[model] = { ok: false, error: String(err.message || err).slice(0, 300) };
  }
}

const queue = state.rows.filter((r) => MODELS.some((m) => !r.results?.[m]?.ok));
let done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const row = queue.shift();
    await Promise.all(MODELS.map((m) => runOne(row, m)));
    done += 1;
    save();
    const r = row.results;
    console.log(`[${done}/${done + queue.length}] ws${row.ws} #${row.ticket_id} ${row.bucket}: `
      + MODELS.map((m) => `${m}=${r[m].ok ? (r[m].isNoise ? 'NOISE' : r[m].topTechName || r[m].topTechId) : 'ERR'}`).join(' '));
  }
}));

// ---------------------------------------------------------------- gates
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Ground truth: who actually took each ticket (read now, after the fact).
// Model-to-model agreement alone cannot say which model is right.
const owners = new Map((await prisma.ticket.findMany({
  where: { id: { in: state.rows.map((r) => r.ticket_id) } },
  select: { id: true, assignedTechId: true, assignedTech: { select: { name: true } } },
})).map((t) => [t.id, { techId: t.assignedTechId, name: t.assignedTech?.name || null }]));

function gatesFor(ws) {
  const rows = state.rows.filter((r) => r.ws === ws);
  const both = rows.filter((r) => r.results?.[BASE]?.ok && r.results?.[CANDIDATE]?.ok);
  const b = (r) => r.results[BASE];
  const c = (r) => r.results[CANDIDATE];
  const extraNoise = both.filter((r) => c(r).isNoise && !b(r).isNoise && !c(r).noiseVetoed);
  const invoiceNoise = both.filter((r) => c(r).isNoise && !c(r).noiseVetoed && INVOICE_RE.test(r.subject || ''));
  const routed = both.filter((r) => !b(r).isNoise && !c(r).isNoise && b(r).topTechId && c(r).topTechId);
  const assigneeAgree = routed.filter((r) => b(r).topTechId === c(r).topTechId).length / (routed.length || 1);
  const categorised = both.filter((r) => b(r).categoryId && c(r).categoryId);
  const categoryAgree = categorised.filter((r) => b(r).categoryId === c(r).categoryId).length / (categorised.length || 1);
  const errors = { [BASE]: rows.filter((r) => r.results?.[BASE] && !r.results[BASE].ok).length, [CANDIDATE]: rows.filter((r) => r.results?.[CANDIDATE] && !r.results[CANDIDATE].ok).length };
  const toolsBase = median(both.map((r) => b(r).toolCalls));
  const toolsCand = median(both.map((r) => c(r).toolCalls));
  const costBase = both.reduce((s, r) => s + b(r).usd, 0) / (both.length || 1);
  const costCand = both.reduce((s, r) => s + c(r).usd, 0) / (both.length || 1);
  const gates = [
    { name: 'Extra noise dismissals vs the base model', value: `${extraNoise.length} of ${both.length} (${pct(extraNoise.length / (both.length || 1))})`, pass: extraNoise.length / (both.length || 1) <= 0.02 },
    { name: 'Invoice/bill/statement tickets dismissed as noise', value: String(invoiceNoise.length), pass: invoiceNoise.length === 0 },
    { name: `Same top assignee (gate ${pct(AGREEMENT_GATE[ws] || 0.85)})`, value: `${pct(assigneeAgree)} of ${routed.length} routed by both`, pass: assigneeAgree >= (AGREEMENT_GATE[ws] || 0.85) },
    { name: 'Same category (gate 85%)', value: `${pct(categoryAgree)} of ${categorised.length}`, pass: categoryAgree >= 0.85 },
    { name: 'Errors', value: `${BASE} ${errors[BASE]} · ${CANDIDATE} ${errors[CANDIDATE]}`, pass: errors[CANDIDATE] <= Math.max(1, errors[BASE]) },
    { name: 'Median tool calls ≥ 60% of the base model', value: `${toolsCand} vs ${toolsBase}`, pass: toolsCand >= 0.6 * toolsBase },
    { name: 'Cost per ticket ≥ 30% lower', value: `$${costCand.toFixed(4)} vs $${costBase.toFixed(4)} (${pct(1 - costCand / (costBase || 1))} lower)`, pass: costCand <= 0.7 * costBase },
  ];
  const disagreements = both.filter((r) => b(r).isNoise !== c(r).isNoise || (b(r).topTechId && c(r).topTechId && b(r).topTechId !== c(r).topTechId) || invoiceNoise.includes(r));
  const owned = both.filter((r) => owners.get(r.ticket_id)?.techId && !b(r).isNoise && !c(r).isNoise);
  const hit = (fn) => owned.filter((r) => fn(r).topTechId === owners.get(r.ticket_id).techId).length;
  const split = owned.filter((r) => b(r).topTechId !== c(r).topTechId);
  const splitHit = (fn) => split.filter((r) => fn(r).topTechId === owners.get(r.ticket_id).techId).length;
  const truth = {
    n: owned.length,
    base: hit(b),
    cand: hit(c),
    split: split.length,
    splitBase: splitHit(b),
    splitCand: splitHit(c),
  };
  return { ws, n: rows.length, both: both.length, gates, disagreements, extraNoise, invoiceNoise, truth };
}

const report = WORKSPACES.map(gatesFor);
const allPass = report.every((r) => r.gates.every((g) => g.pass));
console.log(JSON.stringify(report.map((r) => ({ ws: r.ws, n: r.n, gates: r.gates.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.name}: ${g.value}`) })), null, 1));

const verdictCell = (res) => (!res ? '—' : !res.ok ? `<span class="bad">error: ${esc(res.error)}</span>`
  : `${res.isNoise ? `<b class="bad">noise${res.noiseVetoed ? ' (vetoed)' : ''}</b>` : esc(res.topTechName || `tech ${res.topTechId}`)}<div class="meta">${esc(res.categoryName || '')}${res.confidence ? ` · ${esc(res.confidence)}` : ''} · ${res.toolCalls} tools · $${res.usd.toFixed(3)}</div><div class="why">${esc(res.reasoning)}</div>`);

writeFileSync(`${OUT}.html`, `<!doctype html><html><head><meta charset="utf-8"><title>Assignment shadow test</title>
<style>body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:24px;color:#0f172a;background:#f8fafc;max-width:1400px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p{margin:0 0 12px;color:#475569}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #e2e8f0;padding:8px 10px;vertical-align:top;text-align:left}th{background:#f1f5f9;font-size:12px}
.pass{color:#047857;font-weight:600}.bad,.fail{color:#b91c1c;font-weight:600}.meta{font-size:11px;color:#64748b}.why{font-size:12px;color:#334155;margin-top:4px}.verdict{font-size:17px;margin:12px 0 20px}</style></head><body>
<h1>${esc(CANDIDATE)} vs ${esc(BASE)} on ticket assignment</h1>
<p>Shadow runs through the live pipeline (same prompt, tools and context) · nothing written · sampled ${esc(state.sampledAt)} from the last ${HOURS} h of live runs, noise dismissals, low-confidence and after-hours runs over-sampled.</p>
<div class="verdict">${allPass ? `<span class="pass">Every gate passes.</span> ${esc(CANDIDATE)} can go to a supervised live trial with ${esc(BASE)} kept as fallback.` : `<span class="fail">Not ready.</span> ${esc(CANDIDATE)} fails ${report.flatMap((r) => r.gates.filter((g) => !g.pass).map((g) => `ws${r.ws}: ${g.name}`)).map(esc).join('; ')}.`}</div>
${report.map((r) => `<h2>Workspace ${r.ws} · ${r.both} tickets run by both</h2>
<table><tr><th>Gate</th><th>Result</th><th></th></tr>${r.gates.map((g) => `<tr><td>${esc(g.name)}</td><td>${esc(g.value)}</td><td class="${g.pass ? 'pass' : 'fail'}">${g.pass ? 'pass' : 'fail'}</td></tr>`).join('')}</table>
<h2>Workspace ${r.ws} · where they disagree (${r.disagreements.length})</h2>
<p><b>Against who actually took the ticket</b> (${r.truth.n} tickets that now have an owner): ${esc(BASE)} picked them ${pct(r.truth.base / (r.truth.n || 1))}, ${esc(CANDIDATE)} ${pct(r.truth.cand / (r.truth.n || 1))}. Where the two disagreed (${r.truth.split}): ${esc(BASE)} was right ${r.truth.splitBase}, ${esc(CANDIDATE)} ${r.truth.splitCand}, neither ${r.truth.split - r.truth.splitBase - r.truth.splitCand}.</p>
<table><tr><th>Ticket</th><th>${esc(BASE)}</th><th>${esc(CANDIDATE)}</th></tr>
${r.disagreements.map((d) => `<tr><td style="width:24%"><a href="${APP}/tickets/${d.ticket_id}">#${esc(d.fs_id || d.ticket_id)}</a> ${esc(d.subject)}<div class="meta">${esc(d.bucket)} · live: ${esc(d.decision)}${owners.get(d.ticket_id)?.name ? ` · taken by ${esc(owners.get(d.ticket_id).name)}` : ''}</div></td><td>${verdictCell(d.results[BASE])}</td><td>${verdictCell(d.results[CANDIDATE])}</td></tr>`).join('\n')}</table>`).join('\n')}
</body></html>`);
console.log('wrote', `${OUT}.html`);
await prisma.$disconnect();
process.exit(0);
