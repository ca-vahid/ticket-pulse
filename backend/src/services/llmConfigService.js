import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

/**
 * LLM Configuration Service
 * Manages LLM prompts, templates, and rules with versioning
 */
class LlmConfigService {
  /**
   * Get default configuration
   */
  getDefaults() {
    return {
      classificationPrompt: `You are an IT helpdesk ticket classifier. Analyze the following incoming email/ticket and provide a structured classification.

Email Details:
- From: {{senderName}} <{{senderEmail}}>
- Subject: {{subject}}
- Body: {{body}}

Please analyze and respond with a JSON object containing:
1. "sourceType": one of ["human_request", "automated_notification", "vendor_email", "mailing_list", "spam", "out_of_office"]
2. "severity": one of ["low", "medium", "high", "urgent"]
3. "requiresPersonalResponse": boolean (true if this needs a personalized human touch)
4. "category": brief category/topic of the request (e.g., "password_reset", "software_install", "hardware_issue", "network_problem")
5. "summary": brief one-sentence summary of the request
6. "confidence": number between 0-1 indicating classification confidence
7. "reasoning": brief explanation of the classification

Respond ONLY with valid JSON, no additional text.`,

      responsePrompt: `Generate an auto-response email for this IT helpdesk ticket.

Sender: {{senderName}} <{{senderEmail}}>
Subject: {{subject}}
Classification: {{category}} ({{severity}} severity)
Source Type: {{sourceType}}
Request Summary: {{summary}}

Context: {{context}}

{{instructions}}

Respond with a JSON object containing:
1. "subject": email subject line (brief, professional)
2. "body": email body text (plain text, use \\n for line breaks)
3. "tone": the tone used (professional, friendly, brief, etc.)

Do NOT include signature block or footer. Respond ONLY with valid JSON.`,

      signatureBlock: `Best regards,
IT Support Team`,

      fallbackMessage: `Thank you for contacting IT Support. We have received your request and will respond as soon as possible.

If you need immediate assistance, please call our helpdesk at [PHONE NUMBER].`,

      tonePresets: {
        human_request: {
          instructions: `Generate a warm, professional auto-response email that:
- Addresses the sender by name ({{senderName}})
- Acknowledges receipt of their request about "{{category}}"
- Provides the estimated response time
- Is reassuring and professional
- Includes appropriate details about business hours/holidays if applicable
- Keep it concise but friendly (3-5 sentences)`,
          tone: 'warm and professional',
        },
        automated_notification: {
          instructions: `This appears to be an automated or bulk email. Generate a brief, professional acknowledgment that:
- Politely acknowledges receipt
- Indicates that automated emails may not receive a response
- Suggests the sender contact IT directly if this requires action
- Keep it very brief (2-3 sentences max)`,
          tone: 'brief and professional',
        },
        vendor_email: {
          instructions: `This appears to be a vendor communication. Generate a professional acknowledgment that:
- Thanks them for their message
- Indicates we will review and respond if necessary
- Keep it brief and courteous (2-3 sentences)`,
          tone: 'professional and courteous',
        },
        mailing_list: {
          instructions: 'This appears to be from a mailing list. Generate a minimal acknowledgment (1-2 sentences).',
          tone: 'minimal',
        },
        out_of_office: {
          instructions: 'This is an out-of-office reply. Generate a very brief acknowledgment (1-2 sentences) noting we received their auto-reply.',
          tone: 'minimal',
        },
        spam: {
          instructions: 'This appears to be spam. Generate a minimal acknowledgment that we received their message. Keep it to 1-2 sentences.',
          tone: 'minimal',
        },
      },

      baseResponseMinutes: 30,
      perTicketDelayMinutes: 10,

      afterHoursMessage: 'Your message was received outside of business hours. We will respond during our next business day.',

      holidayMessage: 'Your message was received on a holiday. We will respond on the next business day.',

      overrideRules: [],
      domainWhitelist: [],
      domainBlacklist: [],

      model: 'gpt-5.1',
      reasoningEffort: 'none',
      verbosity: 'medium',
      maxOutputTokens: 800,
    };
  }

  /**
   * Initialize default published configuration if none exists
   */
  async initializeDefaultConfig() {
    try {
      const existingPublished = await prisma.llmConfig.findFirst({
        where: { status: 'published' },
      });

      if (existingPublished) {
        logger.debug('Published LLM config already exists');
        return existingPublished;
      }

      logger.info('No published LLM config found, creating default published config');

      const defaults = this.getDefaults();
      const published = await prisma.llmConfig.create({
        data: {
          status: 'published',
          version: 1,
          classificationPrompt: defaults.classificationPrompt,
          responsePrompt: defaults.responsePrompt,
          signatureBlock: defaults.signatureBlock,
          fallbackMessage: defaults.fallbackMessage,
          tonePresets: defaults.tonePresets,
          baseResponseMinutes: defaults.baseResponseMinutes,
          perTicketDelayMinutes: defaults.perTicketDelayMinutes,
          afterHoursMessage: defaults.afterHoursMessage,
          holidayMessage: defaults.holidayMessage,
          overrideRules: defaults.overrideRules,
          domainWhitelist: defaults.domainWhitelist,
          domainBlacklist: defaults.domainBlacklist,
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort,
          verbosity: defaults.verbosity,
          maxOutputTokens: defaults.maxOutputTokens,
          publishedBy: 'system',
          publishedAt: new Date(),
          notes: 'Initial default configuration',
        },
      });

      // Log to history
      await this.logHistory(published.id, published.version, 'created', 'system', 'Initial default configuration published');

      logger.info('Default LLM config published', { id: published.id, version: published.version });
      return published;
    } catch (error) {
      logger.error('Failed to initialize default LLM config:', error);
      throw error;
    }
  }

