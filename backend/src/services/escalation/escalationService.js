import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import {
  OUTCOMES, decideEscalation, escalationNote, levelIn, levelWord, promote, scopeLabel,
} from './rules.js';

/**
 * Escalation (QA 10-16 item 1): a hand-back with reason "escalate" asks for
 * someone more advanced in the ticket's category / subcategory.
 *
 *  - contextFor(): the snapshot taken when the ticket is handed back — who,
 *    their level, the category / subcategory. It rides the hand-back's audit
 *    row (ticket_activities.details.handBack.escalation) and the rebound run
 *    (reboundFrom.reason.escalation); no new table or column.
 *  - guard(): the deterministic check after the AI's pick on the rebound run,
 *    like the urgent-response and spread guards. Never throws (null on any
 *    error = the AI's pick stands), records what it did on the run's
 *    recommendation JSON (`recommendation.escalation`).
 */

const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const MAX_TECHNICIANS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`Escalation read skipped: ${err.message}`);
  return fallback;
});

const TECH_SELECT = {
  id: true, name: true, email: true, isActive: true, assignableOnly: true, origin: true, freshserviceId: true,
  timezone: true, workStartTime: true, workEndTime: true,
};
const LEAVE_SELECT = {
  technicianId: true, leaveDate: true, category: true, status: true, isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true,
};

async function competencyRows(workspaceId, techIds, categoryIds) {
  const cats = categoryIds.filter(Boolean).map(Number);
  if (!cats.length || !techIds.length) return [];
  return soft(() => prisma.technicianCompetency.findMany({
    where: { workspaceId: Number(workspaceId), technicianId: { in: techIds.map(Number) }, competencyCategoryId: { in: cats } },
    select: { technicianId: true, competencyCategoryId: true, proficiencyLevel: true },
    take: 5000,
  }), []);
}

function skillsByTech(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r.technicianId)) map.set(r.technicianId, []);
    map.get(r.technicianId).push({ categoryId: r.competencyCategoryId, level: r.proficiencyLevel });
  }
  return map;
}

