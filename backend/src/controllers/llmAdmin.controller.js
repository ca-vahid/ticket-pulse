import llmConfigService from '../services/llmConfigService.js';
import logger from '../utils/logger.js';

/**
 * LLM Admin Controller
 * Handles admin endpoints for LLM configuration management
 */

/**
 * GET /api/admin/llm-settings/config
 * Get current configuration (draft or published)
 */
export const getConfig = async (req, res) => {
  try {
    const { type = 'draft' } = req.query;

    let config;
    if (type === 'published') {
      config = await llmConfigService.getPublishedConfig();
    } else {
      config = await llmConfigService.getDraftConfig();
    }

    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.error('Error fetching LLM config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch configuration',
      error: error.message,
    });
  }
};

/**
 * GET /api/admin/llm-settings/defaults
 * Get default configuration
 */
export const getDefaults = async (req, res) => {
  try {
    const defaults = llmConfigService.getDefaults();

    res.json({
      success: true,
      data: defaults,
    });
  } catch (error) {
    logger.error('Error fetching defaults:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch defaults',
      error: error.message,
    });
  }
};

/**
 * PUT /api/admin/llm-settings/prompts
 * Update prompts (classification and response)
 */
export const updatePrompts = async (req, res) => {
  try {
    const { classificationPrompt, responsePrompt } = req.body;
    const updatedBy = req.session?.user?.name || 'admin';

    // Validate required fields
    if (!classificationPrompt || !responsePrompt) {
      return res.status(400).json({
        success: false,
        message: 'Both classificationPrompt and responsePrompt are required',
      });
    }

    const updated = await llmConfigService.updateDraft(
      { classificationPrompt, responsePrompt },
      updatedBy,
    );

    res.json({
      success: true,
      message: 'Prompts updated successfully',
      data: updated,
    });
  } catch (error) {
    logger.error('Error updating prompts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update prompts',
      error: error.message,
    });
  }
};

/**
 * PUT /api/admin/llm-settings/templates
 * Update templates (signature, fallback, tone presets)
 */
export const updateTemplates = async (req, res) => {
  try {
    const { signatureBlock, fallbackMessage, tonePresets } = req.body;
    const updatedBy = req.session?.user?.name || 'admin';

    const updates = {};
    if (signatureBlock !== undefined) updates.signatureBlock = signatureBlock;
    if (fallbackMessage !== undefined) updates.fallbackMessage = fallbackMessage;
    if (tonePresets !== undefined) updates.tonePresets = tonePresets;

    const updated = await llmConfigService.updateDraft(updates, updatedBy);

    res.json({
      success: true,
      message: 'Templates updated successfully',
      data: updated,
    });
  } catch (error) {
    logger.error('Error updating templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update templates',
      error: error.message,
    });
  }
};

/**
 * PUT /api/admin/llm-settings/eta-rules
 * Update ETA and availability rules
 */
export const updateEtaRules = async (req, res) => {
  try {
    const {
      baseResponseMinutes,
      perTicketDelayMinutes,
      afterHoursMessage,
      holidayMessage,
    } = req.body;
    const updatedBy = req.session?.user?.name || 'admin';

    const updates = {};
    if (baseResponseMinutes !== undefined) updates.baseResponseMinutes = parseInt(baseResponseMinutes);
    if (perTicketDelayMinutes !== undefined) updates.perTicketDelayMinutes = parseInt(perTicketDelayMinutes);
    if (afterHoursMessage !== undefined) updates.afterHoursMessage = afterHoursMessage;
    if (holidayMessage !== undefined) updates.holidayMessage = holidayMessage;

    const updated = await llmConfigService.updateDraft(updates, updatedBy);

    res.json({
      success: true,
      message: 'ETA rules updated successfully',
      data: updated,
    });
  } catch (error) {
    logger.error('Error updating ETA rules:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update ETA rules',
      error: error.message,
    });
  }
};

/**
 * PUT /api/admin/llm-settings/overrides
 * Update classification overrides and domain lists
 */
export const updateOverrides = async (req, res) => {
  try {
    const { overrideRules, domainWhitelist, domainBlacklist } = req.body;
    const updatedBy = req.session?.user?.name || 'admin';

    const updates = {};
    if (overrideRules !== undefined) updates.overrideRules = overrideRules;
    if (domainWhitelist !== undefined) updates.domainWhitelist = domainWhitelist;
    if (domainBlacklist !== undefined) updates.domainBlacklist = domainBlacklist;

    const updated = await llmConfigService.updateDraft(updates, updatedBy);

    res.json({
      success: true,
      message: 'Overrides updated successfully',
      data: updated,
    });
  } catch (error) {
    logger.error('Error updating overrides:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update overrides',
      error: error.message,
    });
  }
};

/**
 * PUT /api/admin/llm-settings/runtime
 * Update runtime/model parameters (model, reasoning, verbosity, token limits)
 */
