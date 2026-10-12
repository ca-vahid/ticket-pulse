/**
 * The Knowledge inbox (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 10):
 * everything that needs a person, in one shape. A suggestion says what, why,
 * shows its evidence and a proposed change, and takes three actions: accept,
 * edit-and-accept, dismiss.
 *
 *   kind          what accepting does
 *   new_article   publishes proposed { title, bodyHtml, categoryId, subcategoryId, tags }
 *                 (or publishes the draft article it points at)
 *   add_section   appends proposed.sectionHtml to the article
 *   edit          replaces the article's text with proposed.bodyHtml
 *   merge         keeps articleId with proposed.bodyHtml, archives otherArticleId
 *   retire        archives the article
 *   flag          "something is wrong": accepted = dealt with (fix it or check it)
 *   question      one concrete question; the answer is kept on the suggestion
 *   gap           "asked N times, nothing written": accepted when an article exists
 *   review        a draft waiting for its author to check and publish
 *
 * How it stays small:
 *   - one suggestion per topic (dedupeKey): more evidence updates the open one
 *   - routed by skill to at most two people who are not over their weekly cap;
 *     nobody free = it waits in "My categories" for anyone with the skill
 *   - sorted by impact (tickets a month the change would touch)
 *   - untouched suggestions expire after four weeks
 *
 * The AI proposes, a person decides: nothing here changes a published
 * article until someone with the skill for its category accepts.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';
import knowledgeArticleService, { sanitizeArticleHtml } from './knowledgeArticleService.js';
import knowledgeRights, { rightsIn } from './knowledgeRights.js';

export const SUGGESTION_KINDS = Object.freeze(['new_article', 'add_section', 'edit', 'merge', 'retire', 'flag', 'question', 'gap', 'review']);
export const SUGGESTION_STATUSES = Object.freeze(['open', 'accepted', 'dismissed', 'expired']);
/** Kinds whose acceptance needs the right to CHECK (they remove or fold knowledge). */
export const CHECK_KINDS = Object.freeze(['merge', 'retire']);
export const EXPIRE_AFTER_MS = 28 * 86400e3;
export const MAX_ASSIGNEES = 2;
export const DEFAULT_WEEKLY_CAP = 5;
const MAX_TITLE = 300;
const MAX_WHY = 2000;
const WEEK_MS = 7 * 86400e3;

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const lower = (email) => String(email || '').trim().toLowerCase();

/** API shape. */
export function suggestionView(row, { withProposal = true } = {}) {
  if (!row) return null;
  const { proposed, ...rest } = row;
  return {
    ...rest,
    assignedTo: Array.isArray(row.assignedTo) ? row.assignedTo : [],
    evidence: row.evidence && typeof row.evidence === 'object' ? row.evidence : {},
    ...(withProposal ? { proposed: proposed && typeof proposed === 'object' ? proposed : null } : { hasProposal: Boolean(proposed) }),
  };
}

/** Pure: may this profile act on a suggestion in its category? */
export function canDecide(rights, kind) {
  if (!rights) return false;
  return CHECK_KINDS.includes(kind) ? rights.check === true : rights.write === true;
}

class KnowledgeSuggestionService {
  _expiredAt = new Map();

  /**
   * Who a suggestion goes to: up to two people with the skill for its
   * category who are under their weekly cap, best skill first. Never throws.
   */
  async route(workspaceId, target = {}, { exclude = [], cap = null } = {}) {
    const ws = Number(workspaceId);
    try {
      const settings = await prisma.knowledgeSettings.findUnique({ where: { workspaceId: ws }, select: { inboxWeeklyCap: true, publishLevel: true } }).catch(() => null);
      const weeklyCap = Number(cap ?? settings?.inboxWeeklyCap) || DEFAULT_WEEKLY_CAP;
      const people = await knowledgeRights.skilledPeople(ws, target, { minRank: 2, limit: 12 });
      if (!people.length) return [];
      const skip = new Set(exclude.map(lower));
      const recent = await prisma.knowledgeSuggestion.findMany({
        where: { workspaceId: ws, createdAt: { gte: new Date(Date.now() - WEEK_MS) }, assignedTo: { hasSome: people.map((p) => p.email) } },
        select: { assignedTo: true },
        take: 2000,
      }).catch(() => []);
      const load = new Map();
      for (const r of recent) for (const e of r.assignedTo || []) load.set(e, (load.get(e) || 0) + 1);
      return people
        .filter((p) => !skip.has(p.email) && (load.get(p.email) || 0) < weeklyCap)
        // Spread the work: fewest this week first, then the higher skill.
        .sort((a, b) => (load.get(a.email) || 0) - (load.get(b.email) || 0) || b.level - a.level)
        .slice(0, MAX_ASSIGNEES)
        .map((p) => p.email);
    } catch (err) {
      logger.warn(`Knowledge suggestion routing failed (ws ${ws}): ${err.message}`);
      return [];
    }
  }

