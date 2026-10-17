import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import { MODES, PERIODS, SETTING_FIELDS } from '../services/assignmentShares/rules.js';

/**
 * Ticket shares (QA 10-16 item 4, proof of concept). Mounted at
 * /api/assignment-shares behind requireAuth + requireWorkspace.
 *
 *   GET  /            reviewers — settings, people, categories, the preview and the Shadow report (7 / 14 / 30 days)
 *   POST /preview     reviewers — "the next 10 tickets would go to …" for a draft that is not saved yet
 *   PUT  /settings    admins    — change the shares for this workspace
 *
 * The service is imported lazily so this router loads without the pipeline graph.
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const service = async () => (await import('../services/assignmentShares/sharesService.js')).default;

/** The same rule as requireAdmin, asked quietly: the page uses it to show the editor. Never throws. */
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

const pickDraft = (body) => {
  const out = {};
  for (const field of SETTING_FIELDS) if (body[field] !== undefined) out[field] = body[field];
  return out;
};

router.get('/', requireReviewer, asyncHandler(async (req, res) => {
  const shares = await service();
  const [report, options, preview, manage] = await Promise.all([
    shares.results(req.workspaceId, { days: Number(req.query.days) || 14 }),
    shares.options(req.workspaceId),
    shares.preview(req.workspaceId),
    canManage(req),
  ]);
  res.json({ success: true, data: { ...report, ...options, preview, modes: MODES, periods: PERIODS, canManage: manage } });
}));

router.post('/preview', requireReviewer, asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const shares = await service();
  const preview = await shares.preview(req.workspaceId, pickDraft(body));
  res.json({ success: true, data: preview });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = pickDraft(body);
  if (!Object.keys(patch).length) throw new ValidationError('Nothing to change.');
  const user = sessionUser(req) || {};
  const shares = await service();
  const out = await shares.saveSettings(req.workspaceId, patch, { by: user.name || user.email || null });
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes } });
}));

export default router;
