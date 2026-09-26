/**
 * Reply ownership (Auto-help integration W2, plans/AUTO_HELP_INTEGRATION_PLAN.md
 * design B): one owner of a ticket's FIRST reply.
 *
 *   agent  >  auto_help (a grounded Auto-help answer)  >  workflow_draft
 *
 * tickets.reply_owner / reply_owner_ref are written only under the per-ticket
 * advisory lock that already serializes proposed replies (same namespace as
 * ticketProposedReplyService.PROPOSAL_LOCK_NAMESPACE), so a staging, a
 * workflow draft and an agent's reply can never interleave.
 *
 * Rules:
 *   - a claim succeeds when the claimant ranks at least as high as the owner;
 *   - a workflow draft never replaces a higher owner (propose_reply yields);
 *   - an agent's own public reply always wins: a staged, unsent Auto-help
 *     proposal is dismissed and its run records outcome 'superseded_by'.
 *
 * Every function here is defensive: ownership bookkeeping must never make a
 * reply, a staging or a workflow step fail.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const REPLY_OWNERS = Object.freeze({ AGENT: 'agent', AUTO_HELP: 'auto_help', WORKFLOW_DRAFT: 'workflow_draft' });
export const REPLY_OWNER_RANK = Object.freeze({ workflow_draft: 1, auto_help: 2, agent: 3 });
/** Same advisory-lock namespace as ticketProposedReplyService (one lock per ticket). */
export const REPLY_LOCK_NAMESPACE = 48211;
export const SUPERSEDED_OUTCOME = 'superseded_by';

export function rankOf(kind) {
  return REPLY_OWNER_RANK[kind] || 0;
}

/** May `kind` take the first reply from `current`? (equal rank replaces: a newer workflow draft, a re-run.) */
export function mayClaim(kind, current) {
  if (!REPLY_OWNER_RANK[kind]) return false;
  return rankOf(kind) >= rankOf(current);
}

