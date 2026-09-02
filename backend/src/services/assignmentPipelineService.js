import assignmentRepository from './assignmentRepository.js';
import promptRepository from './promptRepository.js';
import availabilityService from './availabilityService.js';
import settingsRepository from './settingsRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { TOOL_SCHEMAS, executeTool, applyWorkspaceTicketTypes } from './assignmentTools.js';
import freshServiceActionService from './freshServiceActionService.js';
import competencyFeedbackService from './competencyFeedbackService.js';
import noiseRuleService from './noiseRuleService.js';
import afterHoursUrgentEscalationService from './afterHoursUrgentEscalationService.js';
import { formatDateInTimezone } from '../utils/timezone.js';
import { TICKET_ORIGIN } from '../utils/ticketOrigin.js';
import { formatInTimeZone } from 'date-fns-tz';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { Prisma } from '@prisma/client';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
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
} from './priorityAssessment.js';
import {
  buildTicketTypeTicketUpdateFields,
} from './ticketTypeAssessment.js';
import { normalizeSubmitRecommendationPayload } from './assignmentRecommendationValidation.js';

const MAX_TURNS = 20;
const PRIORITY_ASSESSMENT_DISABLED_REASON = 'priority_assessment_disabled';
const PRIORITY_WRITEBACK_DISABLED_REASON = 'priority_writeback_disabled';

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

function isPriorityAssessmentEnabled(assignmentConfig) {
  return assignmentConfig?.priorityAssessmentEnabled !== false;
}