  /**
   * Get the currently published configuration
   */
  async getPublishedConfig() {
    try {
      const config = await prisma.llmConfig.findFirst({
        where: { status: 'published' },
        orderBy: { version: 'desc' },
      });

      if (config) {
        return this.hydrateConfig(config);
      }

      // No published config, initialize defaults
      logger.info('No published LLM config found, initializing defaults');
      const initialized = await this.initializeDefaultConfig();
      return this.hydrateConfig(initialized);
    } catch (error) {
      logger.error('Error fetching published LLM config:', error);
      return this.getDefaults();
    }
  }

  /**
   * Get draft configuration (or create one from published)
   */
  async getDraftConfig() {
    try {
      let draft = await prisma.llmConfig.findFirst({
        where: { status: 'draft' },
        orderBy: { updatedAt: 'desc' },
      });

      if (!draft) {
        // Create draft from published or defaults
        const published = await this.getPublishedConfig();
        draft = await this.createDraft(published);
      }

      return this.hydrateConfig(draft);
    } catch (error) {
      logger.error('Error fetching draft LLM config:', error);
      throw error;
    }
  }

  /**
   * Hydrate config (parse JSON fields)
   */
  hydrateConfig(config) {
    return {
      ...config,
      tonePresets: config.tonePresets || this.getDefaults().tonePresets,
      overrideRules: config.overrideRules || [],
      domainWhitelist: config.domainWhitelist || [],
      domainBlacklist: config.domainBlacklist || [],
      model: config.model || this.getDefaults().model,
      reasoningEffort: config.reasoningEffort || this.getDefaults().reasoningEffort,
      verbosity: config.verbosity || this.getDefaults().verbosity,
      maxOutputTokens: config.maxOutputTokens || this.getDefaults().maxOutputTokens,
    };
  }

  /**
   * Create a draft configuration
   */
  async createDraft(baseConfig, createdBy = 'system') {
    const defaults = this.getDefaults();

    const draft = await prisma.llmConfig.create({
      data: {
        status: 'draft',
        version: 1,
        classificationPrompt: baseConfig.classificationPrompt || defaults.classificationPrompt,
        responsePrompt: baseConfig.responsePrompt || defaults.responsePrompt,
        signatureBlock: baseConfig.signatureBlock || defaults.signatureBlock,
        fallbackMessage: baseConfig.fallbackMessage || defaults.fallbackMessage,
        tonePresets: baseConfig.tonePresets || defaults.tonePresets,
        baseResponseMinutes: baseConfig.baseResponseMinutes || defaults.baseResponseMinutes,
        perTicketDelayMinutes: baseConfig.perTicketDelayMinutes || defaults.perTicketDelayMinutes,
        afterHoursMessage: baseConfig.afterHoursMessage || defaults.afterHoursMessage,
        holidayMessage: baseConfig.holidayMessage || defaults.holidayMessage,
        overrideRules: baseConfig.overrideRules || defaults.overrideRules,
        domainWhitelist: baseConfig.domainWhitelist || defaults.domainWhitelist,
        domainBlacklist: baseConfig.domainBlacklist || defaults.domainBlacklist,
        model: baseConfig.model || defaults.model,
        reasoningEffort: baseConfig.reasoningEffort || defaults.reasoningEffort,
        verbosity: baseConfig.verbosity || defaults.verbosity,
        maxOutputTokens: baseConfig.maxOutputTokens || defaults.maxOutputTokens,
        createdBy,
      },
    });

    // Log creation in history
    await this.logHistory(draft.id, draft.version, 'created', createdBy, 'Draft configuration created');

    logger.info('Draft LLM config created', { id: draft.id, version: draft.version });
    return draft;
  }

  /**
   * Update draft configuration
   */
  async updateDraft(updates, updatedBy = 'system') {
    try {
      const draft = await this.getDraftConfig();

      const updated = await prisma.llmConfig.update({
        where: { id: draft.id },
        data: {
          ...updates,
          updatedAt: new Date(),
        },
      });

      // Log update in history
      await this.logHistory(updated.id, updated.version, 'updated', updatedBy, 'Draft configuration updated');

      logger.info('Draft LLM config updated', { id: updated.id });
      return this.hydrateConfig(updated);
    } catch (error) {
      logger.error('Error updating draft LLM config:', error);
      throw error;
    }
  }

