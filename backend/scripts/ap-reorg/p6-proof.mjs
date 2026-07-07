// Phase 6 — end-to-end pipeline proof on the NEW 11-category taxonomy (ws2).
// Runs a classification_only pipeline on one real open FS ticket: LLM classify
// against the 11-tree -> FS lookup write (category set, subcategory cleared)
// -> verify on the FS ticket. Temporarily lifts dry_run_mode for the single
// run, then restores the Phase 0 freeze (poll stays OFF throughout).
//   SKILL_HIERARCHY_WORKSPACE_IDS=1,2 node scripts/ap-reorg/p6-proof.mjs --apply
import { WS, APPLY, readSnap } from './lib.mjs';

if (!APPLY) { console.log('p6 is a live proof — run with --apply'); process.exit(0); }

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: settingsRepository } = await import('../../src/services/settingsRepository.js');
const { createFreshServiceClient } = await import('../../src/integrations/freshservice.js');
const { default: assignmentPipelineService } = await import('../../src/services/assignmentPipelineService.js');

const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(WS);
const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, { priority: 'high', source: 'ap-reorg-p6' });

// pick one open FS-born ticket
const ticket = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id AS fsid, subject FROM tickets
   WHERE workspace_id=$1 AND freshservice_ticket_id IS NOT NULL AND status IN ('Open','Pending')
   ORDER BY id DESC LIMIT 1`, WS,
);
const t = ticket[0];
console.log(`proof ticket: local#${t.id} FS#${t.fsid} "${String(t.subject).slice(0, 60)}"`);

const before = await client.getTicket(Number(t.fsid));
console.log(`FS BEFORE: category=${before.custom_fields?.lf_ticket_pulse_category} subcategory=${before.custom_fields?.lf_ticket_pulse_subcategory}`);

// lift dry-run for this one proof
await prisma.$executeRawUnsafe('UPDATE assignment_configs SET dry_run_mode=false WHERE workspace_id=$1', WS);
console.log('dry_run_mode -> false (temporary)');

try {
  console.log('running classification_only pipeline…');
  const run = await assignmentPipelineService.runPipeline(Number(t.id), WS, 'classification_only');
  console.log(`run #${run.id}: status=${run.status} decision=${run.decision} syncStatus=${run.syncStatus}`);
  const rec = run.recommendation || {};
  console.log(`classified: category=${rec.internalCategoryName || rec.internalCategoryId} sub=${rec.internalSubcategoryName || rec.internalSubcategoryId || '(none — expected)'}`);

  // allow the fire-and-forget sync a moment, then verify on FS
  await new Promise((r) => setTimeout(r, 20000));
  const after = await client.getTicket(Number(t.fsid));
  console.log(`FS AFTER: category=${after.custom_fields?.lf_ticket_pulse_category} subcategory=${after.custom_fields?.lf_ticket_pulse_subcategory}`);
  const displayIds = readSnap('p3-category-displayids').map((r) => r.displayId);
  const ok = displayIds.includes(after.custom_fields?.lf_ticket_pulse_category) && !after.custom_fields?.lf_ticket_pulse_subcategory;
  console.log(ok ? 'Phase 6 pipeline proof OK' : 'Phase 6 pipeline proof FAILED (category not one of the 11 / subcategory not cleared)');
  if (!ok) process.exitCode = 1;
} finally {
  await prisma.$executeRawUnsafe('UPDATE assignment_configs SET dry_run_mode=true WHERE workspace_id=$1', WS);
  console.log('dry_run_mode -> true (freeze restored; poll stays off until Phase 7)');
}
await prisma.$disconnect();
