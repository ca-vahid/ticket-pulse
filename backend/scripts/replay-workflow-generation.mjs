// Model-comparison replay for workflow e-mail generation (AI cost plan Phase B,
// 23 Sep 2026). Takes the most recent real LLM-drafted workflow runs of a
// workspace and re-runs each (same published workflow, same ticket) through
// the engine's PREVIEW path — the same path as the in-app "Test" button — once
// per model, with the workspace's model setting overridden in THIS process
// only. Nothing is sent; preview runs and provider attempts are recorded as
// previews (trigger_source 'preview').
//
//   DATABASE_URL=... node --env-file=.env scripts/replay-workflow-generation.mjs --ws 1 --n 20 \
//     --models gpt-6-sol,gpt-6-luna --out ../qa/evidence-ai-cost/phase-b-replay.html
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import prisma from '../src/services/prisma.js';
import providerSettingsService from '../src/services/aiProviders/providerSettingsService.js';
import notificationWorkflowEngine from '../src/services/notificationWorkflowEngine.js';
import * as repo from '../src/services/notificationWorkflowRepository.js';
import { buildPreviewEventContext } from '../src/routes/notificationWorkflow.routes.js';
import { costUsdFor } from '../src/services/tokenUsageService.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WS = Number(arg('--ws', '1'));
const N = Number(arg('--n', '20'));
const MODELS = String(arg('--models', 'gpt-6-sol,gpt-6-luna')).split(',').map((s) => s.trim()).filter(Boolean);
const OUT = resolve(arg('--out', '../qa/evidence-ai-cost/phase-b-replay.html'));
const OP = 'notification_workflow_generation';

let currentModel = null;
const realGetSetting = providerSettingsService.getSetting.bind(providerSettingsService);
providerSettingsService.getSetting = async (workspaceId, operation, legacy) => {
  const s = await realGetSetting(workspaceId, operation, legacy);
  if (operation !== OP || !currentModel) return s;
  return { ...s, primaryProvider: 'openai', primaryModel: currentModel, autoFallbackEnabled: false };
};

// The last N distinct (workflow, ticket) pairs whose real run (live or observe-only) drafted with the LLM.
const pairs = await prisma.$queryRaw`
  select distinct on (r.workflow_id, r.ticket_id) r.id run_id, r.workflow_id, r.ticket_id, r.started_at
  from notification_workflow_runs r
  where r.workspace_id = ${WS} and r.execution_mode in ('live', 'mock') and r.ticket_id is not null
    and exists (select 1 from ai_provider_attempts a where a.notification_workflow_run_id = r.id and a.operation = ${OP} and a.status = 'succeeded')
  order by r.workflow_id, r.ticket_id, r.started_at desc
  limit 400`;
