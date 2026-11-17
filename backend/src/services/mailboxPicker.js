import prisma from './prisma.js';

/**
 * ONE outbound mailbox picker (Mega 08-31 Phase MB-1g). Every lane that
 * sends requester-facing or workspace mail — agent replies, forwards,
 * transactional/workflow emails, watcher notices, the sender-identity
 * Settings view — asks here instead of running its own `findFirst`, so a
 * multi-mailbox workspace sends from ONE deterministic address:
 *
 *   isEnabled, mode ∈ {send, both}    (requireSend, default)
 *   ordered by isPrimary DESC, id ASC  (the admin's star wins; else oldest)
 *
 * Returns the full MailboxConnection row or null. `requireSend: false`
 * relaxes the mode filter (any enabled connection — for callers that only
 * want "is any mailbox connected at all").
 */
export const OUTBOUND_MAILBOX_ORDER = [{ isPrimary: 'desc' }, { id: 'asc' }];

export async function pickOutboundMailbox(workspaceId, { requireSend = true } = {}) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return prisma.mailboxConnection.findFirst({
    where: {
      workspaceId: id,
      isEnabled: true,
      ...(requireSend ? { mode: { in: ['send', 'both'] } } : {}),
    },
    orderBy: OUTBOUND_MAILBOX_ORDER,
  });
}

/**
 * The mailbox that READS replies (mode ingest|both), same ordering. Used by
 * the SendGrid fallback lane to still set a plus-address Reply-To so the
 * reply loop survives a Graph outage (the mail leaves as ticketpulse@ but
 * answers land in the monitored mailbox).
 */
export async function pickIngestMailbox(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return prisma.mailboxConnection.findFirst({
    where: { workspaceId: id, isEnabled: true, mode: { in: ['ingest', 'both'] } },
    orderBy: OUTBOUND_MAILBOX_ORDER,
  });
}

/**
 * Mark one connection as the workspace's primary sender, clearing any other
 * primary in the same transaction (the partial unique index
 * `mailbox_connections_one_primary_per_workspace_idx` backs this at the DB).
 * `isPrimary: false` just clears the flag on that row.
 */
export async function setPrimaryMailbox(workspaceId, mailboxId, isPrimary = true) {
  return prisma.$transaction(async (tx) => {
    if (isPrimary) {
      await tx.mailboxConnection.updateMany({
        where: { workspaceId, isPrimary: true, NOT: { id: mailboxId } },
        data: { isPrimary: false },
      });
    }
    return tx.mailboxConnection.update({ where: { id: mailboxId }, data: { isPrimary: Boolean(isPrimary) } });
  });
}

/**
 * The mailbox ONE ticket's mail should use (16 Nov 2026, QA 11-16 #6). A workspace with one
 * mailbox per team (Accounting: aptickets@ → AP group, artickets@ → AR group) sent every
 * reply from the primary, so an AR ticket's answer left from aptickets@. Prefer the
 * connection whose default group is the ticket's group (FreshService or internal), else the
 * usual pick (primary first, then oldest). `modes`: ['send','both'] for the Graph lane,
 * ['ingest','both'] for the SendGrid From / Reply-To. Never throws worse than the old picker:
 * a lookup failure falls back to it.
 */
export async function pickMailboxForTicket(ticket, { modes = ['ingest', 'both'] } = {}) {
  const id = Number(ticket?.workspaceId);
  if (!Number.isInteger(id) || id <= 0) return null;
  let rows;
  try {
    rows = await prisma.mailboxConnection.findMany({
      where: { workspaceId: id, isEnabled: true, mode: { in: modes } },
      orderBy: OUTBOUND_MAILBOX_ORDER,
      take: 20,
    });
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    return modes.includes('send') ? pickOutboundMailbox(id) : pickIngestMailbox(id);
  }
  if (rows.length === 0) return null;
  const group = ticket?.groupId !== null && ticket?.groupId !== undefined ? String(ticket.groupId) : null;
  const internal = ticket?.internalGroupId !== null && ticket?.internalGroupId !== undefined ? Number(ticket.internalGroupId) : null;
  const match = rows.find((r) => (group && r.defaultGroupId !== null && r.defaultGroupId !== undefined && String(r.defaultGroupId) === group)
    || (internal && Number(r.defaultInternalGroupId) === internal));
  return match || rows[0];
}

export const pickOutboundMailboxForTicket = (ticket) => pickMailboxForTicket(ticket, { modes: ['send', 'both'] });
export const pickIngestMailboxForTicket = (ticket) => pickMailboxForTicket(ticket, { modes: ['ingest', 'both'] });

export default {
  pickOutboundMailbox, pickIngestMailbox, pickMailboxForTicket, pickOutboundMailboxForTicket, pickIngestMailboxForTicket,
  setPrimaryMailbox, OUTBOUND_MAILBOX_ORDER,
};

/**
 * The address SendGrid mail should leave FROM for this workspace (FR 09-11 #5).
 *
 * Until now the SendGrid lane always sent as the global sender
 * (ticketpulse@…), so a workspace that reads its own mailbox — patickets@ —
 * replied from an address it does not own, with only Reply-To pointing home.
 * With the bgcengineering.ca domain authenticated in SendGrid (QA confirmed
 * 09-11) we can send AS the workspace's ingest mailbox: the address people
 * already write to, and the one whose Reply-To we were setting anyway.
 * Null when no mailbox is connected → callers fall back to the global sender.
 */
export async function sendgridFromAddress(workspaceId) {
  const ingest = await pickIngestMailbox(workspaceId).catch(() => null);
  const address = String(ingest?.address || '').trim();
  return address || null;
}
