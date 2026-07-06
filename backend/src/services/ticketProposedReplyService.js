import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * LLM-drafted replies staged for human approval — the draft→approve pattern.
 * Workflows create proposals (propose_reply node, or an auto-send node
 * downgrading on low confidence / an always-human match); agents approve &
 * send through the normal reply path (so events, mirroring and threading all
 * behave exactly like a hand-written reply), edit first, or dismiss.
 */
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
  }) {
    if (!bodyHtml && !bodyText) throw new ValidationError('A proposed reply needs a body');
    // One open proposal per ticket — a newer draft supersedes the old one
    // rather than stacking confusing alternatives.
    await prisma.ticketProposedReply.updateMany({
      where: { ticketId, status: 'proposed' },
      data: { status: 'dismissed', decidedBy: 'superseded', decidedAt: new Date() },
    });
    const proposal = await prisma.ticketProposedReply.create({
      data: {
        workspaceId,
        ticketId,
        workflowRunId,
        source,
        subject,
        bodyHtml,
        bodyText,
        confidence,
        guardSummary: guardSummary || undefined,
      },
    });
    this._broadcast(workspaceId, ticketId, 'proposed');
    logger.info(`Proposed reply ${proposal.id} staged for ticket ${ticketId} (${source}, confidence=${confidence || 'n/a'})`);
    return proposal;
  }

  async listForTicket(ticketId, workspaceId, { status = 'proposed' } = {}) {
    return prisma.ticketProposedReply.findMany({
      where: { ticketId, workspaceId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Approve & send — optionally with an agent-edited body. */
  async send(ticketId, workspaceId, proposalId, { bodyHtml = null, bodyText = null } = {}, actor) {
    const proposal = await this._requireProposal(ticketId, workspaceId, proposalId);
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

  async dismiss(ticketId, workspaceId, proposalId, actor) {
    const proposal = await this._requireProposal(ticketId, workspaceId, proposalId);
    const updated = await prisma.ticketProposedReply.update({
      where: { id: proposal.id },
      data: { status: 'dismissed', decidedBy: actor?.email || actor?.name || 'agent', decidedAt: new Date() },
    });
    this._broadcast(workspaceId, ticketId, 'dismissed');
    return updated;
  }

  async _requireProposal(ticketId, workspaceId, proposalId) {
    const proposal = await prisma.ticketProposedReply.findFirst({
      where: { id: Number(proposalId), ticketId, workspaceId },
    });
    if (!proposal) throw new NotFoundError('Proposed reply not found');
    if (proposal.status !== 'proposed') throw new ValidationError(`Proposed reply is already ${proposal.status}`);
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
