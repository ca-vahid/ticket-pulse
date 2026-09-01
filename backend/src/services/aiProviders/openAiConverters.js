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
  return sanitizeOpenAiResponseInputItem(item);
}

// NOTE: replay items deliberately omit `status`. The Responses API rejects it
// on input items ("Unknown parameter: 'input[N].status'") — it's response-side
// metadata, not request-side. Seen in prod failed runs 16673/16679 (Jul 2026).
export function sanitizeOpenAiResponseInputItem(item) {
  if (!item || typeof item !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(item));
  if (copy.type === 'function_call') {
    return {
      type: 'function_call',
      ...(copy.id ? { id: copy.id } : {}),
      call_id: copy.call_id || copy.id,
      name: copy.name,
      arguments: typeof copy.arguments === 'string' ? copy.arguments : JSON.stringify(copy.arguments || {}),
    };
  }
  if (copy.type === 'reasoning') {
    return {
      type: 'reasoning',
      ...(copy.id ? { id: copy.id } : {}),
      summary: Array.isArray(copy.summary) ? copy.summary : [],
      ...(copy.encrypted_content ? { encrypted_content: copy.encrypted_content } : {}),
    };
  }
  if (copy.type === 'message') {
    return {
      type: 'message',
      ...(copy.id ? { id: copy.id } : {}),
      role: copy.role || 'assistant',
      content: Array.isArray(copy.content) ? copy.content : [],
    };
  }
  return null;
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

/**
 * One Anthropic-style user content block → one Responses API input part.
 * Text → `input_text`; image (base64 or url source) → `input_image` data/URL.
 * Anything else THROWS — a silently dropped or stringified block would reach
 * the model as garbage (the pre-Phase-AF "[object Object]" bug).
 */
export function convertUserContentBlockToOpenAiPart(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('Unsupported OpenAI input block: expected an object');
  }
  if (block.type === 'text') {
    return { type: 'input_text', text: String(block.text ?? '') };
  }
  if (block.type === 'image') {
    const source = block.source || {};
    if (source.type === 'base64' && source.media_type && source.data) {
      return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` };
    }
    if (source.type === 'url' && source.url) {
      return { type: 'input_image', image_url: source.url };
    }
    throw new Error('Unsupported OpenAI image block: expected a base64 (media_type + data) or url source');
  }
  throw new Error(`Unsupported OpenAI input block type: ${block.type || 'unknown'}`);
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
    // No fabricated id and no status: locally-invented item ids risk
    // "item not found" rejections, and `status` is not a valid input field.
    return {
      type: 'message',
      role: 'assistant',
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

    if (role !== 'assistant' && content.some((block) => block?.type === 'image')) {
      // Image-bearing user turn: keep text and image parts together, in
      // order, inside ONE message item (images used to be dropped here).
      const parts = content
        .filter((block) => block && (block.type === 'text' || block.type === 'image'))
        .map((block) => convertUserContentBlockToOpenAiPart(block))
        .filter((part) => part.type !== 'input_text' || part.text);
      if (parts.length) {
        input.push({ type: 'message', role: role === 'system' ? 'developer' : 'user', content: parts });
      }
    } else {
      const textItem = convertTextContentToOpenAi(content, role);
      if (textItem) input.push(textItem);
    }

    for (const block of content) {
      if (!block || block.type === 'text' || block.type === 'image') continue;
      if (block.type === 'tool_use') {
        const replayItem = sanitizeOpenAiResponseInputItem(block.openai_response_item);
        // Foreign (Anthropic-born) tool calls get a minimal function_call:
        // call_id can be any string, but a fabricated `id` cannot.
        input.push(replayItem || {
          type: 'function_call',
          call_id: block.openai_call_id || block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      } else if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.openai_call_id || block.tool_use_id,
          output: toText(block.content),
        });
      } else if (block.type === 'thinking') {
        // Only replay reasoning that OpenAI itself produced (round-trips via
        // openai_response_item, with a real id + encrypted_content). Foreign
        // (Anthropic-born) thinking is dropped: fabricated rs_local_* ids are
        // rejected by the Responses API, and reasoning is never required to
        // continue a tool loop.
        const replayItem = sanitizeOpenAiResponseInputItem(block.openai_response_item);
        if (replayItem) input.push(replayItem);
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

/**
 * Clean cross-provider residue out of a message history before replaying it
 * to the Anthropic API. After an OpenAI fallback turn, assistant blocks carry
 * `openai_item_id` / `openai_call_id` / `openai_response_item` round-trip
 * annotations ("Extra inputs are not permitted") and `thinking` blocks with
 * no `signature` ("thinking.signature: Field required") — both hard 400s.
 * Seen in prod failed runs 16670/16674/16677/16680 (Jul 2026).
 *
 * Signed (Anthropic-native) thinking blocks are preserved; foreign ones are
 * dropped — Anthropic cannot verify another provider's reasoning anyway.
 */
export function sanitizeMessagesForAnthropicReplay(messages = []) {
  return (messages || []).map((message) => {
    if (!message || !Array.isArray(message.content)) return message;

    const content = [];
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'thinking' || block.type === 'redacted_thinking')
          && !(typeof block.signature === 'string' && block.signature)
          && !(typeof block.data === 'string' && block.data)) {
        continue;
      }
      // Destructure-to-omit: the three named keys are deliberately dropped.
      // eslint-disable-next-line no-unused-vars
      const { openai_item_id, openai_call_id, openai_response_item, ...clean } = block;
      content.push(clean);
    }

    // An assistant turn whose only content was foreign reasoning would become
    // an (invalid) empty message — keep the transcript shape with a stub.
    if (!content.length) {
      content.push({ type: 'text', text: '(reasoning from fallback provider omitted)' });
    }

    return { ...message, content };
  });
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
