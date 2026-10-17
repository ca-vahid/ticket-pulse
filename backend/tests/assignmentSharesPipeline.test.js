import { jest } from '@jest/globals';

/**
 * Ticket shares in the pipeline (QA 10-16 item 4): the step runs after the
 * AI's verdict and the urgent guard, before Spread.
 *   Shadow  the record rides on the run (recommendation.share); nothing changes;
 *   Live    suggest-only: the rule's pick is rank 1, the AI's own second;
 *           auto-assign: the rule's pick is assigned and Spread's cap is skipped;
 *   errors  the AI's pick stands.
 * Harness from assignmentSpreadPipeline.test.js.
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
const spreadGuard = jest.fn();
const applyToRun = jest.fn();
const beginRelease = jest.fn();
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
jest.unstable_mockModule('../src/services/assignmentSpread/spreadService.js', () => ({ default: { guardAutoAssignment: spreadGuard, beginRelease } }));
jest.unstable_mockModule('../src/services/assignmentShares/sharesService.js', () => ({ default: { applyToRun } }));

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
  spreadGuard.mockResolvedValue({ techId: 5, techName: 'Dana', changed: false, moved: false, rule: 'none', sentence: null, record: { v: 1, rule: 'none', unit: 'ticket:501', recent: 0 }, step: null });
  beginRelease.mockResolvedValue({ staggered: false, wait: false });
  applyToRun.mockResolvedValue(null);
  submit(REAL);
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

const SHADOW_RECORD = { v: 1, mode: 'shadow', applied: false, pick: { techId: 6, name: 'Eli' }, aiPick: { techId: 5, name: 'Dana' }, why: 'Shadow: the share rule would have suggested Eli, furthest below their share this week (0 against about 0.2). The AI picked Dana.' };
const shadow = () => ({ mode: 'shadow', applied: false, techId: 6, techName: 'Eli', sentence: SHADOW_RECORD.why, record: SHADOW_RECORD, step: null });
const LIVE_SENTENCE = 'Assigned by the share rule to Eli, furthest below their share this week (0 against about 0.2). The AI’s first choice was Dana.';
const liveStep = (message) => ({ stepName: 'share_rule', status: 'completed', durationMs: 0, output: { kind: 'share_rule', applied: true, fromTechId: 5, toTechId: 6, message } });
const shareStep = () => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === 'share_rule');

describe('the share rule in _executeRun', () => {
  test('asked after the urgent guard and before Spread, with the AI\'s pick and the run\'s recommendation', async () => {
    const order = [];
    guardAutoAssignment.mockImplementation(async () => { order.push('urgent'); return { outcome: 'keep', techId: 5, sentence: null, shadow: false }; });
    applyToRun.mockImplementation(async () => { order.push('shares'); return null; });
    spreadGuard.mockImplementation(async () => { order.push('spread'); return { techId: 5, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }; });
    await run();
    expect(order).toEqual(['urgent', 'shares', 'spread']);
    expect(applyToRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS_ID, ticketId: TICKET_ID, runId: RUN_ID, decision: 'auto_assigned', dryRun: false,
      aiPick: { techId: 5, techName: 'Dana' }, recommendation: expect.objectContaining({ recommendations: expect.any(Array) }),
    }));
  });

  test('Shadow writes only the record: same person, same list, no step, no note', async () => {
    applyToRun.mockResolvedValue(shadow());
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(update.decisionNote).toBeUndefined();
    expect(update.recommendation.share).toEqual(SHADOW_RECORD);
    expect(update.recommendation.recommendations.map((r) => r.techId)).toEqual([5, 6]);
    expect(shareStep()).toBeUndefined();
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 5, locked: false }));
  });

  test('Shadow in a suggest-only workspace: the review card is unchanged', async () => {
    config({ autoAssign: false });
    applyToRun.mockResolvedValue(shadow());
    await run();
    const update = finalRunUpdate();
    expect(update.decision).toBe('pending_review');
    expect(update.recommendation.recommendations[0]).toMatchObject({ techId: 5 });
    expect(update.recommendation.share).toMatchObject({ mode: 'shadow' });
  });

  test('Live in a suggest-only workspace: the rule\'s pick is rank 1, the AI\'s own pick second', async () => {
    config({ autoAssign: false });
    const sentence = 'Suggested first by the share rule: Eli, furthest below their share this week (0 against about 0.2). The AI’s own first choice, Dana, is second.';
    applyToRun.mockResolvedValue({
      mode: 'live', applied: true, techId: 6, techName: 'Eli', sentence,
      record: { ...SHADOW_RECORD, mode: 'live', applied: true, why: sentence },
      recommendations: [{ rank: 1, techId: 6, techName: 'Eli', score: 0.7, reasoning: 'Share rule: furthest below their share.', source: 'share_rule' }, { rank: 2, techId: 5, techName: 'Dana', score: 0.9 }],
      step: liveStep(sentence),
    });
    const events = await run();
    const update = finalRunUpdate();
    expect(update.decision).toBe('pending_review');
    expect(update.assignedTechId).toBeUndefined();
    expect(update.recommendation.recommendations.map((r) => [r.rank, r.techId])).toEqual([[1, 6], [2, 5]]);
    expect(shareStep()).toMatchObject({ pipelineRunId: RUN_ID, stepNumber: expect.any(Number), output: { toTechId: 6 } });
    expect(events).toContainEqual({ type: 'share_rule', applied: true, message: sentence });
    expect(spreadGuard).not.toHaveBeenCalled();
  });

  test('Live in auto-assign: the rule\'s pick is assigned, Spread counts it but its cap cannot move it', async () => {
    applyToRun.mockResolvedValue({
      mode: 'live', applied: true, techId: 6, techName: 'Eli', sentence: LIVE_SENTENCE,
      record: { ...SHADOW_RECORD, mode: 'live', applied: true, why: LIVE_SENTENCE }, step: liveStep(LIVE_SENTENCE),
    });
    spreadGuard.mockResolvedValue({ techId: 6, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null });
    await run();
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 6, techName: 'Eli', locked: true }));
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 6, decisionNote: LIVE_SENTENCE, syncStatus: 'pending' });
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
  });

  test('the share code throws: the AI\'s pick stands and nothing is recorded', async () => {
    applyToRun.mockRejectedValue(new Error('boom'));
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(update.recommendation.share).toBeUndefined();
    expect(update.decisionNote).toBeUndefined();
  });

  test('the step cannot be saved: the rule\'s pick still stands', async () => {
    applyToRun.mockResolvedValue({
      mode: 'live', applied: true, techId: 6, techName: 'Eli', sentence: LIVE_SENTENCE, record: { ...SHADOW_RECORD, mode: 'live' }, step: liveStep(LIVE_SENTENCE),
    });
    spreadGuard.mockResolvedValue({ techId: 6, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null });
    assignmentRepositoryMock.createPipelineStep.mockImplementation(async (s) => { if (s.stepName === 'share_rule') throw new Error('step table down'); return { id: 1 }; });
    await run();
    expect(finalRunUpdate()).toMatchObject({ assignedTechId: 6 });
  });

  test('a person the urgent rule chose is never overridden: the share rule is not asked', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', sentence: SENTENCE, shadow: false });
    await run();
    expect(applyToRun).not.toHaveBeenCalled();
  });

  test('a noise verdict is never shared out', async () => {
    submit({ ...REAL, recommendations: [] });
    await run();
    expect(applyToRun).not.toHaveBeenCalled();
  });
});
