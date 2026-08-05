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
import { PRIORITY_ID_TO_LABEL } from './priorityAssessment.js';
import { normalizeTicketType } from './ticketTypeAssessment.js';
import ticketTypeService from './ticketTypeService.js';
import statusService from './statusService.js';
import notificationPreferenceService from './notificationPreferenceService.js';
import ticketLifecycleNotificationService from './ticketLifecycleNotificationService.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';

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

/**
 * Resolve Ticket Pulse skill/subskill NAMES to the FreshService custom-object
 * record display ids that the lookup custom fields expect. Sending the name
 * instead of the id makes FreshService store null ("none"). Lenient — returns
 * null ids it can't resolve (never throws), so callers can decide to skip.
 * Shared by the assignment writeback and the ticket mirror.
 */
export async function resolveTpSkillLookupIds(client, { skill, subskill, workspaceId }) {
  if (!skill) return { categoryDisplayId: null, subcategoryDisplayId: null };
  const objects = await client.listCustomObjects({ workspace_id: workspaceId });
  const byTitle = new Map((objects || []).map((o) => [o.title, o]));
  const categoryObject = byTitle.get(TP_SKILL_OBJECT_TITLE);
  const subcategoryObject = byTitle.get(TP_SUBSKILL_OBJECT_TITLE);
  if (!categoryObject) return { categoryDisplayId: null, subcategoryDisplayId: null };
  const [categoryRecords, subcategoryRecords] = await Promise.all([
    client.listCustomObjectRecords(categoryObject.id),
    subcategoryObject ? client.listCustomObjectRecords(subcategoryObject.id) : Promise.resolve([]),
  ]);
  const catByName = new Map((categoryRecords || []).map((r) => [keyFor(recordName(r)), recordDisplayId(r)]));
  const subByName = new Map((subcategoryRecords || []).map((r) => [keyFor(recordName(r)), recordDisplayId(r)]));
  return {
    categoryDisplayId: catByName.get(keyFor(skill)) ?? null,
    subcategoryDisplayId: subskill ? (subByName.get(keyFor(subskill)) ?? null) : null,
  };
}

function buildActionPreview(actions) {
  return actions.map((a) => {
    if (a.type === 'assign') return `Assign ticket #${a.ticketId} to agent ${a.agentId}`;
    if (a.type === 'update_group') return `Move ticket #${a.ticketId} to group "${a.groupName || a.groupId}"`;
    if (a.type === 'update_custom_fields') return `Update Ticket Pulse category fields on ticket #${a.ticketId}`;
    if (a.type === 'update_priority') return `Update ticket #${a.ticketId} priority to ${a.priorityLabel || `P${a.priorityId}`}`;
    if (a.type === 'update_ticket_type') return `Update ticket #${a.ticketId} type to ${a.ticketType}`;
    if (a.type === 'close') return `Close ticket #${a.ticketId}`;
    if (a.type === 'note') return `Add private note to ticket #${a.ticketId}`;
    return `${a.type} on ticket #${a.ticketId}`;
  }).join(' → ');
}

function buildSyncPayload(actions, preview, dryRun, extras = {}) {
  return { actions, preview, dryRun, timestamp: new Date().toISOString(), ...extras };
}

async function isPriorityWritebackEnabled(workspaceId) {
  const config = await prisma.assignmentConfig.findUnique({
    where: { workspaceId: Number(workspaceId) },
    select: { priorityWritebackEnabled: true },
  });
  return config?.priorityWritebackEnabled !== false;
}

function freshServiceErrorMessage(errorOrDetail) {
  const detail = errorOrDetail?.body || errorOrDetail?.freshserviceDetail || errorOrDetail?.response?.data || errorOrDetail;
  return detail?.description || detail?.message || errorOrDetail?.message || '';
}

function isFreshServiceReadOnlyError(error) {
  const detail = extractFreshServiceError(error);
  const status = detail?.status || error?.response?.status || error?.freshserviceStatus || null;
  const message = freshServiceErrorMessage(detail || error);
  return Number(status) === 405 && /PUT method is not allowed/i.test(message) && /method\(s\): GET/i.test(message);
}

function readOnlyTicketSyncMessage() {
  return 'FreshService marked this ticket read-only, spam, deleted, or otherwise GET-only before Ticket Pulse could write back. No further action needed.';
}

