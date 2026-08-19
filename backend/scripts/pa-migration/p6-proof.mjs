// PA Phase 6 — end-to-end pipeline proof on the new PA taxonomy, TP-ONLY.
// Runs a classification_only pipeline on one real open ticket and verifies:
//   1. the ticket lands on one of the new PA category ids (canonical write),
//   2. NO FreshService category write-back happened (ws must NOT be in the
//      FS_TAXONOMY_SYNC set — categoryWritebackStatus should be 'skipped').
// Temporarily lifts dry_run_mode for the single run, then restores it.
// The workspace MUST already be in the canonical set for this proof:
//   CANONICAL_CATEGORY_WORKSPACE_IDS=1,2,5 FS_TAXONOMY_SYNC_WORKSPACE_IDS=1,2 \
//     node scripts/pa-migration/p6-proof.mjs --prod --apply
import { SOURCE, APPLY, resolveWorkspace, readSnap } from './lib.mjs';

if (!APPLY) { console.log('p6 is a live proof — run with --apply'); process.exit(0); }

const { isCanonicalCategoryWorkspace, isFsTaxonomySyncWorkspace } = await import('../../src/utils/workspaceFeatureFlags.js');
const { default: prisma } = await import('../../src/services/prisma.js');
const ws = await resolveWorkspace(prisma);

if (!isCanonicalCategoryWorkspace(ws.id)) {
  throw new Error(`workspace ${ws.id} is not in CANONICAL_CATEGORY_WORKSPACE_IDS — set the env for this proof run (see header)`);
}
if (isFsTaxonomySyncWorkspace(ws.id)) {
  throw new Error(`workspace ${ws.id} IS in the FS taxonomy sync set — that contradicts the ws5 TP-only decision; fix the env before proving`);
}

const newCats = await prisma.$queryRawUnsafe(
  // ws5's taxonomy predates this migration (discovered live in prod) — any active category counts, not just SOURCE-stamped ones
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND is_active=true', ws.id,
);
if (newCats.length === 0) throw new Error('no active PA categories — run Phase 1 first');
const newIds = new Set(newCats.map((c) => Number(c.id)));

// pick one open ticket (prefer one with real content)
const ticket = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id AS fsid, subject FROM tickets
   WHERE workspace_id=$1 AND status IN ('Open','Pending') AND subject IS NOT NULL
   ORDER BY id DESC LIMIT 1`, ws.id,
);
const t = ticket[0];
if (!t) throw new Error('no open ticket found to prove against');
console.log(`proof ticket: local#${t.id}${t.fsid ? ` FS#${t.fsid}` : ' (TP-born)'} "${String(t.subject).slice(0, 60)}"`);

const cfgBefore = readSnap('p0-assignment-config')[0] || {};
await prisma.$executeRawUnsafe('UPDATE assignment_configs SET dry_run_mode=false WHERE workspace_id=$1', ws.id);
console.log('dry_run_mode -> false (temporary)');

try {
  const { default: assignmentPipelineService } = await import('../../src/services/assignmentPipelineService.js');
  console.log('running classification_only pipeline…');
  const run = await assignmentPipelineService.runPipeline(Number(t.id), ws.id, 'classification_only');
  console.log(`run #${run.id}: status=${run.status} decision=${run.decision} syncStatus=${run.syncStatus}`);

  const after = await prisma.$queryRawUnsafe(
    'SELECT internal_category_id AS cat, internal_subcategory_id AS sub, taxonomy_review_needed AS review FROM tickets WHERE id=$1', Number(t.id),
  );
  const runRow = await prisma.$queryRawUnsafe(
    'SELECT category_writeback_status AS cw, category_writeback_error AS cwerr FROM assignment_pipeline_runs WHERE id=$1', Number(run.id),
  );
  const catOk = after[0]?.cat !== null && newIds.has(Number(after[0]?.cat));
  const cw = runRow[0]?.cw || null;
  const fsOk = cw !== 'completed'; // anything but a successful FS write-back
  console.log(`ticket after: internal_category_id=${after[0]?.cat} (in PA set: ${catOk}) sub=${after[0]?.sub ?? '(none — expected)'} review=${after[0]?.review}`);
  console.log(`category write-back: status=${cw ?? '(none)'} err=${runRow[0]?.cwerr ?? ''} (must NOT be 'completed')`);
  const ok = catOk && fsOk;
  console.log(ok ? 'PA Phase 6 pipeline proof OK (canonical write, no FS write-back)' : 'PA Phase 6 pipeline proof FAILED');
  if (!ok) process.exitCode = 1;
} finally {
  const restoreDry = cfgBefore.dry_run_mode ?? true;
  await prisma.$executeRawUnsafe('UPDATE assignment_configs SET dry_run_mode=$1 WHERE workspace_id=$2', restoreDry, ws.id);
  console.log(`dry_run_mode -> ${restoreDry} (restored; p7 sets the final target state)`);
}
await prisma.$disconnect();
