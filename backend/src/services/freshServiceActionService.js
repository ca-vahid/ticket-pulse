import { createFreshServiceClient } from '../integrations/freshservice.js';
import settingsRepository from './settingsRepository.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

class FreshServiceActionService {
  /**
   * Build the FreshService actions for a pipeline run decision.
   * Returns the exact payload that would be sent — used by both real and dry-run modes.
   */
  async buildAction(run) {
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: { freshserviceTicketId: true, subject: true, ticketCategory: true },
    });

    const fsTicketId = Number(ticket?.freshserviceTicketId);
    if (!fsTicketId) {
      return { actions: [], preview: 'Cannot sync: ticket has no FreshService ID', error: 'missing_fs_ticket_id' };
    }

    const decision = run.decision;
    const actions = [];

    if (decision === 'approved' || decision === 'modified' || decision === 'auto_assigned') {
      const tech = run.assignedTechId
        ? await prisma.technician.findUnique({
          where: { id: run.assignedTechId },
          select: { freshserviceId: true, name: true },
        })
        : null;

      if (!tech?.freshserviceId) {
        return { actions: [], preview: 'Cannot sync: assigned technician has no FreshService ID', error: 'missing_fs_agent_id' };
      }

      const fsAgentId = Number(tech.freshserviceId);
      actions.push({ type: 'assign', ticketId: fsTicketId, agentId: fsAgentId });

      const reasoning = run.recommendation?.overallReasoning || '';
      const confidence = run.recommendation?.confidence || 'N/A';
      const decisionLabel = decision === 'auto_assigned' ? 'auto-assigned' : decision === 'modified' ? 'assigned (admin override)' : 'approved';

      let noteBody = `<b>[Ticket Pulse]</b> Assignment ${decisionLabel}.<br>`;
      noteBody += `<b>Assigned to:</b> ${tech.name}<br>`;
      noteBody += `<b>Confidence:</b> ${confidence}<br>`;
      if (run.overrideReason) noteBody += `<b>Override reason:</b> ${run.overrideReason}<br>`;
      noteBody += `<b>Reasoning:</b> ${reasoning}<br>`;
      noteBody += `<b>Run ID:</b> ${run.id}`;

      actions.push({ type: 'note', ticketId: fsTicketId, body: noteBody, private: true });

    } else if (decision === 'noise_dismissed') {
      const classification = run.recommendation?.ticketClassification || 'noise';
      const reasoning = run.recommendation?.overallReasoning || 'Classified as non-actionable';

      let noteBody = '<b>[Ticket Pulse]</b> Ticket classified as non-actionable noise.<br>';
      noteBody += `<b>Classification:</b> ${classification}<br>`;
      noteBody += `<b>Reasoning:</b> ${reasoning}<br>`;
      noteBody += `<b>Run ID:</b> ${run.id}`;

      actions.push({ type: 'note', ticketId: fsTicketId, body: noteBody, private: true });
      actions.push({ type: 'close', ticketId: fsTicketId, status: 4 });
    } else {
      return { actions: [], preview: `No FreshService action for decision: ${decision}`, error: null };
    }

    const preview = actions.map((a) => {
      if (a.type === 'assign') return `Assign ticket #${a.ticketId} to agent ${a.agentId}`;
      if (a.type === 'close') return `Close ticket #${a.ticketId}`;
      if (a.type === 'note') return `Add private note to ticket #${a.ticketId}`;
      return `${a.type} on ticket #${a.ticketId}`;
    }).join(' → ');

    return { actions, preview, error: null };
  }

  /**
   * Execute FreshService write-back for a pipeline run.
   * Single path: builds the action, then either previews (dry-run) or executes (real).
   */
  async execute(runId, workspaceId, dryRun = false) {
    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: runId },
      include: {
        ticket: { select: { freshserviceTicketId: true, subject: true, ticketCategory: true } },
      },
    });

    if (!run) {
      logger.warn('FreshService sync: run not found', { runId });
      return { success: false, error: 'Run not found' };
    }

    const { actions, preview, error: buildError } = await this.buildAction(run);

    if (buildError) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'skipped', syncError: buildError, syncPayload: { actions, preview } },
      });
      logger.info('FreshService sync skipped', { runId, reason: buildError });
      return { success: false, error: buildError, preview };
    }

    if (actions.length === 0) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'skipped', syncPayload: { actions, preview } },
      });
      return { success: true, preview, skipped: true };
    }

    // Store payload regardless of mode
    const payloadData = { actions, preview, dryRun, timestamp: new Date().toISOString() };

    if (dryRun) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'dry_run', syncPayload: payloadData },
      });
      logger.info('FreshService sync dry-run', { runId, preview });
      return { success: true, dryRun: true, preview, actions };
    }

    // Real execution
    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        throw new Error('FreshService not configured for this workspace');
      }

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
      let ticketGone = false;

      for (const action of actions) {
        if (ticketGone) {
          logger.info(`FreshService: skipping ${action.type} — ticket already deleted/terminal`, { ticketId: action.ticketId, runId });
          continue;
        }

        if (action.type === 'assign') {
          const result = await client.assignTicket(action.ticketId, action.agentId);
          if (result?.alreadyClosed) { ticketGone = true; continue; }
          logger.info('FreshService: ticket assigned', { ticketId: action.ticketId, agentId: action.agentId, runId });
        } else if (action.type === 'close') {
          const result = await client.closeTicket(action.ticketId, action.status);
          if (result?.alreadyClosed) { ticketGone = true; }
          logger.info('FreshService: ticket closed', { ticketId: action.ticketId, runId });
        } else if (action.type === 'note') {
          const result = await client.addPrivateNote(action.ticketId, action.body);
          if (result?.skipped) { ticketGone = true; continue; }
          logger.info('FreshService: note added', { ticketId: action.ticketId, runId });
        }
      }

      const syncNote = ticketGone ? 'Ticket already deleted or closed in FreshService — no action needed' : null;

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'synced', syncedAt: new Date(), syncPayload: payloadData, syncError: syncNote },
      });

      logger.info('FreshService sync completed', { runId, preview, ticketGone });
      return { success: true, preview, actions, ticketGone, syncNote };

    } catch (err) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'failed', syncError: err.message, syncPayload: payloadData },
      });
      logger.error('FreshService sync failed', { runId, error: err.message });
      return { success: false, error: err.message, preview };
    }
  }
}

export default new FreshServiceActionService();
