// Cleanup for the Jul 8 categorization/stall incident (v3.0.26 fixes the
// causes; this repairs the already-affected tickets). Raw SQL only — prod
// schema trails the dev Prisma schema, so model hydration is unsafe here.
//
// Pass 1 (deterministic, no LLM): tickets whose latest completed run has a
//   recommendation but the ticket has no internal category — resolve the
//   category from the run's own payload (explicit IDs if present, else the
//   "Parent > Sub" names in ticketClassification), mirroring the server's
//   new repair logic in _persistInternalClassification.
// Pass 2: open, UNASSIGNED tickets whose latest run failed — insert a
//   'queued' pipeline run; prod's own queue drain claims and executes it
//   with prod credentials (drain re-validates eligibility).
// Pass 3: report-only — assigned tickets whose runs all failed (no
//   recommendation to repair from; the drain would skip them). Listed for a
//   one-click "AI triage" from the ticket page if wanted.
//
//   Dry run:  node --env-file=.env scripts/cleanup-failed-runs-0708.mjs
//   Apply:    APPLY=1 node --env-file=.env scripts/cleanup-failed-runs-0708.mjs
//   (point DATABASE_URL at prod, or set PROD_DATABASE_URL to override)
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const envText = (() => {
  try { return readFileSync(new URL('../../reports/agent-reports/.env', import.meta.url), 'utf8'); } catch { return ''; }
})();
const prodUrl = process.env.PROD_DATABASE_URL
  || envText.match(/PROD_DATABASE_URL="?([^"\n]+)"?/)?.[1]
  || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: prodUrl } } });
const APPLY = process.env.APPLY === '1';
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 40);

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — window: last ${WINDOW_HOURS}h\n`);

// ---- Pass 1: repair categories from run payloads --------------------------
const uncategorized = await prisma.$queryRawUnsafe(`
  SELECT DISTINCT ON (t.id)
    t.id, t.workspace_id, t.freshservice_ticket_id, t.subject,
    r.id AS run_id, r.recommendation
  FROM tickets t
  JOIN assignment_pipeline_runs r ON r.ticket_id = t.id AND r.status = 'completed' AND r.recommendation IS NOT NULL
  WHERE t.internal_category_id IS NULL
    AND t.created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'
    AND COALESCE(t.is_noise, false) = false
  ORDER BY t.id, r.created_at DESC
`);

let repaired = 0;
for (const row of uncategorized) {
  const rec = row.recommendation || {};
  const fit = String(rec.categoryFit || '').toLowerCase();
  if (fit === 'none') { console.log(`#${row.freshservice_ticket_id} skip: categoryFit none`); continue; }

  let categoryId = Number.isInteger(Number(rec.internalCategoryId)) && Number(rec.internalCategoryId) > 0 ? Number(rec.internalCategoryId) : null;
  let subcategoryId = Number.isInteger(Number(rec.internalSubcategoryId)) && Number(rec.internalSubcategoryId) > 0 ? Number(rec.internalSubcategoryId) : null;

  if (!categoryId && !subcategoryId) {
    const names = String(rec.ticketClassification || '').split('>').map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (!names.length) { console.log(`#${row.freshservice_ticket_id} skip: no names to resolve`); continue; }
    const matches = await prisma.$queryRawUnsafe(`
      SELECT id, name, parent_id FROM competency_categories
      WHERE workspace_id = $1 AND is_active = true AND LOWER(name) = ANY($2)
    `, row.workspace_id, names.map((n) => n.toLowerCase()));
    const parent = matches.find((c) => !c.parent_id);
    const child = matches.find((c) => c.parent_id && (!parent || Number(c.parent_id) === Number(parent.id)));
    categoryId = parent ? Number(parent.id) : (child ? Number(child.parent_id) : null);
    subcategoryId = child ? Number(child.id) : null;
    if (!categoryId) { console.log(`#${row.freshservice_ticket_id} skip: names [${names.join(' > ')}] did not resolve`); continue; }
  } else {
    // Validate explicit IDs against the live taxonomy (same as server logic).
    const rows2 = await prisma.$queryRawUnsafe(`
      SELECT id, parent_id FROM competency_categories WHERE workspace_id = $1 AND is_active = true AND id = ANY($2)
    `, row.workspace_id, [categoryId, subcategoryId].filter(Boolean));
    const byId = new Map(rows2.map((c) => [Number(c.id), c]));
    const cat = categoryId ? byId.get(categoryId) : null;
    const sub = subcategoryId ? byId.get(subcategoryId) : null;
    const normSub = sub?.parent_id ? sub : (cat?.parent_id ? cat : null);
    const normCat = cat?.parent_id ? byId.get(Number(cat.parent_id)) : cat;
    categoryId = normCat ? Number(normCat.id) : (normSub ? Number(normSub.parent_id) : null);
    subcategoryId = normSub ? Number(normSub.id) : null;
    if (!categoryId) { console.log(`#${row.freshservice_ticket_id} skip: stale IDs`); continue; }
  }

  const subFit = String(rec.subcategoryFit || '').toLowerCase() || null;
  const rationale = rec.classificationRationale || rec.ticketClassification || null;
  console.log(`#${row.freshservice_ticket_id} REPAIR -> category ${categoryId}${subcategoryId ? ` / sub ${subcategoryId}` : ''} (run ${row.run_id}) — ${String(row.subject).slice(0, 60)}`);
  if (APPLY) {
    await prisma.$executeRawUnsafe(`
      UPDATE tickets SET
        internal_category_id = $1,
        internal_subcategory_id = $2,
        internal_category_confidence = COALESCE($3, internal_category_confidence),
        internal_category_rationale = COALESCE($4, internal_category_rationale),
        internal_category_fit = COALESCE($5, internal_category_fit),
        internal_subcategory_fit = COALESCE($6, internal_subcategory_fit),
        updated_at = NOW()
      WHERE id = $7
    `, categoryId, subcategoryId, rec.confidence || null, rationale, fit || null, subFit, row.id);
  }
  repaired += 1;
}

