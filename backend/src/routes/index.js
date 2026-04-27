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
import notificationsRoutes from './notifications.routes.js';
import assignmentRoutes from './assignment.routes.js';
import analyticsRoutes from './analytics.routes.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { requireAuth, requireWorkspaceAccess } from '../middleware/auth.js';

const router = express.Router();

// Redirect to the root /health endpoint (full monitoring response lives there)
router.get('/health', (req, res) => {
  res.redirect(307, '/health');
});

// Auth & workspace selection (handle their own auth internally)
router.use('/auth', authRoutes);
router.use('/workspaces', workspaceRoutes);

// External webhooks: uses shared-secret auth, NOT session/JWT auth.
// Must be mounted BEFORE requireAuth so FreshService can reach them.
router.use('/webhook', webhookRoutes);

// Promote JWT from query param for SSE requests (EventSource can't set headers).
// Must run before requireAuth so the token is available for authentication.
router.use((req, _res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// All routes below require authentication, a workspace, and access to it.
// requireAuth MUST run first so req.session.user is populated from JWT
// before requireWorkspaceAccess checks the user's email against the DB.
router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireWorkspaceAccess);

// Mount route modules (individual route files no longer need requireAuth)
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/sync', syncRoutes);
router.use('/sse', sseRoutes);
router.use('/photos', photosRoutes);
router.use('/autoresponse', autoresponseRoutes);
router.use('/admin/llm-settings', llmAdminRoutes);
router.use('/visuals', visualsRoutes);
router.use('/noise-rules', noiseRoutes);
router.use('/vacation-tracker', vacationTrackerRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/assignment', assignmentRoutes);
router.use('/analytics', analyticsRoutes);

export default router;
