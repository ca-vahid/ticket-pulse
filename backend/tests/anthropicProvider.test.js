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

  // Regression: prod runs 16670/16674/16677/16680 (Jul 2026) — after an
  // OpenAI fallback turn the replayed history 400'd on Anthropic with
  // "openai_item_id: Extra inputs are not permitted" / "thinking.signature:
  // Field required".
  test('toolResponse strips OpenAI fallback residue from replayed history', async () => {
    const stream = jest.fn().mockReturnValue({
      on: jest.fn().mockReturnThis(),
      finalMessage: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const provider = new AnthropicProvider();
    provider.client = { messages: { stream } };

    await provider.toolResponse({
      systemPrompt: 'Assign the ticket.',
      tools: [],
      messages: [
        { role: 'user', content: 'Ticket 9' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'OpenAI summary', openai_item_id: 'rs_1' },
            {
              type: 'tool_use',
              id: 'call_9',
              name: 'get_ticket_details',
              input: { ticketId: 9 },
              openai_item_id: 'fc_9',
              openai_call_id: 'call_9',
              openai_response_item: { type: 'function_call', id: 'fc_9' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_9', content: '{}' }],
        },
      ],
    });

    const sentMessages = stream.mock.calls[0][0].messages;
    const assistantBlocks = sentMessages[1].content;
    expect(assistantBlocks.some((b) => b.type === 'thinking')).toBe(false);
    const toolUse = assistantBlocks.find((b) => b.type === 'tool_use');
    expect(toolUse.openai_item_id).toBeUndefined();
    expect(toolUse.openai_call_id).toBeUndefined();
    expect(toolUse.openai_response_item).toBeUndefined();
    expect(toolUse).toMatchObject({ id: 'call_9', name: 'get_ticket_details' });
  });
});
