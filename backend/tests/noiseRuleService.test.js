import { jest } from '@jest/globals';

const prismaMock = {
  workspace: {
    findUnique: jest.fn(),
  },
  noiseRule: {
    count: jest.fn(),
    createMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');

describe('noiseRuleService default seeding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', slug: 'it' });
    prismaMock.noiseRule.count.mockResolvedValue(0);
    prismaMock.noiseRule.createMany.mockResolvedValue({ count: 1 });
  });

  test('seeds default rules into the IT workspace only', async () => {
    const seeded = await noiseRuleService.seedDefaults();

    expect(seeded).toBeGreaterThan(0);
    expect(prismaMock.noiseRule.createMany).toHaveBeenCalledTimes(1);
    const payload = prismaMock.noiseRule.createMany.mock.calls[0][0].data;
    expect(payload.length).toBe(seeded);
    expect(payload.every(rule => rule.workspaceId === 1)).toBe(true);
  });

  test('does not seed IT defaults into a non-IT workspace', async () => {
    const seeded = await noiseRuleService.seedDefaults(2);

    expect(seeded).toBe(0);
    expect(prismaMock.noiseRule.count).not.toHaveBeenCalled();
    expect(prismaMock.noiseRule.createMany).not.toHaveBeenCalled();
  });

  test('keeps legacy workspace id 1 fallback when it is still named IT', async () => {
    prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => {
      if (where.slug) return null;
      if (where.id === 1) return { id: 1, name: 'IT', slug: 'it' };
      return null;
    });

    const seeded = await noiseRuleService.seedDefaults(1);

    expect(seeded).toBeGreaterThan(0);
    expect(prismaMock.noiseRule.createMany).toHaveBeenCalledTimes(1);
  });
});
