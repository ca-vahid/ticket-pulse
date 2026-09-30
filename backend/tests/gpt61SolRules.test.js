import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * GPT-6.1 Sol (29 Sep 2026): selectable, priced like GPT-6 Sol with cheaper
 * cached reads, and it rejects reasoning.effort 'none' (verified live 30 Sep:
 * 400 unsupported_value, supports low … max) — our JSON calls ask for 'none',
 * so GPT-6.1 runs them at 'low'. Other OpenAI models keep what they asked for.
 */
const create = jest.fn();
const streamFn = jest.fn();
jest.unstable_mockModule('openai', () => ({
  default: jest.fn().mockImplementation(() => ({ responses: { create, stream: streamFn } })),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  default: { openai: { apiKey: 'test-key', model: 'gpt-6-sol' }, anthropic: { apiKey: 'x' } },
}));

const { openAiReasoningFor, getModelMetadata, normalizeAiModel, GPT_6_1_SOL_MODEL } = await import('../src/utils/aiProviders.js');
const { OpenAiProvider } = await import('../src/services/aiProviders/openAiProvider.js');
const { costUsdFor } = await import('../src/services/tokenUsageService.js');

beforeEach(() => {
  create.mockReset().mockResolvedValue({ output_text: '{"ok":true}', output: [], usage: { input_tokens: 10, output_tokens: 5 } });
});

describe('GPT-6.1 Sol', () => {
  test('registered and selectable for every operation, recognised as OpenAI', () => {
    expect(GPT_6_1_SOL_MODEL).toBe('gpt-6.1-sol');
    const meta = getModelMetadata({ provider: 'openai' }).find((m) => m.model === 'gpt-6.1-sol');
    expect(meta).toMatchObject({ provider: 'openai', label: 'GPT-6.1 Sol', supportsTools: true, supportsVision: true });
    expect(meta.operations).toEqual(expect.arrayContaining(['auto_help', 'notification_workflow_generation']));
    expect(normalizeAiModel('gpt-6.1-sol', 'openai')).toBe('gpt-6.1-sol');
  });

  test('priced at $2/$10 with cached reads at $0.10 (not the unknown-model default)', () => {
    expect(costUsdFor({ model: 'gpt-6.1-sol', inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(12, 5);
    expect(costUsdFor({ model: 'gpt-6-sol', inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(12, 5);
  });

  test("reasoning 'none' becomes 'low' for GPT-6.1 only; other efforts and models untouched", () => {
    expect(openAiReasoningFor('gpt-6.1-sol', { effort: 'none' })).toEqual({ effort: 'low' });
    expect(openAiReasoningFor('gpt-6.1-sol', { effort: 'high' })).toEqual({ effort: 'high' });
    expect(openAiReasoningFor('gpt-6-sol', { effort: 'none' })).toEqual({ effort: 'none' });
    expect(openAiReasoningFor('gpt-6-luna', { effort: 'none' })).toEqual({ effort: 'none' });
  });

  test('sendJson: GPT-6.1 Sol gets low reasoning and no temperature; GPT-6 Sol keeps none and its temperature', async () => {
    const provider = new OpenAiProvider();
    await provider.sendJson({ systemPrompt: 's', userMessage: 'u', model: 'gpt-6.1-sol', temperature: 0.3 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    await provider.sendJson({ systemPrompt: 's', userMessage: 'u', model: 'gpt-6-sol', temperature: 0.3 });
    expect(create.mock.calls[1][0]).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'none' }, temperature: 0.3 });
  });
});
