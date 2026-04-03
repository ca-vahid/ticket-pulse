import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import * as llmAdminController from '../controllers/llmAdmin.controller.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireWorkspace);

// Read-only endpoints — any authenticated user
router.get('/config', asyncHandler(llmAdminController.getConfig));
router.get('/defaults', asyncHandler(llmAdminController.getDefaults));
router.get('/history', asyncHandler(llmAdminController.getHistory));

// Mutation endpoints — admin only
router.put('/prompts', requireAdmin, asyncHandler(llmAdminController.updatePrompts));
router.put('/templates', requireAdmin, asyncHandler(llmAdminController.updateTemplates));
router.put('/eta-rules', requireAdmin, asyncHandler(llmAdminController.updateEtaRules));
router.put('/overrides', requireAdmin, asyncHandler(llmAdminController.updateOverrides));
router.put('/runtime', requireAdmin, asyncHandler(llmAdminController.updateRuntimeSettings));
router.post('/publish', requireAdmin, asyncHandler(llmAdminController.publishConfig));
router.post('/reset', requireAdmin, asyncHandler(llmAdminController.resetToDefaults));
router.post('/revert', requireAdmin, asyncHandler(llmAdminController.revertToVersion));
router.post('/validate', requireAdmin, asyncHandler(llmAdminController.validatePlaceholders));
router.post('/preview', requireAdmin, asyncHandler(llmAdminController.previewPrompt));

export default router;

