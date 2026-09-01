import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// NT-1/NT-2/NT-3 (MEGA-0831 Phase NT): deterministic never_noise veto.
// - noiseRuleService.evaluateNeverNoise matches subject + first 2KB of
//   description + category name; noise-mode rules stay subject-only.
// - assignmentPipelineService: an LLM noise verdict (empty recommendations)
//   is forced to pending_review when a never_noise rule matches — with a
//   'noise_veto' trace step — and auto_close_noise never fires.
// - noise-rule CRUD accepts and validates the mode field.

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  noiseRule: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
  },
  assignmentPipelineRun: { findUnique: jest.fn(), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
  ticketAssignmentEpisode: { findFirst: jest.fn() },
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

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({
  default: { anthropic: { apiKey: 'test-key' } },
}));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: assignmentRepositoryMock,
}));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: promptRepositoryMock,
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: { isBusinessHours: jest.fn() },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [],
  executeTool: jest.fn(),
  applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: freshServiceActionServiceMock,
}));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({
  default: { processDecisionFeedback: jest.fn() },
}));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({
  default: { queueForPriorityRun: jest.fn().mockResolvedValue({ queued: 0 }) },
}));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: providerGatewayMock,
}));
jest.unstable_mockModule('../src/services/assignmentRecommendationValidation.js', () => ({
  normalizeSubmitRecommendationPayload: jest.fn(async (input) => ({ ...input })),
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.workspaceId = 1;
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { default: assignmentPipelineService } = await import('../src/services/assignmentPipelineService.js');
const { default: noiseRoutes } = await import('../src/routes/noise.routes.js');

const VETO_RULE = {
  id: 5,
  name: 'Physical packages & shipping',
  pattern: '(package|shipping room|mailroom|courier|FedEx|UPS|Purolator|DHL|equipment pickup)',
  mode: 'never_noise',
  category: 'operations',
  isEnabled: true,
  dedupWindowDays: null,
};
const NOISE_RULE = {
  id: 6,
  name: 'Synology NAS Alerts',
  pattern: '^\\[BGC-',
  mode: 'noise',
  category: 'infrastructure',
  isEnabled: true,
  dedupWindowDays: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  noiseRuleService.invalidateCache();
});

describe('noiseRuleService.evaluateNeverNoise (NT-2 matching surface)', () => {
  beforeEach(() => {
    prismaMock.noiseRule.findMany.mockResolvedValue([VETO_RULE, NOISE_RULE]);
  });

  test('vetoes on subject match', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'FedEx label needed for a shipment',
    });
    expect(result).toEqual({ vetoed: true, ruleId: 5, ruleName: 'Physical packages & shipping' });
  });

  test('vetoes on a match inside the first 2KB of the description', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Hello',
      description: `Please help.\n${'x'.repeat(500)}\nThere is a package in the shipping room.`,
    });
    expect(result.vetoed).toBe(true);
  });

  test('ignores description content beyond the 2KB cap', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Hello',
      description: `${'x'.repeat(2048)} FedEx package waiting`,
    });
    expect(result.vetoed).toBe(false);
  });

  test('vetoes on category name match', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Item at front desk',
      category: 'Mailroom & courier services',
    });
    expect(result.vetoed).toBe(true);
  });

  test('does not veto when nothing matches', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Printer is jammed',
      description: 'Paper stuck in tray 2',
      category: 'Hardware',
    });
    expect(result).toEqual({ vetoed: false, ruleId: null, ruleName: null });
  });

  test('noise-mode rules never act as a veto', async () => {
    const result = await noiseRuleService.evaluateNeverNoise(1, {
      subject: '[BGC-FDR] Synology replication failed',
    });
    expect(result.vetoed).toBe(false);
  });
});

describe('noiseRuleService.evaluate (noise mode unchanged, NT-2 zero-behavior-change)', () => {
  beforeEach(() => {
    prismaMock.noiseRule.findMany.mockResolvedValue([VETO_RULE, NOISE_RULE]);
  });

  test('never_noise rules never mark a ticket as noise', async () => {
    const result = await noiseRuleService.evaluate('FedEx package waiting in the shipping room', null, 1);
    expect(result).toEqual({ isNoise: false, ruleId: null, category: null });
  });

  test('noise-mode rules keep matching on subject only', async () => {
    const result = await noiseRuleService.evaluate('[BGC-FDR] Synology replication failed', null, 1);
    expect(result).toEqual({ isNoise: true, ruleId: 'Synology NAS Alerts', category: 'infrastructure' });
  });
});

