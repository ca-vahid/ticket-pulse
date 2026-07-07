// Phase 3 — FreshService custom-object cleanup + sync (ws2).
// Deletes ALL existing "Ticket Pulse Subskills" records, then all stale
// "Ticket Pulse Skills" records, then syncs the 11 new categories in and
// drift-checks. TP DB rows are untouched (retired only, Phase 1).
//   SKILL_HIERARCHY_WORKSPACE_IDS=1,2 node scripts/ap-reorg/p3-fs-sync.mjs           (dry-run)
//   SKILL_HIERARCHY_WORKSPACE_IDS=1,2 node scripts/ap-reorg/p3-fs-sync.mjs --apply
import { WS, APPLY, mode, readSnap, snap, NEW_CATEGORIES } from './lib.mjs';

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: settingsRepository } = await import('../../src/services/settingsRepository.js');
const { createFreshServiceClient } = await import('../../src/integrations/freshservice.js');
const { default: skillHierarchyService } = await import('../../src/services/skillHierarchyService.js');

console.log(`Phase 3 (${mode()}) — FS cleanup + sync\n`);

const { skillObjectId, subskillObjectId } = readSnap('p0-fs-objects');
const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(WS);
const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, { priority: 'low', source: 'ap-reorg-p3' });

const displayId = (r) => r?.data?.bo_display_id ?? r?.bo_display_id ?? r?.display_id ?? r?.id ?? null;
const recName = (r) => r?.data?.name ?? r?.name ?? '(unnamed)';
const newNames = new Set(NEW_CATEGORIES.map((c) => c.name.trim().toLowerCase()));

// ---- 1. delete subskill records (children first) ----
const subRecs = await client.listCustomObjectRecords(subskillObjectId);
console.log(`subskill records: ${subRecs.length} — all will be deleted (new taxonomy has no subcategories)`);
if (APPLY) {
  let done = 0;
  for (const r of subRecs) {
    await client.deleteCustomObjectRecord(subskillObjectId, displayId(r));
    done += 1;
    if (done % 20 === 0) console.log(`  deleted ${done}/${subRecs.length} subskills…`);
  }
  console.log(`  deleted ${done} subskill records`);
}

// ---- 2. delete stale skill records (any name not among the 11) ----
const skillRecs = await client.listCustomObjectRecords(skillObjectId);
const stale = skillRecs.filter((r) => !newNames.has(String(recName(r)).trim().toLowerCase()));
console.log(`skill records: ${skillRecs.length}, stale (to delete): ${stale.length}`);
for (const r of stale.slice(0, 20)) console.log(`  stale: #${displayId(r)} ${recName(r)}`);
if (APPLY) {
  let done = 0;
  for (const r of stale) {
    await client.deleteCustomObjectRecord(skillObjectId, displayId(r));
    done += 1;
  }
  console.log(`  deleted ${done} stale skill records`);
}

// ---- 3. sync the 11 in + drift check ----
if (APPLY) {
  const res = await skillHierarchyService.syncFreshserviceObjects(WS, {});
  console.log(`sync: expected skills=${res.expected.skills} subskills=${res.expected.subskills} | created skills=${res.created.skills.length} subskills=${res.created.subskills.length}`);
  if (res.created.skills.length) console.log(`  new skills: ${res.created.skills.join(', ')}`);

  const after = await client.listCustomObjectRecords(skillObjectId);
  const afterSubs = await client.listCustomObjectRecords(subskillObjectId);
  snap('p3-fs-skill-records-after', after);
  console.log(`verify: FS skills=${after.length} (expect 11), subskills=${afterSubs.length} (expect 0)`);
  const missing = NEW_CATEGORIES.filter((c) => !after.some((r) => String(recName(r)).trim().toLowerCase() === c.name.trim().toLowerCase()));
  if (after.length !== 11 || afterSubs.length !== 0 || missing.length) {
    throw new Error(`Phase 3 verification FAILED: count=${after.length} subs=${afterSubs.length} missing=[${missing.map((c) => c.name).join(', ')}]`);
  }
  console.log('Phase 3 verification OK');
  // map for Phase 5: category name -> FS display id
  snap('p3-category-displayids', after.map((r) => ({ name: recName(r), displayId: displayId(r) })));
} else {
  console.log(`(dry-run: would delete ${subRecs.length} subskills + ${stale.length} stale skills, then sync 11 in)`);
}
await prisma.$disconnect();
