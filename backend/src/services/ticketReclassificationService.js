import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import prisma from './prisma.js';
import { DEFAULT_RECLASSIFICATION_MODEL, normalizeAnthropicModel } from '../utils/anthropicModels.js';
import { isSkillHierarchyWorkspace } from '../utils/workspaceFeatureFlags.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 25;
const DEFAULT_DAYS = 180;
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 20;

function clampInteger(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function normalizeFit(value) {
  return ['exact', 'weak', 'none'].includes(value) ? value : null;
}

function cleanSuggestion(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 120) : null;
}

function cleanSnippet(value, maxLength = 3500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildCategoryTree(categories = []) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, subcategories: [] }]));
  const roots = [];
  for (const category of byId.values()) {
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId).subcategories.push({
        id: category.id,
        name: category.name,
        description: category.description || null,
      });
    } else {
      roots.push(category);
    }
  }
  const sort = (a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
  return roots.sort(sort).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description || null,
    subcategories: category.subcategories.sort(sort),
  }));
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty classification response');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (objectMatch) return JSON.parse(objectMatch[0]);
    throw new Error('Classification response was not valid JSON');
  }
}

function snapshotTicketClassification(ticket) {
  return {
    id: ticket.id,
    freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
    subject: ticket.subject || null,
    internalCategoryId: ticket.internalCategoryId,
    internalSubcategoryId: ticket.internalSubcategoryId,
    internalCategoryConfidence: ticket.internalCategoryConfidence,
    internalCategoryRationale: ticket.internalCategoryRationale,
    internalCategoryFit: ticket.internalCategoryFit,
    internalSubcategoryFit: ticket.internalSubcategoryFit,
    taxonomyReviewNeeded: ticket.taxonomyReviewNeeded,
    suggestedInternalCategoryName: ticket.suggestedInternalCategoryName,
    suggestedInternalSubcategoryName: ticket.suggestedInternalSubcategoryName,
    updatedAt: ticket.updatedAt?.toISOString?.() || ticket.updatedAt || null,
  };
}

