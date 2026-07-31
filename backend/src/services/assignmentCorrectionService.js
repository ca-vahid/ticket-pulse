import { createFreshServiceClient } from '../integrations/freshservice.js';
import { convertToTimezone } from '../utils/timezone.js';
import assignmentRepository from './assignmentRepository.js';
import settingsRepository from './settingsRepository.js';
import {
  freshServiceGroupHasAgent,
  resolveBroadAssignmentGroup,
} from './freshServiceGroupGuard.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const ASSIGNMENT_DECISIONS = new Set(['approved', 'modified', 'auto_assigned']);
const ACTIONABLE_FRESHSERVICE_STATUSES = new Set([2, 3]);
const LOCAL_TERMINAL_STATUSES = new Set(['closed', 'resolved', 'deleted', 'spam', '4', '5']);

export function normalizeCorrectionInput(input = {}) {
  const assignedTechId = Number(input.assignedTechId);
  const recommendationRank = input.recommendationRank === undefined || input.recommendationRank === null || input.recommendationRank === ''
    ? null
    : Number(input.recommendationRank);
  const selectionSource = String(input.selectionSource || 'manual').trim();
  const reason = String(input.reason || '').trim();

  return {
    assignedTechId,
    recommendationRank,
    selectionSource,
    reason,
  };
}

export function validateCorrectionInput(input = {}) {
  const normalized = normalizeCorrectionInput(input);
  const errors = [];

  if (!Number.isInteger(normalized.assignedTechId) || normalized.assignedTechId <= 0) {
    errors.push('assignedTechId must be a positive integer');
  }
  if (!['recommendation', 'manual'].includes(normalized.selectionSource)) {
    errors.push('selectionSource must be recommendation or manual');
  }
  if (normalized.selectionSource === 'recommendation' && (!Number.isInteger(normalized.recommendationRank) || normalized.recommendationRank <= 0)) {
    errors.push('recommendationRank is required when selectionSource is recommendation');
  }
  if (normalized.reason.length < 15) {
    errors.push('reason must be at least 15 characters');
  }

  return { valid: errors.length === 0, errors, normalized };
}