export function priorityWritebackSkipReasonForTrigger(triggerSource, assignmentConfig = {}) {
  if (triggerSource === 'priority_changed') {
    return 'external_priority_change_reassessment_no_writeback';
  }
  if (assignmentConfig?.priorityWritebackEnabled === false) {
    return PRIORITY_WRITEBACK_DISABLED_REASON;
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

    // ── priority_changed eligibility: never reassess a dead ticket ───────
    // The noise auto-close's own FS write can shift priority; the next sync
    // then records a priority event that would re-run the pipeline on the
    // already-closed ticket, re-closing and re-noting it (prod #233696: three
    // runs + three duplicate courtesy notes in four minutes). The event
    // service gates this too — this is the belt for any other caller.
    if (triggerSource === 'priority_changed') {
      const eligibility = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { status: true, isNoise: true },
      }).catch(() => null);
      // Base-aware terminal check (Phase 8b): custom Resolved/Closed-base
      // statuses are just as dead as the canonical pair.
      const eligibilityBase = eligibility
        ? await statusService.baseStatusOf(workspaceId, eligibility.status)
        : null;
      if (!eligibility || ['Resolved', 'Closed'].includes(eligibilityBase) || eligibility.isNoise === true) {
        logger.info('Pipeline skipped: priority_changed on closed/noise ticket', {
          ticketId, status: eligibility?.status, isNoise: eligibility?.isNoise,
        });
        emit({ type: 'complete' });
        return { skipped: true, reason: 'priority_reassessment_ineligible' };
      }
    }

    // ── Dedupe: reject if a queued or running run already exists ─────────
    const openRun = await assignmentRepository.getOpenPipelineRun(ticketId);
    if (openRun) {
      if (isManual && openRun.status === 'queued') {
        logger.info('Manual trigger claiming queued run', { runId: openRun.id, ticketId });
        const claimed = await assignmentRepository.claimQueuedRun(openRun.id);
        if (claimed) {
          this._broadcastRunUpdate(workspaceId, ticketId, openRun.id, 'running');
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

    const priorityAssessmentEnabled = isPriorityAssessmentEnabled(assignmentConfig);
    if (isPriorityAssessmentOnly && !priorityAssessmentEnabled) {
      emit({ type: 'error', message: 'Priority assessment is disabled for this workspace' });
      emit({ type: 'complete' });
      return { skipped: true, reason: PRIORITY_ASSESSMENT_DISABLED_REASON };
    }

    if (isPriorityAssessmentAfterHours && !assignmentConfig?.priorityAssessmentAfterHoursEnabled) {
      emit({ type: 'error', message: 'After-hours priority assessment is disabled for this workspace' });
      emit({ type: 'complete' });
      return { skipped: true, reason: 'priority_assessment_after_hours_disabled' };
    }

    // ── Duplicate-burst guard (automatic triggers only) ─────────────────
    // Same requester + same normalized subject within a 15-minute window ⇒
    // link as duplicate of the first copy and skip the LLM entirely (one
    // triage per burst, not one per click — see the 2026-07-13 MS Teams app
    // storm: 12 identical tickets in 84s, 12 full AI runs). Manual triggers
    // bypass the guard so an admin can always force a real run.
    // Per-workspace opt-out (Phase DB): `duplicateBurstEnabled === false`
    // disables the guard entirely — some teams' legitimate requests share
    // subjects and differ only in the body, which the guard never reads.
    // Null/missing keeps today's behavior (default ON), matching the
    // competencyFeedbackEnabled !== false convention.
    if (!isManual && !reboundFrom && assignmentConfig?.duplicateBurstEnabled === false) {
      logger.debug('Duplicate-burst guard skipped: disabled for this workspace', {
        ticketId, workspaceId, triggerSource,
      });
    } else if (!isManual && !reboundFrom) {
      try {
        const { default: duplicateBurstService } = await import('./duplicateBurstService.js');
        const original = await duplicateBurstService.detectBurstDuplicate(ticketId, workspaceId);
        if (original) {
          const run = await duplicateBurstService.dismissAsDuplicate(ticketId, workspaceId, original, triggerSource);
          this._broadcastRunUpdate(workspaceId, ticketId, run.id, 'completed');
          emit({ type: 'error', message: `Duplicate of ticket #${original.freshserviceTicketId || original.nativeNumber} — AI run skipped` });
          emit({ type: 'complete', runId: run.id });
          return { skipped: true, reason: 'duplicate_burst', duplicateOfTicketId: original.id, runId: run.id };
        }
      } catch (err) {
        logger.warn('Duplicate-burst guard failed (non-fatal, continuing with run)', {
          ticketId, workspaceId, error: err.message,
        });
      }
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

        if (priorityAssessmentEnabled && assignmentConfig?.priorityAssessmentAfterHoursEnabled) {
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

    this._broadcastRunUpdate(workspaceId, ticketId, run.id, 'running');
    return this._executeRun(run.id, ticketId, workspaceId, triggerSource, pipelineStart, emit, signal);
  }

  /**
   * Workspace-wide SSE ping so ticket surfaces (queue rows, peek, detail) can
   * live-update AI run state without polling. Dynamic import keeps this free
   * of route/service import cycles; failures are best-effort silent.
   */
  async _broadcastRunUpdate(workspaceId, ticketId, runId, status, decision = null, extra = null) {
    try {
      const { sseManager } = await import('../routes/sse.routes.js');
      sseManager.broadcast('ticket-change', {
        action: 'pipeline', workspaceId, ticketId, runId, status, decision,
        ...(extra || {}),
      }, workspaceId);
    } catch { /* SSE is optional plumbing */ }
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
    this._broadcastRunUpdate(workspaceId, ticketId, run.id, 'queued');
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
      // NT-1 never_noise veto, defense-in-depth: the child run already
      // applies the veto itself (its decision becomes pending_review, so we
      // would not land here), but never trust a noise dismissal for the
      // short-circuit without re-checking the deterministic rules.
      const afterHoursVeto = await this._evaluateNoiseVeto(ticketId, workspaceId);
      if (afterHoursVeto?.vetoed) {
        logger.warn('Pipeline after-hours noise dismissal vetoed by never_noise rule — queueing business-hours assignment run anyway', {
          ticketId,
          workspaceId,
          triggerSource,
          priorityRunId,
          ruleId: afterHoursVeto.ruleId,
          ruleName: afterHoursVeto.ruleName,
        });
        emit({
          type: 'noise_veto',
          ruleId: afterHoursVeto.ruleId,
          ruleName: afterHoursVeto.ruleName,
          message: `Noise veto: rule "${afterHoursVeto.ruleName}" — this ticket can never be auto-dismissed.`,
        });
      } else {
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
   * Workspace's custom terminal-BASE status names (Phase 8b) for the
   * eligibility check — resolved from the ticket row's workspaceId when
   * present (statusService caches per workspace, 60s). Empty when the row is
   * missing or workspace-less, which degrades to the canonical-only check.
   */
  async _customTerminalNames(ticket) {
    if (!ticket?.workspaceId) return [];
    try {
      return await statusService.statusNamesForBase(ticket.workspaceId, ['Resolved', 'Closed']);
    } catch { return []; }
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
      select: { workspaceId: true, status: true, assignedTechId: true },
    });
    const blocker = getLocalTicketQueueBlocker(ticket, await this._customTerminalNames(ticket));
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

    const localBlocker = getLocalTicketQueueBlocker(ticket, await this._customTerminalNames(ticket));
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
        // Pipeline bookkeeping (TU-1): the AI lane noticed FS moved on.
        actorKind: 'ai',
        source: 'assignment_pipeline',
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
  async drainQueuedRuns(workspaceId, maxPerTick = 10, concurrency = 10) {
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

    // Runs execute CONCURRENTLY (up to `concurrency`) — a serial drain at
    // ~60-90s per run meant a 40-deep morning queue took an hour to clear.
    // Claims are atomic (claimQueuedRun), the pipeline already tolerates
    // parallel runs (per-ticket open-run dedupe), and LLM/FS throughput is
    // governed by the provider gateway + shared FS limiter respectively.
    const processOne = async (run) => {
      const claimed = await assignmentRepository.claimQueuedRun(run.id);
      if (!claimed) {
        logger.debug('Queue drain: claim failed (already claimed)', { runId: run.id });
        return;
      }
      // Tell live queue rows the run left 'queued' — without this, tickets
      // picked up from the business-hours queue started silently and the
      // page only learned on manual refresh.
      this._broadcastRunUpdate(workspaceId, run.ticketId, run.id, 'running');

      const validation = await this.validateQueuedRun(run, {
        liveCheck: !!validationClient,
        client: validationClient,
      });
      if (!validation.valid) {
        await assignmentRepository.markRunSkippedStale(run.id, validation.reason);
        this._broadcastRunUpdate(workspaceId, run.ticketId, run.id, 'skipped');
        logger.info('Queue drain: skipped stale run', { runId: run.id, ticketId: run.ticketId, reason: validation.reason });
        skipped++;
        return;
      }

      try {
        logger.info('Queue drain: processing queued run', { runId: run.id, ticketId: run.ticketId, workspaceId });
        await this._executeRun(run.id, run.ticketId, workspaceId, run.triggerSource, Date.now(), () => {}, null);
        processed++;
      } catch (error) {
        logger.error('Queue drain: run failed', { runId: run.id, error: error.message });
      }
    };

    const pool = Math.max(1, Math.min(concurrency, queued.length));
    let cursor = 0;
    await Promise.all(Array.from({ length: pool }, async () => {
      while (cursor < queued.length) {
        const run = queued[cursor];
        cursor += 1;
        await processOne(run);
      }
    }));

    logger.info('Queue drain complete', { workspaceId, found: queued.length, processed, skipped, concurrency: pool });
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
    const priorityAssessmentEnabled = isPriorityAssessmentEnabled(assignmentConfig);

    if (assignmentConfig?.feedbackContext) {
      systemPrompt += `\n\n## Historical Admin Feedback\n${assignmentConfig.feedbackContext.slice(-4000)}`;
    }

    systemPrompt += '\n\n## Time Handling\nTreat the workspace current date/time supplied in the user message as the source of truth for what "today" means. Tool outputs expose ticket and decision timestamps in workspace-local time unless explicitly labeled as UTC. Agent availability includes each technician\'s own local date/time. Historical admin feedback may contain legacy UTC timestamps from older runs, so prefer current workspace-local timestamps when there is any ambiguity.';
    if (!priorityAssessmentEnabled) {
      systemPrompt += '\n\n## Workspace Priority Controls\nPriority assessment is disabled for this workspace. The submit_recommendation schema may still require priority fields for compatibility, but Ticket Pulse will not save those priority fields to the ticket or write them to FreshService. Do not spend extra tool calls or analysis turns only to refine priority.';
    } else if (assignmentConfig?.priorityWritebackEnabled === false) {
      systemPrompt += '\n\n## Workspace Priority Controls\nAssess priority for Ticket Pulse audit, but FreshService native priority writeback is disabled for this workspace. Ticket Pulse will save the assessed priority locally only.';
    }
    if (triggerSource === 'classification_only') {
      systemPrompt += '\n\n## Classification-only Mode\nThis ticket is already assigned or self-picked. Ticket Pulse must classify it, but must not change its assignee, close it, or add an assignment note. Focus on selecting the best existing internal top-level category/subcategory, priority, and FreshService ticket type. Use get_ticket_details and get_ticket_categories first; use similar-ticket search only if needed. Still call submit_recommendation so the selected category/subcategory, assessed priority, and ticket type are saved. If the schema requires recommendations, keep them aligned with the current assignee context; the system will ignore assignment recommendations and will only sync Ticket Pulse category fields plus allowed priority/type fields.';
    } else if (isPriorityAssessmentOnly) {
      systemPrompt += '\n\n## Priority-assessment-only Mode\nThis run exists to assess and persist Ticket Pulse priority for an active ticket. Still inspect and classify the ticket enough to produce valid structured output, but do not change the assignee and do not write an assignment recommendation as an action request. If the ticket is non-actionable noise/FYI, submit an empty recommendations array with closureNoticeHtml; the system will apply the workspace noise-dismissal policy. Do not call get_agent_availability, find_matching_agents, get_assignment_risk_signals, get_routing_boundary_context, get_requester_site_context, get_workload_stats, get_tech_ticket_history, or get_technician_ad_profile unless one of those tools is directly needed as evidence for priority or classification. Call submit_recommendation so assessedPriority, priorityRationale, priorityConfidence, and optional prioritySignals are saved for Ticket Pulse priority handling.';
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

    // Per-workspace ticket-type vocabulary: the submit_recommendation
    // ticketType enum + guidance come from the workspace's type registry.
    // Single-type workspaces skip the question; the type is stamped below.
    const { tools: wsTools, autoType: autoTicketType } = await applyWorkspaceTicketTypes(tools, workspaceId);
    tools = wsTools;

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
          // A single tool turn normally takes 5–20s (whole runs: p99 97s over
          // 4.4k prod runs). Without a cap, one hung LLM stream wedges the run
          // in 'running' indefinitely — the queue then shows an "analyzing"
          // halo until the watchdog reaps it. 2 min is generous headroom; on
          // timeout the gateway aborts the attempt and fails over / errors the
          // run cleanly (broadcast fires, the row clears).
          attemptTimeoutMs: 120000,
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
              let normalizedFromString = false;
              try {
                recommendation = await normalizeSubmitRecommendationPayload(block.input, workspaceId);
                normalizedFromString = Boolean(recommendation.__normalizedFromString);
                delete recommendation.__normalizedFromString;
                // Single-type workspace: the schema never asked for a type —
                // stamp the only configured one so persistence/write-back and
                // review surfaces stay uniform.
                if (autoTicketType && !recommendation.ticketType) {
                  recommendation.ticketType = autoTicketType;
                  recommendation.ticketTypeRationale = 'Only ticket type configured for this workspace';
                  recommendation.ticketTypeConfidence = 'high';
                }
              } catch (err) {
                accepted = false;
                validationError = err.message;
                logger.warn('submit_recommendation rejected by schema validation', {
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
                output: accepted ? { accepted: true, normalizedFromString } : { accepted: false, error: validationError },
                errorMessage: validationError,
                durationMs: 0,
              });

              emit({ type: 'tool_call', name: block.name, input: block.input, toolUseId: block.id });
              this._broadcastRunUpdate(workspaceId, ticketId, runId, 'running', null, { step: stepCounter, tool: 'submit_recommendation' });
              const toolResult = accepted ? { accepted: true, normalizedFromString } : { accepted: false, error: validationError };
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
            // Live queue progress: rows show which stage the analysis is at
            // ("reading the ticket · step 2"). Fire-and-forget, tiny payload.
            this._broadcastRunUpdate(workspaceId, ticketId, runId, 'running', null, { step: stepCounter, tool: block.name });
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

      // NT-1 deterministic noise veto: when the LLM's verdict is "noise"
      // (empty recommendations array) but an admin never_noise rule matches
      // the ticket, the run must NEVER finalize as noise_dismissed — it is
      // forced to pending_review below and auto-close is suppressed. This is
      // a hard rule that outranks any prompt/model behavior.
      let noiseVeto = null;
      if (isNoise) {
        noiseVeto = await this._evaluateNoiseVeto(ticketId, workspaceId);
      }

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

      // Group exclusion / observation: one groupId lookup feeds both.
      // - excludedGroupIds: force pending_review even with autoAssign=true
      //   (the admin still sees the recommendation, must approve manually).
      // - observeOnlyGroupIds (mock mode): the run records what WOULD have
      //   happened, but the pipeline writes NOTHING to the ticket — no
      //   assignment, no noise flag, no category/priority/type persistence,
      //   no FS write-back. Built for onboarding observation windows (AR).
      let groupExcluded = false;
      let excludedGroupName = null;
      let groupObserved = false;
      let observedGroupId = null;
      if (recommendation) {
        try {
          const ticketRow = await prisma.ticket.findUnique({
            where: { id: ticketId },
            select: { groupId: true },
          });
          if (isGroupExcluded(ticketRow?.groupId, assignmentConfig?.observeOnlyGroupIds)) {
            groupObserved = true;
            observedGroupId = ticketRow?.groupId;
            logger.info('Pipeline: ticket group is in observe-only mode — recording the recommendation, writing nothing', {
              runId, ticketId, groupId: String(ticketRow.groupId),
            });
          }
          if (!isNoise && assignmentConfig?.autoAssign
            && isGroupExcluded(ticketRow?.groupId, assignmentConfig?.excludedGroupIds)) {
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
          logger.debug('Could not check group exclusion/observation for ticket', { runId, error: err.message });
        }
      }

      let decision = resolvePipelineDecision({
        recommendation,
        triggerSource,
        isPriorityAssessmentOnly,
        isNoise,
        llmIgnoredRebound,
        groupExcluded,
        groupObserved,
        autoAssign: assignmentConfig?.autoAssign,
      });

      // Apply the never_noise veto: the dismissal becomes a pending review
      // with an explicit trace step so the run detail shows WHY the ticket
      // survived the AI's noise verdict.
      let noiseVetoApplied = false;
      if (decision === 'noise_dismissed' && noiseVeto?.vetoed) {
        decision = 'pending_review';
        noiseVetoApplied = true;
        const vetoMessage = `Noise veto: rule "${noiseVeto.ruleName}" — this ticket can never be auto-dismissed.`;
        stepCounter++;
        await assignmentRepository.createPipelineStep({
          pipelineRunId: runId,
          stepNumber: stepCounter,
          stepName: 'noise_veto',
          status: 'completed',
          durationMs: 0,
          output: {
            kind: 'noise_veto',
            ruleId: noiseVeto.ruleId,
            ruleName: noiseVeto.ruleName,
            message: vetoMessage,
            llmVerdict: 'noise',
            forcedDecision: 'pending_review',
          },
        }).catch((stepError) => {
          logger.warn('Pipeline: failed to record noise_veto step', { runId, error: stepError.message });
        });
        emit({ type: 'noise_veto', ruleId: noiseVeto.ruleId, ruleName: noiseVeto.ruleName, message: vetoMessage });
        logger.info('Pipeline noise dismissal vetoed by never_noise rule — forcing pending_review', {
          runId, ticketId, workspaceId, ruleId: noiseVeto.ruleId, ruleName: noiseVeto.ruleName,
        });
      }

      const finalStatus = recommendation ? 'completed' : 'failed_schema_validation';
      let errorMessage = recommendation ? null : 'Could not extract structured recommendation from LLM output';
      if (noiseVetoApplied) {
        // The "Noise veto:" prefix is what the run detail page keys on to
        // render the veto strip — keep this format stable.
        errorMessage = `Noise veto: rule "${noiseVeto.ruleName}" — this ticket can never be auto-dismissed. The AI marked it as noise, but the run was held for manual review.`;
      } else if (llmIgnoredRebound) {
        errorMessage = `LLM re-suggested ${topRec.techName || `tech #${topRec.techId}`}, who already rejected this ticket — downgraded to pending_review for manual handling.`;
      } else if (groupObserved) {
        errorMessage = assignmentConfig?.observeCategoryWritebackEnabled
          ? `Group #${observedGroupId} is in observe-only mode — the category was applied; assignment${isNoise ? ' and the noise verdict' : ''} stayed a recorded suggestion.`
          : `Group #${observedGroupId} is in observe-only mode — the recommendation${isNoise ? ' (looks like noise)' : ''} was recorded but nothing was changed on the ticket.`;
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
        || (decision === 'noise_dismissed' && assignmentConfig?.autoCloseNoise && !noiseVetoApplied);

      const observeApplyCategories = groupObserved && assignmentConfig?.observeCategoryWritebackEnabled === true;
      if (recommendation && groupObserved) {
        // Observe-only: the run carries the full recommendation (category,
        // priority, type, noise verdict) for the review queue, but the
        // ticket itself is left exactly as it arrived — EXCEPT the category
        // when the workspace opted into the observation carve-out (accounting
        // wants AR tickets categorized while assignment stays mocked).
        if (observeApplyCategories) {
          await this._persistInternalClassification(ticketId, workspaceId, recommendation);
        }
        logger.info(`Pipeline: observe-only group — ${observeApplyCategories ? 'applied category only; ' : ''}skipped ${observeApplyCategories ? '' : 'classification/'}priority/type/noise ticket writes`, {
          runId, ticketId, workspaceId,
        });
      } else if (recommendation) {
        await this._persistInternalClassification(ticketId, workspaceId, recommendation);
        if (priorityAssessmentEnabled) {
          await this._persistPriorityAssessment(ticketId, runId, recommendation);
        } else {
          logger.info('Pipeline priority assessment persistence skipped by workspace setting', {
            runId,
            ticketId,
            workspaceId,
          });
        }
        await this._persistTicketTypeAssessment(ticketId, runId, recommendation, workspaceId);
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
      this._broadcastRunUpdate(workspaceId, ticketId, runId, finalStatus, recommendation ? decision : null);

      logger.info('Pipeline completed', {
        runId, ticketId, status: finalStatus, decision: recommendation ? decision : null,
        turns: stepCounter, durationMs: Date.now() - pipelineStart, totalTokens,
      });

      if (recommendation && finalStatus === 'completed') {
        const priorityWritebackSkipReason = priorityAssessmentEnabled
          ? priorityWritebackSkipReasonForTrigger(triggerSource, assignmentConfig)
          : PRIORITY_ASSESSMENT_DISABLED_REASON;
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
          logger.info('FreshService priority writeback skipped', {
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

        if (recommendation.ticketType || recommendation.assessedTicketType) {
          await freshServiceActionService.executeTicketTypeWriteback(
            runId,
            workspaceId,
            assignmentConfig?.dryRunMode ?? true,
          ).catch((err) => {
            logger.warn('FreshService ticket type writeback failed', { runId, decision, error: err.message });
            return null;
          });
        }

        // Auto-categorize: even when the ASSIGNMENT decision waits for a human
        // (pending_review) or the run was priority-only (after-hours escalation
        // classifies anyway), the AI's category flows to FreshService. Decisions
        // that trigger the full sync below already write categories there —
        // this covers only the human-gated paths. Observed groups join in only
        // via the observation carve-out (otherwise they never persisted a
        // category and the writeback would no-op with 'no_category' anyway).
        if (assignmentConfig?.autoCategorizeEnabled && (!groupObserved || observeApplyCategories)
          && (decision === 'pending_review' || decision === 'priority_only')) {
          await freshServiceActionService.executeCategoryWriteback(
            runId,
            workspaceId,
            assignmentConfig?.dryRunMode ?? true,
          ).catch((err) => {
            logger.warn('FreshService category writeback failed', { runId, decision, error: err.message });
            return null;
          });
        }
      }

      // FreshService write-back — separate logic for assignments vs noise.
      // The 'synced' broadcast fires AFTER the fire-and-forget sync finishes:
      // that's when the local mirror (assignee, category fields, status) has
      // actually changed, so live queue rows refetch once the data is real —
      // the earlier 'completed' broadcast predates these writes.
      if (decision === 'auto_assigned' || decision === 'classified_only') {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true)
          .catch((err) => logger.warn('FreshService pipeline sync failed', { runId, decision, error: err.message }))
          .then(() => this._broadcastRunUpdate(workspaceId, ticketId, runId, 'synced', decision));
      } else if (decision === 'noise_dismissed' && assignmentConfig?.autoCloseNoise && !noiseVetoApplied) {
        freshServiceActionService.execute(runId, workspaceId, assignmentConfig?.dryRunMode ?? true)
          .catch((err) => logger.warn('FreshService auto-close noise failed', { runId, error: err.message }))
          .then(() => this._broadcastRunUpdate(workspaceId, ticketId, runId, 'synced', decision));
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
      this._broadcastRunUpdate(workspaceId, ticketId, runId, 'failed');
      return await assignmentRepository.getPipelineRun(runId);
    }
  }

  /**
   * NT-1: deterministic never_noise veto lookup for a ticket. Loads the
   * fields the veto rules match against (subject, description, category
   * name) and delegates to noiseRuleService.evaluateNeverNoise. Fails open
   * (no veto) on lookup errors — a veto miss keeps existing behavior, and
   * a DB outage here would have failed the run elsewhere anyway.
   *
   * @returns {Promise<{vetoed: boolean, ruleId: number|null, ruleName: string|null}>}
   */
  async _evaluateNoiseVeto(ticketId, workspaceId) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          subject: true,
          description: true,
          descriptionText: true,
          category: true,
          internalCategory: { select: { name: true } },
        },
      });
      if (!ticket) return { vetoed: false, ruleId: null, ruleName: null };
      return await noiseRuleService.evaluateNeverNoise(workspaceId, {
        subject: ticket.subject,
        description: ticket.descriptionText || ticket.description,
        category: ticket.internalCategory?.name || ticket.category,
      });
    } catch (error) {
      logger.warn('Pipeline never_noise veto check failed — leaving the noise decision unvetoed', {
        ticketId,
        workspaceId,
        error: error.message,
      });
      return { vetoed: false, ruleId: null, ruleName: null };
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

  async _persistTicketTypeAssessment(ticketId, runId, recommendation, workspaceId) {
    let data = null;
    try {
      data = await buildTicketTypeTicketUpdateFields(recommendation, runId, new Date(), workspaceId);
    } catch (err) {
      logger.warn('Assessed ticket type not in workspace registry — skipping persist', {
        ticketId, runId, workspaceId, error: err.message,
      });
      return;
    }
    if (!data) return;

    try {
      // TP-born tickets have no FreshService owner for the Type field, and the
      // FS write-back path (the only other place ticketType is set from an AI
      // answer) skips TP-native types entirely — so without this promotion a
      // custom registry type like "QA Test" could never become the ticket's
      // visible type, only its assessment.
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { origin: true },
      });
      if (ticket?.origin === TICKET_ORIGIN.TICKETPULSE && data.assessedTicketType) {
        data.ticketType = data.assessedTicketType;
      }
      await prisma.ticket.update({
        where: { id: ticketId },
        data,
      });
    } catch (err) {
      logger.warn('Failed to persist assessed ticket type', {
        ticketId,
        runId,
        error: err.message,
      });
    }
  }

  async _persistInternalClassification(ticketId, workspaceId, recommendation) {
    const rawCategoryId = Number(recommendation?.internalCategoryId);
    const rawSubcategoryId = Number(recommendation?.internalSubcategoryId);
    let categoryId = Number.isInteger(rawCategoryId) ? rawCategoryId : null;
    let subcategoryId = Number.isInteger(rawSubcategoryId) ? rawSubcategoryId : null;

    // Repair pass: some models (first seen with claude-sonnet-5) omit the
    // explicit IDs while still naming their pick in ticketClassification
    // ("Parent > Subcategory"). Resolve those names against the live taxonomy
    // so the ticket doesn't silently stay uncategorized.
    const categoryFitRaw = String(recommendation?.categoryFit || '').toLowerCase();
    if (!categoryId && !subcategoryId && categoryFitRaw !== 'none') {
      const names = String(recommendation?.ticketClassification || '')
        .split('>')
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 2);
      if (names.length) {
        try {
          const matches = await prisma.competencyCategory.findMany({
            where: {
              workspaceId,
              isActive: true,
              OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' } })),
            },
            select: { id: true, name: true, parentId: true },
          });
          // Names are only unique per parent: with a resolved parent the
          // child must live UNDER that parent; without one, accept a child
          // only when its name is unambiguous workspace-wide — never pick an
          // arbitrary same-named sibling from another parent.
          const parent = matches.find((c) => !c.parentId);
          const childMatches = matches.filter((c) => c.parentId);
          const child = parent
            ? (childMatches.find((c) => c.parentId === parent.id) || null)
            : (childMatches.length === 1 ? childMatches[0] : null);
          categoryId = parent?.id || child?.parentId || null;
          subcategoryId = child?.id || null;
          if (categoryId || subcategoryId) {
            logger.warn('Categorization repair: LLM omitted category IDs; resolved from ticketClassification names', {
              ticketId, workspaceId, names, categoryId, subcategoryId,
            });
          } else {
            logger.warn('Categorization missing: LLM omitted category IDs and names did not resolve', {
              ticketId, workspaceId, ticketClassification: recommendation?.ticketClassification || null, categoryFit: categoryFitRaw,
            });
          }
        } catch (resolveError) {
          logger.warn('Categorization repair failed', { ticketId, error: resolveError.message });
        }
      }
    }

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

      const priorClassification = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { internalCategoryId: true, internalSubcategoryId: true },
      });

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

      // Custom agent alerts (fire-and-forget). Category-scoped "new ticket"
      // alerts evaluate at sync/create time — before AI categorization — so on
      // the FS route they'd never match. When a ticket gets its FIRST category
      // here, fire 'created' so those alerts work; when an existing category
      // actually changes, fire 're-categorized'. (Coalescing dedups the common
      // case where the sync-time 'created' is still buffered.)
      const hadCategory = priorClassification?.internalCategoryId !== null && priorClassification?.internalCategoryId !== undefined;
      const changed = priorClassification
        && (priorClassification.internalCategoryId !== safeCategoryId
          || priorClassification.internalSubcategoryId !== (safeSubcategoryId || null));
      if (!hadCategory && safeCategoryId) {
        import('./agentAlertService.js').then(({ default: s }) => s.evaluate('created', ticketId)).catch(() => {});
      } else if (changed) {
        import('./agentAlertService.js').then(({ default: s }) => s.evaluate('recategorized', ticketId)).catch(() => {});
      }
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

  /**
   * Independent queue-drain worker. Previously the only thing that drained
   * business-hours-queued runs was a block inside the FreshService sync cron —
   * so if FS sync was off/paused/erroring (or a workspace runs native ticketing
   * with no FS sync), after-hours queued runs never processed. This worker owns
   * draining on its own cadence: every tick, for each active workspace, if there
   * are queued runs AND it's inside business hours, drain them. Business-hours
   * gating means overnight/holiday tickets wait and process when hours resume.
   */
  startQueueDrainWorker({ intervalMs = 120000 } = {}) {
    if (this._drainTimer) return;
    const tick = async () => {
      try {
        // Watchdog: recover runs whose analysis stalled (a hung LLM/tool call,
        // or a restart the startup sweep somehow missed) so no ticket pins on
        // "analyzing" indefinitely. Prod data (4.4k runs/30d): p99 = 97s,
        // all-time max = 5.5 min — 7 min of zero progress is definitively dead.
        // The per-turn attemptTimeoutMs makes this a rare backstop.
        await this.reconcileStuckAnalysisRuns({ olderThanMs: 7 * 60 * 1000, broadcast: true })
          .catch((e) => logger.warn(`[stuck-run watchdog] ${e.message}`));
        const { default: workspaceRepository } = await import('./workspaceRepository.js');
        const workspaces = await workspaceRepository.getAllActive();
        for (const ws of workspaces) {
          try {
            await this._queueMissedTickets(ws.id).catch((e) => logger.warn(`[missed-ticket sweep] ws ${ws.id}: ${e.message}`));
            await this._retryOrphanedSyncs(ws.id).catch((e) => logger.warn(`[orphan-sync retry] ws ${ws.id}: ${e.message}`));
            const queuedCount = await assignmentRepository.countQueuedRuns(ws.id);
            if (queuedCount === 0) continue;
            const tz = ws.defaultTimezone || 'America/Los_Angeles';
            const bh = await availabilityService.isBusinessHours(new Date(), tz, ws.id);
            if (!bh.isBusinessHours) continue;
            logger.info(`[queue-drain] Draining ${queuedCount} queued run(s) for workspace ${ws.id} (${ws.name})`);
            await this.drainQueuedRuns(ws.id, 10, 10);
          } catch (err) {
            logger.error(`[queue-drain] workspace ${ws.id} failed: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error(`[queue-drain] tick failed: ${err.message}`);
      }
    };
    // Kick once shortly after boot, then on the interval.
    this._drainTimer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    this._drainKick = setTimeout(() => { tick().catch(() => {}); }, 15000);
    logger.info(`Assignment queue-drain worker started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  /**
   * Safety net for trigger gaps: a ticket that never got ANY pipeline run
   * (webhook lost AND the poll cursor moved past it, e.g. during a deploy
   * restart window) used to sit unassigned until a human noticed — four
   * invoice tickets sat 15+ hours during the Jul 8 incident. Sweep recent
   * open/unassigned/non-noise tickets with zero runs and queue them; the
   * drain executes during business hours with its usual validation.
   *
   * Deliberately bounded so it can't over-guardrail or double-run:
   *  - 15-min grace: the normal webhook/poll path always gets first shot;
   *  - 48h horizon: never resurrects old backlog;
   *  - NOT EXISTS *any* run: a ticket touched once is never re-triggered here
   *    (the stuck-run auto-retry owns that case, with its own 3-attempt cap);
   *  - max 10/tick + drain-time eligibility re-validation + the open-run
   *    dedupe guard prevent duplicate or concurrent runs.
   */
  async _queueMissedTickets(workspaceId) {
    const config = await assignmentRepository.getConfig(workspaceId);
    if (!config?.isEnabled) return;
    // Open/Pending-BASE names from the workspace registry (Phase 8b),
    // interpolated via Prisma.join so they stay parameterized.
    const openNames = await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']);
    const missed = await prisma.$queryRaw`
      SELECT t.id FROM tickets t
      WHERE t.workspace_id = ${workspaceId}
        AND t.assigned_tech_id IS NULL
        AND t.status IN (${Prisma.join(openNames)})
        AND COALESCE(t.is_noise, false) = false
        AND t.created_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM assignment_pipeline_runs r WHERE r.ticket_id = t.id)
      ORDER BY t.created_at
      LIMIT 10`;
    // Second net (QA 07-09): tickets that RE-ENTERED the queue after their
    // run completed. Two IT tickets sat unassigned for a day because the AI
    // had dismissed them as noise weeks earlier, then the dismissal was
    // undone (reopened in FS / noise flag cleared) — and every trigger path
    // skips tickets that already have a completed run. Detect the state
    // mismatch (last decision says noise, ticket says not-noise) and re-run.
    // The 12h no-recent-run guard caps re-checks at ~2/day even if the AI
    // keeps calling it noise and something keeps clearing the flag.
    const reentered = await prisma.$queryRaw`
      SELECT t.id FROM tickets t
      WHERE t.workspace_id = ${workspaceId}
        AND t.assigned_tech_id IS NULL
        AND t.status IN (${Prisma.join(openNames)})
        AND COALESCE(t.is_noise, false) = false
        AND t.updated_at > NOW() - INTERVAL '48 hours'
        AND (SELECT r.decision FROM assignment_pipeline_runs r
             WHERE r.ticket_id = t.id AND r.status = 'completed'
             ORDER BY r.id DESC LIMIT 1) = 'noise_dismissed'
        AND NOT EXISTS (SELECT 1 FROM assignment_pipeline_runs r
                        WHERE r.ticket_id = t.id
                          AND (r.status IN ('running', 'queued') OR r.created_at > NOW() - INTERVAL '12 hours'))
      LIMIT 10`;

    const toQueue = [
      ...missed.map((r) => ({ id: r.id, reason: 'Safety net: no pipeline run was ever created for this ticket' })),
      ...reentered.map((r) => ({ id: r.id, reason: 'Re-check: ticket is back in the queue after its noise dismissal was undone' })),
    ];
    if (toQueue.length === 0) return;
    for (const row of toQueue) {
      await prisma.assignmentPipelineRun.create({
        data: {
          ticketId: row.id,
          workspaceId,
          status: 'queued',
          triggerSource: 'poll',
          queuedAt: new Date(),
          queuedReason: row.reason,
        },
      });
    }
    logger.warn(`[missed-ticket sweep] queued ${toQueue.length} ticket(s) (${missed.length} never-ran, ${reentered.length} re-entered)`, {
      workspaceId,
      ticketIds: toQueue.map((r) => r.id),
    });
  }

  /**
   * Re-drive FS write-backs whose sync never completed (null/pending after a
   * restart, or transient failures like a FreshService 500). syncService runs
   * the same recovery at the END of each full sync cycle — but a cycle that
   * aborts (deploy restart, sync error) never reaches its tail: on Jul 8 five
   * consecutive ws1 cycles died mid-flight and a decided auto-assign sat
   * unsynced for 40+ minutes. This worker tick always completes, so recovery
   * no longer depends on sync-cycle luck. Double-execution is safe: success
   * flips syncStatus to 'synced' (no longer matched), failure bumps updatedAt
   * (excluded by the 5-min cutoff until the next spaced retry), and the FS
   * write itself is idempotent.
   */
  async _retryOrphanedSyncs(workspaceId) {
    const orphans = await assignmentRepository.findOrphanedSyncRuns({ workspaceId, olderThanMinutes: 5 });
    if (orphans.length === 0) return;
    const config = await assignmentRepository.getConfig(workspaceId);
    const dryRun = config?.dryRunMode ?? true;
    logger.info(`[orphan-sync retry] re-driving ${orphans.length} incomplete FS write-back(s)`, {
      workspaceId,
      runIds: orphans.map((r) => r.id),
    });
    for (const orphan of orphans) {
      try {
        await freshServiceActionService.execute(orphan.id, workspaceId, dryRun);
      } catch (err) {
        logger.warn('[orphan-sync retry] attempt failed', { runId: orphan.id, error: err.message });
      }
    }
  }

  stopQueueDrainWorker() {
    if (this._drainTimer) {
      clearInterval(this._drainTimer);
      this._drainTimer = null;
    }
    if (this._drainKick) {
      clearTimeout(this._drainKick);
      this._drainKick = null;
    }
  }

  /**
   * Recover pipeline runs stuck in 'running'. A run only ever executes
   * in-process, so a 'running' row whose updatedAt is stale means the process
   * that owned it is gone (a deploy/restart) or the run wedged on a hung
   * LLM/tool call. Left alone the ticket pins on the "AI matching…" state
   * forever (the list reports state='analyzing' for any running row) and its
   * live view has no stream to render — exactly the "stuck for 5+ min" symptom.
   * Mark them 'failed' so the queue clears and the ticket can be re-run.
   *   olderThanMs = 0  → every running row (startup: all are orphaned by the boot)
   *   olderThanMs > 0  → only rows idle longer than that (periodic watchdog)
   */
  async reconcileStuckAnalysisRuns({ olderThanMs = 0, broadcast = false } = {}) {
    const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
    const stuck = await prisma.assignmentPipelineRun.findMany({
      where: { status: 'running', updatedAt: { lt: cutoff } },
      select: { id: true, ticketId: true, workspaceId: true },
    });
    if (stuck.length === 0) return { recovered: 0, runIds: [] };
    const reason = olderThanMs === 0
      ? 'Run interrupted — the server restarted before analysis completed (orphaned-run recovery).'
      : `Analysis stalled — no progress for over ${Math.round(olderThanMs / 60000)} minutes (watchdog recovery).`;
    await prisma.assignmentPipelineRun.updateMany({
      where: { id: { in: stuck.map((r) => r.id) } },
      data: { status: 'failed', errorMessage: reason },
    });
    logger.warn(`Recovered ${stuck.length} stuck pipeline run(s) → failed (${olderThanMs === 0 ? 'startup' : 'watchdog'})`, {
      runIds: stuck.map((r) => r.id),
    });
    if (broadcast) {
      // Nudge live queue rows so they drop the "AI matching…" state immediately.
      for (const r of stuck) {
        this._broadcastRunUpdate(r.workspaceId, r.ticketId, r.id, 'failed').catch(() => {});
      }
    }

    // Smart restart (QA 07-08): failing the stuck run used to leave the ticket
    // waiting for the poller to rediscover it — which can take a while, or
    // never happen once the poll cursor has moved past (four invoice tickets
    // sat unrun for 15+ hours during the Jul 8 incident). Re-queue eligible
    // tickets immediately; the queue-drain tick picks them up within ~2 min
    // in business hours, and drain-time validation re-checks eligibility.
    // Capped at 3 total failed runs per ticket so a genuinely broken ticket
    // can't retry-loop forever.
    let requeued = 0;
    for (const r of stuck) {
      try {
        const ticket = await prisma.ticket.findUnique({
          where: { id: r.ticketId },
          select: { status: true, assignedTechId: true, isNoise: true },
        });
        // Base-aware (Phase 8b): stuck-run retries only chase tickets whose
        // status still maps to an Open/Pending base in their workspace.
        const stuckBase = ticket ? await statusService.baseStatusOf(r.workspaceId, ticket.status) : null;
        if (!ticket || ticket.assignedTechId || !['Open', 'Pending'].includes(stuckBase) || ticket.isNoise) continue;
        const failures = await prisma.assignmentPipelineRun.count({
          where: { ticketId: r.ticketId, status: 'failed' },
        });
        if (failures >= 3) {
          logger.warn('Stuck-run auto-retry cap reached — leaving ticket for manual triage', { ticketId: r.ticketId, failures });
          continue;
        }
        const open = await assignmentRepository.getOpenPipelineRun(r.ticketId);
        if (open) continue;
        await prisma.assignmentPipelineRun.create({
          data: {
            ticketId: r.ticketId,
            workspaceId: r.workspaceId,
            status: 'queued',
            triggerSource: 'poll',
            queuedAt: new Date(),
            queuedReason: `Auto-retry after ${olderThanMs === 0 ? 'restart interruption' : 'stalled-run recovery'} (attempt ${failures + 1}/3)`,
          },
        });
        requeued += 1;
      } catch (retryError) {
        logger.warn('Stuck-run auto-retry could not queue', { ticketId: r.ticketId, error: retryError.message });
      }
    }
    if (requeued > 0) {
      logger.info(`Stuck-run recovery re-queued ${requeued} ticket(s) for automatic retry`);
    }

    return { recovered: stuck.length, runIds: stuck.map((r) => r.id) };
  }
}

export default new AssignmentPipelineService();
