import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { REPLY_OWNERS, claimInTx, claimReplyOwner, mayClaim, rankOf, releaseReplyOwner } from './autoHelpReplyOwner.js';

/**
 * LLM-drafted replies staged for human approval — the draft→approve pattern.
 * Workflows create proposals (propose_reply node, or an auto-send node
 * downgrading on low confidence / an always-human match); agents approve &
 * send through the normal reply path (so events, mirroring and threading all
 * behave exactly like a hand-written reply), edit first, or dismiss.
 *
 * Auto-help proposals (source 'auto_help', P1) are created with
 * `supersede: false` — a human-side draft already waiting wins and nothing is
 * created — and their send / dismiss go through autoHelpDeliveryService, which
 * adds the disclosure line + follow-up footer, records the agent's decision
 * on the run and parks the ticket for the follow-up loop.
 *
 * Reply ownership (integration W2, autoHelpReplyOwner.js): the first reply
 * has one owner — agent > auto_help > workflow_draft. A workflow draft never
 * supersedes an Auto-help answer that is waiting and never takes the first
 * reply from a higher owner: create() then returns null and the caller
 * (propose_reply, an auto-send downgrade) records that it yielded.
 */
/** Advisory-lock namespace for "one open proposal per ticket" (arbitrary, stable). */
export const PROPOSAL_LOCK_NAMESPACE = 48211;

/**
 * Serialize proposal creation per ticket for the rest of the transaction
 * (pg_advisory_xact_lock). A no-op on clients without raw SQL (unit mocks).
 */
