// Phase 5 — write the new category to every FS ticket (first-ever mass
// writeback of TP categories to FreshService tickets).
// Sets lf_ticket_pulse_category to the new record's display id and explicitly
// NULLs lf_ticket_pulse_subcategory (raw _put — the public helper strips
// nulls, which would leave stale subskill ids behind).
// Resumable: done ticket ids checkpoint to p5-writeback-done.jsonl.
//   node scripts/ap-reorg/p5-fs-writeback.mjs                 (dry-run: counts)
//   node scripts/ap-reorg/p5-fs-writeback.mjs --apply
//   AP_TEST=3 node scripts/ap-reorg/p5-fs-writeback.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { WS, SOURCE, APPLY, mode, readSnap, REPORT_DIR } from './lib.mjs';

const CONCURRENCY = 3; // low-priority lane + modest parallelism: rate-limit safe
const { default: prisma } = await import('../../src/services/prisma.js');
const { default: settingsRepository } = await import('../../src/services/settingsRepository.js');
const { createFreshServiceClient } = await import('../../src/integrations/freshservice.js');

console.log(`Phase 5 (${mode()}) — FS ticket category writeback\n`);

const displayIds = readSnap('p3-category-displayids'); // [{name, displayId}]
const newCats = await prisma.$queryRawUnsafe(
  'SELECT id, name FROM competency_categories WHERE workspace_id=$1 AND source=$2 AND is_active=true', WS, SOURCE,
);
const displayByName = new Map(displayIds.map((r) => [r.name.trim().toLowerCase(), r.displayId]));
const displayByCatId = new Map();
for (const c of newCats) {
  const d = displayByName.get(c.name.trim().toLowerCase());
  if (!d) throw new Error(`no FS display id for category "${c.name}" — run Phase 3 first`);
  displayByCatId.set(Number(c.id), d);
}

const donePath = path.join(REPORT_DIR, 'p5-writeback-done.jsonl');
const doneIds = new Set(
  fs.existsSync(donePath)
    ? fs.readFileSync(donePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : [],
);

const targets = (await prisma.$queryRawUnsafe(
  `SELECT id, freshservice_ticket_id AS fsid, internal_category_id AS cat
     FROM tickets
    WHERE workspace_id=$1 AND freshservice_ticket_id IS NOT NULL
      AND internal_category_id = ANY($2::int[])
    ORDER BY id`, WS, [...displayByCatId.keys()],
)).filter((t) => !doneIds.has(Number(t.id)));

console.log(`targets: ${targets.length} tickets (already done: ${doneIds.size})`);
if (!APPLY) {
  console.log('(dry-run stops here)');
  await prisma.$disconnect();
  process.exit(0);
}

const limit = Number(process.env.AP_TEST) || 0;
const workset = limit ? targets.slice(0, limit) : targets;
if (limit) console.log(`TEST: doing ${workset.length}`);

const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(WS);
const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, { priority: 'low', source: 'ap-reorg-p5' });
const catField = 'lf_ticket_pulse_category';
const subField = 'lf_ticket_pulse_subcategory';

let idx = 0; let done = 0; let failed = 0;
const failures = [];
const started = Date.now();

async function worker() {
  while (idx < workset.length) {
    const t = workset[idx]; idx += 1;
    try {
      await client._put(`/tickets/${t.fsid}`, {
        ticket: { custom_fields: { [catField]: displayByCatId.get(Number(t.cat)), [subField]: null } },
      });
      fs.appendFileSync(donePath, `${JSON.stringify({ id: Number(t.id), fsid: String(t.fsid) })}\n`);
    } catch (e) {
      failed += 1;
      failures.push({ id: Number(t.id), fsid: String(t.fsid), status: e.freshserviceStatus || null, error: String(e.message).slice(0, 160) });
    }
    done += 1;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - started) / 60000);
      console.log(`  ${done}/${workset.length} (failed ${failed}) ~${Math.round(rate)}/min, ETA ${Math.round((workset.length - done) / rate)} min`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\nwriteback done: ${done - failed} ok, ${failed} failed`);
if (failures.length) {
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(REPORT_DIR, 'fs-writeback-failures.csv'), [
    'ticket_id,fs_ticket_id,http_status,error',
    ...failures.map((f) => [f.id, f.fsid, f.status, csvEsc(f.error)].join(',')),
  ].join('\n'));
  console.log('failures -> fs-writeback-failures.csv (deleted/locked FS tickets are expected noise)');
}
console.log('Phase 5 OK');
await prisma.$disconnect();
