import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import * as llmAdminController from '../controllers/llmAdmin.controller.js';

const router = express.Router();

// Protect all routes with authentication
router.use(requireAuth);

/**
 * Configuration management
 */
router.get('/config', asyncHandler(llmAdminController.getConfig));
router.get('/defaults', asyncHandler(llmAdminController.getDefaults));

/**
 * Update specific sections
 */
router.put('/prompts', asyncHandler(llmAdminController.updatePrompts));
router.put('/templates', asyncHandler(llmAdminController.updateTemplates));
router.put('/eta-rules', asyncHandler(llmAdminController.updateEtaRules));
router.put('/overrides', asyncHandler(llmAdminController.updateOverrides));
router.put('/runtime', asyncHandler(llmAdminController.updateRuntimeSettings));

/**
 * Publishing and versioning
 */
router.post('/publish', asyncHandler(llmAdminController.publishConfig));
router.post('/reset', asyncHandler(llmAdminController.resetToDefaults));
router.get('/history', asyncHandler(llmAdminController.getHistory));
router.post('/revert', asyncHandler(llmAdminController.revertToVersion));

/**
 * Validation and preview
 */
router.post('/validate', asyncHandler(llmAdminController.validatePlaceholders));
router.post('/preview', asyncHandler(llmAdminController.previewPrompt));

export default router;

