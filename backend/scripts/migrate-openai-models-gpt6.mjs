// One-off settings migration (23 Sep 2026, plans/AI_MODEL_COST_PLAN.md §3):
// ai_provider_settings rows that name gpt-5.5 or gpt-5.6-sol already RUN as
// GPT-6 Sol (LEGACY_MODEL_ALIASES), but Settings shows the old id. Rewrite the
// rows so what is shown is what runs. gpt-5.6-luna rows are left alone.
//
//   DATABASE_URL=... node scripts/migrate-openai-models-gpt6.mjs          # dry run: prints the diff
//   DATABASE_URL=... node scripts/migrate-openai-models-gpt6.mjs --apply  # writes
//
// Run only after a release that knows gpt-6-sol is live.
import prisma from '../src/services/prisma.js';

const FROM = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
const TO = 'gpt-6-sol';
const APPLY = process.argv.includes('--apply');
const CHANGED_BY = 'model-migration 2026-09-23';

const rows = await prisma.aiProviderSetting.findMany({
  where: { OR: [{ primaryModel: { in: FROM } }, { fallbackModel: { in: FROM } }] },
  select: { id: true, workspaceId: true, operation: true, primaryProvider: true, primaryModel: true, fallbackProvider: true, fallbackModel: true },
  orderBy: [{ workspaceId: 'asc' }, { operation: 'asc' }],
});

let changed = 0;
for (const r of rows) {
  const data = {};
  if (FROM.includes(r.primaryModel)) data.primaryModel = TO;
  if (FROM.includes(r.fallbackModel)) data.fallbackModel = TO;
  if (!Object.keys(data).length) continue;
  console.log(`ws${r.workspaceId} ${r.operation}: primary ${r.primaryProvider}:${r.primaryModel}${data.primaryModel ? ` → ${TO}` : ''} | fallback ${r.fallbackProvider}:${r.fallbackModel}${data.fallbackModel ? ` → ${TO}` : ''}`);
  if (APPLY) await prisma.aiProviderSetting.update({ where: { id: r.id }, data: { ...data, lastChangedBy: CHANGED_BY } });
  changed += 1;
}
console.log(`${APPLY ? 'UPDATED' : 'DRY RUN — would update'} ${changed} of ${rows.length} matching rows.`);
await prisma.$disconnect();
