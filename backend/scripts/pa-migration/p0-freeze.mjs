// PA Phase 0 — freeze ws automation + snapshot everything (Project Accounting).
// No FS probes: this workspace stays TP-only (no FS taxonomy objects).
//   node scripts/pa-migration/p0-freeze.mjs                  (dev dry-run: snapshots only)
//   node scripts/pa-migration/p0-freeze.mjs --apply          (dev: also pauses automation)
//   node scripts/pa-migration/p0-freeze.mjs --prod --apply   (PROD run — orchestrator only)
//   node scripts/pa-migration/p0-freeze.mjs [--prod] --undo  (restore assignment config from snapshot)
import { APPLY, mode, resolveWorkspace, snap, readSnap } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');
const ws = await resolveWorkspace(prisma);

if (UNDO) {
  const cfg = readSnap('p0-assignment-config')[0];
  if (!cfg) throw new Error('p0-assignment-config snapshot is empty — nothing to restore');
  await prisma.$executeRawUnsafe(
    'UPDATE assignment_configs SET poll_for_unassigned=$1, dry_run_mode=$2, updated_at=now() WHERE workspace_id=$3',
    cfg.poll_for_unassigned, cfg.dry_run_mode, ws.id,
  );
  console.log(`--undo: restored poll_for_unassigned=${cfg.poll_for_unassigned}, dry_run_mode=${cfg.dry_run_mode}`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`PA Phase 0 (${mode()}) — freeze + snapshot\n`);

// ---- 1. snapshots (abort the whole run if any fails) ----
const cats = await prisma.$queryRawUnsafe(
  `SELECT id, name, description, parent_id, is_active, source, sort_order
   FROM competency_categories WHERE workspace_id=$1 ORDER BY id`, ws.id,
);
snap('p0-categories', cats);

const comps = await prisma.$queryRawUnsafe(
  `SELECT tc.id, tc.technician_id, tc.competency_category_id, tc.proficiency_level, tc.notes, t.name AS tech_name, t.email AS tech_email
   FROM technician_competencies tc JOIN technicians t ON t.id=tc.technician_id
   WHERE tc.workspace_id=$1 ORDER BY tc.id`, ws.id,
);
snap('p0-competencies', comps);

const tickets = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id, ticket_category, internal_category_id, internal_subcategory_id,
          internal_category_fit, internal_subcategory_fit, taxonomy_review_needed, status
   FROM tickets WHERE workspace_id=$1 ORDER BY id`, ws.id,
);
snap('p0-tickets', tickets);

const cfg = await prisma.$queryRawUnsafe(
  'SELECT * FROM assignment_configs WHERE workspace_id=$1', ws.id,
);
snap('p0-assignment-config', cfg);

const prompts = await prisma.$queryRawUnsafe(
  'SELECT id, version, status, created_by, published_by, published_at FROM assignment_prompt_versions WHERE workspace_id=$1 ORDER BY version',
  ws.id,
);
snap('p0-prompt-versions', prompts);

// quick shape summary for the runbook log
const legacyDist = await prisma.$queryRawUnsafe(
  `SELECT COALESCE(ticket_category, '(none)') AS cat, count(*)::int AS n
   FROM tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY n DESC LIMIT 25`, ws.id,
);
console.log('\nlegacy ticketCategory distribution (top 25):');
for (const row of legacyDist) console.log(`  ${String(row.n).padStart(6)}  ${row.cat}`);

// ---- 2. freeze ----
const cur = cfg[0];
if (!cur) {
  console.log('\nno assignment_configs row for this workspace — nothing to freeze (p7 will create one)');
} else {
  console.log(`\ncurrent config: poll_for_unassigned=${cur.poll_for_unassigned} dry_run_mode=${cur.dry_run_mode} auto_assign=${cur.auto_assign} auto_categorize=${cur.auto_categorize_enabled}`);
  if (APPLY) {
    await prisma.$executeRawUnsafe(
      'UPDATE assignment_configs SET poll_for_unassigned=false, dry_run_mode=true, updated_at=now() WHERE workspace_id=$1', ws.id,
    );
    console.log('FROZEN: poll_for_unassigned=false, dry_run_mode=true (restore later with --undo, or p7 sets the target state)');
  } else {
    console.log('(dry-run: would set poll_for_unassigned=false, dry_run_mode=true)');
  }
}

console.log('\nPA Phase 0 OK');
await prisma.$disconnect();
