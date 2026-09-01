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

export default { pickOutboundMailbox, pickIngestMailbox, setPrimaryMailbox, OUTBOUND_MAILBOX_ORDER };
