import { jest } from '@jest/globals';

/**
 * Auto-help P1 in the runner (plans/AUTO_HELP_P1_PLAN.md §1, §3):
 *  - approve mode stages a proposed reply ('staged_for_agent') only when every
 *    gate passed, and NEVER over a human draft that is already waiting
 *  - below the confidence bar / partial context / test runs / approve switch
 *    off → recorded, not staged
 *  - auto is locked in this build: an auto playbook is staged, never sent
 *  - the monthly cost cap stops a run before any model call
 *  - tokens and the estimated cost are stored on the run
 */
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
  autoHelpRun: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
  autoHelpPlaybook: { findFirst: jest.fn(), findMany: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
  autoHelpCostEntry: { aggregate: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  knowledgeArticle: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketApproval: { count: jest.fn() },
  ticketProposedReply: { count: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
  notificationWorkflow: { findMany: jest.fn() },
};
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };
const proposalsMock = { create: jest.fn() };
const ticketServiceMock = { addReply: jest.fn(), changeStatus: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, s) => (['Resolved', 'Closed'].includes(s) ? s : 'Open')) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketProposedReplyService.js', () => ({ default: proposalsMock }));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: { search: jest.fn(async () => ({ results: { q: [] } })) } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false,
  embedQueryTexts: jest.fn(async () => null),
  cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));

const { default: runner, RUN_BUDGET } = await import('../src/services/autoHelpRunner.js');
const { default: playbookService } = await import('../src/services/autoHelpPlaybookService.js');

const TICKET = {
  id: 55, workspaceId: 1, subject: 'Install Bluebeam please', descriptionText: 'Could you install Bluebeam Revu on my laptop?',
  status: 'Open', priority: 2, isNoise: false, origin: 'ticketpulse', nativeNumber: 900, freshserviceTicketId: null,
  createdAt: new Date('2026-09-20T10:00:00Z'), internalCategoryId: 10, internalSubcategoryId: 101, requesterId: 7,
  triageMode: null, fsApprovalStatus: null, firstPublicAgentReplyAt: null,
  internalCategory: { id: 10, name: 'Software & Apps' }, internalSubcategory: { id: 101, name: 'Installation' },
  requester: { id: 7, name: 'Pat Requester', email: 'pat@example.com' },
};
const PLAYBOOK = {
  id: 3, workspaceId: 1, name: 'Software installs', enabled: true, mode: 'approve', sensitive: false, categoryId: 10, subcategoryIds: [101],
  match: { keywords: ['install'], excludeKeywords: [] }, instructions: 'Company Portal installs.', instructionsAreSource: false,
  allowedTools: ['search_knowledge', 'get_article'], kbScope: { mode: 'all', includeVerifiedSolutions: true },
  minConfidence: 0.8, followUp: null, priority: 100, version: 2,
};
const ARTICLE = {
  id: 12, title: 'Install apps from Company Portal', status: 'published',
  bodyText: 'Open Company Portal, search for the app (Bluebeam Revu), choose Install.',
  bodyHtml: '<p>Open Company Portal, search for Bluebeam Revu, choose Install.</p>',
  tags: ['install'], categoryId: 10, subcategoryId: 101, embedding: [], updatedAt: new Date(),
};
const submit = (over = {}) => ({
  message: {
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use', id: 'tu1', name: 'submit_auto_help_reply',
      input: {
        answerable: true, stayQuiet: { matched: false }, subject: 'Installing Bluebeam', intro: 'You can install it yourself:',
        steps: [{ text: 'Open Company Portal.', sourceIds: ['article:12'] }, { text: 'Search for Bluebeam Revu and choose Install.', sourceIds: ['article:12'] }],
        confidence: 0.9, ...over,
      },
    }],
  },
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  usage: { inputTokens: 4000, outputTokens: 500 },
});
const CHECK_YES = { parsed: { sufficient: 'yes', unsupportedSteps: [], stayQuiet: { matched: false } }, provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 1000, outputTokens: 50 } };
const SETTINGS = { workspaceId: 1, enabled: true, approveModeEnabled: true, disclosureEnabled: true, disclosureText: null, monthlyCostCapUsd: null };

