import OpenAI from 'openai';
import config from '../../config/index.js';
import { normalizeAiModel } from '../../utils/aiProviders.js';
import {
  buildAnthropicMessageFromOpenAiResponse,
  convertAnthropicMessagesToOpenAiInput,
  convertAnthropicToolsToOpenAiResponses,
} from './openAiConverters.js';

class OpenAiProvider {
  constructor() {
    this.client = null;
  }

  isConfigured() {
    return !!config.openai.apiKey;
  }

  getClient() {
    if (!this.isConfigured()) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: config.openai.apiKey });
    }
    return this.client;
  }

  async sendJson({
    systemPrompt,
    userMessage,
    model,
    maxTokens = 2048,
    temperature = null,
    signal = null,
    extra = {},
  }) {
    const selectedModel = normalizeAiModel(model || config.openai.model, 'openai');
    const response = await this.getClient().responses.create({
      model: selectedModel,
      instructions: systemPrompt,
      input: [{ role: 'user', content: userMessage }],
      text: {
        format: { type: 'json_object' },
        verbosity: 'medium',
        ...(extra.text || {}),
      },
      reasoning: extra.reasoning || { effort: 'none' },
      max_output_tokens: maxTokens,
      ...(temperature === null ? {} : { temperature }),
    }, signal ? { signal } : undefined);
    const content = response.output_text || this._flattenResponseOutput(response);
    return {
      content,
      parsed: this._parseJson(content),
      usage: this._usage(response),
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
    extra = {},
  }) {
    const selectedModel = normalizeAiModel(model || config.openai.model, 'openai');
    const convertedTools = convertAnthropicToolsToOpenAiResponses(tools);
    const response = await this.getClient().responses.create({
      model: selectedModel,
      instructions: this._instructions(systemPrompt, convertedTools.unsupported),
      input: convertAnthropicMessagesToOpenAiInput(messages),
      tools: convertedTools.tools,
      max_output_tokens: maxTokens,
      include: ['reasoning.encrypted_content'],
      reasoning: extra.reasoning || { effort: 'low' },
      text: extra.text || { verbosity: 'medium' },
    }, signal ? { signal } : undefined);

    const finalMessage = buildAnthropicMessageFromOpenAiResponse(response);
    for (const block of finalMessage.content || []) {
      if (block.type === 'text' && block.text) onText?.(block.text);
      if (block.type === 'thinking' && block.thinking) onThinking?.(block.thinking);
    }

    return {
      message: finalMessage,
      usage: this._usage(response),
      raw: response,
      metadata: {
        unsupportedTools: convertedTools.unsupported,
      },
    };
  }

  _instructions(systemPrompt, unsupportedTools = []) {
    const unsupportedNote = unsupportedTools.length
      ? `\n\nProvider note: Anthropic-only tools are unavailable on this OpenAI fallback attempt and were omitted: ${unsupportedTools.map((tool) => tool.name || tool.type).join(', ')}. Use the remaining local tools and supplied evidence.`
      : '';
    return `${systemPrompt}\n\nWhen referring to yourself, identify as the active OpenAI model for this fallback attempt, not as Claude or Anthropic.${unsupportedNote}`;
  }

  _usage(response) {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: response.usage?.total_tokens || inputTokens + outputTokens,
    };
  }

  _flattenResponseOutput(response) {
    if (!response?.output) return '';
    return response.output
      .flatMap((item) => item.content || [])
      .map((part) => part.text || part.refusal || '')
      .join('');
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

export default new OpenAiProvider();
export { OpenAiProvider };
