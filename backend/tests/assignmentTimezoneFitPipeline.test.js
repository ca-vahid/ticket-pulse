import { jest } from '@jest/globals';

/**
 * Time-zone fit in the pipeline (QA 11-17 item 1): the step runs after Level
 * match and before Spread.
 *   Shadow  the record rides on the run (recommendation.timezoneFit) with a
 *           timezone_fit step; the assignee does not change;
 *   Live    the closer person is assigned and the sentence joins the note;
 *   locks   urgent, share, escalation and a Level match move are never undone;
 *   site    a preferred_location in any tool call marks the run as site work;
 *   errors  the AI's pick stands.
 * Harness from assignmentSharesPipeline.test.js.
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

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');
const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { default: autoHelpPlaybookService } = await import('../src/services/autoHelpPlaybookService.js');

const RUN_ID = 9101;
const TICKET_ID = 601;
const WS_ID = 1;
const flush = () => new Promise((r) => setImmediate(r));
const REAL = {
  recommendations: [
    { techId: 5, techName: 'Eli Park', score: 0.8 },
    { techId: 6, techName: 'Priya Nair', score: 0.78 },
    { techId: 7, techName: 'Dana Fox', score: 0.66 },
  ],
  ticketClassification: 'Hardware > Laptop', internalCategoryId: 10, internalSubcategoryId: 101, assessedPriority: 'Medium',
};
const SENTENCE = 'Time zone: the requester is in Santiago (UTC−3); Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana was put first.';
const SHADOW_SENTENCE = SENTENCE.replace('was put first', 'would be put first');

const turn = (content, stop = 'tool_use') => ({
  message: { content, stop_reason: stop },
  usage: { totalTokens: 42 }, provider: 'anthropic', model: 'claude-sonnet-4-6-20260217', fallbackUsed: false, fallbackReason: null, attemptNumber: 1,
});
const submitBlock = (input) => ({ type: 'tool_use', id: 'tu_submit', name: 'submit_recommendation', input });
function submit(input) {
  providerGatewayMock.runToolTurn.mockResolvedValue(turn([submitBlock(input)]));
}
const config = (extra = {}) => assignmentRepositoryMock.getConfig.mockResolvedValue({
  isEnabled: true, autoAssign: true, autoCloseNoise: false, priorityAssessmentEnabled: true, dryRunMode: false, llmModel: 'claude-sonnet-4-6-20260217', ...extra,
});
const finalRunUpdate = () => assignmentRepositoryMock.updatePipelineRun.mock.calls.map(([, d]) => d).find((d) => d && Object.prototype.hasOwnProperty.call(d, 'decision'));
const tzStep = () => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === 'timezone_fit');
const run = async (events = []) => {
  await pipeline._executeRun(RUN_ID, TICKET_ID, WS_ID, 'webhook', Date.now(), (e) => events.push(e), null);
  await flush();
  return events;
};

const record = (over = {}) => ({
  mode: 'shadow', outcome: 'moved', applied: false, locked: false, from: { techId: 5, techName: 'Eli Park' }, to: { techId: 7, techName: 'Dana Fox' }, sentence: SHADOW_SENTENCE, ...over,
});
const tzShadow = () => ({
  techId: 5, moved: false, applied: false, sentence: null, record: record(),
  step: { stepName: 'timezone_fit', status: 'completed', durationMs: 0, output: { kind: 'timezone_fit', ...record() } },
});
const tzLive = () => {
  const rec = record({ mode: 'live', applied: true, sentence: SENTENCE });
  return { techId: 7, moved: true, applied: true, sentence: SENTENCE, record: rec, step: { stepName: 'timezone_fit', status: 'completed', durationMs: 0, output: { kind: 'timezone_fit', ...rec } } };
};

let spies = [];
beforeEach(() => {
  jest.clearAllMocks();
  config();
  promptRepositoryMock.getPublished.mockResolvedValue({ id: 55, version: 33, systemPrompt: 'You are the assignment pipeline.', toolConfig: { enableWebSearch: false } });
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: null });
  prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue({
    groupId: null, origin: 'ticketpulse', subject: 'Blue screen', description: null, descriptionText: 'please', category: null, status: 'Open',
    internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Hardware' }, internalSubcategory: { name: 'Laptop' },
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
  guardAutoAssignment.mockResolvedValue({ outcome: 'keep', techId: 5, sentence: null, shadow: false });
  spreadGuard.mockImplementation(async ({ techId, techName }) => ({ techId, techName, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }));
  beginRelease.mockResolvedValue({ staggered: false, wait: false });
  applyToRun.mockResolvedValue(null);
  levelIsActive.mockResolvedValue(false);
  levelGuard.mockResolvedValue(null);
  tzGuard.mockResolvedValue(null);
  executeTool.mockResolvedValue({ candidates: [] });
  submit(REAL);
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe('Time-zone fit in _executeRun', () => {
  test('asked after Level match and before Spread, with the pick, the run and no lock', async () => {
    const order = [];
    levelGuard.mockImplementation(async () => { order.push('level'); return null; });
    tzGuard.mockImplementation(async () => { order.push('timezone'); return null; });
    spreadGuard.mockImplementation(async () => { order.push('spread'); return { techId: 5, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }; });
    await run();
    expect(order).toEqual(['level', 'timezone', 'spread']);
    expect(tzGuard).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS_ID, ticketId: TICKET_ID, runId: RUN_ID, techId: 5, decision: 'auto_assigned', siteBound: false, locked: false, dryRun: false,
      recommendation: expect.objectContaining({ recommendations: expect.any(Array) }),
    }));
  });

  test('Shadow: the record and the step are written, the assignee does not change', async () => {
    tzGuard.mockResolvedValue(tzShadow());
    const events = await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(update.decisionNote).toBeUndefined();
    expect(update.recommendation.timezoneFit).toMatchObject({ mode: 'shadow', outcome: 'moved', to: { techId: 7 } });
    expect(tzStep()).toMatchObject({ pipelineRunId: RUN_ID, stepNumber: expect.any(Number), output: { kind: 'timezone_fit', sentence: SHADOW_SENTENCE } });
    expect(events).toContainEqual({ type: 'timezone_fit', applied: false, message: SHADOW_SENTENCE });
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 5 }));
  });

  test('Live: the closer person is assigned and the sentence joins the note', async () => {
    tzGuard.mockResolvedValue(tzLive());
    await run();
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 7, techName: 'Dana Fox' }));
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 7, decisionNote: SENTENCE });
  });

  test('a Level match move locks the pick', async () => {
    levelGuard.mockResolvedValue({ techId: 6, moved: true, applied: true, sentence: 'Needs basic: Priya Nair.', record: { to: { techId: 6, techName: 'Priya Nair' } }, step: null });
    await run();
    expect(tzGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 6, locked: true }));
  });

  test('a person the urgent rule chose is locked too', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Sam Okafor', sentence: 'Urgent: Sam.', shadow: false });
    await run();
    expect(tzGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 22, locked: true }));
  });

  test('a preferred_location in a tool call marks the run as site work', async () => {
    providerGatewayMock.runToolTurn
      .mockResolvedValueOnce(turn([{ type: 'tool_use', id: 'tu_match', name: 'find_matching_agents', input: { category: 'Hardware', preferred_location: 'Calgary' } }]))
      .mockResolvedValue(turn([submitBlock(REAL)]));
    await run();
    expect(tzGuard).toHaveBeenCalledWith(expect.objectContaining({ siteBound: true }));
  });

  test('the time-zone code throws: the AI\'s pick stands and nothing is recorded', async () => {
    tzGuard.mockRejectedValue(new Error('boom'));
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(update.recommendation.timezoneFit).toBeUndefined();
  });

  test('a noise verdict is never looked at', async () => {
    submit({ ...REAL, recommendations: [] });
    await run();
    expect(tzGuard).not.toHaveBeenCalled();
  });
});
