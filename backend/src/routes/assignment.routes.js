import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import assignmentRepository from '../services/assignmentRepository.js';
import competencyRepository from '../services/competencyRepository.js';
import assignmentPipelineService from '../services/assignmentPipelineService.js';
import competencyAnalysisService from '../services/competencyAnalysisService.js';
import competencyPromptRepository from '../services/competencyPromptRepository.js';
import freshServiceActionService from '../services/freshServiceActionService.js';
import competencyFeedbackService from '../services/competencyFeedbackService.js';
import calibrationService from '../services/calibrationService.js';
import anthropicService from '../services/anthropicService.js';
import emailPollingService from '../services/emailPollingService.js';
import promptRepository from '../services/promptRepository.js';
import graphMailClient from '../integrations/graphMailClient.js';
import availabilityService from '../services/availabilityService.js';
import settingsRepository from '../services/settingsRepository.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { analyzeTicketActivities } from '../integrations/freshserviceTransformer.js';
import { convertToTimezone } from '../utils/timezone.js';
import { requireReviewer, requireAdmin } from '../middleware/auth.js';
import appConfig from '../config/index.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

const router = express.Router();

router.get('/freshservice-domain', requireReviewer, (req, res) => {
  const domain = appConfig.freshservice.domain;
  const fullDomain = domain?.includes('.freshservice.com') ? domain : domain ? `${domain}.freshservice.com` : null;
  res.json({ success: true, domain: fullDomain });
});

// ─── Assignment Config ──────────────────────────────────────────────────

router.get('/config', requireAdmin, asyncHandler(async (req, res) => {
  const config = await assignmentRepository.getConfig(req.workspaceId);
  res.json({
    success: true,
    data: config || {
      isEnabled: false,
      autoAssign: false,
      llmModel: 'claude-sonnet-4-6-20260217',
      maxRecommendations: 3,
      scoringWeights: null,
      pollForUnassigned: true,
      pollMaxPerCycle: 5,
      monitoredMailbox: null,
      emailPollingEnabled: false,
      emailPollingIntervalSec: 60,
      lastEmailCheckAt: null,
      autoCloseNoise: false,
      dryRunMode: true,
    },
    anthropicConfigured: anthropicService.isConfigured(),
    graphConfigured: graphMailClient.isConfigured(),
  });
}));

router.put('/config', requireAdmin, asyncHandler(async (req, res) => {
  const {
    isEnabled, autoAssign, llmModel, maxRecommendations,
    scoringWeights, classificationPrompt, categorizationPrompt,
    recommendationPrompt, pollForUnassigned, pollMaxPerCycle,
    monitoredMailbox, emailPollingEnabled, emailPollingIntervalSec,
    autoCloseNoise, dryRunMode,
  } = req.body;

  const data = {};
  if (isEnabled !== undefined) data.isEnabled = isEnabled;
  if (autoAssign !== undefined) data.autoAssign = autoAssign;
  if (llmModel !== undefined) data.llmModel = llmModel;
  if (maxRecommendations !== undefined) data.maxRecommendations = maxRecommendations;
  if (scoringWeights !== undefined) data.scoringWeights = scoringWeights;
  if (classificationPrompt !== undefined) data.classificationPrompt = classificationPrompt;
  if (categorizationPrompt !== undefined) data.categorizationPrompt = categorizationPrompt;
  if (recommendationPrompt !== undefined) data.recommendationPrompt = recommendationPrompt;
  if (pollForUnassigned !== undefined) data.pollForUnassigned = pollForUnassigned;
  if (pollMaxPerCycle !== undefined) data.pollMaxPerCycle = pollMaxPerCycle;
  if (monitoredMailbox !== undefined) data.monitoredMailbox = monitoredMailbox || null;
  if (emailPollingEnabled !== undefined) data.emailPollingEnabled = emailPollingEnabled;
  if (emailPollingIntervalSec !== undefined) data.emailPollingIntervalSec = emailPollingIntervalSec;
  if (autoCloseNoise !== undefined) data.autoCloseNoise = autoCloseNoise;
  if (dryRunMode !== undefined) data.dryRunMode = dryRunMode;

  const config = await assignmentRepository.upsertConfig(req.workspaceId, data);

  // Restart/stop email poller when config changes
  if (monitoredMailbox !== undefined || emailPollingEnabled !== undefined || emailPollingIntervalSec !== undefined) {
    if (config.emailPollingEnabled && config.monitoredMailbox) {
      emailPollingService.startForWorkspace(config);
    } else {
      emailPollingService.stopForWorkspace(req.workspaceId);
    }
  }

  res.json({ success: true, data: config });
}));

// ─── Pipeline Runs ──────────────────────────────────────────────────────

