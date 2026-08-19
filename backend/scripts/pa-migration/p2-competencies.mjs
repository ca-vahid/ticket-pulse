// PA Phase 2 — seed technician competencies against the new PA tree.
// Unlike the AP reorg (which REMAPPED a rich old matrix), Project Accounting
// starts nearly empty, so this phase:
//   1. remaps any existing competencies whose category survives by name, and
//   2. seeds every ACTIVE technician in the workspace with a baseline level
//      on every new top category that they don't already have (default
//      'intermediate', override with PA_SEED_LEVEL=basic|intermediate|...).
// This gives find_matching_agents a coverage signal on day one; the Skill
// Matrix UI is the place to hand-tune levels afterwards. Idempotent: existing
// (tech, category) rows are never downgraded or duplicated.
//   node scripts/pa-migration/p2-competencies.mjs                  (dev dry-run)
//   node scripts/pa-migration/p2-competencies.mjs --apply
//   node scripts/pa-migration/p2-competencies.mjs --prod --apply   (PROD — orchestrator only)
//   node scripts/pa-migration/p2-competencies.mjs [--prod] --undo  (restore from p0 snapshot)
import { SOURCE, APPLY, mode, resolveWorkspace, readSnap, writeReport, RANK, bestLevel } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const SEED_LEVEL = process.env.PA_SEED_LEVEL || 'intermediate';
if (!RANK[SEED_LEVEL]) throw new Error(`PA_SEED_LEVEL must be one of ${Object.keys(RANK).join('|')}`);
const { default: prisma } = await import('../../src/services/prisma.js');
const ws = await resolveWorkspace(prisma);

if (UNDO) {
  const before = readSnap('p0-competencies');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM technician_competencies WHERE workspace_id=$1', ws.id);
    for (const r of before) {
      await tx.$executeRawUnsafe(
        `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        r.technician_id, ws.id, r.competency_category_id, r.proficiency_level, r.notes ?? null,
      );
    }
  });
  console.log(`--undo: restored ${before.length} competencies`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`PA Phase 2 (${mode()}) — competency remap + baseline seed (level: ${SEED_LEVEL})\n`);

const newCats = await prisma.$queryRawUnsafe(
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true ORDER BY sort_order', ws.id, SOURCE,
);
if (newCats.length === 0) throw new Error('no active PA categories found — run Phase 1 first');
const newIdByName = new Map(newCats.map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));
const newIds = new Set(newIdByName.values());

const catSnapshot = readSnap('p0-categories');
const oldById = new Map(catSnapshot.map((c) => [Number(c.id), c]));

const comps = await prisma.$queryRawUnsafe(
  `SELECT tc.id, tc.technician_id, tc.competency_category_id, tc.proficiency_level, t.name AS tech_name
   FROM technician_competencies tc JOIN technicians t ON t.id=tc.technician_id
   WHERE tc.workspace_id=$1`, ws.id,
);
const techs = await prisma.$queryRawUnsafe(
  'SELECT id, name, email FROM technicians WHERE workspace_id=$1 AND is_active=true ORDER BY name', ws.id,
);
console.log(`loaded ${comps.length} existing competencies, ${techs.length} active technicians`);

// ---- 1. carry over / remap existing rows (by surviving category name) ----
const targets = new Map(); // "techId:newCatId" -> { techId, techName, newCatId, newName, level, origin }
const dropped = [];
for (const c of comps) {
  const catId = Number(c.competency_category_id);
  if (newIds.has(catId)) {
    // already on a new category — keep as-is
    const name = newCats.find((n) => Number(n.id) === catId)?.name;
    targets.set(`${c.technician_id}:${catId}`, { techId: c.technician_id, techName: c.tech_name, newCatId: catId, newName: name, level: c.proficiency_level, origin: 'kept' });
    continue;
  }
  const old = oldById.get(catId);
  const top = old?.parent_id ? oldById.get(Number(old.parent_id)) : old;
  const hitId = top ? newIdByName.get(String(top.name || '').trim().toLowerCase()) : null;
  if (!hitId) {
    dropped.push({ ...c, catName: old?.name || `#${catId}` });
    continue;
  }
  const key = `${c.technician_id}:${hitId}`;
  const hit = targets.get(key);
  const newName = newCats.find((n) => Number(n.id) === hitId)?.name;
  if (hit) hit.level = bestLevel(hit.level, c.proficiency_level);
  else targets.set(key, { techId: c.technician_id, techName: c.tech_name, newCatId: hitId, newName, level: c.proficiency_level, origin: 'remapped' });
}

// ---- 2. baseline seed for every active tech × new category ----
let seeded = 0;
for (const tech of techs) {
  for (const cat of newCats) {
    const key = `${tech.id}:${Number(cat.id)}`;
    if (targets.has(key)) continue;
    targets.set(key, { techId: tech.id, techName: tech.name, newCatId: Number(cat.id), newName: cat.name, level: SEED_LEVEL, origin: 'seeded' });
    seeded += 1;
  }
}
console.log(`plan: ${targets.size} (tech, category) rows — kept/remapped ${targets.size - seeded}, seeded ${seeded}; old rows left behind (retired cats): ${dropped.length}`);

if (APPLY) {
  await prisma.$transaction(async (tx) => {
    const keepIds = dropped.map((d) => d.id);
    await tx.$executeRawUnsafe(
      `DELETE FROM technician_competencies WHERE workspace_id=$1 ${keepIds.length ? `AND id NOT IN (${keepIds.join(',')})` : ''}`, ws.id,
    );
    for (const t of targets.values()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        t.techId, ws.id, t.newCatId, t.level,
        t.origin === 'seeded' ? `Baseline seeded by ${SOURCE} — tune in the Skill Matrix.` : null,
      );
    }
  }, { timeout: 120000 });
  console.log(`applied: ${targets.size} competencies written`);
}

// ---- review artifact ----
const byTech = new Map();
for (const t of targets.values()) {
  if (!byTech.has(t.techName)) byTech.set(t.techName, []);
  byTech.get(t.techName).push(`${t.newName} (${t.level}, ${t.origin})`);
}
const byCat = new Map();
for (const t of targets.values()) byCat.set(t.newName, (byCat.get(t.newName) || 0) + 1);

const lines = [`# PA Phase 2 — competency seed (${mode()})`, '', `Rows: ${comps.length} existing → ${targets.size} planned (seeded ${seeded}) | left on retired cats: ${dropped.length}`, '', '## Per technician'];
for (const [tech, list] of [...byTech].sort()) {
  lines.push(`\n### ${tech} (${list.length})`);
  for (const l of list.sort()) lines.push(`- ${l}`);
}
lines.push('', '## Coverage per new category');
for (const c of newCats) lines.push(`- ${c.name}: ${byCat.get(c.name) || 0} tech(s)${(byCat.get(c.name) || 0) === 0 ? '  ⚠️ NO COMPETENT TECH' : ''}`);
writeReport('phase2-competency-seed.md', lines.join('\n'));

const zeroCats = newCats.filter((c) => !byCat.get(c.name));
console.log(`sanity: ${new Set([...targets.values()].map((t) => t.techId)).size} techs covered; categories with no tech: ${zeroCats.map((c) => c.name).join(', ') || 'none'}`);
await prisma.$disconnect();
