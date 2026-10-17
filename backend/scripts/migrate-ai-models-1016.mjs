// One-off settings migration (16 Oct 2026, Vahid):
// 1. Workflow e-mail drafting runs on Claude Sonnet 5.5 with GPT-6.1 Sol as
//    the backup. GPT-6.1 Sol hung on about half of IT's real drafts (45 s
//    budget); Sonnet 5.5 drafted 10/10 in 7-12 s.
// 2. The small classifiers on Claude Haiku 4.5 move to Haiku 5.5 (same
//    answers in a live check, about a tenth of the price).
// Sandbox workspaces (6-9) are left alone.
//
//   DATABASE_URL=... node scripts/migrate-ai-models-1016.mjs          # dry run
//   DATABASE_URL=... node scripts/migrate-ai-models-1016.mjs --apply  # writes
import prisma from '../src/services/prisma.js';

const APPLY = process.argv.includes('--apply');
const CHANGED_BY = 'model-migration 2026-10-16b';
const SANDBOXES = [6, 7, 8, 9];
const HAIKU_OLD = 'claude-haiku-4-5-20251001';
const HAIKU_NEW = 'claude-haiku-5-5';

let changed = 0;
const drafting = await prisma.aiProviderSetting.findMany({
  where: { operation: 'notification_workflow_generation', workspaceId: { notIn: SANDBOXES } },
  select: { id: true, workspaceId: true, primaryProvider: true, primaryModel: true, fallbackProvider: true, fallbackModel: true },
  orderBy: { workspaceId: 'asc' },
});
for (const r of drafting) {
  const data = { primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-5-5', fallbackProvider: 'openai', fallbackModel: 'gpt-6.1-sol' };
  if (r.primaryModel === data.primaryModel && r.fallbackModel === data.fallbackModel) continue;
  console.log(`ws${r.workspaceId} drafting: ${r.primaryProvider}:${r.primaryModel} / ${r.fallbackProvider}:${r.fallbackModel} → anthropic:claude-sonnet-5-5 / openai:gpt-6.1-sol`);
  if (APPLY) await prisma.aiProviderSetting.update({ where: { id: r.id }, data: { ...data, lastChangedBy: CHANGED_BY } });
  changed += 1;
}

const haiku = await prisma.aiProviderSetting.findMany({
  where: { workspaceId: { notIn: SANDBOXES }, OR: [{ primaryModel: HAIKU_OLD }, { fallbackModel: HAIKU_OLD }] },
  select: { id: true, workspaceId: true, operation: true, primaryModel: true, fallbackModel: true },
  orderBy: [{ workspaceId: 'asc' }, { operation: 'asc' }],
});
for (const r of haiku) {
  const data = {};
  if (r.primaryModel === HAIKU_OLD) data.primaryModel = HAIKU_NEW;
  if (r.fallbackModel === HAIKU_OLD) data.fallbackModel = HAIKU_NEW;
  console.log(`ws${r.workspaceId} ${r.operation}: ${JSON.stringify(data)}`);
  if (APPLY) await prisma.aiProviderSetting.update({ where: { id: r.id }, data: { ...data, lastChangedBy: CHANGED_BY } });
  changed += 1;
}
console.log(`${APPLY ? 'UPDATED' : 'DRY RUN - would update'} ${changed} rows.`);
await prisma.$disconnect();
