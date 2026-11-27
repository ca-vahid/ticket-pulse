import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import { ConflictError, ValidationError } from '../utils/errors.js';
import { MODES, PERIODS, RULE_FIELDS, SETTING_FIELDS } from '../services/assignmentShares/rules.js';

/**
 * Ticket shares (QA 10-16 item 4; rules per category QA 11-26 #3–6). Mounted
 * at /api/assignment-shares behind requireAuth + requireWorkspace.
 *
 *   GET  /?days=&ruleId=  reviewers — settings (all rules), people, categories, internal groups, and for
 *                          one rule (default the first) the preview and the report (7 / 14 / 30 days)
 *   POST /preview         reviewers — "the next 10 tickets would go to …" for a rule draft not saved yet
 *                          (body: the rule's fields + ruleId; 'new' = a rule not saved yet)
 *   PUT  /settings        admins    — `{ rule }` adds (no id) or changes a rule, `{ removeRuleId }` removes one;
 *                          the v1 body `{ mode, period, categoryIds, members }` still changes the first rule
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

const pick = (body, fields) => {
  const out = {};
  for (const field of fields) if (body?.[field] !== undefined) out[field] = body[field];
  return out;
};
const RULE_ID = /^(r\d{1,6}|new)$/;
const ruleIdOf = (v) => (typeof v === 'string' && RULE_ID.test(v) ? v : null);

router.get('/', requireReviewer, asyncHandler(async (req, res) => {
  const shares = await service();
  const ruleId = ruleIdOf(req.query.ruleId);
  const [report, options, preview, manage] = await Promise.all([
    shares.results(req.workspaceId, { days: Number(req.query.days) || 14, ruleId }),
    shares.options(req.workspaceId),
    shares.preview(req.workspaceId, null, { ruleId }),
    canManage(req),
  ]);
  res.json({ success: true, data: { ...report, ...options, preview, modes: MODES, periods: PERIODS, canManage: manage } });
}));

router.post('/preview', requireReviewer, asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const shares = await service();
  const preview = await shares.preview(req.workspaceId, pick(body, RULE_FIELDS), { ruleId: ruleIdOf(body.ruleId) });
  res.json({ success: true, data: preview });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let patch;
  if (body.removeRuleId !== undefined) {
    if (!ruleIdOf(body.removeRuleId)) throw new ValidationError('That rule could not be read.');
    patch = { removeRuleId: body.removeRuleId };
  } else if (body.rule && typeof body.rule === 'object' && !Array.isArray(body.rule)) {
    const id = ruleIdOf(body.rule.id);
    if (body.rule.id !== undefined && body.rule.id !== null && !id) throw new ValidationError('That rule could not be read.');
    patch = { rule: { ...pick(body.rule, RULE_FIELDS), ...(id && id !== 'new' ? { id } : {}) } };
  } else {
    patch = pick(body, SETTING_FIELDS);
    if (!Object.keys(patch).length) throw new ValidationError('Nothing to change.');
  }
  const user = sessionUser(req) || {};
  const shares = await service();
  // The settings' updatedAt the page loaded (null = never saved); an older page sends none.
  const expected = Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt')
    ? (typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null)
    : undefined;
  const out = await shares.saveSettings(req.workspaceId, patch, { by: user.name || user.email || null, expectedUpdatedAt: expected });
  if (out.conflict) throw new ConflictError(`${out.errors[0]}.`);
  if (out.errors.length) throw new ValidationError(out.errors.join('. '));
  res.json({ success: true, data: { settings: out.settings, changes: out.changes, ruleId: out.ruleId } });
}));

export default router;