export async function lockTicketProposals(db, ticketId) {
  if (typeof db?.$queryRaw !== 'function') return false;
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${PROPOSAL_LOCK_NAMESPACE}::int, ${Number(ticketId)}::int)`;
  return true;
}

const countOr0 = (fn) => Promise.resolve().then(fn).then((n) => Number(n) || 0).catch(() => 0);

/** The first-reply owner and whether a first reply already went out (read inside the lock). */
async function readOwner(db, ticketId) {
  const row = await Promise.resolve()
    .then(() => db.ticket.findFirst({ where: { id: Number(ticketId) }, select: { id: true, replyOwner: true, replyOwnerRef: true, firstPublicAgentReplyAt: true } }))
    .catch(() => null);
  return { kind: row?.replyOwner || null, ref: row?.replyOwnerRef || null, firstPublicAgentReplyAt: row?.firstPublicAgentReplyAt || null };
}


function htmlToPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class TicketProposedReplyService {
  async create({
    workspaceId,
    ticketId,
    workflowRunId = null,
    source = 'workflow_llm',
    subject = null,
    bodyHtml = null,
    bodyText = null,
    confidence = null,
    guardSummary = null,
    autoHelpRunId = null,
    supersede = true,
  }) {
    if (!bodyHtml && !bodyText) throw new ValidationError('A proposed reply needs a body');
    const data = {
      workspaceId,
      ticketId,
      workflowRunId,
      source,
      subject,
      bodyHtml,
      bodyText,
      confidence,
      guardSummary: guardSummary || undefined,
      ...(autoHelpRunId ? { autoHelpRunId } : {}),
    };
    let proposal;
    let refusedWhy = null;
    if (supersede) {
      // Workflow drafts (propose_reply, an auto-send downgrade). One open
      // proposal per ticket — a newer workflow draft supersedes an older one
      // rather than stacking confusing alternatives. Reply ownership (W2):
      // a workflow draft NEVER replaces a higher owner — an Auto-help answer
      // waiting for an agent, or an Auto-help / agent first reply still
      // pending — so it yields instead (returns null). Under the per-ticket
      // lock so an Auto-help staging can't slip in between (P1 audit).
      const supersedeAndCreate = async (db) => {
        await lockTicketProposals(db, ticketId);
        const openAutoHelp = await countOr0(() => db.ticketProposedReply.count({
          where: { ticketId, source: 'auto_help', status: { in: ['proposed', 'sending', 'needs_check'] } },
        }));
        if (openAutoHelp > 0) { refusedWhy = 'an Auto-help answer is waiting for an agent'; return null; }
        const owner = await readOwner(db, ticketId);
        const firstReplyDone = Boolean(owner.firstPublicAgentReplyAt);
        if (!firstReplyDone && rankOf(owner.kind) > rankOf(REPLY_OWNERS.WORKFLOW_DRAFT)) {
          refusedWhy = `the first reply belongs to ${owner.kind === REPLY_OWNERS.AGENT ? 'an agent' : 'Auto-help'}`;
          return null;
        }
        await db.ticketProposedReply.updateMany({
          where: { ticketId, status: 'proposed', source: { not: 'auto_help' } },
          data: { status: 'dismissed', decidedBy: 'superseded', decidedAt: new Date() },
        });
        const created = await db.ticketProposedReply.create({ data });
        // Only a draft of the FIRST reply takes ownership; a later draft
        // (after someone already answered) leaves the owner as it is.
        if (!firstReplyDone && created?.id) {
          await Promise.resolve()
            .then(() => claimInTx(db, ticketId, REPLY_OWNERS.WORKFLOW_DRAFT, `proposal:${created.id}`))
            .catch((err) => logger.warn(`Reply owner workflow_draft not recorded on ticket ${ticketId}: ${err.message}`));
        }
        return created;
      };
      proposal = typeof prisma.$transaction === 'function'
        ? await prisma.$transaction((tx) => supersedeAndCreate(tx))
        : await supersedeAndCreate(prisma);
      if (!proposal) {
        logger.info(`Workflow draft for ticket ${ticketId} (${source}) not staged: ${refusedWhy}`);
        return null;
      }
    } else {
      // Never overwrite: an open proposal (or one being sent) keeps its place.
      // The per-ticket advisory lock makes check-then-create race-proof: two
      // stagings (or a staging and a workflow draft) serialize on it. An
      // Auto-help answer also takes the first reply (W2) — never from an
      // agent who already owns it.
      proposal = await prisma.$transaction(async (tx) => {
        await lockTicketProposals(tx, ticketId);
        // needs_check = a send nobody could confirm: still this ticket's open suggestion.
        // 30 Sep 2026: a workflow's AI draft no longer blocks an Auto-help
        // answer. The answer takes its place and keeps its text, which goes
        // out on top of the answer (one e-mail). Another Auto-help answer, or
        // anything mid-send, still keeps its place.
        const openRows = await tx.ticketProposedReply.findMany({
          where: { ticketId, status: { in: ['proposed', 'sending', 'needs_check'] } },
          select: { id: true, source: true, status: true, bodyText: true, bodyHtml: true },
        });
        const workflowDrafts = source === 'auto_help'
          ? openRows.filter((r) => r.source !== 'auto_help' && r.status === 'proposed')
          : [];
        if (openRows.length > workflowDrafts.length) { refusedWhy = 'another proposal is waiting'; return null; }
        if (workflowDrafts.length) {
          const ackText = String(workflowDrafts[0].bodyText || htmlToPlain(workflowDrafts[0].bodyHtml) || '').trim().slice(0, 4000);
          await tx.ticketProposedReply.updateMany({
            where: { id: { in: workflowDrafts.map((r) => r.id) }, status: 'proposed' },
            data: { status: 'dismissed', decidedBy: 'superseded_by_auto_help', decidedAt: new Date() },
          });
          if (ackText) {
            data.guardSummary = { ...(data.guardSummary || {}), workflowAck: { text: ackText, fromProposalId: workflowDrafts[0].id } };
          }
        }
        if (source === 'auto_help') {
          const owner = await readOwner(tx, ticketId);
          if (!mayClaim(REPLY_OWNERS.AUTO_HELP, owner.kind)) { refusedWhy = 'an agent owns the first reply'; return null; }
        }
        const created = await tx.ticketProposedReply.create({ data });
        if (source === 'auto_help' && created?.id) {
          await Promise.resolve()
            .then(() => claimInTx(tx, ticketId, REPLY_OWNERS.AUTO_HELP, autoHelpRunId ? `run:${autoHelpRunId}` : `proposal:${created.id}`))
            .catch((err) => logger.warn(`Reply owner auto_help not recorded on ticket ${ticketId}: ${err.message}`));
        }
        return created;
      });
      if (!proposal) {
        logger.info(`Proposed reply for ticket ${ticketId} (${source}) not staged: ${refusedWhy}`);
        return null;
      }
    }
    this._broadcast(workspaceId, ticketId, 'proposed');
    logger.info(`Proposed reply ${proposal.id} staged for ticket ${ticketId} (${source}, confidence=${confidence || 'n/a'})`);
    return proposal;
  }

  async listForTicket(ticketId, workspaceId, { status = 'proposed', actor = null } = {}) {
    // An Auto-help suggestion whose send could not be confirmed ('needs_check')
    // stays on the card, with the warning, until a person checks.
    const statusWhere = status === 'proposed'
      ? { OR: [{ status: 'proposed' }, { status: 'needs_check', source: 'auto_help' }] }
      : (status ? { status } : {});
    const rows = await prisma.ticketProposedReply.findMany({
      where: { ticketId, workspaceId, ...statusWhere },
      orderBy: { createdAt: 'desc' },
    });
    if (!(rows || []).some((r) => r.source === 'auto_help')) return rows;
    // Auto-help suggestions carry what the card shows (playbook, sources, dates).
    const { default: delivery } = await import('./autoHelpDeliveryService.js');
    const { canApproveAutoHelp } = await import('./autoHelpDeliveryService.js');
    const ticket = actor ? await Promise.resolve()
      .then(() => prisma.ticket.findFirst({ where: { id: Number(ticketId), workspaceId: Number(workspaceId) }, select: { assignedTechId: true } }))
      .catch(() => null) : null;
    return Promise.all(rows.map(async (r) => {
      if (r.source !== 'auto_help') return r;
      const ctx = await delivery.proposalContext(workspaceId, r).catch(() => null);
      // canSend: who is looking may send it (the assignee, a reviewer or an admin).
      return { ...r, autoHelp: ctx ? { ...ctx, canSend: actor ? canApproveAutoHelp(actor, ticket) : true } : ctx };
    }));
  }

  /** Approve & send — optionally with an agent-edited body. */
  async send(ticketId, workspaceId, proposalId, { bodyHtml = null, bodyText = null, confirmResend = false } = {}, actor) {
    const proposal = await this._requireProposal(ticketId, workspaceId, proposalId);
    if (proposal.source === 'auto_help') {
      const { default: delivery } = await import('./autoHelpDeliveryService.js');
      const result = await delivery.sendProposal({ ticketId, workspaceId, proposal, bodyHtml, bodyText, actor, confirmResend: confirmResend === true });
      this._broadcast(workspaceId, ticketId, 'sent');
      return result;
    }
    const html = String(bodyHtml || proposal.bodyHtml || '').trim() || null;
    const text = String(bodyText || proposal.bodyText || '').trim() || null;
    if (!html && !text) throw new ValidationError('Nothing to send');

    const { default: ticketService } = await import('./ticketService.js');
    const result = await ticketService.addReply(ticketId, workspaceId, {
      bodyHtml: html,
      bodyText: text,
    }, actor);

    const updated = await prisma.ticketProposedReply.update({
      where: { id: proposal.id },
      data: {
        status: 'sent',
        decidedBy: actor?.email || actor?.name || 'agent',
        decidedAt: new Date(),
        sentThreadEntryId: result?.entry?.id ?? result?.id ?? null,
        // Keep what actually went out (edits included) for the audit trail.
        bodyHtml: html,
        bodyText: text,
      },
    });
    this._broadcast(workspaceId, ticketId, 'sent');
    return { proposal: updated, reply: result };
  }

  async dismiss(ticketId, workspaceId, proposalId, actor, { reason = null } = {}) {
    const proposal = await this._requireProposal(ticketId, workspaceId, proposalId);
    if (proposal.source === 'auto_help') {
      const { default: delivery } = await import('./autoHelpDeliveryService.js');
      const updated = await delivery.dismissProposal({ ticketId, workspaceId, proposal, reason, actor });
      // W2: a dismissed Auto-help answer gives the first reply back.
      await releaseReplyOwner(ticketId, REPLY_OWNERS.AUTO_HELP, proposal.autoHelpRunId ? `run:${proposal.autoHelpRunId}` : `proposal:${proposal.id}`);
      await this._restoreSetAsideWorkflowDraft(ticketId, proposal);
      this._broadcast(workspaceId, ticketId, 'dismissed');
      return updated;
    }
    const updated = await prisma.ticketProposedReply.update({
      where: { id: proposal.id },
      data: { status: 'dismissed', decidedBy: actor?.email || actor?.name || 'agent', decidedAt: new Date() },
    });
    await releaseReplyOwner(ticketId, REPLY_OWNERS.WORKFLOW_DRAFT, `proposal:${proposal.id}`);
    this._broadcast(workspaceId, ticketId, 'dismissed');
    return updated;
  }

  /**
   * The workflow draft an Auto-help answer set aside (30 Sep 2026) comes back
   * when that answer is dismissed, so the requester still gets the
   * acknowledgement a person can send. Only a draft set aside this way, and
   * only while it is still the one set aside.
   */
  async _restoreSetAsideWorkflowDraft(ticketId, proposal) {
    const fromId = Number(proposal?.guardSummary?.workflowAck?.fromProposalId) || null;
    if (!fromId) return false;
    const res = await Promise.resolve()
      .then(() => prisma.ticketProposedReply.updateMany({
        where: { id: fromId, ticketId: Number(ticketId), status: 'dismissed', decidedBy: 'superseded_by_auto_help' },
        data: { status: 'proposed', decidedBy: null, decidedAt: null },
      }))
      .catch((err) => { logger.warn(`Workflow draft ${fromId} not restored on ticket ${ticketId}: ${err.message}`); return null; });
    if (!res?.count) return false;
    await claimReplyOwner(ticketId, REPLY_OWNERS.WORKFLOW_DRAFT, `proposal:${fromId}`);
    return true;
  }

  async _requireProposal(ticketId, workspaceId, proposalId) {
    const proposal = await prisma.ticketProposedReply.findFirst({
      where: { id: Number(proposalId), ticketId, workspaceId },
    });
    if (!proposal) throw new NotFoundError('Proposed reply not found');
    const open = proposal.status === 'proposed' || (proposal.status === 'needs_check' && proposal.source === 'auto_help');
    if (!open) throw new ValidationError(`Proposed reply is already ${proposal.status}`);
    return proposal;
  }

  _broadcast(workspaceId, ticketId, action) {
    import('../routes/sse.routes.js')
      .then(({ sseManager }) => sseManager.broadcast('ticket-change', {
        action: 'proposed_reply',
        proposalAction: action,
        workspaceId,
        ticketId,
      }, workspaceId))
      .catch(() => {});
  }
}

const ticketProposedReplyService = new TicketProposedReplyService();
export default ticketProposedReplyService;
