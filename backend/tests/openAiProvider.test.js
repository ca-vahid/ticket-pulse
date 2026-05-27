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
      model: 'gpt-5.5',
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
      model: 'gpt-5.5',
      onText,
      onThinking,
      onInputJson,
    });

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.5',
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
      model: 'gpt-5.5',
      onText,
    });

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('Final only');
  });
});