// ---- Pass 2: queue re-runs for open, unassigned, latest-run-failed --------
const failedUnassigned = await prisma.$queryRawUnsafe(`
  SELECT t.id, t.workspace_id, t.freshservice_ticket_id, t.subject
  FROM tickets t
  WHERE t.assigned_tech_id IS NULL
    AND t.status IN ('Open', 'Pending')
    AND COALESCE(t.is_noise, false) = false
    AND t.created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'
    AND EXISTS (SELECT 1 FROM assignment_pipeline_runs r WHERE r.ticket_id = t.id AND r.status IN ('failed', 'skipped_stale'))
    AND NOT EXISTS (SELECT 1 FROM assignment_pipeline_runs r WHERE r.ticket_id = t.id AND r.status IN ('completed', 'running', 'queued'))
`);

let queued = 0;
for (const row of failedUnassigned) {
  console.log(`#${row.freshservice_ticket_id} QUEUE re-run — ${String(row.subject).slice(0, 60)}`);
  if (APPLY) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO assignment_pipeline_runs (ticket_id, workspace_id, status, trigger_source, queued_at, queued_reason, created_at, updated_at)
      VALUES ($1, $2, 'queued', 'poll', NOW(), 'Re-queued after v3.0.26 stall/categorization fix (Jul 8 cleanup)', NOW(), NOW())
    `, row.id, row.workspace_id);
  }
  queued += 1;
}

// ---- Pass 3: report assigned tickets with only failed runs ----------------
const failedAssigned = await prisma.$queryRawUnsafe(`
  SELECT t.freshservice_ticket_id, t.subject
  FROM tickets t
  WHERE t.assigned_tech_id IS NOT NULL
    AND t.internal_category_id IS NULL
    AND COALESCE(t.is_noise, false) = false
    AND t.created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'
    AND EXISTS (SELECT 1 FROM assignment_pipeline_runs r WHERE r.ticket_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM assignment_pipeline_runs r WHERE r.ticket_id = t.id AND r.status = 'completed' AND r.recommendation IS NOT NULL)
`);
if (failedAssigned.length) {
  console.log('\nAssigned tickets with no usable run payload (use "AI triage" on the ticket page if category wanted):');
  for (const row of failedAssigned) console.log(`  #${row.freshservice_ticket_id} — ${String(row.subject).slice(0, 70)}`);
}

console.log(`\nSummary: ${repaired} categor${repaired === 1 ? 'y' : 'ies'} repaired, ${queued} re-run${queued === 1 ? '' : 's'} queued, ${failedAssigned.length} left for manual triage.${APPLY ? '' : ' (dry run — nothing written)'}`);
await prisma.$disconnect();
