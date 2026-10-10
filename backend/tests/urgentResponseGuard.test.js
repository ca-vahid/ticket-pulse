import { jest } from '@jest/globals';

/**
 * Urgent response, layer 1 — the hook in the assignment pipeline
 * (_executeRun, plans/URGENT_RESPONSE_PLAN.md): the guard is asked just
 * before an auto-assignment is written.
 *   keep              → the AI's pick, nothing added;
 *   live redirect     → the run row (and so the FreshService write-back, its
 *                       note and the local assignment) carries the replacement;
 *   live on_call      → the same, with the on-call person;
 *   live hold         → pending_review with an urgent_response_guard step;
 *   Shadow / dry run  → nothing changes;
 *   any error         → nothing changes.
 * Harness from autoHelpPipelineIntegration.test.js.
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
  executeTool: jest.fn(),
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

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');
const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { default: autoHelpPlaybookService } = await import('../src/services/autoHelpPlaybookService.js');

const RUN_ID = 9001;
const TICKET_ID = 501;
const WS_ID = 1;
const flush = () => new Promise((r) => setImmediate(r));
const REAL = {
  recommendations: [{ techId: 5, techName: 'Dana', score: 0.9 }, { techId: 6, techName: 'Eli', score: 0.7 }], ticketClassification: 'Network > VPN',
  internalCategoryId: 10, internalSubcategoryId: 101, assessedPriority: 'Urgent', priorityRationale: 'Site down',
};
const SENTENCE = 'Assigned to Maria Lee instead of Dana by the Urgent rule: Dana starts at 09:00.';

function submit(input) {
  providerGatewayMock.runToolTurn.mockResolvedValue({
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_recommendation', input }], stop_reason: 'tool_use' },
    usage: { totalTokens: 42 }, provider: 'anthropic', model: 'claude-sonnet-4-6-20260217', fallbackUsed: false, fallbackReason: null, attemptNumber: 1,
  });
}
const config = (extra = {}) => assignmentRepositoryMock.getConfig.mockResolvedValue({
  isEnabled: true, autoAssign: true, autoCloseNoise: false, priorityAssessmentEnabled: true, dryRunMode: false, llmModel: 'claude-sonnet-4-6-20260217', ...extra,
});
const finalRunUpdate = () => assignmentRepositoryMock.updatePipelineRun.mock.calls.map(([, d]) => d).find((d) => d && Object.prototype.hasOwnProperty.call(d, 'decision'));
const guardStep = () => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === 'urgent_response_guard');
const run = async (events = []) => {
  await pipeline._executeRun(RUN_ID, TICKET_ID, WS_ID, 'webhook', Date.now(), (e) => events.push(e), null);
  await flush();
  return events;
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
    groupId: null, origin: 'ticketpulse', subject: 'VPN is down', description: null, descriptionText: 'please', category: null, status: 'Open',
    internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Network' }, internalSubcategory: { name: 'VPN' },
  });
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.noiseRule.findMany.mockResolvedValue([]);
  noiseRuleService.invalidateCache();
  assignmentRepositoryMock.updatePipelineRun.mockResolvedValue({});
  assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 1 });
  assignmentRepositoryMock.getPipelineRun.mockResolvedValue({ id: RUN_ID, status: 'completed' });
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: WS_ID, enabled: false, enabledAt: null });
  autoHelpPlaybookService._enabledCache.clear();
  guardAutoAssignment.mockResolvedValue({ outcome: 'keep', techId: 5, sentence: null, shadow: false });
  submit(REAL);
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe('the layer-1 hook in the pipeline', () => {
  test('the guard is asked with the run\'s assessed priority and category, before the run row is written', async () => {
    const order = [];
    guardAutoAssignment.mockImplementation(async () => { order.push('guard'); return { outcome: 'keep', techId: 5, sentence: null, shadow: false }; });
    assignmentRepositoryMock.updatePipelineRun.mockImplementation(async (_id, data) => { if (data && 'decision' in data) order.push('run_update'); return {}; });
    await run();
    expect(order).toEqual(['guard', 'run_update']);
    expect(guardAutoAssignment).toHaveBeenCalledTimes(1);
    expect(guardAutoAssignment).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      ticket: { id: TICKET_ID, internalCategoryId: 10, internalSubcategoryId: 101 },
      techId: 5,
      assessedPriorityId: 4,
      runId: RUN_ID,
      now: expect.any(Date),
      dryRun: false,
    });
  });

  test('keep: the AI\'s pick is assigned, no extra step', async () => {
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5, syncStatus: 'pending' });
    expect(finalRunUpdate().decisionNote).toBeUndefined();
    expect(guardStep()).toBeUndefined();
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
  });

  test('live redirect: the run row carries the replacement, a step explains it, and the sync still runs', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', sentence: SENTENCE, shadow: false });
    const events = await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 22, decisionNote: SENTENCE, syncStatus: 'pending', errorMessage: null });
    expect(update.decidedAt).toBeInstanceOf(Date);
    // The ranked recommendation is left as the AI wrote it.
    expect(update.recommendation.recommendations[0]).toMatchObject({ techId: 5, techName: 'Dana' });
    expect(guardStep()).toMatchObject({
      pipelineRunId: RUN_ID,
      stepName: 'urgent_response_guard',
      status: 'completed',
      output: { kind: 'urgent_response_guard', outcome: 'redirect', forcedDecision: null, fromTechId: 5, fromTechName: 'Dana', toTechId: 22, toTechName: 'Maria Lee', message: SENTENCE },
    });
    expect(events).toContainEqual({ type: 'urgent_response_guard', outcome: 'redirect', message: SENTENCE });
    // execute() reads the run's assignedTechId: the write-back, its note and the local assignment follow the replacement.
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
  });

  test('live on_call: the on-call person is assigned', async () => {
    const sentence = 'Nobody is at work. Assigned to the on-call person, Maria Lee, who was texted.';
    guardAutoAssignment.mockResolvedValue({ outcome: 'on_call', techId: 22, techName: 'Maria Lee', sentence, shadow: false });
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 22, decisionNote: sentence });
    expect(guardStep().output).toMatchObject({ outcome: 'on_call', toTechId: 22 });
  });

  test('live hold: pending_review like the other guards — no assignee, no sync, a step and a reason', async () => {
    const sentence = 'Nobody is at work. Left for review instead of assigning it to Dana.';
    guardAutoAssignment.mockResolvedValue({ outcome: 'hold', techId: null, sentence, shadow: false });
    const events = await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'pending_review', errorMessage: `Urgent response: ${sentence}` });
    expect(update.assignedTechId).toBeUndefined();
    expect(update.decidedAt).toBeUndefined();
    expect(update.syncStatus).toBeUndefined();
    expect(guardStep().output).toEqual({
      kind: 'urgent_response_guard', outcome: 'hold', forcedDecision: 'pending_review', fromTechId: 5, fromTechName: 'Dana', toTechId: null, toTechName: null, message: sentence,
    });
    expect(events).toContainEqual({ type: 'urgent_response_guard', outcome: 'hold', message: sentence });
    expect(freshServiceActionServiceMock.execute).not.toHaveBeenCalled();
  });

  test('Shadow: the guard logged its own row — the pipeline changes nothing', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', sentence: `Shadow: would have ${SENTENCE}`, shadow: true });
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(finalRunUpdate().decisionNote).toBeUndefined();
    expect(guardStep()).toBeUndefined();

    jest.clearAllMocks();
    guardAutoAssignment.mockResolvedValue({ outcome: 'hold', techId: null, sentence: 'Shadow: would have left it for review.', shadow: true });
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(guardStep()).toBeUndefined();
  });

  test('a dry-run pipeline tells the guard so (it answers as Shadow)', async () => {
    config({ dryRunMode: true });
    await run();
    expect(guardAutoAssignment.mock.calls[0][0].dryRun).toBe(true);
    config({ dryRunMode: undefined });
    await run();
    expect(guardAutoAssignment.mock.calls[1][0].dryRun).toBe(true);
  });

  test('an error, or an answer that makes no sense: the assignment goes ahead unchanged', async () => {
    guardAutoAssignment.mockRejectedValue(new Error('engine is broken'));
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(guardStep()).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith('Pipeline: urgent response guard failed - assignment unchanged', expect.objectContaining({ runId: RUN_ID, error: 'engine is broken' }));

    for (const answer of [null, {}, { outcome: 'redirect', techId: null, shadow: false }, { outcome: 'mystery', techId: 9, shadow: false }]) {
      jest.clearAllMocks();
      guardAutoAssignment.mockResolvedValue(answer);
      await run();
      expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
      expect(guardStep()).toBeUndefined();
    }
  });

  test('a failing step write does not stop the redirect', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', sentence: SENTENCE, shadow: false });
    assignmentRepositoryMock.createPipelineStep.mockImplementation(async (step) => {
      if (step.stepName === 'urgent_response_guard') throw new Error('step table locked');
      return { id: 1 };
    });
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 22 });
  });

  test('the guard is not asked when the run does not auto-assign', async () => {
    config({ autoAssign: false });
    await run();
    expect(finalRunUpdate().decision).toBe('pending_review');

    config({ autoAssign: true, observeOnlyGroupIds: ['77'] });
    prismaMock.ticket.findUnique.mockResolvedValue({
      groupId: 77n, origin: 'freshservice', subject: 'VPN is down', description: null, descriptionText: 'please', category: null, status: 'Open',
      internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Network' }, internalSubcategory: { name: 'VPN' },
    });
    await run();

    config();
    submit({ recommendations: [], ticketClassification: 'Noise', closureNoticeHtml: '<p>FYI.</p>' });
    await run();
    expect(guardAutoAssignment).not.toHaveBeenCalled();
  });

  test('priority assessment switched off: no assessed priority is passed (the guard reads the ticket)', async () => {
    config({ priorityAssessmentEnabled: false });
    await run();
    expect(guardAutoAssignment.mock.calls[0][0].assessedPriorityId).toBeNull();
  });
});
