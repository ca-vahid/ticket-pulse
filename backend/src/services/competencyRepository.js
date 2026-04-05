import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

class CompetencyRepository {
  // ─── Categories ───────────────────────────────────────────────────────

  async getCategories(workspaceId) {
    try {
      return await prisma.competencyCategory.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
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
        orderBy: { name: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching active competency categories:', error);
      throw new DatabaseError('Failed to fetch active competency categories', error);
    }
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
      return await prisma.competencyCategory.create({
        data: { workspaceId, name: data.name, description: data.description },
      });
    } catch (error) {
      if (error.code === 'P2002') {
        throw new DatabaseError(`Category "${data.name}" already exists in this workspace`);
      }
      logger.error('Error creating competency category:', error);
      throw new DatabaseError('Failed to create competency category', error);
    }
  }

  async updateCategory(id, data) {
    try {
      return await prisma.competencyCategory.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });
    } catch (error) {
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

  // ─── Technician Competencies ──────────────────────────────────────────

  async getTechnicianCompetencies(technicianId, workspaceId) {
    try {
      return await prisma.technicianCompetency.findMany({
        where: { technicianId, workspaceId },
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
        where: { workspaceId },
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
        await tx.technicianCompetency.deleteMany({ where: { technicianId, workspaceId } });

        if (competencies.length === 0) return [];

        return await tx.technicianCompetency.createMany({
          data: competencies.map((c) => ({
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
    const LEVEL_ORDER = { basic: 1, intermediate: 2, expert: 3 };

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
          orderBy: { name: 'asc' },
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
