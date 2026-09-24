// QA 09-23 #7: requesters that were never looked up in Entra (the lookup
// only ran on ticket activity — #800 Bruno James, 29 of 75 Cambio Earth
// profiles, 1,093 overall). Dry run by default; --apply looks each one up,
// throttled, the same way the app does (entra_* columns, or entra_missing_at).
//
//   DATABASE_URL="<prod>&connection_limit=1" node --env-file=.env scripts/requester-entra-backfill.mjs [--apply] [--limit 1500]
/* eslint-disable no-console */
import prisma from '../src/services/prisma.js';
import { refreshRequesterEntraProfile } from '../src/services/requesterProfileService.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(arg('--limit', '1500'));
// Only the tenant's own domains are in Entra; outside senders would only be
// recorded as misses (the page lookup covers anyone opened by hand).
const DOMAINS = String(arg('--domains', 'bgcengineering.ca,cambioearth.com')).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = await prisma.requester.findMany({
  where: { entraProfileSyncedAt: null, entraMissingAt: null, OR: DOMAINS.map((d) => ({ email: { endsWith: `@${d}`, mode: 'insensitive' } })) },
  select: { id: true, email: true, entraProfileSyncedAt: true },
  orderBy: { id: 'asc' },
  take: LIMIT,
});
const byDomain = {};
for (const r of rows) {
  const d = String(r.email).split('@')[1] || '?';
  byDomain[d] = (byDomain[d] || 0) + 1;
}
console.log(`${rows.length} requesters never looked up. Top domains:`, Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 8));
if (!APPLY) { console.log('Dry run — pass --apply to look them up.'); await prisma.$disconnect(); process.exit(0); }

let found = 0; let missing = 0; let failed = 0;
for (const [i, r] of rows.entries()) {
  try {
    const out = await refreshRequesterEntraProfile(r);
    if (out?.entraProfileSyncedAt) found += 1; else if (out?.entraMissingAt) missing += 1; else failed += 1;
  } catch {
    failed += 1;
  }
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${rows.length}: ${found} found, ${missing} not in Entra, ${failed} failed`);
  await pause(250);
}
console.log(`Done: ${found} found, ${missing} not in Entra, ${failed} failed`);
await prisma.$disconnect();
process.exit(0);
