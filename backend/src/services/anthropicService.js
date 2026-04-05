import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000];

class AnthropicService {
  constructor() {
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      const apiKey = config.anthropic.apiKey;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }
      this._client = new Anthropic({ apiKey });
    }
    return this._client;
  }

  /**
   * Send a message to Claude and get a structured JSON response.
   * @param {Object} options
   * @param {string} options.systemPrompt - System-level instructions
   * @param {string} options.userMessage - The user/ticket content to analyze
   * @param {string} [options.model] - Model override
   * @param {number} [options.maxTokens=2048] - Max output tokens
   * @param {number} [options.temperature=0.3] - Sampling temperature
   * @returns {Promise<{content: string, parsed: Object|null, usage: {inputTokens: number, outputTokens: number}}>}
   */
  async sendMessage({ systemPrompt, userMessage, model, maxTokens = 2048, temperature = 0.3 }) {
    const client = this._getClient();
    const selectedModel = model || config.anthropic.defaultModel;

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const startTime = Date.now();

        const response = await client.messages.create({
          model: selectedModel,
          max_tokens: maxTokens,
          temperature,
          thinking: { type: 'disabled' },
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });

        const durationMs = Date.now() - startTime;
        const textContent = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');

        let parsed = null;
        try {
          const jsonMatch = textContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        } catch {
          logger.warn('Failed to parse JSON from Claude response', {
            model: selectedModel,
            responseLength: textContent.length,
          });
        }

        logger.debug('Anthropic API call completed', {
          model: selectedModel,
          durationMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        });

        return {
          content: textContent,
          parsed,
          usage: {
            inputTokens: response.usage?.input_tokens || 0,
            outputTokens: response.usage?.output_tokens || 0,
          },
        };
      } catch (error) {
        lastError = error;
        const isRetryable =
          error.status === 429 ||
          error.status === 529 ||
          error.status >= 500;

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] || 10000;
          logger.warn(`Anthropic API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`, {
            status: error.status,
            message: error.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        logger.error('Anthropic API call failed', {
          model: selectedModel,
          status: error.status,
          message: error.message,
          attempt: attempt + 1,
        });
        throw error;
      }
    }

    throw lastError;
  }

  isConfigured() {
    return !!config.anthropic.apiKey;
  }
}

export default new AnthropicService();
