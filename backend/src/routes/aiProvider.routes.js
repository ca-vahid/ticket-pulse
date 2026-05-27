import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import providerSettingsService from '../services/aiProviders/providerSettingsService.js';
import providerHealthService from '../services/aiProviders/providerHealthService.js';
import anthropicProvider from '../services/aiProviders/anthropicProvider.js';
import openAiProvider from '../services/aiProviders/openAiProvider.js';
import { classifyProviderError } from '../services/aiProviders/errorClassification.js';
import {
  AI_OPERATIONS,
  getModelMetadata,
  normalizeAiModel,
  normalizeProvider,
} from '../utils/aiProviders.js';

const router = express.Router();
const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openAiProvider,
};

function providerClient(provider) {
  const normalized = normalizeProvider(provider);
  const client = PROVIDERS[normalized];
  if (!client) throw new Error(`Unsupported provider: ${provider}`);
  return { provider: normalized, client };
}

function isToolOperation(operation) {
  return [
    'assignment_pipeline',
    'competency_analysis',
    'daily_review',
    'daily_review_consolidation',
  ].includes(operation);
}

router.get('/models', requireReviewer, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: providerSettingsService.getModels({
      provider: req.query.provider || null,
      operation: req.query.operation || null,
    }),
  });
}));

router.get('/settings', requireReviewer, asyncHandler(async (req, res) => {
  const settings = await providerSettingsService.listSettings(req.workspaceId);
  res.json({ success: true, data: settings });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const actorEmail = req.session?.user?.email || 'admin';
  const settings = await providerSettingsService.upsertSettings(
    req.workspaceId,
    req.body?.settings || req.body,
    actorEmail,
  );
  res.json({ success: true, data: settings });
}));

router.get('/health', requireReviewer, asyncHandler(async (req, res) => {
  const operation = AI_OPERATIONS.includes(req.query.operation) ? req.query.operation : null;
  const statuses = await providerHealthService.getStatuses({
    workspaceId: req.workspaceId,
    operation,
  });
  res.json({ success: true, data: statuses });
}));

router.post('/test', requireAdmin, asyncHandler(async (req, res) => {
  const operation = AI_OPERATIONS.includes(req.body?.operation)
    ? req.body.operation
    : 'assignment_pipeline';
  const { provider, client } = providerClient(req.body?.provider || 'anthropic');
  const model = normalizeAiModel(req.body?.model, provider, null, operation);
  const startedAt = Date.now();

  try {
    let result;
    if (isToolOperation(operation)) {
      result = await client.toolResponse({
        systemPrompt: 'You are testing Ticket Pulse provider connectivity. Use the provided tool once.',
        messages: [{ role: 'user', content: 'Call echo_test with value "ok".' }],
        tools: [{
          name: 'echo_test',
          description: 'Connectivity test tool.',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        }],
        model,
        maxTokens: 300,
      });
    } else {
      result = await client.sendJson({
        systemPrompt: 'Return only JSON for a Ticket Pulse provider connectivity test.',
        userMessage: '{"test":"provider","expected":"ok"}',
        model,
        maxTokens: 200,
        temperature: 0,
      });
    }

    const durationMs = Date.now() - startedAt;
    await providerHealthService.recordSuccess({
      workspaceId: req.workspaceId,
      operation,
      provider,
      model,
      durationMs,
    });
    res.json({
      success: true,
      data: {
        provider,
        model,
        operation,
        durationMs,
        configured: client.isConfigured(),
        usage: result.usage || null,
        toolCalled: result.message?.content?.some((block) => block.type === 'tool_use') || false,
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await providerHealthService.recordFailure({
      workspaceId: req.workspaceId,
      operation,
      provider,
      model,
      error,
      durationMs,
    });
    const classified = classifyProviderError(error);
    res.status(502).json({
      success: false,
      message: classified.message,
      data: {
        provider,
        model,
        operation,
        durationMs,
        errorClass: classified.errorClass,
        retryable: classified.retryable,
      },
    });
  }
}));

router.get('/metadata', requireReviewer, asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { operations: AI_OPERATIONS, models: getModelMetadata() } });
}));

export default router;
