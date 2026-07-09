// Phase 2 — sync the AR categories into FreshService custom objects (additive).
// skillHierarchyService.syncFreshserviceObjects only CREATES missing records,
// so the 11 existing AP skill records are untouched.
//
// !! FS is SHARED between dev and prod — the custom objects live in the real
// !! FreshService tenant. Run --apply exactly ONCE, from PROD, at go-live
// !! (after p1 --prod --apply). Dry-run is read-only and safe anywhere.
//
//   node scripts/ar-onboarding/p2-fs-sync.mjs --prod            (dry-run)
//   node scripts/ar-onboarding/p2-fs-sync.mjs --prod --apply    (go-live only)
import { WS, APPLY, PROD, mode, AR_CATEGORIES, snap } from './lib.mjs';

if (APPLY && !PROD) throw new Error('p2 --apply must run with --prod (FS objects are shared; apply from the prod-synced taxonomy).');
if (!process.env.SKILL_HIERARCHY_WORKSPACE_IDS?.split(',').map((s) => s.trim()).includes(String(WS))) {
  process.env.SKILL_HIERARCHY_WORKSPACE_IDS = `${process.env.SKILL_HIERARCHY_WORKSPACE_IDS || '1'},${WS}`;
}

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: settingsRepository } = await import('../../src/services/settingsRepository.js');
const { createFreshServiceClient } = await import('../../src/integrations/freshservice.js');
const { default: skillHierarchyService } = await import('../../src/services/skillHierarchyService.js');

console.log(`AR Phase 2 (${mode()}) — FS custom-object sync (additive)\n`);

const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(WS);
const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, { priority: 'low', source: 'ar-onboarding-p2' });

const objects = await client.listCustomObjects({ workspace_id: fsConfig.workspaceId });
const byTitle = new Map(objects.map((o) => [o.title, o]));
const skillObject = byTitle.get('Ticket Pulse Skills');
if (!skillObject) throw new Error('FS custom object "Ticket Pulse Skills" not found');

const recName = (r) => r?.data?.name ?? r?.name ?? '(unnamed)';
const existing = await client.listCustomObjectRecords(skillObject.id);
const existingNames = new Set(existing.map((r) => String(recName(r)).trim().toLowerCase()));
const missing = AR_CATEGORIES.filter((c) => !existingNames.has(c.name.trim().toLowerCase()));

console.log(`FS skill records now: ${existing.length}; AR categories missing from FS: ${missing.length}`);
for (const c of missing) console.log(`  would create: ${c.name}`);

if (APPLY) {
  const res = await skillHierarchyService.syncFreshserviceObjects(WS, {});
  console.log(`sync: created skills=${res.created.skills.length} (${res.created.skills.join(', ') || 'none'})`);
  const after = await client.listCustomObjectRecords(skillObject.id);
  snap('p2-fs-skill-records-after', after.map((r) => ({ name: recName(r) })));
  const stillMissing = AR_CATEGORIES.filter((c) => !after.some((r) => String(recName(r)).trim().toLowerCase() === c.name.trim().toLowerCase()));
  if (stillMissing.length) throw new Error(`AR Phase 2 verification FAILED — missing in FS: ${stillMissing.map((c) => c.name).join(', ')}`);
  console.log(`AR Phase 2 verification OK — ${after.length} FS skill records (11 AP + ${AR_CATEGORIES.length} AR expected)`);
} else {
  console.log(`\n(dry-run: would create ${missing.length} FS records via syncFreshserviceObjects — AP records untouched)`);
}
await prisma.$disconnect();
