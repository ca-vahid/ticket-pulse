import { jest } from '@jest/globals';

/**
 * Same-day repeats in the pipeline (QA 11-23 items 4–5):
 *   raise   the AI's priority is raised before the urgent rule reads it, and
 *           the history row is written after the priority is saved;
 *   shadow  follow-up routing records "Would send to …"; the assignee stays;
 *   live    the owner of the earlier ticket is assigned, later rules are
 *           locked, the sentence joins the note, a merge note is left;
 *   errors  the AI's pick stands.
 * Harness from assignmentTimezoneFitPipeline.test.js.
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  noiseRule: { findMany: jest.fn(), findFirst: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
  ticketAssignmentEpisode: { findFirst: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
};
const assignmentRepositoryMock = {
  getConfig: jest.fn(),
  getOpenPipelineRun: jest.fn(),
  createQueuedRun: jest.fn(),
  createPipelineStep: jest.fn(),
  updatePipelineStep: jest.fn(),
  updatePipelineRun: jest.fn(),
  getPipelineRun: jest.fn(),
  touchPipelineRun: jest.fn(),
};
const promptRepositoryMock = { getPublished: jest.fn() };
const providerGatewayMock = { runToolTurn: jest.fn() };
const freshServiceActionServiceMock = {
  execute: jest.fn().mockResolvedValue({}),
  executePriorityWriteback: jest.fn().mockResolvedValue(null),
  executeTicketTypeWriteback: jest.fn().mockResolvedValue(null),
  executeCategoryWriteback: jest.fn().mockResolvedValue(null),
};
const guardAutoAssignment = jest.fn();
const spreadGuard = jest.fn();
const beginRelease = jest.fn();
const applyToRun = jest.fn();
const levelGuard = jest.fn();
const levelIsActive = jest.fn();
const tzGuard = jest.fn();
const executeTool = jest.fn();
const repeatMock = {
  evaluate: jest.fn(), route: jest.fn(), addMergeNote: jest.fn(),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/noiseCloseGuard.js', () => ({
  evaluateNoiseCloseGuard: jest.fn().mockResolvedValue({ hold: false, reason: null, message: null }),
  parkHeldHrNotice: jest.fn().mockResolvedValue(null),
  holdMessage: jest.fn(() => 'held'),
  NOISE_CLOSE_HOLD_REASONS: { HR_NOTICE: 'hr_notice' },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({ default: promptRepositoryMock }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [],
  executeTool,
  applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: freshServiceActionServiceMock }));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: { processDecisionFeedback: jest.fn() } }));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({ default: { queueForPriorityRun: jest.fn().mockResolvedValue({ queued: 0 }) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: providerGatewayMock }));
jest.unstable_mockModule('../src/services/assignmentRecommendationValidation.js', () => ({
  normalizeSubmitRecommendationPayload: jest.fn(async (input) => ({ ...input })),
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/autoHelpIntakeService.js', () => ({ default: { onIntakeSettled: jest.fn(async () => ({ id: 1 })) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent: jest.fn(async () => ({})), default: { emitTicketEvent: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/autoHelpContextService.js', () => ({ pipelineContextFor: jest.fn(async () => null), default: { pipelineContextFor: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/services/urgentResponse/urgentResponseService.js', () => ({ default: { guardAutoAssignment } }));
jest.unstable_mockModule('../src/services/assignmentSpread/spreadService.js', () => ({ default: { guardAutoAssignment: spreadGuard, beginRelease } }));
jest.unstable_mockModule('../src/services/assignmentShares/sharesService.js', () => ({ default: { applyToRun } }));
jest.unstable_mockModule('../src/services/assignmentLevelMatch/levelMatchService.js', () => ({ default: { guard: levelGuard, isActive: levelIsActive } }));
jest.unstable_mockModule('../src/services/assignmentTimezoneFit/timezoneFitService.js', () => ({ default: { guard: tzGuard } }));
jest.unstable_mockModule('../src/services/assignmentFollowUp/sameDayRepeatService.js', () => ({ default: repeatMock }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');
const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { default: autoHelpPlaybookService } = await import('../src/services/autoHelpPlaybookService.js');

const RUN_ID = 9201;
const TICKET_ID = 2001;
const WS_ID = 1;
const DANA = 11;
const ELI = 12;
const flush = () => new Promise((r) => setImmediate(r));
const REAL = {
  recommendations: [{ techId: DANA, techName: 'Dana Fox', score: 0.8 }, { techId: ELI, techName: 'Eli Park', score: 0.68 }],
  ticketClassification: 'Collaboration > Teams', internalCategoryId: 10, internalSubcategoryId: 101, assessedPriority: 'Medium', priorityRationale: 'One person blocked.',
};
const RELATED = { ticketId: 2000, ref: 'TP-1042', subject: "can't sign into Teams", matchedOn: 'subcategory', owner: { techId: ELI, techName: 'Eli Park' } };
const SHADOW_SENTENCE = 'Would send to Eli Park: same problem as TP-1042 reported today.';
const LIVE_SENTENCE = 'Sent to Eli Park: same problem as TP-1042 reported today.';

const turn = (content, stop = 'tool_use') => ({
  message: { content, stop_reason: stop },
  usage: { totalTokens: 42 }, provider: 'anthropic', model: 'claude-sonnet-4-6-20260217', fallbackUsed: false, fallbackReason: null, attemptNumber: 1,
});
const submit = (input) => providerGatewayMock.runToolTurn.mockResolvedValue(turn([{ type: 'tool_use', id: 'tu_submit', name: 'submit_recommendation', input }]));
const config = (extra = {}) => assignmentRepositoryMock.getConfig.mockResolvedValue({
  isEnabled: true, autoAssign: true, autoCloseNoise: false, priorityAssessmentEnabled: true, dryRunMode: false, llmModel: 'claude-sonnet-4-6-20260217', ...extra,
});
const finalRunUpdate = () => assignmentRepositoryMock.updatePipelineRun.mock.calls.map(([, d]) => d).find((d) => d && Object.prototype.hasOwnProperty.call(d, 'decision'));
const stepNamed = (name) => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === name);
const run = async (events = []) => {
  await pipeline._executeRun(RUN_ID, TICKET_ID, WS_ID, 'webhook', Date.now(), (e) => events.push(e), null);
  await flush();
  return events;
};

/** evaluate as the real one does it: Medium → High on the recommendation. */
const raising = async ({ recommendation }) => {
  recommendation.assessedPriority = 'High';
  recommendation.assessedPriorityId = 3;
  recommendation.repeatReport = { relatedRef: 'TP-1042', raised: true, aiPriority: 'Medium', raisedTo: 'High', sentence: 'Raised to High: same problem reported again today (TP-1042).' };
  return { related: RELATED, bump: { from: 'Medium', to: 'High' }, record: recommendation.repeatReport, origin: 'ticketpulse' };
};
const routeRecord = (over = {}) => ({
  mode: 'shadow', outcome: 'would_route', applied: false, relatedRef: 'TP-1042', from: { techId: DANA }, to: { techId: ELI, techName: 'Eli Park' }, sentence: SHADOW_SENTENCE, ...over,
});

