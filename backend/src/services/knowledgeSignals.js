/**
 * What happens to an article in use (plans/KNOWLEDGE_SIMPLIFY_PLAN.md
 * sections 3 and 9): "reuse is review" and "flag it or fix it".
 *
 *   good | partial | wrong   a person judged an answer that quoted the article
 *   flagged                  someone said the article itself is wrong or unclear
 *   search_miss              a search in the Library or on a ticket found nothing
 *   demoted                  the article was taken out of automatic answers
 *   ask_shown | ask_accepted | ask_not_now   save-at-close prompts
 *
 * The ONE automatic action lives here, in the safe direction: two bad signals
 * (wrong or flagged, from different tickets or people) since the article was
 * last checked take it out of automatic answers ("needs a look"). A person
 * with the skill brings it back by checking it.
 *
 * Every write fails soft: a signal that cannot be recorded never blocks the
 * review or the flag that caused it.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import knowledgeArticleService from './knowledgeArticleService.js';

export const SIGNAL_KINDS = Object.freeze([
  'good', 'partial', 'wrong', 'flagged', 'search_miss', 'demoted', 'inserted', 'ask_shown', 'ask_accepted', 'ask_not_now',
]);
export const BAD_KINDS = Object.freeze(['wrong', 'flagged']);
/** Bad signals, from different tickets or people, that take an article out of automatic answers. */
export const DEMOTE_AFTER = 2;
export const SIGNAL_WINDOW_MS = 90 * 86400e3;
const MAX_NOTE = 1000;

