// PA Phase 4 — map legacy ticketCategory STRINGS onto the new PA categories
// where a deterministic keyword rule is confident; leave everything else
// UNCATEGORIZED on purpose (the Reclassify UI batch tool is the long-tail
// path once the workspace is canonical). No AI pass here — unlike the AP
// reorg, the legacy strings are the only signal worth trusting in bulk.
// Dry-run prints the full mapping table (distinct legacy value → target).
//   node scripts/pa-migration/p4-recat.mjs                  (dev dry-run: mapping table only)
//   node scripts/pa-migration/p4-recat.mjs --apply
//   node scripts/pa-migration/p4-recat.mjs --prod --apply   (PROD — orchestrator only)
//   node scripts/pa-migration/p4-recat.mjs [--prod] --undo  (restore internal ids from p0 snapshot)
import { SOURCE, APPLY, mode, resolveWorkspace, RECAT_RULES, readSnap, writeReport } from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const { default: prisma } = await import('../../src/services/prisma.js');
const ws = await resolveWorkspace(prisma);

if (UNDO) {
  const before = readSnap('p0-tickets');
  let restored = 0;
  for (const t of before) {
    await prisma.$executeRawUnsafe(
      `UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=$2,
         internal_category_fit=$3, internal_subcategory_fit=$4, taxonomy_review_needed=$5, updated_at=now()
       WHERE id=$6 AND workspace_id=$7`,
      t.internal_category_id, t.internal_subcategory_id,
      t.internal_category_fit, t.internal_subcategory_fit, t.taxonomy_review_needed,
      t.id, ws.id,
    );
    restored += 1;
    if (restored % 2000 === 0) console.log(`  restored ${restored}…`);
  }
  console.log(`--undo: restored categorization on ${restored} tickets`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`PA Phase 4 (${mode()}) — deterministic legacy-string recategorization\n`);

const newCats = await prisma.$queryRawUnsafe(
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true ORDER BY sort_order', ws.id, SOURCE,
);
if (newCats.length === 0) throw new Error('no active PA categories found — run Phase 1 first');
const newIdByName = new Map(newCats.map((c) => [c.name, Number(c.id)]));
const exactByLower = new Map(newCats.map((c) => [c.name.trim().toLowerCase(), c.name]));
for (const r of RECAT_RULES) {
  if (!newIdByName.has(r.target)) throw new Error(`RECAT_RULES target "${r.target}" is not an active PA category`);
}

// distinct legacy values with counts
const legacy = await prisma.$queryRawUnsafe(
  `SELECT COALESCE(ticket_category, '') AS cat, count(*)::int AS n
   FROM tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY n DESC`, ws.id,
);

const decide = (legacyValue) => {
  const value = String(legacyValue || '').trim();
  if (!value) return null;
  const exact = exactByLower.get(value.toLowerCase());
  if (exact) return { target: exact, rule: 'exact name match' };
  for (const r of RECAT_RULES) {
    if (r.pattern.test(value)) return { target: r.target, rule: r.rule };
  }
  return null;
};

// ---- mapping table (always printed; THE dry-run review artifact) ----
const rows = legacy.map((l) => {
  const hit = decide(l.cat);
  return { legacy: l.cat || '(none)', n: l.n, target: hit?.target || null, rule: hit?.rule || null };
});
const mapped = rows.filter((r) => r.target);
const unmapped = rows.filter((r) => !r.target);
const pad = (s, w) => String(s).slice(0, w).padEnd(w);
console.log(`${pad('count', 7)} ${pad('legacy ticketCategory', 48)} ${pad('→ target', 24)} rule`);
for (const r of rows) {
  console.log(`${pad(r.n, 7)} ${pad(r.legacy, 48)} ${pad(r.target || '(stays uncategorized)', 24)} ${r.rule || ''}`);
}
const mappedTickets = mapped.reduce((a, r) => a + r.n, 0);
const unmappedTickets = unmapped.reduce((a, r) => a + r.n, 0);
console.log(`\nsummary: ${mapped.length} legacy values (${mappedTickets} tickets) map deterministically; `
  + `${unmapped.length} values (${unmappedTickets} tickets) stay uncategorized for the Reclassify UI`);

writeReport('phase4-mapping-table.md', [
  `# PA Phase 4 — legacy → canonical mapping table (${mode()}, ${new Date().toISOString()})`, '',
  '| tickets | legacy ticketCategory | target | rule |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.n} | ${r.legacy.replace(/\|/g, '\\|')} | ${r.target || '_(stays uncategorized)_'} | ${r.rule || ''} |`),
  '', `Mapped: ${mappedTickets} tickets across ${mapped.length} values. Uncategorized long tail: ${unmappedTickets} tickets across ${unmapped.length} values → Reclassify UI.`,
].join('\n'));

if (!APPLY) {
  console.log('(dry-run stops here)');
  await prisma.$disconnect();
  process.exit(0);
}

// ---- apply: one UPDATE per mapped legacy value ----
let moved = 0;
for (const r of mapped) {
  const newId = newIdByName.get(r.target);
  const isNone = r.legacy === '(none)';
  const n = await prisma.$executeRawUnsafe(
    `UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=NULL,
       internal_category_confidence='medium',
       internal_category_rationale=$2,
       internal_category_fit='exact', internal_subcategory_fit=NULL,
       taxonomy_review_needed=false, updated_at=now()
     WHERE workspace_id=$3 AND ${isNone ? 'ticket_category IS NULL' : 'ticket_category=$4'}`,
    ...(isNone
      ? [newId, `PA migration rule (${r.rule}) from legacy category "${r.legacy}"`, ws.id]
      : [newId, `PA migration rule (${r.rule}) from legacy category "${r.legacy}"`, ws.id, r.legacy]),
  );
  moved += n;
  console.log(`  ${String(n).padStart(6)}  "${r.legacy}" -> ${r.target}`);
}

// ---- cleanup: tickets still pointing at RETIRED category ids whose legacy
// string had no confident rule → clear to uncategorized (p0 snapshot holds
// the originals for --undo). Retire-never-delete applies to category ROWS;
// ticket pointers must not reference retired categories. ----
const newIds = [...newIdByName.values()];
const cleared = await prisma.$executeRawUnsafe(
  `UPDATE tickets SET internal_category_id=NULL, internal_subcategory_id=NULL,
     internal_category_fit=NULL, internal_subcategory_fit=NULL, updated_at=now()
   WHERE workspace_id=$1 AND internal_category_id IS NOT NULL AND NOT (internal_category_id = ANY($2::int[]))`,
  ws.id, newIds,
);
if (cleared > 0) console.log(`cleared ${cleared} tickets off retired category ids (now uncategorized for the Reclassify UI)`);

// ---- verification + distribution report ----
const dist = await prisma.$queryRawUnsafe(
  'SELECT internal_category_id AS id, count(*)::int n FROM tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY n DESC', ws.id,
);
const nameById = new Map(newCats.map((c) => [Number(c.id), c.name]));
const lines = [`# PA Phase 4 — distribution after apply (${new Date().toISOString()})`, ''];
let outsideNew = 0;
for (const d of dist) {
  const nm = d.id === null ? '(uncategorized — Reclassify UI long tail)' : nameById.get(Number(d.id)) || `LEFTOVER #${d.id}`;
  if (d.id !== null && !nameById.has(Number(d.id))) outsideNew += d.n;
  lines.push(`- ${String(d.n).padStart(6)}  ${nm}`);
}
lines.push('', `moved this run: ${moved}; on retired/foreign category ids: ${outsideNew} (expect 0)`);
writeReport('phase4-distribution.md', lines.join('\n'));
console.log(`\nmoved ${moved} tickets; tickets still on retired/foreign ids: ${outsideNew} (expect 0)`);
if (outsideNew > 0) throw new Error('PA Phase 4 verification FAILED: tickets left on non-PA category ids');
console.log('PA Phase 4 OK');
await prisma.$disconnect();
