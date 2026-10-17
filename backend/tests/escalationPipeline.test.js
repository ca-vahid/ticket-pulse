import { jest } from '@jest/globals';

/**
 * QA 10-16 item 1 - Escalate, in the pipeline (harness from
 * assignmentSpreadPipeline.test.js):
 *  - the rebound run's prompt says it is an escalation, with the level and scope;
 *  - the guard's swap puts the more advanced person first and assigns them;
 *  - nobody more advanced: a suggestion only (pending_review) and the run says so;
 *  - a FreshService-reported escalation gets its snapshot read once;
 *  - a guard that blows up changes nothing.
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
const escalationGuard = jest.fn();
const contextFor = jest.fn();
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
jest.unstable_mockModule('../src/services/assignmentSpread/spreadService.js', () => ({ default: { guardAutoAssignment: spreadGuard, beginRelease: jest.fn() } }));
jest.unstable_mockModule('../src/services/escalation/escalationService.js', () => ({ default: { guard: escalationGuard, contextFor } }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');
const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { default: autoHelpPlaybookService } = await import('../src/services/autoHelpPlaybookService.js');

const RUN_ID = 9101;
const TICKET_ID = 601;
const WS_ID = 1;
const flush = () => new Promise((r) => setImmediate(r));
const REAL = {
  recommendations: [{ techId: 5, techName: 'Dana Fox', score: 0.9 }, { techId: 6, techName: 'Eli Park', score: 0.7 }],
  ticketClassification: 'Network > VPN', internalCategoryId: 40, internalSubcategoryId: 41, assessedPriority: 'Medium',
};
const SNAPSHOT = {
  fromTechId: 7, fromTechName: 'Alex Doe', level: 'intermediate', rank: 2, levelWord: 'intermediate',
  categoryId: 40, categoryName: 'Networking', subcategoryId: 41, subcategoryName: 'VPN', scope: 'Networking / VPN',
};
const REBOUND = {
  previousTechId: 7, previousTechName: 'Alex Doe', unassignedAt: '2026-10-16T17:00:00.000Z', reboundCount: 1, source: 'ticketpulse',
  reason: { code: 'escalate', label: 'Escalate to Advanced Troubleshooting Team', note: null, escalation: SNAPSHOT },
};

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
const step = () => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === 'escalation_guard');
const run = async (events = []) => {
  await pipeline._executeRun(RUN_ID, TICKET_ID, WS_ID, 'rebound', Date.now(), (e) => events.push(e), null);
  await flush();
  return events;
};
const guardResult = (outcome, extra = {}) => ({
  outcome,
  techId: extra.techId ?? 5,
  techName: extra.techName ?? 'Dana Fox',
  sentence: extra.sentence || `Escalation: ${outcome}`,
  recommendations: extra.recommendations || REAL.recommendations,
  record: { outcome, sentence: extra.sentence || `Escalation: ${outcome}`, suggestionOnly: outcome === 'none_higher' },
  step: { stepName: 'escalation_guard', status: 'completed', durationMs: 0, output: { kind: 'escalation_guard', outcome } },
});

let spies = [];
beforeEach(() => {
  jest.clearAllMocks();
  config();
  promptRepositoryMock.getPublished.mockResolvedValue({ id: 55, version: 33, systemPrompt: 'You are the assignment pipeline.', toolConfig: { enableWebSearch: false } });
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: REBOUND });
  prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
  prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findUnique.mockResolvedValue({
    groupId: null, origin: 'ticketpulse', subject: 'VPN drops', description: null, descriptionText: 'please', category: null, status: 'Open',
    internalCategoryId: 40, internalSubcategoryId: 41, internalCategory: { name: 'Networking' }, internalSubcategory: { name: 'VPN' },
  });
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.noiseRule.findMany.mockResolvedValue([]);
  noiseRuleService.invalidateCache();
  assignmentRepositoryMock.updatePipelineRun.mockResolvedValue({});
  assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 1 });
  assignmentRepositoryMock.getPipelineRun.mockResolvedValue({ id: RUN_ID, status: 'completed' });
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: WS_ID, enabled: false, enabledAt: null });
  autoHelpPlaybookService._enabledCache.clear();
  guardAutoAssignment.mockImplementation(async ({ techId }) => ({ outcome: 'keep', techId, sentence: null, shadow: false }));
  spreadGuard.mockImplementation(async ({ techId }) => ({ techId, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }));
  escalationGuard.mockResolvedValue(guardResult('kept'));
  submit(REAL);
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe('Escalate in the pipeline', () => {
  test('the prompt tells the AI it is an escalation from an intermediate person in Networking / VPN', async () => {
    await run();
    const first = providerGatewayMock.runToolTurn.mock.calls[0][0];
    const text = JSON.stringify(first.messages || first);
    expect(text).toContain('ESCALATION');
    expect(text).toContain('Alex Doe is at level \\"intermediate\\" in Networking / VPN');
    expect(text).toContain('advanced or expert');
  });

  test('the guard is asked with the snapshot and the AI\'s ranked list; kept = assigned as the AI said', async () => {
    await run();
    expect(escalationGuard).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS_ID, ticketId: TICKET_ID, runId: RUN_ID, escalation: SNAPSHOT,
      recommendation: expect.objectContaining({ recommendations: expect.any(Array) }),
    }));
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
    expect(update.recommendation.escalation).toMatchObject({ outcome: 'kept' });
    expect(step()).toMatchObject({ pipelineRunId: RUN_ID, stepName: 'escalation_guard' });
  });

  test('swapped: the more advanced person is put first and assigned, and the note says why', async () => {
    const swappedList = [{ techId: 6, techName: 'Eli Park', rank: 1, escalationPromoted: true }, { techId: 5, techName: 'Dana Fox', rank: 2 }];
    const sentence = 'Escalation: Dana Fox is not above Alex Doe (intermediate) in Networking / VPN, so Eli Park (expert) was put first.';
    escalationGuard.mockResolvedValue(guardResult('swapped', { techId: 6, techName: 'Eli Park', recommendations: swappedList, sentence }));
    const events = await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 6 });
    expect(update.decisionNote).toContain(sentence);
    expect(update.recommendation.recommendations[0]).toMatchObject({ techId: 6 });
    expect(guardAutoAssignment).toHaveBeenCalledWith(expect.objectContaining({ techId: 6 }));
    expect(events).toContainEqual({ type: 'escalation_guard', outcome: 'swapped', message: sentence });
  });

  test('an escalated pick is locked: Spread counts it but may not move it to someone less advanced', async () => {
    escalationGuard.mockResolvedValue(guardResult('swapped', { techId: 6, techName: 'Eli Park', recommendations: [{ techId: 6, techName: 'Eli Park', rank: 1 }], sentence: 'Escalation: Eli Park was put first.' }));
    await run();
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 6, locked: true }));
    expect(finalRunUpdate()).toMatchObject({ assignedTechId: 6 });
  });

  test('nobody more advanced: a suggestion only - pending_review, nothing written to the ticket', async () => {
    const sentence = 'Escalation: no one more advanced than Alex Doe (intermediate) in Networking / VPN is available. Left for a coordinator - a suggestion only.';
    escalationGuard.mockResolvedValue(guardResult('none_higher', { sentence }));
    await run();
    const update = finalRunUpdate();
    expect(update.decision).toBe('pending_review');
    expect(update.assignedTechId).toBeUndefined();
    expect(update.errorMessage).toBe(sentence);
    expect(update.recommendation.escalation).toMatchObject({ outcome: 'none_higher', suggestionOnly: true });
    expect(freshServiceActionServiceMock.execute).not.toHaveBeenCalled();
  });

  test('an escalation FreshService reported (no snapshot yet) gets one read and kept on the run', async () => {
    const { escalation, ...reason } = REBOUND.reason;
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: { ...REBOUND, source: 'freshservice_activity', verifiedByFreshserviceActivity: true, reason } });
    contextFor.mockResolvedValue(escalation);
    await run();
    expect(contextFor).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, ticketId: TICKET_ID, technicianId: 7 }));
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: RUN_ID }, data: { reboundFrom: expect.objectContaining({ reason: expect.objectContaining({ escalation }) }) },
    }));
    expect(escalationGuard).toHaveBeenCalledWith(expect.objectContaining({ escalation }));
  });

  test('not an escalation: the guard is never asked', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: { ...REBOUND, reason: { code: 'capacity', label: 'Capacity full', note: null } } });
    await run();
    expect(escalationGuard).not.toHaveBeenCalled();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
  });

  test('the guard throws: the AI\'s pick goes ahead unchanged', async () => {
    escalationGuard.mockRejectedValue(new Error('boom'));
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5 });
  });

  test('suggest-only workspace: the swap changes the suggestion', async () => {
    config({ autoAssign: false });
    const swappedList = [{ techId: 6, techName: 'Eli Park', rank: 1 }, { techId: 5, techName: 'Dana Fox', rank: 2 }];
    escalationGuard.mockResolvedValue(guardResult('swapped', { techId: 6, techName: 'Eli Park', recommendations: swappedList }));
    await run();
    const update = finalRunUpdate();
    expect(update.decision).toBe('pending_review');
    expect(update.recommendation.recommendations[0]).toMatchObject({ techId: 6 });
  });
});
