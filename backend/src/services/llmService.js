import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import llmConfigService from './llmConfigService.js';

/**
 * LLM Service
 * Handles OpenAI GPT interactions for ticket classification and response generation
 */
class LLMService {
  constructor() {
    if (!config.openai.apiKey) {
      logger.warn('OpenAI API key not configured. LLM features will be disabled.');
      this.client = null;
    } else {
      this.client = new OpenAI({
        apiKey: config.openai.apiKey,
      });
    }

    // Default to GPT-5.1 unless overridden
    this.model = config.openai.model || 'gpt-5.1';
  }

  /**
   * Classify an incoming email/ticket
   * @param {Object} ticketData - The ticket/email data
   * @returns {Promise<Object>} Classification result
   */
  async classifyTicket(ticketData) {
    if (!this.client) {
      logger.error('OpenAI client not initialized');
      throw new Error('LLM service not available');
    }

    const { subject, body, senderEmail, senderName } = ticketData;

    // Get published config for classification prompt
    const llmConfig = await llmConfigService.getPublishedConfig();

    // Check for override rules first
    const override = llmConfigService.applyOverrideRules(ticketData, llmConfig.overrideRules);
    if (override) {
      logger.info('Using override classification', { override });
      return {
        classification: override,
        tokensUsed: 0,
        model: 'override-rule',
        duration: 0,
      };
    }

    // Check domain whitelist/blacklist
    if (!llmConfigService.isDomainAllowed(senderEmail, llmConfig.domainWhitelist, llmConfig.domainBlacklist)) {
      logger.info('Email from blocked domain', { senderEmail });
      return {
        classification: {
          sourceType: 'spam',
          severity: 'low',
          requiresPersonalResponse: false,
          category: 'blocked_domain',
          summary: 'Email from blocked domain',
          confidence: 1.0,
          reasoning: 'Domain is in blacklist or not in whitelist',
        },
        tokensUsed: 0,
        model: 'domain-filter',
        duration: 0,
      };
    }

    // Replace placeholders in classification prompt
    const prompt = llmConfigService.replacePlaceholders(llmConfig.classificationPrompt, {
      senderName: senderName || 'Unknown',
      senderEmail,
      subject: subject || 'No subject',
      body: body || 'No content',
    });

    try {
      const startTime = Date.now();

      const response = await this.client.responses.create({
        model: llmConfig.model || this.model,
        input: [
          { role: 'system', content: 'You are an expert IT helpdesk ticket classifier. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        reasoning: { effort: llmConfig.reasoningEffort || 'none' },
        text: {
          verbosity: llmConfig.verbosity || 'medium',
          format: { type: 'json_object' },
        },
        max_output_tokens: Math.min(600, llmConfig.maxOutputTokens || 800),
      });

      const duration = Date.now() - startTime;
      const outputText = response.output_text || this.flattenResponseOutput(response);
      const result = JSON.parse(outputText);
      const tokensUsed = response.usage?.total_tokens
        ?? (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      logger.info(`Ticket classified in ${duration}ms: ${result.category} (${result.severity})`, {
        sourceType: result.sourceType,
        tokensUsed,
        model: response.model,
      });

      return {
        classification: result,
        tokensUsed,
        model: response.model,
        duration,
      };
    } catch (error) {
      logger.error('Error classifying ticket with LLM:', error);

      // Fallback classification
      return {
        classification: {
          sourceType: 'human_request',
          severity: 'medium',
          requiresPersonalResponse: true,
          category: 'general_inquiry',
          summary: 'Unable to automatically classify',
          confidence: 0.1,
          reasoning: 'LLM classification failed, using fallback',
        },
        tokensUsed: 0,
        model: llmConfig.model || this.model,
        duration: 0,
        error: error.message,
      };
    }
  }

  /**
   * Generate a personalized auto-response
   * @param {Object} params - Response generation parameters
   * @returns {Promise<Object>} Generated response
   */
  async generateResponse(params) {
    if (!this.client) {
      logger.error('OpenAI client not initialized');
      throw new Error('LLM service not available');
    }

    const {
      classification,
      senderName,
      senderEmail,
      subject,
      etaInfo,
      isAfterHours,
      isHoliday,
      holidayName,
    } = params;

    // Get published config for response generation
    const llmConfig = await llmConfigService.getPublishedConfig();

    // Build context for response generation
    const contextParts = [];

    if (isHoliday) {
      const holidayMsg = llmConfig.holidayMessage || `Today is ${holidayName}, a holiday. The office is closed.`;
      contextParts.push(holidayMsg);
    } else if (isAfterHours) {
      const afterHoursMsg = llmConfig.afterHoursMessage || 'This message was received outside of business hours.';
      contextParts.push(afterHoursMsg);
    } else {
      contextParts.push('This message was received during business hours.');
    }

    if (etaInfo) {
      if (etaInfo.isAfterHours) {
        contextParts.push(`Business hours resume at ${etaInfo.nextBusinessTime?.toLocaleString() || 'the next business day'}.`);
        contextParts.push(`Estimated response time after opening: ${etaInfo.estimatedMinutes} minutes.`);
      } else {
        contextParts.push(`Current estimated response time: ${etaInfo.estimatedMinutes} minutes.`);
        contextParts.push(`Queue status: ${etaInfo.reason}`);
      }
    }

    const context = contextParts.join(' ');

    // Get tone preset and instructions for this classification type
    const tonePreset = llmConfig.tonePresets?.[classification.sourceType] || llmConfig.tonePresets?.['human_request'];
    const responseInstructions = tonePreset?.instructions || 'Generate a professional auto-response acknowledging receipt.';

    const systemPrompt = 'You are a helpful IT helpdesk auto-response assistant.';

    // Replace placeholders in response prompt
    const prompt = llmConfigService.replacePlaceholders(llmConfig.responsePrompt, {
      senderName: senderName || 'User',
      senderEmail,
      subject: subject || 'No subject',
      category: classification.category,
      severity: classification.severity,
      sourceType: classification.sourceType,
      summary: classification.summary,
      context,
      instructions: responseInstructions,
    });

    try {
      const startTime = Date.now();

      const response = await this.client.responses.create({
        model: llmConfig.model || this.model,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        reasoning: { effort: llmConfig.reasoningEffort || 'none' },
        text: {
          verbosity: llmConfig.verbosity || 'medium',
          format: { type: 'json_object' },
        },
        max_output_tokens: llmConfig.maxOutputTokens || 800,
      });

      const duration = Date.now() - startTime;
      const outputText = response.output_text || this.flattenResponseOutput(response);
      const result = JSON.parse(outputText);
      const tokensUsed = response.usage?.total_tokens
        ?? (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      logger.info(`Response generated in ${duration}ms (${result.tone})`, {
        tokensUsed,
        model: response.model,
      });

      // Add signature if configured
      if (llmConfig.signatureBlock) {
        result.body = `${result.body}\n\n${llmConfig.signatureBlock}`;
      }

      return {
        response: result,
        tokensUsed,
        model: response.model,
        duration,
      };
    } catch (error) {
      logger.error('Error generating response with LLM:', error);

      // Fallback response using configured fallback message
      const fallbackBody = llmConfig.fallbackMessage || `Dear ${senderName || 'valued user'},

Thank you for contacting IT Support. We have received your request and will respond as soon as possible.

${isAfterHours ? 'Your message was received outside of business hours. We will respond during our next business day.' : 'A technician will review your request shortly.'}`;

      const bodyWithSignature = llmConfig.signatureBlock
        ? `${fallbackBody}\n\n${llmConfig.signatureBlock}`
        : `${fallbackBody}\n\nBest regards,\nIT Support Team`;

      return {
        response: {
          subject: `Re: ${subject || 'Your IT Support Request'}`,
          body: bodyWithSignature,
          tone: 'fallback',
        },
        tokensUsed: 0,
        model: this.model,
        duration: 0,
        error: error.message,
      };
    }
  }

  /**
   * Helper to flatten Responses API output into text
   */
  flattenResponseOutput(response) {
    if (!response?.output) return '';
    return response.output
      .map(block => {
        if (!block.content) return '';
        return block.content
          .map(part => part.text ?? part?.content ?? '')
          .join('');
      })
      .join('');
  }
}

export default new LLMService();

