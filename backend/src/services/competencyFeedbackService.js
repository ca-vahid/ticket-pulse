import prisma from './prisma.js';
import { findBestCategoryMatch } from '../utils/categoryMatcher.js';
import logger from '../utils/logger.js';

const LEVEL_ORDER = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
const PROMOTE_THRESHOLDS = { basic: 3, intermediate: 5 };
const NEXT_PROMOTION_LEVEL = { basic: 'intermediate', intermediate: 'advanced' };

class CompetencyFeedbackService {
  /**
   * Process an assignment decision as a competency signal.
   * Strengthens the assigned technician's competency in the ticket's category.
   */
  async processDecisionFeedback(runId, decision, assignedTechId, workspaceId) {
    if (!assignedTechId) return;
    if (decision !== 'approved' && decision !== 'modified' && decision !== 'auto_assigned') return;

    try {
      const run = await prisma.assignmentPipelineRun.findUnique({
        where: { id: runId },
        select: {
          feedbackApplied: true,
          recommendation: true,
          ticket: {
            select: {
              ticketCategory: true,
              category: true,
              internalCategoryId: true,
              internalSubcategoryId: true,
              internalCategory: { select: { id: true, name: true } },
              internalSubcategory: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (!run || run.feedbackApplied) return;

      const targetCategoryId = run.ticket?.internalSubcategoryId || run.ticket?.internalCategoryId || null;
      const ticketCategory = run.ticket?.internalSubcategory?.name
        || run.ticket?.internalCategory?.name
        || run.ticket?.ticketCategory
        || run.ticket?.category
        || run.recommendation?.ticketClassification;
      if (!targetCategoryId && !ticketCategory) {
        logger.debug('Competency feedback: no ticket category to match', { runId });
        return;
      }

      const existingCategories = await prisma.competencyCategory.findMany({
        where: { workspaceId },
        select: { id: true, name: true, parentId: true },
      });

      const directMatch = targetCategoryId ? existingCategories.find((category) => category.id === targetCategoryId) : null;
      const { match } = directMatch ? { match: directMatch } : findBestCategoryMatch(ticketCategory, existingCategories);
      if (!match) {
        logger.debug('Competency feedback: no matching competency category', { runId, ticketCategory });
        return;
      }

      const existing = await prisma.technicianCompetency.findUnique({
        where: { technicianId_competencyCategoryId: { technicianId: assignedTechId, competencyCategoryId: match.id } },
      });

      let newLevel = null;

      if (!existing) {
        await prisma.technicianCompetency.create({
          data: {
            technicianId: assignedTechId,
            workspaceId,
            competencyCategoryId: match.id,
            proficiencyLevel: 'basic',
            notes: 'Auto-created from assignment feedback',
          },
        });
        newLevel = 'basic';
      } else {
        const currentRank = LEVEL_ORDER[existing.proficiencyLevel] || 0;
        if (currentRank >= 3) {
          // Advanced and expert levels need stronger explicit evidence than assignment feedback alone.
          await prisma.assignmentPipelineRun.update({
            where: { id: runId },
            data: { feedbackApplied: true },
          });
          return;
        }

        const recentCount = await this._countRecentApprovals(assignedTechId, match.id, workspaceId, 90);
        const threshold = PROMOTE_THRESHOLDS[existing.proficiencyLevel];

        if (threshold && recentCount >= threshold) {
          const nextLevel = NEXT_PROMOTION_LEVEL[existing.proficiencyLevel];
          if (!nextLevel) {
            await prisma.assignmentPipelineRun.update({
              where: { id: runId },
              data: { feedbackApplied: true },
            });
            return;
          }
          await prisma.technicianCompetency.update({
            where: { id: existing.id },
            data: { proficiencyLevel: nextLevel },
          });
          newLevel = nextLevel;
          logger.info('Competency feedback: promoted', {
            runId, techId: assignedTechId, category: match.name,
            from: existing.proficiencyLevel, to: nextLevel, recentCount,
          });
        }
      }

      await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: { feedbackApplied: true },
      });

      if (newLevel) {
        logger.info('Competency feedback applied', {
          runId, techId: assignedTechId, category: match.name, level: newLevel, decision,
        });
      }
    } catch (error) {
      logger.warn('Competency feedback failed (non-blocking)', { runId, error: error.message });
    }
  }

  async _countRecentApprovals(techId, categoryId, workspaceId, days) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const category = await prisma.competencyCategory.findUnique({
      where: { id: categoryId },
      select: { name: true },
    });

    if (!category) return 0;

    const runs = await prisma.assignmentPipelineRun.findMany({
      where: {
        workspaceId,
        assignedTechId: techId,
        decision: { in: ['approved', 'modified', 'auto_assigned'] },
        feedbackApplied: true,
        createdAt: { gte: since },
      },
      select: {
        recommendation: true,
        ticket: {
          select: {
            ticketCategory: true,
            category: true,
            internalCategoryId: true,
            internalSubcategoryId: true,
            internalCategory: { select: { id: true, name: true } },
            internalSubcategory: { select: { id: true, name: true } },
          },
        },
      },
    });

    const catName = category.name.toLowerCase();
    return runs.filter((r) => {
      if (r.ticket?.internalSubcategoryId === categoryId || r.ticket?.internalCategoryId === categoryId) return true;
      const tc = (
        r.ticket?.internalSubcategory?.name
        || r.ticket?.internalCategory?.name
        || r.ticket?.ticketCategory
        || r.ticket?.category
        || r.recommendation?.ticketClassification
        || ''
      ).toLowerCase();
      return tc.includes(catName) || catName.includes(tc);
    }).length;
  }
}

export default new CompetencyFeedbackService();
