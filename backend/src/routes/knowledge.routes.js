import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthorizationError, ValidationError } from '../utils/errors.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';
import knowledgeArticleService from '../services/knowledgeArticleService.js';
import autoHelpPlaybookService, {
  APPROVE_OFF_MESSAGE, AUTO_HELP_MODES, DEFAULT_ALWAYS_STAY_QUIET, DEFAULT_DISCLOSURE_TEXT, DEFAULT_FOLLOW_UP, DEFAULT_MODE,
} from '../services/autoHelpPlaybookService.js';
import { DISMISS_REASONS, READINESS } from '../services/autoHelpOutcomes.js';
import autoHelpRunner, { disclosureLine } from '../services/autoHelpRunner.js';
import { toolCatalog } from '../services/autoHelpTools.js';
import autoHelpPreviewService from '../services/autoHelpPreviewService.js';
import { resolveTicketRefOrThrow } from '../services/ticketRefResolver.js';
import knowledgeGrowthRoutes from './knowledgeGrowth.routes.js';
import knowledgeAnswerPolicy from '../services/knowledgeAnswerPolicy.js';
import knowledgeRights from '../services/knowledgeRights.js';
import knowledgeSignals from '../services/knowledgeSignals.js';
import knowledgeSuggestionService from '../services/knowledgeSuggestionService.js';

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

/**
 * Who may judge an Auto-help answer (Good / Partly / Wrong): admins and
 * reviewers, the ticket's assignee, and people with the skill to write in
 * the run's category. One click on the ticket is what earns a category its
 * way out of "Draft only", so it must not be an admin-only chore.
 */
async function canReviewRun(req, runId) {
  const user = sessionUser(req);
  if (await knowledgeCapability(user, req.workspaceId, 'review')) return true;
  const run = await Promise.resolve()
    .then(() => prisma.autoHelpRun.findFirst({ where: { id: Number(runId), workspaceId: req.workspaceId }, select: { ticketId: true, categoryId: true, subcategoryId: true } }))
    .catch(() => null);
  if (!run) return false;
  const profile = await knowledgeRights.profile(user, req.workspaceId);
  if (profile.technicianId) {
    const ticket = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({ where: { id: run.ticketId, workspaceId: req.workspaceId }, select: { assignedTechId: true, internalCategoryId: true, internalSubcategoryId: true } }))
      .catch(() => null);
    if (ticket?.assignedTechId && ticket.assignedTechId === profile.technicianId) return true;
    const target = { categoryId: run.categoryId ?? ticket?.internalCategoryId ?? null, subcategoryId: run.subcategoryId ?? ticket?.internalSubcategoryId ?? null };
    if ((await knowledgeRights.rightsFor(user, req.workspaceId, target)).write) return true;
  }
  return false;
}

/** Anyone who may write knowledge in some category (or manage Knowledge). */
function requireKnowledgeWriter(req, _res, next) {
  Promise.resolve()
    .then(async () => (await canManageKnowledge(sessionUser(req), req.workspaceId))
      || (await knowledgeRights.summary(sessionUser(req), req.workspaceId)).canWriteSomewhere === true)
    .then((ok) => (ok ? next() : next(new AuthorizationError('Drafting an article needs the skill to write knowledge in some category', 'knowledge_write_required'))))
    .catch(next);
}

function requireKnowledgeReviewer(req, _res, next) {
  knowledgeCapability(sessionUser(req), req.workspaceId, 'review')
    .then((ok) => (ok ? next() : next(new AuthorizationError('Only workspace admins and reviewers can review Auto-help drafts', 'knowledge_review_required'))))
    .catch(next);
}

/** Approvals queue (30 Sep 2026): admins and reviewers (the roles that approve AI suggestions). */
async function isAutoHelpApprover(user, workspaceId) {
  if (user?.role === 'admin') return true;
  if (!user?.email || !workspaceId) return false;
  const access = await Promise.resolve()
    .then(() => prisma.workspaceAccess.findUnique({
      where: { email_workspaceId: { email: String(user.email).toLowerCase(), workspaceId: Number(workspaceId) } },
      select: { role: true },
    }))
    .catch(() => null);
  return ['admin', 'reviewer'].includes(access?.role);
}

function requireAutoHelpApprover(req, _res, next) {
  isAutoHelpApprover(sessionUser(req), req.workspaceId)
    .then((ok) => (ok ? next() : next(new AuthorizationError('Only reviewers and admins can open the Auto-help approvals queue', 'auto_help_not_approver'))))
    .catch(next);
}

