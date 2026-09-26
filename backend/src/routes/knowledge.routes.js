import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthorizationError, ValidationError } from '../utils/errors.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';
import knowledgeArticleService from '../services/knowledgeArticleService.js';
import autoHelpPlaybookService, {
  DEFAULT_DISCLOSURE_TEXT, DEFAULT_FOLLOW_UP, MODE_LOCKED_MESSAGE, P0_MODE,
} from '../services/autoHelpPlaybookService.js';
import autoHelpRunner, { disclosureLine } from '../services/autoHelpRunner.js';
import { toolCatalog } from '../services/autoHelpTools.js';
import { resolveTicketRefOrThrow } from '../services/ticketRefResolver.js';

/**
 * Knowledge (Auto-help P0, plans/AUTO_HELP_PLAN.md): articles, playbooks,
 * the Auto-help waiting queue and run activity. Mounted behind requireAuth +
 * requireWorkspace + requireWorkspaceAccess, so every route is scoped to
 * req.workspaceId and reads are open to any workspace member.
 *
 * Writes (and test runs, which cost a model call) go through ONE gate:
 * canManageKnowledge. Widen it there — and only there — when category owners
 * or other roles should manage knowledge.
 */
const router = express.Router();

// Same as middleware/auth.js sessionUser(); inlined so partial auth mocks keep working.
const sessionUser = (req) => req.session?.user ?? req.user ?? null;

/**
 * THE role gate for Knowledge, by capability — widen here and only here.
 *   'manage'  write articles/playbooks/settings, run tests: global admins
 *             and workspace admins.
 *   'review'  mark Auto-help drafts good/partial/wrong (R6): managers plus
 *             workspace reviewers.
 */
export async function knowledgeCapability(user, workspaceId, capability = 'manage') {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.email || !workspaceId) return false;
  const access = await Promise.resolve()
    .then(() => prisma.workspaceAccess.findUnique({
      where: { email_workspaceId: { email: String(user.email).toLowerCase(), workspaceId: Number(workspaceId) } },
      select: { role: true },
    }))
    .catch(() => null);
  if (access?.role === 'admin') return true;
  return capability === 'review' && access?.role === 'reviewer';
}

export async function canManageKnowledge(user, workspaceId) {
  return knowledgeCapability(user, workspaceId, 'manage');
}

function requireKnowledgeManager(req, _res, next) {
  canManageKnowledge(sessionUser(req), req.workspaceId)
    .then((ok) => (ok ? next() : next(new AuthorizationError('Only workspace admins can change Knowledge', 'knowledge_manage_required'))))
    .catch(next);
}

function requireKnowledgeReviewer(req, _res, next) {
  knowledgeCapability(sessionUser(req), req.workspaceId, 'review')
    .then((ok) => (ok ? next() : next(new AuthorizationError('Only workspace admins and reviewers can review Auto-help drafts', 'knowledge_review_required'))))
    .catch(next);
}

const actorOf = (req) => {
  const u = sessionUser(req);
  return { email: u?.email || null, name: u?.name || null };
};

// ---------- settings ----------

/** The disclosure line exactly as a requester would read it (the runner's own substitution). */
async function disclosurePreviewFor(workspaceId, settings) {
  const ws = await Promise.resolve()
    .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }))
    .catch(() => null);
  return { workspaceName: ws?.name || null, disclosurePreview: disclosureLine({ ...settings, disclosureEnabled: true }, ws?.name || null) };
}

router.get('/settings', asyncHandler(async (req, res) => {
  const [settings, canManage, canReview] = await Promise.all([
    autoHelpPlaybookService.getSettings(req.workspaceId),
    canManageKnowledge(sessionUser(req), req.workspaceId),
    knowledgeCapability(sessionUser(req), req.workspaceId, 'review'),
  ]);
  const preview = await disclosurePreviewFor(req.workspaceId, settings);
  res.json({
    success: true,
    data: {
      ...settings,
      ...preview,
      canManage,
      canReview,
      modeLocked: true,
      modeLockedMessage: MODE_LOCKED_MESSAGE,
      defaults: { disclosureText: DEFAULT_DISCLOSURE_TEXT, followUp: DEFAULT_FOLLOW_UP, mode: P0_MODE },
      tools: toolCatalog(),
    },
  });
}));

router.put('/settings', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const settings = await autoHelpPlaybookService.updateSettings(req.workspaceId, req.body || {}, actorOf(req));
  logger.info(`Auto-help settings updated (ws ${req.workspaceId}): enabled=${settings.enabled}`);
  const preview = await disclosurePreviewFor(req.workspaceId, settings);
  res.json({ success: true, data: { ...settings, ...preview, canManage: true } });
}));

