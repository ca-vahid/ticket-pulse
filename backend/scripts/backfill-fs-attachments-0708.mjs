// Backfill FS attachment metadata for recent tickets (QA 07-08: FS
// attachments were never synced). Two passes:
//   A (no FS calls): conversation attachments already sit in stored
//     raw_payload JSON on thread entries — ingest from there (7 days).
//   B (FS detail calls, low priority): ticket-LEVEL attachments only exist on
//     the FS ticket detail — fetch it for FS-born tickets from the last 48h.
// Ingest is metadata-only + dedupe-safe (unique blobName); bytes are fetched
// lazily on first download by the deployed code.
//
//   DATABASE_URL=<prod> node --env-file=.env scripts/backfill-fs-attachments-0708.mjs
import prisma from '../src/services/prisma.js';
import attachmentService from '../src/services/attachmentService.js';
import mirrorService from '../src/services/mirrorService.js';

// ---- Pass A: conversation attachments from stored payloads ---------------
const entries = await prisma.$queryRaw`
  SELECT e.id, e.ticket_id, e.workspace_id, e.raw_payload
  FROM ticket_thread_entries e
  WHERE e.source = 'freshservice_conversation'
    AND e.occurred_at > NOW() - INTERVAL '7 days'
    AND e.raw_payload::text LIKE '%"attachments":[{%'`;
let convIngested = 0;
for (const e of entries) {
  const payload = typeof e.raw_payload === 'string' ? JSON.parse(e.raw_payload) : e.raw_payload;
  for (const att of (payload?.attachments || [])) {
    const row = await attachmentService.ingestFreshServiceAttachment({
      workspaceId: e.workspace_id, ticketId: e.ticket_id, threadEntryId: e.id, fsAttachment: att,
    });
    if (row) convIngested += 1;
  }
}
console.log(`Pass A: ${entries.length} conversation entries scanned, ${convIngested} attachment(s) ingested`);

// ---- Pass B: ticket-level attachments via FS detail -----------------------
const tickets = await prisma.$queryRaw`
  SELECT t.id, t.workspace_id, t.freshservice_ticket_id
  FROM tickets t
  WHERE t.origin != 'ticketpulse'
    AND t.freshservice_ticket_id IS NOT NULL
    AND t.created_at > NOW() - INTERVAL '48 hours'
    AND COALESCE(t.is_noise, false) = false
  ORDER BY t.created_at DESC`;
console.log(`Pass B: ${tickets.length} recent FS-born ticket(s) to check`);
const clients = new Map();
let ticketIngested = 0;
let checked = 0;
for (const t of tickets) {
  try {
    if (!clients.has(t.workspace_id)) clients.set(t.workspace_id, await mirrorService.getClient(t.workspace_id));
    const client = clients.get(t.workspace_id);
    if (!client) continue;
    const fsTicket = await client.getTicket(Number(t.freshservice_ticket_id));
    checked += 1;
    for (const att of (fsTicket?.attachments || [])) {
      const row = await attachmentService.ingestFreshServiceAttachment({
        workspaceId: t.workspace_id, ticketId: t.id, fsAttachment: att,
      });
      if (row) { ticketIngested += 1; console.log(`  #${t.freshservice_ticket_id}: ${att.name}`); }
    }
  } catch (err) {
    console.log(`  #${t.freshservice_ticket_id}: skipped (${String(err.message).slice(0, 60)})`);
  }
}
console.log(`Pass B: ${checked} checked, ${ticketIngested} ticket-level attachment(s) ingested`);
await prisma.$disconnect();