const actorOf = (req) => {
  const u = sessionUser(req);
  return { email: u?.email || null, name: u?.name || null };
};

/**
 * Rights by skill (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 7): what the
 * signed-in person may do with an article in a category. Admins: everything.
 */
const rightsIn = (req, target) => knowledgeRights.rightsFor(sessionUser(req), req.workspaceId, target || {});
const targetOf = (row) => ({ categoryId: row?.categoryId ?? null, subcategoryId: row?.subcategoryId ?? null });
function refuseWrite() {
  return new AuthorizationError('You can write knowledge in the categories you have the skill for. Propose it instead, or ask someone with the skill.', 'knowledge_write_required');
}
function refuseCheck() {
  return new AuthorizationError('Checking an article needs a higher skill level in its category', 'knowledge_check_required');
}

// ---------- settings ----------

/** The disclosure line exactly as a requester would read it (the runner's own substitution). */
async function disclosurePreviewFor(workspaceId, settings) {
  const ws = await Promise.resolve()
    .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }))
    .catch(() => null);
  return { workspaceName: ws?.name || null, disclosurePreview: disclosureLine({ ...settings, disclosureEnabled: true }, ws?.name || null) };
}

router.get('/settings', asyncHandler(async (req, res) => {
  const [settings, canManage, canReview, canApprove] = await Promise.all([
    autoHelpPlaybookService.getSettings(req.workspaceId),
    canManageKnowledge(sessionUser(req), req.workspaceId),
    knowledgeCapability(sessionUser(req), req.workspaceId, 'review'),
    isAutoHelpApprover(sessionUser(req), req.workspaceId),
  ]);
  const [preview, budget, afterHours] = await Promise.all([
    disclosurePreviewFor(req.workspaceId, settings),
    autoHelpRunner.budgetState(req.workspaceId, settings),
    // Approve by day, auto by night (30 Sep 2026).
    autoHelpPlaybookService.afterHoursStatus(req.workspaceId),
  ]);
  res.json({
    success: true,
    data: {
      ...settings,
      ...preview,
      canManage,
      canReview,
      canApprove,
      // Rights by skill: where this person may write or check articles.
      rights: await knowledgeRights.summary(sessionUser(req), req.workspaceId),
      // How many inbox items wait for this person (the number on the Inbox tab).
      inboxCount: await knowledgeSuggestionService.list(req.workspaceId, sessionUser(req), { scope: 'mine', limit: 1 })
        .then((r) => r?.counts?.mine || 0).catch(() => 0),
      // P1: approve needs the workspace switch; auto is locked by the build.
      modes: AUTO_HELP_MODES,
      modeLocked: !settings.approveModeEnabled,
      modeLockedMessage: settings.approveModeEnabled ? null : APPROVE_OFF_MESSAGE,
      budget,
      afterHours,
      readinessBar: READINESS,
      dismissReasons: DISMISS_REASONS,
      defaults: { disclosureText: DEFAULT_DISCLOSURE_TEXT, followUp: DEFAULT_FOLLOW_UP, mode: DEFAULT_MODE, alwaysStayQuietWhen: DEFAULT_ALWAYS_STAY_QUIET },
      tools: toolCatalog(),
    },
  });
}));

router.put('/settings', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const settings = await autoHelpPlaybookService.updateSettings(req.workspaceId, req.body || {}, actorOf(req));
  logger.info(`Auto-help settings updated (ws ${req.workspaceId}): enabled=${settings.enabled} approve=${settings.approveModeEnabled} cap=${settings.monthlyCostCapUsd ?? 'none'}`);
  const [preview, budget, afterHours] = await Promise.all([
    disclosurePreviewFor(req.workspaceId, settings),
    autoHelpRunner.budgetState(req.workspaceId, settings),
    // Approve by day, auto by night (30 Sep 2026).
    autoHelpPlaybookService.afterHoursStatus(req.workspaceId),
  ]);
  res.json({
    success: true,
    data: {
      ...settings, ...preview, canManage: true, budget, afterHours,
      modeLocked: !settings.approveModeEnabled,
      modeLockedMessage: settings.approveModeEnabled ? null : APPROVE_OFF_MESSAGE,
    },
  });
}));

// ---------- answering: the dial per category (knowledge-first) ----------

/**
 * Knowledge → Answering: what Auto-help may do with an answer in each
 * category, by day and by night, with the evidence each category has toward
 * "Send when sure". Readable by any member; changed by Knowledge managers.
 */
