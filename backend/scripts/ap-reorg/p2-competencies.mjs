// Phase 2 — remap ws2 technician competencies onto the 11 new categories.
// Competencies on old SUBcategories resolve to their parent top first.
// Collisions merge keeping the best proficiency. Nothing is deleted except
// exact-duplicate rows being merged.
//   node scripts/ap-reorg/p2-competencies.mjs           (dry-run)
//   node scripts/ap-reorg/p2-competencies.mjs --apply
//   node scripts/ap-reorg/p2-competencies.mjs --undo    (restore from p0 snapshot)
import { WS, SOURCE, APPLY, mode, COMPETENCY_MAP, bestLevel, readSnap, writeReport } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');

if (UNDO) {
  const before = readSnap('p0-competencies');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM technician_competencies WHERE workspace_id=$1', WS);
    for (const r of before) {
      await tx.$executeRawUnsafe(
        `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        r.technician_id, WS, r.competency_category_id, r.proficiency_level,
      );
    }
  });
  console.log(`--undo: restored ${before.length} competencies`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Phase 2 (${mode()}) — competency remap\n`);

const catSnapshot = readSnap('p0-categories');
const catById = new Map(catSnapshot.map((c) => [Number(c.id), c]));

const newCats = await prisma.$queryRawUnsafe(
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true', WS, SOURCE,
);
const newIdByName = new Map(newCats.map((c) => [c.name, Number(c.id)]));
if (newIdByName.size !== 11) throw new Error(`expected 11 new categories, found ${newIdByName.size} — run Phase 1 first`);

const comps = await prisma.$queryRawUnsafe(
  `SELECT tc.id, tc.technician_id, tc.competency_category_id, tc.proficiency_level, t.name AS tech_name
   FROM technician_competencies tc JOIN technicians t ON t.id=tc.technician_id
   WHERE tc.workspace_id=$1`, WS,
);
console.log(`loaded ${comps.length} competencies`);

// resolve every competency to a new category id
const unmapped = [];
const targets = new Map(); // "techId:newCatId" -> { techId, newCatId, level, sources: [] }
// Legacy pre-reorg categories that the id map can't reach — matched by name.
// AR & Collections follows the plan's #176 rule (→ Vendor Statements & Recon).
const NAME_FALLBACK = new Map([
  ['accounts receivable and collections [legacy]', 'Vendor Statements & Reconciliation'],
  ['invoice processing and accounts payable [legacy]', 'Vendor Invoices'],
  ['email triage and inbox management [legacy]', 'Inbox Management'],
  ['expense report management [legacy]', 'Expense Reports'],
]);
for (const c of comps) {
  const cat = catById.get(Number(c.competency_category_id));
  const top = cat?.parent_id ? catById.get(Number(cat.parent_id)) : cat;
  const newName = (top ? COMPETENCY_MAP[Number(top.id)] : null)
    || (top ? NAME_FALLBACK.get(String(top.name || '').trim().toLowerCase()) : null);
  const newCatId = newName ? newIdByName.get(newName) : null;
  if (!newCatId) {
    unmapped.push({ ...c, catName: cat?.name || `#${c.competency_category_id}`, topId: top ? Number(top.id) : null });
    continue;
  }
  const key = `${c.technician_id}:${newCatId}`;
  const hit = targets.get(key);
  if (hit) {
    hit.level = bestLevel(hit.level, c.proficiency_level);
    hit.sources.push(c.catName || cat?.name);
  } else {
    targets.set(key, { techId: c.technician_id, techName: c.tech_name, newCatId, newName, level: c.proficiency_level, sources: [cat?.name] });
  }
}
console.log(`remap: ${comps.length} rows -> ${targets.size} unique (tech, category) pairs; unmapped: ${unmapped.length}`);
if (unmapped.length) {
  console.log('  unmapped (left untouched, categories are retired/invisible):');
  for (const u of unmapped.slice(0, 10)) console.log(`    ${u.tech_name}: ${u.catName}`);
}

if (APPLY) {
  await prisma.$transaction(async (tx) => {
    const keepIds = unmapped.map((u) => u.id);
    await tx.$executeRawUnsafe(
      `DELETE FROM technician_competencies WHERE workspace_id=$1 ${keepIds.length ? `AND id NOT IN (${keepIds.join(',')})` : ''}`, WS,
    );
    for (const t of targets.values()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        t.techId, WS, t.newCatId, t.level,
      );
    }
  }, { timeout: 120000 });
  console.log(`applied: ${targets.size} competencies written`);
}

// ---- review artifact + sanity ----
const byTech = new Map();
for (const t of targets.values()) {
  if (!byTech.has(t.techName)) byTech.set(t.techName, []);
  byTech.get(t.techName).push(`${t.newName} (${t.level})${t.sources.length > 1 ? ` ← merged ${t.sources.length}` : ''}`);
}
const byCat = new Map();
for (const t of targets.values()) byCat.set(t.newName, (byCat.get(t.newName) || 0) + 1);

const lines = [`# Phase 2 — competency remap (${mode()})`, '', `Rows: ${comps.length} → ${targets.size} | unmapped: ${unmapped.length}`, '', '## Per technician'];
for (const [tech, list] of [...byTech].sort()) {
  lines.push(`\n### ${tech} (${list.length})`);
  for (const l of list.sort()) lines.push(`- ${l}`);
}
lines.push('', '## Coverage per new category');
for (const c of newCats) lines.push(`- ${c.name}: ${byCat.get(c.name) || 0} tech(s)${(byCat.get(c.name) || 0) === 0 ? '  ⚠️ NO COMPETENT TECH' : ''}`);
writeReport('phase2-competency-diff.md', lines.join('\n'));

const techCount = new Set([...targets.values()].map((t) => t.techId)).size;
const zeroCats = newCats.filter((c) => !byCat.get(c.name));
console.log(`\nsanity: ${techCount} techs covered (expect 15); categories with no tech: ${zeroCats.map((c) => c.name).join(', ') || 'none'}`);
await prisma.$disconnect();
