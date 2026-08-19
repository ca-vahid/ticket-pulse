import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError, ValidationError } from '../utils/errors.js';
// Flag-split assignment (Phase PA): CANONICAL set — gates 2-level hierarchy
// SEMANTICS (subcategory-only AI suggestions, parent-competency inference).
// Pure DB behavior; applies to every canonical-taxonomy workspace.
import { isCanonicalCategoryWorkspace } from '../utils/workspaceFeatureFlags.js';

function categoryOrder() {
  return [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }];
}

function buildCategoryTree(categories = []) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, subcategories: [] }]));
  const roots = [];

  for (const category of byId.values()) {
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId).subcategories.push(category);
    } else {
      roots.push(category);
    }
  }

  const sort = (a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name);
  roots.sort(sort);
  for (const root of roots) {
    root.subcategories.sort(sort);
  }
  return roots;
}

const LEVEL_RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
const RANK_LEVEL = { 1: 'basic', 2: 'intermediate', 3: 'advanced' };

function normalizeCompetencyMapping(mapping = {}) {
  const competencyCategoryId = Number(mapping.competencyCategoryId);
  if (!Number.isInteger(competencyCategoryId)) return null;
  const proficiencyLevel = LEVEL_RANK[mapping.proficiencyLevel] ? mapping.proficiencyLevel : 'intermediate';
  return {
    competencyCategoryId,
    proficiencyLevel,
    notes: mapping.notes || null,
  };
}

function inferParentCompetenciesForSkillHierarchy(competencies = [], categories = []) {
  const normalized = (competencies || [])
    .map(normalizeCompetencyMapping)
    .filter(Boolean);
  const categoryById = new Map(categories.map((category) => [Number(category.id), category]));
  const existingIds = new Set(normalized.map((mapping) => mapping.competencyCategoryId));
  const childrenByParent = new Map();

  for (const mapping of normalized) {
    const category = categoryById.get(mapping.competencyCategoryId);
    if (!category?.parentId) continue;
    const parentId = Number(category.parentId);
    if (!categoryById.has(parentId)) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(mapping);
  }

  const inferred = [];
  for (const [parentId, childMappings] of childrenByParent.entries()) {
    if (existingIds.has(parentId)) continue;
    const level2OrHigher = childMappings.filter((mapping) => (LEVEL_RANK[mapping.proficiencyLevel] || 0) >= 2).length;
    const level3OrHigher = childMappings.filter((mapping) => (LEVEL_RANK[mapping.proficiencyLevel] || 0) >= 3).length;
    const inferredRank = level3OrHigher >= 2 ? 3 : level2OrHigher >= 2 ? 2 : 1;
    inferred.push({
      competencyCategoryId: parentId,
      proficiencyLevel: RANK_LEVEL[inferredRank],
      notes: 'Auto-inferred from subcategory competencies; facilitator override wins.',
    });
  }

  return [...normalized, ...inferred];
}

/** True when the error is a unique violation of the per-parent category name
 *  indexes (competency_categories_ws_name_toplevel_key /
 *  competency_categories_ws_parent_name_key — raw partial indexes; Prisma
 *  still raises P2002 with meta.target = DB column names, verified locally on
 *  Prisma 5.22). */
function isCategoryNameConflict(error) {
  return error?.code === 'P2002';
}

/** Friendly duplicate-name error, scoped the way the constraint is scoped. */
async function categoryNameConflictError(name, parentId, db = prisma) {
  if (parentId) {
    const parent = await db.competencyCategory
      .findUnique({ where: { id: parentId }, select: { name: true } })
      .catch(() => null);
    return new ValidationError(`Subcategory "${name}" already exists under "${parent?.name || 'this category'}"`);
  }
  return new ValidationError(`Category "${name}" already exists in this workspace`);
}

class CompetencyRepository {
  // ─── Categories ───────────────────────────────────────────────────────

  async getCategories(workspaceId) {
    try {
      return await prisma.competencyCategory.findMany({
        where: { workspaceId },
        orderBy: categoryOrder(),
      });
    } catch (error) {
      logger.error('Error fetching competency categories:', error);
      throw new DatabaseError('Failed to fetch competency categories', error);
    }
  }