router.get('/answering', asyncHandler(async (req, res) => {
  const [dial, settings, afterHoursNow, canManage] = await Promise.all([
    knowledgeAnswerPolicy.list(req.workspaceId),
    autoHelpPlaybookService.getSettings(req.workspaceId),
    autoHelpPlaybookService.isAfterHours(req.workspaceId).catch(() => false),
    canManageKnowledge(sessionUser(req), req.workspaceId),
  ]);
  res.json({ success: true, data: { ...dial, knowledgeFirst: settings.knowledgeFirst === true, enabled: settings.enabled === true, afterHoursNow, canManage } });
}));

/** How often each confidence band was right, per category (the calibration table in Activity). */
router.get('/calibration', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeAnswerPolicy.calibration(req.workspaceId) });
}));

router.put('/answering/:categoryId', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const dial = await knowledgeAnswerPolicy.upsert(req.workspaceId, req.params.categoryId, req.body || {}, actorOf(req));
  const settings = await autoHelpPlaybookService.getSettings(req.workspaceId);
  res.json({ success: true, data: { ...dial, knowledgeFirst: settings.knowledgeFirst === true, enabled: settings.enabled === true, canManage: true } });
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
  const { q, status, categoryId, review, topic, owner, source, sort, limit, offset, subcategoryId, confidence, uncategorised } = req.query;
  res.json({
    success: true,
    data: await knowledgeArticleService.list(req.workspaceId, {
      // "Mine" in the Library: owner=me is the signed-in person.
      q, status, categoryId, review, topic, owner: owner === 'me' ? (sessionUser(req)?.email || '-') : owner, source, sort, limit, offset, subcategoryId, confidence, uncategorised,
    }),
  });
}));

/** The Library's category tree with counts (articles, drafts, needing attention). */
router.get('/library', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.library(req.workspaceId, { email: sessionUser(req)?.email || null }) });
}));

/** The Articles landing page: counts, recent quoting, coverage by category (30 Sep 2026). */
router.get('/articles-overview', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.overview(req.workspaceId) });
}));

router.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw new ValidationError('Type something to search for');
  const hits = await knowledgeArticleService.search(req.workspaceId, q, { limit: req.query.limit || 10, minScore: 0.1 });
  // A search that found nothing is a gap someone may want to fill.
  if (!hits.length && q.length >= 4) {
    knowledgeSignals.record(req.workspaceId, { kind: 'search_miss', actor: sessionUser(req)?.email || null, note: q.slice(0, 200), meta: { from: 'library' } }).catch(() => {});
  }
  res.json({ success: true, data: hits });
}));

/**
 * Topic suggestions for the article editor (Knowledge v2: tags are "Topics",
 * for browsing only): the workspace's article topics starting with ?q=, most
 * used first (top 15), as [{ topic, count }].
 */
router.get('/topics', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.topics(req.workspaceId, { q: req.query.q }) });
}));

/** An article, with how it did in use and what the reader may do with it. */
router.get('/articles/:id', asyncHandler(async (req, res) => {
  const article = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  const [stats, my] = await Promise.all([
    knowledgeSignals.stats(req.workspaceId, [article.id]),
    rightsIn(req, targetOf(article)),
  ]);
  res.json({ success: true, data: { ...article, use: stats.get(article.id) || null, my: { write: my.write, check: my.check, level: my.level } } });
}));

/**
 * Write an article: anyone with the skill for its category (rights by skill).
 * What a checker publishes is Checked; anyone else publishes "Not checked yet".
 */
router.post('/articles', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const my = await rightsIn(req, targetOf(body));
  if (!my.write) throw refuseWrite();
  const article = await knowledgeArticleService.create(req.workspaceId, { ...body, source: 'tp' }, actorOf(req), { canCheck: my.selfCheck, changeNote: body.changeNote || null });
  res.status(201).json({ success: true, data: article });
}));

router.put('/articles/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const existing = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  const my = await rightsIn(req, targetOf(existing));
  if (!my.write) throw refuseWrite();
  // Moving an article needs the skill where it lands, too.
  const moved = { categoryId: body.categoryId !== undefined ? body.categoryId : existing.categoryId, subcategoryId: body.subcategoryId !== undefined ? body.subcategoryId : existing.subcategoryId };
  const there = (moved.categoryId !== existing.categoryId || moved.subcategoryId !== existing.subcategoryId) ? await rightsIn(req, moved) : my;
  if (!there.write) throw refuseWrite();
  res.json({
    success: true,
    data: await knowledgeArticleService.update(req.workspaceId, req.params.id, body, actorOf(req), { canCheck: my.selfCheck && there.selfCheck, changeNote: body.changeNote || null }),
  });
}));

