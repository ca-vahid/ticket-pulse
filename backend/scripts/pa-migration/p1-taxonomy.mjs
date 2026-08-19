// PA Phase 1 — insert the new Project Accounting top categories, retire the
// rest. RETIRE = is_active=false. Never deletes rows (Jul 6 lesson).
// Idempotent: re-running reuses same-name rows (reuse-or-insert).
//   node scripts/pa-migration/p1-taxonomy.mjs                  (dev dry-run)
//   node scripts/pa-migration/p1-taxonomy.mjs --apply          (dev)
//   node scripts/pa-migration/p1-taxonomy.mjs --prod --apply   (PROD — orchestrator only)
//   node scripts/pa-migration/p1-taxonomy.mjs [--prod] --undo  (re-activate old, retire new; needs p0 snapshot)
import { SOURCE, APPLY, mode, resolveWorkspace, loadCategories, readSnap, writeReport } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');
const ws = await resolveWorkspace(prisma);

if (UNDO) {
  const before = readSnap('p0-categories');
  let restored = 0;
  for (const c of before) {
    await prisma.$executeRawUnsafe(
      'UPDATE competency_categories SET is_active=$1 WHERE id=$2 AND workspace_id=$3',
      c.is_active, c.id, ws.id,
    );
    restored += 1;
  }
  const gone = await prisma.$executeRawUnsafe(
    'UPDATE competency_categories SET is_active=false WHERE workspace_id=$1 AND source=$2', ws.id, SOURCE,
  );
  console.log(`--undo: restored is_active on ${restored} rows; retired ${gone} ${SOURCE} rows`);
  await prisma.$disconnect();
  process.exit(0);
}

const NEW_CATEGORIES = loadCategories();
console.log(`PA Phase 1 (${mode()}) — new taxonomy (${NEW_CATEGORIES.length} top-level categories)\n`);

const existing = await prisma.$queryRawUnsafe(
  'SELECT id, name, parent_id, is_active, source FROM competency_categories WHERE workspace_id=$1', ws.id,
);
const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));

// 1. insert (or reuse) the new tops
const newIds = new Map();
let inserted = 0;
for (const [i, cat] of NEW_CATEGORIES.entries()) {
  const hit = byName.get(cat.name.trim().toLowerCase());
  if (hit && hit.parent_id === null) {
    newIds.set(cat.name, Number(hit.id));
    console.log(`  reuse   #${hit.id} ${cat.name} (already exists${hit.is_active ? '' : ', will re-activate'})`);
    if (APPLY) {
      await prisma.$executeRawUnsafe(
        'UPDATE competency_categories SET is_active=true, description=$1, sort_order=$2, source=$3, updated_at=now() WHERE id=$4',
        cat.description, i + 1, SOURCE, hit.id,
      );
    }
    continue;
  }
  if (APPLY) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO competency_categories (workspace_id, name, description, parent_id, is_active, source, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, true, $4, $5, now(), now()) RETURNING id`,
      ws.id, cat.name, cat.description, SOURCE, i + 1,
    );
    newIds.set(cat.name, Number(rows[0].id));
    console.log(`  insert  #${rows[0].id} ${cat.name}`);
  } else {
    console.log(`  insert  (new) ${cat.name}`);
  }
  inserted += 1;
}

// 2. retire everything active that is NOT one of the new set
const keepIds = [...newIds.values()];
if (APPLY) {
  const retired = await prisma.$executeRawUnsafe(
    `UPDATE competency_categories SET is_active=false, updated_at=now()
     WHERE workspace_id=$1 AND is_active=true ${keepIds.length ? `AND id NOT IN (${keepIds.join(',')})` : ''}`,
    ws.id,
  );
  console.log(`\nretired ${retired} old categories (tops + subs)`);
} else {
  const wouldRetire = existing.filter((c) => c.is_active && !keepIds.includes(Number(c.id))).length;
  console.log(`\n(dry-run: would insert ${inserted}, retire ${wouldRetire})`);
}

// 3. review artifact + verification
if (APPLY) {
  const after = await prisma.$queryRawUnsafe(
    `SELECT id, name, parent_id, is_active, source, sort_order FROM competency_categories
     WHERE workspace_id=$1 AND is_active=true ORDER BY sort_order`, ws.id,
  );
  const lines = [`# PA Phase 1 — active "${ws.name}" taxonomy after apply`, ''];
  for (const c of after) lines.push(`- #${c.id} ${c.name}${c.parent_id ? ` (SUB of ${c.parent_id} — UNEXPECTED)` : ''} [${c.source}]`);
  writeReport('phase1-taxonomy.md', lines.join('\n'));
  const subsActive = after.filter((c) => c.parent_id !== null).length;
  console.log(`verify: ${after.length} active (expect ${NEW_CATEGORIES.length}), active subs: ${subsActive} (expect 0)`);
  if (after.length !== NEW_CATEGORIES.length || subsActive !== 0) throw new Error('PA Phase 1 verification FAILED');
  console.log('PA Phase 1 verification OK');
}
await prisma.$disconnect();