class TicketReclassificationService {
  async run(workspaceId, options = {}) {
    if (!isSkillHierarchyWorkspace(workspaceId)) {
      throw new ValidationError('Ticket reclassification is enabled only for the IT category/subcategory migration workspace');
    }
    const apply = options.apply === true;
    const applyFromPreview = apply && Array.isArray(options.previewResults) && options.previewResults.length > 0;
    if (!applyFromPreview && !config.anthropic.apiKey) {
      throw new ValidationError('ANTHROPIC_API_KEY not configured');
    }

    const days = clampInteger(options.days, DEFAULT_DAYS, 365);
    const limit = clampInteger(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const model = normalizeAnthropicModel(
      options.model || config.anthropic.reclassificationModel,
      DEFAULT_RECLASSIFICATION_MODEL,
    );
    const concurrency = clampInteger(options.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
    const actorEmail = options.actorEmail || null;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const categories = await prisma.competencyCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, description: true, parentId: true, sortOrder: true },
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (categories.length === 0) {
      throw new ValidationError('No active category hierarchy is published for this workspace');
    }

    const previewByTicketId = new Map((options.previewResults || [])
      .map((result) => [Number(result.ticketId), result])
      .filter(([ticketId]) => Number.isInteger(ticketId)));
    const effectiveOptions = applyFromPreview && previewByTicketId.size > 0
      ? { ...options, ticketIds: [...previewByTicketId.keys()] }
      : options;
    const ticketWhere = this._buildTicketWhere(workspaceId, since, effectiveOptions);
    const tickets = await prisma.ticket.findMany({
      where: ticketWhere,
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        descriptionText: true,
        description: true,
        priority: true,
        status: true,
        category: true,
        subCategory: true,
        ticketCategory: true,
        tpSkill: true,
        tpSubskill: true,
        internalCategoryId: true,
        internalSubcategoryId: true,
        internalCategoryConfidence: true,
        internalCategoryRationale: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        taxonomyReviewNeeded: true,
        suggestedInternalCategoryName: true,
        suggestedInternalSubcategoryName: true,
        createdAt: true,
        updatedAt: true,
        assignedTech: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const requested = {
      days,
      limit,
      model,
      concurrency,
      technicianId: options.technicianId || null,
      onlyNeedsReview: options.onlyNeedsReview !== false,
      createdBefore: options.createdBefore || null,
      ticketIds: Array.isArray(options.ticketIds) ? options.ticketIds.length : 0,
      previewResults: applyFromPreview ? previewByTicketId.size : 0,
      applyFromPreview,
    };
    const beforeSnapshot = tickets.map(snapshotTicketClassification);
    const auditRun = await prisma.ticketReclassificationRun.create({
      data: {
        workspaceId,
        status: 'running',
        mode: apply ? 'apply' : 'dry_run',
        actorEmail,
        request: requested,
        beforeSnapshot,
      },
      select: { id: true },
    });

    const categoryTree = buildCategoryTree(categories);
    const byId = new Map(categories.map((category) => [category.id, category]));
    let results = [];

    try {
      if (applyFromPreview) {
        results = await mapWithConcurrency(tickets, concurrency, async (ticket) => {
          const startedAt = Date.now();
          const preview = previewByTicketId.get(ticket.id);
          try {
            if (!preview?.classification) {
              throw new Error('No preview classification supplied for this ticket');
            }
            const normalized = this._normalizeRecommendation(preview.classification, byId);
            await this._persist(ticket.id, workspaceId, normalized);
            return {
              ticketId: ticket.id,
              freshserviceTicketId: Number(ticket.freshserviceTicketId),
              subject: ticket.subject,
              createdAt: ticket.createdAt,
              applied: true,
              model: preview.model || model,
              source: 'preview',
              durationMs: Date.now() - startedAt,
              classification: normalized,
            };
          } catch (error) {
            logger.warn('Preview ticket reclassification apply failed for ticket', {
              workspaceId,
              ticketId: ticket.id,
              freshserviceTicketId: String(ticket.freshserviceTicketId),
              error: error.message,
            });
            return {
              ticketId: ticket.id,
              freshserviceTicketId: Number(ticket.freshserviceTicketId),
              subject: ticket.subject,
              createdAt: ticket.createdAt,
              applied: false,
              model: preview?.model || model,
              source: 'preview',
              durationMs: Date.now() - startedAt,
              error: error.message,
            };
          }
        });
      } else {
        const client = new Anthropic({ apiKey: config.anthropic.apiKey });
        results = await mapWithConcurrency(tickets, concurrency, async (ticket) => {
          const startedAt = Date.now();
          try {
            const recommendation = await this._classifyTicket(client, model, categoryTree, ticket);
            const normalized = this._normalizeRecommendation(recommendation, byId);
            if (apply) {
              await this._persist(ticket.id, workspaceId, normalized);
            }
            return {
              ticketId: ticket.id,
              freshserviceTicketId: Number(ticket.freshserviceTicketId),
              subject: ticket.subject,
              createdAt: ticket.createdAt,
              applied: apply,
              model,
              durationMs: Date.now() - startedAt,
              classification: normalized,
            };
          } catch (error) {
            logger.warn('Ticket reclassification failed for ticket', {
              workspaceId,
              ticketId: ticket.id,
              freshserviceTicketId: String(ticket.freshserviceTicketId),
              error: error.message,
            });
            return {
              ticketId: ticket.id,
              freshserviceTicketId: Number(ticket.freshserviceTicketId),
              subject: ticket.subject,
              createdAt: ticket.createdAt,
              applied: false,
              model,
              durationMs: Date.now() - startedAt,
              error: error.message,
            };
          }
        });
      }

      const classified = results.filter((result) => result.classification?.internalCategoryId).length;
      const reviewNeeded = results.filter((result) => result.classification?.taxonomyReviewNeeded).length;
      const failed = results.filter((result) => result.error).length;
      const afterSnapshot = apply
        ? await this._snapshotTickets(workspaceId, tickets.map((ticket) => ticket.id))
        : beforeSnapshot;
      const summary = {
        scanned: tickets.length,
        classified,
        reviewNeeded,
        failed,
        model,
        concurrency,
        applyFromPreview,
      };
      await prisma.ticketReclassificationRun.update({
        where: { id: auditRun.id },
        data: {
          status: 'completed',
          summary,
          results,
          afterSnapshot,
        },
      });

      return {
        id: auditRun.id,
        workspaceId,
        dryRun: !apply,
        applied: apply,
        requested,
        model,
        concurrency,
        scanned: tickets.length,
        classified,
        reviewNeeded,
        failed,
        results,
        note: 'Internal-only reclassification: updates Ticket Pulse classification columns only when apply=true. It never writes historical Freshservice tickets.',
      };
    } catch (error) {
      await prisma.ticketReclassificationRun.update({
        where: { id: auditRun.id },
        data: {
          status: 'failed',
          errorMessage: error.message,
          results,
        },
      });
      throw error;
    }
  }

  _buildTicketWhere(workspaceId, since, options = {}) {
    const where = { workspaceId, createdAt: { gte: since } };
    if (options.createdBefore) {
      const createdBefore = new Date(options.createdBefore);
      if (!Number.isNaN(createdBefore.getTime())) {
        where.createdAt = { ...where.createdAt, lt: createdBefore };
      }
    }
    if (options.technicianId) where.assignedTechId = Number(options.technicianId);
    if (Array.isArray(options.ticketIds) && options.ticketIds.length > 0) {
      where.id = { in: options.ticketIds.map((id) => Number(id)).filter(Number.isInteger) };
    }
    if (options.onlyNeedsReview !== false && !where.id) {
      where.OR = [
        { internalCategoryId: null },
        { taxonomyReviewNeeded: true },
        { internalCategoryFit: { in: ['weak', 'none'] } },
        { internalSubcategoryFit: { in: ['weak', 'none'] } },
      ];
    }
    return where;
  }

  async _classifyTicket(client, model, categoryTree, ticket) {
    const response = await client.messages.create({
      model,
      max_tokens: 1200,
      temperature: 0,
      system: `Classify one IT helpdesk ticket into the existing Ticket Pulse category/subcategory hierarchy.

Rules:
- Use only categoryId/subcategoryId values from the supplied hierarchy.
- Prefer an exact subcategory when one clearly fits.
- Use parent category only when no specific subcategory fits.
- Freshservice category fields and old custom fields are raw evidence only.
- If no existing category or subcategory fits cleanly, choose the closest usable parent if possible, set weak/none fit, and provide suggested names for admin review.
- Return JSON only. No markdown.`,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          hierarchy: categoryTree,
          ticket: {
            id: ticket.id,
            freshserviceTicketId: Number(ticket.freshserviceTicketId),
            subject: ticket.subject,
            description: cleanSnippet(ticket.descriptionText || ticket.description),
            status: ticket.status,
            priority: ticket.priority,
            assignedTo: ticket.assignedTech?.name || null,
            rawFreshserviceEvidence: {
              category: ticket.category || null,
              subCategory: ticket.subCategory || null,
              ticketCategory: ticket.ticketCategory || null,
              tpSkill: ticket.tpSkill || null,
              tpSubskill: ticket.tpSubskill || null,
            },
            currentTicketPulseClassification: {
              internalCategoryId: ticket.internalCategoryId,
              internalSubcategoryId: ticket.internalSubcategoryId,
              categoryFit: ticket.internalCategoryFit,
              subcategoryFit: ticket.internalSubcategoryFit,
              reviewNeeded: ticket.taxonomyReviewNeeded,
            },
          },
          outputShape: {
            internalCategoryId: 'number|null',
            internalSubcategoryId: 'number|null',
            categoryFit: 'exact|weak|none',
            subcategoryFit: 'exact|weak|none',
            confidence: 'low|medium|high',
            classificationRationale: 'short explanation',
            suggestedInternalCategoryName: 'string|null',
            suggestedInternalSubcategoryName: 'string|null',
          },
        }),
      }],
    });
    const text = response.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || '';
    return parseJsonObject(text);
  }

  _normalizeRecommendation(recommendation, byId) {
    const categoryId = Number.isInteger(Number(recommendation?.internalCategoryId))
      ? Number(recommendation.internalCategoryId)
      : null;
    const subcategoryId = Number.isInteger(Number(recommendation?.internalSubcategoryId))
      ? Number(recommendation.internalSubcategoryId)
      : null;
    const selectedCategory = categoryId ? byId.get(categoryId) : null;
    const selectedSubcategory = subcategoryId ? byId.get(subcategoryId) : null;

    const normalizedSubcategory = selectedSubcategory?.parentId
      ? selectedSubcategory
      : (selectedCategory?.parentId ? selectedCategory : null);
    const normalizedCategory = selectedCategory?.parentId
      ? byId.get(selectedCategory.parentId)
      : selectedCategory;
    const safeCategoryId = normalizedCategory?.id || normalizedSubcategory?.parentId || null;
    const safeSubcategoryId = normalizedSubcategory?.id || null;
    const categoryFit = normalizeFit(recommendation?.categoryFit) || (safeCategoryId ? 'weak' : 'none');
    const subcategoryFit = normalizeFit(recommendation?.subcategoryFit) || (safeSubcategoryId ? 'weak' : 'none');
    const suggestedInternalCategoryName = cleanSuggestion(recommendation?.suggestedInternalCategoryName);
    const suggestedInternalSubcategoryName = cleanSuggestion(recommendation?.suggestedInternalSubcategoryName);
    const taxonomyReviewNeeded = ['weak', 'none'].includes(categoryFit)
      || ['weak', 'none'].includes(subcategoryFit)
      || Boolean(suggestedInternalCategoryName)
      || Boolean(suggestedInternalSubcategoryName);

    return {
      internalCategoryId: safeCategoryId,
      internalSubcategoryId: safeSubcategoryId,
      categoryName: normalizedCategory?.name || null,
      subcategoryName: normalizedSubcategory?.name || null,
      categoryFit,
      subcategoryFit,
      confidence: ['low', 'medium', 'high'].includes(recommendation?.confidence) ? recommendation.confidence : 'medium',
      classificationRationale: cleanSuggestion(recommendation?.classificationRationale) || 'Historical internal reclassification',
      suggestedInternalCategoryName,
      suggestedInternalSubcategoryName,
      taxonomyReviewNeeded,
    };
  }

  async _persist(ticketId, workspaceId, classification) {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        internalCategoryId: classification.internalCategoryId,
        internalSubcategoryId: classification.internalSubcategoryId,
        internalCategoryConfidence: classification.confidence,
        internalCategoryRationale: classification.classificationRationale,
        internalCategoryFit: classification.categoryFit,
        internalSubcategoryFit: classification.subcategoryFit,
        taxonomyReviewNeeded: classification.taxonomyReviewNeeded,
        suggestedInternalCategoryName: classification.suggestedInternalCategoryName,
        suggestedInternalSubcategoryName: classification.suggestedInternalSubcategoryName,
      },
    });
    logger.info('Ticket internally reclassified', {
      workspaceId,
      ticketId,
      categoryId: classification.internalCategoryId,
      subcategoryId: classification.internalSubcategoryId,
      reviewNeeded: classification.taxonomyReviewNeeded,
    });
  }

  async _snapshotTickets(workspaceId, ticketIds = []) {
    if (!ticketIds.length) return [];
    const tickets = await prisma.ticket.findMany({
      where: { workspaceId, id: { in: ticketIds } },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        internalCategoryId: true,
        internalSubcategoryId: true,
        internalCategoryConfidence: true,
        internalCategoryRationale: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        taxonomyReviewNeeded: true,
        suggestedInternalCategoryName: true,
        suggestedInternalSubcategoryName: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    return tickets.map(snapshotTicketClassification);
  }

  async listRuns(workspaceId, options = {}) {
    const limit = clampInteger(options.limit, 10, 50);
    return await prisma.ticketReclassificationRun.findMany({
      where: { workspaceId },
      select: {
        id: true,
        status: true,
        mode: true,
        actorEmail: true,
        request: true,
        summary: true,
        errorMessage: true,
        rolledBackAt: true,
        rolledBackBy: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async rollback(workspaceId, runId, actorEmail = 'admin') {
    const run = await prisma.ticketReclassificationRun.findFirst({
      where: { id: Number(runId), workspaceId },
      select: {
        id: true,
        mode: true,
        status: true,
        beforeSnapshot: true,
        rolledBackAt: true,
      },
    });
    if (!run) throw new ValidationError('Reclassification run not found');
    if (run.mode !== 'apply') throw new ValidationError('Only applied reclassification runs can be rolled back');
    if (run.status !== 'completed') throw new ValidationError(`Run is not completed (status: ${run.status})`);
    if (run.rolledBackAt) throw new ValidationError('Run has already been rolled back');

    const beforeSnapshot = Array.isArray(run.beforeSnapshot) ? run.beforeSnapshot : [];
    const restored = [];
    await prisma.$transaction(async (tx) => {
      for (const ticket of beforeSnapshot) {
        await tx.ticket.update({
          where: { id: ticket.id },
          data: {
            internalCategoryId: ticket.internalCategoryId,
            internalSubcategoryId: ticket.internalSubcategoryId,
            internalCategoryConfidence: ticket.internalCategoryConfidence,
            internalCategoryRationale: ticket.internalCategoryRationale,
            internalCategoryFit: ticket.internalCategoryFit,
            internalSubcategoryFit: ticket.internalSubcategoryFit,
            taxonomyReviewNeeded: ticket.taxonomyReviewNeeded,
            suggestedInternalCategoryName: ticket.suggestedInternalCategoryName,
            suggestedInternalSubcategoryName: ticket.suggestedInternalSubcategoryName,
          },
        });
        restored.push(ticket.id);
      }
      await tx.ticketReclassificationRun.update({
        where: { id: run.id },
        data: {
          rolledBackAt: new Date(),
          rolledBackBy: actorEmail,
          rollbackResult: { restoredTicketIds: restored, restoredCount: restored.length },
        },
      });
    });

    logger.info('Ticket reclassification run rolled back', {
      workspaceId,
      runId: run.id,
      restoredCount: restored.length,
      actorEmail,
    });
    return { id: run.id, restoredCount: restored.length, restoredTicketIds: restored };
  }
}

export default new TicketReclassificationService();
