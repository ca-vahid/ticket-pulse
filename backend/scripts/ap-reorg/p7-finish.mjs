// Phase 7 — restore ws2 automation to its Phase 0 state and write SUMMARY.md.
//   node scripts/ap-reorg/p7-finish.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { WS, APPLY, mode, readSnap, writeReport, REPORT_DIR } from './lib.mjs';

const { default: prisma } = await import('../../src/services/prisma.js');

console.log(`Phase 7 (${mode()}) — unfreeze + summary\n`);

const orig = readSnap('p0-assignment-config')[0];
console.log(`restoring: poll_for_unassigned=${orig.poll_for_unassigned} dry_run_mode=${orig.dry_run_mode}`);
if (APPLY) {
  await prisma.$executeRawUnsafe(
    'UPDATE assignment_configs SET poll_for_unassigned=$1, dry_run_mode=$2, updated_at=now() WHERE workspace_id=$3',
    orig.poll_for_unassigned, orig.dry_run_mode, WS,
  );
  console.log('assignment config restored');
}

// ---- summary ----
const dist = await prisma.$queryRawUnsafe(
  `SELECT COALESCE(c.name, '(uncategorized)') AS name, count(*)::int n
     FROM tickets t LEFT JOIN competency_categories c ON c.id=t.internal_category_id
    WHERE t.workspace_id=$1 GROUP BY 1 ORDER BY n DESC`, WS,
);
const comp = await prisma.$queryRawUnsafe(
  `SELECT c.name, count(*)::int n FROM technician_competencies tc
     JOIN competency_categories c ON c.id=tc.competency_category_id
    WHERE tc.workspace_id=$1 GROUP BY 1 ORDER BY n DESC`, WS,
);
const aiResults = fs.existsSync(path.join(REPORT_DIR, 'p4-ai-results.jsonl'))
  ? fs.readFileSync(path.join(REPORT_DIR, 'p4-ai-results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const needsReview = aiResults.filter((r) => r.fit !== 'exact');
const writebackDone = fs.existsSync(path.join(REPORT_DIR, 'p5-writeback-done.jsonl'))
  ? fs.readFileSync(path.join(REPORT_DIR, 'p5-writeback-done.jsonl'), 'utf8').split('\n').filter(Boolean).length
  : 0;
const wbFailures = fs.existsSync(path.join(REPORT_DIR, 'fs-writeback-failures.csv'))
  ? fs.readFileSync(path.join(REPORT_DIR, 'fs-writeback-failures.csv'), 'utf8').split('\n').length - 1
  : 0;

const lines = [
  `# AP Category Reorg — SUMMARY (${new Date().toISOString()})`,
  '',
  '## Final ticket distribution (ws2)',
  ...dist.map((d) => `- ${String(d.n).padStart(6)}  ${d.name}`),
  '',
  '## Competency coverage (techs per category)',
  ...comp.map((d) => `- ${String(d.n).padStart(3)}  ${d.name}`),
  '',
  '## AI classification',
  `- classified: ${aiResults.length}`,
  `- needs-review (fit != exact): ${needsReview.length} -> needs-review.csv`,
  '',
  '## FreshService writeback',
  `- tickets written: ${writebackDone}`,
  `- failures: ${wbFailures}${wbFailures ? ' -> fs-writeback-failures.csv' : ''}`,
  '',
  '## AR tickets (for the future AR workspace)',
  '- exported to ar-tickets.csv (315 tickets classified into best-fit AP homes for now)',
  '',
  '## Undo order (if ever needed)',
  '1. p5: re-run writeback after undoing p4 (or clear the FS field)',
  '2. p4: `node scripts/ap-reorg/p4-recat.mjs --undo`',
  '3. p2: `node scripts/ap-reorg/p2-competencies.mjs --undo`',
  '4. p1: `node scripts/ap-reorg/p1-taxonomy.mjs --undo`',
  '5. p3: re-create FS records from p0-fs-*-records.json + re-sync',
  '',
  'Keep all p0-*.json snapshots >= 30 days.',
];
writeReport('SUMMARY.md', lines.join('\n'));
console.log('\nPhase 7 OK');
await prisma.$disconnect();
