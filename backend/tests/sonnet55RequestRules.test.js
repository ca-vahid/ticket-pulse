import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Sonnet 5.5 (28 Sep 2026): the new default. It rejects thinking
 * {type:'disabled'} (use 'between_tools') and forced tool_choice; Sonnet 5
 * keeps the old shape.
 */
const create = jest.fn();
const stream = jest.fn();
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({ messages: { create, stream } })),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  default: { anthropic: { apiKey: 'test-key', defaultModel: 'claude-sonnet-5-5' } },
}));

const { anthropicRequestRules, DEFAULT_ANTHROPIC_MODEL, shouldOmitAnthropicTemperature, getModelMetadata } = await import('../src/utils/aiProviders.js');
const { AnthropicProvider } = await import('../src/services/aiProviders/anthropicProvider.js');
const { costUsdFor } = await import('../src/services/tokenUsageService.js');

const fakeStream = () => {
  const s = { on: jest.fn(() => s), finalMessage: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
  return s;
};

beforeEach(() => {
  create.mockReset().mockResolvedValue({ content: [{ type: 'tool_use', name: 'emit_notification_json', input: { a: 1 } }], usage: { input_tokens: 1, output_tokens: 1 } });
  stream.mockReset().mockImplementation(() => fakeStream());
});

describe('the default and the registry', () => {
  test('Sonnet 5.5 is the default; Sonnet 5 stays selectable', () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
    const models = getModelMetadata({ provider: 'anthropic' }).map((m) => m.model);
    expect(models).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-sonnet-5']));
  });

  test('both reject custom sampling params', () => {
    expect(shouldOmitAnthropicTemperature('claude-sonnet-5-5')).toBe(true);
    expect(shouldOmitAnthropicTemperature('claude-sonnet-5')).toBe(true);
  });

  test('request rules per model', () => {
    expect(anthropicRequestRules('claude-sonnet-5-5')).toEqual({ thinkingOff: { type: 'between_tools' }, forcedToolChoice: false });
    expect(anthropicRequestRules('claude-sonnet-5')).toEqual({ thinkingOff: { type: 'disabled' }, forcedToolChoice: true });
    expect(anthropicRequestRules('claude-opus-5-5').forcedToolChoice).toBe(false);
    expect(anthropicRequestRules('claude-haiku-4-5-20251001').thinkingOff).toEqual({ type: 'disabled' });
  });

  test('Sonnet 5 and 5.5 are priced at $2 / $10', () => {
    expect(costUsdFor({ provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(12, 6);
    expect(costUsdFor({ provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(12, 6);
  });
});

describe('AnthropicProvider request shapes', () => {
  test('sendJson on Sonnet 5.5: between_tools, no forced tool_choice, no temperature, tool asked for in the prompt', async () => {
    const provider = new AnthropicProvider();
    const out = await provider.sendJson({ systemPrompt: 'Write an email.', userMessage: 'x', model: 'claude-sonnet-5-5', extra: { jsonSchema: { type: 'object' } } });
    const req = create.mock.calls[0][0];
    expect(req.thinking).toEqual({ type: 'between_tools' });
    expect(req.tool_choice).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    expect(JSON.stringify(req.system)).toMatch(/Call the emit_notification_json tool right away/);
    expect(out.parsed).toEqual({ a: 1 });
  });

  test('sendJson on Sonnet 5 keeps the forced tool and thinking disabled', async () => {
    const provider = new AnthropicProvider();
    await provider.sendJson({ systemPrompt: 's', userMessage: 'x', model: 'claude-sonnet-5', extra: { jsonSchema: { type: 'object' } } });
    const req = create.mock.calls[0][0];
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'emit_notification_json' });
  });

  test('toolResponse on Sonnet 5.5 sends between_tools; an explicit extra.thinking still wins', async () => {
    const provider = new AnthropicProvider();
    await provider.toolResponse({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], model: 'claude-sonnet-5-5' });
    expect(stream.mock.calls[0][0].thinking).toEqual({ type: 'between_tools' });
    await provider.toolResponse({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], model: 'claude-sonnet-5-5', extra: { thinking: { type: 'adaptive' } } });
    expect(stream.mock.calls[1][0].thinking).toEqual({ type: 'adaptive' });
  });
});