export async function lockTicketReplies(db, ticketId) {
  if (typeof db?.$queryRaw !== 'function') return false;
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${REPLY_LOCK_NAMESPACE}::int, ${Number(ticketId)}::int)`;
  return true;
}

/** Run `fn(tx)` in a transaction holding the per-ticket lock (plain client when there is no $transaction). */
export async function withTicketReplyLock(ticketId, fn) {
  if (typeof prisma.$transaction !== 'function') return fn(prisma);
  return prisma.$transaction(async (tx) => {
    await lockTicketReplies(tx, ticketId);
    return fn(tx);
  });
}

/** The current owner, read with the given client (inside the lock when it matters). */
export async function currentOwner(db, ticketId) {
  const row = await Promise.resolve()
    .then(() => db.ticket.findFirst({ where: { id: Number(ticketId) }, select: { id: true, replyOwner: true, replyOwnerRef: true } }))
    .catch(() => null);
  return { kind: row?.replyOwner || null, ref: row?.replyOwnerRef || null };
}

/**
 * Claim inside an open, locked transaction. Returns { claimed, previous }.
 * Never throws for a refusal; a write error propagates to the caller's tx.
 */
export async function claimInTx(tx, ticketId, kind, ref = null) {
  const previous = await currentOwner(tx, ticketId);
  if (!mayClaim(kind, previous.kind)) return { claimed: false, previous };
  if (previous.kind === kind && previous.ref === (ref || null)) return { claimed: true, previous, unchanged: true };
  await tx.ticket.updateMany({ where: { id: Number(ticketId) }, data: { replyOwner: kind, replyOwnerRef: ref ? String(ref).slice(0, 80) : null } });
  return { claimed: true, previous };
}

/** Claim under the lock. Never throws: { claimed: false, error } on failure. */
export async function claimReplyOwner(ticketId, kind, ref = null) {
  try {
    return await withTicketReplyLock(ticketId, (tx) => claimInTx(tx, ticketId, kind, ref));
  } catch (err) {
    logger.warn(`Reply owner ${kind} not recorded on ticket ${ticketId}: ${err.message}`);
    return { claimed: false, error: err.message };
  }
}

/** Give the first reply back (a dismissed / withdrawn Auto-help draft, a dismissed workflow draft). */
export async function releaseReplyOwner(ticketId, kind, ref = null) {
  try {
    const res = await prisma.ticket.updateMany({
      where: { id: Number(ticketId), replyOwner: kind, ...(ref ? { replyOwnerRef: String(ref) } : {}) },
      data: { replyOwner: null, replyOwnerRef: null },
    });
    return res?.count || 0;
  } catch (err) {
    logger.warn(`Reply owner ${kind} not released on ticket ${ticketId}: ${err.message}`);
    return 0;
  }
}

/**
 * An agent's own public reply (not the Auto-help answer they sent with one
 * click). The agent takes the first reply; a staged Auto-help proposal that
 * nobody sent is dismissed as superseded and its run says so. Returns
 * { superseded: [runIds] }. Never throws.
 */
export async function claimForAgentReply(ticketId, { entryId = null, actor = null } = {}) {
  const ref = entryId ? `entry:${entryId}` : null;
  let superseded = [];
  try {
    superseded = await withTicketReplyLock(ticketId, async (tx) => {
      await claimInTx(tx, ticketId, REPLY_OWNERS.AGENT, ref);
      const open = await Promise.resolve()
        .then(() => tx.ticketProposedReply.findMany({
          where: { ticketId: Number(ticketId), source: 'auto_help', status: 'proposed' },
          select: { id: true, autoHelpRunId: true },
        }))
        .catch(() => []);
      const out = [];
      for (const p of open || []) {
        const res = await tx.ticketProposedReply.updateMany({
          where: { id: p.id, status: 'proposed' },
          data: { status: 'dismissed', decidedBy: 'superseded_by_agent', decidedAt: new Date() },
        });
        if (res?.count) out.push({ proposalId: p.id, runId: p.autoHelpRunId ?? null });
      }
      return out;
    });
  } catch (err) {
    logger.warn(`Agent reply ownership not recorded on ticket ${ticketId}: ${err.message}`);
    return { superseded: [] };
  }
  for (const s of superseded) {
    if (!s.runId) continue;
    await markRunSuperseded(s.runId, { by: REPLY_OWNERS.AGENT, entryId, actorName: actor?.name || actor?.email || null, proposalId: s.proposalId });
  }
  if (superseded.length) {
    import('./ticketActivityRepository.js')
      .then(({ default: repo }) => repo.create({
        ticketId: Number(ticketId),
        activityType: 'auto_help_superseded',
        performedBy: actor?.name || actor?.email || 'An agent',
        performedAt: new Date(),
        details: { runIds: superseded.map((s) => s.runId), note: 'An agent replied themselves — the Auto-help suggestion was set aside' },
      }))
      .catch(() => {});
  }
  return { superseded: superseded.map((s) => s.runId).filter(Boolean) };
}

/** outcome 'superseded_by' on the losing Auto-help run (only when it has no outcome and no send). */
export async function markRunSuperseded(runId, detail = {}) {
  try {
    const run = await prisma.autoHelpRun.findFirst({ where: { id: Number(runId) }, select: { id: true, outcome: true, decision: true, outcomeDetail: true } });
    if (!run || run.outcome || run.decision) return false;
    const base = run.outcomeDetail && typeof run.outcomeDetail === 'object' && !Array.isArray(run.outcomeDetail) ? run.outcomeDetail : {};
    const history = Array.isArray(base.history) ? base.history.slice(-40) : [];
    history.push({ at: new Date().toISOString(), step: SUPERSEDED_OUTCOME, ...detail });
    const res = await prisma.autoHelpRun.updateMany({
      where: { id: run.id, outcome: null, decision: null },
      data: {
        outcome: SUPERSEDED_OUTCOME,
        outcomeAt: new Date(),
        outcomeDetail: JSON.parse(JSON.stringify({ ...base, supersededBy: detail, history })),
      },
    });
    return (res?.count || 0) > 0;
  } catch (err) {
    logger.warn(`Auto-help run ${runId}: superseded outcome not recorded (${err.message})`);
    return false;
  }
}

export default {
  REPLY_OWNERS,
  REPLY_OWNER_RANK,
  mayClaim,
  claimReplyOwner,
  claimInTx,
  releaseReplyOwner,
  claimForAgentReply,
  markRunSuperseded,
  withTicketReplyLock,
};