const escalationService = {
  /**
   * The escalation snapshot for a hand-back. Never throws; fields it could not
   * read are null (a ticket without a category gives categoryId null - the
   * guard then keeps the AI's pick and says so).
   */
  async contextFor({ workspaceId, ticketId, technicianId, technicianName = null, ticket = null }) {
    const ws = Number(workspaceId);
    const row = ticket?.internalCategoryId !== undefined
      ? ticket
      : await soft(() => prisma.ticket.findUnique({
        where: { id: Number(ticketId) },
        select: { id: true, internalCategoryId: true, internalSubcategoryId: true },
      }), null);
    const categoryId = row?.internalCategoryId ? Number(row.internalCategoryId) : null;
    const subcategoryId = row?.internalSubcategoryId ? Number(row.internalSubcategoryId) : null;
    const ids = [categoryId, subcategoryId].filter(Boolean);
    const [cats, tech, rows] = await Promise.all([
      ids.length
        ? soft(() => prisma.competencyCategory.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), [])
        : [],
      technicianName || !technicianId
        ? null
        : soft(() => prisma.technician.findUnique({ where: { id: Number(technicianId) }, select: { id: true, name: true } }), null),
      technicianId ? competencyRows(ws, [Number(technicianId)], ids) : [],
    ]);
    const nameOf = (id) => (cats || []).find((c) => c.id === id)?.name || null;
    const categoryName = nameOf(categoryId);
    const subcategoryName = nameOf(subcategoryId);
    const skills = skillsByTech(rows).get(Number(technicianId)) || [];
    const lvl = levelIn(skills, { categoryId, subcategoryId });
    return {
      fromTechId: technicianId ? Number(technicianId) : null,
      fromTechName: technicianName || tech?.name || null,
      level: lvl.level,
      rank: lvl.rank,
      levelWord: levelWord(lvl.rank),
      categoryId,
      categoryName,
      subcategoryId,
      subcategoryName,
      scope: scopeLabel({ categoryName, subcategoryName }),
    };
  },

  /**
   * After the AI's pick on an escalated ticket.
   *
   * @param {{ workspaceId: number, ticketId: number, runId?: number|null, recommendation: object,
   *   escalation: object, now?: Date }} input
   * @returns {Promise<null | { outcome: string, techId: number|null, techName: string|null, sentence: string,
   *   recommendations: object[], record: object, step: object }>}
   *   null = nothing to do (or an error): the AI's pick stands.
   */
  async guard({ workspaceId, ticketId, runId = null, recommendation, escalation, now = new Date() }) {
    try {
      const ws = Number(workspaceId);
      if (!escalation || SANDBOX_WORKSPACES.includes(ws)) return null;
      const ranked = Array.isArray(recommendation?.recommendations) ? recommendation.recommendations.filter((r) => r?.techId) : [];
      if (!ranked.length) return null;

      // The snapshot's scope wins (where the person said they could not go
      // further); a snapshot without one falls back to the AI's category.
      const scoped = escalation.categoryId || escalation.subcategoryId
        ? escalation
        : {
          ...escalation,
          categoryId: Number(recommendation?.internalCategoryId) || null,
          subcategoryId: Number(recommendation?.internalSubcategoryId) || null,
        };
      if (scoped !== escalation && (scoped.categoryId || scoped.subcategoryId) && escalation.fromTechId) {
        const fresh = await this.contextFor({
          workspaceId: ws,
          ticketId,
          technicianId: escalation.fromTechId,
          technicianName: escalation.fromTechName,
          ticket: { internalCategoryId: scoped.categoryId, internalSubcategoryId: scoped.subcategoryId },
        });
        Object.assign(scoped, { rank: fresh.rank, level: fresh.level, levelWord: fresh.levelWord, scope: fresh.scope, categoryName: fresh.categoryName, subcategoryName: fresh.subcategoryName });
      }

      let candidates = [];
      if (scoped.categoryId || scoped.subcategoryId) candidates = await this._candidates(ws, ticketId, scoped, now);
      const decided = decideEscalation({ escalation: scoped, ranked, candidates });
      const swapped = decided.outcome === OUTCOMES.SWAPPED;
      const recommendations = swapped
        ? promote(ranked, decided, decided.sentence)
        : ranked;
      const record = {
        outcome: decided.outcome,
        sentence: decided.sentence,
        note: escalationNote(scoped),
        fromTechId: scoped.fromTechId ?? null,
        fromTechName: scoped.fromTechName || null,
        fromLevel: levelWord(decided.fromRank),
        scope: scoped.scope || null,
        categoryId: scoped.categoryId || null,
        subcategoryId: scoped.subcategoryId || null,
        aiPickTechId: ranked[0]?.techId ?? null,
        aiPickTechName: ranked[0]?.techName || null,
        aiPickLevel: decided.pickRank === null ? null : levelWord(decided.pickRank),
        chosenTechId: decided.techId ?? null,
        chosenTechName: decided.techName || null,
        chosenLevel: decided.rank === null ? null : levelWord(decided.rank),
        suggestionOnly: decided.outcome === OUTCOMES.NONE_HIGHER,
        considered: candidates
          .filter((c) => c.rank > (scoped.rank || 0))
          .slice(0, 10)
          .map((c) => ({ techId: c.techId, name: c.name, level: levelWord(c.rank), eligible: c.eligible, why: c.why || null })),
        at: now.toISOString(),
      };
      const step = {
        stepName: 'escalation_guard',
        status: 'completed',
        durationMs: 0,
        output: { kind: 'escalation_guard', ...record, message: decided.sentence },
      };
      logger.info('Pipeline escalation guard', {
        runId, ticketId, workspaceId: ws, outcome: decided.outcome, fromTechId: scoped.fromTechId ?? null, toTechId: decided.techId ?? null,
      });
      return { outcome: decided.outcome, techId: decided.techId ?? null, techName: decided.techName || null, sentence: decided.sentence, recommendations, record, step };
    } catch (err) {
      logger.warn('Escalation guard failed - the AI pick stands', { ticketId, workspaceId, error: err.message });
      return null;
    }
  },

  /**
   * Everyone who could take the ticket, with their level in its scope and
   * whether they are eligible right now: active team member, at work and not
   * on leave, allowed to hold this ticket (FreshService seat for FS-born), and
   * not someone who already handed this ticket back.
   */
  async _candidates(ws, ticketId, scope, now) {
    const [ticket, techs, rejected] = await Promise.all([
      soft(() => prisma.ticket.findUnique({ where: { id: Number(ticketId) }, select: { id: true, origin: true } }), null),
      soft(() => prisma.technician.findMany({
        where: { workspaceId: ws, isActive: true },
        select: TECH_SELECT,
        orderBy: { id: 'asc' },
        take: MAX_TECHNICIANS,
      }), []),
      soft(() => prisma.ticketAssignmentEpisode.findMany({
        where: { ticketId: Number(ticketId), endMethod: 'rejected' },
        select: { technicianId: true },
        take: 50,
      }), []),
    ]);
    if (!techs.length) return [];
    const ids = techs.map((t) => t.id);
    const rows = await competencyRows(ws, ids, [scope.categoryId, scope.subcategoryId]);
    const skills = skillsByTech(rows);
    const rejectedIds = new Set((rejected || []).map((r) => r.technicianId));
    const fsBorn = ticket?.origin && ticket.origin !== 'ticketpulse';

    // At work right now: the same definition as the urgent-response guard
    // (shift, business days, approved leave). If it cannot be read, nobody is
    // ruled out for it - the AI already weighed availability.
    let stateOf = () => ({ atWork: true, reason: 'unknown' });
    try {
      const [{ atWork }, { default: businessCalendarService }] = await Promise.all([
        import('../urgentResponse/rules.js'),
        import('../businessCalendarService.js'),
      ]);
      const calendar = await soft(() => businessCalendarService.loadCalendar(ws), null);
      const leaves = await soft(() => prisma.technicianLeave.findMany({
        where: {
          technicianId: { in: ids },
          status: 'APPROVED',
          leaveDate: { gte: new Date(now.getTime() - 2 * DAY_MS), lte: new Date(now.getTime() + 2 * DAY_MS) },
        },
        select: LEAVE_SELECT,
        take: 5000,
      }), []);
      const leavesByTech = new Map();
      for (const l of leaves || []) {
        if (!leavesByTech.has(l.technicianId)) leavesByTech.set(l.technicianId, []);
        leavesByTech.get(l.technicianId).push(l);
      }
      const isBusinessDay = calendar ? (dateStr, dayOfWeek) => calendar.byDay.has(dayOfWeek) && !calendar.isHolidayDate(dateStr) : undefined;
      stateOf = (tech) => atWork(tech, now, {
        leaves: leavesByTech.get(tech.id) || [],
        isBusinessDay,
        leaveTimezone: calendar?.timezone || null,
      });
    } catch (err) {
      logger.debug?.(`Escalation: availability unreadable, nobody ruled out for it: ${err.message}`);
    }

    let openCounts = new Map();
    const open = await soft(async () => {
      const { default: statusService } = await import('../statusService.js');
      const names = await statusService.statusNamesForBase(ws, ['Open', 'Pending']);
      return prisma.ticket.groupBy({
        by: ['assignedTechId'],
        where: { workspaceId: ws, assignedTechId: { in: ids }, status: { in: names } },
        _count: { _all: true },
      });
    }, []);
    openCounts = new Map((open || []).map((r) => [r.assignedTechId, r._count?._all ?? 0]));

    return techs.map((t) => {
      const lvl = levelIn(skills.get(t.id) || [], scope);
      let why = null;
      if (t.assignableOnly) why = 'other team';
      else if (fsBorn && (!t.freshserviceId || t.origin === 'local')) why = 'no FreshService seat';
      else if (rejectedIds.has(t.id) || Number(t.id) === Number(scope.fromTechId)) why = 'handed this ticket back';
      else {
        const state = stateOf(t);
        if (!state.atWork) why = state.reason || 'away';
      }
      return { techId: t.id, name: t.name, rank: lvl.rank, eligible: !why, why, openCount: openCounts.get(t.id) || 0 };
    });
  },
};

export { escalationNote };
export default escalationService;