router.get('/queued', requireReviewer, asyncHandler(async (req, res) => {
  // limit defaults to 500 (was 50, which silently truncated large queues
  // and hid that the queue had problems). Also return totalCount so the UI
  // can warn when the queue exceeds the display cap.
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 2000);
  const [runs, totalCount] = await Promise.all([
    assignmentRepository.listQueuedRuns(req.workspaceId, limit),
    assignmentRepository.countQueuedRuns(req.workspaceId),
  ]);
  res.json({
    success: true,
    data: runs,
    total: runs.length,
    totalCount,
    truncated: runs.length < totalCount,
  });
}));

// ─── Queue Pruning ──────────────────────────────────────────────────────
// Mark all queued runs as skipped_stale if the underlying ticket is no
// longer eligible for assignment (closed, deleted, or assigned). Used to
// clean up after the email poller (or backfill, app restart, etc.) flooded
// the queue with non-actionable items.
router.post('/queued/prune', requireReviewer, asyncHandler(async (req, res) => {
  const queued = await assignmentRepository.listQueuedRuns(req.workspaceId, 2000);
  let pruned = 0;
  let kept = 0;
  const reasons = {};
  for (const run of queued) {
    const validation = await assignmentPipelineService.validateQueuedRun(run);
    if (!validation.valid) {
      await assignmentRepository.markRunSkippedStale(run.id, validation.reason);
      reasons[validation.reason] = (reasons[validation.reason] || 0) + 1;
      pruned++;
    } else {
      kept++;
    }
  }
  logger.info('Queue pruned', { workspaceId: req.workspaceId, pruned, kept, reasons });
  res.json({ success: true, data: { pruned, kept, reasons } });
}));

router.get('/queue-status', requireReviewer, asyncHandler(async (req, res) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    select: { defaultTimezone: true },
  });
  const tz = workspace?.defaultTimezone || 'America/Los_Angeles';
  const bh = await availabilityService.isBusinessHours(new Date(), tz, req.workspaceId);
  const queuedCount = await assignmentRepository.countQueuedRuns(req.workspaceId);

  let nextWindow = null;
  if (!bh.isBusinessHours) {
    const now = new Date();
    const hours = await availabilityService.getBusinessHours(req.workspaceId);
    const enabledDays = hours.filter((h) => h.isEnabled).sort((a, b) => a.dayOfWeek - b.dayOfWeek);

    if (enabledDays.length > 0) {
      const { toZonedTime } = await import('date-fns-tz');
      const zoned = toZonedTime(now, tz);
      const todayDow = zoned.getDay();
      const currentMinutes = zoned.getHours() * 60 + zoned.getMinutes();

      for (let offset = 0; offset < 7; offset++) {
        const checkDow = (todayDow + offset) % 7;
        const dayConfig = enabledDays.find((d) => d.dayOfWeek === checkDow);
        if (!dayConfig) continue;

        const [sh, sm] = dayConfig.startTime.split(':').map(Number);
        const startMinutes = sh * 60 + sm;

        if (offset === 0 && currentMinutes >= startMinutes) continue;

        const daysUntil = offset;
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const hour12 = sh === 0 ? 12 : sh > 12 ? sh - 12 : sh;
        const ampm = sh >= 12 ? 'PM' : 'AM';
        const timeLabel = sm > 0 ? `${hour12}:${String(sm).padStart(2, '0')} ${ampm}` : `${hour12} ${ampm}`;

        const TZ_ABBREV = {
          'America/Los_Angeles': 'PT', 'America/Vancouver': 'PT',
          'America/Denver': 'MT', 'America/Edmonton': 'MT', 'America/Calgary': 'MT',
          'America/Chicago': 'CT', 'America/Winnipeg': 'CT',
          'America/New_York': 'ET', 'America/Toronto': 'ET',
          'America/Halifax': 'AT', 'America/St_Johns': 'NT',
        };
        const tzAbbrev = TZ_ABBREV[tz] || tz.replace('America/', '');

        nextWindow = {
          dayName: dayNames[checkDow],
          startTime: dayConfig.startTime,
          timeLabel,
          timezone: tz,
          tzAbbrev,
          daysUntil,
          label: daysUntil === 0
            ? `Today at ${timeLabel} ${tzAbbrev}`
            : daysUntil === 1
              ? `Tomorrow at ${timeLabel} ${tzAbbrev}`
              : `${dayNames[checkDow]} at ${timeLabel} ${tzAbbrev}`,
        };
        break;
      }
    }
  }

  res.json({
    success: true,
    data: {
      isBusinessHours: bh.isBusinessHours,
      reason: bh.reason,
      timezone: tz,
      queuedCount,
      nextWindow,
    },
  });
}));

