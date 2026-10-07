import { jest } from '@jest/globals';

/**
 * QA 10-05 #5 — workflow watch: a workflow whose noise check was replaced, or
 * that runs and sends nothing after sending regularly, is flagged.
 */
const prismaMock = {
  notificationWorkflow: { findMany: jest.fn(), groupBy: jest.fn() },
  notificationWorkflowRun: { groupBy: jest.fn() },
  notificationDelivery: { findMany: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { NotificationWorkflowWatchService, lintWorkflowDefinition, wentQuiet } = await import('../src/services/notificationWorkflowWatchService.js');

const NOISE_RULE = { '!=': [{ var: 'ticket.isNoise' }, true] };
const URGENT = { field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' };
const def = (data) => ({ nodes: [{ id: 'skip-noise', type: 'condition', data: { label: 'Skip noise tickets', ...data } }], edges: [] });
const NOW = new Date('2026-10-05T20:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000);

beforeEach(() => jest.clearAllMocks());

describe('definition lint', () => {
  test('conditions that replaced the noise rule are flagged; keeping a noise row, or no conditions, is fine', () => {
    const replaced = lintWorkflowDefinition(def({ rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [URGENT] } }));
    expect(replaced).toEqual([expect.objectContaining({ code: 'noise_check_replaced', nodeId: 'skip-noise', message: expect.stringContaining('no longer skips noise tickets') })]);
    expect(lintWorkflowDefinition(def({ rule: NOISE_RULE }))).toEqual([]);
    expect(lintWorkflowDefinition(def({ rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.isNoise', operator: 'is_false' }, URGENT] } }))).toEqual([]);
    expect(lintWorkflowDefinition(def({ rule: true, conditionGroup: { logic: 'all', conditions: [] } }))).toEqual([]);
    expect(lintWorkflowDefinition(null)).toEqual([]);
  });

  test('QA 10-06 #2: a step whose Skip noise tickets switch is set (on or off) made the choice on purpose', () => {
    expect(lintWorkflowDefinition(def({ skipNoise: true, rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [URGENT] } }))).toEqual([]);
    expect(lintWorkflowDefinition(def({ skipNoise: false, rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [URGENT] } }))).toEqual([]);
  });
});

describe('went quiet', () => {
  test('needs runs, no sends, and a real sending history', () => {
    expect(wentQuiet({ runs24h: 12, sent24h: 0, sentPrior7d: 40 })).toBe(true);
    expect(wentQuiet({ runs24h: 12, sent24h: 1, sentPrior7d: 40 })).toBe(false);
    expect(wentQuiet({ runs24h: 2, sent24h: 0, sentPrior7d: 40 })).toBe(false);
    expect(wentQuiet({ runs24h: 12, sent24h: 0, sentPrior7d: 3 })).toBe(false);
  });

  test('a live workflow that ran and sent nothing is flagged; shadow ones are not counted', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([
      { id: 1, name: 'Ticket assigned', isEnabled: true, mockModeEnabled: false, publishedDefinition: def({ rule: NOISE_RULE }) },
      { id: 2, name: 'Shadowed', isEnabled: true, mockModeEnabled: true, publishedDefinition: def({ rule: NOISE_RULE }) },
      { id: 3, name: 'Healthy', isEnabled: true, mockModeEnabled: false, publishedDefinition: def({ rule: NOISE_RULE }) },
    ]);
    prismaMock.notificationWorkflowRun.groupBy.mockResolvedValue([{ workflowId: 1, _count: { _all: 9 } }, { workflowId: 3, _count: { _all: 9 } }]);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => ({ createdAt: hoursAgo(30 + i * 10), workflowRun: { workflowId: 1 } })),
      ...Array.from({ length: 8 }, (_, i) => ({ createdAt: hoursAgo(30 + i * 10), workflowRun: { workflowId: 3 } })),
      { createdAt: hoursAgo(2), workflowRun: { workflowId: 3 } },
    ]);
    const svc = new NotificationWorkflowWatchService();
    const out = await svc.signalsForWorkspace(1, { now: NOW });
    expect(Object.keys(out)).toEqual(['1']);
    expect(out[1][0]).toMatchObject({ code: 'went_quiet', runs24h: 9, sent24h: 0, sentPrior7d: 8 });
    expect(prismaMock.notificationWorkflowRun.groupBy.mock.calls[0][0].where.workflowId.in).toEqual([1, 3]);
    // cached for five minutes
    await svc.signalsForWorkspace(1, { now: new Date(NOW.getTime() + 60_000) });
    expect(prismaMock.notificationWorkflow.findMany).toHaveBeenCalledTimes(1);
  });

  test('the hourly pass logs one line per workspace with signals, and never throws', async () => {
    prismaMock.notificationWorkflow.groupBy.mockResolvedValue([{ workspaceId: 1 }]);
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([
      { id: 5, name: 'Urgent', isEnabled: false, mockModeEnabled: false, publishedDefinition: def({ rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [URGENT] } }) },
    ]);
    const svc = new NotificationWorkflowWatchService();
    await svc.logSignals(NOW);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Workflow watch: workspace 1 has 1 signal(s): #5 noise_check_replaced'));
    prismaMock.notificationWorkflow.groupBy.mockRejectedValue(new Error('db down'));
    await expect(svc.logSignals(NOW)).resolves.toBeUndefined();
  });
});
