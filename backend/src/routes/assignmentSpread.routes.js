import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import { LIMITS, SETTING_FIELDS } from '../services/assignmentSpread/rules.js';

/**
 * Assignment spread (QA 10-13 item 17). Mounted at /api/assignment-spread
 * behind requireAuth + requireWorkspace.
 *
 *   GET  /            reviewers — the settings and how the rules have worked (7 / 14 / 30 days)
 *   PUT  /settings    admins    — change the rules for this workspace
 *
 * The service is imported lazily so this router loads without the pipeline graph.
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const service = async () => (await import('../services/assignmentSpread/spreadService.js')).default;

/** The same rule as requireAdmin, asked quietly: the page uses it to show the switches. Never throws. */
async function canManage(req) {
  try {
    const user = sessionUser(req);
    if (user?.role === 'admin') return true;
    if (!user?.email || !req.workspaceId) return false;
    const { default: wsRepo } = await import('../services/workspaceRepository.js');
    return (await wsRepo.getAccessRole(user.email, req.workspaceId)) === 'admin';
  } catch {
    return false;
  }
}

router.get('/', requireReviewer, asyncHandler(async (req, res) => {
  const spread = await service();
  const data = await spread.results(req.workspaceId, { days: Number(req.query.days) || 30 });
  res.json({ success: true, data: { ...data, limits: LIMITS, canManage: await canManage(req) } });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  for (const field of SETTING_FIELDS) if (body[field] !== undefined) patch[field] = body[field];
  if (!Object.keys(patch).length) throw new ValidationError('Nothing to change.');
  const user = sessionUser(req) || {};
  const spread = await service();
  const out = await spread.saveSettings(req.workspaceId, patch, { by: user.name || user.email || null });
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes } });
}));

export default router;
