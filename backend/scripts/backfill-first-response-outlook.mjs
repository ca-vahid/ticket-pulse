#!/usr/bin/env node
/**
 * QA 11-05 #1 — backfill: open tickets whose first agent answer came back
 * through the mailbox as the agent's own Outlook reply, but whose
 * `first_public_agent_reply_at` is still null (the gap fixed in
 * mailboxIngestService._stampAgentFirstResponse).
 *
 * DRY RUN BY DEFAULT: reads only, prints counts per workspace and the ticket
 * ids. Nothing is written without --apply.
 *
 *   node scripts/backfill-first-response-outlook.mjs                 # dry run, workspaces 1,2,4,5, last 180 days
 *   node scripts/backfill-first-response-outlook.mjs --workspace=1   # one workspace
 *   node scripts/backfill-first-response-outlook.mjs --days=365 --include-closed
 *   node scripts/backfill-first-response-outlook.mjs --apply [--undo-file=path.json]
 *
 * The value written is the time Outlook delivered the reply (the thread
 * entry's occurredAt), never before the ticket existed. Only tickets where
 * that e-mail reply IS the earliest public agent reply are touched, and the
 * write is conditional (`first_public_agent_reply_at IS NULL`), so a value
 * that appears meanwhile is never overwritten.
 *
 * --apply writes an undo file: [{ ticketId, ref, set }]. To undo, set the
 * field back to null on those ids where it still equals `set`.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TERMINAL = ['Resolved', 'Closed', 'Deleted', 'Spam'];
const DEFAULT_WORKSPACES = [1, 2, 4, 5];

/** An agent's own outbound words: not a forward, not something they relayed. */
export function isOutlookAgentReply(entry) {
  const p = entry?.rawPayload && typeof entry.rawPayload === 'object' ? entry.rawPayload : {};
  return entry?.source === 'email_inbound' && entry?.eventType === 'reply' && entry?.authorType === 'agent'
    && entry?.incoming === false && p.deliveryState === 'external' && !p.forwarded;
}

const isPublicAgentReply = (e) => e.eventType === 'reply' && e.authorType === 'agent' && e.isPrivate !== true && e.incoming !== true
  && !(e.rawPayload && typeof e.rawPayload === 'object' && e.rawPayload.forwarded);

/**
 * Reads only. Returns [{ ticketId, workspaceId, ref, status, set }] — the
 * tickets the backfill would stamp and the value it would write.
 */
export async function findCandidates(db, { workspaceIds = DEFAULT_WORKSPACES, days = 180, includeClosed = false, limit = 5000 } = {}) {
  const since = new Date(Date.now() - days * 86400e3);
  const mailReplies = await db.ticketThreadEntry.findMany({
    where: {
      workspaceId: { in: workspaceIds }, source: 'email_inbound', eventType: 'reply', authorType: 'agent', incoming: false, occurredAt: { gte: since },
    },
    select: { id: true, ticketId: true, occurredAt: true, source: true, eventType: true, authorType: true, incoming: true, isPrivate: true, rawPayload: true },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });
  const outlook = mailReplies.filter(isOutlookAgentReply);
  const ticketIds = [...new Set(outlook.map((e) => e.ticketId))];
  if (!ticketIds.length) return [];
  const tickets = await db.ticket.findMany({
    where: {
      id: { in: ticketIds }, workspaceId: { in: workspaceIds }, firstPublicAgentReplyAt: null,
      ...(includeClosed ? {} : { status: { notIn: TERMINAL } }),
    },
    select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, status: true, createdAt: true },
    take: limit,
  });
  if (!tickets.length) return [];
  // Any earlier public agent reply (in-app, FreshService) wins: then the
  // e-mail was not the first answer and the ticket is left alone.
  const all = await db.ticketThreadEntry.findMany({
    where: { ticketId: { in: tickets.map((t) => t.id) }, eventType: 'reply', authorType: 'agent' },
    select: { id: true, ticketId: true, occurredAt: true, source: true, eventType: true, authorType: true, incoming: true, isPrivate: true, rawPayload: true },
    orderBy: { occurredAt: 'asc' },
    take: limit * 4,
  });
  const out = [];
  for (const t of tickets) {
    const first = all.filter((e) => e.ticketId === t.id && isPublicAgentReply(e)).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt))[0];
    if (!first || !isOutlookAgentReply(first)) continue;
    const created = t.createdAt ? new Date(t.createdAt) : null;
    let set = new Date(first.occurredAt);
    if (created && set < created) set = created;
    const ref = t.origin === 'ticketpulse' && t.nativeNumber ? `TP-${t.nativeNumber}` : (t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `ticket ${t.id}`);
    out.push({ ticketId: t.id, workspaceId: t.workspaceId, ref, status: t.status, set: set.toISOString(), entryId: first.id });
  }
  return out;
}

export async function applyCandidates(db, rows) {
  const done = [];
  for (const r of rows) {
    const res = await db.ticket.updateMany({ where: { id: r.ticketId, firstPublicAgentReplyAt: null }, data: { firstPublicAgentReplyAt: new Date(r.set) } });
    if (res?.count) done.push({ ticketId: r.ticketId, ref: r.ref, set: r.set });
  }
  return done;
}

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const ws = get('workspace');
  const workspaceIds = ws ? ws.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : DEFAULT_WORKSPACES;
  return {
    apply: argv.includes('--apply'),
    includeClosed: argv.includes('--include-closed'),
    days: Number(get('days')) || 180,
    workspaceIds: workspaceIds.filter((n) => ![6, 7, 8, 9].includes(n)),
    undoFile: get('undo-file') || `backfill-first-response-outlook-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: prisma } = await import('../src/services/prisma.js');
  try {
    const rows = await findCandidates(prisma, args);
    const byWs = rows.reduce((m, r) => ({ ...m, [r.workspaceId]: (m[r.workspaceId] || 0) + 1 }), {});
    console.log(`${args.apply ? 'APPLY' : 'DRY RUN'} — first response from an Outlook reply, ${args.includeClosed ? 'all statuses' : 'open tickets'}, last ${args.days} days, workspaces ${args.workspaceIds.join(',')}`);
    console.log(`candidates: ${rows.length}`, JSON.stringify(byWs));
    console.log('ids:', JSON.stringify(rows.map((r) => r.ticketId)));
    if (!args.apply) {
      console.log('Nothing written (dry run). Re-run with --apply to stamp them.');
      return;
    }
    const done = await applyCandidates(prisma, rows);
    writeFileSync(args.undoFile, JSON.stringify(done, null, 2));
    console.log(`stamped: ${done.length}; undo file: ${args.undoFile}`);
  } finally {
    await prisma.$disconnect?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
