import { createFreshServiceClient } from '../integrations/freshservice.js';
import settingsRepository from './settingsRepository.js';
import prisma from './prisma.js';
import { shouldCloseNoiseDismissedRun } from './assignmentFlowGuards.js';
import {
  freshServiceGroupHasAgent,
  resolveBroadAssignmentGroup,
} from './freshServiceGroupGuard.js';
import { isSkillHierarchyWorkspace } from '../utils/workspaceFeatureFlags.js';
import logger from '../utils/logger.js';

const TP_SKILL_OBJECT_TITLE = 'Ticket Pulse Skills';
const TP_SUBSKILL_OBJECT_TITLE = 'Ticket Pulse Subskills';

function mapClosedStatus(status) {
  if (Number(status) === 5) return 'Closed';
  return 'Resolved';
}

function extractFreshServiceError(error) {
  const status = error.freshserviceStatus
    || error.response?.status
    || error.statusCode
    || error.originalError?.response?.status
    || null;
  const body = error.freshserviceDetail
    || error.response?.data
    || error.originalError?.response?.data
    || null;
  return status || body ? { status, body } : null;
}

function keyFor(value) {
  return String(value || '').trim().toLowerCase();
}

function recordName(record) {
  return String(record?.data?.name || record?.name || '').trim();
}

function recordDisplayId(record) {
  return record?.data?.bo_display_id ?? record?.bo_display_id ?? record?.id ?? null;
}

function buildActionPreview(actions) {
  return actions.map((a) => {
    if (a.type === 'assign') return `Assign ticket #${a.ticketId} to agent ${a.agentId}`;
    if (a.type === 'update_group') return `Move ticket #${a.ticketId} to group "${a.groupName || a.groupId}"`;
    if (a.type === 'update_custom_fields') return `Update Ticket Pulse category fields on ticket #${a.ticketId}`;
    if (a.type === 'close') return `Close ticket #${a.ticketId}`;
    if (a.type === 'note') return `Add private note to ticket #${a.ticketId}`;
    return `${a.type} on ticket #${a.ticketId}`;
  }).join(' → ');
}

function buildSyncPayload(actions, preview, dryRun, extras = {}) {
  return { actions, preview, dryRun, timestamp: new Date().toISOString(), ...extras };
}