describe('assignmentPipelineService noise veto (NT-1 pipeline touchpoints)', () => {
  const RUN_ID = 9001;
  const TICKET_ID = 501;
  const WS_ID = 1;
  let persistClassificationSpy;
  let persistTypeSpy;
  let broadcastSpy;

  const packageTicket = {
    groupId: null,
    origin: 'freshservice',
    subject: 'Package waiting at reception',
    description: null,
    descriptionText: 'A FedEx package arrived for the lab.',
    category: null,
    internalCategory: null,
    status: 'Open',
    assignedTechId: null,
  };

  beforeEach(() => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      autoAssign: true,
      autoCloseNoise: true,
      priorityAssessmentEnabled: false,
      dryRunMode: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    promptRepositoryMock.getPublished.mockResolvedValue({
      id: 55,
      version: 33,
      systemPrompt: 'You are the assignment pipeline.',
      toolConfig: { enableWebSearch: false },
    });
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({ reboundFrom: null });
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.findUnique.mockResolvedValue(packageTicket);
    prismaMock.ticket.update.mockResolvedValue({});
    assignmentRepositoryMock.updatePipelineRun.mockResolvedValue({});
    assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 1 });
    assignmentRepositoryMock.getPipelineRun.mockResolvedValue({ id: RUN_ID, status: 'completed' });
    providerGatewayMock.runToolTurn.mockResolvedValue({
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'submit_recommendation',
          input: { recommendations: [], ticketClassification: 'Noise', closureNoticeHtml: '<p>Automated alert.</p>' },
        }],
        stop_reason: 'tool_use',
      },
      usage: { totalTokens: 42 },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260217',
      fallbackUsed: false,
      fallbackReason: null,
      attemptNumber: 1,
    });

    persistClassificationSpy = jest
      .spyOn(assignmentPipelineService, '_persistInternalClassification')
      .mockResolvedValue();
    persistTypeSpy = jest
      .spyOn(assignmentPipelineService, '_persistTicketTypeAssessment')
      .mockResolvedValue();
    broadcastSpy = jest
      .spyOn(assignmentPipelineService, '_broadcastRunUpdate')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    persistClassificationSpy.mockRestore();
    persistTypeSpy.mockRestore();
    broadcastSpy.mockRestore();
  });

  function finalRunUpdate() {
    const call = assignmentRepositoryMock.updatePipelineRun.mock.calls.find(
      ([, data]) => data && Object.prototype.hasOwnProperty.call(data, 'decision'),
    );
    return call ? call[1] : null;
  }

  test('never_noise match forces pending_review, records a noise_veto step, and blocks auto-close', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([VETO_RULE]);
    const events = [];

    await assignmentPipelineService._executeRun(
      RUN_ID, TICKET_ID, WS_ID, 'manual', Date.now(), (e) => events.push(e), null,
    );

    const update = finalRunUpdate();
    expect(update).not.toBeNull();
    expect(update.decision).toBe('pending_review');
    expect(update.errorMessage).toContain('Noise veto: rule "Physical packages & shipping"');
    // pending_review keeps decidedAt null and never stamps a sync
    expect(update.decidedAt).toBeUndefined();
    expect(update.syncStatus).toBeUndefined();

    // trace step visible in the run detail
    expect(assignmentRepositoryMock.createPipelineStep).toHaveBeenCalledWith(expect.objectContaining({
      pipelineRunId: RUN_ID,
      stepName: 'noise_veto',
      status: 'completed',
      output: expect.objectContaining({
        kind: 'noise_veto',
        ruleId: 5,
        ruleName: 'Physical packages & shipping',
        llmVerdict: 'noise',
        forcedDecision: 'pending_review',
        message: expect.stringContaining('can never be auto-dismissed'),
      }),
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'noise_veto', ruleName: 'Physical packages & shipping' }),
    ]));

    // auto_close_noise must never fire, and the ticket is never flagged noise
    expect(freshServiceActionServiceMock.execute).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('without a matching never_noise rule the noise dismissal proceeds unchanged', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([NOISE_RULE]);

    await assignmentPipelineService._executeRun(
      RUN_ID, TICKET_ID, WS_ID, 'manual', Date.now(), () => {}, null,
    );

    const update = finalRunUpdate();
    expect(update.decision).toBe('noise_dismissed');
    expect(update.decidedAt).toBeInstanceOf(Date);
    expect(update.syncStatus).toBe('pending');
    expect(freshServiceActionServiceMock.execute).toHaveBeenCalledWith(RUN_ID, WS_ID, false);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TICKET_ID },
      data: expect.objectContaining({ isNoise: true }),
    }));
    expect(assignmentRepositoryMock.createPipelineStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ stepName: 'noise_veto' }),
    );
  });

  test('after-hours noise short-circuit is vetoed too — assignment run still queues', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([VETO_RULE]);
    assignmentRepositoryMock.getOpenPipelineRun.mockResolvedValue(null);
    assignmentRepositoryMock.createQueuedRun.mockResolvedValue({ id: 8801, status: 'queued' });
    const runPipelineSpy = jest.spyOn(assignmentPipelineService, 'runPipeline').mockResolvedValue({
      id: 7702,
      status: 'completed',
      decision: 'noise_dismissed',
      recommendation: { recommendations: [] },
    });
    const events = [];

    const result = await assignmentPipelineService._runAfterHoursPriorityAssessmentAndQueue({
      ticketId: TICKET_ID,
      workspaceId: WS_ID,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours',
      reboundFrom: null,
      emit: (e) => events.push(e),
      signal: null,
    });

    expect(assignmentRepositoryMock.createQueuedRun).toHaveBeenCalled();
    expect(result.afterHoursQueueSkippedReason).toBeUndefined();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'noise_veto', ruleName: 'Physical packages & shipping' }),
    ]));

    runPipelineSpy.mockRestore();
  });

  test('after-hours noise short-circuit still skips the queue when no veto rule matches', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([NOISE_RULE]);
    const runPipelineSpy = jest.spyOn(assignmentPipelineService, 'runPipeline').mockResolvedValue({
      id: 7703,
      status: 'completed',
      decision: 'noise_dismissed',
      recommendation: { recommendations: [] },
    });

    const result = await assignmentPipelineService._runAfterHoursPriorityAssessmentAndQueue({
      ticketId: TICKET_ID,
      workspaceId: WS_ID,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours',
      reboundFrom: null,
      emit: () => {},
      signal: null,
    });

    expect(assignmentRepositoryMock.createQueuedRun).not.toHaveBeenCalled();
    expect(result.afterHoursQueueSkippedReason).toBe('noise_dismissed');

    runPipelineSpy.mockRestore();
  });
});

