// Phase 1 — insert the 11 new AP top categories, retire everything else (ws2).
// RETIRE = is_active=false. Never deletes rows (Jul 6 lesson).
//   node scripts/ap-reorg/p1-taxonomy.mjs           (dry-run)
//   node scripts/ap-reorg/p1-taxonomy.mjs --apply
//   node scripts/ap-reorg/p1-taxonomy.mjs --undo    (re-activate old, retire new)
import { WS, SOURCE, APPLY, mode, NEW_CATEGORIES, readSnap, writeReport } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');

if (UNDO) {
  const before = readSnap('p0-categories');
  let restored = 0;
  for (const c of before) {
    await prisma.$executeRawUnsafe(
      'UPDATE competency_categories SET is_active=$1 WHERE id=$2 AND workspace_id=$3',
      c.is_active, c.id, WS,
    );
    restored += 1;
  }
  const gone = await prisma.$executeRawUnsafe(
    'UPDATE competency_categories SET is_active=false WHERE workspace_id=$1 AND source=$2', WS, SOURCE,
  );
  console.log(`--undo: restored is_active on ${restored} rows; retired ${gone} ${SOURCE} rows`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Phase 1 (${mode()}) — new taxonomy\n`);

const existing = await prisma.$queryRawUnsafe(
  'SELECT id, name, parent_id, is_active, source FROM competency_categories WHERE workspace_id=$1', WS,
);
const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));

// 1. insert (or reuse) the 11 new tops
const newIds = new Map();
let inserted = 0;
for (const [i, cat] of NEW_CATEGORIES.entries()) {
  const hit = byName.get(cat.name.trim().toLowerCase());
  if (hit && hit.parent_id === null) {
    newIds.set(cat.name, hit.id);
    console.log(`  reuse   #${hit.id} ${cat.name} (already exists${hit.is_active ? '' : ', will re-activate'})`);
    if (APPLY) {
      await prisma.$executeRawUnsafe(
        'UPDATE competency_categories SET is_active=true, description=$1, sort_order=$2, source=$3 WHERE id=$4',
        cat.description, i + 1, SOURCE, hit.id,
      );
    }
    continue;
  }
  if (APPLY) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO competency_categories (workspace_id, name, description, parent_id, is_active, source, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, true, $4, $5, now(), now()) RETURNING id`,
      WS, cat.name, cat.description, SOURCE, i + 1,
    );
    newIds.set(cat.name, Number(rows[0].id));
    console.log(`  insert  #${rows[0].id} ${cat.name}`);
  } else {
    console.log(`  insert  (new) ${cat.name}`);
  }
  inserted += 1;
}

// 2. retire everything that is NOT one of the 11
const keepIds = [...newIds.values()];
if (APPLY) {
  const retired = await prisma.$executeRawUnsafe(
    `UPDATE competency_categories SET is_active=false
     WHERE workspace_id=$1 AND is_active=true ${keepIds.length ? `AND id NOT IN (${keepIds.join(',')})` : ''}`,
    WS,
  );
  console.log(`\nretired ${retired} old categories (tops + subs)`);
} else {
  const wouldRetire = existing.filter((c) => c.is_active && !keepIds.includes(c.id)).length;
  console.log(`\n(dry-run: would insert ${inserted}, retire ${wouldRetire})`);
}

// 3. review artifact + verification
if (APPLY) {
  const after = await prisma.$queryRawUnsafe(
    `SELECT id, name, parent_id, is_active, source, sort_order FROM competency_categories
     WHERE workspace_id=$1 AND is_active=true ORDER BY sort_order`, WS,
  );
  const lines = ['# Phase 1 — active ws2 taxonomy after apply', ''];
  for (const c of after) lines.push(`- #${c.id} ${c.name}${c.parent_id ? ` (SUB of ${c.parent_id} — UNEXPECTED)` : ''} [${c.source}]`);
  writeReport('phase1-taxonomy.md', lines.join('\n'));
  const subsActive = after.filter((c) => c.parent_id !== null).length;
  console.log(`verify: ${after.length} active (expect 11), active subs: ${subsActive} (expect 0)`);
  if (after.length !== 11 || subsActive !== 0) throw new Error('Phase 1 verification FAILED');
  console.log('Phase 1 verification OK');
}
await prisma.$disconnect();
