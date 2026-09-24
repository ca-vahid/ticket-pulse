// One-off: park the OPEN HR notices whose date is clear, in the future and
// within six months (Parked §2.6, plans/PARKED_BUILD_PLAN.md). Dry run by
// default; --apply parks. A ticket that was ever parked is left alone.
//
//   DATABASE_URL="<prod>&connection_limit=1" node --env-file=.env scripts/park-hr-backfill.mjs --ws 1 [--apply]
/* eslint-disable no-console */
import prisma from '../src/services/prisma.js';
import ticketParkService from '../src/services/ticketParkService.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WS = Number(arg('--ws', '1'));
if (WS >= 6 && WS <= 8) throw new Error('sandbox workspaces are out of scope');
const APPLY = process.argv.includes('--apply');

const results = await ticketParkService.autoParkHrNotices({ workspaceId: WS, sinceDays: null, dryRun: !APPLY, limit: 200 });
for (const r of results) {
  const what = r.parked ? `PARKED until ${r.until}` : r.would ? `would park until ${r.would.until} — ${r.would.reason}` : `skip: ${r.why}`;
  console.log(`#${r.id} ${String(r.subject).slice(0, 60)} → ${what}`);
}
console.log(`${APPLY ? 'Parked' : 'Would park'}: ${results.filter((r) => r.parked || r.would).length} of ${results.length}`);
await prisma.$disconnect();
process.exit(0);