/**
 * "Checked": someone with the skill confirmed the article is right today.
 * In a category that is always checked by a person, that is someone other
 * than the person who last wrote it (admins excepted).
 */
router.post('/articles/:id/verify', asyncHandler(async (req, res) => {
  const existing = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  const my = await rightsIn(req, targetOf(existing));
  if (!my.check) throw refuseCheck();
  const me = String(sessionUser(req)?.email || '').toLowerCase();
  if (!my.selfCheck && me && String(existing.updatedBy || '').toLowerCase() === me) {
    throw new AuthorizationError('Someone else has to check this one: its category is always checked by a second person', 'knowledge_second_person');
  }
  res.json({ success: true, data: await knowledgeArticleService.verify(req.workspaceId, req.params.id, actorOf(req)) });
}));

/** "Delete" archives: the article leaves search and the default list; past runs still link to it. */
router.delete('/articles/:id', asyncHandler(async (req, res) => {
  const existing = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  if (!(await rightsIn(req, targetOf(existing))).check) throw refuseCheck();
  res.json({ success: true, data: await knowledgeArticleService.remove(req.workspaceId, req.params.id, actorOf(req)) });
}));

/** History: every saved version, and putting an older one back (as a new version). */
router.get('/articles/:id/versions', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeArticleService.versions(req.workspaceId, req.params.id) });
}));

router.get('/articles/:id/versions/:version', asyncHandler(async (req, res) => {
  await knowledgeArticleService.get(req.workspaceId, req.params.id);
  res.json({ success: true, data: await knowledgeArticleService.getVersion(req.workspaceId, req.params.id, req.params.version) });
}));

router.post('/articles/:id/versions/:version/restore', asyncHandler(async (req, res) => {
  const existing = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  const my = await rightsIn(req, targetOf(existing));
  if (!my.write) throw refuseWrite();
  res.json({ success: true, data: await knowledgeArticleService.restore(req.workspaceId, req.params.id, req.params.version, actorOf(req), { canCheck: my.selfCheck }) });
}));

/** "Flag it": any member may say an article is wrong or unclear, in one sentence. */
router.post('/articles/:id/flag', asyncHandler(async (req, res) => {
  const article = await knowledgeArticleService.get(req.workspaceId, req.params.id);
  const note = String(req.body?.note || '').trim();
  if (note.length < 3) throw new ValidationError('Say in a few words what is wrong or unclear');
  const result = await knowledgeSignals.flag(req.workspaceId, article.id, { note, ticketId: Number(req.body?.ticketId) || null, actor: actorOf(req) });
  // The flag reaches people with the skill through the inbox (one open item per article).
  await knowledgeSuggestionService.create(req.workspaceId, {
    kind: 'flag',
    title: `Something is wrong in: ${article.title}`,
    why: note,
    articleId: article.id,
    categoryId: article.categoryId,
    subcategoryId: article.subcategoryId,
    evidence: { note, by: actorOf(req).email, ticketId: Number(req.body?.ticketId) || null, needsLook: result.demoted === true },
    impact: Number(article.timesQuoted) || 0,
    source: 'agent_flag',
    createdBy: actorOf(req).email,
    excludeAssignees: [actorOf(req).email],
    dedupeKey: `flag:article:${article.id}`,
    reopen: true,
  }).catch((err) => logger.warn(`Knowledge flag on article ${article.id}: inbox item not made (${err.message})`));
  logger.info(`Knowledge article ${article.id} flagged by ${actorOf(req).email || 'unknown'}${result.demoted ? ' (now needs a look)' : ''}`);
  res.status(201).json({ success: true, data: result });
}));

// ---------- playbooks ----------

router.get('/playbooks', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.list(req.workspaceId) });
}));

router.get('/playbooks/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.getWithSummary(req.workspaceId, req.params.id) });
}));

/**
 * "Show the effect before saving" (Knowledge v2): the playbook body in the
 * editor (unsaved) vs the saved one on the last 30 days of tickets. Scope and
 * word rules only - no model call (aiFitCheckNotRun: true). The /:id form
 * compares with the saved playbook; the bare form is a new playbook.
 */
router.post('/playbooks/preview-match', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.previewMatch(req.workspaceId, { draft: req.body || {} }) });
}));

router.post('/playbooks/:id/preview-match', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.previewMatch(req.workspaceId, { id: req.params.id, draft: req.body || {} }) });
}));

