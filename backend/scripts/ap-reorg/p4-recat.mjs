// Phase 4 — recategorize all ws2 tickets onto the 11 new AP categories.
//   1. AR export (tickets on AR & Collections) -> ar-tickets.csv
//   2. Deterministic SQL moves for the 1:1 buckets + null ALL subcategories
//   3. AI (Haiku) classification for ambiguous buckets + uncategorized + strays
// The DB itself is the checkpoint: every AI update moves the ticket into a new
// category id, so re-running only picks up what's left.
//   node scripts/ap-reorg/p4-recat.mjs                    (dry-run: counts only)
//   node scripts/ap-reorg/p4-recat.mjs --apply            (full run)
//   AP_TEST=5 node scripts/ap-reorg/p4-recat.mjs --apply  (AI limited to 5 tickets)
//   node scripts/ap-reorg/p4-recat.mjs --undo             (restore from p0 snapshot)
import fs from 'node:fs';
import path from 'node:path';
import {
  WS, SOURCE, APPLY, mode, DETERMINISTIC_MAP, readSnap, writeReport, REPORT_DIR,
} from './lib.mjs';

const UNDO = process.argv.includes('--undo');
const CONCURRENCY = 8;
const MODEL = 'claude-haiku-4-5-20251001';
const { default: prisma } = await import('../../src/services/prisma.js');

if (UNDO) {
  const before = readSnap('p0-tickets');
  let restored = 0;
  for (const t of before) {
    await prisma.$executeRawUnsafe(
      'UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=$2, updated_at=now() WHERE id=$3 AND workspace_id=$4',
      t.internal_category_id, t.internal_subcategory_id, t.id, WS,
    );
    restored += 1;
    if (restored % 2000 === 0) console.log(`  restored ${restored}…`);
  }
  console.log(`--undo: restored categories on ${restored} tickets`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Phase 4 (${mode()}) — ticket recategorization\n`);

const newCats = await prisma.$queryRawUnsafe(
  'SELECT id, name, description FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true ORDER BY sort_order', WS, SOURCE,
);
if (newCats.length !== 11) throw new Error(`expected 11 new categories, found ${newCats.length}`);
const newIdByName = new Map(newCats.map((c) => [c.name, Number(c.id)]));
const newIds = [...newIdByName.values()];
const inboxId = newIdByName.get('Inbox Management');

// ---- 1. AR export (before anything moves) ----
const catSnap = readSnap('p0-categories');
const arIds = catSnap.filter((c) => /accounts receivable/i.test(c.name)).map((c) => Number(c.id));
const arTickets = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id, subject, status, created_at FROM tickets
   WHERE workspace_id=$1 AND internal_category_id = ANY($2::int[]) ORDER BY created_at DESC`, WS, arIds,
);
const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(REPORT_DIR, 'ar-tickets.csv'), [
  'ticket_id,fs_ticket_id,subject,status,created_at',
  ...arTickets.map((t) => [t.id, t.freshservice_ticket_id, csvEsc(t.subject), t.status, new Date(t.created_at).toISOString()].join(',')),
].join('\n'));
console.log(`AR export: ${arTickets.length} tickets -> ar-tickets.csv (for the future AR workspace)`);

// ---- 2. deterministic pass ----
let deterministicMoved = 0;
for (const [oldId, newName] of Object.entries(DETERMINISTIC_MAP)) {
  const newId = newIdByName.get(newName);
  if (APPLY) {
    const n = await prisma.$executeRawUnsafe(
      'UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=NULL, updated_at=now() WHERE workspace_id=$2 AND internal_category_id=$3',
      newId, WS, Number(oldId),
    );
    deterministicMoved += n;
    console.log(`  ${String(n).padStart(5)}  #${oldId} -> ${newName}`);
  } else {
    const r = await prisma.$queryRawUnsafe(
      'SELECT count(*)::int n FROM tickets WHERE workspace_id=$1 AND internal_category_id=$2', WS, Number(oldId),
    );
    deterministicMoved += r[0].n;
    console.log(`  ${String(r[0].n).padStart(5)}  #${oldId} -> ${newName}`);
  }
}
if (APPLY) {
  const nulled = await prisma.$executeRawUnsafe(
    'UPDATE tickets SET internal_subcategory_id=NULL, updated_at=now() WHERE workspace_id=$1 AND internal_subcategory_id IS NOT NULL', WS,
  );
  console.log(`deterministic: moved ${deterministicMoved}; nulled remaining subcategories on ${nulled} tickets`);
} else {
  console.log(`deterministic total: ${deterministicMoved}`);
}

// ---- 3. AI pass over whatever is not in the new taxonomy yet ----
const aiSet = await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id AS fsid, subject, description_text AS "descText", status, priority,
          category, sub_category AS "subCategory", tp_skill AS "tpSkill", internal_category_id AS "oldCat"
     FROM tickets
    WHERE workspace_id=$1 AND (internal_category_id IS NULL OR NOT (internal_category_id = ANY($2::int[])))
    ORDER BY created_at DESC`, WS, newIds,
);
const limit = Number(process.env.AP_TEST) || 0;
const workset = limit ? aiSet.slice(0, limit) : aiSet;
console.log(`\nAI pass: ${aiSet.length} tickets need classification${limit ? ` (TEST: doing ${workset.length})` : ''}`);
if (!APPLY) {
  console.log('(dry-run stops here)');
  await prisma.$disconnect();
  process.exit(0);
}

const { default: anthropicProvider } = await import('../../src/services/aiProviders/anthropicProvider.js');
const catalog = newCats.map((c) => ({ categoryId: Number(c.id), name: c.name, description: c.description }));
const systemPrompt = `Classify one Accounts Payable helpdesk ticket into EXACTLY ONE of the 11 supplied categories.