function getFreshServiceError(error) {
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

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function findRecommendationByRank(recommendations, rank) {
  if (!Number.isInteger(rank) || rank <= 0) return null;
  return Array.isArray(recommendations) ? recommendations[rank - 1] || null : null;
}

export function buildCorrectionFeedbackEntry({
  timestamp,
  ticket,
  fromTech,
  toTech,
  selectionSource,
  recommendationRank,
  reason,
}) {
  const ticketRef = `Ticket #${ticket?.freshserviceTicketId || 'unknown'} (${ticket?.subject || 'unknown'})`;
  const source = selectionSource === 'recommendation'
    ? `LLM recommendation #${recommendationRank}`
    : 'manual technician selection outside the LLM recommendation list';
  return `[${timestamp}] ${ticketRef}: Admin corrected assignment. Original: ${fromTech?.name || 'unassigned/unknown'}. Corrected: ${toTech?.name}. Source: ${source}. Reason: ${reason}`;
}

export function isCorrectableAssignmentRun(run) {
  if (!run || !ASSIGNMENT_DECISIONS.has(run.decision)) return false;
  if (run.status === 'completed') return true;
  return run.syncStatus === 'synced' && !!run.assignedTechId;
}

// Canned reason text per override reason code — used when the coordinator
// picks a chip without typing anything, so the LLM feedback stays readable.
export const OVERRIDE_REASON_CODES = {
  wrong_skill: 'Coordinator override: the AI pick did not match the required skill.',
  load_balancing: 'Coordinator override: rebalancing workload across the team.',
  availability: 'Coordinator override: the AI pick was not available to take this ticket.',
  other: 'Coordinator override: manual reassignment away from the AI pick.',
};

class AssignmentCorrectionService {
  /**
   * Correction feedback loop v1: a coordinator reassigned a ticket away from
   * an AI pick through the normal assign path and told us why (one-click
   * reason chip). Records an assignmentCorrection against the ticket's latest
   * correctable pipeline run and feeds a summary line to the assignment LLM
   * prompt. Deliberately does NOT touch FreshService — the reassignment
   * already happened. Returns null when there is nothing correctable.
   */
  async recordManualReassignReason(ticketId, workspaceId, { toTechnicianId, reasonCode, reason, actorEmail } = {}) {
    const code = String(reasonCode || '').trim();
    const toTechId = Number(toTechnicianId);
    if (!OVERRIDE_REASON_CODES[code] || !Number.isInteger(toTechId) || toTechId <= 0) return null;

    const recentRuns = await prisma.assignmentPipelineRun.findMany({
      where: { ticketId, workspaceId },
      orderBy: { id: 'desc' },
      take: 5,
      include: { ticket: { select: { freshserviceTicketId: true, subject: true } } },
    });
    const run = recentRuns.find(isCorrectableAssignmentRun) || null;
    // Reassigning to the run's own pick is not an override — nothing to learn.
    if (!run || run.assignedTechId === toTechId) return null;

    const techs = await prisma.technician.findMany({
      where: { id: { in: [run.assignedTechId, toTechId].filter(Boolean) } },
      select: { id: true, name: true },
    });
    const fromTech = techs.find((t) => t.id === run.assignedTechId) || null;
    const toTech = techs.find((t) => t.id === toTechId) || null;
    const reasonText = String(reason || '').trim() || OVERRIDE_REASON_CODES[code];

    const correction = await prisma.assignmentCorrection.create({
      data: {
        workspaceId,
        pipelineRunId: run.id,
        ticketId,
        fromTechnicianId: run.assignedTechId || null,
        toTechnicianId: toTechId,
        selectionSource: 'manual',
        reasonCode: code,
        reason: reasonText,
        createdByEmail: actorEmail || null,
        freshserviceSyncStatus: 'not_required',
      },
    });

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultTimezone: true },
    });
    const timestamp = convertToTimezone(new Date(), workspace?.defaultTimezone || 'America/Los_Angeles');
    const ticketRef = `Ticket #${run.ticket?.freshserviceTicketId || ticketId} (${run.ticket?.subject || 'unknown'})`;
    const feedbackEntry = `[${timestamp}] ${ticketRef}: Coordinator reassigned after an AI pick. Original: ${fromTech?.name || 'unassigned/unknown'}. Corrected: ${toTech?.name || `technician #${toTechId}`}. Reason code: ${code}. Reason: ${reasonText}`;
    await assignmentRepository.appendFeedback(workspaceId, feedbackEntry).catch((error) => {
      logger.warn('Failed to append manual reassign feedback', {
        correctionId: correction.id,
        error: error.message,
      });
    });

    return correction;
  }

  async reassignRun(runId, workspaceId, input, actorEmail) {
    const { valid, errors, normalized } = validateCorrectionInput(input);
    if (!valid) {
      return { success: false, status: 400, message: errors.join('; ') };
    }

    const run = await assignmentRepository.getPipelineRun(runId);
    if (run.workspaceId !== workspaceId) {
      return { success: false, status: 403, message: 'Pipeline run belongs to a different workspace' };
    }
    if (!isCorrectableAssignmentRun(run)) {
      return { success: false, status: 400, message: 'Only completed or already-synced assignment decisions can be reassigned' };
    }

    const localStatus = String(run.ticket?.status || '').toLowerCase();
    if (LOCAL_TERMINAL_STATUSES.has(localStatus)) {
      return { success: false, status: 409, message: `Ticket is ${run.ticket.status}; it cannot be reassigned` };
    }

    const recommendations = run.recommendation?.recommendations || [];
    if (normalized.selectionSource === 'recommendation') {
      const rec = findRecommendationByRank(recommendations, normalized.recommendationRank);
      if (!rec) {
        return { success: false, status: 400, message: `Recommendation #${normalized.recommendationRank} is not available for this run` };
      }
      if (Number(rec.techId) !== normalized.assignedTechId) {
        return { success: false, status: 400, message: `Recommendation #${normalized.recommendationRank} does not match technician ${normalized.assignedTechId}` };
      }
    }

    const targetTech = await prisma.technician.findFirst({
      where: { id: normalized.assignedTechId, workspaceId, isActive: true },
      select: { id: true, name: true, email: true, freshserviceId: true },
    });
    if (!targetTech) {
      return { success: false, status: 400, message: 'Target technician is not active in this workspace' };
    }
    if (!targetTech.freshserviceId) {
      return { success: false, status: 400, message: 'Target technician has no FreshService agent ID' };
    }

    const currentTechId = run.ticket?.assignedTechId || run.assignedTechId || null;
    if (currentTechId === targetTech.id) {
      return { success: false, status: 409, message: 'Ticket is already assigned to that technician' };
    }

    const fromTech = currentTechId
      ? await prisma.technician.findUnique({ where: { id: currentTechId }, select: { id: true, name: true, email: true } })
      : null;

    const correction = await prisma.assignmentCorrection.create({
      data: {
        workspaceId,
        pipelineRunId: run.id,
        ticketId: run.ticketId,
        fromTechnicianId: fromTech?.id || null,
        toTechnicianId: targetTech.id,
        selectionSource: normalized.selectionSource,
        recommendationRank: normalized.selectionSource === 'recommendation' ? normalized.recommendationRank : null,
        reason: normalized.reason,
        createdByEmail: actorEmail,
        freshserviceSyncStatus: 'pending',
        freshservicePayload: {
          requestedAt: new Date().toISOString(),
          assignedTechId: targetTech.id,
          selectionSource: normalized.selectionSource,
          recommendationRank: normalized.recommendationRank,
        },
      },
      include: {
        fromTechnician: { select: { id: true, name: true, email: true } },
        toTechnician: { select: { id: true, name: true, email: true } },
      },
    });

    try {
      const result = await this._syncCorrectionToFreshService({ run, correction, fromTech, targetTech, reason: normalized.reason, workspaceId });
      return { success: true, status: 200, data: result };
    } catch (error) {
      const freshserviceError = getFreshServiceError(error);
      await prisma.assignmentCorrection.update({
        where: { id: correction.id },
        data: {
          freshserviceSyncStatus: 'failed',
          freshserviceSyncError: error.message,
          freshservicePayload: {
            ...(correction.freshservicePayload || {}),
            freshserviceError,
          },
        },
      }).catch((updateError) => logger.warn('Failed to mark assignment correction failed', {
        correctionId: correction.id,
        error: updateError.message,
      }));
      return { success: false, status: 502, message: error.message, freshserviceError };
    }
  }

  async _syncCorrectionToFreshService({ run, correction, fromTech, targetTech, reason, workspaceId }) {
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) {
      throw new Error('FreshService not configured for this workspace');
    }

    const fsTicketId = Number(run.ticket?.freshserviceTicketId);
    if (!Number.isFinite(fsTicketId)) {
      throw new Error('Ticket has no FreshService ticket ID');
    }

    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'high',
      source: 'assignment-correction',
    });

    const fsTicket = await client.getTicket(fsTicketId);
    if (!ACTIONABLE_FRESHSERVICE_STATUSES.has(Number(fsTicket.status)) || fsTicket.deleted === true || fsTicket.spam === true) {
      throw new Error(`FreshService ticket is not open/pending (status: ${fsTicket.status})`);
    }

    let groupRemediationAction = null;
    if (fsTicket.group_id) {
      const group = await client.getGroup(fsTicket.group_id);
      if (group && !freshServiceGroupHasAgent(group, targetTech.freshserviceId)) {
        const broadGroupResult = await resolveBroadAssignmentGroup(client, fsConfig, targetTech.freshserviceId, fsTicket.group_id);
        if (!broadGroupResult.ok) {
          throw new Error(`Target technician is not a member of group "${group.name || fsTicket.group_id}"; ${broadGroupResult.reason}`);
        }
        groupRemediationAction = {
          type: 'update_group',
          ticketId: fsTicketId,
          groupId: broadGroupResult.group.id,
          groupName: broadGroupResult.group.name,
          previousGroupId: Number(fsTicket.group_id),
          previousGroupName: group.name || null,
        };
      }
    }

    const rejection = await prisma.ticketAssignmentEpisode.findFirst({
      where: {
        ticketId: run.ticketId,
        endMethod: 'rejected',
        technicianId: targetTech.id,
      },
      select: { endedAt: true, technician: { select: { name: true } } },
    });
    if (rejection) {
      throw new Error(`${rejection.technician.name} previously rejected this ticket at ${rejection.endedAt?.toISOString()}`);
    }

    const noteBody = [
      '<b>[Ticket Pulse]</b> Assignment corrected by admin.<br>',
      `<b>From:</b> ${htmlEscape(fromTech?.name || 'Unassigned/unknown')}<br>`,
      `<b>To:</b> ${htmlEscape(targetTech.name)}<br>`,
      `<b>Reason:</b> ${htmlEscape(reason)}<br>`,
      `<b>Correction ID:</b> ${correction.id}`,
    ].join('');

    if (groupRemediationAction) {
      await client.updateTicketGroup(fsTicketId, groupRemediationAction.groupId);
    }
    await client.assignTicket(fsTicketId, Number(targetTech.freshserviceId));
    await client.addPrivateNote(fsTicketId, noteBody);

    const now = new Date();
    const updatedCorrection = await prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: run.ticketId },
        data: {
          assignedTechId: targetTech.id,
          updatedAt: now,
        },
      });
      return tx.assignmentCorrection.update({
        where: { id: correction.id },
        data: {
          freshserviceSyncStatus: 'synced',
          freshserviceSyncedAt: now,
          freshserviceSyncError: null,
          freshservicePayload: {
            ...(correction.freshservicePayload || {}),
            actions: [
              ...(groupRemediationAction ? [groupRemediationAction] : []),
              { type: 'assign', ticketId: fsTicketId, agentId: Number(targetTech.freshserviceId) },
              { type: 'note', ticketId: fsTicketId, private: true },
            ],
            syncedAt: now.toISOString(),
          },
        },
        include: {
          fromTechnician: { select: { id: true, name: true, email: true } },
          toTechnician: { select: { id: true, name: true, email: true } },
        },
      });
    });

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultTimezone: true },
    });
    const timestamp = convertToTimezone(now, workspace?.defaultTimezone || 'America/Los_Angeles');
    const feedbackEntry = buildCorrectionFeedbackEntry({
      timestamp,
      ticket: run.ticket,
      fromTech,
      toTech: targetTech,
      selectionSource: correction.selectionSource,
      recommendationRank: correction.recommendationRank,
      reason,
    });
    await assignmentRepository.appendFeedback(workspaceId, feedbackEntry).catch((error) => {
      logger.warn('Failed to append assignment correction feedback', {
        correctionId: correction.id,
        error: error.message,
      });
    });

    return updatedCorrection;
  }
}

export default new AssignmentCorrectionService();
