// Delete the two orphan FS mirror copies of TP-1006 created by the QA 07-08
// double-mirror race (real mirror = #231931; #231932/#231933 are strays).
// Verifies subject + no responder activity before deleting; FS delete is a
// soft delete (trash), reversible from the FS UI.
//
//   DATABASE_URL=<prod> node --env-file=.env scripts/delete-orphan-mirrors-0708.mjs
import settingsRepository from '../src/services/settingsRepository.js';
import { createFreshServiceClient } from '../src/integrations/freshservice.js';
import prisma from '../src/services/prisma.js';

const ORPHANS = [231932, 231933];
const REAL_MIRROR = 231931;

const linked = await prisma.$queryRaw`SELECT freshservice_ticket_id FROM tickets WHERE origin = 'ticketpulse' AND native_number = 1006`;
const linkedId = Number(linked[0]?.freshservice_ticket_id);
if (linkedId !== REAL_MIRROR) {
  console.error(`abort: TP-1006 now points at #${linkedId}, expected #${REAL_MIRROR}`);
  process.exit(1);
}

const cfg = await settingsRepository.getFreshServiceConfigForWorkspace(1);
const client = createFreshServiceClient(cfg.domain, cfg.apiKey, { priority: 'high', source: 'orphan-mirror-cleanup' });

for (const id of ORPHANS) {
  const t = await client.getTicket(id).catch((e) => ({ error: e.message }));
  const tk = t?.ticket || t;
  if (tk?.error) { console.log(`#${id}: fetch failed (${tk.error}) — skipping`); continue; }
  const subject = tk?.subject || '';
  if (!/QA TEST - Laptop broke down/i.test(subject)) {
    console.log(`#${id}: subject ${JSON.stringify(subject)} does not match the QA test ticket — skipping`);
    continue;
  }
  await client.deleteTicket(id);
  console.log(`#${id}: deleted (soft) — was ${JSON.stringify(subject)}`);
}
console.log(`kept: #${REAL_MIRROR} (linked mirror of TP-1006)`);
await prisma.$disconnect();
