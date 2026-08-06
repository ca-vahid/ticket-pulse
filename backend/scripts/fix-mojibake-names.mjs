// Phase 2 backfill (FR 08-05 item 2): repair mojibake display names that the
// old longest-name-wins tiebreaks kept re-applying every sync
// ("Erick RÃ³genes Soares" → "Erick Rógenes Soares").
//
// Scans requesters.name and ticket_thread_entries.actor_name for the
// UTF-8-as-Latin-1/CP1252 signature AND the CP437/CP850 DOS-codepage
// signature (looksMojibake) and repairs rows with the round-trip-guarded
// repairMojibake. Prod evidence: "Erick R├│genes Soares" — UTF-8 bytes
// decoded as CP437 (0xC3 → '├' U+251C, 0xB3 → '│' U+2502). Raw SQL — prod
// schema trails the dev Prisma schema.
//
// IMPORTANT: run ONLY AFTER the heuristic fix (requesterRepository tiebreaks,
// v3.1.6-preview train) is deployed — otherwise the sweep re-corrupts the
// repaired names on the next sync.
//
//   Dry run:  node scripts/fix-mojibake-names.mjs
//   Apply:    APPLY=1 node scripts/fix-mojibake-names.mjs
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { looksMojibake, repairMojibake } from '../src/utils/textEncoding.js';

let envText = '';
try {
  envText = readFileSync(new URL('./.env.prod', import.meta.url), 'utf8');
} catch {
  // fall through to process.env
}
const url = process.env.PROD_DATABASE_URL || envText.match(/PROD_DATABASE_URL="?([^"\r\n]+)"?/)?.[1];
if (!url) {
  console.error('No PROD_DATABASE_URL (env or scripts/.env.prod)');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });
const APPLY = process.env.APPLY === '1';
const SAMPLE_LIMIT = 40;

// SQL pre-filter; JS looksMojibake() is the authoritative check on the
// narrowed rows.
//  - CP1252/Latin-1 signature leads: Ã Â â.
//  - CP437/CP850 signature: box-drawing/block chars (never legit in a name).
//    Deliberately NOT filtering on á í ó ú ñ etc. — under CP437 those are
//    bytes 0xA0-0xA5 but they are also plain legitimate accented text.
//    Known gap: CP437-corrupted 3-byte punctuation with no box char (e.g.
//    "ΓÇÖ" = ’) is not pre-filtered; acceptable for name columns, where the
//    corruption always includes a 2-byte Latin sequence → a box char.
const LEAD_CHARS = [
  'Ã', 'Â', 'â', // CP1252/Latin-1
  '├', '│', '─', '┤', '┐', '└', '┴', '┬', '┼', '═', '║', // CP437/CP850 box
  '╔', '╗', '╚', '╝', '▒', '░', '█', // double-line corners + blocks
];
const LEAD_FILTER = (col) => `(${LEAD_CHARS.map((ch) => `${col} LIKE '%${ch}%'`).join(' OR ')})`;

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — mojibake name repair\n`);

async function repairColumn({ label, table, idCol, col }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${idCol} AS id, ${col} AS value FROM ${table} WHERE ${LEAD_FILTER(col)}`,
  );
  const candidates = rows
    .map((r) => ({ id: r.id, before: r.value, after: repairMojibake(r.value) }))
    .filter((r) => looksMojibake(r.before) && r.after !== r.before);
  const unrepairable = rows.filter((r) => looksMojibake(r.value) && repairMojibake(r.value) === r.value);

  console.log(`${label}: ${rows.length} rows match the SQL lead filter`);
  console.log(`  mojibake + repairable: ${candidates.length}`);
  console.log(`  mojibake but NOT auto-repairable (left alone): ${unrepairable.length}`);
  for (const r of candidates.slice(0, SAMPLE_LIMIT)) {
    console.log(`    #${r.id}: ${JSON.stringify(r.before)}  ->  ${JSON.stringify(r.after)}`);
  }
  if (candidates.length > SAMPLE_LIMIT) {
    console.log(`    ... and ${candidates.length - SAMPLE_LIMIT} more`);
  }

  let updated = 0;
  if (APPLY) {
    for (const r of candidates) {
      updated += await prisma.$executeRawUnsafe(
        `UPDATE ${table} SET ${col} = $1 WHERE ${idCol} = $2`,
        r.after,
        r.id,
      );
    }
    console.log(`  APPLIED: ${updated} rows updated`);
  }
  console.log('');
  return { scanned: rows.length, repairable: candidates.length, unrepairable: unrepairable.length, updated };
}

const requesters = await repairColumn({
  label: 'requesters.name',
  table: 'requesters',
  idCol: 'id',
  col: 'name',
});
const threadEntries = await repairColumn({
  label: 'ticket_thread_entries.actor_name',
  table: 'ticket_thread_entries',
  idCol: 'id',
  col: 'actor_name',
});

console.log('Summary:');
console.table({ requesters, threadEntries });
if (!APPLY) console.log('\nDry run only — re-run with APPLY=1 to write.');
await prisma.$disconnect();