router.post('/playbooks', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const playbook = await autoHelpPlaybookService.create(req.workspaceId, req.body || {}, actorOf(req));
  logger.info(`Auto-help playbook created: ${playbook.name} (ws ${req.workspaceId})`);
  res.status(201).json({ success: true, data: playbook });
}));

router.put('/playbooks/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPlaybookService.update(req.workspaceId, req.params.id, req.body || {}, actorOf(req)) });
}));

/** The auto-mode readiness gate for one playbook, criterion by criterion (P1). */
router.get('/playbooks/:id/readiness', asyncHandler(async (req, res) => {
  const playbook = await autoHelpPlaybookService.get(req.workspaceId, req.params.id);
  const readiness = await autoHelpPlaybookService.readiness(req.workspaceId, playbook.id, { sensitive: playbook.sensitive === true });
  res.json({ success: true, data: { ...readiness, autoModeAllowed: autoHelpPlaybookService.autoModeAllowed() } });
}));

/**
 * "Preview answer" (playbook builder): the newest drafted test run as the
 * requester would read it, or — with none yet — a labelled SAMPLE built from
 * the best-matching published article without any model call.
 */
router.get('/playbooks/:id/preview', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpPreviewService.forPlaybook(req.workspaceId, req.params.id) });
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
router.post('/runs/:id/review', asyncHandler(async (req, res) => {
  const { verdict, note } = req.body || {};
  if (!(await canReviewRun(req, req.params.id))) {
    throw new AuthorizationError('Reviewing this answer is for the ticket\'s assignee, people with the skill for its category, reviewers and admins', 'knowledge_review_required');
  }
  const run = await autoHelpRunner.review(req.workspaceId, req.params.id, { verdict, note }, actorOf(req));
  // Reuse is review: the verdict lands on every article the answer quoted.
  const demoted = await knowledgeSignals.recordReview(req.workspaceId, run, String(verdict || ''), actorOf(req)).catch(() => []);
  res.json({ success: true, data: { ...run, demotedArticleIds: demoted } });
}));

/** Every Auto-help answer waiting for a person (Knowledge → Approvals, 30 Sep 2026). */
router.get('/approvals', requireAutoHelpApprover, asyncHandler(async (req, res) => {
  const { default: autoHelpDeliveryService } = await import('../services/autoHelpDeliveryService.js');
  res.json({ success: true, data: await autoHelpDeliveryService.listWaiting(req.workspaceId) });
}));

/** "Send to me": e-mail yourself exactly what the requester would get (30 Sep 2026). */
router.post('/runs/:id/send-to-me', asyncHandler(async (req, res) => {
  const { default: autoHelpDeliveryService } = await import('../services/autoHelpDeliveryService.js');
  res.json({ success: true, data: await autoHelpDeliveryService.sendPreviewToMe(req.workspaceId, req.params.id, actorOf(req)) });
}));

// ---------- prompts (Knowledge → Settings → Prompts, 30 Sep 2026) ----------

router.get('/prompts', asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  const { promptPreview } = await import('../services/autoHelpRunner.js');
  const list = await autoHelpPromptService.list(req.workspaceId);
  res.json({ success: true, data: list.map((p) => ({ ...p, fullPrompt: promptPreview(p.key, p.activeBody) })) });
}));

router.post('/prompts/preview', asyncHandler(async (req, res) => {
  const { promptPreview } = await import('../services/autoHelpRunner.js');
  const key = String(req.body?.key || '');
  if (!['answer', 'route', 'check', 'triage'].includes(key)) throw new ValidationError('Unknown prompt');
  res.json({ success: true, data: { fullPrompt: promptPreview(key, String(req.body?.body || '')) } });
}));

router.get('/prompts/:id', asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  res.json({ success: true, data: await autoHelpPromptService.get(req.workspaceId, req.params.id) });
}));

router.post('/prompts', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  const { key, body, notes } = req.body || {};
  res.status(201).json({ success: true, data: await autoHelpPromptService.createDraft(req.workspaceId, { key, body, notes }, actorOf(req)) });
}));

router.post('/prompts/:id/publish', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  res.json({ success: true, data: await autoHelpPromptService.publish(req.workspaceId, req.params.id, actorOf(req)) });
}));

router.post('/prompts/:id/restore', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  res.status(201).json({ success: true, data: await autoHelpPromptService.restore(req.workspaceId, req.params.id, actorOf(req)) });
}));

