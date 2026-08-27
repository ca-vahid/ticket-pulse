import express from 'express';
import authRoutes from './auth.routes.js';
import workspaceRoutes from './workspace.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import settingsRoutes from './settings.routes.js';
import syncRoutes from './sync.routes.js';
import sseRoutes from './sse.routes.js';
import photosRoutes from './photos.routes.js';
import webhookRoutes from './webhook.routes.js';
import freshserviceWebhookRoutes from './freshserviceWebhook.routes.js';
import autoresponseRoutes from './autoresponse.routes.js';
import llmAdminRoutes from './llmAdmin.routes.js';
import aiUsageRoutes from './aiUsage.routes.js';
import visualsRoutes from './visuals.routes.js';
import noiseRoutes from './noise.routes.js';
import vacationTrackerRoutes from './vacationTracker.routes.js';
import calendarLeaveRoutes from './calendarLeave.routes.js';
import notificationsRoutes from './notifications.routes.js';
import notificationWorkflowRoutes from './notificationWorkflow.routes.js';
import assignmentRoutes from './assignment.routes.js';
import aiProviderRoutes from './aiProvider.routes.js';
import analyticsRoutes from './analytics.routes.js';
import summitRoutes, { summitPublicRouter } from './summit.routes.js';
import { publicTicketStatusPublicRouter } from './publicTicketStatus.routes.js';
import agentRoutes from './agent.routes.js';
import ticketsRoutes, { ticketApprovalPublicRouter } from './tickets.routes.js';
import statusesRoutes from './statuses.routes.js';
import searchRoutes from './search.routes.js';
import apiV1Routes from './apiV1.routes.js';
import backupRoutes from './backup.routes.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { requireAdmin, requireAuth, requireWorkspaceAccess, requireWorkspaceMemberOrAgent } from '../middleware/auth.js';

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

// FreshService v2 ticket-ingest webhook: per-workspace secret auth, NOT
// session/JWT auth. Must stay before requireAuth for FreshService delivery.
router.use('/freshservice-webhooks', freshserviceWebhookRoutes);

// Temporary IT Summit voting links intentionally bypass app auth but require
// an expiring workshop token.
router.use('/summit/public', summitPublicRouter);

// Public requester-facing ticket status pages bypass app auth but require the
// per-ticket bearer token in the URL.
router.use('/ticket-status/public', publicTicketStatusPublicRouter);

// Approval magic links bypass app auth — the per-approval token is the credential.
router.use('/ticket-approvals/public', ticketApprovalPublicRouter);

// Public integration API: its own key auth (Authorization: Bearer tpk_…),
// workspace scoping comes from the key. Must stay before requireAuth.
router.use('/v1', apiV1Routes);

// Promote JWT from query param for SSE requests (EventSource can't set headers).
// Must run before requireAuth so the token is available for authentication.
router.use((req, _res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// All routes below require authentication, a workspace, and access to it.
// requireAuth MUST run first so the identity (req.session.user for cookie
// sessions, req.user for Bearer JWTs) is populated before the access gates
// check the user's email against the DB.
router.use(requireAuth);
router.use('/agent', agentRoutes);
// Native ticketing: mounted before global workspace-access enforcement because
// agent-role users (no workspace_access rows) are first-class here — the router
// applies requireWorkspace + its own access resolution internally.
router.use('/tickets', ticketsRoutes);
// Multi-entity search (command palette): same access model as /tickets —
// agent-role users (no workspace_access rows) search too, so the router
// applies requireWorkspace + its own membership resolution internally.
router.use('/search', searchRoutes);
// Settings has both global app configuration and a few workspace-specific
// helpers. Mount it before global workspace enforcement so one-time global
// settings are not blocked by a stale selected workspace.
router.use('/settings', settingsRoutes);
// Cross-workspace AI usage/cost report: super-admin gated inside the router,
// deliberately NOT behind workspace enforcement (it spans all workspaces).
router.use('/ai-usage', aiUsageRoutes);
// SSE live events: agent-allowed READ tier (Mega 08-15 Phase A1). Global
// 'agent' users (no workspace_access rows) work the ticket queue, so their
// live updates must not 401/403 — active-technician membership grants access,
// same model as /tickets and /search above. Mounted before the strict
// requireWorkspaceAccess gate; everything below it stays members-only.
router.use('/sse', requireWorkspace, requireWorkspaceMemberOrAgent, sseRoutes);
router.use(requireWorkspace);
router.use(requireWorkspaceAccess);

// Mount route modules (individual route files no longer need requireAuth)
//
// ROLE MODEL (QA 08-24 #3, v3.7.02): viewers and reviewers are ticket-surface
// users — Tickets + Approvals (+ the reviewer-tier AI decide/override path in
// assignment.routes). Dashboard, Analytics, Agent Maps and the Summit
// workshop are workspace-admin only, the same as "No access" for everyone
// else. `/sse` stays ABOVE these gates on purpose — viewers need live queue
// updates. Global admins pass requireAdmin without a DB lookup.
router.use('/dashboard', requireAdmin, dashboardRoutes);
// Ticket-status registry (Phase 8a): Settings CRUD, admin-gated in the router.
router.use('/ticket-statuses', statusesRoutes);
router.use('/sync', syncRoutes);
router.use('/photos', photosRoutes);
router.use('/autoresponse', autoresponseRoutes);
router.use('/admin/llm-settings', llmAdminRoutes);
router.use('/visuals', requireAdmin, visualsRoutes);
router.use('/noise-rules', noiseRoutes);
router.use('/vacation-tracker', vacationTrackerRoutes);
router.use('/calendar-leave', calendarLeaveRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/notification-workflows', notificationWorkflowRoutes);
router.use('/ai-providers', aiProviderRoutes);
router.use('/assignment', assignmentRoutes);
router.use('/analytics', requireAdmin, analyticsRoutes);
router.use('/summit', requireAdmin, summitRoutes);
router.use('/backup', backupRoutes);

export default router;