router.post('/runs/:id/run-now', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  if (run.status !== 'queued') {
    return res.status(400).json({ success: false, message: `Run is not queued (status: ${run.status})` });
  }

  const claimed = await assignmentRepository.claimQueuedRun(runId);
  if (!claimed) {
    return res.status(409).json({ success: false, message: 'Run already claimed by another process' });
  }

  const validation = await assignmentPipelineService.validateQueuedRun(run);
  if (!validation.valid) {
    await assignmentRepository.markRunSkippedStale(runId, validation.reason);
    return res.status(409).json({ success: false, message: validation.reason });
  }

  res.status(202).json({ success: true, message: 'Run promoted to immediate execution' });
  assignmentPipelineService._executeRun(runId, run.ticketId, run.workspaceId, 'manual', Date.now(), () => {}, null).catch((error) => {
    logger.error('Run-now execution failed', { runId, error: error.message });
  });
}));

router.get('/queue', requireReviewer, asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const assignmentStatus = ['unassigned', 'outside_assigned', 'all'].includes(req.query.assignmentStatus)
    ? req.query.assignmentStatus
    : 'all';
  const ticketStatus = ['all', 'active', 'in_progress', 'pending', 'closed_resolved', 'deleted'].includes(req.query.ticketStatus)
    ? req.query.ticketStatus
    : 'all';
  const { since, sinceField } = req.query;
  const result = await assignmentRepository.getPendingQueue(req.workspaceId, { limit, offset, assignmentStatus, ticketStatus, since, sinceField });
  res.json({ success: true, ...result });
}));

router.get('/runs', requireReviewer, asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const { status, decision, since, sinceField, decisions } = req.query;
  const decisionsArr = decisions ? decisions.split(',') : undefined;
  const ticketStatus = ['all', 'active', 'in_progress', 'pending', 'closed_resolved', 'deleted'].includes(req.query.ticketStatus)
    ? req.query.ticketStatus
    : undefined;
  const result = await assignmentRepository.getPipelineRuns(req.workspaceId, { limit, offset, status, decision, since, sinceField, decisions: decisionsArr, ticketStatus });
  res.json({ success: true, ...result });
}));

router.get('/runs/:id', requireReviewer, asyncHandler(async (req, res) => {
  const run = await assignmentRepository.getPipelineRun(parseInt(req.params.id));
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  res.json({ success: true, data: run });
}));

router.post('/runs/:id/decide', requireReviewer, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const { decision, assignedTechId, overrideReason, decisionNote, force } = req.body;

  if (!['approved', 'modified', 'rejected'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'decision must be: approved, modified, or rejected' });
  }

  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  if (run.status !== 'completed' || run.decision !== 'pending_review') {
    return res.status(409).json({
      success: false,
      message: `Run is not awaiting review (status: ${run.status}, decision: ${run.decision || 'none'})`,
    });
  }

  const decidedByEmail = req.session?.user?.email || 'unknown';

  const updated = await assignmentRepository.recordDecisionIfPending(runId, {
    decision,
    assignedTechId: assignedTechId || run.recommendation?.recommendations?.[0]?.techId,
    decidedByEmail,
    overrideReason: decision === 'modified' ? overrideReason : null,
    decisionNote: decisionNote?.trim() || null,
  });
  if (!updated) {
    return res.status(409).json({ success: false, message: 'Run was already decided or is no longer pending review' });
  }

  // Record feedback for learning (include decision note for all decisions)
  const ticket = run.ticket;
  const ticketRef = `Ticket #${ticket?.freshserviceTicketId} (${ticket?.subject || 'unknown'})`;
  const noteAppendix = decisionNote ? ` Admin note: ${decisionNote.trim()}` : '';
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    select: { defaultTimezone: true },
  });
  const workspaceTimezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const feedbackTimestamp = convertToTimezone(new Date(), workspaceTimezone);

  if (decision === 'modified' && overrideReason) {
    const feedbackEntry = `[${feedbackTimestamp}] ${ticketRef}: Admin overrode recommendation. Chosen tech ID: ${assignedTechId}. Reason: ${overrideReason}.${noteAppendix}`;
    await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
      logger.warn('Failed to append feedback', { error: err.message }),
    );
  } else if (decision === 'approved') {
    const topRec = run.recommendation?.recommendations?.[0];
    if (topRec) {
      const feedbackEntry = `[${feedbackTimestamp}] ${ticketRef}: Approved assignment to ${topRec.techName}.${noteAppendix}`;
      await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
        logger.warn('Failed to append feedback', { error: err.message }),
      );
    }
  } else if (decision === 'rejected' && decisionNote) {
    const feedbackEntry = `[${feedbackTimestamp}] ${ticketRef}: Rejected recommendation.${noteAppendix}`;
    await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
      logger.warn('Failed to append feedback', { error: err.message }),
    );
  }

  // FreshService write-back (fire-and-forget)
  if (decision === 'approved' || decision === 'modified') {
    const config = await assignmentRepository.getConfig(req.workspaceId);
    freshServiceActionService.execute(runId, req.workspaceId, config?.dryRunMode ?? true, { force: !!force }).catch((err) =>
      logger.warn('FreshService sync failed after decide', { runId, error: err.message }),
    );
  }

  // Competency feedback (fire-and-forget)
  if (decision === 'approved' || decision === 'modified') {
    const finalTechId = assignedTechId || run.recommendation?.recommendations?.[0]?.techId;
    competencyFeedbackService.processDecisionFeedback(runId, decision, finalTechId, req.workspaceId).catch((err) =>
      logger.warn('Competency feedback failed after decide', { runId, error: err.message }),
    );
  }

  res.json({ success: true, data: updated });
}));

