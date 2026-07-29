import {
  sanitizeMessagesForAnthropicReplay,
  buildAnthropicBlocksFromOpenAiResponse,
  convertAnthropicMessagesToOpenAiInput,
  convertAnthropicToolsToOpenAiResponses,
  sanitizeOpenAiResponseInputItem,
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
    ]));
    // Anthropic-born thinking must NOT become a fabricated reasoning item —
    // the Responses API rejects locally-invented reasoning ids.
    expect(input.some((item) => item.type === 'reasoning')).toBe(false);
    // `status` is response-side metadata; sending it back 400s ("Unknown
    // parameter: 'input[N].status'").
    expect(input.every((item) => item.status === undefined)).toBe(true);
    // Locally-built items must not fabricate ids either.
    const assistantMsg = input.find((i) => i.type === 'message' && i.role === 'assistant');
    expect(assistantMsg.id).toBeUndefined();
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
        parsed_arguments: { ticketId: 26901 },
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
    expect(input.find((item) => item.type === 'function_call').parsed_arguments).toBeUndefined();
    expect(input.every((item) => item.status === undefined)).toBe(true);
  });

  test('strips parsed function-call fields while preserving continuation fields', () => {
    const blocks = buildAnthropicBlocksFromOpenAiResponse([
      {
        type: 'reasoning',
        id: 'rs_required',
        summary: [],
        status: 'completed',
        encrypted_content: 'encrypted-reasoning',
        content: [{ type: 'reasoning_text', text: 'Internal chain' }],
      },
      {
        type: 'function_call',
        id: 'fc_required',
        call_id: 'call_required',
        name: 'detect_related_ticket_spike',
        arguments: '{"ticketId":27883}',
        parsed_arguments: { ticketId: 27883 },
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
            content: '{"outageSignals":{"status":"watch"}}',
          },
        ],
      },
    ]);

    expect(input).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        id: 'rs_required',
        summary: [],
        encrypted_content: 'encrypted-reasoning',
      }),
      expect.objectContaining({
        type: 'function_call',
        id: 'fc_required',
        call_id: 'call_required',
        name: 'detect_related_ticket_spike',
        arguments: '{"ticketId":27883}',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_required',
      }),
    ]);
    expect(input[0].content).toBeUndefined();
    expect(input[1].parsed_arguments).toBeUndefined();
    expect(input.every((item) => item.status === undefined)).toBe(true);
  });

  test('strips SDK-only fields from function-call replay items', () => {
    const replayItem = sanitizeOpenAiResponseInputItem({
      type: 'function_call',
      id: 'fc_123',
      call_id: 'call_123',
      name: 'find_similar_tickets',
      arguments: '{"ticketId":225001}',
      parsed_arguments: { ticketId: 225001 },
      parsedArguments: { ticketId: 225001 },
      output: 'provider helper output',
      status: 'completed',
    });

    expect(replayItem).toEqual({
      type: 'function_call',
      id: 'fc_123',
      call_id: 'call_123',
      name: 'find_similar_tickets',
      arguments: '{"ticketId":225001}',
    });

    const input = convertAnthropicMessagesToOpenAiInput([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'find_similar_tickets',
            input: { ticketId: 225001 },
            openai_response_item: {
              type: 'function_call',
              id: 'fc_123',
              call_id: 'call_123',
              name: 'find_similar_tickets',
              arguments: '{"ticketId":225001}',
              parsed_arguments: { ticketId: 225001 },
            },
          },
        ],
      },
    ]);

    expect(input[0]).not.toHaveProperty('parsed_arguments');
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_123',
      name: 'find_similar_tickets',
    });
  });

  // Prod failure class from Jul 2026 (runs 16670/16674/16677/16680): after an
  // OpenAI fallback turn, the accumulated history 400s on Anthropic with
  // "tool_use.openai_item_id: Extra inputs are not permitted" and
  // "thinking.signature: Field required".
  describe('sanitizeMessagesForAnthropicReplay', () => {
    test('strips OpenAI round-trip annotations from replayed blocks', () => {
      const [message] = sanitizeMessagesForAnthropicReplay([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking workload.' },
            {
              type: 'tool_use',
              id: 'call_9',
              name: 'find_matching_agents',
              input: { ticketId: 9 },
              openai_item_id: 'fc_9',
              openai_call_id: 'call_9',
              openai_response_item: { type: 'function_call', id: 'fc_9' },
            },
          ],
        },
      ]);

      expect(message.content[1]).toEqual({
        type: 'tool_use',
        id: 'call_9',
        name: 'find_matching_agents',
        input: { ticketId: 9 },
      });
    });

    test('drops foreign thinking blocks but keeps signed Anthropic ones', () => {
      const [message] = sanitizeMessagesForAnthropicReplay([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'OpenAI reasoning summary', openai_item_id: 'rs_1' },
            { type: 'thinking', thinking: 'Native reasoning', signature: 'sig_abc' },
            { type: 'redacted_thinking', data: 'opaque-blob' },
            { type: 'text', text: 'Assigning to Dana.' },
          ],
        },
      ]);

      expect(message.content).toEqual([
        { type: 'thinking', thinking: 'Native reasoning', signature: 'sig_abc' },
        { type: 'redacted_thinking', data: 'opaque-blob' },
        { type: 'text', text: 'Assigning to Dana.' },
      ]);
    });

    test('stubs an assistant turn whose only content was foreign reasoning', () => {
      const [message] = sanitizeMessagesForAnthropicReplay([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'summary only', openai_item_id: 'rs_2' }],
        },
      ]);

      expect(message.content).toEqual([
        { type: 'text', text: '(reasoning from fallback provider omitted)' },
      ]);
    });

    test('passes plain-string messages through untouched', () => {
      const messages = [{ role: 'user', content: 'Classify this ticket.' }];
      expect(sanitizeMessagesForAnthropicReplay(messages)).toEqual(messages);
    });
  });
});
