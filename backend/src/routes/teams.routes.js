/**
 * Teams notifications routes (plans/TEAMS_NOTIFICATIONS_PLAN.md).
 *
 *  - teamsBotRouter  (public, before requireAuth): POST /api/teams/messages —
 *    the Azure Bot messaging endpoint. Every request carries a Bot Framework
 *    JWT that is verified before anything is read.
 *  - teamsAdminRouter (workspace admins): status, workspace settings, install.
 * The agent's own endpoints live in agent.routes.js (/api/agent/teams…).
 */
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import logger from '../utils/logger.js';
import bot from '../integrations/teamsBotClient.js';
import teamsNotificationService from '../services/teamsNotificationService.js';

export const teamsBotRouter = express.Router();

teamsBotRouter.post('/messages', async (req, res) => {
  if (!bot.isTeamsConfigured()) return res.status(503).json({ error: 'Teams bot is not configured' });
  const activity = req.body || {};
  try {
    await bot.verifyInbound(req.headers.authorization, activity);
  } catch (err) {
    logger.warn(`Teams bot request refused: ${err.message}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body = await teamsNotificationService.handleActivity(activity);
    return res.status(200).json(body || {});
  } catch (err) {
    logger.warn(`Teams bot activity ${activity.type}/${activity.name || ''} failed: ${err.message}`);
    // An invoke must still get an answer, or Teams shows a generic error.
    if (activity.type === 'invoke') {
      return res.status(200).json({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Ticket Pulse could not do that right now.' });
    }
    return res.status(200).json({});
  }
});

export const teamsAdminRouter = express.Router();
teamsAdminRouter.use(requireAdmin);

teamsAdminRouter.get('/status', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await teamsNotificationService.adminStatus(req.workspaceId) });
}));

teamsAdminRouter.put('/settings', asyncHandler(async (req, res) => {
  const email = (req.session?.user ?? req.user)?.email || null;
  const settings = await teamsNotificationService.saveWorkspaceSettings(req.workspaceId, req.body || {}, email);
  res.json({ success: true, data: settings });
}));

teamsAdminRouter.post('/install', asyncHandler(async (req, res) => {
  const result = await teamsNotificationService.installForAgents(req.workspaceId, req.body?.technicianIds || null);
  res.json({ success: true, data: result });
}));

export default { teamsBotRouter, teamsAdminRouter };