beforeEach(() => {
  jest.clearAllMocks();
  runner.budget = RUN_BUDGET;
  runner.alwaysHumanCache.clear();
  prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT', defaultTimezone: 'America/Vancouver' });
  prismaMock.autoHelpRun.findFirst.mockResolvedValue(null);
  prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
  prismaMock.autoHelpRun.count.mockResolvedValue(0);
  prismaMock.autoHelpRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.autoHelpRun.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
  prismaMock.autoHelpCostEntry.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
  prismaMock.autoHelpCostEntry.findMany.mockResolvedValue([]);
  prismaMock.autoHelpRun.create.mockImplementation(async ({ data }) => ({ id: 901, createdAt: new Date(), ...data }));
  prismaMock.autoHelpRun.update.mockImplementation(async ({ where, data }) => ({ id: where.id, workspaceId: 1, ticketId: 55, playbookId: 3, trigger: 'categorized', createdAt: new Date(), ...data }));
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([PLAYBOOK]);
  prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(PLAYBOOK);
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue(SETTINGS);
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([ARTICLE]);
  prismaMock.ticketApproval.count.mockResolvedValue(0);
  prismaMock.ticketProposedReply.count.mockResolvedValue(0);
  prismaMock.ticketThreadEntry.count.mockResolvedValue(0);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.notificationWorkflow.findMany.mockResolvedValue([]);
  gatewayMock.runToolTurn.mockResolvedValue(submit());
  gatewayMock.sendJson.mockResolvedValue(CHECK_YES);
  proposalsMock.create.mockImplementation(async (args) => ({ id: 77, ...args }));
});

const updates = () => prismaMock.autoHelpRun.update.mock.calls.map((c) => c[0].data);

describe('approve mode staging', () => {
  test('all gates pass → staged as an Auto-help proposal (never superseding), activity line written', async () => {
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(run.status).toBe('staged');
    expect(run.gateDecision).toBe('staged_for_agent');
    expect(run.proposedReplyId).toBe(77);
    const args = proposalsMock.create.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: 1, ticketId: 55, source: 'auto_help', autoHelpRunId: 901, supersede: false, confidence: 'high' });
    expect(args.bodyHtml).toContain('This is an automated first answer from the IT team');
    expect(args.bodyHtml).toContain('Did this sort it out?');
    expect(prismaMock.ticketActivity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ activityType: 'auto_help_staged' }) }));
    // Nothing is sent by staging.
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  });

  test('a human draft already waiting wins: nothing staged, the run says why', async () => {
    proposalsMock.create.mockResolvedValue(null);
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.status).toBe('drafted');
    expect(run.gateDecision).toBe('human_draft_exists');
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  });

  test('below the playbook\'s confidence bar → recorded as below_confidence, not staged', async () => {
    gatewayMock.runToolTurn.mockResolvedValue(submit({ confidence: 0.7 }));
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.gateDecision).toBe('below_confidence');
    expect(proposalsMock.create).not.toHaveBeenCalled();
  });

  // 30 Sep 2026: a partial draft used to be recorded and silently never shown;
  // it is now suggested to the agent, marked partial (never auto-sent).
  test('partial context is suggested to the agent, marked partial', async () => {
    gatewayMock.sendJson.mockResolvedValue({ parsed: { sufficient: 'partial', unsupportedSteps: [], stayQuiet: { matched: false } } });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.gateDecision).toBe('staged_for_agent');
    expect(proposalsMock.create).toHaveBeenCalledWith(expect.objectContaining({
      guardSummary: expect.objectContaining({ autoHelp: true, partial: true }),
    }));
  });

  test('approve switch off → the approve playbook runs as shadow', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, approveModeEnabled: false });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('shadow');
    expect(run.gateDecision).toBe('shadow_recorded');
    expect(proposalsMock.create).not.toHaveBeenCalled();
  });

  test('test runs never stage', async () => {
    const run = await runner.runForTicket(55, { trigger: 'test', playbookId: 3 });
    expect(run.mode).toBe('shadow');
    expect(run.status).toBe('drafted');
    expect(proposalsMock.create).not.toHaveBeenCalled();
  });

  test('an auto playbook in this build is staged for a person — never sent', async () => {
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ ...PLAYBOOK, mode: 'auto' }]);
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(run.status).toBe('staged');
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  });

  test('a sensitive auto playbook is staged even when the build switch is on and the gate is met', async () => {
    const spy = jest.spyOn(playbookService, 'autoModeAllowed').mockReturnValue(true);
    try {
      prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ ...PLAYBOOK, mode: 'auto', sensitive: true }]);
      const run = await runner.runForTicket(55, { trigger: 'categorized' });
      expect(run.mode).toBe('approve');
      expect(run.status).toBe('staged');
      expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('approve by day, auto by night (30 Sep 2026)', () => {
  let delivery;
  let spies = [];
  const setup = ({ afterHours = true, ready = true } = {}) => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, autoAfterHours: true });
    spies = [
      jest.spyOn(playbookService, 'isAfterHours').mockResolvedValue(afterHours),
      jest.spyOn(playbookService, 'cachedReadiness').mockResolvedValue({ met: ready }),
      jest.spyOn(delivery, '_autoSend').mockResolvedValue({ status: 'sent', gateDecision: 'auto_sent', decision: 'auto_sent', sentEntryId: 5000 }),
    ];
  };
  beforeAll(async () => { ({ default: delivery } = await import('../src/services/autoHelpDeliveryService.js')); });
  afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

  test('after hours, switch on, proven playbook, clean answer → sent by itself, marked scheduled', async () => {
    setup();
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('auto');
    expect(run.status).toBe('sent');
    expect(delivery._autoSend).toHaveBeenCalledWith(expect.objectContaining({ scheduled: true }));
    expect(proposalsMock.create).not.toHaveBeenCalled();
  });

  test('business hours → approve: staged for a person', async () => {
    setup({ afterHours: false });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(run.status).toBe('staged');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });

  test('after hours but the readiness checklist is not met → staged', async () => {
    setup({ ready: false });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });

  test('after hours, a partial answer → staged for the morning, never sent', async () => {
    setup();
    gatewayMock.sendJson.mockResolvedValue({ parsed: { sufficient: 'partial', unsupportedSteps: [], stayQuiet: { matched: false } } });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.gateDecision).toBe('staged_for_agent');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });

  test('after hours, below the confidence bar → not sent', async () => {
    setup();
    gatewayMock.runToolTurn.mockResolvedValue(submit({ confidence: 0.7 }));
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.gateDecision).toBe('below_confidence');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });

  test('a sensitive playbook never sends by itself, even after hours', async () => {
    setup();
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ ...PLAYBOOK, sensitive: true }]);
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });

  test('the switch off → approve, whatever the hour', async () => {
    setup();
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, autoAfterHours: false });
    const run = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(run.mode).toBe('approve');
    expect(delivery._autoSend).not.toHaveBeenCalled();
  });
});

