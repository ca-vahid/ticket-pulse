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
 *   GET/PUT /timezone-fit        — Time-zone fit, the same shape (below)
 *   GET/PUT /followup-routing    — same-day follow-ups (QA 11-23), the same shape
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

/**
 * Time-zone fit (QA 11-17 item 1), the switch beside Level match.
 *   GET  /timezone-fit   reviewers — the mode and what the rule did lately
 *   PUT  /timezone-fit   admins    — { mode: 'off' | 'shadow' | 'live' }
 */
const timezoneFit = async () => (await import('../services/assignmentTimezoneFit/timezoneFitService.js')).default;

router.get('/timezone-fit', requireReviewer, asyncHandler(async (req, res) => {
  const fit = await timezoneFit();
  const data = await fit.results(req.workspaceId, { days: Number(req.query.days) || 14 });
  res.json({ success: true, data: { ...data, canManage: await canManage(req) } });
}));

router.put('/timezone-fit', requireAdmin, asyncHandler(async (req, res) => {
  const mode = req.body?.mode;
  if (mode === undefined) throw new ValidationError('Nothing to change.');
  const user = sessionUser(req) || {};
  const fit = await timezoneFit();
  const out = await fit.saveSettings(req.workspaceId, { mode }, { by: user.name || user.email || null });
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes } });
}));

/**
 * Same-day follow-ups (QA 11-23 items 4–5): the follow-up routing switch
 * (app_settings `followup_routing_ws<id>`), and the runs that found the same
 * requester's same problem earlier the same day (routing + priority raise).
 *   GET  /followup-routing   reviewers — { settings, days, tally, runs, canManage }
 *   PUT  /followup-routing   admins    — { mode: 'off' | 'shadow' | 'live' }
 */
const followUp = async () => (await import('../services/assignmentFollowUp/sameDayRepeatService.js')).default;

router.get('/followup-routing', requireReviewer, asyncHandler(async (req, res) => {
  const svc = await followUp();
  const data = await svc.results(req.workspaceId, { days: Number(req.query.days) || 14 });
  res.json({ success: true, data: { ...data, canManage: await canManage(req) } });
}));

router.put('/followup-routing', requireAdmin, asyncHandler(async (req, res) => {
  const mode = req.body?.mode;
  if (mode === undefined) throw new ValidationError('Nothing to change.');
  const user = sessionUser(req) || {};
  const svc = await followUp();
  const out = await svc.saveSettings(req.workspaceId, { mode }, { by: user.name || user.email || null });
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes } });
}));

export default router;