describe('noise-rule CRUD mode field (routes + service)', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/noise-rules', noiseRoutes);
    return app;
  }

  test('POST accepts mode=never_noise and passes it through to create', async () => {
    prismaMock.noiseRule.create.mockImplementation(async ({ data }) => ({ id: 77, matchCount: 0, ...data }));

    const res = await request(buildApp())
      .post('/api/noise-rules')
      .send({ name: 'Packages', pattern: '(package|courier)', mode: 'never_noise' });

    expect(res.status).toBe(201);
    expect(res.body.data.mode).toBe('never_noise');
    expect(prismaMock.noiseRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mode: 'never_noise', workspaceId: 1 }),
    });
  });

  test('POST defaults mode to noise when omitted', async () => {
    prismaMock.noiseRule.create.mockImplementation(async ({ data }) => ({ id: 78, matchCount: 0, ...data }));

    const res = await request(buildApp())
      .post('/api/noise-rules')
      .send({ name: 'Digest', pattern: '^Daily Digest' });

    expect(res.status).toBe(201);
    expect(res.body.data.mode).toBe('noise');
  });

  test('POST rejects an invalid mode', async () => {
    const res = await request(buildApp())
      .post('/api/noise-rules')
      .send({ name: 'Bad', pattern: 'x', mode: 'always_noise' });

    expect(res.status).toBe(400);
    expect(prismaMock.noiseRule.create).not.toHaveBeenCalled();
  });

  test('PUT accepts a mode change', async () => {
    prismaMock.noiseRule.findFirst.mockResolvedValue({ id: 12, workspaceId: 1, name: 'Packages' });
    prismaMock.noiseRule.update.mockImplementation(async ({ where, data }) => ({ id: where.id, name: 'Packages', ...data }));

    const res = await request(buildApp())
      .put('/api/noise-rules/12')
      .send({ mode: 'never_noise' });

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('never_noise');
    expect(prismaMock.noiseRule.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { mode: 'never_noise' },
    });
  });

  test('PUT rejects an invalid mode', async () => {
    const res = await request(buildApp())
      .put('/api/noise-rules/12')
      .send({ mode: 'sometimes' });

    expect(res.status).toBe(400);
    expect(prismaMock.noiseRule.update).not.toHaveBeenCalled();
  });

  test('GET list returns mode on each rule', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([VETO_RULE, NOISE_RULE]);

    const res = await request(buildApp()).get('/api/noise-rules');

    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.mode)).toEqual(['never_noise', 'noise']);
  });
});
