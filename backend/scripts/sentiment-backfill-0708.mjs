// One-off: classify requester sentiment for the QA 07-08 test tickets whose
// frustrated replies synced from FS before the thread-sync sentiment hook
// existed (ticketThreadRepository now schedules this automatically for new
// customer replies).
//
//   DATABASE_URL=<prod> node --env-file=.env scripts/sentiment-backfill-0708.mjs [fsId ...]
import prisma from '../src/services/prisma.js';
import ticketSentimentService from '../src/services/ticketSentimentService.js';

const fsIds = process.argv.slice(2).map(Number).filter(Boolean);
if (!fsIds.length) fsIds.push(231930);

for (const fsId of fsIds) {
  const rows = await prisma.$queryRaw`SELECT id, workspace_id, subject FROM tickets WHERE freshservice_ticket_id = ${fsId} AND origin != 'ticketpulse'`;
  const t = rows[0];
  if (!t) { console.log(`#${fsId}: not found`); continue; }
  const result = await ticketSentimentService.refreshSentiment(t.id, t.workspace_id);
  console.log(`#${fsId} (ticket ${t.id}) ->`, JSON.stringify(result));
}
await prisma.$disconnect();
