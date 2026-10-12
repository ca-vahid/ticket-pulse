/**
 * Who may do what in Knowledge (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 7).
 * Rights come from the skills people already have (technician_competencies),
 * the KCS licence idea: propose, write, check.
 *
 *   any workspace member   read, search, flag, say "this helped / this is wrong"
 *   basic                  propose (goes to someone with the skill)
 *   publish level (intermediate by default)
 *                          write and publish as "Not checked yet"; fix articles
 *   check level (advanced by default)
 *                          all of that, plus confirm an article as Checked
 *   workspace admin        everything, everywhere
 *
 * A skill in a top category covers its subcategories; a skill in a
 * subcategory covers that subcategory, and counts for articles filed on the
 * top category itself. A category that is "always checked by a person"
 * (Knowledge -> Answering) needs a second person: nobody but an admin
 * confirms their own article there.
 *
 * Reads fail soft to "no rights beyond a member's": a broken lookup can
 * never hand out write access.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const SKILL_LEVELS = Object.freeze(['basic', 'intermediate', 'advanced', 'expert']);
export const DEFAULT_PUBLISH_LEVEL = 'intermediate';
export const DEFAULT_CHECK_LEVEL = 'advanced';
const CACHE_MS = 60 * 1000;

export function rankOf(level) {
  const i = SKILL_LEVELS.indexOf(String(level || '').toLowerCase());
  return i < 0 ? 0 : i + 1;
}

/**
 * A person's level (0-4) for an article or ticket in a category. Pure.
 *   levels   Map(categoryId -> rank) of the person's own skills
 *   parents  Map(categoryId -> parentId | null) of the workspace's categories
 */
export function levelIn(levels, parents, { categoryId = null, subcategoryId = null } = {}) {
  const top = Number(categoryId) || null;
  const sub = Number(subcategoryId) || null;
  if (!top && !sub) return 0;
  const topOfSub = sub ? (parents.get(sub) ?? null) : null;
  const root = top || topOfSub;
  let best = 0;
  if (root) best = Math.max(best, levels.get(root) || 0);
  if (sub) return Math.max(best, levels.get(sub) || 0);
  // Filed on the top category itself: any skill inside it counts.
  for (const [id, rank] of levels) if (parents.get(id) === root) best = Math.max(best, rank);
  return best;
}

/**
 * What a profile may do with something in a category. Pure.
 * @returns {{ level, propose, write, check, selfCheck }}
 */
export function rightsIn(profile, target = {}, { alwaysChecked = false } = {}) {
  if (!profile) return { level: 0, propose: false, write: false, check: false, selfCheck: false };
  if (profile.isAdmin) return { level: 4, propose: true, write: true, check: true, selfCheck: true };
  const level = levelIn(profile.levels, profile.parents, target);
  const write = level >= profile.publishRank;
  const check = level >= profile.checkRank;
  return { level, propose: level >= 1, write, check, selfCheck: check && !alwaysChecked };
}

class KnowledgeRightsService {
  _cache = new Map();

  clearCache() { this._cache.clear(); }