router.delete('/runs/:id', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  if (run.status === 'running') {
    return res.status(400).json({ success: false, message: 'Cannot delete a running pipeline' });
  }
  await assignmentRepository.deletePipelineRun(runId);
  res.json({ success: true, message: 'Pipeline run deleted' });
}));

router.post('/runs/bulk-delete', requireAdmin, asyncHandler(async (req, res) => {
  const { status, decision } = req.body;
  const result = await assignmentRepository.bulkDeleteRuns(req.workspaceId, { status, decision });
  res.json({ success: true, ...result });
}));

router.post('/runs/:id/dismiss', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  if (run.status !== 'completed' || run.decision !== 'pending_review') {
    return res.status(409).json({
      success: false,
      message: `Run is not awaiting review (status: ${run.status}, decision: ${run.decision || 'none'})`,
    });
  }
  const dismissed = await assignmentRepository.dismissRunIfPending(runId, req.session?.user?.email || 'admin');
  if (!dismissed) {
    return res.status(409).json({ success: false, message: 'Run was already decided or is no longer pending review' });
  }

  const hadRecommendations = run.recommendation?.recommendations?.length > 0;

  if (!hadRecommendations) {
    // True noise (LLM produced no candidates) — sync to FreshService to close
    const config = await assignmentRepository.getConfig(req.workspaceId);
    freshServiceActionService.execute(runId, req.workspaceId, config?.dryRunMode ?? true).catch((err) =>
      logger.warn('FreshService sync failed after dismiss', { runId, error: err.message }),
    );
  } else {
    logger.info('Dismiss skipped FreshService sync: run had valid recommendations', { runId, recCount: run.recommendation.recommendations.length });
  }

  res.json({ success: true, message: 'Run dismissed' });
}));

router.post('/runs/:id/sync', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const force = req.query.force === 'true';
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  if (run.status !== 'completed' || !['approved', 'modified', 'auto_assigned', 'noise_dismissed'].includes(run.decision)) {
    return res.status(400).json({ success: false, message: 'Run is not in a syncable state' });
  }
  if (run.syncStatus === 'synced' && !force) {
    return res.status(409).json({ success: false, message: 'Run already synced. Use force=true to resync intentionally.' });
  }
  const result = await freshServiceActionService.execute(runId, req.workspaceId, false, { force });
  res.json({ success: true, data: result });
}));

router.post('/runs/:id/sync-preview', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  if (run.status !== 'completed' || !['approved', 'modified', 'auto_assigned', 'noise_dismissed'].includes(run.decision)) {
    return res.status(400).json({ success: false, message: 'Run is not in a syncable state' });
  }
  const result = await freshServiceActionService.execute(runId, req.workspaceId, true);
  res.json({ success: true, data: result });
}));

// ─── Freshness Check & Rerun ──────────────────────────────────────────────

