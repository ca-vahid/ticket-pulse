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
      model: 'gpt-5.5',
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
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.5', fallbackFromProvider: 'anthropic' }),
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
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.5' }),
    ]);
  });
});
