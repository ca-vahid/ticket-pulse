/**
 * Per-ticket advisory lock for Auto-help's intake settles (audit S2,
 * 26 Sep 2026). Two settle jobs for one ticket (the morning settle and a
 * manual recategorization, two containers during a deploy) must never both
 * decide "nothing ran yet" and both run the model:
 *
 *   - autoHelpIntakeService.claim takes this lock for the claim itself and
 *     refuses a job while another job for the same ticket is running;
 *   - autoHelpRunner.runForTicket re-checks "already ran" and creates the run
 *     row under the same lock (the belt to the claim's braces).
 *
 * A transaction-scoped lock (pg_advisory_xact_lock): held for milliseconds,
 * never across a model call, so it costs the 9-connection pool nothing.
 * Its own namespace (the reply-owner lock is 48211).
 */
import prisma from './prisma.js';

export const AUTO_HELP_SETTLE_LOCK_NAMESPACE = 48213;

/** Take the per-ticket settle lock inside an open transaction. */
export async function lockTicketSettles(db, ticketId) {
  if (typeof db?.$queryRaw !== 'function') return false;
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${AUTO_HELP_SETTLE_LOCK_NAMESPACE}::int, ${Number(ticketId)}::int)`;
  return true;
}

/** Run `fn(tx)` in a short transaction holding the ticket's settle lock. */
export async function withTicketSettleLock(ticketId, fn, client = prisma) {
  if (typeof client?.$transaction !== 'function') return fn(client);
  return client.$transaction(async (tx) => {
    await lockTicketSettles(tx, ticketId);
    return fn(tx);
  });
}

export default { AUTO_HELP_SETTLE_LOCK_NAMESPACE, lockTicketSettles, withTicketSettleLock };