  /**
   * Add a suggestion, or add to the open one about the same thing
   * (`dedupeKey`): its evidence and impact are refreshed, never a second row.
   * Returns { suggestion, created }. Never throws for a duplicate.
   */
  async create(workspaceId, input = {}) {
    const ws = Number(workspaceId);
    if (!SUGGESTION_KINDS.includes(input.kind)) throw new ValidationError(`kind must be one of: ${SUGGESTION_KINDS.join(', ')}`);
    const title = clip(input.title, MAX_TITLE);
    if (!title) throw new ValidationError('A suggestion needs a title');
    const dedupeKey = input.dedupeKey ? String(input.dedupeKey).slice(0, 200) : null;
    const target = { categoryId: input.categoryId ?? null, subcategoryId: input.subcategoryId ?? null };
    if (dedupeKey) {
      const existing = await prisma.knowledgeSuggestion.findFirst({ where: { workspaceId: ws, dedupeKey } }).catch(() => null);
      if (existing?.status === 'open') {
        const row = await prisma.knowledgeSuggestion.update({
          where: { id: existing.id },
          data: {
            ...(input.evidence ? { evidence: input.evidence } : {}),
            ...(input.proposed ? { proposed: input.proposed } : {}),
            ...(input.why ? { why: clip(input.why, MAX_WHY) } : {}),
            impact: Math.max(Number(existing.impact) || 0, Number(input.impact) || 0),
            expiresAt: new Date(Date.now() + EXPIRE_AFTER_MS),
          },
        });
        return { suggestion: suggestionView(row), created: false };
      }
      // Decided before: the same thing is not raised again unless told to (the
      // steward passes `reopen` when the evidence has grown).
      if (existing && input.reopen !== true) return { suggestion: suggestionView(existing), created: false };
      if (existing) await prisma.knowledgeSuggestion.update({ where: { id: existing.id }, data: { dedupeKey: `${dedupeKey}#${existing.id}` } }).catch(() => {});
    }
    const assignedTo = Array.isArray(input.assignedTo) && input.assignedTo.length
      ? [...new Set(input.assignedTo.map(lower).filter(Boolean))].slice(0, MAX_ASSIGNEES)
      : await this.route(ws, target, { exclude: input.excludeAssignees || [] });
    const row = await prisma.knowledgeSuggestion.create({
      data: {
        workspaceId: ws,
        kind: input.kind,
        status: 'open',
        articleId: input.articleId ? Number(input.articleId) : null,
        otherArticleId: input.otherArticleId ? Number(input.otherArticleId) : null,
        categoryId: target.categoryId ? Number(target.categoryId) : null,
        subcategoryId: target.subcategoryId ? Number(target.subcategoryId) : null,
        title,
        why: input.why ? clip(input.why, MAX_WHY) : null,
        ...(input.proposed && typeof input.proposed === 'object' ? { proposed: input.proposed } : {}),
        ...(input.evidence && typeof input.evidence === 'object' ? { evidence: input.evidence } : {}),
        impact: Math.max(0, Number(input.impact) || 0),
        source: String(input.source || 'person').slice(0, 30),
        assignedTo,
        dedupeKey,
        createdBy: input.createdBy ? lower(input.createdBy) : null,
        expiresAt: new Date(Date.now() + EXPIRE_AFTER_MS),
      },
    });
    return { suggestion: suggestionView(row), created: true };
  }

