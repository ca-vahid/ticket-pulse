import prisma from './prisma.js';
import statusService, { TERMINAL_BASE_STATUSES } from './statusService.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

/**
 * Skills learner (QA 10-09 item 12).
 *
 * A skill is learned from CLOSED tickets, never from assignments: the
 * assignment is mostly the AI's guess and can be wrong, a close means the
 * person holding the ticket did the work. Until 9 Oct 2026 an approved /
 * auto-assigned decision minted a `basic` row at once and promoted at 3 and 5
 * assignments; one person got 13 of 20 new-hire tickets in a day and was
 * "advanced" a minute after the skill existed.
 *
 * How it counts. The count is read from the tickets table every time: closed
 * tickets this person holds in this category. Nothing is stored per credit, so
 * a ticket that is reopened and closed again, or that the sync reports closed
 * twice, is still one ticket. The level is whatever the count supports
 * (COMPETENCY_LEARNING.thresholds), never above `maxAutoLevel`, and never
 * below the level the row already has.
 */
export const COMPETENCY_LEARNING = Object.freeze({
  // Closed tickets by that person in that category needed for each level.
  thresholds: Object.freeze({ basic: 1, intermediate: 10, advanced: 25 }),
  // Expert stays a human decision; the learner stops here.
  maxAutoLevel: 'advanced',
  // The matrix (amber dot) and the review list find learner rows by this
  // prefix on `notes`. A human edit drops it, which is how a row is confirmed.
  notesPrefix: 'Auto-created',
  createdNote: 'Auto-created from closed tickets',
  // resolved_by_kind values that mean nobody closed it by hand.
  automationResolvedKinds: Object.freeze(['workflow', 'api', 'automation', 'auto_help']),
  // Run decisions that mean the AI's pick is the person on the ticket.
  aiAssignedDecisions: Object.freeze(['auto_assigned', 'approved']),
});

export const PROFICIENCY_LEVELS = Object.freeze(['basic', 'intermediate', 'advanced', 'expert']);
const LEVEL_ORDER = Object.freeze({ basic: 1, intermediate: 2, advanced: 3, expert: 4 });
// What a row of each level should have behind it. Expert has no learner
// threshold; for the review list it is held to the advanced bar.
const EXPECTED_CLOSED = Object.freeze({
  ...COMPETENCY_LEARNING.thresholds,
  expert: COMPETENCY_LEARNING.thresholds.advanced,
});
const MAX_BULK_IDS = 500;

/** The level a count of closed tickets supports, or null below the first bar. */
export function levelForClosedCount(count) {
  const n = Number(count) || 0;
  const { thresholds } = COMPETENCY_LEARNING;
  if (n >= thresholds.advanced) return 'advanced';
  if (n >= thresholds.intermediate) return 'intermediate';
  if (n >= thresholds.basic) return 'basic';
  return null;
}