router.post('/prompts/use-default/:key', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  res.json({ success: true, data: await autoHelpPromptService.useDefault(req.workspaceId, req.params.key) });
}));

router.delete('/prompts/:id', requireKnowledgeManager, asyncHandler(async (req, res) => {
  const { default: autoHelpPromptService } = await import('../services/autoHelpPromptService.js');
  res.json({ success: true, data: await autoHelpPromptService.remove(req.workspaceId, req.params.id) });
}));

router.get('/runs/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.getRun(req.workspaceId, req.params.id) });
}));

router.get('/tickets/:ticketId/auto-help', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.latestForTicket(req.workspaceId, req.params.ticketId) });
}));

/**
 * The ticket's Knowledge panel (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12):
 * the articles that fit this ticket, the latest Auto-help run, and whether
 * the signed-in person may judge it.
 */
router.get('/tickets/:ticketId/knowledge', asyncHandler(async (req, res) => {
  const ticket = await Promise.resolve()
    .then(() => prisma.ticket.findFirst({
      where: { id: Number(req.params.ticketId), workspaceId: req.workspaceId },
      select: { id: true, subject: true, descriptionText: true, internalCategoryId: true, internalSubcategoryId: true, assignedTechId: true },
    }))
    .catch(() => null);
  if (!ticket) throw new ValidationError('Ticket not found in this workspace');
  const query = `${ticket.subject || ''}\n${String(ticket.descriptionText || '').slice(0, 1500)}`.trim();
  const [articles, run, my] = await Promise.all([
    query ? knowledgeArticleService.search(req.workspaceId, query, {
      limit: 5, categoryId: ticket.internalCategoryId, subcategoryId: ticket.internalSubcategoryId,
    }).catch(() => []) : [],
    autoHelpRunner.latestForTicket(req.workspaceId, ticket.id).catch(() => null),
    rightsIn(req, { categoryId: ticket.internalCategoryId, subcategoryId: ticket.internalSubcategoryId }),
  ]);
  if (query && !articles.length) {
    knowledgeSignals.record(req.workspaceId, { kind: 'search_miss', ticketId: ticket.id, categoryId: ticket.internalCategoryId, actor: sessionUser(req)?.email || null, note: String(ticket.subject || '').slice(0, 200), meta: { from: 'ticket' } }).catch(() => {});
  }
  res.json({
    success: true,
    data: {
      articles: articles.map((a) => ({ id: a.id, title: a.title, section: a.section?.heading || null, snippet: a.snippet, score: a.score, confidence: a.confidence, stale: a.stale })),
      run,
      canReview: run?.id ? await canReviewRun(req, run.id) : false,
      my: { write: my.write, check: my.check, level: my.level },
    },
  });
}));

router.get('/waiting', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await autoHelpRunner.waiting(req.workspaceId) });
}));

// ---------- the inbox (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 10) ----------

router.get('/inbox', asyncHandler(async (req, res) => {
  const { scope, status, kind, articleId, limit, offset } = req.query;
  res.json({ success: true, data: await knowledgeSuggestionService.list(req.workspaceId, sessionUser(req), { scope, status, kind, articleId, limit, offset }) });
}));

router.get('/suggestions/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeSuggestionService.get(req.workspaceId, req.params.id, sessionUser(req)) });
}));

/**
 * Propose something (anyone with a skill in the category, basic included):
 * a new article or a change, for someone with the skill to accept.
 */
router.post('/suggestions', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!['new_article', 'edit', 'add_section'].includes(body.kind)) throw new ValidationError('You can propose a new article, a change or a section');
  let target = { categoryId: body.categoryId ?? null, subcategoryId: body.subcategoryId ?? null };
  if (body.articleId) {
    const article = await knowledgeArticleService.get(req.workspaceId, body.articleId);
    target = targetOf(article);
  }
  const my = await rightsIn(req, target);
  if (!my.propose) throw new AuthorizationError('Proposing knowledge needs a skill in that category', 'knowledge_propose_required');
  const me = actorOf(req).email;
  const { suggestion } = await knowledgeSuggestionService.create(req.workspaceId, {
    kind: body.kind,
    title: body.title,
    why: body.why || null,
    articleId: body.articleId || null,
    categoryId: target.categoryId,
    subcategoryId: target.subcategoryId,
    proposed: body.proposed && typeof body.proposed === 'object' ? {
      ...(body.proposed.title ? { title: String(body.proposed.title).slice(0, 300) } : {}),
      ...(body.proposed.bodyHtml ? { bodyHtml: String(body.proposed.bodyHtml).slice(0, 100000) } : {}),
      ...(body.proposed.sectionHtml ? { sectionHtml: String(body.proposed.sectionHtml).slice(0, 50000) } : {}),
      ...(target.categoryId ? { categoryId: target.categoryId, subcategoryId: target.subcategoryId } : {}),
    } : null,
    evidence: body.ticketId ? { ticketIds: [Number(body.ticketId)] } : null,
    source: 'person',
    createdBy: me,
    excludeAssignees: [me],
  });
  res.status(201).json({ success: true, data: suggestion });
}));

