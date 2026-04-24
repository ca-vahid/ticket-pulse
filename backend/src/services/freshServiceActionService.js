import { createFreshServiceClient } from '../integrations/freshservice.js';
import settingsRepository from './settingsRepository.js';
import prisma from './prisma.js';
import { shouldCloseNoiseDismissedRun } from './assignmentFlowGuards.js';
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

      const decisionLabel = decision === 'auto_assigned' ? 'auto-assigned' : decision === 'modified' ? 'assigned (admin override)' : 'approved';

      // Prefer the LLM's sanitized public briefing. Fall back to overallReasoning
      // for legacy runs (created before agentBriefingHtml was introduced) so
      // re-syncs of historical runs don't break, but log it so we can spot
      // unexpected fallbacks.
      const briefing = run.recommendation?.agentBriefingHtml;
      const legacyReasoning = run.recommendation?.overallReasoning;
      const usingFallback = !briefing && !!legacyReasoning;
      if (usingFallback) {
        logger.warn('FreshService note: agentBriefingHtml missing, falling back to overallReasoning (may leak internal logic)', { runId: run.id });
      }
      const messageHtml = briefing || legacyReasoning || '';

      let noteBody = `<b>[Ticket Pulse]</b> Assignment ${decisionLabel}.<br>`;
      noteBody += `<b>Assigned to:</b> ${tech.name}<br>`;
      if (messageHtml) noteBody += `${messageHtml}<br>`;
      if (run.overrideReason) noteBody += `<b>Override reason:</b> ${run.overrideReason}<br>`;
      noteBody += `<b>Run ID:</b> ${run.id}`;

      actions.push({ type: 'note', ticketId: fsTicketId, body: noteBody, private: true });

    } else if (decision === 'noise_dismissed') {
      if (!shouldCloseNoiseDismissedRun(run)) {
        logger.info('FreshService sync: skipping close for noise_dismissed run that had valid recommendations', {
          runId: run.id, recCount: run.recommendation.recommendations.length,
        });
        return { actions: [], preview: 'Skipped: run had valid recommendations — admin dismissed the pipeline run, not the ticket', error: null };
      }

      // Prefer the LLM's sanitized closure notice. Fall back to a generic line
      // (NOT the internal reasoning) for legacy runs without the new field.
      const closureNotice = run.recommendation?.closureNoticeHtml;
      if (!closureNotice) {
        logger.warn('FreshService note: closureNoticeHtml missing on noise_dismissed run, using generic message', { runId: run.id });
      }
      const messageHtml = closureNotice || 'This ticket has been reviewed and does not require helpdesk follow-up.';

      let noteBody = '<b>[Ticket Pulse]</b> Ticket closed without assignment.<br>';
      noteBody += `${messageHtml}<br>`;
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
   * Includes preflight validation against live FS state unless force=true.
   * @param {number} runId
   * @param {number} workspaceId
   * @param {boolean} dryRun
   * @param {Object} options
   * @param {boolean} options.force - Skip preflight checks
   */
  async execute(runId, workspaceId, dryRun = false, options = {}) {
    const force = options.force || false;

    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: runId },
      include: {
        ticket: { select: { id: true, freshserviceTicketId: true, subject: true, ticketCategory: true } },
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

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source: 'freshservice-action',
      });

      // --- Preflight checks (skip if force=true) ---
      if (!force) {
        const assignAction = actions.find((a) => a.type === 'assign');
        if (assignAction) {
          const preflightResult = await this._preflightCheck(client, run, assignAction);
          if (preflightResult) {
            // For auto-assigned runs (no human in the loop yet), downgrade the
            // decision to pending_review so the run surfaces in Awaiting
            // Decision instead of being stuck as `auto_assigned + syncStatus=failed`
            // — which would falsely appear assigned in the dashboard while
            // FreshService is unchanged. Manually-approved runs keep their
            // existing decision so the audit trail shows admin intent.
            const shouldDowngrade = run.decision === 'auto_assigned';
            const updatePayload = {
              syncStatus: 'failed',
              syncError: preflightResult.reason,
              syncPayload: { ...payloadData, preflightAbort: preflightResult },
            };
            if (shouldDowngrade) {
              updatePayload.decision = 'pending_review';
              updatePayload.assignedTechId = null;
              // Clear decidedAt — the pipeline set it when the decision was
              // auto_assigned (see _executeRun), but we're reverting that
              // decision now. A pending_review run should always have
              // decidedAt=null until an admin makes the real call.
              updatePayload.decidedAt = null;
              updatePayload.errorMessage = `Auto-assign blocked at FreshService preflight: ${preflightResult.reason}. Downgraded to pending_review for manual handling.`;
            }
            await prisma.assignmentPipelineRun.update({
              where: { id: runId },
              data: updatePayload,
            });
            logger.warn('FreshService sync aborted by preflight', { runId, downgraded: shouldDowngrade, ...preflightResult });
            return { success: false, error: preflightResult.reason, preflightAbort: preflightResult, preview, downgraded: shouldDowngrade };
          }
        }
      }

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
      const freshserviceError = err.freshserviceDetail
        ? { status: err.freshserviceStatus, body: err.freshserviceDetail }
        : null;
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          syncStatus: 'failed',
          syncError: err.message,
          syncPayload: { ...payloadData, freshserviceError },
        },
      });
      logger.error('FreshService sync failed', { runId, error: err.message, freshserviceError });
      return { success: false, error: err.message, preview, freshserviceError };
    }
  }
  /**
   * Pre-validate that the assignment will succeed before making the API call.
   * Returns null if OK, or { code, reason, details } if should abort.
   */
  async _preflightCheck(client, run, assignAction) {
    try {
      const fsTicket = await client.getTicket(assignAction.ticketId);
      if (!fsTicket) return null;

      // Check 1: ticket already assigned to someone else
      if (fsTicket.responder_id && Number(fsTicket.responder_id) !== Number(assignAction.agentId)) {
        const currentAgent = await prisma.technician.findFirst({
          where: { freshserviceId: BigInt(fsTicket.responder_id) },
          select: { name: true },
        });
        return {
          code: 'superseded_assignee',
          reason: `Ticket is already assigned to ${currentAgent?.name || `agent #${fsTicket.responder_id}`}`,
          details: { currentResponderId: fsTicket.responder_id, currentAgentName: currentAgent?.name },
        };
      }

      // Check 2: ticket is in a group — check if target agent belongs to it
      if (fsTicket.group_id) {
        const group = await client.getGroup(fsTicket.group_id);
        // FreshService returns group members under `members` (not `agent_ids`
        // as Freshdesk does — this check was silently always-true before
        // v1.9.75 because agent_ids is never populated on /groups responses).
        // Fall back to agent_ids for defensiveness in case a future API
        // version or a different FS tier returns the older shape.
        const memberIds = Array.isArray(group?.members)
          ? group.members
          : Array.isArray(group?.agent_ids) ? group.agent_ids : null;
        if (group && memberIds && !memberIds.includes(Number(assignAction.agentId))) {
          return {
            code: 'incompatible_group',
            reason: `Target agent is not a member of group "${group.name || fsTicket.group_id}"`,
            details: { groupId: fsTicket.group_id, groupName: group.name },
          };
        }
      }

      // Check 3: agent previously rejected this ticket
      if (run.ticket?.id) {
        const rejection = await prisma.ticketAssignmentEpisode.findFirst({
          where: {
            ticketId: run.ticket.id,
            endMethod: 'rejected',
            technician: { freshserviceId: BigInt(assignAction.agentId) },
          },
          select: { endedAt: true, technician: { select: { name: true } } },
        });
        if (rejection) {
          return {
            code: 'already_rejected_by_this_agent',
            reason: `${rejection.technician.name} previously rejected this ticket at ${rejection.endedAt?.toISOString()}`,
            details: { rejectedAt: rejection.endedAt, agentName: rejection.technician.name },
          };
        }
      }

      return null;
    } catch (error) {
      logger.warn('Preflight check failed (proceeding with sync)', { runId: run.id, error: error.message });
      return null;
    }
  }
}

export default new FreshServiceActionService();
