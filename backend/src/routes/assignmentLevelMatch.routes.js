import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Level match (26 Oct 2026). Mounted at /api/assignment-level-match behind
 * requireAuth + requireWorkspace.
 *
 *   GET  /            reviewers — the mode and what the rule did (7 / 14 / 30 days)
 *   PUT  /settings    admins    — { mode: 'off' | 'shadow' | 'live' }
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const service = async () => (await import('../services/assignmentLevelMatch/levelMatchService.js')).default;

/** The same rule as requireAdmin, asked quietly: the page uses it to show the switch. Never throws. */
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
  const levelMatch = await service();
  const data = await levelMatch.results(req.workspaceId, { days: Number(req.query.days) || 14 });
  res.json({ success: true, data: { ...data, canManage: await canManage(req) } });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const mode = req.body?.mode;
  if (mode === undefined) throw new ValidationError('Nothing to change.');
  const user = sessionUser(req) || {};
  const levelMatch = await service();
  const out = await levelMatch.saveSettings(req.workspaceId, { mode }, { by: user.name || user.email || null });
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes } });
}));

export default router;
