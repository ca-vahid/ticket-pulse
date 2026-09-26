import { jest } from '@jest/globals';

/**
 * Runner hooks for Auto-help P1 "Knowledge that grows":
 *  - trigger 'backtest' is a probe: a RESOLVED ticket an agent already
 *    answered still runs (skip reasons become warnings), a switched-off
 *    playbook still runs, the run is shadow even when the playbook and the
 *    workspace are in approve mode, and nothing is staged, sent or written
 *    to the ticket; "what the team did" is the team's actual reply.
 *  - verified-solution retrieval prefers the solution's own vector and pulls
 *    in older semantic matches beyond the most-recent pool.
 */
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
  autoHelpRun: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
  autoHelpPlaybook: { findFirst: jest.fn(), findMany: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
  knowledgeArticle: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketApproval: { count: jest.fn() },
  ticketProposedReply: { create: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  notificationWorkflow: { findMany: jest.fn() },
  ticketPark: { create: jest.fn() },
};
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };
const sendgridMock = { sendEmail: jest.fn() };
const graphMock = { sendMail: jest.fn(), isConfigured: jest.fn(() => true) };
const ticketServiceMock = {
  solutionSuggestions: jest.fn(), addReply: jest.fn(), addThreadEntry: jest.fn(), _addThreadEntry: jest.fn(), changeStatus: jest.fn(),
};
const nearestMock = jest.fn(async () => ({ cosById: new Map(), topIds: [] }));
const embedState = { configured: false };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, s) => (['Resolved', 'Closed'].includes(s) ? s : 'Open')) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: { search: jest.fn(async () => ({ results: { q: [] } })) } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => embedState.configured,
  embedQueryTexts: jest.fn(async (texts) => texts.map(() => [1, 0])),
  cosineSimilarity: (a, b) => a.reduce((s, x, i) => s + x * (b[i] || 0), 0),
  nearestVerifiedSolutions: nearestMock,
}));

const { default: runner, RUN_BUDGET, PROBE_TRIGGERS } = await import('../src/services/autoHelpRunner.js');

const RESOLVED_TICKET = {
  id: 55, workspaceId: 1, subject: 'Install Bluebeam please', descriptionText: 'Could you install Bluebeam Revu on my laptop?',
  status: 'Resolved', priority: 2, isNoise: false, origin: 'ticketpulse', nativeNumber: 900, freshserviceTicketId: null,
  createdAt: new Date('2026-09-01T10:00:00Z'), internalCategoryId: 10, internalSubcategoryId: 101, requesterId: 7,
  triageMode: null, fsApprovalStatus: null, firstPublicAgentReplyAt: new Date('2026-09-01T11:00:00Z'),
  internalCategory: { id: 10, name: 'Software & Apps' }, internalSubcategory: { id: 101, name: 'Installation' },
  requester: { id: 7, name: 'Pat Requester', email: 'pat@example.com' },
};
const PLAYBOOK = {
  id: 3, workspaceId: 1, name: 'Software installs', enabled: false, mode: 'approve', categoryId: 10, subcategoryIds: [101],
  match: { keywords: ['install'], excludeKeywords: [] }, instructions: 'Answer from the articles.', instructionsAreSource: false,
  allowedTools: ['search_knowledge'], kbScope: { mode: 'all', includeVerifiedSolutions: true }, minConfidence: 0.5,
  followUp: null, priority: 100, version: 2, sensitive: false,
};
const ARTICLE = {
  id: 12, title: 'Install apps from Company Portal', bodyText: 'Open Company Portal, search for Bluebeam Revu, choose Install.',
  bodyHtml: '<p>Open Company Portal, search for Bluebeam Revu, choose Install.</p>', tags: ['install'], categoryId: 10, subcategoryId: 101,
  embedding: [], updatedAt: new Date(), status: 'published',
};
const SUBMIT = {
  message: {
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use', id: 't1', name: 'submit_auto_help_reply',
      input: { answerable: true, stayQuiet: { matched: false }, subject: 'Installing Bluebeam', steps: [{ text: 'Open Company Portal and install Bluebeam Revu.', sourceIds: ['article:12'] }], confidence: 0.95 },
    }],
  },
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  usage: { inputTokens: 1000, outputTokens: 100 },
};