/** The article ids an Auto-help run's answer cited ({ sources: [{ type, id, cited }] }). Pure. */
export function citedArticleIds(run) {
  const list = Array.isArray(run?.sources) ? run.sources : [];
  return [...new Set(list.filter((s) => s && s.type === 'article' && s.cited === true).map((s) => Number(s.id)).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Distinct "who or where" of bad signals: a second complaint about the same ticket is not a second signal. Pure. */
export function distinctBad(signals = []) {
  const seen = new Set();
  for (const s of signals) {
    if (!BAD_KINDS.includes(s.kind)) continue;
    seen.add(s.ticketId ? `t${s.ticketId}` : `a${String(s.actor || '').toLowerCase() || s.id}`);
  }
  return seen.size;
}

class KnowledgeSignalsService {
  /** Record one signal. Never throws; returns the row or null. */
  async record(workspaceId, { kind, articleId = null, sectionIndex = null, categoryId = null, ticketId = null, runId = null, actor = null, note = null, meta = null } = {}) {
    if (!SIGNAL_KINDS.includes(kind)) return null;
    return Promise.resolve()
      .then(() => prisma.knowledgeSignal.create({
        data: {
          workspaceId: Number(workspaceId),
          kind,
          articleId: articleId ? Number(articleId) : null,
          sectionIndex: Number.isInteger(sectionIndex) ? sectionIndex : null,
          categoryId: categoryId ? Number(categoryId) : null,
          ticketId: ticketId ? Number(ticketId) : null,
          runId: runId ? Number(runId) : null,
          actor: actor ? String(actor).toLowerCase().slice(0, 255) : null,
          note: note ? String(note).trim().slice(0, MAX_NOTE) || null : null,
          ...(meta && typeof meta === 'object' ? { meta } : {}),
        },
      }))
      .catch((err) => { logger.warn(`Knowledge signal "${kind}" not recorded (ws ${workspaceId}): ${err.message}`); return null; });
  }

  /**
   * A person judged an Auto-help answer: every article it quoted gets the
   * verdict ('should_not_answer' says nothing about the articles). A "wrong"
   * may take an article out of automatic answers. Returns the demoted ids.
   */
  async recordReview(workspaceId, run, verdict, actor = null) {
    if (!['good', 'partial', 'wrong'].includes(verdict)) return [];
    const ids = citedArticleIds(run);
    const demoted = [];
    for (const articleId of ids) {
      await this.record(workspaceId, { kind: verdict, articleId, categoryId: run.categoryId ?? null, ticketId: run.ticketId, runId: run.id, actor: actor?.email || actor?.name || null });
      if (verdict === 'wrong' && await this.demoteIfDoubtful(workspaceId, articleId)) demoted.push(articleId);
    }
    return demoted;
  }

  /** "Flag it": anyone may say an article is wrong or unclear, with one sentence. */
  async flag(workspaceId, articleId, { note = null, ticketId = null, actor = null } = {}) {
    const row = await this.record(workspaceId, { kind: 'flagged', articleId, ticketId, actor: actor?.email || actor?.name || null, note });
    const demoted = await this.demoteIfDoubtful(workspaceId, articleId);
    return { recorded: Boolean(row), demoted };
  }

  /**
   * Two bad signals from different tickets or people since the article was
   * last checked: out of automatic answers. Returns true when it was demoted now.
   */
  async demoteIfDoubtful(workspaceId, articleId) {
    const ws = Number(workspaceId);
    const id = Number(articleId);
    try {
      const article = await prisma.knowledgeArticle.findFirst({ where: { id, workspaceId: ws }, select: { id: true, status: true, confidence: true, checkedAt: true } });
      if (!article || article.status !== 'published' || article.confidence === 'needs_look') return false;
      const since = new Date(Math.max(Date.now() - SIGNAL_WINDOW_MS, article.checkedAt ? new Date(article.checkedAt).getTime() : 0));
      const signals = await prisma.knowledgeSignal.findMany({
        where: { workspaceId: ws, articleId: id, kind: { in: [...BAD_KINDS] }, createdAt: { gte: since } },
        select: { id: true, kind: true, ticketId: true, actor: true },
        take: 200,
      });
      if (distinctBad(signals) < DEMOTE_AFTER) return false;
      const done = await knowledgeArticleService.markNeedsLook(ws, id, { by: 'system' });
      if (done) {
        await this.record(ws, { kind: 'demoted', articleId: id, note: `${distinctBad(signals)} people or tickets said this article was wrong or unclear` });
        logger.info(`Knowledge article ${id} (ws ${ws}) taken out of automatic answers: ${distinctBad(signals)} bad signals since it was last checked`);
      }
      return done;
    } catch (err) {
      logger.warn(`Knowledge article ${id}: doubt check failed (${err.message})`);
      return false;
    }
  }

  /**
   * How articles did in use, for the reader and the Library:
   * Map(articleId -> { good, partial, wrong, flagged, lastGoodAt, lastGoodBy, flags: [{ note, actor, at }] }).
   */
  async stats(workspaceId, articleIds = []) {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const out = new Map(ids.map((id) => [id, { good: 0, partial: 0, wrong: 0, flagged: 0, lastGoodAt: null, lastGoodBy: null, flags: [] }]));
    if (!ids.length) return out;
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeSignal.findMany({
        where: { workspaceId: Number(workspaceId), articleId: { in: ids }, kind: { in: ['good', 'partial', 'wrong', 'flagged'] }, createdAt: { gte: new Date(Date.now() - 365 * 86400e3) } },
        orderBy: { createdAt: 'desc' },
        take: 5000,
        select: { articleId: true, kind: true, actor: true, note: true, createdAt: true },
      }))
      .catch(() => []);
    for (const r of rows || []) {
      const s = out.get(r.articleId);
      if (!s) continue;
      s[r.kind] += 1;
      if (r.kind === 'good' && !s.lastGoodAt) { s.lastGoodAt = r.createdAt; s.lastGoodBy = r.actor || null; }
      if (r.kind === 'flagged' && s.flags.length < 5) s.flags.push({ note: r.note || null, actor: r.actor || null, at: r.createdAt });
    }
    return out;
  }
}

const knowledgeSignals = new KnowledgeSignalsService();
export default knowledgeSignals;
