import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    aiProviderHealthEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    debug: jest.fn(),
  },
}));

const { ProviderHealthService } = await import('../src/services/aiProviders/providerHealthService.js');

describe('ProviderHealthService classification', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns unknown when no recent events exist', () => {
    const service = new ProviderHealthService();
    expect(service._classifyEvents('anthropic', [])).toMatchObject({
      status: 'unknown',
      routingEligible: true,
      successCount: 0,
      failureCount: 0,
    });
  });

  test('marks three consecutive failures as down', () => {
    const service = new ProviderHealthService();
    const events = [
      { success: false, errorClass: 'provider_down', sanitizedMessage: 'down', createdAt: new Date('2026-05-27T10:00:03Z') },
      { success: false, errorClass: 'rate_limited', sanitizedMessage: 'rate', createdAt: new Date('2026-05-27T10:00:02Z') },
      { success: false, errorClass: 'api_timeout', sanitizedMessage: 'timeout', createdAt: new Date('2026-05-27T10:00:01Z') },
    ];

    expect(service._classifyEvents('openai', events)).toMatchObject({
      status: 'down',
      routingEligible: false,
      failureCount: 3,
      lastErrorClass: 'provider_down',
    });
  });

  test('uses dwell time after provider recovery', () => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-27T10:01:00Z').getTime());
    const service = new ProviderHealthService();
    const events = [
      { success: true, createdAt: new Date('2026-05-27T10:00:30Z') },
      { success: false, errorClass: 'provider_down', sanitizedMessage: 'down', createdAt: new Date('2026-05-27T10:00:00Z') },
    ];

    expect(service._classifyEvents('anthropic', events)).toMatchObject({
      status: 'degraded',
      routingEligible: false,
      dwellUntil: '2026-05-27T10:02:30.000Z',
    });
  });
});
