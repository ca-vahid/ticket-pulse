function parseToolArguments(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return { rawArguments: String(argumentsValue) };
  }
}

function toText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? '');
}

function sanitizeToolSchema(schema = {}) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.cache_control;
  delete copy.eager_input_streaming;
  return copy;
}

function cloneResponseItem(item) {
  if (!item || typeof item !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(item));
  if (copy.type === 'reasoning' && !Array.isArray(copy.summary)) {
    copy.summary = [];
  }
  if (copy.type === 'function_call' && !copy.status) {
    copy.status = 'completed';
  }
  return copy;
}

export function convertAnthropicToolsToOpenAiResponses(tools = []) {
  const converted = [];
  const unsupported = [];

  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type && tool.type !== 'function' && !tool.name) {
      unsupported.push({ type: tool.type, name: tool.name || tool.type });
      continue;
    }
    if (tool.type === 'web_search_20250305' || tool.name === 'web_search') {
      unsupported.push({ type: tool.type || 'server_tool', name: tool.name || 'web_search' });
      continue;
    }
    converted.push({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeToolSchema(tool.input_schema || tool.parameters),
      strict: false,
    });
  }

  return { tools: converted, unsupported };
}

function convertTextContentToOpenAi(content, role) {
  const text = Array.isArray(content)
    ? content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
    : toText(content);
  if (!text) return null;

  if (role === 'assistant') {
    return {
      type: 'message',
      id: `msg_local_${Math.random().toString(36).slice(2)}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
  }

  return {
    type: 'message',
    role: role === 'system' ? 'developer' : 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function convertAnthropicMessagesToOpenAiInput(messages = []) {
  const input = [];

  for (const message of messages || []) {
    if (!message) continue;
    const role = message.role || 'user';
    const content = message.content;

    if (typeof content === 'string') {
      const item = convertTextContentToOpenAi(content, role);
      if (item) input.push(item);
      continue;
    }

    if (!Array.isArray(content)) {
      const item = convertTextContentToOpenAi(toText(content), role);
      if (item) input.push(item);
      continue;
    }

    const textItem = convertTextContentToOpenAi(content, role);
    if (textItem) input.push(textItem);

    for (const block of content) {
      if (!block || block.type === 'text') continue;
      if (block.type === 'tool_use') {
        input.push(block.openai_response_item || {
          type: 'function_call',
          id: block.openai_item_id || undefined,
          call_id: block.openai_call_id || block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
          status: 'completed',
        });
      } else if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.openai_call_id || block.tool_use_id,
          output: toText(block.content),
        });
      } else if (block.type === 'thinking') {
        input.push(block.openai_response_item || {
          type: 'reasoning',
          id: block.openai_item_id || `rs_local_${Math.random().toString(36).slice(2)}`,
          summary: [{ type: 'summary_text', text: block.thinking || block.text || '' }],
          status: 'completed',
        });
      }
    }
  }

  return input;
}

export function buildAnthropicBlocksFromOpenAiResponse(responseOutput = []) {
  const blocks = [];

  for (const item of responseOutput || []) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal' && part.refusal) {
          blocks.push({ type: 'text', text: part.refusal });
        }
      }
    } else if (item.type === 'function_call') {
      blocks.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
        openai_item_id: item.id || null,
        openai_call_id: item.call_id || null,
        openai_response_item: cloneResponseItem(item),
      });
    } else if (item.type === 'reasoning') {
      const thinking = [
        ...(item.summary || []).map((part) => part.text),
        ...(item.content || []).map((part) => part.text),
      ].filter(Boolean).join('\n');
      blocks.push({
        type: 'thinking',
        thinking,
        openai_item_id: item.id || null,
        openai_response_item: cloneResponseItem(item),
      });
    }
  }

  return blocks;
}

export function buildAnthropicMessageFromOpenAiResponse(response) {
  const content = buildAnthropicBlocksFromOpenAiResponse(response?.output || []);
  return {
    id: response?.id || null,
    role: 'assistant',
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: response?.usage || {},
    provider_response_id: response?.id || null,
  };
}
