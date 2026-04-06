import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import assignmentRepository from '../services/assignmentRepository.js';
import competencyRepository from '../services/competencyRepository.js';
import assignmentPipelineService from '../services/assignmentPipelineService.js';
import competencyAnalysisService from '../services/competencyAnalysisService.js';
import competencyPromptRepository from '../services/competencyPromptRepository.js';
import freshServiceActionService from '../services/freshServiceActionService.js';
import competencyFeedbackService from '../services/competencyFeedbackService.js';
import anthropicService from '../services/anthropicService.js';
import emailPollingService from '../services/emailPollingService.js';
import promptRepository from '../services/promptRepository.js';
import graphMailClient from '../integrations/graphMailClient.js';
import availabilityService from '../services/availabilityService.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ─── Assignment Config ──────────────────────────────────────────────────

router.get('/config', asyncHandler(async (req, res) => {
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

router.put('/config', asyncHandler(async (req, res) => {
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

router.get('/queued', asyncHandler(async (req, res) => {
  const runs = await assignmentRepository.listQueuedRuns(req.workspaceId, 50);
  res.json({ success: true, data: runs, total: runs.length });
}));

router.get('/queue-status', asyncHandler(async (req, res) => {
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

        nextWindow = {
          dayName: dayNames[checkDow],
          startTime: dayConfig.startTime,
          timezone: tz,
          daysUntil,
          label: daysUntil === 0
            ? `Today at ${dayConfig.startTime}`
            : daysUntil === 1
              ? `Tomorrow at ${dayConfig.startTime}`
              : `${dayNames[checkDow]} at ${dayConfig.startTime}`,
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

router.post('/runs/:id/run-now', asyncHandler(async (req, res) => {
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

router.get('/queue', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const result = await assignmentRepository.getPendingQueue(req.workspaceId, { limit, offset });
  res.json({ success: true, ...result });
}));

router.get('/runs', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const { status, decision } = req.query;
  const result = await assignmentRepository.getPipelineRuns(req.workspaceId, { limit, offset, status, decision });
  res.json({ success: true, ...result });
}));

router.get('/runs/:id', asyncHandler(async (req, res) => {
  const run = await assignmentRepository.getPipelineRun(parseInt(req.params.id));
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  res.json({ success: true, data: run });
}));

router.post('/runs/:id/decide', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const { decision, assignedTechId, overrideReason, decisionNote } = req.body;

  if (!['approved', 'modified', 'rejected'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'decision must be: approved, modified, or rejected' });
  }

  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }

  const decidedByEmail = req.session?.user?.email || 'unknown';

  const updated = await assignmentRepository.recordDecision(runId, {
    decision,
    assignedTechId: assignedTechId || run.recommendation?.recommendations?.[0]?.techId,
    decidedByEmail,
    overrideReason: decision === 'modified' ? overrideReason : null,
    decisionNote: decisionNote?.trim() || null,
  });

  // Record feedback for learning (include decision note for all decisions)
  const ticket = run.ticket;
  const ticketRef = `Ticket #${ticket?.freshserviceTicketId} (${ticket?.subject || 'unknown'})`;
  const noteAppendix = decisionNote ? ` Admin note: ${decisionNote.trim()}` : '';

  if (decision === 'modified' && overrideReason) {
    const feedbackEntry = `[${new Date().toISOString()}] ${ticketRef}: Admin overrode recommendation. Chosen tech ID: ${assignedTechId}. Reason: ${overrideReason}.${noteAppendix}`;
    await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
      logger.warn('Failed to append feedback', { error: err.message }),
    );
  } else if (decision === 'approved') {
    const topRec = run.recommendation?.recommendations?.[0];
    if (topRec) {
      const feedbackEntry = `[${new Date().toISOString()}] ${ticketRef}: Approved assignment to ${topRec.techName}.${noteAppendix}`;
      await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
        logger.warn('Failed to append feedback', { error: err.message }),
      );
    }
  } else if (decision === 'rejected' && decisionNote) {
    const feedbackEntry = `[${new Date().toISOString()}] ${ticketRef}: Rejected recommendation.${noteAppendix}`;
    await assignmentRepository.appendFeedback(req.workspaceId, feedbackEntry).catch((err) =>
      logger.warn('Failed to append feedback', { error: err.message }),
    );
  }

  // FreshService write-back (fire-and-forget)
  if (decision === 'approved' || decision === 'modified') {
    const config = await assignmentRepository.getConfig(req.workspaceId);
    freshServiceActionService.execute(runId, req.workspaceId, config?.dryRunMode ?? true).catch((err) =>
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

router.delete('/runs/:id', asyncHandler(async (req, res) => {
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

router.post('/runs/bulk-delete', asyncHandler(async (req, res) => {
  const { status, decision } = req.body;
  const result = await assignmentRepository.bulkDeleteRuns(req.workspaceId, { status, decision });
  res.json({ success: true, ...result });
}));

router.post('/runs/:id/dismiss', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Pipeline run belongs to a different workspace' });
  }
  await assignmentRepository.updatePipelineRun(runId, { decision: 'noise_dismissed', decidedAt: new Date(), decidedByEmail: req.session?.user?.email || 'admin' });

  // FreshService write-back: close noise ticket
  const config = await assignmentRepository.getConfig(req.workspaceId);
  freshServiceActionService.execute(runId, req.workspaceId, config?.dryRunMode ?? true).catch((err) =>
    logger.warn('FreshService sync failed after dismiss', { runId, error: err.message }),
  );

  res.json({ success: true, message: 'Run dismissed' });
}));

router.post('/runs/:id/sync', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  const result = await freshServiceActionService.execute(runId, req.workspaceId, false);
  res.json({ success: true, data: result });
}));

router.post('/runs/:id/sync-preview', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await assignmentRepository.getPipelineRun(runId);
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  const result = await freshServiceActionService.execute(runId, req.workspaceId, true);
  res.json({ success: true, data: result });
}));

router.get('/ticket/:ticketId/latest-run', asyncHandler(async (req, res) => {
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

router.post('/trigger/:ticketId', asyncHandler(async (req, res) => {
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

router.post('/email/test', asyncHandler(async (req, res) => {
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

router.get('/email/status', asyncHandler(async (req, res) => {
  const status = emailPollingService.getStatus(req.workspaceId);
  res.json({ success: true, data: status });
}));

router.post('/email/poll-now', asyncHandler(async (req, res) => {
  if (!graphMailClient.isConfigured()) {
    return res.status(400).json({ success: false, message: 'Azure Graph API credentials not configured' });
  }

  const result = await emailPollingService.pollNow(req.workspaceId);
  res.json({ success: true, data: result });
}));

// ─── Recent Tickets (for manual trigger UI) ─────────────────────────────

router.get('/recent-tickets', asyncHandler(async (req, res) => {
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

router.get('/prompts', asyncHandler(async (req, res) => {
  const versions = await promptRepository.getVersions(req.workspaceId);
  const published = await promptRepository.getPublished(req.workspaceId);
  res.json({ success: true, data: { versions, published } });
}));

router.get('/prompts/:id', asyncHandler(async (req, res) => {
  const version = await promptRepository.getVersion(parseInt(req.params.id));
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  res.json({ success: true, data: version });
}));

router.post('/prompts', asyncHandler(async (req, res) => {
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

router.post('/prompts/:id/publish', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await promptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const published = await promptRepository.publish(id, req.session?.user?.email);
  res.json({ success: true, data: published });
}));

router.post('/prompts/:id/restore', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await promptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const draft = await promptRepository.restore(id, req.session?.user?.email);
  res.json({ success: true, data: draft });
}));

// ─── Tool Schemas (for UI display) ──────────────────────────────────────

router.get('/tools', asyncHandler(async (req, res) => {
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

router.get('/competencies/duplicates', asyncHandler(async (req, res) => {
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

router.post('/competencies/merge', asyncHandler(async (req, res) => {
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

router.get('/competencies', asyncHandler(async (req, res) => {
  const categories = await competencyRepository.getCategories(req.workspaceId);
  const mappings = await competencyRepository.getAllCompetenciesForWorkspace(req.workspaceId);
  res.json({ success: true, data: { categories, mappings } });
}));

router.post('/competencies/categories', asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ success: false, message: 'Category name is required' });
  }
  const category = await competencyRepository.createCategory(req.workspaceId, { name: name.trim(), description });
  res.status(201).json({ success: true, data: category });
}));

router.put('/competencies/categories/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const category = await competencyRepository.getCategoryById(id);
  if (category.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Category belongs to a different workspace' });
  }
  const updated = await competencyRepository.updateCategory(id, req.body);
  res.json({ success: true, data: updated });
}));

router.delete('/competencies/categories/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const category = await competencyRepository.getCategoryById(id);
  if (category.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Category belongs to a different workspace' });
  }
  await competencyRepository.deleteCategory(id);
  res.json({ success: true, message: 'Category deleted' });
}));

// ─── Technician Competency Mappings ─────────────────────────────────────

router.get('/competencies/technician/:techId', asyncHandler(async (req, res) => {
  const techId = parseInt(req.params.techId);
  const competencies = await competencyRepository.getTechnicianCompetencies(techId, req.workspaceId);
  res.json({ success: true, data: competencies });
}));

router.put('/competencies/technician/:techId', asyncHandler(async (req, res) => {
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

router.get('/competency-prompts', asyncHandler(async (req, res) => {
  const versions = await competencyPromptRepository.getVersions(req.workspaceId);
  const published = await competencyPromptRepository.getPublished(req.workspaceId);
  res.json({ success: true, data: { versions, published } });
}));

router.get('/competency-prompts/:id', asyncHandler(async (req, res) => {
  const version = await competencyPromptRepository.getVersion(parseInt(req.params.id));
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  res.json({ success: true, data: version });
}));

router.post('/competency-prompts', asyncHandler(async (req, res) => {
  const { systemPrompt, toolConfig, notes } = req.body;
  if (!systemPrompt?.trim()) {
    return res.status(400).json({ success: false, message: 'systemPrompt is required' });
  }
  const version = await competencyPromptRepository.createVersion(req.workspaceId, {
    systemPrompt, toolConfig, notes, createdBy: req.session?.user?.email,
  });
  res.status(201).json({ success: true, data: version });
}));

router.post('/competency-prompts/:id/publish', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await competencyPromptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const published = await competencyPromptRepository.publish(id, req.session?.user?.email);
  res.json({ success: true, data: published });
}));

router.post('/competency-prompts/:id/restore', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const version = await competencyPromptRepository.getVersion(id);
  if (version.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Prompt belongs to a different workspace' });
  }
  const draft = await competencyPromptRepository.restore(id, req.session?.user?.email);
  res.json({ success: true, data: draft });
}));

router.get('/competency-tools', asyncHandler(async (req, res) => {
  const { COMPETENCY_TOOL_SCHEMAS } = await import('../services/competencyTools.js');
  const tools = COMPETENCY_TOOL_SCHEMAS.map((t) => ({
    name: t.name, description: t.description,
    parameters: t.input_schema?.properties || {},
    required: t.input_schema?.required || [],
  }));
  res.json({ success: true, data: tools });
}));

router.post('/competencies/analyze/:techId', asyncHandler(async (req, res) => {
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

router.get('/competencies/runs', asyncHandler(async (req, res) => {
  const techId = req.query.techId ? parseInt(req.query.techId) : undefined;
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const result = await competencyAnalysisService.getRuns(req.workspaceId, { technicianId: techId, limit, offset });
  res.json({ success: true, ...result });
}));

router.get('/competencies/runs/:id', asyncHandler(async (req, res) => {
  const run = await competencyAnalysisService._getRunWithSteps(parseInt(req.params.id));
  if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
  if (run.workspaceId !== req.workspaceId) {
    return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  }
  res.json({ success: true, data: run });
}));

router.post('/competencies/runs/:id/rollback', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const rolledBackBy = req.session?.user?.email || 'admin';
  const result = await competencyAnalysisService.rollback(runId, rolledBackBy);
  res.json({ success: true, data: result });
}));

router.post('/competencies/runs/:id/cancel', asyncHandler(async (req, res) => {
  const runId = parseInt(req.params.id);
  const run = await prisma.competencyAnalysisRun.findUnique({ where: { id: runId }, select: { status: true, workspaceId: true } });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
  if (run.workspaceId !== req.workspaceId) return res.status(403).json({ success: false, message: 'Run belongs to a different workspace' });
  if (run.status !== 'running') return res.status(400).json({ success: false, message: `Run is not running (status: ${run.status})` });
  await prisma.competencyAnalysisRun.update({ where: { id: runId }, data: { status: 'failed', errorMessage: 'Manually cancelled by admin' } });
  logger.info('Competency run manually cancelled', { runId });
  res.json({ success: true, message: 'Run cancelled' });
}));

router.get('/competencies/technicians', asyncHandler(async (req, res) => {
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

export default router;
