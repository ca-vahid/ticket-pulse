import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import calendarLeaveService from '../services/calendarLeaveService.js';

const router = express.Router();

router.get('/config', asyncHandler(async (req, res) => {
  const config = await calendarLeaveService.getConfig(req.workspaceId);
  res.json({ success: true, data: config });
}));

router.put('/config', requireAdmin, asyncHandler(async (req, res) => {
  const data = {
    mailbox: req.body.mailbox,
    graphGroupId: req.body.graphGroupId,
    timezone: req.body.timezone,
    syncEnabled: req.body.syncEnabled,
    lookbackDays: req.body.lookbackDays !== undefined ? parseInt(req.body.lookbackDays, 10) : undefined,
    horizonDays: req.body.horizonDays !== undefined ? parseInt(req.body.horizonDays, 10) : undefined,
  };
  if (!data.mailbox || !data.graphGroupId) {
    return res.status(400).json({ success: false, message: 'mailbox and graphGroupId are required' });
  }
  const config = await calendarLeaveService.upsertConfig(req.workspaceId, data);
  await calendarLeaveService.seedDefaults(req.workspaceId);
  res.json({ success: true, data: config });
}));

router.post('/seed-defaults', requireAdmin, asyncHandler(async (req, res) => {
  await calendarLeaveService.seedDefaults(req.workspaceId);
  const [rules, aliases] = await Promise.all([
    calendarLeaveService.getRules(req.workspaceId),
    calendarLeaveService.getAliases(req.workspaceId),
  ]);
  res.json({ success: true, data: { rules, aliases } });
}));

router.get('/rules', asyncHandler(async (req, res) => {
  const rules = await calendarLeaveService.getRules(req.workspaceId);
  res.json({ success: true, data: rules });
}));

router.post('/rules', requireAdmin, asyncHandler(async (req, res) => {
  const rule = await calendarLeaveService.upsertRule(req.workspaceId, req.body);
  res.json({ success: true, data: rule });
}));

router.put('/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  const rule = await calendarLeaveService.upsertRule(req.workspaceId, { ...req.body, id: parseInt(req.params.id, 10) });
  res.json({ success: true, data: rule });
}));

router.delete('/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await calendarLeaveService.deleteRule(req.workspaceId, parseInt(req.params.id, 10));
  res.json({ success: true, data: result });
}));

router.get('/aliases', asyncHandler(async (req, res) => {
  const aliases = await calendarLeaveService.getAliases(req.workspaceId);
  res.json({ success: true, data: aliases });
}));

router.get('/review', asyncHandler(async (req, res) => {
  const rows = await calendarLeaveService.getReviewRows(req.workspaceId, {
    status: req.query.status || 'review',
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 200,
  });
  res.json({ success: true, data: rows });
}));

router.post('/aliases', requireAdmin, asyncHandler(async (req, res) => {
  const alias = await calendarLeaveService.upsertAlias(req.workspaceId, req.body);
  res.json({ success: true, data: alias });
}));

router.delete('/aliases/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await calendarLeaveService.deleteAlias(req.workspaceId, parseInt(req.params.id, 10));
  res.json({ success: true, data: result });
}));

router.post('/review-decision', requireAdmin, asyncHandler(async (req, res) => {
  const result = await calendarLeaveService.saveManualDecision(req.workspaceId, req.body);
  res.json({ success: true, data: result });
}));

router.post('/preview', requireAdmin, asyncHandler(async (req, res) => {
  const result = await calendarLeaveService.preview(req.workspaceId, {
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    useLlm: req.body.useLlm === true,
    top: req.body.top ? parseInt(req.body.top, 10) : 200,
    llmLimit: req.body.llmLimit !== undefined ? parseInt(req.body.llmLimit, 10) : null,
  });
  res.json({ success: true, data: result });
}));

router.post('/sync', requireAdmin, asyncHandler(async (req, res) => {
  const result = await calendarLeaveService.sync(req.workspaceId, {
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    useLlm: req.body.useLlm !== false,
  });
  res.json({ success: true, data: result });
}));

export default router;