router.post('/suggestions/:id/accept', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeSuggestionService.accept(req.workspaceId, req.params.id, sessionUser(req), req.body || {}) });
}));

router.post('/suggestions/:id/dismiss', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeSuggestionService.dismiss(req.workspaceId, req.params.id, sessionUser(req), { note: req.body?.note }) });
}));

router.post('/suggestions/:id/snooze', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await knowledgeSuggestionService.snooze(req.workspaceId, req.params.id, sessionUser(req), { days: req.body?.days }) });
}));

// ---------- contribution in the flow of work (section 8) ----------

// Loaded on first use: the capture service pulls in the drafter, which tests of other routes mock with a short export list.
const captureService = async () => (await import('../services/knowledgeCaptureService.js')).default;

/** Should the person closing this ticket be asked to save their answer? (Records the ask when yes.) */
router.get('/tickets/:ticketId/capture', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await (await captureService()).shouldAsk(req.workspaceId, req.params.ticketId, sessionUser(req)) });
}));

/** "Save my answer as knowledge" (decision yes) or "Not now". */
router.post('/tickets/:ticketId/capture', testRateLimit, asyncHandler(async (req, res) => {
  const decision = req.body?.decision === 'not_now' ? 'not_now' : 'yes';
  res.status(decision === 'yes' ? 201 : 200).json({ success: true, data: await (await captureService()).capture(req.workspaceId, req.params.ticketId, sessionUser(req), { decision }) });
}));

/** Rough notes -> a house-style article proposal. Nothing is saved. */
router.post('/tidy', testRateLimit, asyncHandler(async (req, res) => {
  const profile = await knowledgeRights.summary(sessionUser(req), req.workspaceId);
  if (!profile.canPropose) throw new AuthorizationError('Writing knowledge needs a skill in some category', 'knowledge_propose_required');
  res.json({ success: true, data: await (await captureService()).tidy(req.workspaceId, { text: req.body?.text, title: req.body?.title }) });
}));

// ---------- the nightly review and the coverage map (sections 9 and 11) ----------

/** When the review last ran and what it raised. */
router.get('/steward', asyncHandler(async (req, res) => {
  const { default: knowledgeSettingsService } = await import('../services/knowledgeSettingsService.js');
  const s = await knowledgeSettingsService.get(req.workspaceId);
  res.json({ success: true, data: { enabled: s.stewardEnabled === true, last: s.stewardState || null } });
}));

/** "Review now": every check that needs no model call, on demand. */
router.post('/steward/run', requireKnowledgeManager, testRateLimit, asyncHandler(async (req, res) => {
  const { default: knowledgeStewardService } = await import('../services/knowledgeStewardService.js');
  const state = await knowledgeStewardService.runForWorkspace(req.workspaceId, { withModel: false });
  logger.info(`Knowledge review run by ${actorOf(req).email || 'unknown'} (ws ${req.workspaceId})`);
  res.json({ success: true, data: state });
}));

/**
 * The coverage map: per top category, the demand, what Auto-help did with
 * it and what the Library holds. About topics, never about people (the
 * people count is how many could write there, not who).
 */
