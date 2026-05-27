import { jest } from '@jest/globals';

const prismaMock = {
  aiProviderSetting: {
    findMany: jest.fn(),
    createMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn(),
  },
  assignmentConfig: {
    findUnique: jest.fn(),
  },
  llmConfig: {
    findFirst: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const { default: providerSettingsService } = await import('../src/services/aiProviders/providerSettingsService.js');

describe('providerSettingsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates operation defaults scoped to the requested workspace', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ llmModel: 'claude-sonnet-4-6' });
    prismaMock.llmConfig.findFirst.mockResolvedValue({ model: 'gpt-5.1' });
    prismaMock.aiProviderSetting.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.aiProviderSetting.createMany.mockResolvedValue({ count: 8 });

    await providerSettingsService.listSettings(7);

    const created = prismaMock.aiProviderSetting.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(8);
    expect(created.every((row) => row.workspaceId === 7)).toBe(true);
    expect(created.find((row) => row.operation === 'assignment_pipeline')).toMatchObject({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-4-6',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.5',
    });
    expect(created.find((row) => row.operation === 'ticket_reclassification')).toMatchObject({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-haiku-4-5-20251001',
    });
    expect(created.find((row) => row.operation === 'autoresponse_generation')).toMatchObject({
      primaryProvider: 'openai',
      primaryModel: 'gpt-5.5',
      fallbackProvider: 'anthropic',
      fallbackModel: 'claude-sonnet-4-6',
    });
  });
});
