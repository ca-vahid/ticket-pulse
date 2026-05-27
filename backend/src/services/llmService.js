import config from '../config/index.js';
import logger from '../utils/logger.js';
import llmConfigService from './llmConfigService.js';
import providerGateway from './aiProviders/providerGateway.js';

/**
 * LLM Service
 * Handles OpenAI GPT interactions for ticket classification and response generation
 */
class LLMService {
  constructor() {
    this.model = config.openai.model || 'gpt-5.5';
  }

  /**
   * Classify an incoming email/ticket
   * @param {Object} ticketData - The ticket/email data
   * @returns {Promise<Object>} Classification result
   */
  async classifyTicket(ticketData) {
    const { subject, body, senderEmail, senderName } = ticketData;

    const llmConfig = await llmConfigService.getPublishedConfig(ticketData.workspaceId);

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

      const response = await providerGateway.sendJson({
        operation: 'autoresponse_classification',
        workspaceId: ticketData.workspaceId || 1,
        legacyModel: llmConfig.model || this.model,
        systemPrompt: 'You are an expert IT helpdesk ticket classifier. Always respond with valid JSON only.',
        userMessage: prompt,
        maxTokens: Math.min(600, llmConfig.maxOutputTokens || 800),
        temperature: 0,
        extra: {
          reasoning: { effort: llmConfig.reasoningEffort || 'none' },
          text: {
            verbosity: llmConfig.verbosity || 'medium',
            format: { type: 'json_object' },
          },
        },
      });

      const duration = Date.now() - startTime;
      const result = response.parsed || JSON.parse(response.content || '{}');
      const tokensUsed = response.usage?.totalTokens
        ?? (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0);

      logger.info(`Ticket classified in ${duration}ms: ${result.category} (${result.severity})`, {
        sourceType: result.sourceType,
        tokensUsed,
        provider: response.provider,
        model: response.model,
        fallbackUsed: response.fallbackUsed,
      });

      return {
        classification: result,
        tokensUsed,
        model: response.model,
        provider: response.provider,
        fallbackUsed: response.fallbackUsed,
        fallbackReason: response.fallbackReason || null,
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

    const llmConfig = await llmConfigService.getPublishedConfig(params.workspaceId);

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

      const response = await providerGateway.sendJson({
        operation: 'autoresponse_generation',
        workspaceId: params.workspaceId || 1,
        legacyModel: llmConfig.model || this.model,
        systemPrompt,
        userMessage: prompt,
        maxTokens: llmConfig.maxOutputTokens || 800,
        temperature: 0,
        extra: {
          reasoning: { effort: llmConfig.reasoningEffort || 'none' },
          text: {
            verbosity: llmConfig.verbosity || 'medium',
            format: { type: 'json_object' },
          },
        },
      });

      const duration = Date.now() - startTime;
      const result = response.parsed || JSON.parse(response.content || '{}');
      const tokensUsed = response.usage?.totalTokens
        ?? (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0);

      logger.info(`Response generated in ${duration}ms (${result.tone})`, {
        tokensUsed,
        provider: response.provider,
        model: response.model,
        fallbackUsed: response.fallbackUsed,
      });

      // Add signature if configured
      if (llmConfig.signatureBlock) {
        result.body = `${result.body}\n\n${llmConfig.signatureBlock}`;
      }

      return {
        response: result,
        tokensUsed,
        model: response.model,
        provider: response.provider,
        fallbackUsed: response.fallbackUsed,
        fallbackReason: response.fallbackReason || null,
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

}

export default new LLMService();
