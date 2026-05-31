import prisma from '../prisma.js';
import {
  AI_OPERATIONS,
  AI_PROVIDERS,
  getDefaultProviderSetting,
  getModelMetadata,
  normalizeAiModel,
  normalizeProvider,
  supportsOperation,
} from '../../utils/aiProviders.js';

function sanitizeSettingInput(input = {}) {
  const operation = AI_OPERATIONS.includes(input.operation) ? input.operation : 'assignment_pipeline';
  const primaryProvider = normalizeProvider(input.primaryProvider);
  const primaryModel = normalizeAiModel(input.primaryModel, primaryProvider, null, operation);
  const fallbackProvider = input.fallbackProvider
    ? normalizeProvider(input.fallbackProvider)
    : (primaryProvider === 'anthropic' ? 'openai' : 'anthropic');
  const fallbackModel = input.fallbackModel
    ? normalizeAiModel(input.fallbackModel, fallbackProvider, null, operation)
    : null;

  if (!supportsOperation(primaryModel, primaryProvider, operation)) {
    throw new Error(`Model ${primaryModel} does not support ${operation}`);
  }
  if (fallbackModel && !supportsOperation(fallbackModel, fallbackProvider, operation)) {
    throw new Error(`Fallback model ${fallbackModel} does not support ${operation}`);
  }

  return {
    operation,
    primaryProvider,
    primaryModel,
    fallbackProvider,
    fallbackModel,
    autoFallbackEnabled: input.autoFallbackEnabled !== false,
    fallbackMode: input.fallbackMode || 'retry_safe_checkpoint',
  };
}

class ProviderSettingsService {
  getModels(params = {}) {
    return {
      providers: AI_PROVIDERS,
      operations: AI_OPERATIONS,
      models: getModelMetadata(params),
    };
  }

  async ensureDefaults(workspaceId, legacyModels = null) {
    const existing = await prisma.aiProviderSetting.findMany({ where: { workspaceId } });
    const existingOperations = new Set(existing.map((setting) => setting.operation));
    const missing = AI_OPERATIONS.filter((operation) => !existingOperations.has(operation));
    if (missing.length > 0) {
      await prisma.aiProviderSetting.createMany({
        data: missing.map((operation) => {
          const legacyModel = typeof legacyModels === 'string'
            ? legacyModels
            : legacyModels?.[operation];
          return {
            workspaceId,
            ...getDefaultProviderSetting(operation, legacyModel),
          };
        }),
        skipDuplicates: true,
      });
    }
    return prisma.aiProviderSetting.findMany({
      where: { workspaceId },
      orderBy: { operation: 'asc' },
    });
  }

  async listSettings(workspaceId) {
    const [assignmentConfig, llmConfig] = await Promise.all([
      prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: { llmModel: true },
      }).catch(() => null),
      prisma.llmConfig.findFirst({
        where: { workspaceId, status: 'published' },
        orderBy: { version: 'desc' },
        select: { model: true },
      }).catch(() => null),
    ]);
    return this.ensureDefaults(workspaceId, {
      assignment_pipeline: assignmentConfig?.llmModel,
      competency_analysis: assignmentConfig?.llmModel,
      daily_review: assignmentConfig?.llmModel,
      autoresponse_classification: llmConfig?.model,
      autoresponse_generation: llmConfig?.model,
      notification_workflow_generation: llmConfig?.model,
    });
  }

  async getSetting(workspaceId, operation, legacyModel = null) {
    if (!AI_OPERATIONS.includes(operation)) {
      throw new Error(`Unsupported AI operation: ${operation}`);
    }
    let setting = await prisma.aiProviderSetting.findUnique({
      where: { workspaceId_operation: { workspaceId, operation } },
    });
    if (!setting) {
      const defaults = getDefaultProviderSetting(operation, legacyModel);
      setting = await prisma.aiProviderSetting.create({
        data: { workspaceId, ...defaults },
      });
    }
    return setting;
  }

  async upsertSettings(workspaceId, settings, actorEmail = null) {
    const rows = Array.isArray(settings) ? settings : [settings];
    const results = [];
    for (const row of rows) {
      const sanitized = sanitizeSettingInput(row);
      const saved = await prisma.aiProviderSetting.upsert({
        where: { workspaceId_operation: { workspaceId, operation: sanitized.operation } },
        create: {
          workspaceId,
          ...sanitized,
          lastChangedBy: actorEmail,
        },
        update: {
          ...sanitized,
          lastChangedBy: actorEmail,
        },
      });
      results.push(saved);
    }
    return results;
  }
}

export default new ProviderSettingsService();
export { ProviderSettingsService, sanitizeSettingInput };
