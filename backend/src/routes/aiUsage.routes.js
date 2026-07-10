import express from 'express';
import { requireGlobalAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import tokenUsageService from '../services/tokenUsageService.js';

const router = express.Router();

/**
 * AI token usage & estimated cost — SUPER ADMIN ONLY (global role, not
 * workspace admins). The report always spans all workspaces; ?workspaceId=
 * narrows the focus. Costs are estimates from list prices, reported in USD
 * and CAD (configurable rate).
 */
router.get('/', requireGlobalAdmin, asyncHandler(async (req, res) => {
  const report = await tokenUsageService.report({
    days: req.query.days,
    workspaceId: req.query.workspaceId ? Number(req.query.workspaceId) : null,
  });
  res.json({ success: true, data: report });
}));

router.put('/usd-cad-rate', requireGlobalAdmin, asyncHandler(async (req, res) => {
  const rate = await tokenUsageService.setUsdCadRate(req.body?.rate);
  res.json({ success: true, data: { usdCadRate: rate } });
}));

export default router;
