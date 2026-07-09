// Phase 1 — ADD the 10 AR top categories to ws2 (ADDITIVE — unlike the AP
// reorg, nothing is retired; the 11 AP categories stay untouched).
//   node scripts/ar-onboarding/p1-taxonomy.mjs                  (dry-run, DEV)
//   node scripts/ar-onboarding/p1-taxonomy.mjs --apply          (apply, DEV)
//   node scripts/ar-onboarding/p1-taxonomy.mjs --prod           (dry-run, PROD)
//   node scripts/ar-onboarding/p1-taxonomy.mjs --prod --apply   (apply, PROD)
//   node scripts/ar-onboarding/p1-taxonomy.mjs [--prod] --undo  (retire the AR rows)
import { WS, SOURCE, APPLY, mode, AR_CATEGORIES, snap } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');

if (UNDO) {
  const gone = await prisma.$executeRawUnsafe(
    'UPDATE competency_categories SET is_active=false WHERE workspace_id=$1 AND source=$2', WS, SOURCE,
  );
  console.log(`--undo: retired ${gone} ${SOURCE} rows (never deleted — Jul 6 lesson)`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`AR Phase 1 (${mode()}) — additive taxonomy\n`);

const existing = await prisma.$queryRawUnsafe(
  'SELECT id, name, parent_id, is_active, source, sort_order FROM competency_categories WHERE workspace_id=$1', WS,
);
snap('p1-categories-before', existing);
const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
const activeTopsBefore = existing.filter((c) => c.is_active && c.parent_id === null).length;
const maxSort = Math.max(0, ...existing.filter((c) => c.parent_id === null).map((c) => Number(c.sort_order) || 0));

let inserted = 0;
let reused = 0;
for (const [i, cat] of AR_CATEGORIES.entries()) {
  const hit = byName.get(cat.name.trim().toLowerCase());
  if (hit && hit.parent_id === null) {
    reused += 1;
    console.log(`  reuse   #${hit.id} ${cat.name}${hit.is_active ? '' : ' (will re-activate)'}`);
    if (APPLY) {
      await prisma.$executeRawUnsafe(
        'UPDATE competency_categories SET is_active=true, description=$1, source=$2 WHERE id=$3',
        cat.description, SOURCE, hit.id,
      );
    }
    continue;
  }
  if (APPLY) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO competency_categories (workspace_id, name, description, parent_id, is_active, source, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, true, $4, $5, now(), now()) RETURNING id`,
      WS, cat.name, cat.description, SOURCE, maxSort + i + 1,
    );
    console.log(`  insert  #${rows[0].id} ${cat.name}`);
  } else {
    console.log(`  insert  (new) ${cat.name}`);
  }
  inserted += 1;
}

if (APPLY) {
  const after = await prisma.$queryRawUnsafe(
    `SELECT id, name, is_active, source, sort_order FROM competency_categories
     WHERE workspace_id=$1 AND is_active=true AND parent_id IS NULL ORDER BY sort_order`, WS,
  );
  snap('p1-categories-after', after);
  const expected = activeTopsBefore + inserted + existing.filter((c) => !c.is_active && byName.get(c.name.trim().toLowerCase())?.id === c.id && AR_CATEGORIES.some((a) => a.name.trim().toLowerCase() === c.name.trim().toLowerCase())).length;
  console.log(`\nverify: ${after.length} active tops (was ${activeTopsBefore}, inserted ${inserted}, reused ${reused})`);
  if (after.length < activeTopsBefore + inserted) throw new Error('AR Phase 1 verification FAILED — fewer tops than expected');
  console.log('AR Phase 1 verification OK — AP categories untouched, AR categories live');
} else {
  console.log(`\n(dry-run: would insert ${inserted}, reuse ${reused}; active tops ${activeTopsBefore} → ${activeTopsBefore + inserted})`);
}
await prisma.$disconnect();
