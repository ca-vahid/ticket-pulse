import { jest } from '@jest/globals';

const getSettingMock = jest.fn();
const getStatusMock = jest.fn();

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    anthropic: { apiKey: 'anthropic-key' },
    openai: { apiKey: 'openai-key' },
  },
}));

jest.unstable_mockModule('../src/services/aiProviders/providerSettingsService.js', () => ({
  default: { getSetting: getSettingMock },
}));

jest.unstable_mockModule('../src/services/aiProviders/providerHealthService.js', () => ({
  default: { getStatus: getStatusMock },
}));

const { ProviderModelResolver } = await import('../src/services/aiProviders/providerModelResolver.js');

describe('ProviderModelResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSettingMock.mockResolvedValue({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-4-6',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.1',
      autoFallbackEnabled: true,
    });
  });

  test('routes directly to fallback when primary is down', async () => {
    getStatusMock
      .mockResolvedValueOnce({ status: 'down', routingEligible: false })
      .mockResolvedValueOnce({ status: 'healthy', routingEligible: true });

    const resolver = new ProviderModelResolver();
    const result = await resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'assignment_pipeline',
    });

    expect(result.attempts).toEqual([{
      provider: 'openai',
      model: 'gpt-5.6-sol',
      fallbackFromProvider: 'anthropic',
      fallbackReason: 'primary_down',
      healthStatus: 'healthy',
    }]);
  });

  test('attempts fallback after primary when primary is routeable', async () => {
    getStatusMock
      .mockResolvedValueOnce({ status: 'healthy', routingEligible: true })
      .mockResolvedValueOnce({ status: 'healthy', routingEligible: true });

    const resolver = new ProviderModelResolver();
    const result = await resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'assignment_pipeline',
    });

    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-6', fallbackFromProvider: null }),
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-sol', fallbackFromProvider: 'anthropic' }),
    ]);
  });

  test('does not add a fallback attempt when automatic fallback is disabled', async () => {
    getSettingMock.mockResolvedValue({
      primaryProvider: 'openai',
      primaryModel: 'gpt-5.1',
      fallbackProvider: 'anthropic',
      fallbackModel: 'claude-sonnet-4-6',
      autoFallbackEnabled: false,
    });
    getStatusMock
      .mockResolvedValueOnce({ status: 'healthy', routingEligible: true })
      .mockResolvedValueOnce({ status: 'healthy', routingEligible: true });

    const resolver = new ProviderModelResolver();
    const result = await resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'assignment_pipeline',
    });

    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-sol' }),
    ]);
  });
});

describe('ProviderModelResolver vision gate (Phase AF)', () => {
  test('refuses a non-vision primary when the call carries images', async () => {
    getSettingMock.mockResolvedValue({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-haiku-4-5-20251001',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.6-sol',
      autoFallbackEnabled: true,
    });
    const resolver = new ProviderModelResolver();
    // ticket_reclassification is on Haiku's allow-list, so only the vision
    // gate can refuse here.
    await expect(resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'ticket_reclassification',
      requiresVision: true,
    })).rejects.toThrow(/does not support image input/);
    // Same setting without images resolves normally.
    getStatusMock.mockResolvedValue({ status: 'healthy', routingEligible: true });
    await expect(resolver.resolveAttempts({ workspaceId: 1, operation: 'ticket_reclassification' }))
      .resolves.toMatchObject({ primary: { model: 'claude-haiku-4-5-20251001' } });
  });

  test('drops a non-vision fallback instead of sending images into a 400', async () => {
    getSettingMock.mockResolvedValue({
      primaryProvider: 'openai',
      primaryModel: 'gpt-5.6-sol',
      fallbackProvider: 'anthropic',
      fallbackModel: 'claude-haiku-4-5-20251001',
      autoFallbackEnabled: true,
    });
    getStatusMock.mockResolvedValue({ status: 'healthy', routingEligible: true });
    const resolver = new ProviderModelResolver();
    const result = await resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'ticket_reclassification',
      requiresVision: true,
    });
    expect(result.visionFallbackDropped).toBe(true);
    expect(result.fallback.model).toBeNull();
    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-sol', fallbackFromProvider: null }),
    ]);
  });

  test('vision-capable primary + fallback keep the 2-attempt chain for ticket_intake_extract', async () => {
    getSettingMock.mockResolvedValue({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-5',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.6-luna',
      autoFallbackEnabled: true,
    });
    getStatusMock.mockResolvedValue({ status: 'healthy', routingEligible: true });
    const resolver = new ProviderModelResolver();
    const result = await resolver.resolveAttempts({
      workspaceId: 1,
      operation: 'ticket_intake_extract',
      requiresVision: true,
    });
    expect(result.visionFallbackDropped).toBe(false);
    expect(result.attempts.map((a) => `${a.provider}/${a.model}`)).toEqual(['anthropic/claude-sonnet-5', 'openai/gpt-5.6-luna']);
  });

  test('Haiku can never be resolved for ticket_intake_extract (op gate fires before the vision gate)', async () => {
    getSettingMock.mockResolvedValue({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-haiku-4-5-20251001',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.6-sol',
      autoFallbackEnabled: true,
    });
    const resolver = new ProviderModelResolver();
    await expect(resolver.resolveAttempts({ workspaceId: 1, operation: 'ticket_intake_extract' }))
      .rejects.toThrow(/does not support ticket_intake_extract/);
  });
});
