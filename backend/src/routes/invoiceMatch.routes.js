import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Invoice-number matching for mail (24 Nov 2026, services/invoiceMatchService.js).
 * Mounted at /api/mail-triage behind requireAuth + requireWorkspace +
 * requireWorkspaceAccess. Workspace admins only; read-only except the switch.
 *
 *   GET /invoice-match/shadow?days=7   what Shadow recorded (1–30 days) and what actually happened
 *   GET /invoice-match/settings        { mode }
 *   PUT /invoice-match/settings        { mode: 'off' | 'shadow' | 'live' } (app setting invoice_match_ws<N>)
 */
const router = express.Router();

const service = async () => import('../services/invoiceMatchService.js');
const sessionUser = (req) => req.session?.user ?? req.user ?? null;

router.get('/invoice-match/shadow', requireAdmin, asyncHandler(async (req, res) => {
  const { shadowReport } = await service();
  const data = await shadowReport(req.workspaceId, { days: Number(req.query.days) || 7, limit: Number(req.query.limit) || 500 });
  res.json({ success: true, data });
}));

router.get('/invoice-match/settings', requireAdmin, asyncHandler(async (req, res) => {
  const { getMode, settingsKey } = await service();
  res.json({ success: true, data: { mode: await getMode(req.workspaceId, { fresh: true }), key: settingsKey(req.workspaceId) } });
}));

router.put('/invoice-match/settings', requireAdmin, asyncHandler(async (req, res) => {
  const { MODES, setMode, settingsKey } = await service();
  const mode = String(req.body?.mode ?? '').trim().toLowerCase();
  if (!MODES.includes(mode)) throw new ValidationError('Pick Off, Shadow or Live');
  await setMode(req.workspaceId, mode);
  const user = sessionUser(req) || {};
  logger.info(`Invoice match for workspace ${req.workspaceId} set to ${mode} by ${user.email || user.name || 'unknown'}`);
  res.json({ success: true, data: { mode, key: settingsKey(req.workspaceId) } });
}));

export default router;