  async getActiveCategories(workspaceId) {
    try {
      return await prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        orderBy: categoryOrder(),
      });
    } catch (error) {
      logger.error('Error fetching active competency categories:', error);
      throw new DatabaseError('Failed to fetch active competency categories', error);
    }
  }

  async getSystemSuggestedCategories(workspaceId) {
    try {
      return await prisma.competencyCategory.findMany({
        where: {
          workspaceId,
          isActive: false,
          isSystemSuggested: true,
          ...(isCanonicalCategoryWorkspace(workspaceId) ? { parentId: { not: null } } : {}),
        },
        include: {
          parent: { select: { id: true, name: true, isActive: true } },
          subcategories: {
            where: { isActive: false, isSystemSuggested: true },
            select: { id: true, name: true, description: true, createdAt: true },
            orderBy: categoryOrder(),
          },
        },
        orderBy: categoryOrder(),
      });
    } catch (error) {
      logger.error('Error fetching system-suggested competency categories:', error);
      throw new DatabaseError('Failed to fetch suggested competency categories', error);
    }
  }

  buildCategoryTree(categories) {
    return buildCategoryTree(categories);
  }

  /**
   * Every category row (active AND inactive) with usage counts, for the admin
   * category manager. Counts come from three groupBy queries — never N+1.
   * FROZEN CONTRACT (frontend CompetencyManager): [{ id, name, description,
   * parentId, parentName, isActive, source, sortOrder, isSystemSuggested,
   * createdAt, updatedAt, ticketCount, techCount, childCount }].
   */
  async getCategoriesDetailed(workspaceId) {
    try {
      const [rows, techCounts, categoryTicketCounts, subcategoryTicketCounts, childCounts] = await Promise.all([
        prisma.competencyCategory.findMany({
          where: { workspaceId },
          orderBy: categoryOrder(),
        }),
        prisma.technicianCompetency.groupBy({
          by: ['competencyCategoryId'],
          where: { workspaceId },
          _count: { _all: true },
        }),
        prisma.ticket.groupBy({
          by: ['internalCategoryId'],
          where: { workspaceId, internalCategoryId: { not: null } },
          _count: { _all: true },
        }),
        prisma.ticket.groupBy({
          by: ['internalSubcategoryId'],
          where: { workspaceId, internalSubcategoryId: { not: null } },
          _count: { _all: true },
        }),
        prisma.competencyCategory.groupBy({
          by: ['parentId'],
          where: { workspaceId, parentId: { not: null } },
          _count: { _all: true },
        }),
      ]);

      const nameById = new Map(rows.map((row) => [row.id, row.name]));
      const techByCategory = new Map(techCounts.map((row) => [row.competencyCategoryId, row._count._all]));
      const ticketsAsCategory = new Map(categoryTicketCounts.map((row) => [row.internalCategoryId, row._count._all]));
      const ticketsAsSubcategory = new Map(subcategoryTicketCounts.map((row) => [row.internalSubcategoryId, row._count._all]));
      const childrenByParent = new Map(childCounts.map((row) => [row.parentId, row._count._all]));

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        parentId: row.parentId,
        parentName: row.parentId ? nameById.get(row.parentId) ?? null : null,
        isActive: row.isActive,
        source: row.source,
        sortOrder: row.sortOrder,
        isSystemSuggested: row.isSystemSuggested,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // A row is referenced via internal_category_id (top-level) or
        // internal_subcategory_id (sub); the columns are disjoint per level so
        // the sum is that row's ticket usage.
        ticketCount: (ticketsAsCategory.get(row.id) || 0) + (ticketsAsSubcategory.get(row.id) || 0),
        techCount: techByCategory.get(row.id) || 0,
        childCount: childrenByParent.get(row.id) || 0,
      }));
    } catch (error) {
      logger.error('Error fetching detailed competency categories:', error);
      throw new DatabaseError('Failed to fetch detailed competency categories', error);
    }
  }

  async validateParent(workspaceId, parentId, categoryId = null) {
    if (parentId === undefined || parentId === null || parentId === '') return null;
    const parsedParentId = Number(parentId);
    if (!Number.isInteger(parsedParentId)) {
      throw new ValidationError('parentId must be a category id or null');
    }
    if (categoryId && parsedParentId === Number(categoryId)) {
      throw new ValidationError('A category cannot be its own parent');
    }

    const parent = await prisma.competencyCategory.findUnique({ where: { id: parsedParentId } });
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new ValidationError('Parent category must belong to this workspace');
    }
    if (parent.parentId) {
      throw new ValidationError('Only two category levels are supported; subcategories cannot have children');
    }
    return parsedParentId;
  }

  async getCategoryById(id) {
    try {
      const category = await prisma.competencyCategory.findUnique({ where: { id } });
      if (!category) throw new NotFoundError(`Competency category ${id} not found`);
      return category;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error fetching competency category:', error);
      throw new DatabaseError('Failed to fetch competency category', error);
    }
  }

  async createCategory(workspaceId, data) {
    let parentId = null;
    try {
      parentId = await this.validateParent(workspaceId, data.parentId);
      return await prisma.competencyCategory.create({
        data: {
          workspaceId,
          name: data.name,
          description: data.description ?? null,
          parentId,
          isActive: data.isActive ?? true,
          isSystemSuggested: data.isSystemSuggested ?? false,
          source: data.source || 'manual',
          sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
        },
      });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      if (isCategoryNameConflict(error)) {
        throw await categoryNameConflictError(data.name, parentId);
      }
      logger.error('Error creating competency category:', error);
      throw new DatabaseError('Failed to create competency category', error);
    }
  }

  async updateCategory(id, data) {
    let effectiveParentId;
    let effectiveName;
    try {
      const current = await prisma.competencyCategory.findUnique({ where: { id } });
      if (!current) throw new NotFoundError(`Competency category ${id} not found`);

      let parentId;
      if (data.parentId !== undefined) {
        parentId = await this.validateParent(current.workspaceId, data.parentId, id);
        if (parentId) {
          const childCount = await prisma.competencyCategory.count({ where: { parentId: id } });
          if (childCount > 0) {
            throw new ValidationError('A category with subcategories cannot be moved under another parent');
          }
        }
      }

      // For the conflict message and the rename side-effect we need the row's
      // level/name AFTER this update.
      effectiveParentId = data.parentId !== undefined ? parentId : current.parentId;
      effectiveName = data.name !== undefined ? data.name : current.name;
      const nameChanged = data.name !== undefined && data.name !== current.name;

      return await prisma.$transaction(async (tx) => {
        const updated = await tx.competencyCategory.update({
          where: { id },
          data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && { description: data.description }),
            ...(data.isActive !== undefined && { isActive: data.isActive }),
            ...(data.parentId !== undefined && { parentId }),
            ...(data.isSystemSuggested !== undefined && { isSystemSuggested: data.isSystemSuggested }),
            ...(data.source !== undefined && { source: data.source || 'manual' }),
            ...(data.sortOrder !== undefined && { sortOrder: Number(data.sortOrder) || 0 }),
          },
        });

        // Renames must follow through to the denormalized name strings that
        // ticket sync writes onto tickets (ticketService keeps tpSkill /
        // tpSubskill in lockstep on categorization edits) — otherwise the old
        // name lingers on every already-categorized ticket. Bounded: one
        // updateMany per rename, scoped by the FK column for this level.
        if (nameChanged) {
          if (updated.parentId) {
            await tx.ticket.updateMany({
              where: { workspaceId: current.workspaceId, internalSubcategoryId: id },
              data: { tpSubskill: updated.name },
            });
          } else {
            await tx.ticket.updateMany({
              where: { workspaceId: current.workspaceId, internalCategoryId: id },
              data: { tpSkill: updated.name },
            });
          }
        }

        return updated;
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) throw error;
      if (isCategoryNameConflict(error)) {
        throw await categoryNameConflictError(effectiveName, effectiveParentId);
      }
      logger.error('Error updating competency category:', error);
      throw new DatabaseError('Failed to update competency category', error);
    }
  }

  async deleteCategory(id) {
    try {
      // Deleting a category in use is destructive far beyond the row itself:
      // subcategories are orphaned (parent_id -> NULL), tickets lose their
      // internal_category_id (SET NULL), and technician competencies are
      // CASCADE-deleted. This orphaned 4.4k Accounting tickets in July 2026 —
      // block instead, and point at the safe alternatives.
      const [childCount, ticketCount] = await Promise.all([
        prisma.competencyCategory.count({ where: { parentId: id } }),
        prisma.ticket.count({
          where: { OR: [{ internalCategoryId: id }, { internalSubcategoryId: id }] },
        }),
      ]);
      if (childCount > 0) {
        throw new ValidationError(
          `This category has ${childCount} subcategor${childCount === 1 ? 'y' : 'ies'}. Move or delete them first — deleting the parent would orphan them.`,
        );
      }
      if (ticketCount > 0) {
        throw new ValidationError(
          `${ticketCount} ticket${ticketCount === 1 ? ' is' : 's are'} categorized under this category. Deactivate it instead (it disappears from pickers but keeps ticket history), or merge it into another category first.`,
        );
      }
      return await prisma.competencyCategory.delete({ where: { id } });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      logger.error('Error deleting competency category:', error);
      throw new DatabaseError('Failed to delete competency category', error);
    }
  }

  async reviewSystemSuggestedCategory(workspaceId, id, action, data = {}) {
    try {
      const categoryId = Number(id);
      if (!Number.isInteger(categoryId)) throw new ValidationError('Category id is required');
      const current = await prisma.competencyCategory.findUnique({
        where: { id: categoryId },
        include: { subcategories: { select: { id: true, isActive: true, isSystemSuggested: true } } },
      });
      if (!current || current.workspaceId !== workspaceId) {
        throw new NotFoundError(`Suggested category ${id} not found`);
      }
      if (current.isActive || !current.isSystemSuggested) {
        throw new ValidationError('Only inactive AI-suggested categories can be reviewed here');
      }

      if (action === 'approve') {
        const requestedParentId = data.parentId !== undefined ? data.parentId : current.parentId;
        if (isCanonicalCategoryWorkspace(workspaceId) && !requestedParentId) {
          throw new ValidationError('IT category review can approve new subcategories only; choose an existing parent category');
        }
        return await this.updateCategory(categoryId, {
          name: data.name?.trim() || current.name,
          description: data.description !== undefined ? data.description : current.description,
          parentId: requestedParentId,
          isActive: true,
          isSystemSuggested: false,
          source: 'technician_analysis_approved',
        });
      }

      if (action === 'reject') {
        return await prisma.$transaction(async (tx) => {
          const childIds = current.subcategories
            .filter((child) => !child.isActive && child.isSystemSuggested)
            .map((child) => child.id);
          if (childIds.length > 0) {
            await tx.competencyCategory.deleteMany({
              where: { workspaceId, id: { in: childIds }, isActive: false, isSystemSuggested: true },
            });
          }
          await tx.competencyCategory.delete({ where: { id: categoryId } });
          return { id: categoryId, action: 'rejected', deletedChildren: childIds.length };
        });
      }

      if (action === 'merge') {
        const targetId = Number(data.targetCategoryId);
        if (!Number.isInteger(targetId)) throw new ValidationError('targetCategoryId is required for merge');
        if (targetId === categoryId) throw new ValidationError('Suggested category cannot be merged into itself');
        const target = await prisma.competencyCategory.findUnique({ where: { id: targetId } });
        if (!target || target.workspaceId !== workspaceId || !target.isActive) {
          throw new ValidationError('Merge target must be an active category in this workspace');
        }
        const childIds = current.subcategories
          .filter((child) => !child.isActive && child.isSystemSuggested)
          .map((child) => child.id);
        if (childIds.length > 0 && target.parentId) {
          throw new ValidationError('A suggested category with subcategories can only merge into a top-level category');
        }

        return await prisma.$transaction(async (tx) => {
          if (childIds.length > 0) {
            await tx.competencyCategory.updateMany({
              where: { workspaceId, id: { in: childIds }, isActive: false, isSystemSuggested: true },
              data: { parentId: target.id },
            });
          }
          await tx.competencyCategory.delete({ where: { id: categoryId } });
          return {
            id: categoryId,
            action: 'merged',
            targetCategoryId: target.id,
            movedChildren: childIds.length,
          };
        });
      }

      throw new ValidationError('action must be approve, reject, or merge');
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) throw error;
      logger.error('Error reviewing system-suggested competency category:', error);
      throw new DatabaseError('Failed to review suggested competency category', error);
    }
  }

  // ─── Technician Competencies ──────────────────────────────────────────

  async getTechnicianCompetencies(technicianId, workspaceId) {
    try {
      return await prisma.technicianCompetency.findMany({
        where: { technicianId, workspaceId, competencyCategory: { isActive: true } },
        include: { competencyCategory: true },
        orderBy: { competencyCategory: { name: 'asc' } },
      });
    } catch (error) {
      logger.error('Error fetching technician competencies:', error);
      throw new DatabaseError('Failed to fetch technician competencies', error);
    }
  }

  async getAllCompetenciesForWorkspace(workspaceId) {
    try {
      return await prisma.technicianCompetency.findMany({
        where: { workspaceId, competencyCategory: { isActive: true } },
        include: {
          technician: { select: { id: true, name: true, email: true, location: true, isActive: true } },
          competencyCategory: true,
        },
      });
    } catch (error) {
      logger.error('Error fetching all competencies for workspace:', error);
      throw new DatabaseError('Failed to fetch workspace competencies', error);
    }
  }

  async upsertTechnicianCompetency(technicianId, workspaceId, competencyCategoryId, proficiencyLevel, notes) {
    try {
      return await prisma.$transaction(async (tx) => {
        const competency = await tx.technicianCompetency.upsert({
          where: {
            technicianId_competencyCategoryId: { technicianId, competencyCategoryId },
          },
          create: {
            technicianId,
            workspaceId,
            competencyCategoryId,
            proficiencyLevel,
            notes,
          },
          update: {
            proficiencyLevel,
            notes,
          },
        });

        if (isCanonicalCategoryWorkspace(workspaceId)) {
          const categories = await tx.competencyCategory.findMany({
            where: { workspaceId, isActive: true },
            select: { id: true, parentId: true },
          });
          const existing = await tx.technicianCompetency.findMany({
            where: { technicianId, workspaceId, competencyCategory: { isActive: true } },
            select: { competencyCategoryId: true, proficiencyLevel: true, notes: true },
          });
          const existingIds = new Set(existing.map((mapping) => mapping.competencyCategoryId));
          const inferred = inferParentCompetenciesForSkillHierarchy(existing, categories)
            .filter((mapping) => !existingIds.has(mapping.competencyCategoryId));
          if (inferred.length > 0) {
            await tx.technicianCompetency.createMany({
              data: inferred.map((mapping) => ({
                technicianId,
                workspaceId,
                competencyCategoryId: mapping.competencyCategoryId,
                proficiencyLevel: mapping.proficiencyLevel,
                notes: mapping.notes,
              })),
              skipDuplicates: true,
            });
          }
        }

        return competency;
      });
    } catch (error) {
      logger.error('Error upserting technician competency:', error);
      throw new DatabaseError('Failed to upsert technician competency', error);
    }
  }

  async bulkUpdateTechnicianCompetencies(technicianId, workspaceId, competencies) {
    try {
      return await prisma.$transaction(async (tx) => {
        const requestedCategoryIds = Array.from(new Set((competencies || [])
          .map((c) => Number(c.competencyCategoryId))
          .filter((id) => Number.isInteger(id))));
        const allActiveCategories = await tx.competencyCategory.findMany({
          where: { workspaceId, isActive: true },
          select: { id: true, parentId: true },
        });
        const activeCategories = allActiveCategories.filter((category) => requestedCategoryIds.includes(category.id));
        const activeIds = new Set(activeCategories.map((category) => category.id));
        const activeCompetencies = (competencies || []).filter((c) => activeIds.has(Number(c.competencyCategoryId)));
        const competenciesToSave = isCanonicalCategoryWorkspace(workspaceId)
          ? inferParentCompetenciesForSkillHierarchy(activeCompetencies, allActiveCategories)
          : activeCompetencies.map(normalizeCompetencyMapping).filter(Boolean);
        if (activeCompetencies.length !== (competencies || []).length) {
          logger.warn('Skipped inactive or cross-workspace competency mappings during bulk update', {
            technicianId,
            workspaceId,
            requested: competencies?.length || 0,
            applied: activeCompetencies.length,
          });
        }

        await tx.technicianCompetency.deleteMany({ where: { technicianId, workspaceId } });

        if (competenciesToSave.length === 0) return [];

        return await tx.technicianCompetency.createMany({
          data: competenciesToSave.map((c) => ({
            technicianId,
            workspaceId,
            competencyCategoryId: c.competencyCategoryId,
            proficiencyLevel: c.proficiencyLevel || 'intermediate',
            notes: c.notes || null,
          })),
        });
      });
    } catch (error) {
      logger.error('Error bulk updating technician competencies:', error);
      throw new DatabaseError('Failed to bulk update technician competencies', error);
    }
  }

  async deleteTechnicianCompetency(technicianId, competencyCategoryId) {
    try {
      return await prisma.technicianCompetency.delete({
        where: {
          technicianId_competencyCategoryId: { technicianId, competencyCategoryId },
        },
      });
    } catch (error) {
      logger.error('Error deleting technician competency:', error);
      throw new DatabaseError('Failed to delete technician competency', error);
    }
  }

  async getTechniciansWithCompetency(workspaceId, competencyCategoryId) {
    try {
      return await prisma.technicianCompetency.findMany({
        where: { workspaceId, competencyCategoryId },
        include: {
          technician: { select: { id: true, name: true, email: true, location: true, isActive: true } },
        },
        orderBy: { proficiencyLevel: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching technicians with competency:', error);
      throw new DatabaseError('Failed to fetch technicians with competency', error);
    }
  }
  /**
   * Merge categories into keepId. Same-level only: merging subcategories
   * remaps ticket.internalSubcategoryId, merging top-level categories remaps
   * ticket.internalCategoryId and re-parents child rows onto keepId. Sub
   * merges additionally require the SAME parent unless the caller explicitly
   * passes { allowCrossParent: true } (the admin route never does).
   *
   * Deliberately NOT remapped (stale ids degrade gracefully): QuickNote
   * .internalCategoryIds and TicketTemplate.internalCategoryId/SubcategoryId
   * keep pointing at the deleted row — quick notes fall back to
   * "shown everywhere"/hidden scoping and templates simply stop pre-filling
   * the category, both easy to re-point in Settings → Ticket Ops. Same for
   * TicketWatchSubscription / AgentAlertSubscription category filters, which
   * just stop matching.
   */
  async mergeCategories(workspaceId, keepId, mergeIds, options = {}) {
    const LEVEL_ORDER = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };

    try {
      const rows = await prisma.competencyCategory.findMany({
        where: { workspaceId, id: { in: [keepId, ...mergeIds] } },
        select: { id: true, name: true, parentId: true },
      });
      const keep = rows.find((row) => row.id === keepId);
      if (!keep) throw new ValidationError('Merge target not found in this workspace');
      const mergeRows = rows.filter((row) => mergeIds.includes(row.id));
      if (mergeRows.length !== mergeIds.length) {
        throw new ValidationError('All categories being merged must belong to this workspace');
      }
      if (mergeRows.some((row) => row.id === keepId)) {
        throw new ValidationError('A category cannot be merged into itself');
      }

      const keepIsSub = keep.parentId !== null;
      const wrongLevel = mergeRows.find((row) => (row.parentId !== null) !== keepIsSub);
      if (wrongLevel) {
        throw new ValidationError(
          `"${wrongLevel.name}" and "${keep.name}" are not at the same level — top-level categories and subcategories cannot be merged together`,
        );
      }
      if (keepIsSub && options.allowCrossParent !== true) {
        const crossParent = mergeRows.find((row) => row.parentId !== keep.parentId);
        if (crossParent) {
          throw new ValidationError(
            `"${crossParent.name}" lives under a different parent than "${keep.name}" — move it first, or merge within one parent`,
          );
        }
      }

      if (!keepIsSub) {
        // Re-parenting children of the merged categories onto keepId can
        // collide with the per-parent unique name index — surface that as a
        // clear pre-check instead of a mid-transaction failure.
        const [keepChildren, mergeChildren] = await Promise.all([
          prisma.competencyCategory.findMany({ where: { parentId: keepId }, select: { name: true } }),
          prisma.competencyCategory.findMany({ where: { parentId: { in: mergeIds } }, select: { name: true } }),
        ]);
        const seen = new Set(keepChildren.map((child) => child.name.toLowerCase()));
        for (const child of mergeChildren) {
          const key = child.name.toLowerCase();
          if (seen.has(key)) {
            throw new ValidationError(
              `Subcategory "${child.name}" exists under both "${keep.name}" and a category being merged — merge or rename those subcategories first`,
            );
          }
          seen.add(key);
        }
      }

      return await prisma.$transaction(async (tx) => {
        const merging = await tx.technicianCompetency.findMany({
          where: { workspaceId, competencyCategoryId: { in: mergeIds } },
        });

        for (const comp of merging) {
          const existing = await tx.technicianCompetency.findUnique({
            where: { technicianId_competencyCategoryId: { technicianId: comp.technicianId, competencyCategoryId: keepId } },
          });

          if (existing) {
            const existingLevel = LEVEL_ORDER[existing.proficiencyLevel] || 0;
            const mergingLevel = LEVEL_ORDER[comp.proficiencyLevel] || 0;
            if (mergingLevel > existingLevel) {
              await tx.technicianCompetency.update({
                where: { id: existing.id },
                data: { proficiencyLevel: comp.proficiencyLevel },
              });
            }
          } else {
            await tx.technicianCompetency.create({
              data: {
                technicianId: comp.technicianId,
                workspaceId,
                competencyCategoryId: keepId,
                proficiencyLevel: comp.proficiencyLevel,
                notes: comp.notes,
              },
            });
          }
        }

        await tx.technicianCompetency.deleteMany({
          where: { competencyCategoryId: { in: mergeIds } },
        });

        // Remap tickets BEFORE deleting the merged rows — the FKs are
        // ON DELETE SET NULL, so skipping this silently orphaned tickets
        // (the July 2026 Accounting incident class).
        if (keepIsSub) {
          await tx.ticket.updateMany({
            where: { workspaceId, internalSubcategoryId: { in: mergeIds } },
            data: {
              internalSubcategoryId: keepId,
              internalCategoryId: keep.parentId,
              tpSubskill: keep.name,
            },
          });
        } else {
          await tx.ticket.updateMany({
            where: { workspaceId, internalCategoryId: { in: mergeIds } },
            data: { internalCategoryId: keepId, tpSkill: keep.name },
          });
          // Children of the merged categories move under keepId (name
          // collisions were pre-checked above). Their tickets keep their
          // internalSubcategoryId but must follow to the new parent.
          await tx.competencyCategory.updateMany({
            where: { workspaceId, parentId: { in: mergeIds } },
            data: { parentId: keepId },
          });
        }

        // Category→group routing links: move to keepId, skipping ones the
        // keep category already has ((workspaceId, categoryId, groupId) is
        // unique). Row counts are tiny, so per-row handling is fine.
        const [keepLinks, mergeLinks] = await Promise.all([
          tx.categoryGroupLink.findMany({ where: { workspaceId, categoryId: keepId }, select: { groupId: true } }),
          tx.categoryGroupLink.findMany({ where: { workspaceId, categoryId: { in: mergeIds } } }),
        ]);
        const linkedGroupIds = new Set(keepLinks.map((link) => link.groupId.toString()));
        for (const link of mergeLinks) {
          const groupKey = link.groupId.toString();
          if (linkedGroupIds.has(groupKey)) {
            await tx.categoryGroupLink.delete({ where: { id: link.id } });
          } else {
            await tx.categoryGroupLink.update({ where: { id: link.id }, data: { categoryId: keepId } });
            linkedGroupIds.add(groupKey);
          }
        }

        await tx.competencyCategory.deleteMany({
          where: { id: { in: mergeIds }, workspaceId },
        });

        const remaining = await tx.competencyCategory.findMany({
          where: { workspaceId },
          orderBy: categoryOrder(),
        });

        return { merged: mergeIds.length, remaining: remaining.length, categories: remaining };
      });
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) throw error;
      logger.error('Error merging competency categories:', error);
      throw new DatabaseError('Failed to merge competency categories', error);
    }
  }
}

export { buildCategoryTree, inferParentCompetenciesForSkillHierarchy };
export default new CompetencyRepository();
