import express from 'express';
import authRoutes from './auth.routes.js';
import workspaceRoutes from './workspace.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import settingsRoutes from './settings.routes.js';
import syncRoutes from './sync.routes.js';
import sseRoutes from './sse.routes.js';
import photosRoutes from './photos.routes.js';
import webhookRoutes from './webhook.routes.js';
import autoresponseRoutes from './autoresponse.routes.js';
import llmAdminRoutes from './llmAdmin.routes.js';
import visualsRoutes from './visuals.routes.js';
import noiseRoutes from './noise.routes.js';
import vacationTrackerRoutes from './vacationTracker.routes.js';
import { requireWorkspace } from '../middleware/workspace.js';

const router = express.Router();

// Health check endpoint (no auth required)
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
  });
});

// Auth & workspace selection (exempt from workspace requirement)
router.use('/auth', authRoutes);
router.use('/workspaces', workspaceRoutes);

// Workspace resolution middleware — all routes below require a workspace
router.use(requireWorkspace);

// Mount route modules
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/sync', syncRoutes);
router.use('/sse', sseRoutes);
router.use('/photos', photosRoutes);
router.use('/webhook', webhookRoutes);
router.use('/autoresponse', autoresponseRoutes);
router.use('/admin/llm-settings', llmAdminRoutes);
router.use('/visuals', visualsRoutes);
router.use('/noise-rules', noiseRoutes);
router.use('/vacation-tracker', vacationTrackerRoutes);

export default router;
