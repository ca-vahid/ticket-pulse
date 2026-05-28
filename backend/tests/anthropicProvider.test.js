import { jest } from '@jest/globals';

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic { constructor() {} },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    anthropic: {
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    },
  },
}));

const { AnthropicProvider } = await import('../src/services/aiProviders/anthropicProvider.js');

function createProvider() {
  const create = jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const provider = new AnthropicProvider();
  provider.client = { messages: { create } };
  return { provider, create };
}

describe('AnthropicProvider', () => {
  test('omits deprecated temperature for Opus 4.8 JSON calls', async () => {
    const { provider, create } = createProvider();

    await provider.sendJson({
      systemPrompt: 'Return JSON.',
      userMessage: '{}',
      model: 'claude-opus-4-8',
      temperature: 0,
    });

    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.anything() }),
      undefined,
    );
  });

  test('keeps temperature for Anthropic models that still support it', async () => {
    const { provider, create } = createProvider();

    await provider.sendJson({
      systemPrompt: 'Return JSON.',
      userMessage: '{}',
      model: 'claude-sonnet-4-6',
      temperature: 0,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 }),
      undefined,
    );
  });
});
