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
import teamsAssistantSettings from '../services/teamsAssistantSettings.js';
import prisma from '../services/prisma.js';

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

// QA 10-01 #4: disconnect named agents (removes the app, stops every send).
teamsAdminRouter.post('/disconnect', asyncHandler(async (req, res) => {
  const ids = req.body?.technicianIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: 'technicianIds is required' });
  }
  const email = (req.session?.user ?? req.user)?.email || null;
  const result = await teamsNotificationService.disconnectAgents(req.workspaceId, ids, email);
  return res.json({ success: true, data: result });
}));

// Ask Ticket Pulse in Teams (plans/TEAMS_BOT_COMMANDS_PLAN.md): the
// workspace's mode, pilot people, monthly AI limit and sensitive switch.
async function assistantPeople(workspaceId) {
  const ws = Number(workspaceId);
  const [techs, access] = await Promise.all([
    prisma.technician.findMany({ where: { workspaceId: ws, isActive: true, email: { not: null } }, select: { name: true, email: true }, orderBy: { name: 'asc' }, take: 1000 }).catch(() => []),
    prisma.workspaceAccess.findMany({ where: { workspaceId: ws }, select: { email: true }, take: 1000 }).catch(() => []),
  ]);
  const byEmail = new Map();
  for (const t of techs) if (t.email) byEmail.set(t.email.toLowerCase(), { email: t.email.toLowerCase(), name: t.name || t.email });
  const missing = access.map((a) => String(a.email || '').toLowerCase()).filter((e) => e && !byEmail.has(e));
  if (missing.length) {
    const people = await prisma.avPerson.findMany({ where: { email: { in: missing } }, select: { email: true, name: true } }).catch(() => []);
    const nameOf = new Map(people.map((p) => [p.email, p.name]));
    for (const e of missing) byEmail.set(e, { email: e, name: nameOf.get(e) || e });
  }
  return [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function isSuperAdmin(req) {
  const email = String((req.session?.user ?? req.user)?.email || '').toLowerCase();
  if (!email) return false;
  const { getAdminEmails } = await import('./auth.routes.js');
  return (await getAdminEmails()).includes(email);
}

teamsAdminRouter.get('/assistant', asyncHandler(async (req, res) => {
  const settings = await teamsAssistantSettings.get(req.workspaceId);
  const [cap, people, superAdmin] = await Promise.all([
    teamsAssistantSettings.capState(req.workspaceId, settings),
    assistantPeople(req.workspaceId),
    isSuperAdmin(req),
  ]);
  res.json({ success: true, data: { settings, spend: { spentUsd: cap.spentUsd, capUsd: cap.capUsd, unknown: cap.unknown === true }, people, canSeeActivity: superAdmin } });
}));

teamsAdminRouter.put('/assistant', asyncHandler(async (req, res) => {
  const email = (req.session?.user ?? req.user)?.email || null;
  const body = req.body || {};
  const settings = await teamsAssistantSettings.save(req.workspaceId, {
    mode: body.mode, pilotEmails: body.pilotEmails, monthlyCapUsd: body.monthlyCapUsd, sensitive: body.sensitive,
  }, email);
  res.json({ success: true, data: settings });
}));

// The Shadow log: questions and outcomes only (never tool results), super admins only.
teamsAdminRouter.get('/assistant/turns', asyncHandler(async (req, res) => {
  if (!(await isSuperAdmin(req))) return res.status(403).json({ success: false, message: 'Only super admins can read the assistant activity' });
  return res.json({ success: true, data: await teamsAssistantSettings.recentTurns(req.workspaceId, { take: req.query.take }) });
}));

export default { teamsBotRouter, teamsAdminRouter };