router.get('/runs/:id/freshness', requireReviewer, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }

  const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(req.workspaceId);
  if (!fsConfig?.domain || !fsConfig?.apiKey) {
    return res.status(400).json({ success: false, message: 'FreshService not configured' });
  }

  const fsTicketId = Number(run.ticket?.freshserviceTicketId);
  if (!fsTicketId) {
    return res.json({ success: true, data: { diffs: [], fresh: true } });
  }

  const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
  const [fsTicket, fsActivities] = await Promise.all([
    client.getTicket(fsTicketId),
    client.fetchTicketActivities(fsTicketId),
  ]);

  const diffs = [];
  let currentAssigneeName = null;
  let currentGroupName = null;

  // Check if assignee has changed
  if (fsTicket?.responder_id) {
    const currentTech = await prisma.technician.findFirst({
      where: { freshserviceId: BigInt(fsTicket.responder_id) },
      select: { id: true, name: true },
    });
    currentAssigneeName = currentTech?.name || `FS Agent #${fsTicket.responder_id}`;

    const recommendedTechId = run.recommendation?.recommendations?.[0]?.techId;
    if (currentTech && recommendedTechId && currentTech.id !== recommendedTechId) {
      diffs.push('assignee_changed');
    } else if (!currentTech) {
      diffs.push('assignee_changed');
    }
  } else if (run.ticket?.assignedTechId) {
    diffs.push('assignee_changed');
  }

  // Check group
  if (fsTicket?.group_id) {
    const group = await client.getGroup(fsTicket.group_id);
    currentGroupName = group?.name || `Group #${fsTicket.group_id}`;

    const topRecTechId = run.recommendation?.recommendations?.[0]?.techId;
    if (topRecTechId) {
      const recTech = await prisma.technician.findUnique({
        where: { id: topRecTechId },
        select: { freshserviceId: true },
      });
      if (recTech && group?.agent_ids && !group.agent_ids.includes(Number(recTech.freshserviceId))) {
        diffs.push('group_incompatible');
      }
    }
  }

  // Check rejection history from episodes
  const rejectionHistory = await prisma.ticketAssignmentEpisode.findMany({
    where: { ticketId: run.ticket?.id, endMethod: 'rejected' },
    select: {
      technicianId: true,
      endedAt: true,
      technician: { select: { name: true } },
    },
    orderBy: { endedAt: 'desc' },
  });

  // Check if recommended tech already rejected this ticket
  const topRecTechId = run.recommendation?.recommendations?.[0]?.techId;
  if (topRecTechId && rejectionHistory.some((r) => r.technicianId === topRecTechId)) {
    diffs.push('rejected_by_recommended_tech');
  }

  // Analyze FS activities for bounce info
  const analysis = fsActivities?.length ? analyzeTicketActivities(fsActivities) : null;

  res.json({
    success: true,
    data: {
      fresh: diffs.length === 0,
      diffs,
      currentAssigneeName,
      currentResponderId: fsTicket?.responder_id || null,
      currentGroupId: fsTicket?.group_id || null,
      currentGroupName,
      currentStatus: fsTicket?.status || null,
      recommendedTechId: topRecTechId || null,
      recommendedTechName: run.recommendation?.recommendations?.[0]?.techName || null,
      rejectionHistory: rejectionHistory.map((r) => ({
        techId: r.technicianId,
        techName: r.technician.name,
        rejectedAt: r.endedAt,
      })),
      bounceCount: analysis?.rejectionCount || 0,
    },
  });
}));

router.post('/runs/:id/rerun', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }

  // Mark old run as superseded
  await prisma.assignmentPipelineRun.update({
    where: { id: runId },
    data: { status: 'superseded', decision: null },
  });

  // Trigger new pipeline run
  res.status(202).json({ success: true, message: 'Pipeline re-run triggered, old run superseded' });
  assignmentPipelineService.runPipeline(run.ticketId, req.workspaceId, 'manual').catch((error) => {
    logger.error('Pipeline rerun failed', { runId, ticketId: run.ticketId, error: error.message });
  });
}));

router.get('/ticket/:ticketId/latest-run', requireReviewer, asyncHandler(async (req, res) => {
  const ticketId = parseInt(req.params.ticketId);
  const run = await prisma.assignmentPipelineRun.findFirst({
    where: { ticketId, workspaceId: req.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      ticket: {
        select: {
          id: true, freshserviceTicketId: true, subject: true, status: true, priority: true,
          category: true, ticketCategory: true, assignedTechId: true, createdAt: true,
          requester: { select: { name: true, email: true, department: true } },
        },
      },
      assignedTech: { select: { id: true, name: true, email: true } },
    },
  });
  res.json({ success: true, data: run });
}));

router.post('/trigger/:ticketId', requireAdmin, asyncHandler(async (req, res) => {
  const ticketId = parseInt(req.params.ticketId);
  const stream = req.query.stream === 'true';

  logger.info('Pipeline trigger', { ticketId, workspaceId: req.workspaceId, stream });

  if (!stream) {
    res.status(202).json({ success: true, message: 'Pipeline triggered' });
    assignmentPipelineService.runPipeline(ticketId, req.workspaceId, 'manual').catch((error) => {
      logger.error('Pipeline trigger failed', { ticketId, error: error.message });
    });
    return;
  }

  // SSE streaming mode
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const abortController = new AbortController();
  let clientDisconnected = false;

  const onEvent = (event) => {
    if (clientDisconnected) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      clientDisconnected = true;
    }
  };

  req.on('close', () => {
    clientDisconnected = true;
    abortController.abort();
    logger.debug('SSE client disconnected during pipeline', { ticketId });
  });

  try {
    await assignmentPipelineService.runPipeline(ticketId, req.workspaceId, 'manual', onEvent, abortController.signal);
  } catch (error) {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }
  }

  if (!clientDisconnected) {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
}));

// ─── Email Monitoring ───────────────────────────────────────────────────

