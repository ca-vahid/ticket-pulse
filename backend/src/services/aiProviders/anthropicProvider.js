import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import { normalizeAiModel, shouldOmitAnthropicTemperature } from '../../utils/aiProviders.js';

function usageFromResponse(response) {
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
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
      system: systemPrompt,
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
      system: systemPrompt,
      tools,
      messages,
      ...(extra.thinking ? { thinking: extra.thinking } : {}),
      ...(extra.outputConfig ? { output_config: extra.outputConfig } : {}),
    }, signal ? { signal } : undefined);

    stream.on('text', (text) => onText?.(text));
    stream.on('thinking', (chunk) => onThinking?.(chunk));
    stream.on('inputJson', (partialJson) => onInputJson?.(partialJson));

    const finalMessage = await stream.finalMessage();
    const usage = {
      inputTokens: finalMessage.usage?.input_tokens || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0,
      totalTokens: (finalMessage.usage?.input_tokens || 0) + (finalMessage.usage?.output_tokens || 0),
    };
    return {
      message: finalMessage,
      usage,
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
