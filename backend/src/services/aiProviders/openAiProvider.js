import OpenAI from 'openai';
import config from '../../config/index.js';
import { normalizeAiModel } from '../../utils/aiProviders.js';
import {
  buildAnthropicMessageFromOpenAiResponse,
  convertAnthropicMessagesToOpenAiInput,
  convertAnthropicToolsToOpenAiResponses,
  convertUserContentBlockToOpenAiPart,
} from './openAiConverters.js';

function metadataFromResponse(response, usage, maxTokens) {
  const incompleteReason = response.incomplete_details?.reason || null;
  return {
    status: response.status || null,
    incompleteReason,
    requestedMaxTokens: maxTokens,
    tokenLimitHit: incompleteReason === 'max_output_tokens'
      || response.status === 'incomplete'
      || (maxTokens > 0 && usage.outputTokens >= maxTokens),
  };
}

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
      input: [{ role: 'user', content: this._jsonModeInput(userMessage) }],
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
    const usage = this._usage(response);
    return {
      content,
      parsed: this._parseJson(content),
      usage,
      metadata: metadataFromResponse(response, usage, maxTokens),
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
    const selectedModel = normalizeAiModel(model || config.openai.model, 'openai');
    const convertedTools = convertAnthropicToolsToOpenAiResponses(tools);
    let streamedText = '';
    let streamedThinking = '';
    const stream = this.getClient().responses.stream({
      model: selectedModel,
      instructions: this._instructions(systemPrompt, convertedTools.unsupported),
      input: convertAnthropicMessagesToOpenAiInput(messages),
      tools: convertedTools.tools,
      max_output_tokens: maxTokens,
      include: ['reasoning.encrypted_content'],
      reasoning: extra.reasoning || { effort: 'low' },
      text: extra.text || { verbosity: 'medium' },
    }, signal ? { signal } : undefined);

    stream.on('response.output_text.delta', (event) => {
      if (!event?.delta) return;
      streamedText += event.delta;
      onText?.(event.delta);
    });

    stream.on('response.function_call_arguments.delta', (event) => {
      if (!event?.delta) return;
      onInputJson?.(event.delta);
    });

    stream.on('event', (event) => {
      if (event?.type !== 'response.reasoning_text.delta' || !event.delta) return;
      streamedThinking += event.delta;
      onThinking?.(event.delta);
    });

    const response = await stream.finalResponse();
    const finalMessage = buildAnthropicMessageFromOpenAiResponse(response);
    this._emitMissingFinalText(finalMessage, streamedText, streamedThinking, { onText, onThinking });

    return {
      message: finalMessage,
      usage: this._usage(response),
      raw: response,
      metadata: {
        unsupportedTools: convertedTools.unsupported,
      },
    };
  }

  _emitMissingFinalText(finalMessage, streamedText, streamedThinking, { onText, onThinking }) {
    const finalText = (finalMessage?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('');
    const finalThinking = (finalMessage?.content || [])
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking || '')
      .join('');

    if (finalText && finalText.startsWith(streamedText)) {
      const missingText = finalText.slice(streamedText.length);
      if (missingText) onText?.(missingText);
    } else if (finalText && !streamedText) {
      onText?.(finalText);
    }

    if (finalThinking && finalThinking.startsWith(streamedThinking)) {
      const missingThinking = finalThinking.slice(streamedThinking.length);
      if (missingThinking) onThinking?.(missingThinking);
    } else if (finalThinking && !streamedThinking) {
      onThinking?.(finalThinking);
    }
  }

  _instructions(systemPrompt, unsupportedTools = []) {
    const unsupportedNote = unsupportedTools.length
      ? `\n\nProvider note: Anthropic-only tools are unavailable on this OpenAI fallback attempt and were omitted: ${unsupportedTools.map((tool) => tool.name || tool.type).join(', ')}. Use the remaining local tools and supplied evidence.`
      : '';
    return `${systemPrompt}\n\nWhen referring to yourself, identify as the active OpenAI model for this fallback attempt, not as Claude or Anthropic.${unsupportedNote}`;
  }

  _jsonModeInput(userMessage) {
    if (!Array.isArray(userMessage)) {
      const content = String(userMessage || '');
      return /\bjson\b/i.test(content) ? content : `Return JSON only.\n\n${content}`;
    }
    // Anthropic-style content blocks (text + image) → Responses input parts.
    // Unknown block types throw: silently stringifying them produced
    // "[object Object]" prompts before Phase AF.
    const parts = userMessage.map((block) => convertUserContentBlockToOpenAiPart(block));
    const mentionsJson = parts.some((part) => part.type === 'input_text' && /\bjson\b/i.test(part.text));
    if (!mentionsJson) {
      const firstText = parts.find((part) => part.type === 'input_text');
      if (firstText) {
        firstText.text = `Return JSON only.\n\n${firstText.text}`;
      } else {
        parts.push({ type: 'input_text', text: 'Return JSON only.' });
      }
    }
    return parts;
  }

  _usage(response) {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    // OpenAI caches automatically on stable prefixes ≥1024 tokens; cached
    // tokens bill at half price (Responses API reports them in
    // input_tokens_details). input_tokens INCLUDES the cached portion.
    const cacheReadInputTokens = response.usage?.input_tokens_details?.cached_tokens
      || response.usage?.prompt_tokens_details?.cached_tokens
      || 0;
    return {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
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