pairs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
const sample = pairs.slice(0, N);
console.log(`ws${WS}: ${sample.length} recent LLM-drafted runs; models ${MODELS.join(', ')}`);

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rows = [];
for (const p of sample) {
  const workflow = await repo.getWorkflow(WS, Number(p.workflow_id));
  const ticket = await prisma.ticket.findFirst({
    where: { id: Number(p.ticket_id), workspaceId: WS },
    include: { workspace: true, requester: true, assignedTech: true, internalCategory: true, internalSubcategory: true },
  });
  if (!workflow || !ticket || !workflow.publishedDefinition) continue;
  const eventContext = await buildPreviewEventContext({ ticket, triggerType: workflow.triggerType });
  const row = { workflow: workflow.name, ticket: ticket.subject, ticketId: ticket.id, results: {} };
  for (const model of MODELS) {
    currentModel = model;
    const t0 = Date.now();
    try {
      const res = await notificationWorkflowEngine.executePreview({ workflow, definition: workflow.publishedDefinition, eventContext, executeLlm: true });
      const llm = res.state?.llm || {};
      const u = llm.usage || {};
      row.results[model] = {
        ok: Boolean(llm.email?.html || llm.email?.text),
        ranModel: llm.model || null,
        fallbackUsed: Boolean(llm.fallbackUsed),
        guardAccepted: llm.guard ? llm.guard.accepted !== false : null,
        guardIssues: (llm.guard?.issues || []).map((i) => i.id || i.message || String(i)).slice(0, 4),
        subject: llm.email?.subject || null,
        text: llm.email?.text || String(llm.email?.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        ms: Date.now() - t0,
        usd: costUsdFor({ provider: 'openai', model, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cacheReadInputTokens: u.cacheReadInputTokens || 0 }),
      };
    } catch (err) {
      row.results[model] = { ok: false, error: err.message, ms: Date.now() - t0 };
    }
    const r = row.results[model];
    console.log(`  #${ticket.id} ${model}: ${r.ok ? 'ok' : 'FAIL'} guard=${r.guardAccepted} fallback=${r.fallbackUsed} ${r.ms} ms ${r.error || ''}`);
  }
  rows.push(row);
}
currentModel = null;

const summary = MODELS.map((m) => {
  const rs = rows.map((r) => r.results[m]).filter(Boolean);
  const ok = rs.filter((r) => r.ok).length;
  const guardFail = rs.filter((r) => r.guardAccepted === false).length;
  const fb = rs.filter((r) => r.fallbackUsed).length;
  const usd = rs.reduce((s, r) => s + (r.usd || 0), 0);
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] || 0;
  return { m, n: rs.length, ok, guardFail, fb, usd, ms };
});
console.log(JSON.stringify(summary));

mkdirSync(dirname(OUT), { recursive: true });
const cell = (r) => (!r ? '<td>—</td>' : r.error ? `<td class="bad">Error: ${esc(r.error)}</td>`
  : `<td><div class="meta">${r.ok ? '' : '<b class="bad">no draft</b> · '}${r.guardAccepted === false ? '<b class="bad">guard blocked</b> · ' : ''}${r.fallbackUsed ? '<b class="bad">fell back</b> · ' : ''}${(r.ms / 1000).toFixed(1)} s · $${(r.usd || 0).toFixed(4)}</div>${r.subject ? `<div class="subj">${esc(r.subject)}</div>` : ''}<div class="body">${esc(r.text)}</div></td>`);
writeFileSync(OUT, `<!doctype html><html><head><meta charset="utf-8"><title>Workflow e-mail drafts — ${MODELS.join(' vs ')}</title>
<style>body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:24px;color:#0f172a;background:#f8fafc}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#475569}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #e2e8f0;padding:10px;vertical-align:top;text-align:left}th{background:#f1f5f9;font-size:12px}
.meta{font-size:11px;color:#64748b;margin-bottom:6px}.subj{font-weight:600;margin-bottom:4px}.body{white-space:pre-wrap;font-size:13px}.bad{color:#b91c1c}.case{font-size:12px;color:#334155;width:18%}</style></head><body>
<h1>Workflow e-mail drafts, side by side</h1><p>Workspace ${WS} · the ${rows.length} most recent real runs drafted by the AI (live or observe-only), re-run in preview with each model · nothing was sent.</p>
<table><tr><th>Summary</th>${summary.map((s) => `<th>${esc(s.m)}</th>`).join('')}</tr>
<tr><td class="case">Drafted · guard blocks · fallbacks · median time · total cost</td>${summary.map((s) => `<td>${s.ok}/${s.n} · ${s.guardFail} · ${s.fb} · ${(s.ms / 1000).toFixed(1)} s · $${s.usd.toFixed(3)}</td>`).join('')}</tr></table><br>
<table><tr><th>Workflow · ticket</th>${MODELS.map((m) => `<th>${esc(m)}</th>`).join('')}</tr>
${rows.map((r) => `<tr><td class="case"><b>${esc(r.workflow)}</b><br>#${r.ticketId} ${esc(r.ticket)}</td>${MODELS.map((m) => cell(r.results[m])).join('')}</tr>`).join('\n')}
</table></body></html>`);
console.log('wrote', OUT);
await prisma.$disconnect();
process.exit(0);