async function findTicketForNotificationMirror(ticketId, context) {
  try {
    return await prisma.ticket.findUnique({ where: { id: ticketId } });
  } catch (error) {
    logger.warn('FreshService sync: failed to load ticket for workflow notification mirror', {
      ticketId,
      ...context,
      error: error.message,
    });
    return null;
  }
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
        status: true,
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
          select: { freshserviceId: true, name: true, email: true },
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
        techEmail: tech.email,
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
      // Don't re-close a ticket an agent already resolved/closed — the close
      // action carries status 4 (Resolved) and used to DOWNGRADE an agent's
      // Closed to Resolved (QA 07-27 #5). Note still lands; status stays put.
      // Base-aware (Phase 8b): custom terminal-base statuses count as closed.
      const noiseCloseBase = ticket?.status
        ? await statusService.baseStatusOf(run.workspaceId, ticket.status)
        : null;
      if (!['Resolved', 'Closed'].includes(noiseCloseBase)) {
        actions.push({ type: 'close', ticketId: fsTicketId, status: 4 });
      }
    } else {
      return { actions: [], preview: `No FreshService action for decision: ${decision}`, error: null };
    }

    return { actions, preview: buildActionPreview(actions), error: null };
  }

  async buildPriorityWritebackAction(run) {
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: {
        freshserviceTicketId: true,
        assessedPriority: true,
        assessedPriorityId: true,
      },
    });

    const fsTicketId = Number(ticket?.freshserviceTicketId);
    if (!fsTicketId) {
      return { actions: [], preview: 'Cannot sync priority: ticket has no FreshService ID', error: 'missing_fs_ticket_id' };
    }

    const priorityId = Number(ticket?.assessedPriorityId);
    const priorityLabel = ticket?.assessedPriority || PRIORITY_ID_TO_LABEL[priorityId];
    if (!Number.isInteger(priorityId) || priorityId < 1 || priorityId > 4 || !priorityLabel) {
      return { actions: [], preview: 'Cannot sync priority: ticket has no assessed priority', error: 'missing_assessed_priority' };
    }

    const actions = [{
      type: 'update_priority',
      ticketId: fsTicketId,
      priorityId,
      priorityLabel,
      localFields: {
        priority: priorityId,
      },
    }];

    return { actions, preview: buildActionPreview(actions), error: null };
  }

  async buildTicketTypeWritebackAction(run) {
    const workspaceId = run.workspaceId;
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: {
        freshserviceTicketId: true,
        ticketType: true,
        assessedTicketType: true,
      },
    });

    const fsTicketId = Number(ticket?.freshserviceTicketId);
    if (!fsTicketId) {
      return { actions: [], preview: 'Cannot sync ticket type: ticket has no FreshService ID', error: 'missing_fs_ticket_id' };
    }

    let ticketType;
    try {
      ticketType = await normalizeTicketType(ticket?.assessedTicketType || run.recommendation?.ticketType, workspaceId);
    } catch (error) {
      return { actions: [], preview: 'Cannot sync ticket type: ticket has no assessed type recognized by this workspace', error: 'missing_assessed_ticket_type' };
    }

    // Only registry types with an FS mapping are ever written to FreshService.
    // TP-native-only types (fsTypeValue null) stay TP-side by design.
    const definition = await ticketTypeService.resolveType(workspaceId, ticketType);
    if (!definition?.fsTypeValue) {
      return {
        actions: [],
        preview: `Type "${ticketType}" is Ticket Pulse–native (no FreshService mapping) — nothing to write back`,
        error: null,
        skippedReason: 'not_mapped_to_freshservice',
      };
    }

    if (ticket?.ticketType) {
      try {
        if (await normalizeTicketType(ticket.ticketType, workspaceId) === ticketType) {
          return {
            actions: [],
            preview: `Ticket #${fsTicketId} already has type ${ticketType}`,
            error: null,
            skippedReason: 'ticket_type_already_current',
          };
        }
      } catch {
        // Keep going if the local mirror has an unexpected legacy value.
      }
    }

    const actions = [{
      type: 'update_ticket_type',
      ticketId: fsTicketId,
      // FS receives the mapped choice value; TP keeps the canonical name.
      ticketType: definition.fsTypeValue,
      localFields: {
        ticketType,
      },
    }];

    return { actions, preview: buildActionPreview(actions), error: null };
  }

  async executePriorityWriteback(runId, workspaceId, dryRun = false) {
    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: runId },
      include: {
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            assessedPriority: true,
            assessedPriorityId: true,
            priorityRationale: true,
          },
        },
      },
    });

    if (!run) {
      logger.warn('FreshService priority sync: run not found', { runId });
      return { success: false, error: 'Run not found' };
    }

    if (!(await isPriorityWritebackEnabled(workspaceId))) {
      const preview = 'FreshService priority writeback is disabled for this workspace';
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          priorityWritebackStatus: 'skipped',
          priorityWritebackError: 'priority_writeback_disabled',
          priorityWritebackPayload: buildSyncPayload([], preview, dryRun, {
            kind: 'priority_writeback',
            skippedReason: 'priority_writeback_disabled',
          }),
        },
      });
      logger.info('FreshService priority sync skipped by workspace setting', { runId, workspaceId });
      return { success: true, skipped: true, error: 'priority_writeback_disabled', preview, actions: [] };
    }

    const actionPlan = await this.buildPriorityWritebackAction(run);
    const { actions, preview } = actionPlan;
    const payloadData = buildSyncPayload(actions, preview, dryRun, { kind: 'priority_writeback' });

    if (actionPlan.error) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          priorityWritebackStatus: 'skipped',
          priorityWritebackError: actionPlan.error,
          priorityWritebackPayload: payloadData,
        },
      });
      return { success: false, skipped: true, error: actionPlan.error, preview };
    }

    if (dryRun) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          priorityWritebackStatus: 'dry_run',
          priorityWritebackError: null,
          priorityWritebackPayload: payloadData,
        },
      });
      logger.info('FreshService priority sync dry-run', { runId, preview });
      return { success: true, dryRun: true, preview, actions };
    }

    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        throw new Error('FreshService not configured for this workspace');
      }

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source: 'freshservice-priority-writeback',
      });

      const action = actions[0];
      await client.updateTicketPriority(action.ticketId, action.priorityId);
      await prisma.ticket.update({
        where: { id: run.ticketId },
        data: {
          priority: action.priorityId,
          updatedAt: new Date(),
        },
      }).catch((updateError) => {
        logger.warn('FreshService priority sync: priority updated but local mirror update failed', {
          ticketId: run.ticketId,
          freshserviceTicketId: action.ticketId,
          runId,
          error: updateError.message,
        });
      });

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          priorityWritebackStatus: 'synced',
          priorityWritebackError: null,
          priorityWritebackPayload: payloadData,
          priorityWrittenAt: new Date(),
        },
      });

      logger.info('FreshService priority sync completed', { runId, preview });
      return { success: true, preview, actions };
    } catch (err) {
      const freshserviceError = extractFreshServiceError(err);
      if (isFreshServiceReadOnlyError(err)) {
        const skippedReason = readOnlyTicketSyncMessage();
        await prisma.assignmentPipelineRun.update({
          where: { id: runId },
          data: {
            priorityWritebackStatus: 'skipped',
            priorityWritebackError: skippedReason,
            priorityWritebackPayload: { ...payloadData, freshserviceError, skippedReason },
          },
        });
        logger.info('FreshService priority sync skipped for read-only ticket', { runId, preview, freshserviceError });
        return { success: true, skipped: true, error: skippedReason, preview, freshserviceError };
      }
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          priorityWritebackStatus: 'failed',
          priorityWritebackError: err.message,
          priorityWritebackPayload: { ...payloadData, freshserviceError },
        },
      });
      logger.error('FreshService priority sync failed', { runId, error: err.message, freshserviceError });
      return { success: false, error: err.message, preview, freshserviceError };
    }
  }

  async executeTicketTypeWriteback(runId, workspaceId, dryRun = false) {
    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: runId },
      include: {
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            ticketType: true,
            assessedTicketType: true,
            ticketTypeRationale: true,
          },
        },
      },
    });

    if (!run) {
      logger.warn('FreshService ticket type sync: run not found', { runId });
      return { success: false, error: 'Run not found' };
    }

    // Per-workspace gate (Settings → AI & Routing). Replaced the old
    // SKILL_HIERARCHY_WORKSPACE_IDS env gate — migration seeded ws1 true.
    const assignmentConfig = await prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: { typeWritebackEnabled: true },
    });
    if (!assignmentConfig?.typeWritebackEnabled) {
      const preview = 'FreshService ticket type write-back is disabled for this workspace (Settings → AI & Routing)';
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          ticketTypeWritebackStatus: 'skipped',
          ticketTypeWritebackError: 'ticket_type_writeback_not_enabled_for_workspace',
          ticketTypeWritebackPayload: buildSyncPayload([], preview, dryRun, {
            kind: 'ticket_type_writeback',
            skippedReason: 'ticket_type_writeback_not_enabled_for_workspace',
          }),
        },
      });
      logger.info('FreshService ticket type sync skipped by workspace setting', { runId, workspaceId });
      return { success: true, skipped: true, error: 'ticket_type_writeback_not_enabled_for_workspace', preview, actions: [] };
    }

    const actionPlan = await this.buildTicketTypeWritebackAction(run);
    const { actions, preview } = actionPlan;
    const payloadData = buildSyncPayload(actions, preview, dryRun, { kind: 'ticket_type_writeback' });

    if (actionPlan.error || actionPlan.skippedReason) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          ticketTypeWritebackStatus: 'skipped',
          ticketTypeWritebackError: actionPlan.error || actionPlan.skippedReason,
          ticketTypeWritebackPayload: actionPlan.skippedReason
            ? { ...payloadData, skippedReason: actionPlan.skippedReason }
            : payloadData,
        },
      });
      return {
        success: !actionPlan.error,
        skipped: true,
        error: actionPlan.error || actionPlan.skippedReason,
        preview,
        actions,
      };
    }

    if (dryRun) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          ticketTypeWritebackStatus: 'dry_run',
          ticketTypeWritebackError: null,
          ticketTypeWritebackPayload: payloadData,
        },
      });
      logger.info('FreshService ticket type sync dry-run', { runId, preview });
      return { success: true, dryRun: true, preview, actions };
    }

    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        throw new Error('FreshService not configured for this workspace');
      }

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source: 'freshservice-ticket-type-writeback',
      });

      const action = actions[0];
      await client.updateTicketType(action.ticketId, action.ticketType);
      await prisma.ticket.update({
        where: { id: run.ticketId },
        data: {
          ticketType: action.ticketType,
          updatedAt: new Date(),
        },
      }).catch((updateError) => {
        logger.warn('FreshService ticket type sync: type updated but local mirror update failed', {
          ticketId: run.ticketId,
          freshserviceTicketId: action.ticketId,
          runId,
          error: updateError.message,
        });
      });

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          ticketTypeWritebackStatus: 'synced',
          ticketTypeWritebackError: null,
          ticketTypeWritebackPayload: payloadData,
          ticketTypeWrittenAt: new Date(),
        },
      });

      logger.info('FreshService ticket type sync completed', { runId, preview });
      return { success: true, preview, actions };
    } catch (err) {
      const freshserviceError = extractFreshServiceError(err);
      if (isFreshServiceReadOnlyError(err)) {
        const skippedReason = readOnlyTicketSyncMessage();
        await prisma.assignmentPipelineRun.update({
          where: { id: runId },
          data: {
            ticketTypeWritebackStatus: 'skipped',
            ticketTypeWritebackError: skippedReason,
            ticketTypeWritebackPayload: { ...payloadData, freshserviceError, skippedReason },
          },
        });
        logger.info('FreshService ticket type sync skipped for read-only ticket', { runId, preview, freshserviceError });
        return { success: true, skipped: true, error: skippedReason, preview, freshserviceError };
      }
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          ticketTypeWritebackStatus: 'failed',
          ticketTypeWritebackError: err.message,
          ticketTypeWritebackPayload: { ...payloadData, freshserviceError },
        },
      });
      logger.error('FreshService ticket type sync failed', { runId, error: err.message, freshserviceError });
      return { success: false, error: err.message, preview, freshserviceError };
    }
  }

  /**
   * Category-only FS write-back (autoCategorizeEnabled): applies the AI's
   * category custom fields on runs whose ASSIGNMENT stayed human-gated
   * (pending_review) or that were priority-only (after-hours escalation runs
   * classify anyway). Sources the category from the ticket row, which
   * _persistInternalClassification already populated — so observe-only
   * groups naturally short-circuit here with 'no_category'.
   */
  async executeCategoryWriteback(runId, workspaceId, dryRun = false) {
    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: runId },
      include: {
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            origin: true,
            tpSkill: true,
            tpSubskill: true,
            internalCategory: { select: { name: true } },
            internalSubcategory: { select: { name: true } },
          },
        },
      },
    });

    if (!run) {
      logger.warn('FreshService category sync: run not found', { runId });
      return { success: false, error: 'Run not found' };
    }

    const skip = async (reason, preview) => {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          categoryWritebackStatus: 'skipped',
          categoryWritebackError: reason,
          categoryWritebackPayload: buildSyncPayload([], preview, dryRun, {
            kind: 'category_writeback', skippedReason: reason,
          }),
        },
      });
      return { success: true, skipped: true, error: reason, preview, actions: [] };
    };

    if (!isSkillHierarchyWorkspace(workspaceId)) {
      return skip('category_writeback_not_enabled_for_workspace', 'Category write-back requires the hierarchical category system for this workspace');
    }
    const ticket = run.ticket;
    const fsTicketId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
    if (!fsTicketId) {
      return skip('missing_fs_ticket_id', 'Ticket has no FreshService ID — nothing to write back');
    }
    const skillName = ticket?.internalCategory?.name || null;
    const subskillName = ticket?.internalSubcategory?.name || null;
    if (!skillName) {
      return skip('no_category', 'Run produced no persisted category (observe-only group or classification missing)');
    }
    if (skillName === ticket.tpSkill && (subskillName || null) === (ticket.tpSubskill || null)) {
      return skip('already_current', `FreshService already carries "${skillName}${subskillName ? ` > ${subskillName}` : ''}"`);
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { tpSkillCustomField: true, tpSubskillCustomField: true },
    });
    const action = {
      type: 'update_custom_fields',
      ticketId: fsTicketId,
      customFields: {
        [workspace?.tpSkillCustomField || 'lf_ticket_pulse_category']: skillName,
        [workspace?.tpSubskillCustomField || 'lf_ticket_pulse_subcategory']: subskillName || null,
      },
      localFields: { tpSkill: skillName, tpSubskill: subskillName || null },
    };
    const preview = `Set Ticket Pulse category on #${fsTicketId} to "${skillName}${subskillName ? ` > ${subskillName}` : ''}"`;
    const payloadData = buildSyncPayload([action], preview, dryRun, { kind: 'category_writeback' });

    if (dryRun) {
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { categoryWritebackStatus: 'dry_run', categoryWritebackError: null, categoryWritebackPayload: payloadData },
      });
      logger.info('FreshService category sync dry-run', { runId, preview });
      return { success: true, dryRun: true, preview, actions: [action] };
    }

    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        throw new Error('FreshService not configured for this workspace');
      }
      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source: 'freshservice-category-writeback',
      });

      const customFields = await this._resolveTicketPulseLookupFields(client, action, fsConfig);
      action.sentCustomFields = customFields;
      const result = await client.updateTicketCustomFields(fsTicketId, customFields);
      if (result?.alreadyClosed) {
        return skip('ticket_closed_in_freshservice', `Ticket #${fsTicketId} is closed in FreshService — category not written`);
      }
      await prisma.ticket.update({
        where: { id: run.ticketId },
        data: action.localFields,
      }).catch((updateError) => {
        logger.warn('FreshService category sync: FS updated but local mirror failed', {
          ticketId: run.ticketId, freshserviceTicketId: fsTicketId, runId, error: updateError.message,
        });
      });

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          categoryWritebackStatus: 'synced',
          categoryWritebackError: null,
          categoryWritebackPayload: payloadData,
          categoryWrittenAt: new Date(),
        },
      });
      logger.info('FreshService category sync completed', { runId, preview });
      return { success: true, preview, actions: [action] };
    } catch (err) {
      const freshserviceError = extractFreshServiceError(err);
      if (isFreshServiceReadOnlyError(err)) {
        const skippedReason = readOnlyTicketSyncMessage();
        await prisma.assignmentPipelineRun.update({
          where: { id: runId },
          data: {
            categoryWritebackStatus: 'skipped',
            categoryWritebackError: skippedReason,
            categoryWritebackPayload: { ...payloadData, freshserviceError, skippedReason },
          },
        });
        logger.info('FreshService category sync skipped for read-only ticket', { runId, preview, freshserviceError });
        return { success: true, skipped: true, error: skippedReason, preview, freshserviceError };
      }
      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          categoryWritebackStatus: 'failed',
          categoryWritebackError: err.message,
          categoryWritebackPayload: { ...payloadData, freshserviceError },
        },
      });
      logger.error('FreshService category sync failed', { runId, error: err.message, freshserviceError });
      return { success: false, error: err.message, preview, freshserviceError };
    }
  }

  async executeDirectPriorityWriteback({
    workspaceId,
    ticketId,
    priorityId,
    priorityLabel = null,
    source = 'freshservice-priority-writeback',
    dryRun = false,
  } = {}) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: {
        id: true,
        freshserviceTicketId: true,
      },
    });

    const fsTicketId = Number(ticket?.freshserviceTicketId);
    if (!ticket || !fsTicketId) {
      return { success: false, skipped: true, error: 'missing_fs_ticket_id' };
    }

    if (!(await isPriorityWritebackEnabled(workspaceId))) {
      return {
        success: true,
        skipped: true,
        error: 'priority_writeback_disabled',
        preview: 'FreshService priority writeback is disabled for this workspace',
        actions: [],
      };
    }

    const parsedPriorityId = Number(priorityId);
    const label = priorityLabel || PRIORITY_ID_TO_LABEL[parsedPriorityId] || `P${parsedPriorityId}`;
    const actions = [{
      type: 'update_priority',
      ticketId: fsTicketId,
      priorityId: parsedPriorityId,
      priorityLabel: label,
      localFields: {
        priority: parsedPriorityId,
      },
    }];
    const preview = buildActionPreview(actions);

    if (!Number.isInteger(parsedPriorityId) || parsedPriorityId < 1 || parsedPriorityId > 4) {
      return { success: false, skipped: true, error: 'invalid_priority', preview, actions };
    }

    if (dryRun) {
      return { success: true, dryRun: true, preview, actions };
    }

    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        throw new Error('FreshService not configured for this workspace');
      }

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source,
      });

      await client.updateTicketPriority(fsTicketId, parsedPriorityId);
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          priority: parsedPriorityId,
          updatedAt: new Date(),
        },
      }).catch((updateError) => {
        logger.warn('FreshService direct priority sync: priority updated but local mirror update failed', {
          ticketId: ticket.id,
          freshserviceTicketId: fsTicketId,
          source,
          error: updateError.message,
        });
      });

      logger.info('FreshService direct priority sync completed', {
        ticketId: ticket.id,
        freshserviceTicketId: fsTicketId,
        priorityId: parsedPriorityId,
        source,
      });
      return { success: true, preview, actions };
    } catch (err) {
      const freshserviceError = extractFreshServiceError(err);
      if (isFreshServiceReadOnlyError(err)) {
        const skippedReason = readOnlyTicketSyncMessage();
        logger.info('FreshService direct priority sync skipped for read-only ticket', {
          ticketId: ticket.id,
          preview,
          source,
          freshserviceError,
        });
        return { success: true, skipped: true, error: skippedReason, preview, freshserviceError };
      }
      logger.error('FreshService direct priority sync failed', {
        ticketId: ticket.id,
        source,
        error: err.message,
        freshserviceError,
      });
      return { success: false, error: err.message, preview, freshserviceError };
    }
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
            origin: true,
            nativeNumber: true,
            workspaceId: true,
            status: true,
            assignedTechId: true,
            isNoise: true,
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

    // TP-born tickets never talk to FreshService from the pipeline — Ticket
    // Pulse is their source of truth; the fallback mirror pushes copies on its
    // own channel. Apply the decision locally with full parity instead.
    if (run.ticket?.origin === TICKET_ORIGIN.TICKETPULSE) {
      return this._executeLocalOnly(run, workspaceId, dryRun, options);
    }

    if (run.decision === 'noise_dismissed' && !force) {
      const assignmentConfig = await prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: { autoCloseNoise: true },
      });

      if (!assignmentConfig?.autoCloseNoise) {
        const preview = 'Skipped: noise auto-close is disabled for this workspace';
        await prisma.assignmentPipelineRun.update({
          where: { id: runId },
          data: {
            syncStatus: 'skipped',
            syncError: 'Noise auto-close disabled for workspace',
            syncPayload: buildSyncPayload([], preview, dryRun, { autoCloseNoise: false }),
          },
        });
        logger.info('FreshService sync skipped: noise auto-close disabled', { runId, workspaceId });
        return { success: true, skipped: true, preview, reason: 'noise_auto_close_disabled' };
      }
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
              if (shouldDowngrade && preflightResult.code === 'superseded_assignee') {
                const completedActions = await this._executeSafeActionsBeforeAssignment(client, run, actions, assignAction, fsConfig);
                const handledMessage = `Handled in FreshService: ${preflightResult.reason}. Ticket Pulse left assignment untouched.`;
                await prisma.assignmentPipelineRun.update({
                  where: { id: runId },
                  data: {
                    decision: 'pending_review',
                    assignedTechId: null,
                    decidedAt: null,
                    syncStatus: 'skipped',
                    syncError: handledMessage,
                    syncPayload: { ...payloadData, preflightAbort: preflightResult, completedActions },
                    errorMessage: `${handledMessage} Priority and category writeback were preserved when available.`,
                  },
                });
                // Heal the ticket row immediately — the preflight just learned
                // FS's real assignee, and waiting for the next full sync cycle
                // left the queue showing a stale "Suggested" chip while FS had
                // a real assignee for an hour (QA 07-09, #232260).
                try {
                  const responderId = preflightResult.details?.currentResponderId;
                  let ticketRowId = run.ticket?.id || null;
                  if (!ticketRowId && assignAction.ticketId) {
                    const row = await prisma.ticket.findFirst({
                      where: { freshserviceTicketId: BigInt(assignAction.ticketId), workspaceId: run.workspaceId },
                      select: { id: true },
                    });
                    ticketRowId = row?.id || null;
                  }
                  if (responderId && ticketRowId) {
                    const tech = await prisma.technician.findFirst({
                      where: { freshserviceId: BigInt(responderId), workspaceId: run.workspaceId },
                      select: { id: true, name: true },
                    });
                    if (tech) {
                      await prisma.ticket.update({ where: { id: ticketRowId }, data: { assignedTechId: tech.id } });
                      logger.info(`Preflight healed stale assignee: ticket ${ticketRowId} → ${tech.name}`, { runId });
                    }
                  }
                } catch (healError) {
                  logger.warn(`Preflight assignee heal failed (non-fatal): ${healError.message}`, { runId });
                }
                logger.info('FreshService sync handled externally by existing assignee', {
                  runId,
                  completedActions: completedActions.map((action) => action.type),
                  ...preflightResult,
                });
                return {
                  success: true,
                  skipped: true,
                  handledInFreshService: true,
                  preflightAbort: preflightResult,
                  preview,
                  completedActions,
                };
              }
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
      const optionalActionFailures = [];

      for (const action of actions) {
        if (ticketGone) {
          logger.info(`FreshService: skipping ${action.type} — ticket already deleted/terminal`, { ticketId: action.ticketId, runId });
          continue;
        }

        if (action.type === 'assign') {
          const result = await client.assignTicket(action.ticketId, action.agentId);
          if (result?.alreadyClosed) { ticketGone = true; continue; }
          const existingTicket = await findTicketForNotificationMirror(run.ticketId, {
            freshserviceTicketId: action.ticketId,
            runId,
          });
          await this._mirrorLocalAssignment(run, action);
          const upsertedTicket = await findTicketForNotificationMirror(run.ticketId, {
            freshserviceTicketId: action.ticketId,
            runId,
          });
          if (upsertedTicket) {
            await ticketLifecycleNotificationService.emitTicketLifecycleNotifications({
              existingTicket,
              upsertedTicket,
              source: 'assignment_pipeline',
              allowNotificationWorkflows: true,
            }).catch((notificationError) => {
              logger.warn('FreshService sync: assignment succeeded but workflow notification dispatch failed', {
                ticketId: run.ticketId,
                freshserviceTicketId: action.ticketId,
                runId,
                error: notificationError.message,
              });
            });
          }
          await notificationPreferenceService.queueNotificationsForAssignment(run, action).catch((notificationError) => {
            logger.warn('FreshService sync: assignment succeeded but notification queueing failed', {
              ticketId: run.ticketId,
              freshserviceTicketId: action.ticketId,
              runId,
              error: notificationError.message,
            });
          });
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
          try {
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
          } catch (customFieldError) {
            if (run.decision !== 'noise_dismissed') {
              throw customFieldError;
            }

            const optionalFailure = {
              type: action.type,
              ticketId: action.ticketId,
              error: customFieldError.message,
              freshserviceError: extractFreshServiceError(customFieldError),
            };
            optionalActionFailures.push(optionalFailure);
            action.optionalFailure = optionalFailure;
            payloadData = buildSyncPayload(actions, preview, dryRun, { optionalActionFailures });
            logger.warn('FreshService sync: optional noise category write failed; continuing to close ticket', {
              ticketId: action.ticketId,
              runId,
              error: customFieldError.message,
              freshserviceError: optionalFailure.freshserviceError,
            });
          }
        } else if (action.type === 'close') {
          const result = await client.closeTicket(action.ticketId, action.status);
          if (result?.alreadyClosed) { ticketGone = true; }
          const existingTicket = await findTicketForNotificationMirror(run.ticketId, {
            freshserviceTicketId: action.ticketId,
            runId,
          });
          // Never downgrade an agent's Closed to Resolved (QA 07-27 #5): the
          // close action always carries status 4, but if the ticket is already
          // Closed (locally or FS reported alreadyClosed) keep it Closed.
          const alreadyClosed = existingTicket?.status === 'Closed' || result?.alreadyClosed;
          await prisma.ticket.update({
            where: { id: run.ticketId },
            data: {
              status: alreadyClosed ? 'Closed' : mapClosedStatus(action.status),
              resolvedAt: existingTicket?.resolvedAt || new Date(),
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
          const upsertedTicket = await findTicketForNotificationMirror(run.ticketId, {
            freshserviceTicketId: action.ticketId,
            runId,
          });
          if (upsertedTicket) {
            await ticketLifecycleNotificationService.emitTicketLifecycleNotifications({
              existingTicket,
              upsertedTicket,
              source: 'assignment_pipeline',
              allowNotificationWorkflows: true,
            }).catch((notificationError) => {
              logger.warn('FreshService sync: close succeeded but workflow notification dispatch failed', {
                ticketId: run.ticketId,
                freshserviceTicketId: action.ticketId,
                runId,
                error: notificationError.message,
              });
            });
          }
          logger.info('FreshService: ticket closed', { ticketId: action.ticketId, runId });
        } else if (action.type === 'note') {
          const result = await client.addPrivateNote(action.ticketId, action.body);
          if (result?.skipped) { ticketGone = true; continue; }
          logger.info('FreshService: note added', { ticketId: action.ticketId, runId });
        }
      }

      const syncNotes = [];
      if (ticketGone) syncNotes.push('Ticket already deleted or closed in FreshService — no action needed');
      if (optionalActionFailures.length > 0) {
        syncNotes.push('Optional Ticket Pulse category write failed; continued with remaining FreshService actions');
      }
      const syncNote = syncNotes.length > 0 ? syncNotes.join(' ') : null;

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { syncStatus: 'synced', syncedAt: new Date(), syncPayload: payloadData, syncError: syncNote },
      });

      logger.info('FreshService sync completed', { runId, preview, ticketGone });
      return { success: true, preview, actions, ticketGone, syncNote };

    } catch (err) {
      const freshserviceError = extractFreshServiceError(err);
      if (isFreshServiceReadOnlyError(err)) {
        const skippedReason = readOnlyTicketSyncMessage();
        await prisma.assignmentPipelineRun.update({
          where: { id: runId },
          data: {
            syncStatus: 'skipped',
            syncError: skippedReason,
            syncPayload: { ...payloadData, freshserviceError, skippedReason },
          },
        });
        logger.info('FreshService sync skipped for read-only ticket', { runId, preview, freshserviceError });
        return { success: true, skipped: true, preview, freshserviceError, syncNote: skippedReason };
      }
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

  async _executeSafeActionsBeforeAssignment(client, run, actions, assignAction, fsConfig) {
    const assignIndex = actions.findIndex((action) => action === assignAction);
    const safeActions = assignIndex >= 0 ? actions.slice(0, assignIndex) : [];
    const completedActions = [];

    for (const action of safeActions) {
      if (action.type !== 'update_custom_fields') continue;
      const customFields = await this._resolveTicketPulseLookupFields(client, action, fsConfig);
      action.sentCustomFields = customFields;
      const result = await client.updateTicketCustomFields(action.ticketId, customFields);
      if (result?.alreadyClosed) break;
      await prisma.ticket.update({
        where: { id: run.ticketId },
        data: action.localFields,
      }).catch((updateError) => {
        logger.warn('FreshService sync: custom fields updated before external assignment handling, but local mirror failed', {
          ticketId: run.ticketId,
          freshserviceTicketId: action.ticketId,
          runId: run.id,
          error: updateError.message,
        });
      });
      completedActions.push(action);
      logger.info('FreshService: Ticket Pulse skill fields updated before external assignment handling', {
        ticketId: action.ticketId,
        runId: run.id,
      });
    }

    return completedActions;
  }

  /**
   * Pipeline execution for TP-born tickets: everything applies locally
   * (assignment + episode, category fields, noise resolution) and the row is
   * flagged mirrorState='pending' so the fallback mirror pushes the FS copy.
   */
  async _executeLocalOnly(run, workspaceId, dryRun = false, options = {}) {
    const force = options.force || false;
    const ticket = await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      include: {
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
      },
    });
    if (!ticket) return { success: false, error: 'Ticket not found' };

    const ref = ticketDisplayRef(ticket);
    const decision = run.decision;
    const actions = [];

    const skillName = ticket.internalCategory?.name || null;
    const subskillName = ticket.internalSubcategory?.name || null;
    if (skillName && (skillName !== ticket.tpSkill || (subskillName || null) !== (ticket.tpSubskill || null))) {
      actions.push({ type: 'local_category', ticketId: ticket.id, tpSkill: skillName, tpSubskill: subskillName || null });
    }

    let tech = null;
    if ((decision === 'approved' || decision === 'modified' || decision === 'auto_assigned') && run.assignedTechId) {
      tech = await prisma.technician.findUnique({
        where: { id: run.assignedTechId },
        select: { id: true, name: true },
      });
      if (!tech) {
        await prisma.assignmentPipelineRun.update({
          where: { id: run.id },
          data: { syncStatus: 'failed', syncError: 'Assigned technician not found', syncPayload: buildSyncPayload(actions, 'Local assignment failed', dryRun, { localOnly: true }) },
        });
        return { success: false, error: 'Assigned technician not found' };
      }
      if (ticket.assignedTechId && ticket.assignedTechId !== run.assignedTechId && !force) {
        const reason = 'Ticket already assigned locally to a different technician';
        await prisma.assignmentPipelineRun.update({
          where: { id: run.id },
          data: { syncStatus: 'skipped', syncError: reason, syncPayload: buildSyncPayload(actions, reason, dryRun, { localOnly: true }) },
        });
        return { success: false, skipped: true, error: reason };
      }
      actions.push({ type: 'local_assign', ticketId: ticket.id, techId: tech.id, techName: tech.name });
    }

    if (decision === 'noise_dismissed' && !ticket.assignedTechId
      && !['Resolved', 'Closed'].includes(await statusService.baseStatusOf(run.workspaceId, ticket.status))) {
      const assignmentConfig = await prisma.assignmentConfig.findUnique({
        where: { workspaceId: Number(run.workspaceId) },
        select: { autoCloseNoise: true },
      });
      if (assignmentConfig?.autoCloseNoise) {
        actions.push({ type: 'local_close', ticketId: ticket.id });
      }
    }

    const preview = actions.map((a) => {
      if (a.type === 'local_assign') return `Assign ${ref} to ${a.techName} (local — mirror queued)`;
      if (a.type === 'local_close') return `Resolve ${ref} as noise (local — mirror queued)`;
      return `Update Ticket Pulse category fields on ${ref} (local)`;
    }).join(' → ') || `No local actions needed for ${ref}`;
    const payloadData = buildSyncPayload(actions, preview, dryRun, { localOnly: true });

    if (dryRun) {
      await prisma.assignmentPipelineRun.update({
        where: { id: run.id },
        data: { syncStatus: 'dry_run', syncPayload: payloadData },
      });
      return { success: true, dryRun: true, actions, preview };
    }

    try {
      const now = new Date();
      for (const action of actions) {
        if (action.type === 'local_category') {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { tpSkill: action.tpSkill, tpSubskill: action.tpSubskill, mirrorState: 'pending' },
          });
        } else if (action.type === 'local_close') {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              status: 'Resolved',
              resolvedAt: now,
              resolutionTimeSeconds: Math.max(0, Math.round((now.getTime() - new Date(ticket.createdAt).getTime()) / 1000)),
              mirrorState: 'pending',
            },
          });
        } else if (action.type === 'local_assign') {
          if (ticket.assignedTechId && ticket.assignedTechId !== action.techId) {
            await prisma.ticketAssignmentEpisode.updateMany({
              where: { ticketId: ticket.id, technicianId: ticket.assignedTechId, endedAt: null },
              data: { endedAt: now, endMethod: 'reassigned', endActorName: 'Ticket Pulse AI' },
            });
          }
          const updated = await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              assignedTechId: action.techId,
              assignedAt: now,
              firstAssignedAt: ticket.firstAssignedAt || now,
              assignedBy: 'Ticket Pulse',
              isSelfPicked: false,
              mirrorState: 'pending',
            },
          });
          await prisma.ticketAssignmentEpisode.create({
            data: {
              ticketId: ticket.id,
              technicianId: action.techId,
              workspaceId: ticket.workspaceId,
              startedAt: now,
              startMethod: 'workflow_assigned',
              startAssignedByName: 'Ticket Pulse AI',
            },
          }).catch(() => { /* duplicate startedAt guard — harmless */ });
          await ticketLifecycleNotificationService.emitTicketLifecycleNotifications({
            existingTicket: ticket,
            upsertedTicket: updated,
            source: 'assignment_pipeline',
            allowNotificationWorkflows: true,
          }).catch((notificationError) => {
            logger.warn('Local assignment succeeded but workflow notification dispatch failed', {
              ticketId: ticket.id, runId: run.id, error: notificationError.message,
            });
          });
          await notificationPreferenceService.queueNotificationsForAssignment(run, action).catch((notificationError) => {
            logger.warn('Local assignment succeeded but notification queueing failed', {
              ticketId: ticket.id, runId: run.id, error: notificationError.message,
            });
          });
          logger.info('Native ticket assigned by pipeline (local-only)', { ticketRef: ref, techId: action.techId, runId: run.id });
        }
      }

      await prisma.assignmentPipelineRun.update({
        where: { id: run.id },
        data: { syncStatus: 'synced', syncedAt: new Date(), syncPayload: payloadData, syncError: null },
      });
      if (actions.length > 0) {
        const { default: mirrorService } = await import('./mirrorService.js');
        await mirrorService.enqueueFieldSync(ticket.workspaceId, ticket.id).catch(() => {});
      }
      return { success: true, actions, preview };
    } catch (err) {
      logger.error('Local-only pipeline execution failed', { runId: run.id, ticketId: ticket.id, error: err.message });
      await prisma.assignmentPipelineRun.update({
        where: { id: run.id },
        data: { syncStatus: 'failed', syncError: err.message, syncPayload: payloadData },
      }).catch(() => {});
      return { success: false, error: err.message };
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