let spies = [];
beforeEach(() => {
  jest.clearAllMocks();
  config();
  promptRepositoryMock.getPublished.mockResolvedValue({ id: 55, version: 33, systemPrompt: 'You are the assignment pipeline.', toolConfig: { enableWebSearch: false } });
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: null });
  prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue({
    groupId: null, origin: 'ticketpulse', subject: 'Lost access to Teams again', description: null, descriptionText: 'please', category: null, status: 'Open',
    internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Collaboration' }, internalSubcategory: { name: 'Teams' },
  });
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.noiseRule.findMany.mockResolvedValue([]);
  noiseRuleService.invalidateCache();
  assignmentRepositoryMock.updatePipelineRun.mockResolvedValue({});
  assignmentRepositoryMock.updatePipelineStep.mockResolvedValue({});
  assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 1 });
  assignmentRepositoryMock.getPipelineRun.mockResolvedValue({ id: RUN_ID, status: 'completed' });
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: WS_ID, enabled: false, enabledAt: null });
  autoHelpPlaybookService._enabledCache.clear();
  guardAutoAssignment.mockResolvedValue({ outcome: 'keep', techId: DANA, sentence: null, shadow: false });
  spreadGuard.mockImplementation(async ({ techId, techName }) => ({ techId, techName, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }));
  beginRelease.mockResolvedValue({ staggered: false, wait: false });
  applyToRun.mockResolvedValue(null);
  levelIsActive.mockResolvedValue(false);
  levelGuard.mockResolvedValue(null);
  tzGuard.mockResolvedValue(null);
  executeTool.mockResolvedValue({ candidates: [] });
  repeatMock.evaluate.mockImplementation(raising);
  repeatMock.route.mockResolvedValue(null);

  repeatMock.addMergeNote.mockResolvedValue(true);
  submit({ ...REAL });
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe('the repeat raises priority (item 5)', () => {
  test('raised before the urgent rule reads it, saved as the assessment, and handed to the write-back on the run', async () => {
    const persisted = [];
    pipeline._persistPriorityAssessment.mockImplementation(async (_t, _r, rec) => { persisted.push(rec.assessedPriority); });
    await run();
    expect(guardAutoAssignment).toHaveBeenCalledWith(expect.objectContaining({ assessedPriorityId: 3 }));
    expect(persisted).toEqual(['High']);
    // No history row from the pipeline itself: the write-back records it where the real priority moves.
    expect(freshServiceActionServiceMock.executePriorityWriteback).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
    expect(finalRunUpdate().recommendation.repeatReport).toMatchObject({ raised: true, raisedTo: 'High' });
  });

  test('runs whatever the routing mode: route says nothing, the raise still happens', async () => {
    repeatMock.route.mockResolvedValue(null); // follow-up routing off
    await run();
    expect(finalRunUpdate().recommendation).toMatchObject({ assessedPriority: 'High', repeatReport: { raised: true } });
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: DANA });
  });

  test('priority assessment off in the workspace: the service is told so', async () => {
    config({ priorityAssessmentEnabled: false });
    await run();
    expect(repeatMock.evaluate).toHaveBeenCalledWith(expect.objectContaining({ priorityAssessmentEnabled: false }));
  });

  test('a noise verdict is never looked at', async () => {
    submit({ ...REAL, recommendations: [] });
    await run();
    expect(repeatMock.evaluate).not.toHaveBeenCalled();
  });
});