export function isLearnedNote(notes) {
  return typeof notes === 'string' && notes.startsWith(COMPETENCY_LEARNING.notesPrefix);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanIds(ids) {
  if (!Array.isArray(ids)) throw new ValidationError('ids must be an array of skill ids');
  const clean = Array.from(new Set(ids.map(positiveInt).filter(Boolean)));
  if (clean.length === 0) throw new ValidationError('ids must name at least one skill');
  if (clean.length > MAX_BULK_IDS) throw new ValidationError(`At most ${MAX_BULK_IDS} skills per request`);
  return clean;
}

async function terminalStatusNames(workspaceId) {
  // Retired custom statuses still sit on old tickets: include inactive rows.
  const rows = await Promise.resolve()
    .then(() => statusService.listStatuses(workspaceId, { includeInactive: true }))
    .catch(() => []);
  const names = (Array.isArray(rows) ? rows : [])
    .filter((row) => TERMINAL_BASE_STATUSES.includes(row.baseStatus))
    .map((row) => row.name);
  return Array.from(new Set([...names, ...TERMINAL_BASE_STATUSES]));
}

class CompetencyFeedbackService {
  /**
   * Assignment decisions no longer teach the matrix (QA 10-09 item 12). Kept
   * so an older caller is harmless; it reads and writes nothing.
   */
  async processDecisionFeedback() {
    return { learned: false, reason: 'learning_happens_on_close' };
  }

  /**
   * Closed tickets per (person, category, subcategory) — the ONE definition of
   * "a closed ticket that counts", used by the learner and by the review list:
   *   - the ticket sits in a Resolved/Closed-base status of the workspace;
   *   - somebody holds it;
   *   - it is not noise, not a duplicate (reason or duplicate_of link);
   *   - it was not closed by automation (workflow, API, Auto-help).
   * `aiAssigned` = of those, the ones the AI put on that same person
   * (auto-assigned, or its pick approved). One grouped query; no photo, no
   * ticket rows.
   */
  async closedTicketEvidence(workspaceId, technicianIds, categoryIds) {
    const techIds = Array.from(new Set((technicianIds || []).map(positiveInt).filter(Boolean)));
    const catIds = Array.from(new Set((categoryIds || []).map(positiveInt).filter(Boolean)));
    if (techIds.length === 0 || catIds.length === 0) return [];
    const statuses = await terminalStatusNames(workspaceId);
    const automation = [...COMPETENCY_LEARNING.automationResolvedKinds];
    const aiDecisions = [...COMPETENCY_LEARNING.aiAssignedDecisions];
    const rows = await prisma.$queryRaw`
      SELECT t.assigned_tech_id AS "technicianId",
             t.internal_category_id AS "categoryId",
             t.internal_subcategory_id AS "subcategoryId",
             COUNT(*)::int AS "closed",
             (COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM assignment_pipeline_runs r
               WHERE r.ticket_id = t.id
                 AND r.assigned_tech_id = t.assigned_tech_id
                 AND r.decision = ANY(${aiDecisions}::text[])
             )))::int AS "aiAssigned"
      FROM tickets t
      WHERE t.workspace_id = ${Number(workspaceId)}
        AND t.assigned_tech_id = ANY(${techIds}::int[])
        AND t.status = ANY(${statuses}::text[])
        AND t.is_noise = false
        AND (t.resolution_reason IS NULL OR t.resolution_reason <> 'duplicate')
        AND (t.resolved_by_kind IS NULL OR NOT (t.resolved_by_kind = ANY(${automation}::text[])))
        AND NOT EXISTS (
          SELECT 1 FROM ticket_links l WHERE l.ticket_id = t.id AND l.kind = 'duplicate_of'
        )
        AND (t.internal_category_id = ANY(${catIds}::int[]) OR t.internal_subcategory_id = ANY(${catIds}::int[]))
      GROUP BY t.assigned_tech_id, t.internal_category_id, t.internal_subcategory_id
    `;
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      technicianId: Number(row.technicianId),
      categoryId: positiveInt(row.categoryId),
      subcategoryId: positiveInt(row.subcategoryId),
      closed: Number(row.closed) || 0,
      aiAssigned: Number(row.aiAssigned) || 0,
    }));
  }

  /**
   * Fold the grouped rows into a lookup. A ticket in subcategory S of
   * category P is a closed ticket in S and in P.
   */
  _evidenceLookup(rows) {
    const map = new Map();
    const add = (techId, catId, row) => {
      if (!catId) return;
      const key = `${techId}:${catId}`;
      const cur = map.get(key) || { closed: 0, aiAssigned: 0 };
      cur.closed += row.closed;
      cur.aiAssigned += row.aiAssigned;
      map.set(key, cur);
    };
    for (const row of rows) {
      add(row.technicianId, row.categoryId, row);
      if (row.subcategoryId && row.subcategoryId !== row.categoryId) add(row.technicianId, row.subcategoryId, row);
    }
    return (techId, catId) => map.get(`${techId}:${catId}`) || { closed: 0, aiAssigned: 0 };
  }

  /**
   * A ticket reached a Resolved/Closed status: credit the person holding it in
   * the ticket's internal subcategory (or category when it has none). Never
   * throws — a skipped credit is caught up by that person's next close, since
   * the level is always read from the count.
   */
  async processTicketClosed(ticketId, workspaceId) {
    const id = positiveInt(ticketId);
    if (!id) return { learned: false, reason: 'no_ticket' };
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id },
        select: {
          id: true,
          workspaceId: true,
          status: true,
          isNoise: true,
          assignedTechId: true,
          resolvedByKind: true,
          resolutionReason: true,
          internalCategoryId: true,
          internalSubcategoryId: true,
          assignedTech: { select: { id: true, workspaceId: true, isActive: true, assignableOnly: true } },
        },
      });
      if (!ticket) return { learned: false, reason: 'no_ticket' };
      const wsId = positiveInt(ticket.workspaceId) || positiveInt(workspaceId);
      const skip = (reason) => {
        logger.debug('Skills learner: no credit', { ticketId: id, workspaceId: wsId, reason });
        return { learned: false, reason };
      };

      if (!ticket.assignedTechId || !ticket.assignedTech) return skip('unassigned');
      if (ticket.isNoise) return skip('noise');
      if (ticket.resolutionReason === 'duplicate') return skip('duplicate');
      if (COMPETENCY_LEARNING.automationResolvedKinds.includes(String(ticket.resolvedByKind || ''))) {
        return skip('closed_by_automation');
      }
      const tech = ticket.assignedTech;
      // "Other teams" people are assignable but not on the team (isActive is
      // false for them too): they never enter the skills matrix.
      if (tech.assignableOnly === true) return skip('assignable_only');
      if (tech.isActive === false) return skip('inactive_technician');
      if (tech.workspaceId && wsId && Number(tech.workspaceId) !== wsId) return skip('other_workspace');

      const targetCategoryId = positiveInt(ticket.internalSubcategoryId) || positiveInt(ticket.internalCategoryId);
      if (!targetCategoryId) return skip('no_category');

      // Per-workspace switch. Off = the matrix changes only by human edits.
      const config = await prisma.assignmentConfig.findUnique({
        where: { workspaceId: wsId },
        select: { competencyFeedbackEnabled: true },
      });
      if (config && config.competencyFeedbackEnabled === false) return skip('learning_disabled');

      const terminal = await terminalStatusNames(wsId);
      const statusNow = String(ticket.status || '').trim().toLowerCase();
      if (!terminal.some((name) => String(name).toLowerCase() === statusNow)) return skip('not_closed');

      const category = await prisma.competencyCategory.findFirst({
        where: { id: targetCategoryId, workspaceId: wsId, isActive: true },
        select: { id: true, name: true },
      });
      if (!category) return skip('no_category');

      const duplicateLink = await Promise.resolve()
        .then(() => prisma.ticketLink.findFirst({ where: { ticketId: id, kind: 'duplicate_of' }, select: { id: true } }))
        .catch(() => null);
      if (duplicateLink) return skip('duplicate');

      const evidence = await this.closedTicketEvidence(wsId, [tech.id], [category.id]);
      const { closed } = this._evidenceLookup(evidence)(tech.id, category.id);
      const earned = levelForClosedCount(closed);
      if (!earned) return skip('below_first_threshold');

      const existing = await prisma.technicianCompetency.findUnique({
        where: { technicianId_competencyCategoryId: { technicianId: tech.id, competencyCategoryId: category.id } },
      });

      if (!existing) {
        try {
          await prisma.technicianCompetency.create({
            data: {
              technicianId: tech.id,
              workspaceId: wsId,
              competencyCategoryId: category.id,
              proficiencyLevel: earned,
              notes: COMPETENCY_LEARNING.createdNote,
            },
          });
        } catch (error) {
          // Two closes at once: the other one created the row.
          if (error?.code === 'P2002') return skip('already_created');
          throw error;
        }
        logger.info('Skills learner: skill added from closed tickets', {
          ticketId: id, workspaceId: wsId, techId: tech.id, category: category.name, level: earned, closed,
        });
        return { learned: true, action: 'created', level: earned, closed };
      }

      // Never demote, never touch a level a person set at or above what the
      // count supports (expert included — the learner cannot reach it).
      if ((LEVEL_ORDER[existing.proficiencyLevel] || 0) >= LEVEL_ORDER[earned]) return skip('level_already_held');
      // A level a person set, or a learned row a person confirmed, is theirs:
      // the learner only raises rows it created and nobody has reviewed yet.
      if (!isLearnedNote(existing.notes)) return skip('set_by_person');

      await prisma.technicianCompetency.update({
        where: { id: existing.id },
        data: { proficiencyLevel: earned },
      });
      logger.info('Skills learner: skill promoted from closed tickets', {
        ticketId: id, workspaceId: wsId, techId: tech.id, category: category.name,
        from: existing.proficiencyLevel, to: earned, closed,
      });
      return { learned: true, action: 'promoted', from: existing.proficiencyLevel, level: earned, closed };
    } catch (error) {
      logger.warn('Skills learner failed (non-blocking)', { ticketId: id, error: error.message });
      return { learned: false, reason: 'error' };
    }
  }

  // ─── Admin review of learned skills ──────────────────────────────────────

  /**
   * Every skill the system added in this workspace, with what is behind it.
   * Sorted weakest evidence first: closed tickets relative to what the row's
   * level asks for, so "advanced on 2 tickets" comes before "basic on 4".
   */
  async listLearnedSkills(workspaceId) {
    const wsId = Number(workspaceId);
    const [rows, config] = await Promise.all([
      prisma.technicianCompetency.findMany({
        where: { workspaceId: wsId, notes: { startsWith: COMPETENCY_LEARNING.notesPrefix } },
        select: {
          id: true,
          technicianId: true,
          competencyCategoryId: true,
          proficiencyLevel: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
          technician: { select: { id: true, name: true, email: true, isActive: true, assignableOnly: true } },
          competencyCategory: {
            select: { id: true, name: true, parentId: true, isActive: true, parent: { select: { id: true, name: true } } },
          },
        },
      }),
      Promise.resolve()
        .then(() => prisma.assignmentConfig.findUnique({ where: { workspaceId: wsId }, select: { competencyFeedbackEnabled: true } }))
        .catch(() => null),
    ]);

    const evidence = await this.closedTicketEvidence(
      wsId,
      rows.map((row) => row.technicianId),
      rows.map((row) => row.competencyCategoryId),
    );
    const lookup = this._evidenceLookup(evidence);

    const items = rows.map((row) => {
      const { closed, aiAssigned } = lookup(row.technicianId, row.competencyCategoryId);
      const expected = EXPECTED_CLOSED[row.proficiencyLevel] || COMPETENCY_LEARNING.thresholds.basic;
      return {
        id: row.id,
        level: row.proficiencyLevel,
        notes: row.notes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        technician: {
          id: row.technician?.id ?? row.technicianId,
          name: row.technician?.name || null,
          email: row.technician?.email || null,
          isActive: row.technician?.isActive !== false,
          assignableOnly: row.technician?.assignableOnly === true,
        },
        category: {
          id: row.competencyCategory?.id ?? row.competencyCategoryId,
          name: row.competencyCategory?.name || null,
          parentId: row.competencyCategory?.parentId ?? null,
          parentName: row.competencyCategory?.parent?.name || null,
          isActive: row.competencyCategory?.isActive !== false,
        },
        evidence: {
          closed,
          aiAssigned,
          expectedForLevel: expected,
          belowBar: closed < expected,
        },
      };
    });

    const ratio = (item) => item.evidence.closed / Math.max(1, item.evidence.expectedForLevel);
    items.sort((a, b) => (
      ratio(a) - ratio(b)
      || (LEVEL_ORDER[b.level] || 0) - (LEVEL_ORDER[a.level] || 0)
      || a.evidence.closed - b.evidence.closed
      || a.id - b.id
    ));

    return {
      items,
      total: items.length,
      belowBar: items.filter((item) => item.evidence.belowBar).length,
      thresholds: { ...COMPETENCY_LEARNING.thresholds },
      levels: [...PROFICIENCY_LEVELS],
      learningEnabled: !(config && config.competencyFeedbackEnabled === false),
    };
  }

  _confirmedNote(actorEmail) {
    const who = String(actorEmail || '').trim() || 'an admin';
    return `Confirmed by ${who} on ${new Date().toISOString().slice(0, 10)} (first added from closed tickets)`;
  }

  /** Keep: the row stays, the auto-created marker goes — a person chose it. */
  async keepLearnedSkills(workspaceId, ids, actorEmail) {
    const clean = cleanIds(ids);
    const result = await prisma.technicianCompetency.updateMany({
      where: { id: { in: clean }, workspaceId: Number(workspaceId), notes: { startsWith: COMPETENCY_LEARNING.notesPrefix } },
      data: { notes: this._confirmedNote(actorEmail) },
    });
    logger.info('Learned skills kept', { workspaceId: Number(workspaceId), by: actorEmail || null, requested: clean.length, kept: result.count });
    return { kept: result.count, requested: clean.length };
  }

  /** Remove: delete the row. Only rows the system added can go this way. */
  async removeLearnedSkills(workspaceId, ids, actorEmail) {
    const clean = cleanIds(ids);
    const result = await prisma.technicianCompetency.deleteMany({
      where: { id: { in: clean }, workspaceId: Number(workspaceId), notes: { startsWith: COMPETENCY_LEARNING.notesPrefix } },
    });
    logger.info('Learned skills removed', { workspaceId: Number(workspaceId), by: actorEmail || null, requested: clean.length, removed: result.count });
    return { removed: result.count, requested: clean.length };
  }

  /**
   * Set the level by hand. A person picking the level is a person confirming
   * the skill (same rule as an edit in the matrix), so the marker goes too.
   */
  async setLearnedSkillLevel(workspaceId, id, level, actorEmail) {
    const skillId = positiveInt(id);
    if (!skillId) throw new ValidationError('Invalid skill id');
    const next = String(level || '').trim().toLowerCase();
    if (!PROFICIENCY_LEVELS.includes(next)) {
      throw new ValidationError(`level must be one of: ${PROFICIENCY_LEVELS.join(', ')}`);
    }
    const row = await prisma.technicianCompetency.findFirst({
      where: { id: skillId, workspaceId: Number(workspaceId), notes: { startsWith: COMPETENCY_LEARNING.notesPrefix } },
      select: { id: true, proficiencyLevel: true },
    });
    if (!row) throw new NotFoundError('Learned skill not found in this workspace');
    const updated = await prisma.technicianCompetency.update({
      where: { id: row.id },
      data: { proficiencyLevel: next, notes: this._confirmedNote(actorEmail) },
      select: { id: true, proficiencyLevel: true, notes: true },
    });
    logger.info('Learned skill level set', {
      workspaceId: Number(workspaceId), by: actorEmail || null, id: row.id, from: row.proficiencyLevel, to: next,
    });
    return { id: updated.id, level: updated.proficiencyLevel, from: row.proficiencyLevel };
  }
}

export default new CompetencyFeedbackService();