router.post('/email/test', requireAdmin, asyncHandler(async (req, res) => {
  const mailbox = req.body.mailbox;
  if (!mailbox) {
    return res.status(400).json({ success: false, message: 'mailbox is required' });
  }
  if (!graphMailClient.isConfigured()) {
    return res.status(400).json({ success: false, message: 'Azure Graph API credentials not configured on server' });
  }

  logger.info('Testing email connection', { mailbox });
  const result = await graphMailClient.testConnection(mailbox);
  logger.info('Email connection test result', { mailbox, success: result.success, message: result.message });
  res.json({ success: true, data: result });
}));

router.get('/email/status', requireAdmin, asyncHandler(async (req, res) => {
  const status = emailPollingService.getStatus(req.workspaceId);
  res.json({ success: true, data: status });
}));

router.post('/email/poll-now', requireAdmin, asyncHandler(async (req, res) => {
  if (!graphMailClient.isConfigured()) {
    return res.status(400).json({ success: false, message: 'Azure Graph API credentials not configured' });
  }

  const result = await emailPollingService.pollNow(req.workspaceId);
  res.json({ success: true, data: result });
}));

// ─── Recent Tickets (for manual trigger UI) ─────────────────────────────

router.get('/recent-tickets', requireAdmin, asyncHandler(async (req, res) => {
  await assignmentRepository.sweepStaleRunningRuns(req.workspaceId);
  const limit = parseInt(req.query.limit) || 20;
  const onlyUnassigned = req.query.unassigned === 'true';

  const where = { workspaceId: req.workspaceId };
  if (onlyUnassigned) where.assignedTechId = null;

  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      status: true,
      priority: true,
      category: true,
      assignedTechId: true,
      createdAt: true,
      requester: { select: { name: true, email: true } },
      assignedTech: { select: { name: true } },
      pipelineRuns: { select: { id: true, status: true, decision: true }, take: 1, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  res.json({ success: true, data: tickets });
}));

// ─── Prompt Management ──────────────────────────────────────────────────

router.get('/prompts', requireAdmin, asyncHandler(async (req, res) => {
  const versions = await promptRepository.getVersions(req.workspaceId);
  const published = await promptRepository.getPublished(req.workspaceId);
  res.json({ success: true, data: { versions, published } });
}));

router.get('/prompts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const version = await promptRepository.getVersion(parseInt(req.params.id));
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  res.json({ success: true, data: version });
}));

router.post('/prompts', requireAdmin, asyncHandler(async (req, res) => {
  const { systemPrompt, toolConfig, notes } = req.body;
  if (!systemPrompt?.trim()) {
    return res.status(400).json({ success: false, message: 'systemPrompt is required' });
  }
  const version = await promptRepository.createVersion(req.workspaceId, {
    systemPrompt,
    toolConfig,
    notes,
    createdBy: req.session?.user?.email,
  });
  res.status(201).json({ success: true, data: version });
}));

router.post('/prompts/:id/publish', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await promptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const published = await promptRepository.publish(id, req.session?.user?.email);
  res.json({ success: true, data: published });
}));

router.post('/prompts/:id/restore', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await promptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const draft = await promptRepository.restore(id, req.session?.user?.email);
  res.json({ success: true, data: draft });
}));

router.delete('/prompts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await promptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  if (version.status === 'published') {
    return res.status(400).json({ success: false, message: 'Cannot delete the published prompt version' });
  }
  await promptRepository.deleteVersion(id);
  res.json({ success: true, message: 'Prompt version deleted' });
}));

// ─── Tool Schemas (for UI display) ──────────────────────────────────────

router.get('/tools', requireAdmin, asyncHandler(async (req, res) => {
  const { TOOL_SCHEMAS } = await import('../services/assignmentTools.js');
  const tools = TOOL_SCHEMAS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema?.properties || {},
    required: t.input_schema?.required || [],
    type: t.type || 'custom',
  }));
  res.json({ success: true, data: tools });
}));

// ─── Category Deduplication ──────────────────────────────────────────────

router.get('/competencies/duplicates', requireAdmin, asyncHandler(async (req, res) => {
  const { findDuplicateGroups } = await import('../utils/categoryMatcher.js');
  const categories = await competencyRepository.getCategories(req.workspaceId);
  const groups = findDuplicateGroups(categories.map((c) => ({ id: c.id, name: c.name })));

  for (const group of groups) {
    const keepMappings = await competencyRepository.getTechniciansWithCompetency(req.workspaceId, group.keepId);
    group.keepTechCount = keepMappings.length;
    for (const dup of group.duplicates) {
      const dupMappings = await competencyRepository.getTechniciansWithCompetency(req.workspaceId, dup.id);
      dup.techCount = dupMappings.length;
    }
  }

  res.json({ success: true, data: groups });
}));

