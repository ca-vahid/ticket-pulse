import { jest } from '@jest/globals';

const streamMock = jest.fn();
const createMock = jest.fn();
const openAiConstructorMock = jest.fn(() => ({
  responses: {
    create: createMock,
    stream: streamMock,
  },
}));

jest.unstable_mockModule('openai', () => ({
  default: openAiConstructorMock,
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    openai: {
      apiKey: 'test-openai-key',
      model: 'gpt-5.6-sol',
    },
  },
}));

const { OpenAiProvider } = await import('../src/services/aiProviders/openAiProvider.js');

function createResponseStream(events, response) {
  const listeners = new Map();
  return {
    on(name, callback) {
      const existing = listeners.get(name) || [];
      existing.push(callback);
      listeners.set(name, existing);
      return this;
    },
    async finalResponse() {
      for (const event of events) {
        for (const callback of listeners.get('event') || []) callback(event);
        for (const callback of listeners.get(event.type) || []) callback(event);
      }
      return response;
    },
  };
}

describe('OpenAiProvider streaming tool responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('forwards Responses stream text and tool-argument deltas to the pipeline callbacks', async () => {
    const response = {
      id: 'resp_1',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello world' }],
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          status: 'completed',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Checking context' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_ticket_details',
          arguments: '{"ticketId":123}',
          status: 'completed',
        },
      ],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    };
    streamMock.mockReturnValue(createResponseStream([
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'world' },
      { type: 'response.reasoning_text.delta', delta: 'Checking context' },
      { type: 'response.function_call_arguments.delta', delta: '{"ticketId":' },
      { type: 'response.function_call_arguments.delta', delta: '123}' },
    ], response));

    const provider = new OpenAiProvider();
    const onText = jest.fn();
    const onThinking = jest.fn();
    const onInputJson = jest.fn();

    const result = await provider.toolResponse({
      systemPrompt: 'Assign the ticket.',
      messages: [{ role: 'user', content: 'Ticket 123' }],
      tools: [{ name: 'get_ticket_details', input_schema: { type: 'object', properties: {} } }],
      model: 'gpt-5.6-sol',
      onText,
      onThinking,
      onInputJson,
    });

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      include: ['reasoning.encrypted_content'],
      tools: [expect.objectContaining({ name: 'get_ticket_details' })],
    }), undefined);
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenNthCalledWith(1, 'Hello ');
    expect(onText).toHaveBeenNthCalledWith(2, 'world');
    expect(onThinking).toHaveBeenCalledWith('Checking context');
    expect(onInputJson).toHaveBeenNthCalledWith(1, '{"ticketId":');
    expect(onInputJson).toHaveBeenNthCalledWith(2, '123}');
    expect(result).toMatchObject({
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      message: {
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Hello world' }),
          expect.objectContaining({ type: 'tool_use', name: 'get_ticket_details' }),
        ]),
      },
    });
  });

  test('emits final text if the stream did not provide text deltas', async () => {
    streamMock.mockReturnValue(createResponseStream([], {
      id: 'resp_2',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Final only' }],
        },
      ],
      usage: {},
    }));

    const provider = new OpenAiProvider();
    const onText = jest.fn();

    await provider.toolResponse({
      systemPrompt: 'Assign the ticket.',
      messages: [{ role: 'user', content: 'Ticket 123' }],
      tools: [],
      model: 'gpt-5.6-sol',
      onText,
    });

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('Final only');
  });

  test('does not replay parsed function-call fields in Responses continuation input', async () => {
    streamMock
      .mockReturnValueOnce(createResponseStream([], {
        id: 'resp_tool',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'find_similar_tickets',
            arguments: '{"ticketId":27883}',
            parsed_arguments: { ticketId: 27883 },
            status: 'completed',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }))
      .mockReturnValueOnce(createResponseStream([], {
        id: 'resp_final',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Ready' }],
          },
        ],
        usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
      }));

    const provider = new OpenAiProvider();
    const first = await provider.toolResponse({
      systemPrompt: 'Write notification copy.',
      messages: [{ role: 'user', content: 'Ticket 27883' }],
      tools: [{ name: 'find_similar_tickets', input_schema: { type: 'object', properties: {} } }],
      model: 'gpt-5.6-sol',
    });

    await provider.toolResponse({
      systemPrompt: 'Write notification copy.',
      messages: [
        { role: 'user', content: 'Ticket 27883' },
        { role: 'assistant', content: first.message.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '{"recentSimilarTickets":[]}',
            },
          ],
        },
      ],
      tools: [{ name: 'find_similar_tickets', input_schema: { type: 'object', properties: {} } }],
      model: 'gpt-5.6-sol',
    });

    const continuationInput = streamMock.mock.calls[1][0].input;
    const functionCallInput = continuationInput.find((item) => item.type === 'function_call');
    expect(functionCallInput).toMatchObject({
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'find_similar_tickets',
      arguments: '{"ticketId":27883}',
    });
    expect(functionCallInput.parsed_arguments).toBeUndefined();
    // Response-side `status` must never be replayed as input — the API 400s
    // with "Unknown parameter: 'input[N].status'".
    expect(continuationInput.every((item) => item.status === undefined)).toBe(true);
  });
});

describe('OpenAiProvider JSON responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('adds a JSON instruction to JSON-mode input when the payload does not mention JSON', async () => {
    createMock.mockResolvedValue({
      output_text: '{"ok":true}',
      output: [],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });

    const provider = new OpenAiProvider();
    const result = await provider.sendJson({
      systemPrompt: 'Classify the ticket.',
      userMessage: '{"ticketId":123}',
      model: 'gpt-5.6-sol',
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.objectContaining({
        format: { type: 'json_object' },
      }),
      input: [{
        role: 'user',
        content: expect.stringMatching(/^Return JSON only\.\n\n\{"ticketId":123\}$/),
      }],
    }), undefined);
    expect(result).toMatchObject({
      parsed: { ok: true },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
  });
});