  /**
   * Publish draft configuration
   */
  async publishDraft(publishedBy = 'system', notes = null) {
    try {
      const draft = await this.getDraftConfig();

      // Unpublish any existing published config
      await prisma.llmConfig.updateMany({
        where: { status: 'published' },
        data: { status: 'archived' },
      });

      // Get the highest version number
      const latestPublished = await prisma.llmConfig.findFirst({
        orderBy: { version: 'desc' },
      });

      const newVersion = latestPublished ? latestPublished.version + 1 : 1;

      // Publish the draft
      const published = await prisma.llmConfig.update({
        where: { id: draft.id },
        data: {
          status: 'published',
          version: newVersion,
          publishedBy,
          publishedAt: new Date(),
          notes,
        },
      });

      // Log publish in history
      await this.logHistory(published.id, published.version, 'published', publishedBy, notes || 'Configuration published');

      logger.info('Draft LLM config published', { id: published.id, version: published.version });
      return this.hydrateConfig(published);
    } catch (error) {
      logger.error('Error publishing LLM config:', error);
      throw error;
    }
  }

  /**
   * Reset draft to defaults
   */
  async resetDraftToDefaults(resetBy = 'system') {
    try {
      const defaults = this.getDefaults();

      // Delete existing draft
      await prisma.llmConfig.deleteMany({
        where: { status: 'draft' },
      });

      // Create new draft with defaults
      return await this.createDraft(defaults, resetBy);
    } catch (error) {
      logger.error('Error resetting draft to defaults:', error);
      throw error;
    }
  }

  /**
   * Get configuration history
   */
  async getHistory(limit = 50) {
    return await prisma.llmConfigHistory.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Log configuration change to history
   */
  async logHistory(configId, version, action, changedBy, changeNotes) {
    const config = await prisma.llmConfig.findUnique({ where: { id: configId } });

    return await prisma.llmConfigHistory.create({
      data: {
        configId,
        version,
        action,
        configSnapshot: config,
        changedBy,
        changeNotes,
      },
    });
  }

  /**
   * Revert to a specific version
   */
  async revertToVersion(historyId, revertedBy = 'system') {
    try {
      const historyRecord = await prisma.llmConfigHistory.findUnique({
        where: { id: historyId },
      });

      if (!historyRecord) {
        throw new Error('History record not found');
      }

      const snapshot = historyRecord.configSnapshot;

      // Delete current draft
      await prisma.llmConfig.deleteMany({ where: { status: 'draft' } });

      // Create new draft from snapshot
      const reverted = await this.createDraft(snapshot, revertedBy);

      await this.logHistory(
        reverted.id,
        reverted.version,
        'reverted',
        revertedBy,
        `Reverted to version ${historyRecord.version}`,
      );

      logger.info('LLM config reverted', { historyId, newDraftId: reverted.id });
      return reverted;
    } catch (error) {
      logger.error('Error reverting LLM config:', error);
      throw error;
    }
  }

  /**
   * Validate placeholders in a template
   */
  validatePlaceholders(template, requiredPlaceholders = []) {
    const found = template.match(/\{\{(\w+)\}\}/g) || [];
    const foundNames = found.map(p => p.replace(/\{\{|\}\}/g, ''));

    const missing = requiredPlaceholders.filter(req => !foundNames.includes(req));
    const extra = foundNames.filter(name => !requiredPlaceholders.includes(name));

    return {
      valid: missing.length === 0,
      found: foundNames,
      missing,
      extra,
    };
  }

  /**
   * Replace placeholders in a template
   */
  replacePlaceholders(template, values) {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = `{{${key}}}`;
      result = result.replace(new RegExp(placeholder, 'g'), value || '');
    }
    return result;
  }

  /**
   * Check if domain is allowed based on whitelist/blacklist
   */
  isDomainAllowed(email, whitelist = [], blacklist = []) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return true;

    // If whitelist exists, domain must be in it
    if (whitelist.length > 0) {
      return whitelist.some(d => d.toLowerCase() === domain);
    }

    // Check blacklist
    if (blacklist.length > 0) {
      return !blacklist.some(d => d.toLowerCase() === domain);
    }

    return true;
  }

  /**
   * Apply override rules to classification
   */
  applyOverrideRules(ticketData, overrideRules = []) {
    for (const rule of overrideRules) {
      if (this.ruleMatches(ticketData, rule)) {
        logger.info('Override rule matched', { rule: rule.name });
        return rule.overrideClassification;
      }
    }
    return null;
  }

  /**
   * Check if a rule matches ticket data
   */
  ruleMatches(ticketData, rule) {
    const { field, operator, value } = rule;
    const fieldValue = ticketData[field];

    if (!fieldValue) return false;

    switch (operator) {
    case 'contains':
      return fieldValue.toLowerCase().includes(value.toLowerCase());
    case 'equals':
      return fieldValue.toLowerCase() === value.toLowerCase();
    case 'startsWith':
      return fieldValue.toLowerCase().startsWith(value.toLowerCase());
    case 'endsWith':
      return fieldValue.toLowerCase().endsWith(value.toLowerCase());
    default:
      return false;
    }
  }
}

export default new LlmConfigService();

