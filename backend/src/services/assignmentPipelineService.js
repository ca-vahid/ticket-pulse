import assignmentRepository from './assignmentRepository.js';
import promptRepository from './promptRepository.js';
import availabilityService from './availabilityService.js';
import settingsRepository from './settingsRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { TOOL_SCHEMAS, executeTool } from './assignmentTools.js';
import freshServiceActionService from './freshServiceActionService.js';
import competencyFeedbackService from './competencyFeedbackService.js';
import afterHoursUrgentEscalationService from './afterHoursUrgentEscalationService.js';
import { formatDateInTimezone } from '../utils/timezone.js';
import { formatInTimeZone } from 'date-fns-tz';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
// Pure helpers extracted to their own modules so unit tests can exercise the
// rebound-context user-message logic and the auto-assign decision rules
// without pulling in Prisma/Anthropic.
import { buildUserMessage } from './assignmentUserMessage.js';
import { isGroupExcluded, isPipelineFinalDecision, resolvePipelineDecision } from './assignmentDecisionRules.js';
import {
  getFreshServiceTicketQueueBlocker,
  getLocalTicketQueueBlocker,
} from './assignmentQueueEligibility.js';
import { normalizeAiModel, providerForModel } from '../utils/aiProviders.js';
import providerGateway from './aiProviders/providerGateway.js';
import {
  buildPriorityTicketUpdateFields,
  validateRecommendationPriorityFields,
} from './priorityAssessment.js';

const MAX_TURNS = 20;

function sanitizeJsonValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeJsonValue(entry)]),
    );
  }
  return value;
}

function stringifyForModel(value) {
  return JSON.stringify(sanitizeJsonValue(value));
}

function normalizeTaxonomyFit(value) {
  const normalized = String(value || '').toLowerCase();
  return ['exact', 'weak', 'none'].includes(normalized) ? normalized : null;
}

function truncateTaxonomySuggestion(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.slice(0, 120);
}

export function priorityWritebackSkipReasonForTrigger(triggerSource) {
  if (triggerSource === 'priority_changed') {
    return 'external_priority_change_reassessment_no_writeback';
  }
  return null;
}

class AssignmentPipelineService {
  /**
   * Run the agentic assignment pipeline with streaming.
   * Automatic assignment triggers are queued outside business hours. When the
   * workspace enables after-hours priority assessment, an immediate priority-only
   * run executes first, then the full assignment run is queued for business
   * hours.
   * Manual triggers always execute immediately.
   */
  async runPipeline(ticketId, workspaceId, triggerSource = 'manual', onEvent = null, signal = null, options = {}) {
    const pipelineStart = Date.now();
    const emit = (event) => { try { onEvent?.(event); } catch { /* SSE write errors are non-fatal */ } };
    const isManual = triggerSource === 'manual';
    const isClassificationOnly = triggerSource === 'classification_only';
    const isPriorityAssessmentAfterHours = triggerSource === 'priority_assessment_after_hours';
    const isPriorityAssessmentOnly = triggerSource === 'priority_assessment_only'
      || isPriorityAssessmentAfterHours
      || triggerSource === 'priority_changed';
    // reboundFrom: { previousTechId, previousTechName, unassignedAt, unassignedByName, reboundCount }
    // Set when this run is being created because the ticket bounced back from
    // a prior assignee. Persisted on the run so the UI / LLM can show context.
    const reboundFrom = options.reboundFrom || null;

    if (signal?.aborted) {
      return { skipped: true, reason: 'cancelled_before_start' };
    }

    // ── Dedupe: reject if a queued or running run already exists ─────────
    const openRun = await assignmentRepository.getOpenPipelineRun(ticketId);
    if (openRun) {
      if (isManual && openRun.status === 'queued') {
        logger.info('Manual trigger claiming queued run', { runId: openRun.id, ticketId });
        const claimed = await assignmentRepository.claimQueuedRun(openRun.id);
        if (claimed) {
          return this._executeRun(openRun.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
        }
      }
      logger.info('Pipeline skipped: open run exists', { ticketId, existingRunId: openRun.id, existingStatus: openRun.status, triggerSource });
      emit({ type: 'error', message: `Pipeline already ${openRun.status} for this ticket (run #${openRun.id})` });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'open_run_exists', existingRunId: openRun.id };
    }

    // ── Config check ────────────────────────────────────────────────────
    const assignmentConfig = await assignmentRepository.getConfig(workspaceId);
    if (!assignmentConfig?.isEnabled) {
      emit({ type: 'error', message: 'Assignment pipeline is not enabled for this workspace' });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'assignment_not_enabled' };
    }