class FreshServiceActionService {
  /**
   * Build the FreshService actions for a pipeline run decision.
   * Returns the exact payload that would be sent — used by both real and dry-run modes.
   */
  async buildAction(run) {
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: {
        freshserviceTicketId: true,
        subject: true,
        ticketCategory: true,
        tpSkill: true,
        tpSubskill: true,
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
      },
    });

    const fsTicketId = Number(ticket?.freshserviceTicketId);
    if (!fsTicketId) {
      return { actions: [], preview: 'Cannot sync: ticket has no FreshService ID', error: 'missing_fs_ticket_id' };
    }

    const decision = run.decision;
    const actions = [];
    const addTicketPulseCategoryAction = async () => {
      if (!isSkillHierarchyWorkspace(run.workspaceId)) {
        return;
      }

      const skillName = ticket?.internalCategory?.name || null;
      const subskillName = ticket?.internalSubcategory?.name || null;
      if (!skillName || (skillName === ticket.tpSkill && (subskillName || null) === (ticket.tpSubskill || null))) {
        return;
      }
      const workspace = await prisma.workspace.findUnique({
        where: { id: run.workspaceId },
        select: { tpSkillCustomField: true, tpSubskillCustomField: true },
      });
      actions.push({
        type: 'update_custom_fields',
        ticketId: fsTicketId,
        customFields: {
          [workspace?.tpSkillCustomField || 'lf_ticket_pulse_category']: skillName,
          [workspace?.tpSubskillCustomField || 'lf_ticket_pulse_subcategory']: subskillName || null,
        },
        localFields: {
          tpSkill: skillName,
          tpSubskill: subskillName || null,
        },
      });
    };

    if (decision === 'classified_only') {
      await addTicketPulseCategoryAction();
    } else if (decision === 'approved' || decision === 'modified' || decision === 'auto_assigned') {
      await addTicketPulseCategoryAction();

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
      actions.push({
        type: 'assign',
        ticketId: fsTicketId,
        agentId: fsAgentId,
        techId: run.assignedTechId,
        techName: tech.name,
      });

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

      if (isSkillHierarchyWorkspace(run.workspaceId)) {
        const workspace = await prisma.workspace.findUnique({
          where: { id: run.workspaceId },
          select: { tpSkillCustomField: true, tpSubskillCustomField: true },
        });
        const categoryField = workspace?.tpSkillCustomField || 'lf_ticket_pulse_category';
        const subcategoryField = workspace?.tpSubskillCustomField || 'lf_ticket_pulse_subcategory';

        actions.push({
          type: 'update_custom_fields',
          ticketId: fsTicketId,
          customFields: {
            [categoryField]: 'Service Desk & Routing',
            [subcategoryField]: 'Non-actionable Notifications',
          },
          localFields: {
            tpSkill: 'Service Desk & Routing',
            tpSubskill: 'Non-actionable Notifications',
          },
        });
      }
      actions.push({ type: 'note', ticketId: fsTicketId, body: noteBody, private: true });
      actions.push({ type: 'close', ticketId: fsTicketId, status: 4 });
    } else {
      return { actions: [], preview: `No FreshService action for decision: ${decision}`, error: null };
    }

    return { actions, preview: buildActionPreview(actions), error: null };
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
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            subject: true,
            firstAssignedAt: true,
            ticketCategory: true,
            tpSkill: true,
            tpSubskill: true,
            internalCategory: { select: { name: true } },
            internalSubcategory: { select: { name: true } },
          },
        },
      },
    });

    if (!run) {
      logger.warn('FreshService sync: run not found', { runId });
      return { success: false, error: 'Run not found' };
    }

    const actionPlan = await this.buildAction(run);
    let { actions, preview } = actionPlan;
    const buildError = actionPlan.error;

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
    let payloadData = buildSyncPayload(actions, preview, dryRun);

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
          const preflightResult = await this._preflightCheck(client, run, assignAction, fsConfig);
          if (preflightResult) {
            if (preflightResult.remediation?.type === 'update_group') {
              const assignIndex = actions.findIndex((action) => action === assignAction);
              actions = [
                ...actions.slice(0, assignIndex),
                preflightResult.remediation,
                ...actions.slice(assignIndex),
              ];
              preview = buildActionPreview(actions);
              payloadData = buildSyncPayload(actions, preview, dryRun, { preflightRemediation: preflightResult });
              logger.warn('FreshService sync will broaden ticket group before assignment', {
                runId,
                ticketId: assignAction.ticketId,
                fromGroupId: preflightResult.details?.groupId,
                fromGroupName: preflightResult.details?.groupName,
                toGroupId: preflightResult.remediation.groupId,
                toGroupName: preflightResult.remediation.groupName,
              });
            } else {
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
          await this._mirrorLocalAssignment(run, action);
          logger.info('FreshService: ticket assigned', { ticketId: action.ticketId, agentId: action.agentId, runId });
        } else if (action.type === 'update_group') {
          const result = await client.updateTicketGroup(action.ticketId, action.groupId);
          if (result?.alreadyClosed) { ticketGone = true; continue; }
          await prisma.ticket.update({
            where: { id: run.ticketId },
            data: {
              groupId: BigInt(action.groupId),
              updatedAt: new Date(),
            },
          }).catch((updateError) => {
            logger.warn('FreshService sync: group updated but local mirror update failed', {
              ticketId: run.ticketId,
              freshserviceTicketId: action.ticketId,
              runId,
              error: updateError.message,
            });
          });
          logger.info('FreshService: ticket group updated before assignment', {
            ticketId: action.ticketId,
            groupId: action.groupId,
            groupName: action.groupName,
            runId,
          });
        } else if (action.type === 'update_custom_fields') {
          const customFields = await this._resolveTicketPulseLookupFields(client, action, fsConfig);
          action.sentCustomFields = customFields;
          const result = await client.updateTicketCustomFields(action.ticketId, customFields);
          if (result?.alreadyClosed) { ticketGone = true; continue; }
          await prisma.ticket.update({
            where: { id: run.ticketId },
            data: action.localFields,
          }).catch((updateError) => {
            logger.warn('FreshService sync: custom fields updated but local mirror update failed', {
              ticketId: run.ticketId,
              freshserviceTicketId: action.ticketId,
              runId,
              error: updateError.message,
            });
          });
          logger.info('FreshService: Ticket Pulse skill fields updated', { ticketId: action.ticketId, runId });
        } else if (action.type === 'close') {
          const result = await client.closeTicket(action.ticketId, action.status);
          if (result?.alreadyClosed) { ticketGone = true; }
          await prisma.ticket.update({
            where: { id: run.ticketId },
            data: {
              status: mapClosedStatus(action.status),
              resolvedAt: new Date(),
              updatedAt: new Date(),
            },
          }).catch((updateError) => {
            logger.warn('FreshService sync: ticket closed but local status update failed', {
              ticketId: run.ticketId,
              freshserviceTicketId: action.ticketId,
              runId,
              error: updateError.message,
            });
          });
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
      const freshserviceError = extractFreshServiceError(err);
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

  async _mirrorLocalAssignment(run, action) {
    const assignedTechId = Number(action.techId || run.assignedTechId);
    if (!Number.isFinite(assignedTechId) || assignedTechId <= 0) return;

    const now = new Date();
    const serviceAccountNames = await settingsRepository.getServiceAccountNames().catch((error) => {
      logger.warn('FreshService sync: failed to load service account names for local assignment mirror', {
        runId: run.id,
        error: error.message,
      });
      return [];
    });
    const assignedBy = serviceAccountNames[0] || 'Ticket Pulse';

    await prisma.ticket.update({
      where: { id: run.ticketId },
      data: {
        assignedTechId,
        assignedAt: now,
        firstAssignedAt: run.ticket?.firstAssignedAt || now,
        assignedBy,
        isSelfPicked: false,
        updatedAt: now,
      },
    }).catch((updateError) => {
      logger.warn('FreshService sync: assignment succeeded but local ticket mirror update failed', {
        ticketId: run.ticketId,
        freshserviceTicketId: action.ticketId,
        assignedTechId,
        runId: run.id,
        error: updateError.message,
      });
    });
  }

  async _resolveTicketPulseLookupFields(client, action, fsConfig) {
    const categoryName = action.localFields?.tpSkill;
    const subcategoryName = action.localFields?.tpSubskill;
    const categoryField = fsConfig.tpSkillCustomField || 'lf_ticket_pulse_category';
    const subcategoryField = fsConfig.tpSubskillCustomField || 'lf_ticket_pulse_subcategory';

    if (!categoryName || (!action.customFields?.[categoryField] && !action.customFields?.[subcategoryField])) {
      return action.customFields;
    }

    const objects = await client.listCustomObjects({ workspace_id: fsConfig.workspaceId });
    const byTitle = new Map(objects.map((object) => [object.title, object]));
    const categoryObject = byTitle.get(TP_SKILL_OBJECT_TITLE);
    const subcategoryObject = byTitle.get(TP_SUBSKILL_OBJECT_TITLE);
    if (!categoryObject || !subcategoryObject) {
      return action.customFields;
    }

    const [categoryRecords, subcategoryRecords] = await Promise.all([
      client.listCustomObjectRecords(categoryObject.id),
      client.listCustomObjectRecords(subcategoryObject.id),
    ]);
    const categoriesByName = new Map(categoryRecords.map((record) => [keyFor(recordName(record)), recordDisplayId(record)]));
    const subcategoriesByName = new Map(subcategoryRecords.map((record) => [keyFor(recordName(record)), recordDisplayId(record)]));
    const categoryDisplayId = categoriesByName.get(keyFor(categoryName));
    const subcategoryDisplayId = subcategoryName ? subcategoriesByName.get(keyFor(subcategoryName)) : null;

    if (!categoryDisplayId) {
      throw new Error(`FreshService lookup record not found for Ticket Pulse category "${categoryName}"`);
    }
    if (subcategoryName && !subcategoryDisplayId) {
      throw new Error(`FreshService lookup record not found for Ticket Pulse subcategory "${subcategoryName}"`);
    }

    return {
      ...action.customFields,
      [categoryField]: categoryDisplayId,
      [subcategoryField]: subcategoryDisplayId,
    };
  }

  /**
   * Pre-validate that the assignment will succeed before making the API call.
   * Returns null if OK, or { code, reason, details } if should abort.
   */
  async _preflightCheck(client, run, assignAction, fsConfig = {}) {
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

      // Check 2: agent previously rejected this ticket
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

      // Check 3: ticket is in a group — check if target agent belongs to it
      if (fsTicket.group_id) {
        const group = await client.getGroup(fsTicket.group_id);
        if (group && !freshServiceGroupHasAgent(group, assignAction.agentId)) {
          const broadGroupResult = await resolveBroadAssignmentGroup(client, fsConfig, assignAction.agentId, fsTicket.group_id);
          const reason = `Target agent is not a member of group "${group.name || fsTicket.group_id}"`;
          const baseResult = {
            code: 'incompatible_group',
            reason,
            details: { groupId: fsTicket.group_id, groupName: group.name },
          };
          if (broadGroupResult.ok) {
            return {
              ...baseResult,
              remediation: {
                type: 'update_group',
                ticketId: assignAction.ticketId,
                groupId: broadGroupResult.group.id,
                groupName: broadGroupResult.group.name,
                previousGroupId: Number(fsTicket.group_id),
                previousGroupName: group.name || null,
              },
            };
          }
          return {
            ...baseResult,
            reason: `${reason}; ${broadGroupResult.reason}`,
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