export const updateRuntimeSettings = async (req, res) => {
  try {
    const { model, reasoningEffort, verbosity, maxOutputTokens } = req.body;
    const updatedBy = req.session?.user?.name || 'admin';

    const allowedModels = ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
    const allowedReasoning = ['none', 'low', 'medium', 'high'];
    const allowedVerbosity = ['low', 'medium', 'high'];

    const updates = {};

    if (model !== undefined) {
      if (!allowedModels.includes(model)) {
        return res.status(400).json({
          success: false,
          message: `Invalid model. Allowed values: ${allowedModels.join(', ')}`,
        });
      }
      updates.model = model;
    }

    if (reasoningEffort !== undefined) {
      if (!allowedReasoning.includes(reasoningEffort)) {
        return res.status(400).json({
          success: false,
          message: `Invalid reasoning effort. Allowed values: ${allowedReasoning.join(', ')}`,
        });
      }
      updates.reasoningEffort = reasoningEffort;
    }

    if (verbosity !== undefined) {
      if (!allowedVerbosity.includes(verbosity)) {
        return res.status(400).json({
          success: false,
          message: `Invalid verbosity. Allowed values: ${allowedVerbosity.join(', ')}`,
        });
      }
      updates.verbosity = verbosity;
    }

    if (maxOutputTokens !== undefined) {
      const parsed = parseInt(maxOutputTokens, 10);
      if (Number.isNaN(parsed) || parsed < 100 || parsed > 4000) {
        return res.status(400).json({
          success: false,
          message: 'maxOutputTokens must be between 100 and 4000',
        });
      }
      updates.maxOutputTokens = parsed;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No runtime settings provided',
      });
    }

    const updated = await llmConfigService.updateDraft(updates, updatedBy);

    res.json({
      success: true,
      message: 'Runtime settings updated successfully',
      data: updated,
    });
  } catch (error) {
    logger.error('Error updating runtime settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update runtime settings',
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/llm-settings/publish
 * Publish draft configuration
 */
export const publishConfig = async (req, res) => {
  try {
    const { notes } = req.body;
    const publishedBy = req.session?.user?.name || 'admin';

    const published = await llmConfigService.publishDraft(publishedBy, notes);

    res.json({
      success: true,
      message: 'Configuration published successfully',
      data: published,
    });
  } catch (error) {
    logger.error('Error publishing config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to publish configuration',
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/llm-settings/reset
 * Reset draft to defaults
 */
export const resetToDefaults = async (req, res) => {
  try {
    const resetBy = req.session?.user?.name || 'admin';

    const draft = await llmConfigService.resetDraftToDefaults(resetBy);

    res.json({
      success: true,
      message: 'Configuration reset to defaults',
      data: draft,
    });
  } catch (error) {
    logger.error('Error resetting config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset configuration',
      error: error.message,
    });
  }
};

/**
 * GET /api/admin/llm-settings/history
 * Get configuration history
 */
export const getHistory = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const history = await llmConfigService.getHistory(parseInt(limit));

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    logger.error('Error fetching history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch history',
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/llm-settings/revert
 * Revert to a specific version from history
 */
export const revertToVersion = async (req, res) => {
  try {
    const { historyId } = req.body;
    const revertedBy = req.session?.user?.name || 'admin';

    if (!historyId) {
      return res.status(400).json({
        success: false,
        message: 'historyId is required',
      });
    }

    const reverted = await llmConfigService.revertToVersion(parseInt(historyId), revertedBy);

    res.json({
      success: true,
      message: 'Configuration reverted successfully',
      data: reverted,
    });
  } catch (error) {
    logger.error('Error reverting config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to revert configuration',
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/llm-settings/validate
 * Validate placeholders in templates
 */
export const validatePlaceholders = async (req, res) => {
  try {
    const { template, requiredPlaceholders } = req.body;

    if (!template) {
      return res.status(400).json({
        success: false,
        message: 'template is required',
      });
    }

    const validation = llmConfigService.validatePlaceholders(template, requiredPlaceholders || []);

    res.json({
      success: true,
      data: validation,
    });
  } catch (error) {
    logger.error('Error validating placeholders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate placeholders',
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/llm-settings/preview
 * Preview assembled prompt with sample data
 */
export const previewPrompt = async (req, res) => {
  try {
    const { template, sampleData } = req.body;

    if (!template || !sampleData) {
      return res.status(400).json({
        success: false,
        message: 'Both template and sampleData are required',
      });
    }

    const assembled = llmConfigService.replacePlaceholders(template, sampleData);

    res.json({
      success: true,
      data: {
        assembled,
        placeholders: template.match(/\{\{(\w+)\}\}/g) || [],
      },
    });
  } catch (error) {
    logger.error('Error previewing prompt:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to preview prompt',
      error: error.message,
    });
  }
};

