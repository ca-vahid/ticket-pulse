import {
  buildAnthropicBlocksFromOpenAiResponse,
  convertAnthropicMessagesToOpenAiInput,
  convertAnthropicToolsToOpenAiResponses,
} from '../src/services/aiProviders/openAiConverters.js';

describe('OpenAI Responses converters', () => {
  test('converts Anthropic tool schemas and strips provider metadata', () => {
    const converted = convertAnthropicToolsToOpenAiResponses([
      {
        name: 'lookup_ticket',
        description: 'Lookup a ticket',
        input_schema: {
          type: 'object',
          cache_control: { type: 'ephemeral' },
          eager_input_streaming: true,
          properties: { ticketId: { type: 'number' } },
        },
      },
      { type: 'web_search_20250305', name: 'web_search' },
    ]);

    expect(converted.tools).toHaveLength(1);
    expect(converted.tools[0]).toMatchObject({
      type: 'function',
      name: 'lookup_ticket',
      parameters: {
        type: 'object',
        properties: { ticketId: { type: 'number' } },
      },
    });
    expect(converted.tools[0].parameters.cache_control).toBeUndefined();
    expect(converted.tools[0].parameters.eager_input_streaming).toBeUndefined();
    expect(converted.unsupported).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
    ]);
  });

  test('converts mixed Anthropic messages to Responses input items', () => {
    const input = convertAnthropicMessagesToOpenAiInput([
      { role: 'user', content: 'Classify this ticket.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup_ticket', input: { ticketId: 123 } },
          { type: 'thinking', thinking: 'Need assignment context.' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ status: 'ok' }] },
        ],
      },
    ]);

    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'toolu_1', name: 'lookup_ticket' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'toolu_1' }),
      expect.objectContaining({ type: 'reasoning', status: 'completed' }),
    ]));
  });

  test('builds Anthropic-style blocks while preserving OpenAI IDs', () => {
    const blocks = buildAnthropicBlocksFromOpenAiResponse([
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Use Dana.' }],
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'submit_recommendation',
        arguments: '{"techId":42}',
      },
      {
        type: 'reasoning',
        id: 'rs_123',
        summary: [{ type: 'summary_text', text: 'Dana has capacity.' }],
      },
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'Use Dana.' },
      expect.objectContaining({
        type: 'tool_use',
        id: 'call_123',
        name: 'submit_recommendation',
        input: { techId: 42 },
        openai_item_id: 'fc_123',
        openai_call_id: 'call_123',
      }),
      expect.objectContaining({
        type: 'thinking',
        thinking: 'Dana has capacity.',
        openai_item_id: 'rs_123',
      }),
    ]);
  });

  test('preserves opaque reasoning items required by GPT-5.5 function-call continuations', () => {
    const blocks = buildAnthropicBlocksFromOpenAiResponse([
      {
        type: 'reasoning',
        id: 'rs_required',
        summary: [],
        status: 'completed',
      },
      {
        type: 'function_call',
        id: 'fc_required',
        call_id: 'call_required',
        name: 'get_ticket_details',
        arguments: '{"ticketId":26901}',
        status: 'completed',
      },
    ]);

    const input = convertAnthropicMessagesToOpenAiInput([
      { role: 'assistant', content: blocks },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_required',
            content: '{"subject":"VPN issue"}',
          },
        ],
      },
    ]);

    expect(input).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        id: 'rs_required',
        summary: [],
      }),
      expect.objectContaining({
        type: 'function_call',
        id: 'fc_required',
        call_id: 'call_required',
        name: 'get_ticket_details',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_required',
      }),
    ]);
  });
});
