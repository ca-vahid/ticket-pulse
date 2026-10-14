import { jest } from '@jest/globals';

/**
 * Assignment spread in the pipeline (QA 10-13 item 17) - the two small hooks:
 *   _executeRun      the guard is asked just before an auto-assignment is
 *                    written; a moved ticket rides on the run row exactly like
 *                    the urgent guard's redirect, and the record is kept on
 *                    the run (recommendation.spread);
 *   drainQueuedRuns  with the stagger on, the queue is released a few at a
 *                    time, most urgent first, one decision after another.
 * In both, a failure in the spread code changes nothing.
 * Harness from urgentResponseGuard.test.js.
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
const spreadStep = () => assignmentRepositoryMock.createPipelineStep.mock.calls.map(([s]) => s).find((s) => s.stepName === 'assignment_spread');
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
  submit(REAL);
  spies = [
    jest.spyOn(pipeline, '_persistInternalClassification').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistPriorityAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_persistTicketTypeAssessment').mockResolvedValue(),
    jest.spyOn(pipeline, '_broadcastRunUpdate').mockImplementation(() => {}),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

const SPREAD_SENTENCE = 'Given to Eli instead of Dana: Dana already got 3 tickets from automation in the last 10 minutes (the cap is 3).';
const MOVED = {
  techId: 6, techName: 'Eli', changed: true, moved: true, rule: 'cap', sentence: SPREAD_SENTENCE,
  record: { v: 1, rule: 'cap', unit: 'ticket:501', recent: 3, from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' }, why: SPREAD_SENTENCE },
  step: { stepName: 'assignment_spread', status: 'completed', durationMs: 0, output: { kind: 'assignment_spread', rule: 'cap', fromTechId: 5, toTechId: 6, message: SPREAD_SENTENCE } },
};

describe('the spread hook in _executeRun', () => {
  test('asked after the urgent guard and before the run row is written, with the run\'s own ranked list', async () => {
    const order = [];
    guardAutoAssignment.mockImplementation(async () => { order.push('urgent'); return { outcome: 'keep', techId: 5, sentence: null, shadow: false }; });
    spreadGuard.mockImplementation(async () => { order.push('spread'); return { techId: 5, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null }; });
    assignmentRepositoryMock.updatePipelineRun.mockImplementation(async (_id, data) => { if (data && 'decision' in data) order.push('run_update'); return {}; });
    await run();
    expect(order).toEqual(['urgent', 'spread', 'run_update']);
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS_ID, ticketId: TICKET_ID, runId: RUN_ID, techId: 5, techName: 'Dana', locked: false, dryRun: false, reboundFrom: null,
      recommendation: expect.objectContaining({ recommendations: expect.any(Array) }),
    }));
  });

  test('nothing to do: the AI\'s pick is assigned, no step, no note - and the record is kept on the run', async () => {
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5, syncStatus: 'pending' });
    expect(update.decisionNote).toBeUndefined();
    expect(update.recommendation.spread).toEqual({ v: 1, rule: 'none', unit: 'ticket:501', recent: 0 });
    expect(spreadStep()).toBeUndefined();
  });

  test('the cap moved it: the run row carries the next person, a step and a note explain it, the sync runs', async () => {
    spreadGuard.mockResolvedValue(MOVED);
    const events = await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 6, decisionNote: SPREAD_SENTENCE, syncStatus: 'pending', errorMessage: null });
    // The ranked recommendation is left as the AI wrote it; the record says what happened.
    expect(update.recommendation.recommendations[0]).toMatchObject({ techId: 5, techName: 'Dana' });
    expect(update.recommendation.spread).toMatchObject({ rule: 'cap', from: { techId: 5 }, to: { techId: 6 } });
    expect(spreadStep()).toMatchObject({ pipelineRunId: RUN_ID, stepName: 'assignment_spread', stepNumber: expect.any(Number), output: { rule: 'cap', toTechId: 6 } });
    expect(events).toContainEqual({ type: 'assignment_spread', rule: 'cap', message: SPREAD_SENTENCE });
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
  });

  test('the cap gave way: the same person, and the run says so', async () => {
    const sentence = 'Dana already got 3 tickets from automation in the last 10 minutes (the cap is 3), but nobody else qualified is at work, so the cap gave way.';
    spreadGuard.mockResolvedValue({ ...MOVED, techId: 5, techName: 'Dana', moved: false, rule: 'cap_gave_way', sentence, step: { ...MOVED.step, output: { rule: 'cap_gave_way' } } });
    await run();
    expect(finalRunUpdate()).toMatchObject({ assignedTechId: 5, decisionNote: sentence });
    expect(spreadStep().output.rule).toBe('cap_gave_way');
  });

  test('a person the urgent rule chose is passed as locked, and both sentences are kept', async () => {
    guardAutoAssignment.mockResolvedValue({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', sentence: SENTENCE, shadow: false });
    spreadGuard.mockResolvedValue({ techId: 22, changed: false, moved: false, rule: 'none', sentence: null, record: null, step: null });
    await run();
    expect(spreadGuard).toHaveBeenCalledWith(expect.objectContaining({ techId: 22, techName: 'Maria Lee', locked: true }));
    expect(finalRunUpdate()).toMatchObject({ assignedTechId: 22, decisionNote: SENTENCE });
  });

  test('not an automatic assignment (review mode, or held by the urgent rule): the guard is not asked', async () => {
    config({ autoAssign: false });
    await run();
    expect(spreadGuard).not.toHaveBeenCalled();
    jest.clearAllMocks();
    config();
    assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 1 });
    guardAutoAssignment.mockResolvedValue({ outcome: 'hold', techId: null, sentence: 'Nobody is at work.', shadow: false });
    await run();
    expect(spreadGuard).not.toHaveBeenCalled();
  });

  test('the spread code throws: the assignment goes ahead exactly as it was', async () => {
    spreadGuard.mockRejectedValue(new Error('boom'));
    await run();
    const update = finalRunUpdate();
    expect(update).toMatchObject({ decision: 'auto_assigned', assignedTechId: 5, syncStatus: 'pending' });
    expect(update.decisionNote).toBeUndefined();
    expect(update.recommendation.spread).toBeUndefined();
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
  });

  test('the step cannot be saved: still assigned to the person the rule chose', async () => {
    spreadGuard.mockResolvedValue(MOVED);
    assignmentRepositoryMock.createPipelineStep.mockImplementation(async (s) => { if (s.stepName === 'assignment_spread') throw new Error('step table down'); return { id: 1 }; });
    await run();
    expect(finalRunUpdate()).toMatchObject({ decision: 'auto_assigned', assignedTechId: 6, decisionNote: SPREAD_SENTENCE });
  });
});

describe('the staggered release in drainQueuedRuns', () => {
  const queuedRun = (id, priority, createdAt) => ({ id, ticketId: 700 + id, triggerSource: 'webhook', createdAt: new Date(createdAt), queuedAt: new Date(createdAt), ticket: { priority } });
  let queue;
  let executed;
  let inFlight;
  let maxInFlight;
  let extra;

  beforeEach(() => {
    queue = [queuedRun(1, 2, '2026-10-14T03:00:00Z'), queuedRun(2, 4, '2026-10-14T09:00:00Z'), queuedRun(3, 2, '2026-10-14T01:00:00Z'), queuedRun(4, 1, '2026-10-14T02:00:00Z')];
    executed = [];
    inFlight = 0;
    maxInFlight = 0;
    assignmentRepositoryMock.listQueuedRuns = jest.fn(async (_ws, limit) => queue.slice(0, limit));
    assignmentRepositoryMock.claimQueuedRun = jest.fn(async (id) => { const had = queue.some((r) => r.id === id); queue = queue.filter((r) => r.id !== id); return had; });
    assignmentRepositoryMock.markRunSkippedStale = jest.fn(async () => ({}));
    extra = [
      jest.spyOn(pipeline, '_initializeQueueValidationClient').mockResolvedValue(null),
      jest.spyOn(pipeline, 'validateQueuedRun').mockImplementation(async (r) => (r.stale ? { valid: false, reason: 'ticket_already_assigned' } : { valid: true })),
      jest.spyOn(pipeline, '_executeRun').mockImplementation(async (runId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        executed.push(runId);
        inFlight -= 1;
      }),
    ];
  });
  afterEach(() => extra.forEach((s) => s.mockRestore()));

  const staggered = (allowance = 2) => {
    const release = {
      staggered: true, wait: false, allowance, fetchLimit: 50, maxRounds: 8,
      order: (runs) => [...runs].sort((a, b) => (b.ticket.priority - a.ticket.priority) || (a.queuedAt - b.queuedAt)),
      started: jest.fn(), done: jest.fn(),
    };
    beginRelease.mockResolvedValue(release);
    return release;
  };

  test('stagger off: the drain is exactly the old one (batch of 10, 4 at a time, queue order)', async () => {
    const out = await pipeline.drainQueuedRuns(WS_ID);
    expect(out).toEqual({ processed: 4, skipped: 0 });
    expect(assignmentRepositoryMock.listQueuedRuns).toHaveBeenCalledWith(WS_ID, 10);
    expect([...executed].sort()).toEqual([1, 2, 3, 4]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('stagger on: only the allowance is released, most urgent then oldest, one at a time', async () => {
    const release = staggered(2);
    const out = await pipeline.drainQueuedRuns(WS_ID);
    expect(out).toEqual({ processed: 2, skipped: 0, staggered: true });
    expect(executed).toEqual([2, 3]);
    expect(maxInFlight).toBe(1);
    expect(assignmentRepositoryMock.listQueuedRuns).toHaveBeenCalledWith(WS_ID, 50);
    expect(release.started).toHaveBeenCalledTimes(2);
    expect(release.done).toHaveBeenCalledTimes(1);
    expect(queue.map((r) => r.id)).toEqual([1, 4]);
  });

  test('a stale run is swept away without using up the allowance', async () => {
    queue[1].stale = true;
    staggered(2);
    const out = await pipeline.drainQueuedRuns(WS_ID);
    expect(out).toEqual({ processed: 2, skipped: 1, staggered: true });
    expect(executed).toEqual([3, 1]);
    expect(assignmentRepositoryMock.markRunSkippedStale).toHaveBeenCalledWith(2, 'ticket_already_assigned');
  });

  test('a release is already running, or the interval is used up: this tick does nothing', async () => {
    beginRelease.mockResolvedValue({ staggered: true, wait: true });
    expect(await pipeline.drainQueuedRuns(WS_ID)).toEqual({ processed: 0, skipped: 0, staggered: true, waiting: true });
    expect(assignmentRepositoryMock.listQueuedRuns).not.toHaveBeenCalled();
  });

  test('the release is always handed back, also when a run blows up', async () => {
    const release = staggered(3);
    pipeline._executeRun.mockRejectedValueOnce(new Error('llm down'));
    const out = await pipeline.drainQueuedRuns(WS_ID);
    expect(release.done).toHaveBeenCalledTimes(1);
    expect(out.staggered).toBe(true);
  });

  test('the spread code throws: the queue drains as before', async () => {
    beginRelease.mockRejectedValue(new Error('boom'));
    const out = await pipeline.drainQueuedRuns(WS_ID);
    expect(out).toEqual({ processed: 4, skipped: 0 });
  });
});