  /** Close what nobody touched in four weeks. Returns how many. Never throws. */
  async expireOld(workspaceId = null) {
    return Promise.resolve()
      .then(() => prisma.knowledgeSuggestion.updateMany({
        where: { ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}), status: 'open', expiresAt: { lt: new Date() } },
        data: { status: 'expired' },
      }))
      .then((res) => res?.count || 0)
      .catch((err) => { logger.warn(`Knowledge suggestions: expiry sweep failed (${err.message})`); return 0; });
  }

  /**
   * The inbox for one person.
   *   scope 'mine'        sent to me
   *         'categories'  anything in a category I may write in (default)
   *         'all'         everything (admins)
   * Sorted by impact. Each item says whether this person may decide it.
   */
  async list(workspaceId, user, { scope = 'categories', status = 'open', kind = null, articleId = null, limit = 50, offset = 0 } = {}) {
    const ws = Number(workspaceId);
    // Old items close when the inbox is read (at most once an hour per workspace).
    if (Date.now() - (this._expiredAt.get(ws) || 0) > 3600e3) {
      this._expiredAt.set(ws, Date.now());
      await this.expireOld(ws);
    }
    const profile = await knowledgeRights.profile(user, ws);
    const where = { workspaceId: ws, status: SUGGESTION_STATUSES.includes(status) ? status : 'open' };
    if (kind && SUGGESTION_KINDS.includes(kind)) where.kind = kind;
    if (Number(articleId)) where.articleId = Number(articleId);
    if (where.status === 'open') where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }];
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeSuggestion.findMany({ where, orderBy: [{ impact: 'desc' }, { createdAt: 'desc' }], take: 500 }))
      .catch((err) => { logger.warn(`Knowledge inbox unavailable (ws ${ws}): ${err.message}`); return []; });
    const me = profile.email;
    const decorated = (rows || []).map((r) => {
      const rights = knowledgeRightsIn(profile, r);
      const mine = (r.assignedTo || []).includes(me) || (r.kind === 'review' && lower(r.createdBy) === me);
      return { row: r, mine, can: canDecide(rights, r.kind), level: rights.level };
    });
    const visible = decorated.filter((d) => {
      if (scope === 'all' && profile.isAdmin) return true;
      if (scope === 'mine') return d.mine;
      return d.mine || d.can || profile.isAdmin;
    });
    const counts = {
      mine: decorated.filter((d) => d.mine).length,
      categories: decorated.filter((d) => d.mine || d.can || profile.isAdmin).length,
      all: profile.isAdmin ? decorated.length : null,
    };
    const start = Math.max(Number(offset) || 0, 0);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return {
      counts,
      total: visible.length,
      items: visible.slice(start, start + take).map((d) => ({ ...suggestionView(d.row, { withProposal: false }), mine: d.mine, canDecide: d.can })),
    };
  }

  async get(workspaceId, id, user = null) {
    const row = await Promise.resolve()
      .then(() => prisma.knowledgeSuggestion.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
    if (!row) throw new NotFoundError('That suggestion was not found');
    const profile = user ? await knowledgeRights.profile(user, workspaceId) : null;
    const rights = profile ? knowledgeRightsIn(profile, row) : null;
    const [article, other] = await Promise.all([
      row.articleId ? knowledgeArticleService.get(workspaceId, row.articleId).catch(() => null) : null,
      row.otherArticleId ? knowledgeArticleService.get(workspaceId, row.otherArticleId).catch(() => null) : null,
    ]);
    const slim = (a) => (a ? { id: a.id, title: a.title, bodyHtml: a.bodyHtml, status: a.status, health: a.health, version: a.version } : null);
    return { ...suggestionView(row), article: slim(article), otherArticle: slim(other), canDecide: canDecide(rights, row.kind), mine: profile ? (row.assignedTo || []).includes(profile.email) : false };
  }

  async _open(workspaceId, id, user) {
    const row = await prisma.knowledgeSuggestion.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } }).catch(() => null);
    if (!row) throw new NotFoundError('That suggestion was not found');
    if (row.status !== 'open') throw new ValidationError('That suggestion was already dealt with');
    const profile = await knowledgeRights.profile(user, workspaceId);
    const rights = knowledgeRightsIn(profile, row);
    return { row, profile, rights };
  }

  /**
   * Accept a suggestion: apply its change through the article service (so the
   * edit is versioned and the trust rules apply) and close it. `edits` may
   * replace the proposed title / text first ("edit and accept"), or carry the
   * answer to a question.
   */
  async accept(workspaceId, id, user, edits = {}) {
    const { row, profile, rights } = await this._open(workspaceId, id, user);
    // The author of a draft may always publish their own review item when they can write there.
    if (!canDecide(rights, row.kind)) {
      throw new AuthorizationError(CHECK_KINDS.includes(row.kind)
        ? 'Merging or retiring an article needs the level that can check articles in its category'
        : 'Accepting this needs the skill for its category', 'knowledge_suggestion_rights');
    }
    const actor = { email: profile.email || user?.email || null, name: user?.name || null };
    const proposed = { ...(row.proposed && typeof row.proposed === 'object' ? row.proposed : {}), ...(edits && typeof edits === 'object' ? edits : {}) };
    const opts = { canCheck: rights.selfCheck === true, changeNote: clip(`${row.title}`, 300), suggestionId: row.id };
    let resultArticleId = row.articleId || null;
    let decisionNote = edits?.note ? clip(edits.note, 1000) : null;

    if (row.kind === 'new_article' || row.kind === 'review') {
      if (row.articleId) {
        // A draft article waiting for its author: publish it (with any last edits).
        const article = await knowledgeArticleService.update(workspaceId, row.articleId, {
          status: 'published',
          ...(proposed.title ? { title: proposed.title } : {}),
          ...(proposed.bodyHtml ? { bodyHtml: proposed.bodyHtml } : {}),
        }, actor, opts);
        resultArticleId = article.id;
      } else {
        if (!proposed.title || !proposed.bodyHtml) throw new ValidationError('This suggestion has no text to publish');
        const article = await knowledgeArticleService.create(workspaceId, {
          title: proposed.title, bodyHtml: proposed.bodyHtml, status: 'published',
          categoryId: proposed.categoryId ?? row.categoryId, subcategoryId: proposed.subcategoryId ?? row.subcategoryId, tags: proposed.tags || [],
        }, actor, opts);
        resultArticleId = article.id;
      }
    } else if (row.kind === 'add_section') {
      const article = await knowledgeArticleService.get(workspaceId, row.articleId);
      const section = sanitizeArticleHtml(String(proposed.sectionHtml || ''));
      if (!section) throw new ValidationError('This suggestion has no text to add');
      await knowledgeArticleService.update(workspaceId, article.id, { bodyHtml: `${article.bodyHtml || ''}${section}` }, actor, opts);
    } else if (row.kind === 'edit') {
      if (!proposed.bodyHtml && !proposed.title) throw new ValidationError('This suggestion has no change to apply');
      await knowledgeArticleService.update(workspaceId, row.articleId, {
        ...(proposed.title ? { title: proposed.title } : {}),
        ...(proposed.bodyHtml ? { bodyHtml: proposed.bodyHtml } : {}),
      }, actor, opts);
    } else if (row.kind === 'merge') {
      if (!row.articleId || !row.otherArticleId) throw new ValidationError('A merge needs two articles');
      // Nothing is archived on a guess: without a merged text the person
      // must say the kept article already covers everything.
      if (!proposed.bodyHtml && edits?.keepAsIs !== true) {
        throw new ValidationError('Move what is still needed into the kept article first (open it in the editor), then archive the other one');
      }
      if (proposed.bodyHtml) await knowledgeArticleService.update(workspaceId, row.articleId, { bodyHtml: proposed.bodyHtml, ...(proposed.title ? { title: proposed.title } : {}) }, actor, opts);
      await knowledgeArticleService.remove(workspaceId, row.otherArticleId, actor);
    } else if (row.kind === 'retire') {
      await knowledgeArticleService.remove(workspaceId, row.articleId, actor);
    } else if (row.kind === 'question') {
      const answer = clip(edits?.answer, 1000);
      if (!answer) throw new ValidationError('Type the answer first');
      decisionNote = answer;
    }
    // flag / gap: accepted = dealt with; nothing to apply.
    const done = await prisma.knowledgeSuggestion.update({
      where: { id: row.id },
      data: { status: 'accepted', decidedBy: actor.email, decidedAt: new Date(), decisionNote, resultArticleId },
    });
    logger.info(`Knowledge suggestion ${row.id} (${row.kind}) accepted by ${actor.email || 'unknown'}${resultArticleId ? ` -> article ${resultArticleId}` : ''}`);
    return suggestionView(done);
  }

  /** Dismiss: anyone who could accept it, the person it was sent to, or its author. */
  async dismiss(workspaceId, id, user, { note = null } = {}) {
    const { row, profile, rights } = await this._open(workspaceId, id, user);
    const mine = (row.assignedTo || []).includes(profile.email) || lower(row.createdBy) === profile.email;
    if (!mine && !canDecide(rights, row.kind) && !rights.write) {
      throw new AuthorizationError('Dismissing this needs the skill for its category', 'knowledge_suggestion_rights');
    }
    const done = await prisma.knowledgeSuggestion.update({
      where: { id: row.id },
      data: { status: 'dismissed', decidedBy: profile.email || null, decidedAt: new Date(), decisionNote: note ? clip(note, 1000) : null },
    });
    return suggestionView(done);
  }

  /** "Not now": hide it from the inbox for a week (it keeps its place when it returns). */
  async snooze(workspaceId, id, user, { days = 7 } = {}) {
    const { row } = await this._open(workspaceId, id, user);
    const until = new Date(Date.now() + Math.min(Math.max(Number(days) || 7, 1), 28) * 86400e3);
    const done = await prisma.knowledgeSuggestion.update({ where: { id: row.id }, data: { snoozedUntil: until } });
    return suggestionView(done);
  }

  /** Open suggestions for an article (shown on its page). */
  async forArticle(workspaceId, articleId) {
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeSuggestion.findMany({
        where: { workspaceId: Number(workspaceId), status: 'open', OR: [{ articleId: Number(articleId) }, { otherArticleId: Number(articleId) }] },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }))
      .catch(() => []);
    return (rows || []).map((r) => suggestionView(r, { withProposal: false }));
  }
}

/** What a profile may do with a suggestion (its category). */
function knowledgeRightsIn(profile, row) {
  return rightsIn(profile, { categoryId: row?.categoryId ?? null, subcategoryId: row?.subcategoryId ?? null });
}

const knowledgeSuggestionService = new KnowledgeSuggestionService();
export default knowledgeSuggestionService;