  /**
   * The signed-in person's Knowledge profile in a workspace (cached a minute):
   * { email, isAdmin, isReviewer, technicianId, levels, parents, publishRank, checkRank }.
   */
  async profile(user, workspaceId) {
    const ws = Number(workspaceId);
    const email = String(user?.email || '').trim().toLowerCase();
    const base = { email, isAdmin: false, isReviewer: false, technicianId: null, levels: new Map(), parents: new Map(), publishRank: rankOf(DEFAULT_PUBLISH_LEVEL), checkRank: rankOf(DEFAULT_CHECK_LEVEL) };
    if (!user || !ws) return base;
    const key = `${ws}:${email}:${user.role || ''}`;
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const soft = (fn, fallback) => Promise.resolve().then(fn).catch((err) => { logger.warn(`Knowledge rights lookup failed (ws ${ws}): ${err.message}`); return fallback; });
    const [access, tech, cats, settings] = await Promise.all([
      email ? soft(() => prisma.workspaceAccess.findUnique({ where: { email_workspaceId: { email, workspaceId: ws } }, select: { role: true } }), null) : null,
      email ? soft(() => prisma.technician.findFirst({ where: { workspaceId: ws, isActive: true, email: { equals: email, mode: 'insensitive' } }, select: { id: true } }), null) : null,
      soft(() => prisma.competencyCategory.findMany({ where: { workspaceId: ws, isActive: true }, select: { id: true, parentId: true }, take: 2000 }), []),
      soft(() => prisma.knowledgeSettings.findUnique({ where: { workspaceId: ws }, select: { publishLevel: true, checkLevel: true } }), null),
    ]);
    const skills = tech ? await soft(() => prisma.technicianCompetency.findMany({
      where: { technicianId: tech.id, workspaceId: ws },
      select: { competencyCategoryId: true, proficiencyLevel: true },
      take: 2000,
    }), []) : [];
    const value = {
      ...base,
      isAdmin: user.role === 'admin' || access?.role === 'admin',
      isReviewer: access?.role === 'reviewer',
      technicianId: tech?.id || null,
      levels: new Map((skills || []).map((s) => [Number(s.competencyCategoryId), rankOf(s.proficiencyLevel)]).filter(([, r]) => r > 0)),
      parents: new Map((cats || []).map((c) => [Number(c.id), c.parentId === null ? null : Number(c.parentId)])),
      publishRank: rankOf(settings?.publishLevel) || rankOf(DEFAULT_PUBLISH_LEVEL),
      checkRank: Math.max(rankOf(settings?.checkLevel) || rankOf(DEFAULT_CHECK_LEVEL), rankOf(settings?.publishLevel) || 0),
    };
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** rightsIn() for a user, reading whether the category is "always checked". */
  async rightsFor(user, workspaceId, target = {}) {
    const profile = await this.profile(user, workspaceId);
    if (profile.isAdmin) return rightsIn(profile, target);
    let alwaysChecked = false;
    try {
      const { default: policy } = await import('./knowledgeAnswerPolicy.js');
      alwaysChecked = (await policy.resolveForTicket(workspaceId, { internalCategoryId: target.categoryId ?? null, internalSubcategoryId: target.subcategoryId ?? null })).alwaysChecked === true;
    } catch { alwaysChecked = false; }
    return rightsIn(profile, target, { alwaysChecked });
  }

  /**
   * What the UI needs to know about the person: can they write anywhere, and
   * where. { isAdmin, isReviewer, technician, canWriteSomewhere, categories: { [id]: { level, write, check } } }
   */
  async summary(user, workspaceId) {
    const profile = await this.profile(user, workspaceId);
    const categories = {};
    for (const id of profile.parents.keys()) {
      const isSub = profile.parents.get(id) !== null;
      const r = rightsIn(profile, isSub ? { subcategoryId: id } : { categoryId: id });
      if (r.level > 0 || profile.isAdmin) categories[id] = { level: r.level, propose: r.propose, write: r.write, check: r.check };
    }
    const any = (k) => profile.isAdmin || Object.values(categories).some((c) => c[k]);
    return {
      isAdmin: profile.isAdmin,
      isReviewer: profile.isReviewer,
      technician: Boolean(profile.technicianId),
      canPropose: any('propose'),
      canWriteSomewhere: any('write'),
      canCheckSomewhere: any('check'),
      publishLevel: SKILL_LEVELS[profile.publishRank - 1],
      checkLevel: SKILL_LEVELS[profile.checkRank - 1],
      categories,
    };
  }

  /**
   * People who could write or check in a category (for routing gaps and
   * suggestions): active technicians at or above the level, best first.
   * Never throws. [{ technicianId, name, email, level }] — no photos.
   */
  async skilledPeople(workspaceId, target = {}, { minRank = 2, limit = 10 } = {}) {
    const ws = Number(workspaceId);
    try {
      const cats = await prisma.competencyCategory.findMany({ where: { workspaceId: ws, isActive: true }, select: { id: true, parentId: true }, take: 2000 });
      const parents = new Map(cats.map((c) => [Number(c.id), c.parentId === null ? null : Number(c.parentId)]));
      const top = Number(target.categoryId) || (target.subcategoryId ? parents.get(Number(target.subcategoryId)) : null) || null;
      const ids = [top, Number(target.subcategoryId) || null].filter(Boolean);
      if (!target.subcategoryId && top) for (const [id, parent] of parents) if (parent === top) ids.push(id);
      if (!ids.length) return [];
      const rows = await prisma.technicianCompetency.findMany({
        where: { workspaceId: ws, competencyCategoryId: { in: ids }, technician: { isActive: true } },
        select: { proficiencyLevel: true, technician: { select: { id: true, name: true, email: true } } },
        take: 2000,
      });
      const best = new Map();
      for (const r of rows) {
        const rank = rankOf(r.proficiencyLevel);
        if (rank < minRank || !r.technician?.email) continue;
        const cur = best.get(r.technician.id);
        if (!cur || rank > cur.level) best.set(r.technician.id, { technicianId: r.technician.id, name: r.technician.name, email: String(r.technician.email).toLowerCase(), level: rank });
      }
      return [...best.values()].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).slice(0, limit);
    } catch (err) {
      logger.warn(`Knowledge skilled people lookup failed (ws ${ws}): ${err.message}`);
      return [];
    }
  }
}

const knowledgeRights = new KnowledgeRightsService();
export default knowledgeRights;
