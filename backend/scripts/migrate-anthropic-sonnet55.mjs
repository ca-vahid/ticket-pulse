// One-off settings migration (28 Sep 2026): ai_provider_settings rows naming Claude Sonnet 5 move to Sonnet 5.5 (the new default; same price, faster).
//
//   DATABASE_URL=... node scripts/migrate-anthropic-sonnet55.mjs          # dry run: prints the diff
//   DATABASE_URL=... node scripts/migrate-anthropic-sonnet55.mjs --apply  # writes
//
// Run only after a release that knows claude-sonnet-5-5 (4.1.01).
import prisma from '../src/services/prisma.js';

const FROM = ['claude-sonnet-5'];
const TO = 'claude-sonnet-5-5';
const APPLY = process.argv.includes('--apply');
const CHANGED_BY = 'model-migration 2026-09-28 (Sonnet 5.5)';

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
