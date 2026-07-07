/**
 * Repair the Accounting (ws 2) taxonomy on PROD after six top-level categories
 * were deleted (ids 166, 172, 173, 175, 176, 177). The bare delete orphaned
 * their subcategories (parent_id -> NULL via FK), nulled internal_category_id
 * on ~4.4k tickets, and cascade-deleted technician competencies.
 *
 * Dev still holds the pre-deletion state (mirrored from prod before the
 * deletion), so it is the source of truth for names, parent links, and
 * competencies (matched to prod technicians by email).
 *
 * Idempotent: every step only fills gaps (INSERT if missing / UPDATE where
 * NULL), so re-running is safe.
 *
 * Run from backend/:
 *   node scripts/repair-ws2-taxonomy.mjs           # dry run (default)
 *   node scripts/repair-ws2-taxonomy.mjs --apply   # write to prod
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const WS = 2;
const DELETED_IDS = [166, 172, 173, 175, 176, 177];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev URL from backend/.env; prod URL from the untracked scripts/.env.prod
// (never on the command line).
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const devEnv = loadEnv(path.resolve(__dirname, '../.env'));
const prodEnv = loadEnv(path.resolve(__dirname, '.env.prod'));
if (!devEnv.DATABASE_URL) { console.error('Missing dev DATABASE_URL in backend/.env'); process.exit(1); }
if (!prodEnv.PROD_DATABASE_URL) { console.error('Missing PROD_DATABASE_URL in backend/scripts/.env.prod'); process.exit(1); }

const dev = new PrismaClient({ datasources: { db: { url: devEnv.DATABASE_URL } } });
const prod = new PrismaClient({ datasources: { db: { url: prodEnv.PROD_DATABASE_URL } } });

// ---------------------------------------------------------------- source data
const devCategories = await dev.competencyCategory.findMany({
  where: { workspaceId: WS, id: { in: DELETED_IDS } },
});
if (devCategories.length !== DELETED_IDS.length) {
  console.error(`Dev only has ${devCategories.length}/${DELETED_IDS.length} of the deleted categories — aborting.`);
  process.exit(1);
}

const devChildren = await dev.competencyCategory.findMany({
  where: { workspaceId: WS, parentId: { in: DELETED_IDS } },
  select: { id: true, name: true, parentId: true },
});

const devCompetencies = await dev.$queryRaw`
  SELECT tc.competency_category_id AS category_id, lower(t.email) AS email,
         tc.proficiency_level, tc.notes
  FROM technician_competencies tc
  JOIN technicians t ON t.id = tc.technician_id
  WHERE tc.workspace_id = ${WS} AND tc.competency_category_id IN (166,172,173,175,176,177)
    AND t.email IS NOT NULL`;

console.log(`Dev source: ${devCategories.length} categories, ${devChildren.length} child links, ${devCompetencies.length} competency rows`);

// ------------------------------------------------------------------ prod state
const prodExisting = await prod.competencyCategory.findMany({
  where: { workspaceId: WS, id: { in: DELETED_IDS } },
  select: { id: true },
});
const prodExistingIds = new Set(prodExisting.map((c) => c.id));

const ticketGap = await prod.$queryRaw`
  SELECT COUNT(*)::int AS n FROM tickets
  WHERE workspace_id = ${WS} AND internal_category_id IS NULL AND internal_subcategory_id IS NOT NULL`;
console.log(`Prod state: ${prodExistingIds.size}/6 categories present, tickets missing top category: ${ticketGap[0].n}`);

if (!APPLY) {
  console.log('\nDRY RUN — planned actions:');
  console.log(`  1. INSERT ${DELETED_IDS.filter((id) => !prodExistingIds.has(id)).length} categories:`,
    devCategories.filter((c) => !prodExistingIds.has(c.id)).map((c) => `${c.id}=${c.name}`).join(' | '));
  console.log(`  2. Reattach ${devChildren.length} subcategories to their parents`);
  console.log('  3. Backfill tickets.internal_category_id from subcategory parents (ws 2, currently NULL)');
  console.log(`  4. Restore up to ${devCompetencies.length} technician competencies (matched by email, insert-if-missing)`);
  console.log('\nRe-run with --apply to execute.');
  process.exit(0);
}

// ---------------------------------------------------------------------- apply
await prod.$transaction(async (tx) => {
  // 1. Recreate the deleted top categories with their ORIGINAL ids so any
  //    remaining references (workflow conditions, templates) resolve again.
  for (const cat of devCategories) {
    if (prodExistingIds.has(cat.id)) continue;
    await tx.$executeRaw`
      INSERT INTO competency_categories (id, workspace_id, parent_id, name, description, is_active, is_system_suggested, source, sort_order, created_at, updated_at)
      VALUES (${cat.id}, ${WS}, NULL, ${cat.name}, ${cat.description}, ${cat.isActive}, ${cat.isSystemSuggested}, ${cat.source}, ${cat.sortOrder}, ${cat.createdAt}, NOW())
      ON CONFLICT (id) DO NOTHING`;
    console.log(`  + category ${cat.id} "${cat.name}"`);
  }

  // 2. Reattach orphaned subcategories (only ones currently parentless — a
  //    deliberately re-parented subcategory is left alone).
  for (const child of devChildren) {
    const updated = await tx.$executeRaw`
      UPDATE competency_categories SET parent_id = ${child.parentId}, updated_at = NOW()
      WHERE id = ${child.id} AND workspace_id = ${WS} AND parent_id IS NULL`;
    if (updated > 0) console.log(`  ~ subcategory ${child.id} "${child.name}" -> parent ${child.parentId}`);
  }

  // 3. Backfill tickets: top category = subcategory's parent, wherever the top
  //    is NULL (covers every orphaned combination, not just the six).
  const backfilled = await tx.$executeRaw`
    UPDATE tickets t SET internal_category_id = s.parent_id
    FROM competency_categories s
    WHERE t.internal_subcategory_id = s.id
      AND t.workspace_id = ${WS}
      AND t.internal_category_id IS NULL
      AND s.parent_id IS NOT NULL`;
  console.log(`  ~ tickets backfilled: ${backfilled}`);

  // 4. Restore technician competencies (cascade-deleted), matching dev
  //    technicians to prod by email; skip rows that already exist.
  let restored = 0;
  for (const row of devCompetencies) {
    const tech = await tx.$queryRaw`
      SELECT id FROM technicians WHERE workspace_id = ${WS} AND lower(email) = ${row.email} AND is_active = true LIMIT 1`;
    if (!tech.length) { console.log(`  ! no prod technician for ${row.email} — skipped`); continue; }
    const inserted = await tx.$executeRaw`
      INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, notes, created_at, updated_at)
      VALUES (${tech[0].id}, ${WS}, ${row.category_id}, ${row.proficiency_level}, ${row.notes}, NOW(), NOW())
      ON CONFLICT (technician_id, competency_category_id) DO NOTHING`;
    restored += inserted;
  }
  console.log(`  + technician competencies restored: ${restored}`);
}, { timeout: 120000 });

// --------------------------------------------------------------------- verify
const after = await prod.$queryRaw`
  SELECT
    (SELECT COUNT(*)::int FROM competency_categories WHERE workspace_id = ${WS} AND id IN (166,172,173,175,176,177)) AS categories,
    (SELECT COUNT(*)::int FROM competency_categories c WHERE c.workspace_id = ${WS} AND c.parent_id IS NULL
       AND EXISTS (SELECT 1 FROM tickets t WHERE t.internal_subcategory_id = c.id)) AS subs_still_orphaned,
    (SELECT COUNT(*)::int FROM tickets WHERE workspace_id = ${WS} AND internal_category_id IS NULL AND internal_subcategory_id IS NOT NULL) AS tickets_still_gapped,
    (SELECT COUNT(*)::int FROM technician_competencies WHERE workspace_id = ${WS} AND competency_category_id IN (166,172,173,175,176,177)) AS competencies`;
console.log('\nAFTER:', JSON.stringify(after[0]));

await dev.$disconnect();
await prod.$disconnect();
