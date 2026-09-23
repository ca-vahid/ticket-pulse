// One-off repair for the Pending Response build (23 Sep 2026,
// plans/PENDING_RESPONSE_STATUS_SYNC.md). Dry run by default; --apply writes.
//
//   1. Reads FreshService's status choices for each workspace and binds them
//      to registry rows (IT's "Pending Response" -> 6). Another workspace gets
//      a "Pending Response" row only if its tickets use that status (Accounting
//      has 2); workspaces that never use it get nothing in their status list.
//   2. FS-born tickets still labelled "Waiting on Customer" / "Waiting on
//      Third Party" (FreshService 6/7 under the old fixed labels) are
//      re-read from FreshService through the app's own single-ticket
//      reconcile: still 6 -> "Pending Response"; anything else -> FreshService's
//      real status, with resolved/closed dates (fixes #222020-style drift).
//   3. --stale-days N (optional): the same reconcile for FS-born tickets that
//      are open in Ticket Pulse but untouched by FreshService for N+ days.
//
//   DATABASE_URL="<prod>&connection_limit=1" node --env-file=.env \
//     scripts/fix-pending-response-status.mjs [--apply] [--ws 1,2,3,4,5] [--stale-days 21]
/* eslint-disable no-console */
import prisma from '../src/services/prisma.js';
import settingsRepository from '../src/services/settingsRepository.js';
import statusService from '../src/services/statusService.js';
import syncService from '../src/services/syncService.js';
import { createFreshServiceClient } from '../src/integrations/freshservice.js';
import { getStatusString } from '../src/integrations/freshserviceTransformer.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const WORKSPACES = String(arg('--ws', '1,2,3,4,5')).split(',').map(Number).filter((n) => n && !(n >= 6 && n <= 8));
const STALE_DAYS = arg('--stale-days') ? Number(arg('--stale-days')) : null;
const LEGACY_LABELS = ['Waiting on Customer', 'Waiting on Third Party'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — workspaces ${WORKSPACES.join(', ')}${STALE_DAYS ? `, stale ${STALE_DAYS}+ days` : ''}`);
const totals = { bound: 0, created: 0, relabelled: 0, driftFixed: 0, unchanged: 0, failed: 0 };

for (const ws of WORKSPACES) {
  const workspace = await prisma.workspace.findUnique({ where: { id: ws }, select: { name: true, freshserviceWorkspaceId: true } });
  const cfg = await settingsRepository.getFreshServiceConfigForWorkspace(ws);
  if (!workspace || !cfg?.domain || !cfg?.apiKey) { console.log(`ws${ws}: no FreshService config — skipped`); continue; }
  const client = createFreshServiceClient(cfg.domain, cfg.apiKey, { priority: 'low', source: 'pending-response-repair' });

  // 1. status choices -> registry bindings
  if (APPLY) {
    const r = await statusService.syncFsStatusChoices(ws, client, workspace.freshserviceWorkspaceId);
    totals.bound += r.bound; totals.created += r.created;
    console.log(`ws${ws} ${workspace.name}: FreshService statuses — ${r.bound} bound, ${r.created} created`);
  } else {
    const fields = await client.listTicketFormFields({ workspace_id: Number(workspace.freshserviceWorkspaceId) });
    const choices = (fields.find((f) => f.name === 'status')?.choices || []).filter((c) => Number(c.id) > 5);
    const rows = await prisma.ticketStatusDefinition.findMany({ where: { workspaceId: ws }, select: { name: true, freshserviceStatusId: true } });
    for (const c of choices) {
      const match = rows.find((r) => r.freshserviceStatusId === Number(c.id)) || rows.find((r) => r.name.toLowerCase() === String(c.value).toLowerCase());
      const legacy = { 6: 'Waiting on Customer', 7: 'Waiting on Third Party' }[Number(c.id)];
      const inUse = await prisma.ticket.count({ where: { workspaceId: ws, status: { in: [String(c.value), ...(legacy ? [legacy] : [])] } } });
      const plan = match ? `bind existing "${match.name}"` : inUse ? `create (${inUse} ticket(s) use it)` : 'skip — not used in this workspace';
      console.log(`ws${ws} ${workspace.name}: FS ${c.id} "${c.value}" -> ${plan}`);
    }
  }
  await statusService.loadFsBindings(ws);

  // 2 + 3. tickets to re-read from FreshService
  const legacy = await prisma.ticket.findMany({
    where: { workspaceId: ws, origin: 'freshservice', status: { in: LEGACY_LABELS } },
    select: { id: true, freshserviceTicketId: true, status: true, subject: true },
    take: 500,
  });
  let stale = [];
  if (STALE_DAYS) {
    const open = await statusService.statusNamesForBase(ws, ['Open', 'Pending']);
    stale = await prisma.ticket.findMany({
      where: {
        workspaceId: ws,
        origin: 'freshservice',
        status: { in: open },
        freshserviceUpdatedAt: { lt: new Date(Date.now() - STALE_DAYS * 86400e3) },
      },
      select: { id: true, freshserviceTicketId: true, status: true, subject: true },
      orderBy: { freshserviceUpdatedAt: 'asc' },
      take: 300,
    });
  }
  const queue = [...legacy, ...stale.filter((s) => !legacy.some((l) => l.id === s.id))];
  console.log(`ws${ws}: ${legacy.length} with a legacy label, ${stale.length} stale open`);

  for (const t of queue) {
    try {
      const fs = await client.fetchTicketSafe(Number(t.freshserviceTicketId));
      const fsName = fs?.deleted ? 'Deleted' : getStatusString(Number(fs?.status), { workspaceId: ws });
      if (fsName === t.status) { totals.unchanged += 1; continue; }
      const kind = LEGACY_LABELS.includes(t.status) && fsName === 'Pending Response' ? 'relabel' : 'drift';
      console.log(`  #${t.freshserviceTicketId} "${String(t.subject).slice(0, 60)}": ${t.status} -> ${fsName} (${kind})`);
      if (APPLY) {
        await syncService.reconcileSingleTicket(t.id, ws);
        const after = await prisma.ticket.findUnique({ where: { id: t.id }, select: { status: true } });
        if (after?.status === t.status) { console.log(`    ! still "${after.status}" after reconcile`); totals.failed += 1; continue; }
      }
      if (kind === 'relabel') totals.relabelled += 1; else totals.driftFixed += 1;
    } catch (err) {
      totals.failed += 1;
      console.log(`  #${t.freshserviceTicketId}: failed — ${err.message}`);
    }
    await pause(400);
  }
}

console.log(`${APPLY ? 'Applied' : 'Would apply'}:`, JSON.stringify(totals));
await prisma.$disconnect();
process.exit(0);