router.get('/coverage', asyncHandler(async (req, res) => {
  const ws = req.workspaceId;
  const since = new Date(Date.now() - 30 * 86400e3);
  const soft = (fn, fallback) => Promise.resolve().then(fn).catch(() => fallback);
  const [library, runs, tickets, misses, open, skills] = await Promise.all([
    knowledgeArticleService.library(ws, {}),
    soft(() => prisma.autoHelpRun.groupBy({ by: ['categoryId', 'status', 'gateDecision'], where: { workspaceId: ws, trigger: 'categorized', createdAt: { gte: since } }, _count: true }), []),
    soft(() => prisma.ticket.groupBy({ by: ['internalCategoryId'], where: { workspaceId: ws, isNoise: false, createdAt: { gte: since } }, _count: true }), []),
    soft(() => prisma.knowledgeSignal.groupBy({ by: ['categoryId'], where: { workspaceId: ws, kind: 'search_miss', createdAt: { gte: since } }, _count: true }), []),
    soft(() => prisma.knowledgeSuggestion.groupBy({ by: ['categoryId', 'kind'], where: { workspaceId: ws, status: 'open' }, _count: true }), []),
    soft(() => prisma.technicianCompetency.findMany({
      where: { workspaceId: ws, technician: { isActive: true }, proficiencyLevel: { in: ['intermediate', 'advanced', 'expert'] } },
      select: { technicianId: true, competencyCategory: { select: { id: true, parentId: true } } },
      take: 5000,
    }), []),
  ]);
  const n = (v) => Number(v?._count) || 0;
  const writers = new Map();
  for (const sk of skills) {
    const top = sk.competencyCategory?.parentId || sk.competencyCategory?.id;
    if (!top) continue;
    if (!writers.has(top)) writers.set(top, new Set());
    writers.get(top).add(sk.technicianId);
  }
  const rows = (library.categories || []).map((c) => {
    const mine = runs.filter((r) => r.categoryId === c.id);
    const sum = (pred) => mine.filter(pred).reduce((t, r) => t + n(r), 0);
    return {
      id: c.id,
      name: c.name,
      tickets30: n(tickets.find((t) => t.internalCategoryId === c.id)),
      answered: sum((r) => ['drafted', 'staged', 'sent'].includes(r.status)),
      needsPerson: sum((r) => r.gateDecision === 'needs_person'),
      notAnswered: sum((r) => r.status === 'not_answerable' && ['no_sources', 'insufficient_context', 'model_declined', 'no_grounded_source', 'uncited_step'].includes(r.gateDecision)),
      articles: c.articles,
      notChecked: c.notChecked,
      attention: c.attention,
      searchMisses: n(misses.find((m) => m.categoryId === c.id)),
      openGaps: open.filter((o) => o.categoryId === c.id && o.kind === 'gap').reduce((t, o) => t + n(o), 0),
      openItems: open.filter((o) => o.categoryId === c.id).reduce((t, o) => t + n(o), 0),
      couldWrite: writers.get(c.id)?.size || 0,
    };
  });
  res.json({ success: true, data: { days: 30, categories: rows } });
}));

/** Knowledge → Home: what waits for me, and how my categories are doing. */
router.get('/home', asyncHandler(async (req, res) => {
  const user = sessionUser(req);
  const [inbox, rights, library, dial] = await Promise.all([
    knowledgeSuggestionService.list(req.workspaceId, user, { scope: 'categories', limit: 6 }),
    knowledgeRights.summary(user, req.workspaceId),
    knowledgeArticleService.library(req.workspaceId, { email: user?.email || null }),
    knowledgeAnswerPolicy.list(req.workspaceId).catch(() => ({ categories: [] })),
  ]);
  const dialById = new Map((dial.categories || []).map((c) => [c.id, c]));
  // My categories: the top categories I have a skill in (directly or through a subcategory).
  const mine = (library.categories || []).filter((c) => rights.isAdmin || rights.categories[c.id] || (c.subcategories || []).some((s) => rights.categories[s.id]));
  res.json({
    success: true,
    data: {
      rights: { isAdmin: rights.isAdmin, canPropose: rights.canPropose, canWriteSomewhere: rights.canWriteSomewhere, canCheckSomewhere: rights.canCheckSomewhere, technician: rights.technician },
      inbox: { counts: inbox.counts, items: inbox.items },
      totals: library.totals,
      mine: library.mine,
      categories: mine.map((c) => {
        const d = dialById.get(c.id);
        return {
          id: c.id, name: c.name, articles: c.articles, drafts: c.drafts, attention: c.attention, notChecked: c.notChecked,
          // An admin's reach is not a skill: no level is shown for it.
          level: rights.isAdmin ? 0 : (rights.categories[c.id]?.level || Math.max(0, ...(c.subcategories || []).map((s) => rights.categories[s.id]?.level || 0))),
          runs30: d?.runs30 || { total: 0, answered: 0 },
          dayLevel: d?.resolved?.dayLevel || 'draft',
        };
      }),
    },
  });
}));

// Knowledge that grows (P1): gaps, drafts from tickets, FreshService import,
// review digest, backtests — behind the same role gates as everything above.
router.use(knowledgeGrowthRoutes({ requireKnowledgeManager, requireKnowledgeReviewer, requireKnowledgeWriter, sessionUser, actorOf }));

export default router;