describe('follow-up routing (item 4)', () => {
  test('Shadow: the record and the step are written; Dana keeps it', async () => {
    repeatMock.route.mockResolvedValue({
      techId: DANA, applied: false, sentence: null, record: routeRecord(),
      step: { stepName: 'followup_routing', status: 'completed', durationMs: 0, output: { kind: 'followup_routing', ...routeRecord() } },
    });
    const events = await run();
    expect(repeatMock.route).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS_ID, ticketId: TICKET_ID, runId: RUN_ID, decision: 'auto_assigned', related: RELATED, pickId: DANA, pickName: 'Dana Fox',
      locked: false, dryRun: false, ticketOrigin: 'ticketpulse',
    }));
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: DANA });
    expect(update.decisionNote).toBeUndefined();
    expect(update.recommendation.followUpRouting).toMatchObject({ mode: 'shadow', outcome: 'would_route', sentence: SHADOW_SENTENCE });
    expect(stepNamed('followup_routing')).toMatchObject({ pipelineRunId: RUN_ID, output: { kind: 'followup_routing' } });
    expect(events).toContainEqual({ type: 'followup_routing', applied: false, message: SHADOW_SENTENCE });
    expect(levelGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: DANA, locked: false }));
    expect(repeatMock.addMergeNote).not.toHaveBeenCalled();
  });

  test('Live: Eli is assigned, later rules are locked, the note and the merge suggestion follow', async () => {
    const rec = routeRecord({ mode: 'live', outcome: 'routed', applied: true, sentence: LIVE_SENTENCE });
    repeatMock.route.mockResolvedValue({ techId: ELI, applied: true, sentence: LIVE_SENTENCE, record: rec, step: null });
    await run();
    expect(levelGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: ELI, locked: true }));
    expect(tzGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: ELI, locked: true }));
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: ELI, techName: 'Eli Park', locked: true }));
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: ELI, decisionNote: LIVE_SENTENCE });
    expect(repeatMock.addMergeNote).toHaveBeenCalledWith({ ticketId: TICKET_ID, workspaceId: WS_ID, related: RELATED });
  });

  test('an urgent-rule redirect locks follow-up routing', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Sam Okafor', sentence: 'Urgent: Sam.', shadow: false });
    await run();
    expect(repeatMock.route).toHaveBeenCalledWith(expect.objectContaining({ pickId: 22, locked: true }));
  });

  test('no related ticket: routing is never asked', async () => {
    repeatMock.evaluate.mockResolvedValue(null);
    await run();
    expect(repeatMock.route).not.toHaveBeenCalled();
    expect(finalRunUpdate().recommendation.assessedPriority).toBe('Medium');
  });

  test('the same-day code throws: the AI\'s pick and priority stand', async () => {
    repeatMock.evaluate.mockRejectedValue(new Error('boom'));
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: DANA });
    expect(update.recommendation.assessedPriority).toBe('Medium');
    expect(update.recommendation.followUpRouting).toBeUndefined();
  });

  test('routing throws: the AI\'s pick stands', async () => {
    repeatMock.route.mockRejectedValue(new Error('boom'));
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: DANA });
  });
});
