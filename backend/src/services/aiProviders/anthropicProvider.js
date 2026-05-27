import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import { normalizeAiModel } from '../../utils/aiProviders.js';

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
  }) {
    const selectedModel = normalizeAiModel(model || config.anthropic.defaultModel, 'anthropic');
    const response = await this.getClient().messages.create({
      model: selectedModel,
      max_tokens: maxTokens,
      temperature,
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }, signal ? { signal } : undefined);
    const content = response.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('') || '';
    return {
      content,
      parsed: this._parseJson(content),
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      },
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