describe('cost', () => {
  test('tokens and the estimated cost of every model call land on the run', async () => {
    await runner.runForTicket(55, { trigger: 'categorized' });
    const data = updates().find((d) => d.status === 'drafted');
    expect(data.inputTokens).toBe(5000);
    expect(data.outputTokens).toBe(550);
    // sonnet 5 2/10 per Mtok (4000 in, 500 out) + haiku 1/5 (1000 in, 50 out)
    expect(data.costUsd).toBeCloseTo((4000 * 2 + 500 * 10 + 1000 * 1 + 50 * 5) / 1e6, 6);
  });

  test('the monthly cap stops a new-ticket run before any model call (skip row budget_exhausted)', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, monthlyCostCapUsd: 5 });
    prismaMock.autoHelpRun.aggregate.mockResolvedValue({ _sum: { costUsd: 5.01 } });
    const res = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(res).toMatchObject({ skipped: true, gateDecision: 'budget_exhausted' });
    expect(gatewayMock.runToolTurn).not.toHaveBeenCalled();
    expect(prismaMock.autoHelpRun.create.mock.calls[0][0].data).toMatchObject({ status: 'skipped', gateDecision: 'budget_exhausted' });
  });

  test('a test run over the cap is refused with a plain message', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, monthlyCostCapUsd: 0 });
    await expect(runner.runForTicket(55, { trigger: 'test', playbookId: 3 })).rejects.toMatchObject({ code: 'auto_help_budget_exhausted' });
    expect(gatewayMock.runToolTurn).not.toHaveBeenCalled();
  });

  test('under the cap it runs; no cap = no limit', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, monthlyCostCapUsd: 5 });
    prismaMock.autoHelpRun.aggregate.mockResolvedValue({ _sum: { costUsd: 4.99 } });
    expect((await runner.runForTicket(55, { trigger: 'categorized' })).status).toBe('staged');
    expect(await runner.budgetState(1, { monthlyCostCapUsd: null })).toMatchObject({ capUsd: null, exhausted: false });
  });

  test('reply checks booked this month count toward the cap (runs 4.00 + reply checks 1.00 = 5.00 of 5)', async () => {
    prismaMock.autoHelpRun.aggregate.mockResolvedValue({ _sum: { costUsd: 4 } });
    prismaMock.autoHelpCostEntry.aggregate.mockResolvedValue({ _sum: { costUsd: 1 } });
    expect(await runner.budgetState(1, { monthlyCostCapUsd: 5 })).toMatchObject({ spentUsd: 5, exhausted: true });
    expect(prismaMock.autoHelpCostEntry.aggregate.mock.calls.at(-1)[0].where).toMatchObject({ workspaceId: 1, createdAt: { gte: expect.any(Date) } });
  });

  test('budget query fails with a cap set → fail closed (no model call); without a cap it still runs', async () => {
    prismaMock.autoHelpRun.aggregate.mockRejectedValue(new Error('db down'));
    expect(await runner.budgetState(1, { monthlyCostCapUsd: 5 })).toMatchObject({ exhausted: true, unknown: true });
    expect(await runner.budgetState(1, { monthlyCostCapUsd: null })).toMatchObject({ exhausted: false });
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ ...SETTINGS, monthlyCostCapUsd: 5 });
    const res = await runner.runForTicket(55, { trigger: 'categorized' });
    expect(res).toMatchObject({ skipped: true, gateDecision: 'budget_exhausted' });
    expect(gatewayMock.runToolTurn).not.toHaveBeenCalled();
  });
});
