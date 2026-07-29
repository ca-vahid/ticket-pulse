import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import { normalizeAiModel, shouldOmitAnthropicTemperature } from '../../utils/aiProviders.js';
import { sanitizeMessagesForAnthropicReplay } from './openAiConverters.js';

function usageFromResponse(response) {
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  // With prompt caching, input_tokens counts ONLY the uncached tail; cached
  // prefix tokens are billed separately (writes at 1.25x, reads at 0.1x).
  const cacheCreationInputTokens = response.usage?.cache_creation_input_tokens || 0;
  const cacheReadInputTokens = response.usage?.cache_read_input_tokens || 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens,
  };
}

/**
 * Prompt caching (cost work, Jul 10). Anthropic caches the request prefix at
 * explicit breakpoints; repeats within ~5 min bill at 10% of input price.
 * Our agentic pipeline re-sends system + tools + a growing transcript every
 * turn, so nearly the whole request is a cacheable repeat of the previous
 * turn. Breakpoints (max 4 allowed; we use 3):
 *   1. system prompt   2. tools array (via its last tool)   3. the last message
 * Below-minimum prefixes (1024/2048 tokens depending on model) simply don't
 * cache — no penalty. Never mutates caller-owned arrays.
 */
function cacheableSystem(systemPrompt) {
  if (!systemPrompt) return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    if (systemPrompt.length === 0) return systemPrompt;
    return systemPrompt.map((block, i) => (
      i === systemPrompt.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
    ));
  }
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

function cacheableTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map((tool, i) => (
    i === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
  ));
}

function cacheableMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(content) && content.length > 0) {
    content = content.map((block, i) => (
      i === content.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
    ));
  } else {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

function metadataFromResponse(response, maxTokens) {
  const usage = usageFromResponse(response);
  return {
    stopReason: response.stop_reason || null,
    stopSequence: response.stop_sequence || null,
    requestedMaxTokens: maxTokens,
    tokenLimitHit: response.stop_reason === 'max_tokens' || (maxTokens > 0 && usage.outputTokens >= maxTokens),
  };
}

class AnthropicProvider {
  constructor() {
    this.client = null;
  }

  isConfigured() {
    return !!config.anthropic.apiKey;
  }

  getClient() {
    if (!this.isConfigured()) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    }
    return this.client;
  }

  async sendJson({
    systemPrompt,
    userMessage,
    model,
    maxTokens = 2048,
    temperature = 0.3,
    signal = null,
    extra = {},
  }) {
    const selectedModel = normalizeAiModel(model || config.anthropic.defaultModel, 'anthropic');
    const request = {
      model: selectedModel,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      // Cached system prompt: single-shot operations (sentiment, workflow
      // generation) reuse the same static instructions call after call.
      system: cacheableSystem(systemPrompt),
      messages: [{ role: 'user', content: userMessage }],
    };
    if (extra.jsonSchema) {
      request.tools = [{
        name: 'emit_notification_json',
        description: 'Return the notification workflow email content using the exact requested schema.',
        input_schema: extra.jsonSchema,
      }];
      request.tool_choice = { type: 'tool', name: 'emit_notification_json' };
    }
    if (!shouldOmitAnthropicTemperature(selectedModel)) {
      request.temperature = temperature;
    }
    const response = await this.getClient().messages.create(request, signal ? { signal } : undefined);
    const toolUse = response.content?.find((block) => block.type === 'tool_use' && block.name === 'emit_notification_json');
    if (toolUse?.input) {
      return {
        content: JSON.stringify(toolUse.input),
        parsed: toolUse.input,
        usage: usageFromResponse(response),
        metadata: metadataFromResponse(response, maxTokens),
        raw: response,
      };
    }
    const content = response.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('') || '';
    return {
      content,
      parsed: this._parseJson(content),
      usage: usageFromResponse(response),
      metadata: metadataFromResponse(response, maxTokens),
      raw: response,
    };
  }

  async toolResponse({
    systemPrompt,
    messages,
    tools,
    model,
    maxTokens = 4096,
    signal = null,
    onText = null,
    onThinking = null,
    onInputJson = null,
    extra = {},
  }) {
    const selectedModel = normalizeAiModel(model || config.anthropic.defaultModel, 'anthropic');
    const stream = this.getClient().messages.stream({
      model: selectedModel,
      max_tokens: maxTokens,
      // Agentic loop: every turn re-sends system + tools + the growing
      // transcript. Cache breakpoints turn each turn's request into ~90%
      // cache reads of the previous turn's prefix.
      system: cacheableSystem(systemPrompt),
      tools: cacheableTools(tools),
      // Replay histories can contain OpenAI-fallback residue (round-trip
      // annotations, unsigned thinking blocks) that the Messages API 400s on.
      messages: cacheableMessages(sanitizeMessagesForAnthropicReplay(messages)),
      // Sonnet 5 runs adaptive thinking when the field is omitted (4.6 ran
      // thinking-off); disable explicitly so pipeline latency/token behavior
      // stays model-independent unless a caller opts in via extra.thinking.
      thinking: extra.thinking || { type: 'disabled' },
      ...(extra.outputConfig ? { output_config: extra.outputConfig } : {}),
    }, signal ? { signal } : undefined);

    stream.on('text', (text) => onText?.(text));
    stream.on('thinking', (chunk) => onThinking?.(chunk));
    stream.on('inputJson', (partialJson) => onInputJson?.(partialJson));

    const finalMessage = await stream.finalMessage();
    return {
      message: finalMessage,
      usage: usageFromResponse(finalMessage),
      raw: finalMessage,
    };
  }

  _parseJson(content) {
    try {
      const match = String(content || '').match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    } catch {
      return null;
    }
  }
}

export default new AnthropicProvider();
export { AnthropicProvider };
