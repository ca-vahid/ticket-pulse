import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError, ValidationError } from '../utils/errors.js';

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
        where: { workspaceId, isActive: false, isSystemSuggested: true },
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
    try {
      const parentId = await this.validateParent(workspaceId, data.parentId);
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
      if (error.code === 'P2002') {
        throw new DatabaseError(`Category "${data.name}" already exists in this workspace`);
      }
      logger.error('Error creating competency category:', error);
      throw new DatabaseError('Failed to create competency category', error);
    }
  }

  async updateCategory(id, data) {
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

      return await prisma.competencyCategory.update({
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
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) throw error;
      logger.error('Error updating competency category:', error);
      throw new DatabaseError('Failed to update competency category', error);
    }
  }

  async deleteCategory(id) {
    try {
      return await prisma.competencyCategory.delete({ where: { id } });
    } catch (error) {
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
        return await this.updateCategory(categoryId, {
          name: data.name?.trim() || current.name,
          description: data.description !== undefined ? data.description : current.description,
          parentId: data.parentId !== undefined ? data.parentId : current.parentId,
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
      return await prisma.technicianCompetency.upsert({
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
        const activeCategories = requestedCategoryIds.length
          ? await tx.competencyCategory.findMany({
            where: { workspaceId, id: { in: requestedCategoryIds }, isActive: true },
            select: { id: true },
          })
          : [];
        const activeIds = new Set(activeCategories.map((category) => category.id));
        const activeCompetencies = (competencies || []).filter((c) => activeIds.has(Number(c.competencyCategoryId)));
        if (activeCompetencies.length !== (competencies || []).length) {
          logger.warn('Skipped inactive or cross-workspace competency mappings during bulk update', {
            technicianId,
            workspaceId,
            requested: competencies?.length || 0,
            applied: activeCompetencies.length,
          });
        }

        await tx.technicianCompetency.deleteMany({ where: { technicianId, workspaceId } });

        if (activeCompetencies.length === 0) return [];

        return await tx.technicianCompetency.createMany({
          data: activeCompetencies.map((c) => ({
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
  async mergeCategories(workspaceId, keepId, mergeIds) {
    const LEVEL_ORDER = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };

    try {
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
      logger.error('Error merging competency categories:', error);
      throw new DatabaseError('Failed to merge competency categories', error);
    }
  }
}

export default new CompetencyRepository();