Rules:
- Use only categoryId values from the supplied list. There are no subcategories.
- The old FreshService/legacy category fields are raw evidence only.
- General email noise, spam, marketing, internal chatter and non-financial mail belong in "Inbox Management".
- Accounts-Receivable/collections content has no dedicated category: pick the closest fit (statements/reconciliation, payment processing, or inbox management).
- categoryFit: "exact" if clearly right, "weak" if best-available, "none" if nothing fits.
- Return JSON only. No markdown.`;

const snippet = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
const jsonlPath = path.join(REPORT_DIR, 'p4-ai-results.jsonl');
const results = [];

async function classifyOne(t) {
  const userMessage = JSON.stringify({
    categories: catalog,
    ticket: {
      subject: t.subject,
      description: snippet(t.descText),
      status: t.status,
      priority: t.priority,
      rawEvidence: { fsCategory: t.category, fsSubCategory: t.subCategory, oldTpSkill: t.tpSkill },
    },
    outputShape: { categoryId: 'number', categoryFit: 'exact|weak|none', confidence: 'low|medium|high', rationale: 'short' },
  });
  const res = await anthropicProvider.sendJson({ systemPrompt, userMessage, model: MODEL, maxTokens: 400, temperature: 0 });
  const rec = res.parsed || {};
  let catId = Number(rec.categoryId);
  let fit = ['exact', 'weak', 'none'].includes(rec.categoryFit) ? rec.categoryFit : 'weak';
  if (!newIds.includes(catId)) { catId = inboxId; fit = 'none'; }
  const confidence = ['low', 'medium', 'high'].includes(rec.confidence) ? rec.confidence : 'medium';
  const rationale = String(rec.rationale || 'AP reorg reclassification').slice(0, 500);
  const review = fit !== 'exact';
  await prisma.$executeRawUnsafe(
    `UPDATE tickets SET internal_category_id=$1, internal_subcategory_id=NULL, internal_category_confidence=$2,
       internal_category_rationale=$3, internal_category_fit=$4, internal_subcategory_fit=NULL,
       taxonomy_review_needed=$5, updated_at=now()
     WHERE id=$6 AND workspace_id=$7`,
    catId, confidence, rationale, fit, review, Number(t.id), WS,
  );
  const row = { id: Number(t.id), fsid: t.fsid !== null && t.fsid !== undefined ? String(t.fsid) : null, subject: String(t.subject || '').slice(0, 120), catId, fit, confidence, oldCat: t.oldCat !== null && t.oldCat !== undefined ? Number(t.oldCat) : null };
  fs.appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);
  return row;
}

let idx = 0; let done = 0; let failed = 0;
const failures = [];
async function worker() {
  while (idx < workset.length) {
    const t = workset[idx]; idx += 1;
    try {
      results.push(await classifyOne(t));
    } catch (e) {
      failed += 1;
      failures.push({ id: Number(t.id), error: e.message.slice(0, 200) });
    }
    done += 1;
    if (done % 100 === 0) console.log(`  AI ${done}/${workset.length} (failed ${failed})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`AI done: ${done} processed, ${failed} failed`);
if (failures.length) fs.writeFileSync(path.join(REPORT_DIR, 'p4-ai-failures.json'), JSON.stringify(failures, null, 1));

// ---- 4. reports + verification ----
const nameById = new Map(newCats.map((c) => [Number(c.id), c.name]));
const dist = await prisma.$queryRawUnsafe(
  'SELECT internal_category_id AS id, count(*)::int n FROM tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY n DESC', WS,
);
const lines = [`# Phase 4 — distribution after recategorization (${new Date().toISOString()})`, ''];
let outside = 0;
for (const d of dist) {
  const nm = d.id === null ? '(uncategorized)' : nameById.get(Number(d.id)) || `LEFTOVER #${d.id}`;
  if (d.id === null || !nameById.has(Number(d.id))) outside += d.n;
  lines.push(`- ${String(d.n).padStart(6)}  ${nm}`);
}
const needsReview = results.filter((r) => r.fit !== 'exact');
lines.push('', `AI classified: ${results.length}; needs-review (fit != exact): ${needsReview.length} (${results.length ? Math.round((needsReview.length / results.length) * 100) : 0}%)`, `outside new taxonomy: ${outside}`);
writeReport('phase4-distribution.md', lines.join('\n'));
fs.writeFileSync(path.join(REPORT_DIR, 'needs-review.csv'), [
  'ticket_id,fs_ticket_id,category,fit,confidence,subject',
  ...needsReview.map((r) => [r.id, r.fsid, csvEsc(nameById.get(r.catId)), r.fit, r.confidence, csvEsc(r.subject)].join(',')),
].join('\n'));
console.log(`needs-review: ${needsReview.length}; tickets outside new taxonomy after run: ${outside}${limit ? ' (TEST run — remainder expected)' : ''}`);
if (!limit && outside > failed) throw new Error('Phase 4 verification FAILED: tickets left outside the new taxonomy');
console.log('Phase 4 OK');
await prisma.$disconnect();