    if (isPriorityAssessmentAfterHours && !assignmentConfig?.priorityAssessmentAfterHoursEnabled) {
      emit({ type: 'error', message: 'After-hours priority assessment is disabled for this workspace' });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'priority_assessment_after_hours_disabled' };
    }

    // ── Business hours gate (automatic triggers only) ───────────────────
    if (!isManual && !isClassificationOnly && !isPriorityAssessmentOnly) {
      // Queue-time validation: never queue a ticket that is already closed,
      // deleted, or assigned. Without this guard the email poller floods the
      // queue with noise — security alerts, marketing emails, and FS tickets
      // that were auto-deleted as spam all get pulled in by subject regex
      // matching. (The same validation runs at drain time, but by then the
      // queue UI is already polluted with stale items.)
      const queueGuard = await this._validateForQueue(ticketId);
      if (!queueGuard.valid) {
        logger.info('Pipeline queue rejected: ticket not eligible', {
          ticketId, workspaceId, triggerSource, reason: queueGuard.reason,
        });
        emit({ type: 'error', message: `Ticket not eligible for queue: ${queueGuard.reason}` });
        emit({ type: 'complete' });
        return { skipped: true, reason: 'not_eligible_for_queue', detail: queueGuard.reason };
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultTimezone: true },
      });
      const tz = workspace?.defaultTimezone || 'America/Los_Angeles';
      const bh = await availabilityService.isBusinessHours(new Date(), tz, workspaceId);

      if (!bh.isBusinessHours) {
        const queuedReason = this._buildAfterHoursQueuedReason(bh.reason || 'Outside business hours', reboundFrom);
        let run;

        if (assignmentConfig?.priorityAssessmentAfterHoursEnabled) {
          run = await this._runAfterHoursPriorityAssessmentAndQueue({
            ticketId,
            workspaceId,
            triggerSource,
            queuedReason,
            reboundFrom,
            emit,
            signal,
          });
        } else {
          run = await this._queueRunForBusinessHours({
            ticketId,
            workspaceId,
            triggerSource,
            queuedReason,
            reboundFrom,
            emit,
          });
        }

        emit({ type: 'complete' });
        return run;
      }
    }

    // ── Create running run and execute ──────────────────────────────────
    const promptVersion = await promptRepository.getPublished(workspaceId);
    const llmProvider = providerForModel(assignmentConfig.llmModel, 'anthropic');
    const llmModel = normalizeAiModel(assignmentConfig.llmModel, llmProvider, null, 'assignment_pipeline');
    let run;
    try {
      run = await assignmentRepository.createPipelineRun({
        ticketId,
        workspaceId,
        status: 'running',
        triggerSource,
        llmProvider,
        llmModel,
        promptVersionId: promptVersion.id,
        reboundFrom,
      });
    } catch (error) {
      const existingRun = await assignmentRepository.getOpenPipelineRun(ticketId);
      if (existingRun) {
        logger.info('Pipeline start skipped: open run was created concurrently', {
          ticketId,
          existingRunId: existingRun.id,
          existingStatus: existingRun.status,
          triggerSource,
        });
        emit({ type: 'error', message: `Pipeline already ${existingRun.status} for this ticket (run #${existingRun.id})` });
        emit({ type: 'complete' });
        return { skipped: true, reason: 'open_run_exists', existingRunId: existingRun.id };
      }
      throw error;
    }

    return this._executeRun(run.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
  }

  _buildAfterHoursQueuedReason(baseReason, reboundFrom = null) {
    let queuedReason = baseReason || 'Outside business hours';
    if (reboundFrom?.previousTechName) {
      const when = reboundFrom.unassignedAt ? ` at ${new Date(reboundFrom.unassignedAt).toISOString()}` : '';
      const who = reboundFrom.unassignedByName ? ` by ${reboundFrom.unassignedByName}` : '';
      queuedReason = `Returned from ${reboundFrom.previousTechName}${when}${who} - ${queuedReason}`;
    }
    return queuedReason;
  }

  async _queueRunForBusinessHours({ ticketId, workspaceId, triggerSource, queuedReason, reboundFrom = null, emit = () => {} }) {
    let run;
    try {
      run = await assignmentRepository.createQueuedRun({
        ticketId, workspaceId, triggerSource, queuedReason, reboundFrom,
      });
    } catch (error) {
      const existingRun = await assignmentRepository.getOpenPipelineRun(ticketId);
      if (existingRun) {
        logger.info('Pipeline queue skipped: open run was created concurrently', {
          ticketId,
          existingRunId: existingRun.id,
          existingStatus: existingRun.status,
          triggerSource,
        });
        emit({ type: 'error', message: `Pipeline already ${existingRun.status} for this ticket (run #${existingRun.id})` });
        return { skipped: true, reason: 'open_run_exists', existingRunId: existingRun.id };
      }
      throw error;
    }

    logger.info('Pipeline queued (outside business hours)', {
      runId: run.id, ticketId, workspaceId, triggerSource, queuedReason,
    });
    emit({ type: 'queued', runId: run.id, reason: queuedReason });
    return run;
  }

  async _runAfterHoursPriorityAssessmentAndQueue({
    ticketId,
    workspaceId,
    triggerSource,
    queuedReason,
    reboundFrom = null,
    emit = () => {},
    signal = null,
  }) {
    logger.info('Pipeline after-hours priority assessment starting before business-hours queue', {
      ticketId,
      workspaceId,
      triggerSource,
    });
    emit({ type: 'priority_assessment_started', reason: 'after_hours_priority_only' });

    const priorityRun = await this.runPipeline(
      ticketId,
      workspaceId,
      'priority_assessment_after_hours',
      null,
      signal,
      { parentTriggerSource: triggerSource },
    ).catch((error) => {
      logger.warn('Pipeline after-hours priority assessment failed before queueing assignment run', {
        ticketId,
        workspaceId,
        triggerSource,
        error: error.message,
      });
      return { skipped: true, reason: 'priority_assessment_failed', error: error.message };
    });

    if (signal?.aborted) {
      return priorityRun;
    }

    const assessedPriority = priorityRun?.recommendation?.assessedPriority || priorityRun?.ticket?.assessedPriority || null;
    const priorityStatus = priorityRun?.status || (priorityRun?.skipped ? 'skipped' : null);
    const priorityRunId = priorityRun?.id || null;

    let escalation = null;
    if (priorityStatus === 'completed' && priorityRun?.decision === 'noise_dismissed') {
      logger.info('Pipeline after-hours priority assessment dismissed ticket as noise; skipping business-hours queue', {
        ticketId,
        workspaceId,
        triggerSource,
        priorityRunId,
      });
      return {
        ...priorityRun,
        afterHoursPriorityRunId: priorityRunId,
        afterHoursPriorityStatus: priorityStatus,
        afterHoursAssessedPriority: assessedPriority,
        afterHoursAssignmentQueued: false,
        afterHoursQueueSkippedReason: 'noise_dismissed',
      };
    }

    if (priorityStatus === 'completed' && assessedPriority === 'Urgent') {
      escalation = await afterHoursUrgentEscalationService.queueForPriorityRun(priorityRun).catch((error) => {
        logger.warn('Pipeline after-hours urgent escalation failed', {
          ticketId,
          workspaceId,
          priorityRunId,
          error: error.message,
        });
        return { queued: 0, skipped: 'error', error: error.message };
      });
      await this._recordAfterHoursEscalationAudit(priorityRunId, escalation);
    }

    const queueRun = await this._queueRunForBusinessHours({
      ticketId,
      workspaceId,
      triggerSource,
      queuedReason,
      reboundFrom,
      emit,
    });

    logger.info('Pipeline after-hours assignment queued after priority assessment', {
      ticketId,
      workspaceId,
      triggerSource,
      priorityRunId,
      priorityStatus,
      assessedPriority,
      escalation,
      queuedRunId: queueRun?.id,
    });

    return {
      ...queueRun,
      afterHoursPriorityRunId: priorityRunId,
      afterHoursPriorityStatus: priorityStatus,
      afterHoursAssessedPriority: assessedPriority,
      afterHoursUrgentEscalation: escalation,
    };
  }

  async _recordAfterHoursEscalationAudit(runId, escalation) {
    if (!runId) return null;
    try {
      const maxStep = await prisma.assignmentPipelineStep.aggregate({
        where: { pipelineRunId: runId },
        _max: { stepNumber: true },
      });
      return await assignmentRepository.createPipelineStep({
        pipelineRunId: runId,
        stepNumber: (maxStep._max.stepNumber || 0) + 1,
        stepName: 'after_hours_urgent_escalation',
        status: escalation?.error ? 'failed' : escalation?.queued > 0 ? 'completed' : 'skipped',
        output: escalation || { queued: 0, skipped: 'unknown' },
        errorMessage: escalation?.error || null,
        durationMs: 0,
      });
    } catch (error) {
      logger.warn('Pipeline after-hours urgent escalation audit step failed', {
        runId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Validate a ticket is eligible to enter the queue. Mirrors
   * validateQueuedRun but takes a ticketId directly (no run needed).
   * Used at queue-time so closed/deleted/assigned tickets never get
   * queued in the first place.
   */
  async _validateForQueue(ticketId) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { status: true, assignedTechId: true },
    });
    const blocker = getLocalTicketQueueBlocker(ticket);
    if (blocker) return blocker.reason === 'Ticket no longer exists'
      ? { valid: false, reason: 'Ticket not found in database' }
      : blocker;
    return { valid: true };
  }

  /**
   * Validate a queued run is still worth executing.
   * Returns { valid: true } or { valid: false, reason: string }.
   */
  async validateQueuedRun(run, options = {}) {
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: {
        id: true,
        workspaceId: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        assignedTechId: true,
      },
    });

    const localBlocker = getLocalTicketQueueBlocker(ticket);
    if (localBlocker) return localBlocker;

    if (options.liveCheck !== false) {
      const freshserviceBlocker = await this._validateQueuedRunAgainstFreshService(ticket, options);
      if (freshserviceBlocker) return freshserviceBlocker;
    }

    const newerRun = await prisma.assignmentPipelineRun.findFirst({
      where: {
        ticketId: run.ticketId,
        id: { not: run.id },
        status: { in: ['completed', 'running'] },
        createdAt: { gt: run.createdAt },
      },
      select: { id: true, status: true },
    });

    if (newerRun) {
      return { valid: false, reason: `Superseded by newer run #${newerRun.id} (${newerRun.status})` };
    }

    return { valid: true };
  }

  async _initializeQueueValidationClient(options = {}) {
    const config = await settingsRepository.getFreshServiceConfig();
    return createFreshServiceClient(config.domain, config.apiKey, {
      priority: options.priority || 'high',
      source: options.source || 'assignment-queue-validation',
    });
  }

  async _validateQueuedRunAgainstFreshService(ticket, options = {}) {
    const fsId = Number(ticket.freshserviceTicketId);
    if (!Number.isFinite(fsId)) {
      return { valid: false, reason: 'Ticket is missing a FreshService ticket ID' };
    }

    let fsTicket;
    try {
      const client = options.client || await this._initializeQueueValidationClient(options);
      fsTicket = await client.fetchTicketSafe(fsId);
    } catch (error) {
      logger.warn('Queued run FreshService validation failed; leaving run eligible for retry', {
        ticketId: ticket.id,
        fsId,
        error: error.message,
      });
      return null;
    }

    const blocker = getFreshServiceTicketQueueBlocker(fsTicket);
    if (!blocker) return null;

    if (blocker.localStatus && blocker.shouldUpdateTicket !== false) {
      await this._markTicketStatusFromFreshService(ticket, blocker.localStatus, blocker.activityReason || blocker.reason);
    } else if (blocker.freshserviceResponderId) {
      await this._markTicketAssignedFromFreshService(ticket, blocker.freshserviceResponderId);
    }

    return blocker;
  }

  async _markTicketStatusFromFreshService(ticket, status, reason) {
    if (String(ticket.status) === String(status)) return;

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status, updatedAt: new Date() },
    });

    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'status_changed',
      performedBy: 'System',
      performedAt: new Date(),
      details: {
        oldStatus: ticket.status,
        newStatus: status,
        note: reason,
      },
    });
  }

  async _markTicketAssignedFromFreshService(ticket, freshserviceResponderId) {
    const responderId = BigInt(freshserviceResponderId);
    const tech = await prisma.technician.findFirst({
      where: { freshserviceId: responderId, workspaceId: ticket.workspaceId },
      select: { id: true },
    }) || await prisma.technician.findFirst({
      where: { freshserviceId: responderId },
      select: { id: true },
    });

    if (!tech?.id || ticket.assignedTechId === tech.id) return;

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { assignedTechId: tech.id, updatedAt: new Date() },
    });
  }

  async reconcileQueuedRuns(workspaceId, options = {}) {
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 500, 1), 2000);
    const queued = await assignmentRepository.listQueuedRuns(workspaceId, limit);
    if (queued.length === 0) return { checked: 0, pruned: 0, kept: 0, reasons: {} };

    let client = null;
    if (options.liveCheck !== false) {
      try {
        client = await this._initializeQueueValidationClient({
          priority: options.priority || 'high',
          source: options.source || 'assignment-queue-reconcile',
        });
      } catch (error) {
        logger.warn('Queue reconciliation could not initialize FreshService client; using local validation only', {
          workspaceId,
          error: error.message,
        });
      }
    }

    let pruned = 0;
    let kept = 0;
    const reasons = {};

    for (const run of queued) {
      try {
        const validation = await this.validateQueuedRun(run, {
          liveCheck: !!client,
          client,
        });
        if (!validation.valid) {
          await assignmentRepository.markRunSkippedStale(run.id, validation.reason);
          reasons[validation.reason] = (reasons[validation.reason] || 0) + 1;
          pruned++;
        } else {
          kept++;
        }
      } catch (error) {
        kept++;
        logger.warn('Queue reconciliation skipped one run after validation error', {
          workspaceId,
          runId: run.id,
          ticketId: run.ticketId,
          error: error.message,
        });
      }
    }

    if (pruned > 0) {
      logger.info('Queue reconciliation pruned stale runs', { workspaceId, checked: queued.length, pruned, kept, reasons });
    }

    return { checked: queued.length, pruned, kept, reasons };
  }

  /**
   * Process queued runs for a workspace. Called by the scheduler during business hours.
   * Returns count of processed/skipped runs.
   */
  async drainQueuedRuns(workspaceId, maxPerTick = 5) {
    const queued = await assignmentRepository.listQueuedRuns(workspaceId, maxPerTick);
    if (queued.length === 0) return { processed: 0, skipped: 0 };

    let processed = 0;
    let skipped = 0;
    let validationClient = null;
    try {
      validationClient = await this._initializeQueueValidationClient({
        priority: 'high',
        source: 'assignment-queue-drain',
      });
    } catch (error) {
      logger.warn('Queue drain could not initialize FreshService validation client; using local validation only', {
        workspaceId,
        error: error.message,
      });
    }

    for (const run of queued) {
      const claimed = await assignmentRepository.claimQueuedRun(run.id);
      if (!claimed) {
        logger.debug('Queue drain: claim failed (already claimed)', { runId: run.id });
        continue;
      }

      const validation = await this.validateQueuedRun(run, {
        liveCheck: !!validationClient,
        client: validationClient,
      });
      if (!validation.valid) {
        await assignmentRepository.markRunSkippedStale(run.id, validation.reason);
        logger.info('Queue drain: skipped stale run', { runId: run.id, ticketId: run.ticketId, reason: validation.reason });
        skipped++;
        continue;
      }

      try {
        logger.info('Queue drain: processing queued run', { runId: run.id, ticketId: run.ticketId, workspaceId });
        await this._executeRun(run.id, run.ticketId, workspaceId, run.triggerSource, Date.now(), () => {}, null);
        processed++;
      } catch (error) {
        logger.error('Queue drain: run failed', { runId: run.id, error: error.message });
      }
    }

    logger.info('Queue drain complete', { workspaceId, found: queued.length, processed, skipped });
    return { processed, skipped };
  }

  /**
   * Core pipeline execution. Separated from runPipeline so it can be called
   * for both fresh runs and claimed queued runs.
   */
  async _executeRun(runId, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal) {
    const isPriorityAssessmentOnly = triggerSource === 'priority_assessment_only'
      || triggerSource === 'priority_assessment_after_hours'
      || triggerSource === 'priority_changed';
    const assignmentConfig = await assignmentRepository.getConfig(workspaceId);
    const promptVersion = await promptRepository.getPublished(workspaceId);
    let systemPrompt = promptVersion.systemPrompt;

    if (assignmentConfig?.feedbackContext) {
      systemPrompt += `\n\n## Historical Admin Feedback\n${assignmentConfig.feedbackContext.slice(-4000)}`;
    }

    systemPrompt += '\n\n## Time Handling\nTreat the workspace current date/time supplied in the user message as the source of truth for what "today" means. Tool outputs expose ticket and decision timestamps in workspace-local time unless explicitly labeled as UTC. Agent availability includes each technician\'s own local date/time. Historical admin feedback may contain legacy UTC timestamps from older runs, so prefer current workspace-local timestamps when there is any ambiguity.';
    if (triggerSource === 'classification_only') {
      systemPrompt += '\n\n## Classification-only Mode\nThis ticket is already assigned or self-picked. Ticket Pulse must classify it, but must not change its assignee, close it, or add an assignment note. Focus on selecting the best existing internal top-level category and subcategory. Use get_ticket_details and get_ticket_categories first; use similar-ticket search only if needed. Still call submit_recommendation so the selected category/subcategory is saved. If the schema requires recommendations, keep them aligned with the current assignee context; the system will ignore assignment recommendations and will only sync Ticket Pulse category fields.';
    } else if (isPriorityAssessmentOnly) {
      systemPrompt += '\n\n## Priority-assessment-only Mode\nThis run exists to assess and persist Ticket Pulse priority for an active ticket. Still inspect and classify the ticket enough to produce valid structured output, but do not change the assignee and do not write an assignment recommendation as an action request. If the ticket is non-actionable noise/FYI, submit an empty recommendations array with closureNoticeHtml; the system will apply the workspace noise-dismissal policy. Do not call get_agent_availability, find_matching_agents, get_workload_stats, get_tech_ticket_history, or get_technician_ad_profile unless one of those tools is directly needed as evidence for priority or classification. Call submit_recommendation so assessedPriority, priorityRationale, priorityConfidence, and optional prioritySignals are saved for Ticket Pulse priority handling.';
      if (triggerSource === 'priority_changed') {
        systemPrompt += '\n\nFreshService priority changed outside Ticket Pulse. Treat that change as an escalation signal to consider, but still assess priority from the ticket evidence and explain whether the evidence supports the new FreshService priority. This reassessment is audit-only for FreshService native priority: the system will not write the assessed priority back to FreshService from this trigger.';
      }
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultTimezone: true },
    });
    const wsTz = workspace?.defaultTimezone || 'America/Los_Angeles';
    const now = new Date();
    const localDate = formatDateInTimezone(now, wsTz);
    const localTime = formatInTimeZone(now, wsTz, 'HH:mm');
    const dayOfWeek = formatInTimeZone(now, wsTz, 'EEEE');

    // Pull rebound metadata that syncService persisted on the run record so we
    // can surface it to the LLM in the first user message. Without this the LLM
    // is blind to the fact that this run is a rerouting after a rejection,
    // which leads to repeating the same pick or producing a generic agent
    // briefing that doesn't acknowledge the bounce.
    let reboundFrom = null;
    try {
      const runRecord = await prisma.assignmentPipelineRun.findUnique({
        where: { id: runId },
        select: { reboundFrom: true },
      });
      reboundFrom = runRecord?.reboundFrom || null;
    } catch (err) {
      logger.debug('Could not load reboundFrom for pipeline run', { runId, error: err.message });
    }

    // Ensure run is in running state (may already be if created as running)
    const initialProvider = providerForModel(assignmentConfig?.llmModel, 'anthropic');
    const llmModel = normalizeAiModel(assignmentConfig?.llmModel, initialProvider, null, 'assignment_pipeline');
    await assignmentRepository.updatePipelineRun(runId, {
      status: 'running',
      llmProvider: initialProvider,
      llmModel,
      promptVersionId: promptVersion.id,
    });

    emit({ type: 'run_started', runId, ticketId, promptVersion: promptVersion.version });
    let totalTokens = 0;
    let llmProvider = initialProvider;
    let resolvedLlmModel = llmModel;
    let llmFallbackUsed = false;
    let llmFallbackReason = null;
    let llmAttemptCount = 0;
    let stepCounter = 0;
    let fullTranscript = '';
    let lastHeartbeatAt = Date.now();
    let heartbeatPromise = Promise.resolve();

    const queueHeartbeat = () => {
      const now = Date.now();
      if (now - lastHeartbeatAt < 10000) {
        return;
      }

      lastHeartbeatAt = now;
      heartbeatPromise = heartbeatPromise
        .then(() => assignmentRepository.touchPipelineRun(runId))
        .catch((error) => logger.debug('Pipeline heartbeat failed', { runId, error: error.message }));
    };

    // Pure helper at module scope; see buildUserMessage above. Surfaces the
    // rebound state explicitly so the LLM (a) actively avoids the prior
    // rejecter via the previouslyRejectedThisTicket flag from
    // find_matching_agents, and (b) knows to acknowledge the re-routing in
    // agentBriefingHtml without naming the previous assignee.
    const messages = [
      { role: 'user', content: buildUserMessage({ ticketId, dayOfWeek, localDate, localTime, wsTz, reboundFrom }) },
    ];

    const toolAllowlist = promptVersion.toolConfig?.allowedTools || null;
    let tools = TOOL_SCHEMAS
      .filter((t) => !toolAllowlist || toolAllowlist.includes(t.name));

    const enableWebSearch = promptVersion.toolConfig?.enableWebSearch !== false;
    if (enableWebSearch) {
      tools = [
        ...tools,
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ];
    }

    try {
      let continueLoop = true;
      let recommendation = null;

      while (continueLoop && stepCounter < MAX_TURNS) {
        if (signal?.aborted) {
          await assignmentRepository.updatePipelineRun(runId, {
            status: 'cancelled', totalDurationMs: Date.now() - pipelineStart,
            totalTokensUsed: totalTokens, fullTranscript,
            llmProvider,
            llmModel: resolvedLlmModel,
            llmFallbackUsed,
            llmFallbackReason,
            llmAttemptCount,
          });
          emit({ type: 'error', message: 'Pipeline cancelled by client' });
          emit({ type: 'complete', runId });
          return await assignmentRepository.getPipelineRun(runId);
        }

        stepCounter++;
        emit({ type: 'turn_start', turn: stepCounter });

        let toolJsonLength = 0;
        let lastProgressAt = 0;
        const turnResult = await providerGateway.runToolTurn({
          operation: 'assignment_pipeline',
          workspaceId,
          legacyModel: assignmentConfig?.llmModel,
          runLinks: { assignmentPipelineRunId: runId },
          systemPrompt,
          tools,
          messages,
          maxTokens: 4096,
          signal,
          emit,
          onText: (text) => {
            fullTranscript += text;
            emit({ type: 'text', text });
            queueHeartbeat();
          },
          onInputJson: (partialJson) => {
            toolJsonLength += partialJson.length;
            queueHeartbeat();
            const now = Date.now();
            if (now - lastProgressAt > 1000) {
              lastProgressAt = now;
              const kb = (toolJsonLength / 1024).toFixed(1);
              emit({ type: 'thinking', kb: parseFloat(kb) });
            }
          },
          onThinking: (chunk) => {
            if (chunk) {
              emit({ type: 'thinking', text: chunk });
              queueHeartbeat();
            }
          },
        });

        const finalMessage = turnResult.message;
        totalTokens += turnResult.usage?.totalTokens || 0;
        llmProvider = turnResult.provider;
        resolvedLlmModel = turnResult.model;
        llmFallbackUsed = llmFallbackUsed || turnResult.fallbackUsed;
        llmFallbackReason = turnResult.fallbackReason || llmFallbackReason;
        llmAttemptCount += turnResult.attemptNumber || 1;

        await assignmentRepository.updatePipelineRun(runId, {
          llmProvider,
          llmModel: resolvedLlmModel,
          llmFallbackUsed,
          llmFallbackReason,
          llmAttemptCount,
        });

        const toolResultMap = new Map();

        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            if (block.name === 'submit_recommendation') {
              let accepted = true;
              let validationError = null;
              try {
                validateRecommendationPriorityFields(block.input);
                recommendation = block.input;
              } catch (err) {
                accepted = false;
                validationError = err.message;
                logger.warn('submit_recommendation rejected by priority schema validation', {
                  runId,
                  ticketId,
                  error: validationError,
                });
              }

              await assignmentRepository.createPipelineStep({
                pipelineRunId: runId,
                stepNumber: stepCounter,
                stepName: 'submit_recommendation',
                status: accepted ? 'completed' : 'failed',
                input: block.input,
                output: accepted ? { accepted: true } : { accepted: false, error: validationError },
                errorMessage: validationError,
                durationMs: 0,
              });

              emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });
              const toolResult = accepted ? { accepted: true } : { accepted: false, error: validationError };
              toolResultMap.set(block.id, toolResult);
              emit({ type: 'tool_result', name: block.name, data: toolResult, durationMs: 0, toolUseId: block.id });
              continue;
            }

            const toolStep = await assignmentRepository.createPipelineStep({
              pipelineRunId: runId,
              stepNumber: stepCounter,
              stepName: block.name,
              status: 'running',
              input: block.input,
            });

            emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });
            queueHeartbeat();

            const toolStart = Date.now();
            let toolResult;
            try {
              toolResult = await executeTool(block.name, block.input, { workspaceId, ticketId });
            } catch (err) {
              toolResult = { error: err.message };
            }
            const sanitizedToolResult = sanitizeJsonValue(toolResult);
            const toolDuration = Date.now() - toolStart;

            toolResultMap.set(block.id, sanitizedToolResult);

            await assignmentRepository.updatePipelineStep(toolStep.id, {
              status: 'completed',
              durationMs: toolDuration,
              output: sanitizedToolResult,
            });
            queueHeartbeat();

            emit({ type: 'tool_result', name: block.name, data: sanitizedToolResult, durationMs: toolDuration, toolUseId: block.id });

            const toolResultStr = stringifyForModel(sanitizedToolResult);
            fullTranscript += `\n\n[Tool: ${block.name}] → ${toolResultStr.slice(0, 500)}${toolResultStr.length > 500 ? '...' : ''}\n\n`;
          }
        }

        for (const block of finalMessage.content) {
          if (block.type === 'server_tool_use') {
            emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id, serverTool: true });
            fullTranscript += `\n\n[Server Tool: ${block.name}] query="${block.input?.query || ''}"\n\n`;
          } else if (block.type === 'web_search_tool_result') {
            const resultCount = Array.isArray(block.content) ? block.content.filter((r) => r.type === 'web_search_result').length : 0;
            emit({ type: 'tool_result', name: 'web_search', data: { resultCount }, toolUseId: block.tool_use_id, serverTool: true });
            fullTranscript += `[Web Search Results: ${resultCount} results]\n\n`;
          }
        }

        messages.push({ role: 'assistant', content: finalMessage.content });

        if (finalMessage.stop_reason === 'tool_use') {
          const toolResultBlocks = finalMessage.content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({
              type: 'tool_result',
              tool_use_id: b.id,
              content: stringifyForModel(toolResultMap.get(b.id) || { error: 'Result not found' }),
            }));

          messages.push({ role: 'user', content: toolResultBlocks });
          continueLoop = recommendation === null;
        } else if (finalMessage.stop_reason === 'pause_turn') {
          continueLoop = true;
        } else {
          continueLoop = false;

          const accumulatedText = finalMessage.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');

          if (accumulatedText) {
            await assignmentRepository.createPipelineStep({
              pipelineRunId: runId,
              stepNumber: stepCounter,
              stepName: 'final_response',
              status: 'completed',
              durationMs: Date.now() - pipelineStart,
              llmResponse: accumulatedText,
              tokensUsed: totalTokens,
            });
          }
        }
      }

      if (!recommendation) {
        logger.warn('LLM did not call submit_recommendation, falling back to regex parse', { runId, provider: llmProvider });
        recommendation = this._parseRecommendationFromTranscript(fullTranscript, runId);
      }

      const topRec = recommendation?.recommendations?.[0];
      const isNoise = recommendation && (!recommendation.recommendations || recommendation.recommendations.length === 0);

      // Detect "LLM ignored the prompt and re-suggested a prior rejecter" so we
      // don't auto-assign a ticket back to the agent who just bounced it. The
      // preflight check would catch this at the FS layer too, but downgrading
      // here avoids the FS round-trip and produces a cleaner state.
      let llmIgnoredRebound = false;
      if (recommendation && triggerSource === 'rebound' && topRec?.techId) {
        try {
          const rejectedByTopRec = await prisma.ticketAssignmentEpisode.findFirst({
            where: {
              ticketId,
              technicianId: topRec.techId,
              endMethod: 'rejected',
            },
            select: { id: true },
          });
          if (rejectedByTopRec) {
            llmIgnoredRebound = true;
            logger.warn('Pipeline rebound: LLM picked a prior rejecter as top recommendation, downgrading to pending_review', {
              runId, ticketId, topRecTechId: topRec.techId,
            });
          }
        } catch (err) {
          logger.debug('Could not check for prior rejection of top recommendation', { runId, error: err.message });
        }
      }

      // Group exclusion: when the ticket's FS group is in
      // assignmentConfig.excludedGroupIds, force pending_review even with
      // autoAssign=true. The admin still sees the LLM recommendation, but
      // has to click approve manually. Looks up group name for the error
      // message and the UI strip.
      let groupExcluded = false;
      let excludedGroupName = null;
      if (recommendation && !isNoise && assignmentConfig?.autoAssign) {
        try {
          const ticketRow = await prisma.ticket.findUnique({
            where: { id: ticketId },
            select: { groupId: true },
          });
          if (isGroupExcluded(ticketRow?.groupId, assignmentConfig?.excludedGroupIds)) {
            groupExcluded = true;
            // Cheap name lookup: settings UI knows the names but the pipeline
            // doesn't cache them. Fall back to "#<id>" if FS lookup is slow
            // or fails — this is purely cosmetic for the error message.
            excludedGroupName = `#${ticketRow.groupId}`;
            logger.info('Pipeline: ticket group is excluded from auto-assignment, downgrading to pending_review', {
              runId, ticketId, groupId: String(ticketRow.groupId),
            });
          }
        } catch (err) {
          logger.debug('Could not check group exclusion for ticket', { runId, error: err.message });
        }
      }

      const decision = resolvePipelineDecision({
        recommendation,
        triggerSource,
        isPriorityAssessmentOnly,
        isNoise,
        llmIgnoredRebound,
        groupExcluded,
        autoAssign: assignmentConfig?.autoAssign,
      });

      const finalStatus = recommendation ? 'completed' : 'failed_schema_validation';
      let errorMessage = recommendation ? null : 'Could not extract structured recommendation from LLM output';
      if (llmIgnoredRebound) {
        errorMessage = `LLM re-suggested ${topRec.techName || `tech #${topRec.techId}`}, who already rejected this ticket — downgraded to pending_review for manual handling.`;
      } else if (groupExcluded) {
        // The "Group <X>" prefix is what the run detail page keys on to render
        // the blue "Manual approval required" strip — keep this format stable.
        errorMessage = `Group ${excludedGroupName} is excluded from auto-assignment — manual approval required.`;
      }

      // Set decidedAt when the pipeline itself finalizes a decision. Without
      // this, auto_assigned + noise_dismissed runs had decidedAt=NULL and
      // were silently filtered out of the Decided/Dismissed tabs (which
      // query by sinceField='decidedAt'). Admin-triggered decisions (via
      // /decide + /dismiss) continue to set decidedAt themselves, and
      // pending_review stays null (the run really is still pending).
      const pipelineDidDecide = isPipelineFinalDecision(decision);

      // Stamp syncStatus='pending' atomically with the decision so a process
      // crash between "decision finalized" and "FS sync kicked off" doesn't
      // leave the run permanently stuck. The fire-and-forget execute() call
      // below will overwrite to 'synced' / 'failed' / 'skipped' / 'dry_run'
      // when it actually runs. The new sweepOrphanedSyncRuns() recovers any
      // run that's still 'pending' a few minutes later (process died mid-flight).
      // Only set this for outcomes we actually try to sync — pending_review and
      // failed don't trigger a sync attempt.
      const willTriggerSync =
        decision === 'auto_assigned'
        || decision === 'classified_only'
        || (decision === 'noise_dismissed' && assignmentConfig?.autoCloseNoise);

      if (recommendation) {
        await this._persistInternalClassification(ticketId, workspaceId, recommendation);
        await this._persistPriorityAssessment(ticketId, runId, recommendation);
        if (decision === 'noise_dismissed') {
          await prisma.ticket.update({
            where: { id: ticketId },
            data: {
              isNoise: true,
              ticketCategory: recommendation.ticketClassification || 'Noise',
              updatedAt: new Date(),
            },
          }).catch((updateError) => {
            logger.warn('Pipeline: failed to mark noise-dismissed ticket locally', {
              runId,
              ticketId,
              error: updateError.message,
            });
          });
        }
      }

      await assignmentRepository.updatePipelineRun(runId, {
        status: finalStatus,
        decision,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokensUsed: totalTokens,
        llmProvider,
        llmModel: resolvedLlmModel,
        llmFallbackUsed,
        llmFallbackReason,
        llmAttemptCount,
        recommendation,
        fullTranscript,
        errorMessage,
        ...(decision === 'auto_assigned' && topRec?.techId ? { assignedTechId: topRec.techId } : {}),
        ...(pipelineDidDecide ? { decidedAt: new Date() } : {}),
        ...(willTriggerSync ? { syncStatus: 'pending' } : {}),
      });

      if (recommendation) {
        emit({ type: 'recommendation', data: recommendation, decision, totalDurationMs: Date.now() - pipelineStart, totalTokens });
      } else {
        emit({ type: 'error', message: errorMessage });
      }

      logger.info('Pipeline completed', {
        runId, ticketId, status: finalStatus, decision: recommendation ? decision : null,
        turns: stepCounter, durationMs: Date.now() - pipelineStart, totalTokens,
      });

      if (recommendation && finalStatus === 'completed') {
        const priorityWritebackSkipReason = priorityWritebackSkipReasonForTrigger(triggerSource);
        if (priorityWritebackSkipReason) {
          await prisma.assignmentPipelineRun.update({
            where: { id: runId },
            data: {
              priorityWritebackStatus: 'skipped',
              priorityWritebackError: priorityWritebackSkipReason,
              priorityWritebackPayload: {
                kind: 'priority_writeback',
                skippedReason: priorityWritebackSkipReason,
                triggerSource,
              },
            },
          }).catch((err) => {
            logger.warn('Failed to mark priority writeback skipped', { runId, triggerSource, error: err.message });
          });
          logger.info('FreshService priority writeback skipped for external priority-change reassessment', {
            runId,
            ticketId,
            triggerSource,
            reason: priorityWritebackSkipReason,
          });
        } else {
          await freshServiceActionService.executePriorityWriteback(
            runId,
            workspaceId,
            assignmentConfig?.dryRunMode ?? true,
          ).catch((err) => {
            logger.warn('FreshService priority writeback failed', { runId, decision, error: err.message });
            return null;
          });
        }
      }

      // FreshService write-back — separate logic for assignments vs noise
      if (decision === 'auto_assigned' || decision === 'classified_only') {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true).catch((err) =>
          logger.warn('FreshService pipeline sync failed', { runId, decision, error: err.message }),
        );
      } else if (decision === 'noise_dismissed' && assignmentConfig?.autoCloseNoise) {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true).catch((err) =>
          logger.warn('FreshService auto-close noise failed', { runId, error: err.message }),
        );
      }

      // Competency feedback for auto-assign
      if (decision === 'auto_assigned' && topRec?.techId) {
        competencyFeedbackService.processDecisionFeedback(runId, decision, topRec.techId, workspaceId).catch((err) =>
          logger.warn('Competency feedback failed after auto-assign', { runId, error: err.message }),
        );
      }

      emit({ type: 'complete', runId });
      return await assignmentRepository.getPipelineRun(runId);

    } catch (error) {
      const currentRun = await prisma.assignmentPipelineRun.findUnique({
        where: { id: runId },
        select: { id: true, status: true, decision: true, syncStatus: true },
      }).catch((lookupError) => {
        logger.warn('Could not inspect pipeline run after failure', { runId, error: lookupError.message });
        return null;
      });

      if (currentRun?.status === 'completed' && currentRun?.decision) {
        logger.error('Pipeline post-completion hydration failed; preserving finalized run state', {
          runId,
          ticketId,
          status: currentRun.status,
          decision: currentRun.decision,
          syncStatus: currentRun.syncStatus,
          error: error.message,
        });
        emit({ type: 'complete', runId });
        return currentRun;
      }

      logger.error('Pipeline failed', { runId, ticketId, error: error.message });
      await assignmentRepository.updatePipelineRun(runId, {
        status: 'failed',
        totalDurationMs: Date.now() - pipelineStart,
        totalTokensUsed: totalTokens,
        llmProvider,
        llmModel: resolvedLlmModel,
        llmFallbackUsed,
        llmFallbackReason,
        llmAttemptCount,
        fullTranscript,
        errorMessage: error.message,
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'complete', runId });
      return await assignmentRepository.getPipelineRun(runId);
    }
  }

  async _persistPriorityAssessment(ticketId, runId, recommendation) {
    try {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: buildPriorityTicketUpdateFields(recommendation, runId, new Date()),
      });
    } catch (err) {
      logger.warn('Failed to persist assessed ticket priority', {
        ticketId,
        runId,
        error: err.message,
      });
    }
  }

  async _persistInternalClassification(ticketId, workspaceId, recommendation) {
    const rawCategoryId = Number(recommendation?.internalCategoryId);
    const rawSubcategoryId = Number(recommendation?.internalSubcategoryId);
    const categoryId = Number.isInteger(rawCategoryId) ? rawCategoryId : null;
    const subcategoryId = Number.isInteger(rawSubcategoryId) ? rawSubcategoryId : null;

    if (!categoryId && !subcategoryId && !recommendation?.classificationRationale) return;

    try {
      const selectedIds = [categoryId, subcategoryId].filter(Boolean);
      const categories = selectedIds.length
        ? await prisma.competencyCategory.findMany({
          where: { workspaceId, id: { in: selectedIds }, isActive: true },
          select: { id: true, parentId: true },
        })
        : [];
      const byId = new Map(categories.map((category) => [category.id, category]));
      const category = categoryId ? byId.get(categoryId) : null;
      const subcategory = subcategoryId ? byId.get(subcategoryId) : null;

      const normalizedSubcategory = subcategory?.parentId
        ? subcategory
        : (category?.parentId ? category : null);
      const normalizedCategory = category?.parentId
        ? byId.get(category.parentId)
        : category;
      const safeCategoryId = normalizedCategory?.id || normalizedSubcategory?.parentId || null;
      const safeSubcategoryId = normalizedSubcategory?.id || null;
      const categoryFit = normalizeTaxonomyFit(recommendation?.categoryFit);
      const subcategoryFit = normalizeTaxonomyFit(recommendation?.subcategoryFit);
      const suggestedCategoryName = null;
      const suggestedSubcategoryName = truncateTaxonomySuggestion(recommendation?.suggestedInternalSubcategoryName);
      const taxonomyReviewNeeded = ['weak', 'none'].includes(categoryFit)
        || ['weak', 'none'].includes(subcategoryFit)
        || Boolean(suggestedSubcategoryName);

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          internalCategoryId: safeCategoryId,
          internalSubcategoryId: safeSubcategoryId || null,
          internalCategoryConfidence: recommendation?.confidence || null,
          internalCategoryRationale: recommendation?.classificationRationale || recommendation?.ticketClassification || null,
          internalCategoryFit: categoryFit,
          internalSubcategoryFit: subcategoryFit,
          taxonomyReviewNeeded,
          suggestedInternalCategoryName: suggestedCategoryName,
          suggestedInternalSubcategoryName: suggestedSubcategoryName,
        },
      });
    } catch (err) {
      logger.warn('Failed to persist internal ticket classification', { ticketId, workspaceId, error: err.message });
    }
  }

  _parseRecommendationFromTranscript(transcript, runId) {
    try {
      const jsonMatch = transcript.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      const rawMatch = transcript.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (rawMatch) return JSON.parse(rawMatch[0]);
    } catch {
      logger.warn('Failed to parse recommendation JSON from pipeline output', { runId });
    }
    return null;
  }
}

export default new AssignmentPipelineService();