beforeEach(() => {
  jest.clearAllMocks();
  runner.budget = RUN_BUDGET;
  runner.lastSweepAt = 0;
  runner.alwaysHumanCache.clear();
  embedState.configured = false;
  prismaMock.ticket.findFirst.mockResolvedValue({ ...RESOLVED_TICKET });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT' });
  prismaMock.autoHelpRun.findFirst.mockResolvedValue(null);
  prismaMock.autoHelpRun.count.mockResolvedValue(0);
  prismaMock.autoHelpRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.autoHelpRun.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
  prismaMock.autoHelpRun.create.mockImplementation(async ({ data }) => ({ id: 901, createdAt: new Date(), ...data }));
  prismaMock.autoHelpRun.update.mockImplementation(async ({ where, data }) => ({ id: where.id, workspaceId: 1, ticketId: 55, playbookId: 3, trigger: 'backtest', mode: 'shadow', createdAt: new Date(), ...data }));
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([PLAYBOOK]);
  prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(PLAYBOOK);
  // Approve mode switched on for the workspace: a live run could stage; a backtest must not.
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, approveModeEnabled: true, disclosureEnabled: true, disclosureText: null });
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([ARTICLE]);
  prismaMock.ticketApproval.count.mockResolvedValue(0);
  prismaMock.ticketProposedReply.count.mockResolvedValue(0);
  prismaMock.ticketThreadEntry.count.mockResolvedValue(1);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.notificationWorkflow.findMany.mockResolvedValue([]);
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
  gatewayMock.runToolTurn.mockResolvedValue(SUBMIT);
  gatewayMock.sendJson.mockResolvedValue({ parsed: { sufficient: 'yes', unsupportedSteps: [], stayQuiet: { matched: false } }, provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 200, outputTokens: 20 } });
});

function expectNothingWritten() {
  expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  expect(graphMock.sendMail).not.toHaveBeenCalled();
  expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  expect(prismaMock.ticketProposedReply.create).not.toHaveBeenCalled();
  expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  expect(prismaMock.ticketPark.create).not.toHaveBeenCalled();
}

describe('trigger "backtest"', () => {
  test('is a probe trigger', () => {
    expect(PROBE_TRIGGERS).toEqual(['test', 'backtest']);
  });

  test('runs on a resolved, already-answered ticket with a switched-off approve-mode playbook; shadow; writes nothing', async () => {
    const run = await runner.runForTicket(55, { trigger: 'backtest', playbookId: 3, workspaceId: 1 });
    expect(run.skipped).toBeUndefined();
    expect(run.status).toBe('drafted');
    expect(run.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/already resolved/), expect.stringMatching(/agent already replied/),
    ]));
    const created = prismaMock.autoHelpRun.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ trigger: 'backtest', mode: 'shadow', playbookId: 3, status: 'running' });
    expect(created.mode).not.toBe('approve');
    expectNothingWritten();
  });

  test('a missing ticket is an error the batch can record (not a silent skip)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await expect(runner.runForTicket(99, { trigger: 'backtest', playbookId: 3, workspaceId: 1 })).rejects.toThrow(/not found/i);
  });

  test('"what the team did" is the team\'s actual first reply (no after-the-run filter)', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    await runner._teamOutcome(1, { ticketId: 55, trigger: 'backtest', createdAt: new Date() });
    const where = prismaMock.ticketThreadEntry.findFirst.mock.calls[0][0].where;
    expect(where.occurredAt).toBeUndefined();
    await runner._teamOutcome(1, { ticketId: 55, trigger: 'categorized', createdAt: new Date() });
    expect(prismaMock.ticketThreadEntry.findFirst.mock.calls[1][0].where.occurredAt).toBeDefined();
  });
});

describe('verified solutions by their own vectors', () => {
  const row = (id, subject, note, vec, sub = 101) => ({
    id, workspaceId: 1, subject, solutionNote: note, internalSubcategoryId: sub, origin: 'ticketpulse', nativeNumber: id,
    freshserviceTicketId: null, requester: { name: 'Someone Else', email: 'se@example.com' }, embedding: { embedding: vec },
  });

  test('solution cosine wins over the ticket content vector; older semantic matches join the pool', async () => {
    nearestMock.mockResolvedValue({ cosById: new Map([[21, 0.65], [22, 0.05], [23, 0.6]]), topIds: [21, 23] });
    prismaMock.ticket.findMany
      .mockResolvedValueOnce([row(21, 'Bluebeam install', 'Installed from Company Portal', [0, 1]), row(22, 'Printer', 'Replaced toner', [1, 0])])
      .mockResolvedValueOnce([row(23, 'Revu setup', 'Company Portal again', [0, 1])]);
    const out = await runner._verifiedSolutions({ ...RESOLVED_TICKET }, { queryVec: [1, 0], tokens: [] });
    expect(nearestMock).toHaveBeenCalledWith(1, [1, 0], expect.objectContaining({ categoryId: 10, excludeTicketId: 55 }));
    const second = prismaMock.ticket.findMany.mock.calls[1][0];
    expect(second.where.id.in).toEqual([23]);
    expect(second.take).toBe(1);
    // 22's content vector matches the query exactly (cos 1) but its SOLUTION does not (0.05): it drops out.
    expect(out.map((s) => s.id)).toEqual([21, 23]);
  });

  test('no solution vectors (table missing / not embedded yet) -> the content vector as before', async () => {
    nearestMock.mockResolvedValue({ cosById: new Map(), topIds: [] });
    prismaMock.ticket.findMany.mockResolvedValueOnce([row(22, 'Printer', 'Replaced toner', [1, 0])]);
    const out = await runner._verifiedSolutions({ ...RESOLVED_TICKET }, { queryVec: [1, 0], tokens: [] });
    expect(out.map((s) => s.id)).toEqual([22]);
    expect(prismaMock.ticket.findMany).toHaveBeenCalledTimes(1);
  });
});
