import { jest } from '@jest/globals';

const prismaMock = {
  notificationLlmToolPolicy: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const {
  getNotificationLlmToolPolicy,
  notificationLlmToolCatalog,
  updateNotificationLlmToolPolicy,
} = await import('../src/services/notificationLlmToolPolicyService.js');

describe('notification LLM tool policy service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a safe context-only default when no policy row exists', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);

    const policy = await getNotificationLlmToolPolicy(1);

    expect(policy).toMatchObject({
      workspaceId: 1,
      mode: 'context_only',
      includePrivateNotes: false,
      redactionEnabled: true,
      maxTurns: 4,
      maxToolCalls: 6,
    });
    expect(policy.enabledTools).toContain('get_notification_context');
    expect(policy.toolSettings.context.includeSimilarTickets).toBe(true);
  });

  test('exposes only the curated server-side catalog', () => {
    const catalog = notificationLlmToolCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_notification_context',
      'find_similar_tickets',
      'detect_related_ticket_spike',
    ]));
    expect(catalog.every((tool) => tool.riskLevel.startsWith('read_only'))).toBe(true);
  });

  test('rejects unknown tools instead of persisting arbitrary tool access', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);

    await expect(updateNotificationLlmToolPolicy(1, {
      enabledTools: ['get_notification_context', 'delete_everything'],
    }, { email: 'admin@example.com' })).rejects.toThrow('Unknown notification LLM tool');
    expect(prismaMock.notificationLlmToolPolicy.upsert).not.toHaveBeenCalled();
  });

  test('normalizes budget and source settings before upsert', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue({
      id: 10,
      workspaceId: 1,
      mode: 'context_only',
      enabledTools: ['get_notification_context'],
      toolSettings: {},
      maxTurns: 4,
      maxToolCalls: 6,
      totalTimeoutMs: 20000,
      perToolTimeoutMs: 3000,
      includePrivateNotes: false,
      redactionEnabled: true,
      policyVersion: 2,
    });
    prismaMock.notificationLlmToolPolicy.upsert.mockImplementation(({ update }) => Promise.resolve({
      id: 10,
      workspaceId: 1,
      ...update,
      policyVersion: 3,
      createdAt: new Date('2026-05-31T12:00:00.000Z'),
      updatedAt: new Date('2026-05-31T12:01:00.000Z'),
    }));

    const policy = await updateNotificationLlmToolPolicy(1, {
      mode: 'tools_enabled',
      maxTurns: 99,
      maxToolCalls: -2,
      toolSettings: {
        context: {
          maxThreadEntries: 99,
          lookbackHours: [24, 1, 4, 4],
        },
      },
    }, { email: 'admin@example.com' });

    expect(prismaMock.notificationLlmToolPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        mode: 'tools_enabled',
        maxTurns: 8,
        maxToolCalls: 0,
        updatedBy: 'admin@example.com',
      }),
    }));
    expect(policy.toolSettings.context.maxThreadEntries).toBe(20);
    expect(policy.toolSettings.context.lookbackHours).toEqual([1, 4, 24]);
  });
});