/** Internal category tree for the editors' selects (lighter than /tickets/meta). */
router.get('/categories', asyncHandler(async (req, res) => {
  const rows = await Promise.resolve()
    .then(() => prisma.competencyCategory.findMany({
      where: { workspaceId: req.workspaceId, isActive: true },
      select: { id: true, name: true, parentId: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }))
    .catch(() => []);
  const tree = rows.filter((c) => c.parentId === null).map((top) => ({
    id: top.id,
    name: top.name,
    subcategories: rows.filter((c) => c.parentId === top.id).map((s) => ({ id: s.id, name: s.name })),
  }));
  res.json({ success: true, data: tree });
}));

// ---------- articles ----------

router.get('/articles', asyncHandler(async (req, res) => {
  const { q, status, categoryId, review, limit, offset } = req.query;
  res.json({ success: true, data: await knowledgeArticleService.list(req.workspaceId, { q, status, categoryId, review, limit, offset }) });
}));

router.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw new ValidationError('Type something to search for');
  res.json({ success: true, data: await knowledgeArticleService.search(req.workspaceId, q, { limit: req.query.limit || 10, minScore: 0.1 }) });
}));

router.get('/articles/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.get(req.workspaceId, req.params.id) });
}));

router.post('/articles', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const article = await knowledgeArticleService.create(req.workspaceId, { ...(req.body || {}), source: 'tp' }, actorOf(req));
  res.status(201).json({ success: true, data: article });
}));

router.put('/articles/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.update(req.workspaceId, req.params.id, req.body || {}, actorOf(req)) });
}));

/** "Mark as verified" (R1): someone checked the article is still right today. */
router.post('/articles/:id/verify', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.verify(req.workspaceId, req.params.id, actorOf(req)) });
}));

/** "Delete" archives: the article leaves search and the default list; past runs still link to it. */
router.delete('/articles/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.remove(req.workspaceId, req.params.id, actorOf(req)) });
}));

// ---------- playbooks ----------

router.get('/playbooks', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.list(req.workspaceId) });
}));

router.get('/playbooks/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.get(req.workspaceId, req.params.id) });
}));

router.post('/playbooks', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const playbook = await autoHelpPlaybookService.create(req.workspaceId, req.body || {}, actorOf(req));
  logger.info(`Auto-help playbook created: ${playbook.name} (ws ${req.workspaceId})`);
  res.status(201).json({ success: true, data: playbook });
}));

router.put('/playbooks/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.update(req.workspaceId, req.params.id, req.body || {}, actorOf(req)) });
}));

router.delete('/playbooks/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.remove(req.workspaceId, req.params.id) });
}));

// Test runs cost a model call: at most TEST_RATE_LIMIT per person per minute
// (in-memory, per process — enough to stop a stuck button or a script).
export const TEST_RATE_LIMIT = 10;
const TEST_RATE_WINDOW_MS = 60 * 1000;
const testHits = new Map();

export function _resetTestRateLimit() {
  testHits.clear();
}

function testRateLimit(req, res, next) {
  const u = sessionUser(req);
  const key = String(u?.email || u?.name || req.ip || 'anon').toLowerCase();
  const now = Date.now();
  const recent = (testHits.get(key) || []).filter((t) => now - t < TEST_RATE_WINDOW_MS);
  if (recent.length >= TEST_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((TEST_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    testHits.set(key, recent);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      code: 'auto_help_test_rate_limited',
      message: `That's ${TEST_RATE_LIMIT} test runs in a minute. Give it ${retryAfter} seconds and try again.`,
    });
  }
  recent.push(now);
  testHits.set(key, recent);
  if (testHits.size > 1000) {
    for (const [k, list] of testHits) if (!list.some((t) => now - t < TEST_RATE_WINDOW_MS)) testHits.delete(k);
  }
  return next();
}

/**
 * "Test on a ticket": runs the playbook synchronously (trigger 'test') on a
 * ticket given as TP-1234 / #241406 / id. Shadow only — nothing is sent.
 */
router.post('/playbooks/:id/test', requireKnowledgeManager, testRateLimit, asyncHandler(async (req, res) => {
  const raw = req.body?.ticketRef ?? req.body?.ticketId;
  const ticket = await resolveTicketRefOrThrow(raw, req.workspaceId);
  const playbook = await autoHelpPlaybookService.get(req.workspaceId, req.params.id);
  const run = await autoHelpRunner.runForTicket(ticket.id, {
    trigger: 'test', playbookId: playbook.id, actor: actorOf(req), workspaceId: req.workspaceId,
  });
  res.json({ success: true, data: run });
}));

// ---------- runs / waiting ----------

router.get('/runs', asyncHandler(async (req, res) => {
  const { status, playbookId, ticketId, from, to, limit, offset } = req.query;
  res.json({ success: true, data: await autoHelpRunner.listRuns(req.workspaceId, { status, playbookId, ticketId, from, to, limit, offset }) });
}));

/** Per-playbook shadow summary with N (R6). Registered before /runs/:id. */
router.get('/runs-summary', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.summary(req.workspaceId, { from: req.query.from }) });
}));

/** A reviewer's verdict on a shadow draft (R6): good | partial | wrong | should_not_answer. */
router.post('/runs/:id/review', requireKnowledgeReviewer, asyncHandler(async (req, res) => {
  const { verdict, note } = req.body || {};
  res.json({ success: true, data: await autoHelpRunner.review(req.workspaceId, req.params.id, { verdict, note }, actorOf(req)) });
}));

router.get('/runs/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.getRun(req.workspaceId, req.params.id) });
}));

router.get('/tickets/:ticketId/auto-help', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.latestForTicket(req.workspaceId, req.params.ticketId) });
}));

router.get('/waiting', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.waiting(req.workspaceId) });
}));

export default router;
