// Phase 3 — seed AR competencies from SKILL_SEED in lib.mjs (edit that table
// first). Additive + idempotent: existing rows for the same tech+category are
// upgraded only if the seed level is higher; nothing is deleted.
// Technicians looked up by email — missing ones (e.g. Alexa before her
// onboarding) are SKIPPED with a warning; rerun after they exist.
//   node scripts/ar-onboarding/p3-skills.mjs                  (dry-run, DEV)
//   node scripts/ar-onboarding/p3-skills.mjs --prod --apply
//   node scripts/ar-onboarding/p3-skills.mjs [--prod] --undo  (delete seeded AR-category rows for seeded techs)
import { WS, SOURCE, APPLY, mode, AR_CATEGORIES, SKILL_SEED, snap } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');

const RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };

const arCats = await prisma.$queryRawUnsafe(
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true AND parent_id IS NULL', WS, SOURCE,
);
const arIdByName = new Map(arCats.map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));
if (arIdByName.size === 0) throw new Error('No AR categories found — run p1-taxonomy first');

const seedEmails = SKILL_SEED.map((s) => s.email.toLowerCase());
const techs = await prisma.$queryRawUnsafe(
  `SELECT id, name, email FROM technicians WHERE workspace_id=$1 AND lower(email) = ANY($2)`, WS, seedEmails,
);
const techByEmail = new Map(techs.map((t) => [t.email.toLowerCase(), t]));

if (UNDO) {
  const techIds = techs.map((t) => Number(t.id));
  const catIds = [...arIdByName.values()];
  if (!techIds.length || !catIds.length) { console.log('--undo: nothing to remove'); process.exit(0); }
  const gone = await prisma.$executeRawUnsafe(
    `DELETE FROM technician_competencies WHERE workspace_id=$1
     AND technician_id = ANY($2) AND competency_category_id = ANY($3)`,
    WS, techIds, catIds,
  );
  console.log(`--undo: removed ${gone} seeded AR competencies`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`AR Phase 3 (${mode()}) — skill seeding\n`);

let planned = 0;
let upgraded = 0;
let skippedTech = 0;
const actions = [];
for (const seed of SKILL_SEED) {
  const tech = techByEmail.get(seed.email.toLowerCase());
  if (!tech) {
    console.log(`  SKIP ${seed.email} — no ws${WS} technician with this email yet (onboard first, then rerun)`);
    skippedTech += 1;
    continue;
  }
  const catNames = seed.categories === 'ALL' ? AR_CATEGORIES.map((c) => c.name) : seed.categories;
  for (const name of catNames) {
    const catId = arIdByName.get(name.trim().toLowerCase());
    if (!catId) { console.log(`  WARN unknown AR category "${name}"`); continue; }
    const [existing] = await prisma.$queryRawUnsafe(
      'SELECT id, proficiency_level FROM technician_competencies WHERE workspace_id=$1 AND technician_id=$2 AND competency_category_id=$3',
      WS, Number(tech.id), catId,
    );
    if (existing) {
      if ((RANK[seed.level] || 0) > (RANK[existing.proficiency_level] || 0)) {
        actions.push({ kind: 'upgrade', tech: tech.name, cat: name, from: existing.proficiency_level, to: seed.level, id: Number(existing.id) });
        upgraded += 1;
      }
      continue;
    }
    actions.push({ kind: 'insert', tech: tech.name, cat: name, to: seed.level, techId: Number(tech.id), catId });
    planned += 1;
  }
}

for (const a of actions) {
  console.log(`  ${a.kind === 'insert' ? 'seed   ' : 'upgrade'} ${a.tech} → ${a.cat} = ${a.to}${a.from ? ` (was ${a.from})` : ''}`);
  if (!APPLY) continue;
  if (a.kind === 'insert') {
    await prisma.$executeRawUnsafe(
      `INSERT INTO technician_competencies (technician_id, workspace_id, competency_category_id, proficiency_level, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      a.techId, WS, a.catId, a.to,
    );
  } else {
    await prisma.$executeRawUnsafe(
      'UPDATE technician_competencies SET proficiency_level=$1, updated_at=now() WHERE id=$2', a.to, a.id,
    );
  }
}

console.log(`\n${APPLY ? 'applied' : '(dry-run)'}: ${planned} new, ${upgraded} upgrades, ${skippedTech} technician(s) skipped`);
if (APPLY) snap('p3-skill-seed-applied', actions);
await prisma.$disconnect();