router.post('/competencies/merge', requireAdmin, asyncHandler(async (req, res) => {
  const { keepId, mergeIds } = req.body;
  if (!keepId || !Array.isArray(mergeIds) || mergeIds.length === 0) {
    return res.status(400).json({ success: false, message: 'keepId and mergeIds[] are required' });
  }

  const keepCat = await competencyRepository.getCategoryById(keepId);
  if (keepCat.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Category belongs to a different workspace' });
  }

  const result = await competencyRepository.mergeCategories(req.workspaceId, keepId, mergeIds);
  logger.info('Categories merged', { workspaceId: req.workspaceId, keepId, mergeIds, merged: result.merged });
  res.json({ success: true, data: result });
}));

// ─── Competency Categories ──────────────────────────────────────────────

router.get('/competencies', requireAdmin, asyncHandler(async (req, res) => {
  const categories = await competencyRepository.getCategories(req.workspaceId);
  const mappings = await competencyRepository.getAllCompetenciesForWorkspace(req.workspaceId);
  res.json({ success: true, data: { categories, mappings } });
}));

router.post('/competencies/categories', requireAdmin, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ success: false, message: 'Category name is required' });
  }
  const category = await competencyRepository.createCategory(req.workspaceId, { name: name.trim(), description });
  res.status(201).json({ success: true, data: category });
}));

router.put('/competencies/categories/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const category = await competencyRepository.getCategoryById(id);
  if (category.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Category belongs to a different workspace' });
  }
  const updated = await competencyRepository.updateCategory(id, req.body);
  res.json({ success: true, data: updated });
}));

router.delete('/competencies/categories/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const category = await competencyRepository.getCategoryById(id);
  if (category.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Category belongs to a different workspace' });
  }
  await competencyRepository.deleteCategory(id);
  res.json({ success: true, message: 'Category deleted' });
}));

// ─── Technician Competency Mappings ─────────────────────────────────────

router.get('/competencies/technician/:techId', requireAdmin, asyncHandler(async (req, res) => {
  const techId = parseInt(req.params.techId);
  const competencies = await competencyRepository.getTechnicianCompetencies(techId, req.workspaceId);
  res.json({ success: true, data: competencies });
}));

router.put('/competencies/technician/:techId', requireAdmin, asyncHandler(async (req, res) => {
  const techId = parseInt(req.params.techId);
  const { competencies } = req.body;

  if (!Array.isArray(competencies)) {
    return res.status(400).json({ success: false, message: 'competencies must be an array' });
  }

  await competencyRepository.bulkUpdateTechnicianCompetencies(techId, req.workspaceId, competencies);
  const updated = await competencyRepository.getTechnicianCompetencies(techId, req.workspaceId);
  res.json({ success: true, data: updated });
}));

// ─── Competency Analysis Pipeline ───────────────────────────────────────

router.get('/competency-prompts', requireAdmin, asyncHandler(async (req, res) => {
  const versions = await competencyPromptRepository.getVersions(req.workspaceId);
  const published = await competencyPromptRepository.getPublished(req.workspaceId);
  res.json({ success: true, data: { versions, published } });
}));

router.get('/competency-prompts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const version = await competencyPromptRepository.getVersion(parseInt(req.params.id));
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  res.json({ success: true, data: version });
}));

router.post('/competency-prompts', requireAdmin, asyncHandler(async (req, res) => {
  const { systemPrompt, toolConfig, notes } = req.body;
  if (!systemPrompt?.trim()) {
    return res.status(400).json({ success: false, message: 'systemPrompt is required' });
  }
  const version = await competencyPromptRepository.createVersion(req.workspaceId, {
    systemPrompt, toolConfig, notes, createdBy: req.session?.user?.email,
  });
  res.status(201).json({ success: true, data: version });
}));

router.post('/competency-prompts/:id/publish', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await competencyPromptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const published = await competencyPromptRepository.publish(id, req.session?.user?.email);
  res.json({ success: true, data: published });
}));

router.post('/competency-prompts/:id/restore', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await competencyPromptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const draft = await competencyPromptRepository.restore(id, req.session?.user?.email);
  res.json({ success: true, data: draft });
}));

router.get('/competency-tools', requireAdmin, asyncHandler(async (req, res) => {
  const { COMPETENCY_TOOL_SCHEMAS } = await import('../services/competencyTools.js');
  const tools = COMPETENCY_TOOL_SCHEMAS.map((t) => ({
    name: t.name, description: t.description,
    parameters: t.input_schema?.properties || {},
    required: t.input_schema?.required || [],
  }));
  res.json({ success: true, data: tools });
}));

router.post('/competencies/analyze/:techId', requireAdmin, asyncHandler(async (req, res) => {
  const techId = parseInt(req.params.techId);
  const stream = req.query.stream === 'true';
  const triggeredBy = req.session?.user?.email || 'admin';

  if (!stream) {
    res.status(202).json({ success: true, message: 'Competency analysis triggered' });
    competencyAnalysisService.runAnalysis(techId, req.workspaceId, triggeredBy).catch((error) => {
      logger.error('Competency analysis trigger failed', { techId, error: error.message });
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let clientDisconnected = false;
  const onEvent = (event) => {
    if (clientDisconnected) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { clientDisconnected = true; }
  };

  req.on('close', () => { clientDisconnected = true; });

  try {
    await competencyAnalysisService.runAnalysis(techId, req.workspaceId, triggeredBy, onEvent);
  } catch (error) {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }
  }

  if (!clientDisconnected) {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
}));

router.get('/competencies/runs', requireAdmin, asyncHandler(async (req, res) => {
  const techId = req.query.techId ? parseInt(req.query.techId) : undefined;
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const result = await competencyAnalysisService.getRuns(req.workspaceId, { technicianId: techId, limit, offset });
  res.json({ success: true, ...result });
}));

router.get('/competencies/runs/:id', requireAdmin, asyncHandler(async (req, res) => {
  const run = await competencyAnalysisService._getRunWithSteps(parseInt(req.params.id));
  if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  res.json({ success: true, data: run });
}));

router.post('/competencies/runs/:id/rollback', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const rolledBackBy = req.session?.user?.email || 'admin';
  const result = await competencyAnalysisService.rollback(runId, rolledBackBy);
  res.json({ success: true, data: result });
}));

router.post('/competencies/runs/:id/cancel', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await prisma.competencyAnalysisRun.findUnique({ where: { id: runId }, select: { status: true, workspaceId: true } });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
  if (run.workspaceId !== req.workspaceId) return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  if (run.status !== 'running') return res.status(400).json({ success: false, message: `Run is not running (status: ${run.status})` });
  await prisma.competencyAnalysisRun.update({ where: { id: runId }, data: { status: 'failed', errorMessage: 'Manually cancelled by admin' } });
  logger.info('Competency run manually cancelled', { runId });
  res.json({ success: true, message: 'Run cancelled' });
}));

router.get('/competencies/technicians', requireReviewer, asyncHandler(async (req, res) => {
  const technicians = await prisma.technician.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: {
      id: true, name: true, email: true, location: true, photoUrl: true,
      competencies: {
        include: { competencyCategory: { select: { id: true, name: true } } },
      },
      competencyRuns: {
        select: { id: true, status: true, decision: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: technicians });
}));

// ─── Calibration ────────────────────────────────────────────────────────

router.post('/calibration', requireAdmin, asyncHandler(async (req, res) => {
  const { periodStart, periodEnd, mode } = req.body;
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ success: false, message: 'periodStart and periodEnd are required' });
  }
  const calibrationMode = mode === 'prompt_only' ? 'prompt_only' : 'full';

  const stream = req.query.stream === 'true';
  const triggeredBy = req.session?.user?.email || 'admin';

  if (!stream) {
    const result = await calibrationService.runCalibration(req.workspaceId, periodStart, periodEnd, triggeredBy, null, { mode: calibrationMode });
    return res.json({ success: true, data: result });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; clearInterval(heartbeat); });

  const heartbeat = setInterval(() => {
    if (clientDisconnected) return;
    try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); } catch { /* client gone */ }
  }, 15000);

  await calibrationService.runCalibration(req.workspaceId, periodStart, periodEnd, triggeredBy, (event) => {
    if (clientDisconnected) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* client gone */ }
  }, { mode: calibrationMode });

  clearInterval(heartbeat);
  if (!clientDisconnected) {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
}));

router.get('/calibration/runs', requireAdmin, asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  const result = await calibrationService.getRuns(req.workspaceId, { limit, offset });
  res.json({ success: true, ...result });
}));

router.post('/calibration/runs/:id/cancel', requireAdmin, asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await prisma.calibrationRun.findUnique({ where: { id: runId }, select: { status: true, workspaceId: true } });
  if (!run) return res.status(404).json({ success: false, message: 'Calibration run not found' });
  if (run.workspaceId !== req.workspaceId) return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  const activeStatuses = ['running', 'collecting', 'analyzing_prompt', 'analyzing_competencies'];
  if (!activeStatuses.includes(run.status)) {
    return res.status(400).json({ success: false, message: `Run is not active (status: ${run.status})` });
  }
  await prisma.calibrationRun.update({ where: { id: runId }, data: { status: 'failed', errorMessage: 'Manually cancelled by admin' } });
  logger.info('Calibration run manually cancelled', { runId });
  res.json({ success: true, message: 'Calibration run cancelled' });
}));

router.get('/calibration/runs/:id', requireAdmin, asyncHandler(async (req, res) => {
  const run = await calibrationService._getRun(parseInt(req.params.id));
  if (!run) return res.status(404).json({ success: false, message: 'Calibration run not found' });
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  res.json({ success: true, data: run });
}));

export default router;
