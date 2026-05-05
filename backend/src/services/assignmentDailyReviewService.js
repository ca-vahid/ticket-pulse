import Anthropic from '@anthropic-ai/sdk';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import appConfig from '../config/index.js';
import availabilityService from './availabilityService.js';
import promptRepository from './promptRepository.js';
import ticketThreadRepository from './ticketThreadRepository.js';
import settingsRepository from './settingsRepository.js';
import {
  DAILY_REVIEW_OUTCOMES,
  DAILY_REVIEW_PRIMARY_TAGS,
  classifyDailyReviewCase,
  isClosedLikeStatus,
} from './dailyReviewDefinitions.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import {
  transformTicketThreadEntries,
  transformTicketConversationEntries,
} from '../integrations/freshserviceTransformer.js';
import { runJobsInPool } from '../utils/parallelPool.js';

const ACTIVE_STATUSES = ['running', 'collecting', 'analyzing'];
const STALE_RUNNING_MS = 30 * 60 * 1000;
const ANALYSIS_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_CASES_FOR_ANALYSIS = 15;
// Bumped from 6 → 12 so we can include both the conversation bodies and the
// most-recent state-change events for a single ticket. The summarizer below
// prioritizes notes/replies (real text) over activity-stream events.
const MAX_THREAD_EXCERPTS = 12;
// Cap conversation excerpt length; long replies eat tokens and rarely add
// signal beyond the first paragraph or two.
const THREAD_EXCERPT_CHARS = 600;
// Conversations endpoint can return hundreds of entries on long-running
// tickets; we only need recent context for daily review.
const MAX_CONVERSATIONS_PER_TICKET = 30;
// Cap on the plaintext description we forward to the LLM. Long descriptions
// (forwarded email chains, monitoring alerts) can be 10k+ chars each; a
// 1500-char head plus the existing thread excerpts gives the LLM the user's
// actual ask without blowing the per-case token budget.
const MAX_DESCRIPTION_CHARS_FOR_LLM = 1500;
const RECOMMENDATION_KIND_CONFIG = [
  { kind: 'prompt', field: 'promptRecommendations' },
  { kind: 'process', field: 'processRecommendations' },
  { kind: 'taxonomy', field: 'taxonomyRecommendations' },
  { kind: 'skill', field: 'skillRecommendations' },
];
const RECOMMENDATION_STATUSES = ['pending', 'approved', 'rejected', 'applied'];
const TAXONOMY_ACTIONS = ['add', 'rename', 'update', 'move', 'merge', 'deprecate'];

class DailyReviewCancelledError extends Error {
  constructor(message = 'Daily review cancelled by user') {
    super(message);
    this.name = 'DailyReviewCancelledError';
  }
}

function reviewDateKey(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function normalizeDateInput(value) {
  if (!value) return null;
  const str = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function truncate(text, max = 280) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}...` : normalized;
}

function buildDailyReviewCategoryTree(categories = []) {
  const byId = new Map(categories.map((category) => [category.id, { ...category, subcategories: [] }]));
  const roots = [];
  const sort = (a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);

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

  return roots.sort(sort).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description || null,
    subcategories: category.subcategories.sort(sort),
  }));
}

// Strip HTML tags + collapse whitespace. FreshService conversation bodies
// are HTML; bodyText is a best-effort plaintext rendering but is sometimes
// missing on older entries, so we fall back to stripping bodyHtml ourselves.
function stripHtml(text) {
  if (!text) return null;
  return String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(\r?\n)?/gi, ' ')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6])[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeJsonForPostgres(value) {
  if (typeof value === 'string') {
    return value
      // Prisma/Postgres JSONB writes can choke on FreshService text that
      // contains Windows/network paths such as C:\Users or \\server\x. The
      // path syntax is evidence only, so normalize backslashes before the
      // JSON payload crosses the DB boundary.
      .replace(/\\/g, '/')
      // Iterate by code point so valid emoji/supplementary chars remain
      // intact. Lone surrogate halves can appear when older code truncated a
      // string mid-emoji; PostgreSQL JSON rejects those as bad unicode escapes.
      .split(/(?=.)/u)
      .map((char) => {
        const code = char.codePointAt(0);
        if (code === 0) return '';
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) return ' ';
        if (code >= 0xD800 && code <= 0xDFFF) return '';
        return char;
      })
      .join('');
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonForPostgres(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeJsonForPostgres(key), sanitizeJsonForPostgres(item)]),
    );
  }

  return value;
}

function toPct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function bucketCounts(items, getKey, limit = 5) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function recommendationText(item = {}) {
  return [
    item.title,
    item.rationale,
    item.suggestedAction,
    item.categoryName,
    item.parentCategoryName,
    item.newName,
    ...(Array.isArray(item.skillsAffected) ? item.skillsAffected : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

class AssignmentDailyReviewService {
  constructor() {
    this.activeRunControllers = new Map();
    this.kickoffLocks = new Map();
  }

  _throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw new DailyReviewCancelledError();
    }
  }

  _isCancellationError(error) {
    return error instanceof DailyReviewCancelledError
      || error?.name === 'DailyReviewCancelledError'
      || error?.name === 'APIUserAbortError';
  }

  async _analyzeDatasetWithTimeout(workspaceId, dataset, llmModel, parentSignal) {
    const analysisAbortController = new AbortController();
    let timedOut = false;
    const abortFromParent = () => analysisAbortController.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      analysisAbortController.abort();
    }, ANALYSIS_TIMEOUT_MS);

    if (parentSignal?.aborted) {
      clearTimeout(timeout);
      throw new DailyReviewCancelledError();
    }
    parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });

    try {
      return await this._analyzeDataset(workspaceId, dataset, llmModel, {
        signal: analysisAbortController.signal,
      });
    } catch (error) {
      if (timedOut && this._isCancellationError(error)) {
        logger.warn('Daily review LLM analysis timed out; falling back to heuristic recommendations', {
          workspaceId,
          reviewDate: dataset.reviewDate,
          timeoutMs: ANALYSIS_TIMEOUT_MS,
        });
        const heuristic = this._buildHeuristicRecommendations(dataset);
        heuristic.warnings.push(`LLM analysis timed out after ${Math.round(ANALYSIS_TIMEOUT_MS / 60000)} minutes; heuristic recommendations were used instead.`);
        return heuristic;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  _validateRecommendationStatus(status) {
    if (!RECOMMENDATION_STATUSES.includes(status)) {
      throw new Error(`Invalid recommendation status: ${status}`);
    }
  }

  _validateRecommendationKind(kind) {
    if (!['prompt', 'process', 'taxonomy', 'skill', 'all'].includes(kind)) {
      throw new Error(`Invalid recommendation kind: ${kind}`);
    }
  }

  _isTaxonomyRecommendation(item = {}) {
    const action = item.taxonomyAction || item.metadata?.taxonomy?.taxonomyAction;
    if (action && TAXONOMY_ACTIONS.includes(action)) return true;
    if (action === 'competency_update') return false;

    const text = recommendationText(item);
    const agentSkillSignals = /\b(technician|agent|profile|competenc|proficiency|upgrade|downgrade|level|mapping to technician)\b/.test(text);
    const taxonomySignals = /\b(taxonomy|subcategory|sub-category|category description|category mapping|freshservice mapping|skill list|rename category|merge category|deprecate category)\b/.test(text)
      || /\b(add|create|split|rename|merge|deprecate|remove|update)\b.{0,80}\b(category|subcategory|sub-category)\b/.test(text)
      || /\b(category|subcategory|sub-category)\b.{0,80}\b(add|create|split|rename|merge|deprecate|remove|update|description|mapping)\b/.test(text);

    return taxonomySignals && !agentSkillSignals;
  }

  _splitSkillAndTaxonomyRecommendations(items = []) {
    const skillRecommendations = [];
    const taxonomyRecommendations = [];
    for (const item of toArray(items)) {
      if (this._isTaxonomyRecommendation(item)) taxonomyRecommendations.push(item);
      else skillRecommendations.push(item);
    }
    return { skillRecommendations, taxonomyRecommendations };
  }

  _taxonomyMetadataFromItem(item = {}) {
    const existing = item.metadata?.taxonomy || {};
    const parsed = {};
    const proposalText = String(item.suggestedAction || '').match(/Taxonomy proposal:\s*([^\n]+)/i)?.[1] || '';
    for (const part of proposalText.split(';')) {
      const [rawKey, ...rawValue] = part.split('=');
      const key = rawKey?.trim();
      const value = rawValue.join('=').trim();
      if (key && value) parsed[key] = value;
    }
    const toNumberOrNull = (value) => {
      const numeric = Number(value);
      return Number.isInteger(numeric) ? numeric : null;
    };
    const taxonomyAction = item.taxonomyAction || existing.taxonomyAction || parsed.taxonomyAction || null;
    const categoryId = item.categoryId ?? existing.categoryId ?? toNumberOrNull(parsed.categoryId);
    const categoryName = item.categoryName || existing.categoryName || parsed.categoryName || null;
    const parentCategoryId = item.parentCategoryId ?? existing.parentCategoryId ?? toNumberOrNull(parsed.parentCategoryId);
    const parentCategoryName = item.parentCategoryName || existing.parentCategoryName || parsed.parentCategoryName || null;
    const newName = item.newName || existing.newName || parsed.newName || null;

    if (!taxonomyAction && !categoryId && !categoryName && !parentCategoryId && !parentCategoryName && !newName) {
      return item.metadata || null;
    }

    return {
      ...(item.metadata || {}),
      taxonomy: {
        ...existing,
        taxonomyAction,
        categoryId,
        categoryName,
        parentCategoryId,
        parentCategoryName,
        newName,
      },
    };
  }

  _toRecommendationDto(row) {
    const metadata = row.metadata || {};
    const taxonomy = metadata.taxonomy || {};
    return {
      id: row.id,
      runId: row.runId,
      workspaceId: row.workspaceId,
      reviewDate: row.reviewDate,
      kind: row.kind,
      ordinal: row.ordinal,
      title: row.title,
      severity: row.severity,
      rationale: row.rationale,
      suggestedAction: row.suggestedAction,
      metadata,
      taxonomyAction: taxonomy.taxonomyAction || null,
      categoryId: taxonomy.categoryId ?? null,
      categoryName: taxonomy.categoryName || null,
      parentCategoryId: taxonomy.parentCategoryId ?? null,
      parentCategoryName: taxonomy.parentCategoryName || null,
      newName: taxonomy.newName || null,
      skillsAffected: toArray(row.skillsAffected),
      supportingTicketIds: toArray(row.supportingTicketIds),
      supportingFreshserviceTicketIds: toArray(row.supportingFreshserviceTicketIds),
      status: row.status,
      reviewNotes: row.reviewNotes,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      appliedBy: row.appliedBy,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      run: row.run ? {
        id: row.run.id,
        reviewDate: row.run.reviewDate,
        triggeredBy: row.run.triggeredBy,
        status: row.run.status,
      } : undefined,
    };
  }

  _buildRecommendationCreateData(run, recommendationGroups = {}) {
    const reviewDate = run.reviewDate instanceof Date
      ? run.reviewDate
      : reviewDateKey(String(run.reviewDate).slice(0, 10));
    const rows = [];

    for (const { kind, field } of RECOMMENDATION_KIND_CONFIG) {
      const items = toArray(recommendationGroups[field] ?? run[field]);
      items.forEach((item, index) => {
        const metadata = kind === 'taxonomy' ? this._taxonomyMetadataFromItem(item) : (item.metadata || null);
        const taxonomy = metadata?.taxonomy || {};
        const taxonomyDetails = kind === 'taxonomy'
          ? [
            taxonomy.taxonomyAction ? `taxonomyAction=${taxonomy.taxonomyAction}` : null,
            taxonomy.categoryId ? `categoryId=${taxonomy.categoryId}` : null,
            taxonomy.categoryName ? `categoryName=${taxonomy.categoryName}` : null,
            taxonomy.parentCategoryId ? `parentCategoryId=${taxonomy.parentCategoryId}` : null,
            taxonomy.parentCategoryName ? `parentCategoryName=${taxonomy.parentCategoryName}` : null,
            taxonomy.newName ? `newName=${taxonomy.newName}` : null,
          ].filter(Boolean).join('; ')
          : '';
        const suggestedAction = String(item.suggestedAction || '');
        rows.push({
          workspaceId: run.workspaceId,
          runId: run.id,
          reviewDate,
          kind,
          ordinal: index,
          title: String(item.title || `${kind} recommendation ${index + 1}`),
          severity: String(item.severity || 'low'),
          rationale: String(item.rationale || ''),
          suggestedAction: taxonomyDetails
            ? `${suggestedAction}\n\nTaxonomy proposal: ${taxonomyDetails}`
            : suggestedAction,
          metadata: metadata ? sanitizeJsonForPostgres(metadata) : null,
          skillsAffected: toArray(item.skillsAffected),
          supportingTicketIds: toArray(item.supportingTicketIds),
          supportingFreshserviceTicketIds: toArray(item.supportingFreshserviceTicketIds),
        });
      });
    }

    return rows;
  }

  async _replaceRecommendationsForRun(tx, run, recommendationGroups = {}) {
    const rows = this._buildRecommendationCreateData(run, recommendationGroups);
    await tx.assignmentDailyReviewRecommendation.deleteMany({ where: { runId: run.id } });
    if (rows.length > 0) {
      await tx.assignmentDailyReviewRecommendation.createMany({ data: rows });
    }
  }

  _groupRecommendations(rows = []) {
    const grouped = {
      promptRecommendations: [],
      processRecommendations: [],
      taxonomyRecommendations: [],
      skillRecommendations: [],
      recommendationStatusCounts: {
        pending: 0,
        approved: 0,
        rejected: 0,
        applied: 0,
      },
    };

    for (const row of rows) {
      const dto = this._toRecommendationDto(row);
      if (dto.kind === 'prompt') grouped.promptRecommendations.push(dto);
      if (dto.kind === 'process') grouped.processRecommendations.push(dto);
      if (dto.kind === 'taxonomy') grouped.taxonomyRecommendations.push(dto);
      if (dto.kind === 'skill') grouped.skillRecommendations.push(dto);
      if (grouped.recommendationStatusCounts[dto.status] !== undefined) {
        grouped.recommendationStatusCounts[dto.status] += 1;
      }
    }

    return grouped;
  }

  async _ensureRecommendationRowsForRuns(workspaceId, runs = []) {
    for (const run of runs) {
      if (!run || run.workspaceId !== workspaceId) continue;
      if (ACTIVE_STATUSES.includes(run.status)) continue;
      const existingCount = await prisma.assignmentDailyReviewRecommendation.count({
        where: { runId: run.id },
      });
      if (existingCount > 0) continue;

      const skillSplit = this._splitSkillAndTaxonomyRecommendations(run.skillRecommendations);
      const deterministicTaxonomy = this._buildDeterministicTaxonomyRecommendations({
        cases: toArray(run.evidenceCases),
      });
      const rows = this._buildRecommendationCreateData(run, {
        promptRecommendations: run.promptRecommendations,
        processRecommendations: run.processRecommendations,
        taxonomyRecommendations: this._mergeTaxonomyRecommendations([
          ...skillSplit.taxonomyRecommendations,
          ...deterministicTaxonomy,
        ]),
        skillRecommendations: skillSplit.skillRecommendations,
      });
      if (rows.length === 0) continue;

      await prisma.assignmentDailyReviewRecommendation.createMany({ data: rows });
    }
  }

  async _migrateRecentTaxonomySkillRecommendations(workspaceId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: {
        workspaceId,
        kind: 'skill',
        createdAt: { gte: since },
      },
      orderBy: [{ runId: 'asc' }, { ordinal: 'asc' }],
      take: 500,
    });

    const taxonomyRows = rows.filter((row) => this._isTaxonomyRecommendation({
      title: row.title,
      rationale: row.rationale,
      suggestedAction: row.suggestedAction,
      skillsAffected: toArray(row.skillsAffected),
      metadata: row.metadata || null,
    }));
    if (taxonomyRows.length === 0) return;

    const ordinalsByRun = new Map();
    const existingTaxonomyRows = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: {
        workspaceId,
        kind: 'taxonomy',
        runId: { in: Array.from(new Set(taxonomyRows.map((row) => row.runId))) },
      },
      select: { runId: true, ordinal: true },
    });
    for (const row of existingTaxonomyRows) {
      const current = ordinalsByRun.get(row.runId) ?? -1;
      ordinalsByRun.set(row.runId, Math.max(current, row.ordinal));
    }

    for (const row of taxonomyRows) {
      const nextOrdinal = (ordinalsByRun.get(row.runId) ?? -1) + 1;
      ordinalsByRun.set(row.runId, nextOrdinal);
      await prisma.assignmentDailyReviewRecommendation.update({
        where: { id: row.id },
        data: {
          kind: 'taxonomy',
          ordinal: nextOrdinal,
          metadata: sanitizeJsonForPostgres(row.metadata || this._taxonomyMetadataFromItem({
            suggestedAction: row.suggestedAction,
          })),
        },
      });
    }
  }

  async _ensureRecommendationRowsForWorkspace(workspaceId, { startDate, endDate } = {}) {
    const where = {
      workspaceId,
      status: 'completed',
    };

    if (startDate || endDate) {
      where.reviewDate = {};
      if (startDate) where.reviewDate.gte = reviewDateKey(startDate);
      if (endDate) where.reviewDate.lte = reviewDateKey(endDate);
    }

    const runs = await prisma.assignmentDailyReviewRun.findMany({
      where,
      select: {
        id: true,
        workspaceId: true,
        reviewDate: true,
        evidenceCases: true,
        promptRecommendations: true,
        processRecommendations: true,
        skillRecommendations: true,
      },
      orderBy: { reviewDate: 'desc' },
      take: 500,
    });

    await this._ensureRecommendationRowsForRuns(workspaceId, runs);
  }

  async _markStaleRunsFailed(workspaceId = null) {
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
    const staleRuns = await prisma.assignmentDailyReviewRun.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        status: { in: ACTIVE_STATUSES },
        OR: [
          { progressUpdatedAt: { lt: staleBefore } },
          { progressUpdatedAt: null, updatedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true, createdAt: true, progressUpdatedAt: true, updatedAt: true },
      take: 50,
    });

    const now = new Date();
    for (const staleRun of staleRuns) {
      await prisma.assignmentDailyReviewRun.update({
        where: { id: staleRun.id },
        data: {
          status: 'failed',
          errorMessage: 'Marked stale after 30 minutes without progress; the worker likely stopped before writing a terminal status.',
          totalDurationMs: Math.max(0, now.getTime() - new Date(staleRun.createdAt).getTime()),
          completedAt: now,
          progress: sanitizeJsonForPostgres({
            phase: 'failed',
            percent: 100,
            message: 'Marked stale after 30 minutes without progress. Start a new review to regenerate results.',
            stats: {},
          }),
          progressUpdatedAt: now,
        },
      });
      logger.warn('Marked stale daily review run failed', {
        runId: staleRun.id,
        lastProgressAt: staleRun.progressUpdatedAt || staleRun.updatedAt,
      });
    }

    return staleRuns.length;
  }

  async markStaleRunsFailed(workspaceId = null) {
    return this._markStaleRunsFailed(workspaceId);
  }

  async getRunProgress(id, workspaceId) {
    await this._markStaleRunsFailed(workspaceId);
    const row = await prisma.assignmentDailyReviewRun.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        progress: true,
        progressUpdatedAt: true,
        errorMessage: true,
        completedAt: true,
        totalDurationMs: true,
      },
    });
    if (!row) return null;
    if (row.workspaceId !== workspaceId) {
      const error = new Error('Run belongs to a different workspace');
      error.statusCode = 403;
      throw error;
    }
    return row;
  }

  async _getWorkspaceContext(workspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        defaultTimezone: true,
      },
    });

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const config = await prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: {
        llmModel: true,
        dailyReviewEnabled: true,
        dailyReviewRunHour: true,
        dailyReviewRunMinute: true,
        dailyReviewLookbackDays: true,
      },
    });

    return {
      workspace,
      config,
      timezone: workspace.defaultTimezone || 'America/Los_Angeles',
    };
  }

  async _getBusinessDayRange(workspaceId, dateStr, timezone) {
    const reference = new Date(`${dateStr}T12:00:00.000Z`);
    const zoned = toZonedTime(reference, timezone);
    const dayOfWeek = zoned.getDay();
    const hours = await availabilityService.getBusinessHours(workspaceId);
    const dayConfig = hours.find((entry) => entry.dayOfWeek === dayOfWeek && entry.isEnabled);

    const startTime = dayConfig?.startTime || '00:00';
    const endTime = dayConfig?.endTime || '23:59';
    const startIso = formatInTimeZone(reference, timezone, `yyyy-MM-dd'T'${startTime}:00XXX`);
    const endSuffix = endTime === '23:59' ? ':59.999' : ':00.000';
    const endIso = formatInTimeZone(reference, timezone, `yyyy-MM-dd'T'${endTime}${endSuffix}XXX`);

    return {
      start: new Date(startIso),
      end: new Date(endIso),
      startTime,
      endTime,
      isBusinessDay: !!dayConfig,
      localDate: dateStr,
    };
  }

  _buildDeterministicTaxonomyRecommendations(dataset = {}) {
    const cases = toArray(dataset.cases);
    const flagged = cases.filter((item) => {
      const fit = item.taxonomyFit || {};
      return fit.reviewNeeded
        || ['weak', 'none'].includes(fit.categoryFit)
        || ['weak', 'none'].includes(fit.subcategoryFit)
        || fit.suggestedCategoryName
        || fit.suggestedSubcategoryName;
    });
    if (flagged.length === 0) return [];

    const groups = new Map();
    for (const item of flagged) {
      const fit = item.taxonomyFit || {};
      const category = item.internalCategory || {};
      const parentCategoryName = category.name || item.category || 'Uncategorized';
      const suggestedCategoryName = fit.suggestedCategoryName || null;
      const suggestedSubcategoryName = fit.suggestedSubcategoryName || null;
      const issue = fit.categoryFit === 'none'
        ? 'missing_category'
        : suggestedCategoryName
          ? 'suggested_category'
          : suggestedSubcategoryName
            ? 'suggested_subcategory'
            : fit.categoryFit === 'weak'
              ? 'category_cleanup'
              : fit.subcategoryFit === 'none'
                ? 'missing_subcategory'
                : fit.subcategoryFit === 'weak'
                  ? 'subcategory_cleanup'
                  : 'taxonomy_review';
      const key = [
        category.id || '',
        parentCategoryName,
        issue,
        suggestedCategoryName || '',
        suggestedSubcategoryName || '',
      ].map(normalizeName).join('|');
      if (!groups.has(key)) {
        groups.set(key, {
          issue,
          categoryId: category.id || null,
          categoryName: parentCategoryName,
          suggestedCategoryName,
          suggestedSubcategoryName,
          categoryFit: fit.categoryFit || null,
          subcategoryFit: fit.subcategoryFit || null,
          cases: [],
          rationales: [],
        });
      }
      const group = groups.get(key);
      group.cases.push(item);
      if (fit.rationale && group.rationales.length < 3) group.rationales.push(fit.rationale);
    }

    return Array.from(groups.values())
      .sort((a, b) => b.cases.length - a.cases.length || a.categoryName.localeCompare(b.categoryName))
      .map((group) => {
        const proposedName = group.suggestedSubcategoryName || group.suggestedCategoryName || null;
        const isSubcategory = group.issue.includes('subcategory') || Boolean(group.suggestedSubcategoryName);
        const taxonomyAction = proposedName ? 'add' : 'update';
        const parentCategoryId = isSubcategory ? group.categoryId : null;
        const parentCategoryName = isSubcategory ? group.categoryName : null;
        const targetCategoryId = isSubcategory ? null : group.categoryId;
        const targetCategoryName = isSubcategory
          ? (proposedName || group.categoryName)
          : (proposedName || group.categoryName);
        const title = proposedName
          ? `Review ${proposedName} ${isSubcategory ? `under ${group.categoryName}` : 'as a category'}`
          : `Review taxonomy coverage for ${group.categoryName}`;
        const fitText = [
          group.categoryFit ? `categoryFit=${group.categoryFit}` : null,
          group.subcategoryFit ? `subcategoryFit=${group.subcategoryFit}` : null,
        ].filter(Boolean).join(', ');

        return {
          title,
          severity: group.cases.length >= 3 ? 'high' : 'medium',
          rationale: [
            `${group.cases.length} assignment run${group.cases.length === 1 ? '' : 's'} flagged taxonomy review for ${group.categoryName}.`,
            fitText ? `Observed ${fitText}.` : null,
            group.rationales[0] || null,
          ].filter(Boolean).join(' '),
          suggestedAction: proposedName
            ? `Review whether "${proposedName}" should be added or mapped in the category taxonomy, and adjust nearby category descriptions so future tickets route cleanly.`
            : `Review whether "${group.categoryName}" needs subcategories, description cleanup, or FreshService mapping guidance based on the supporting tickets.`,
          skillsAffected: [group.categoryName, proposedName].filter(Boolean),
          taxonomyAction,
          categoryId: targetCategoryId,
          categoryName: targetCategoryName,
          parentCategoryId,
          parentCategoryName,
          newName: proposedName,
          supportingTicketIds: group.cases.map((item) => item.ticketId).filter(Boolean).slice(0, 10),
          supportingFreshserviceTicketIds: group.cases.map((item) => item.freshserviceTicketId).filter(Boolean).slice(0, 10),
          metadata: {
            taxonomy: {
              source: 'deterministic_assignment_taxonomy_flags',
              issue: group.issue,
              taxonomyAction,
              categoryId: targetCategoryId,
              categoryName: targetCategoryName,
              parentCategoryId,
              parentCategoryName,
              newName: proposedName,
              categoryFit: group.categoryFit,
              subcategoryFit: group.subcategoryFit,
              evidenceRunIds: group.cases.map((item) => item.runId).filter(Boolean).slice(0, 10),
            },
          },
        };
      });
  }

  _mergeTaxonomyRecommendations(items = []) {
    const byKey = new Map();
    for (const item of toArray(items)) {
      const metadata = this._taxonomyMetadataFromItem(item);
      const taxonomy = metadata?.taxonomy || {};
      const key = [
        taxonomy.taxonomyAction || item.taxonomyAction || 'update',
        taxonomy.categoryId || item.categoryId || '',
        taxonomy.categoryName || item.categoryName || '',
        taxonomy.parentCategoryId || item.parentCategoryId || '',
        taxonomy.parentCategoryName || item.parentCategoryName || '',
        taxonomy.newName || item.newName || item.title || '',
      ].map(normalizeName).join('|');
      if (!byKey.has(key)) {
        byKey.set(key, { ...item, metadata });
        continue;
      }
      const existing = byKey.get(key);
      byKey.set(key, {
        ...existing,
        severity: existing.severity === 'high' || item.severity === 'high' ? 'high' : existing.severity || item.severity || 'medium',
        supportingTicketIds: Array.from(new Set([
          ...toArray(existing.supportingTicketIds),
          ...toArray(item.supportingTicketIds),
        ])).slice(0, 10),
        supportingFreshserviceTicketIds: Array.from(new Set([
          ...toArray(existing.supportingFreshserviceTicketIds),
          ...toArray(item.supportingFreshserviceTicketIds),
        ])).slice(0, 10),
      });
    }
    return Array.from(byKey.values());
  }

  async _getReviewWindow(workspaceId, reviewDate, timezone, options = {}) {
    const fallbackDate = reviewDate || formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
    let startDate = normalizeDateInput(options.reviewStartDate || options.startDate) || normalizeDateInput(fallbackDate);
    let endDate = normalizeDateInput(options.reviewEndDate || options.endDate) || startDate;

    if (endDate < startDate) {
      [startDate, endDate] = [endDate, startDate];
    }

    const startRange = await this._getBusinessDayRange(workspaceId, startDate, timezone);
    const endRange = endDate === startDate
      ? startRange
      : await this._getBusinessDayRange(workspaceId, endDate, timezone);

    return {
      dateStr: startDate,
      startDate,
      endDate,
      reviewDateValue: reviewDateKey(startDate),
      range: {
        start: startRange.start,
        end: endRange.end,
        startTime: startRange.startTime,
        endTime: endRange.endTime,
        isBusinessDay: startRange.isBusinessDay || endRange.isBusinessDay,
        localDate: startDate,
        endLocalDate: endDate,
        isRange: startDate !== endDate,
      },
    };
  }

  async _hydrateMissingThreads(workspaceId, tickets = [], options = {}) {
    this._throwIfCancelled(options.signal);
    const forceRefresh = options.forceRefresh === true;

    // We now hydrate two FreshService endpoints per ticket:
    //   - /tickets/:id/activities  → state-change events (assignments, status, workflow runs)
    //   - /tickets/:id/conversations → reply + note BODIES (the actual text)
    // A ticket needs hydration if either source is missing locally. The
    // forceRefresh flag bypasses the cache check so an admin can pull fresh
    // data from FS even when something is already in our DB.
    const ticketsForActivities = forceRefresh
      ? tickets.slice()
      : tickets.filter((t) => (t?.threadCounts?.activities ?? t?._count?.threadEntries ?? 0) === 0);
    const ticketsForConversations = forceRefresh
      ? tickets.slice()
      : tickets.filter((t) => (t?.threadCounts?.conversations ?? 0) === 0);

    const emitProgress = (payload) => {
      try { options.onProgress?.(payload); } catch { /* ignore progress errors */ }
    };

    if (ticketsForActivities.length === 0 && ticketsForConversations.length === 0) {
      emitProgress({
        processed: 0,
        total: 0,
        hydratedActivities: 0,
        hydratedConversations: 0,
        failed: 0,
        message: 'Thread history (activities + conversations) already cached locally for every ticket in this review.',
      });
      return {
        hydratedActivities: 0,
        hydratedConversations: 0,
        activitiesFetched: 0,
        conversationsFetched: 0,
        failed: 0,
        warnings: [],
        perTicket: [],
      };
    }

    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) {
      return {
        hydratedActivities: 0,
        hydratedConversations: 0,
        activitiesFetched: 0,
        conversationsFetched: 0,
        failed: 0,
        warnings: ['FreshService is not configured, so missing ticket threads could not be hydrated.'],
        perTicket: [],
      };
    }

    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
    const activityTicketIds = new Set(ticketsForActivities.map((t) => t.id));
    const conversationTicketIds = new Set(ticketsForConversations.map((t) => t.id));
    const ticketIdsToProcess = Array.from(new Set([
      ...activityTicketIds,
      ...conversationTicketIds,
    ]));
    const ticketById = new Map(tickets.map((t) => [t.id, t]));

    // Build a flat work-queue of independent FS jobs. Activities and
    // conversations on the same ticket hit different endpoints so they can
    // overlap freely; the shared rate limiter (maxConcurrent: 3, 110/min)
    // is the real cap. The previous sequential per-ticket loop only ever
    // had ONE in-flight request, wasting 2/3 of the limiter's budget and
    // turning a ~90s job into a 30+ min slog.
    const jobs = [];
    for (const ticketInternalId of ticketIdsToProcess) {
      const ticket = ticketById.get(ticketInternalId);
      if (!ticket) continue;
      if (activityTicketIds.has(ticket.id)) {
        jobs.push({ ticket, kind: 'activities' });
      }
      if (conversationTicketIds.has(ticket.id)) {
        jobs.push({ ticket, kind: 'conversations' });
      }
    }

    let hydratedActivities = 0;
    let hydratedConversations = 0;
    let activitiesFetched = 0;
    let conversationsFetched = 0;
    let failed = 0;
    const warnings = [];
    const diagByTicketId = new Map();
    const failedTickets = new Set();

    emitProgress({
      processed: 0,
      total: ticketIdsToProcess.length,
      hydratedActivities,
      hydratedConversations,
      failed,
      message: `Hydrating FreshService threads for ${ticketIdsToProcess.length} ticket(s) (activities + conversations${forceRefresh ? ', forced refresh' : ''}).`,
    });

    // Per-job runner. Errors on one job (or even one ticket) are isolated
    // and never abort siblings — only cancellation propagates upward.
    const runJob = async (job) => {
      this._throwIfCancelled(options.signal);
      const { ticket, kind } = job;
      const fsTicketId = Number(ticket.freshserviceTicketId);
      let diag = diagByTicketId.get(ticket.id);
      if (!diag) {
        diag = {
          ticketId: ticket.id,
          freshserviceTicketId: fsTicketId,
          activitiesFetched: 0,
          conversationsFetched: 0,
          activitiesError: null,
          conversationsError: null,
        };
        diagByTicketId.set(ticket.id, diag);
      }

      try {
        if (kind === 'activities') {
          const activities = await client.fetchTicketActivities(fsTicketId);
          this._throwIfCancelled(options.signal);
          if (activities?.length) {
            const entries = transformTicketThreadEntries(activities, { ticketId: ticket.id, workspaceId });
            await ticketThreadRepository.bulkUpsert(entries);
            hydratedActivities += 1;
            activitiesFetched += entries.length;
            diag.activitiesFetched = entries.length;
          }
        } else {
          const conversations = await client.fetchTicketConversations(fsTicketId, {
            maxEntries: MAX_CONVERSATIONS_PER_TICKET,
          });
          this._throwIfCancelled(options.signal);
          if (conversations?.length) {
            const entries = transformTicketConversationEntries(conversations, {
              ticketId: ticket.id,
              workspaceId,
            });
            await ticketThreadRepository.bulkUpsert(entries);
            hydratedConversations += 1;
            conversationsFetched += entries.length;
            diag.conversationsFetched = entries.length;
          }
        }
      } catch (error) {
        if (this._isCancellationError(error)) throw error;
        if (kind === 'activities') {
          diag.activitiesError = error.message;
          warnings.push(`Could not hydrate ACTIVITIES for ticket #${fsTicketId}: ${error.message}`);
        } else {
          diag.conversationsError = error.message;
          warnings.push(`Could not hydrate CONVERSATIONS for ticket #${fsTicketId}: ${error.message}`);
        }
        if (!failedTickets.has(ticket.id)) {
          failedTickets.add(ticket.id);
          failed += 1;
        }
      }
    };

    // Track per-ticket completion (a ticket is "processed" once all of its
    // jobs finish, so the progress counter matches `total = ticket count`).
    const remainingByTicket = new Map();
    for (const job of jobs) {
      remainingByTicket.set(job.ticket.id, (remainingByTicket.get(job.ticket.id) || 0) + 1);
    }
    let processedTickets = 0;
    let lastEmittedProcessed = 0;
    const total = ticketIdsToProcess.length;
    const emitEvery = Math.max(1, Math.floor(total / 20)); // ~5% increments

    const onJobDone = (ticketId) => {
      const left = (remainingByTicket.get(ticketId) || 1) - 1;
      remainingByTicket.set(ticketId, left);
      if (left === 0) {
        processedTickets += 1;
        const shouldEmit = processedTickets === total
          || processedTickets - lastEmittedProcessed >= emitEvery;
        if (shouldEmit) {
          lastEmittedProcessed = processedTickets;
          emitProgress({
            processed: processedTickets,
            total,
            hydratedActivities,
            hydratedConversations,
            failed,
            message: `Hydrating FreshService threads (${processedTickets}/${total}); pulled ${activitiesFetched} activity row(s) + ${conversationsFetched} conversation row(s) so far.`,
          });
        }
      }
    };

    // Worker pool. Pool size > limiter concurrency on purpose so workers
    // refill the limiter's queue without idle gaps. The limiter still
    // enforces maxConcurrent: 3 and 110/min, so we cannot trigger 429
    // storms by oversizing the pool.
    await runJobsInPool(
      jobs,
      async (job) => {
        await runJob(job);
        onJobDone(job.ticket.id);
      },
      {
        poolSize: 8,
        isCancellationError: (err) => this._isCancellationError(err),
        // runJob already routes per-job FS errors into `warnings` /
        // `failedTickets`; this onError catches the unexpected (e.g. a
        // bug in transform/upsert) so the pool stops cleanly without
        // taking the whole review down.
        onError: (error, job) => {
          if (!failedTickets.has(job.ticket.id)) {
            failedTickets.add(job.ticket.id);
            failed += 1;
          }
          warnings.push(`Unexpected error hydrating ticket #${job.ticket?.freshserviceTicketId}: ${error?.message || error}`);
        },
      },
    );

    // Final progress emit so the caller always sees 100% completion.
    if (lastEmittedProcessed < processedTickets) {
      emitProgress({
        processed: processedTickets,
        total,
        hydratedActivities,
        hydratedConversations,
        failed,
        message: `Hydrating FreshService threads (${processedTickets}/${total}); pulled ${activitiesFetched} activity row(s) + ${conversationsFetched} conversation row(s) so far.`,
      });
    }

    const perTicket = ticketIdsToProcess
      .map((tid) => diagByTicketId.get(tid))
      .filter(Boolean);

    return {
      hydratedActivities,
      hydratedConversations,
      activitiesFetched,
      conversationsFetched,
      failed,
      warnings,
      perTicket,
      forceRefresh,
    };
  }

  // Build a per-ticket excerpt list for the LLM. Real conversation bodies
  // (notes / replies) carry the most signal, so we return them first and
  // fill the remaining slots with state-change activity-stream entries for
  // chronological context. Each entry's text is normalized (HTML stripped)
  // and truncated to keep token usage bounded.
  _buildThreadExcerptMap(entries = []) {
    const byTicketId = new Map();
    const buckets = new Map();
    for (const entry of entries) {
      const list = buckets.get(entry.ticketId) || { conversations: [], events: [] };
      const cleanedBody = stripHtml(entry.bodyText || entry.bodyHtml || '');
      const excerptText = truncate(cleanedBody || entry.content || entry.title, THREAD_EXCERPT_CHARS);
      if (!excerptText) {
        buckets.set(entry.ticketId, list);
        continue;
      }
      const projected = {
        id: entry.id,
        source: entry.source,
        eventType: entry.eventType,
        visibility: entry.visibility,
        actorName: entry.actorName || null,
        occurredAt: entry.occurredAt,
        excerpt: excerptText,
      };
      if (entry.source === 'freshservice_conversation') {
        list.conversations.push(projected);
      } else {
        list.events.push(projected);
      }
      buckets.set(entry.ticketId, list);
    }

    for (const [ticketId, list] of buckets.entries()) {
      // Sort each bucket newest first within itself so the freshest reply +
      // freshest state-change event are guaranteed to land in the LLM's
      // context window.
      list.conversations.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      list.events.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      const conversationSlots = Math.min(list.conversations.length, MAX_THREAD_EXCERPTS);
      const eventSlots = Math.max(0, MAX_THREAD_EXCERPTS - conversationSlots);
      const merged = [
        ...list.conversations.slice(0, conversationSlots),
        ...list.events.slice(0, eventSlots),
      ];
      // Re-sort merged result chronologically (oldest → newest) so the
      // model can read the thread in narrative order.
      merged.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
      byTicketId.set(ticketId, merged);
    }
    return byTicketId;
  }

  _buildAssignmentActionMap(assignments = []) {
    const byTicketId = new Map();
    for (const item of assignments) {
      if (!byTicketId.has(item.ticketId)) byTicketId.set(item.ticketId, []);
      byTicketId.get(item.ticketId).push(item);
    }
    return byTicketId;
  }

  _buildEpisodeMap(episodes = []) {
    const byTicketId = new Map();
    for (const item of episodes) {
      if (!byTicketId.has(item.ticketId)) byTicketId.set(item.ticketId, []);
      byTicketId.get(item.ticketId).push(item);
    }
    return byTicketId;
  }

  _summarizeCase(caseItem) {
    const parts = [];
    if (caseItem.category) parts.push(`Category: ${caseItem.category}`);
    if (caseItem.topRecommendation?.techName) parts.push(`Top rec: ${caseItem.topRecommendation.techName}`);
    if (caseItem.finalAssignee?.name) parts.push(`Final assignee: ${caseItem.finalAssignee.name}`);
    if (caseItem.overrideReason) parts.push(`Override: ${truncate(caseItem.overrideReason, 180)}`);
    if (caseItem.decisionNote) parts.push(`Decision note: ${truncate(caseItem.decisionNote, 180)}`);
    if (caseItem.threadExcerpts?.length) {
      parts.push(`Thread: ${caseItem.threadExcerpts.map((excerpt) => excerpt.excerpt).join(' | ')}`);
    }
    return parts.join(' | ');
  }

  async collectDailyDataset(workspaceId, reviewDate, options = {}) {
    const emitProgress = (message, extra = {}) => {
      try {
        options.onProgress?.({
          phase: 'collecting',
          message,
          ...extra,
        });
      } catch {
        /* ignore progress errors */
      }
    };
    const throwIfCancelled = () => this._throwIfCancelled(options.signal);

    const { workspace, config, timezone } = await this._getWorkspaceContext(workspaceId);
    const reviewWindow = await this._getReviewWindow(workspaceId, reviewDate, timezone, options);
    const { dateStr, startDate, endDate, range } = reviewWindow;
    throwIfCancelled();

    const reviewLabel = range.isRange ? `${startDate} to ${endDate}` : dateStr;
    emitProgress(
      `Reviewing ${workspace.name} for ${reviewLabel} in ${timezone} (${range.startTime}-${range.endTime}).`,
      {
        percent: 8,
        stats: {
          workspaceName: workspace.name,
          reviewDate: dateStr,
          reviewStartDate: startDate,
          reviewEndDate: endDate,
          timezone,
          rangeStart: range.start.toISOString(),
          rangeEnd: range.end.toISOString(),
        },
      },
    );

    const runWhere = {
      workspaceId,
      status: { notIn: ['skipped_stale', 'superseded'] },
      OR: [
        { createdAt: { gte: range.start, lte: range.end } },
        { decidedAt: { gte: range.start, lte: range.end } },
      ],
    };

    emitProgress('Loading pipeline runs from the review window...', {
      percent: 18,
    });

    const runs = await prisma.assignmentPipelineRun.findMany({
      where: runWhere,
      include: {
        assignedTech: { select: { id: true, name: true, email: true } },
        promptVersion: { select: { id: true, version: true } },
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            subject: true,
            // The plaintext description is the user's actual request — without
            // it the LLM is reasoning about routing decisions blind to what
            // the user wrote. We truncate at payload-build time, not here.
            descriptionText: true,
            category: true,
            ticketCategory: true,
            internalCategory: { select: { id: true, name: true } },
            internalSubcategory: { select: { id: true, name: true, parentId: true } },
            internalCategoryConfidence: true,
            internalCategoryRationale: true,
            internalCategoryFit: true,
            internalSubcategoryFit: true,
            taxonomyReviewNeeded: true,
            suggestedInternalCategoryName: true,
            suggestedInternalSubcategoryName: true,
            status: true,
            priority: true,
            createdAt: true,
            updatedAt: true,
            resolvedAt: true,
            closedAt: true,
            rejectionCount: true,
            assignedTechId: true,
            assignedTech: {
              select: {
                id: true, name: true, email: true,
                location: true, timezone: true,
              },
            },
            requester: {
              select: {
                id: true, name: true, email: true,
                department: true, jobTitle: true, timeZone: true,
              },
            },
            _count: { select: { threadEntries: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    throwIfCancelled();

    emitProgress('Loading direct FreshService assignments that bypassed the pipeline...', {
      percent: 26,
    });

    const bypassTickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        createdAt: { gte: range.start, lte: range.end },
        assignedTechId: { not: null },
        pipelineRuns: {
          none: {
            OR: [
              { createdAt: { gte: range.start, lte: range.end } },
              { decidedAt: { gte: range.start, lte: range.end } },
            ],
          },
        },
      },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        descriptionText: true,
        category: true,
        ticketCategory: true,
        internalCategory: { select: { id: true, name: true } },
        internalSubcategory: { select: { id: true, name: true, parentId: true } },
        internalCategoryConfidence: true,
        internalCategoryRationale: true,
        internalCategoryFit: true,
        internalSubcategoryFit: true,
        taxonomyReviewNeeded: true,
        suggestedInternalCategoryName: true,
        suggestedInternalSubcategoryName: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
        rejectionCount: true,
        assignedTechId: true,
        assignedTech: {
          select: {
            id: true, name: true, email: true,
            location: true, timezone: true,
          },
        },
        requester: {
          select: {
            id: true, name: true, email: true,
            department: true, jobTitle: true, timeZone: true,
          },
        },
        _count: { select: { threadEntries: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    throwIfCancelled();

    emitProgress(
      `Loaded ${runs.length} pipeline run(s) and ${bypassTickets.length} direct FreshService assignment(s).`,
      {
        percent: 34,
        stats: {
          pipelineRuns: runs.length,
          bypassedTickets: bypassTickets.length,
        },
      },
    );

    const ticketsForHydration = [
      ...runs.map((run) => run.ticket).filter(Boolean),
      ...bypassTickets,
    ];

    // Per-source thread counts for every candidate ticket so we can decide
    // exactly what's missing (activities vs conversations) without fetching
    // both endpoints unconditionally. groupBy on source keeps this to a
    // single query regardless of cohort size.
    const ticketIdSet = ticketsForHydration.map((t) => t.id);
    const threadCountsRows = ticketIdSet.length > 0
      ? await prisma.ticketThreadEntry.groupBy({
        by: ['ticketId', 'source'],
        where: { workspaceId, ticketId: { in: ticketIdSet } },
        _count: { _all: true },
      })
      : [];
    const threadCountsByTicket = new Map();
    for (const row of threadCountsRows) {
      const current = threadCountsByTicket.get(row.ticketId) || { activities: 0, conversations: 0 };
      if (row.source === 'freshservice_conversation') {
        current.conversations = row._count._all;
      } else {
        current.activities = row._count._all;
      }
      threadCountsByTicket.set(row.ticketId, current);
    }
    for (const t of ticketsForHydration) {
      t.threadCounts = threadCountsByTicket.get(t.id) || { activities: 0, conversations: 0 };
    }

    const missingActivities = ticketsForHydration.filter((t) => t.threadCounts.activities === 0).length;
    const missingConversations = ticketsForHydration.filter((t) => t.threadCounts.conversations === 0).length;
    const cachedFully = ticketsForHydration.length - Math.max(missingActivities, missingConversations);
    const forceRefresh = options.forceRefreshThreads === true;
    emitProgress(
      forceRefresh
        ? `Force-refreshing thread history for all ${ticketsForHydration.length} ticket(s) from FreshService...`
        : (missingActivities + missingConversations > 0)
          ? `Local cache: ${cachedFully}/${ticketsForHydration.length} ticket(s) fully cached. Pulling ${missingActivities} missing activity stream(s) and ${missingConversations} missing conversation stream(s) from FreshService.`
          : `Local cache: all ${ticketsForHydration.length} ticket(s) already have both activities and conversations cached. No FreshService calls needed.`,
      {
        percent: 42,
        stats: {
          candidateTickets: ticketsForHydration.length,
          ticketsFullyCached: cachedFully,
          ticketsMissingActivities: missingActivities,
          ticketsMissingConversations: missingConversations,
        },
      },
    );

    const hydration = await this._hydrateMissingThreads(workspaceId, ticketsForHydration, {
      signal: options.signal,
      forceRefresh,
      onProgress: ({ processed, total, hydratedActivities, hydratedConversations, failed, message }) => {
        emitProgress(message, {
          percent: total > 0 ? Math.min(68, 42 + Math.floor((processed / total) * 26)) : 68,
          stats: {
            ticketsBeingHydrated: total,
            threadHydrationProcessed: processed,
            ticketsHydratedActivities: hydratedActivities,
            ticketsHydratedConversations: hydratedConversations,
            threadHydrationFailures: failed,
          },
        });
      },
    });
    throwIfCancelled();

    emitProgress(
      `Thread hydration complete: pulled ${hydration.activitiesFetched} activity row(s) + ${hydration.conversationsFetched} conversation row(s) across ${hydration.hydratedActivities + hydration.hydratedConversations} ticket-source pair(s); ${hydration.failed} ticket(s) had errors.`,
      {
        percent: 70,
        stats: {
          activitiesFetched: hydration.activitiesFetched,
          conversationsFetched: hydration.conversationsFetched,
          ticketsHydratedActivities: hydration.hydratedActivities,
          ticketsHydratedConversations: hydration.hydratedConversations,
          threadHydrationWarnings: hydration.warnings.length,
        },
      },
    );

    const ticketIds = Array.from(new Set(ticketsForHydration.map((ticket) => ticket.id)));
    emitProgress('Loading assignment episodes, assignment actions, and thread excerpts...', {
      percent: 78,
      stats: {
        ticketIds: ticketIds.length,
      },
    });
    // Defence-in-depth: every related-data query is scoped by workspaceId
    // even though the ticketId set is already workspace-scoped. This protects
    // the analysis input from any pre-existing cross-workspace data integrity
    // issues (e.g. an assignment episode whose ticket id was reused).
    const [episodes, assignments, threadEntries, competencyCategories] = await Promise.all([
      prisma.ticketAssignmentEpisode.findMany({
        where: { workspaceId, ticketId: { in: ticketIds } },
        include: { technician: { select: { id: true, name: true, workspaceId: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.ticketAssignment.findMany({
        where: {
          workspaceId,
          ticketId: { in: ticketIds },
          createdAt: { lte: range.end },
        },
        include: { assignedTo: { select: { id: true, name: true, workspaceId: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      ticketThreadRepository.listForTickets(ticketIds, { end: range.end, workspaceId }),
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, description: true, parentId: true, sortOrder: true },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);
    throwIfCancelled();

    emitProgress(
      `Loaded ${episodes.length} assignment episode(s), ${assignments.length} assignment action(s), and ${threadEntries.length} thread excerpt record(s).`,
      {
        percent: 88,
        stats: {
          episodes: episodes.length,
          assignmentActions: assignments.length,
          threadEntries: threadEntries.length,
          competencyCategories: competencyCategories.length,
        },
      },
    );

    const episodesByTicket = this._buildEpisodeMap(episodes);
    const assignmentsByTicket = this._buildAssignmentActionMap(assignments);
    const threadByTicket = this._buildThreadExcerptMap(threadEntries);

    const runCases = runs.map((run) => {
      const recs = run.recommendation?.recommendations || [];
      const ticket = run.ticket;
      const ticketEpisodes = episodesByTicket.get(ticket.id) || [];
      const hasRebound = ticketEpisodes.some((episode) => episode.endMethod === 'rejected')
        || ['rebound', 'rebound_exhausted'].includes(run.triggerSource);
      const classification = classifyDailyReviewCase({
        finalTechId: ticket.assignedTechId,
        recommendationPoolIds: recs.map((rec) => rec.techId),
        topRecommendationId: recs[0]?.techId || null,
        hasRebound,
        isPendingReview: run.decision === 'pending_review',
      });

      const tags = [...classification.tags];
      if (!isClosedLikeStatus(ticket.status)) {
        tags.push(DAILY_REVIEW_PRIMARY_TAGS.stillOpen);
      }

      return {
        type: 'pipeline',
        runId: run.id,
        ticketId: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
        subject: ticket.subject || '(no subject)',
        category: ticket.ticketCategory || ticket.category || null,
        internalCategory: ticket.internalCategory
          ? {
            id: ticket.internalCategory.id,
            name: ticket.internalCategory.name,
            subcategory: ticket.internalSubcategory
              ? { id: ticket.internalSubcategory.id, name: ticket.internalSubcategory.name }
              : null,
          }
          : null,
        taxonomyFit: {
          categoryFit: ticket.internalCategoryFit || null,
          subcategoryFit: ticket.internalSubcategoryFit || null,
          reviewNeeded: !!ticket.taxonomyReviewNeeded,
          confidence: ticket.internalCategoryConfidence || null,
          rationale: ticket.internalCategoryRationale || null,
          suggestedCategoryName: ticket.suggestedInternalCategoryName || null,
          suggestedSubcategoryName: ticket.suggestedInternalSubcategoryName || null,
        },
        priority: ticket.priority,
        status: ticket.status,
        triggerSource: run.triggerSource,
        decision: run.decision,
        outcome: classification.outcome,
        primaryTag: classification.primaryTag,
        tags: Array.from(new Set(tags)),
        topRecommendation: recs[0]
          ? {
            techId: recs[0].techId,
            techName: recs[0].techName || null,
            score: recs[0].score ?? null,
          }
          : null,
        recommendationPool: recs.slice(0, 5).map((rec) => ({
          techId: rec.techId,
          techName: rec.techName || null,
          score: rec.score ?? null,
        })),
        pipelineAssignedTech: run.assignedTech
          ? { id: run.assignedTech.id, name: run.assignedTech.name }
          : null,
        // Carry tech location + timezone through so the LLM can reason about
        // "the wrong-region tech got assigned to a site-specific ticket".
        finalAssignee: ticket.assignedTech
          ? {
            id: ticket.assignedTech.id,
            name: ticket.assignedTech.name,
            location: ticket.assignedTech.location || null,
            timezone: ticket.assignedTech.timezone || null,
          }
          : null,
        changedFromTopRecommendation: !!(
          recs[0]?.techId
          && ticket.assignedTechId
          && recs[0].techId !== ticket.assignedTechId
        ),
        handledInFreshService: run.decision === 'pending_review' && !!ticket.assignedTechId,
        overrideReason: run.overrideReason || null,
        decisionNote: run.decisionNote || null,
        decidedAt: run.decidedAt,
        decidedByEmail: run.decidedByEmail,
        promptVersion: run.promptVersion
          ? { id: run.promptVersion.id, version: run.promptVersion.version }
          : null,
        rejectionCount: ticket.rejectionCount || 0,
        ticketCreatedAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        // Plaintext description — the actual user request. Kept full here;
        // truncated only at LLM-payload time so other consumers (heuristics,
        // diagnostics) still have the whole text if they want it.
        descriptionText: ticket.descriptionText || null,
        requester: ticket.requester,
        episodeSummary: ticketEpisodes.map((episode) => ({
          technicianId: episode.technicianId,
          technicianName: episode.technician?.name || null,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          startMethod: episode.startMethod,
          endMethod: episode.endMethod,
          endActorName: episode.endActorName,
        })),
        assignmentActions: (assignmentsByTicket.get(ticket.id) || []).slice(-5).map((item) => ({
          id: item.id,
          source: item.source,
          assignedToId: item.assignedToId,
          assignedToName: item.assignedTo?.name || null,
          assignedByEmail: item.assignedByEmail,
          createdAt: item.createdAt,
          note: item.note,
        })),
        threadExcerpts: threadByTicket.get(ticket.id) || [],
      };
    });

    const bypassCases = bypassTickets.map((ticket) => {
      const tags = [DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed];
      if (!isClosedLikeStatus(ticket.status)) tags.push(DAILY_REVIEW_PRIMARY_TAGS.stillOpen);
      return {
        type: 'pipeline_bypass',
        runId: null,
        ticketId: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
        subject: ticket.subject || '(no subject)',
        category: ticket.ticketCategory || ticket.category || null,
        internalCategory: ticket.internalCategory
          ? {
            id: ticket.internalCategory.id,
            name: ticket.internalCategory.name,
            subcategory: ticket.internalSubcategory
              ? { id: ticket.internalSubcategory.id, name: ticket.internalSubcategory.name }
              : null,
          }
          : null,
        taxonomyFit: {
          categoryFit: ticket.internalCategoryFit || null,
          subcategoryFit: ticket.internalSubcategoryFit || null,
          reviewNeeded: !!ticket.taxonomyReviewNeeded,
          confidence: ticket.internalCategoryConfidence || null,
          rationale: ticket.internalCategoryRationale || null,
          suggestedCategoryName: ticket.suggestedInternalCategoryName || null,
          suggestedSubcategoryName: ticket.suggestedInternalSubcategoryName || null,
        },
        priority: ticket.priority,
        status: ticket.status,
        triggerSource: 'freshservice_only',
        decision: 'pipeline_bypassed',
        outcome: DAILY_REVIEW_OUTCOMES.failure,
        primaryTag: DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed,
        tags,
        topRecommendation: null,
        recommendationPool: [],
        pipelineAssignedTech: null,
        finalAssignee: ticket.assignedTech
          ? {
            id: ticket.assignedTech.id,
            name: ticket.assignedTech.name,
            location: ticket.assignedTech.location || null,
            timezone: ticket.assignedTech.timezone || null,
          }
          : null,
        changedFromTopRecommendation: false,
        handledInFreshService: true,
        overrideReason: null,
        decisionNote: null,
        decidedAt: null,
        decidedByEmail: null,
        promptVersion: null,
        rejectionCount: ticket.rejectionCount || 0,
        ticketCreatedAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        descriptionText: ticket.descriptionText || null,
        requester: ticket.requester,
        episodeSummary: (episodesByTicket.get(ticket.id) || []).map((episode) => ({
          technicianId: episode.technicianId,
          technicianName: episode.technician?.name || null,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          startMethod: episode.startMethod,
          endMethod: episode.endMethod,
          endActorName: episode.endActorName,
        })),
        assignmentActions: (assignmentsByTicket.get(ticket.id) || []).slice(-5).map((item) => ({
          id: item.id,
          source: item.source,
          assignedToId: item.assignedToId,
          assignedToName: item.assignedTo?.name || null,
          assignedByEmail: item.assignedByEmail,
          createdAt: item.createdAt,
          note: item.note,
        })),
        threadExcerpts: threadByTicket.get(ticket.id) || [],
      };
    });

    const allCases = [...runCases, ...bypassCases];
    const pipelineCases = runCases.filter((item) => item.type === 'pipeline');
    const consideredCases = pipelineCases.filter((item) => item.primaryTag !== DAILY_REVIEW_PRIMARY_TAGS.awaitingReview);
    const uniqueReviewedTicketIds = Array.from(new Set(allCases.map((item) => item.ticketId)));
    const uniqueReboundedTicketIds = Array.from(new Set(
      allCases
        .filter((item) => item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded))
        .map((item) => item.ticketId),
    ));
    throwIfCancelled();

    emitProgress(`Built ${allCases.length} review case(s); summarizing daily metrics...`, {
      percent: 95,
      stats: {
        totalCases: allCases.length,
        pipelineCases: pipelineCases.length,
        consideredCases: consideredCases.length,
      },
    });

    const taxonomyCategoryName = (item) => {
      if (item.internalCategory?.name && item.internalCategory?.subcategory?.name) {
        return `${item.internalCategory.name} > ${item.internalCategory.subcategory.name}`;
      }
      return item.internalCategory?.name || item.category || 'Uncategorized';
    };

    const summaryMetrics = {
      reviewDate: dateStr,
      reviewStartDate: startDate,
      reviewEndDate: endDate,
      workspaceName: workspace.name,
      timezone,
      reviewWindow: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        localDate: range.localDate,
        endLocalDate: range.endLocalDate,
        isRange: range.isRange,
        startTime: range.startTime,
        endTime: range.endTime,
        isBusinessDay: range.isBusinessDay,
      },
      definitions: {
        cohortAnchor: 'Tickets with assignment pipeline activity during the selected workspace business day, plus tickets created that day that were assigned directly in FreshService without a pipeline run.',
        success: 'Top recommendation stayed the final assignee by review time and the ticket did not rebound.',
        partialSuccess: 'The final assignee was in the recommendation pool, but not the top recommendation.',
        failure: 'The final assignee was outside the recommendation pool, the ticket rebounded, or the pipeline was bypassed.',
        unresolved: 'The ticket is still awaiting review, missing a recommendation, or lacks enough final assignment evidence yet.',
        rebounds: 'Unique tickets that rebounded at least once during the review cohort. Multiple rebounds on the same ticket count once.',
      },
      totals: {
        pipelineRuns: runs.length,
        bypassedTickets: bypassCases.length,
        totalTicketsReviewed: allCases.length,
        distinctTicketsReviewed: uniqueReviewedTicketIds.length,
        autoAssigned: pipelineCases.filter((item) => item.decision === 'auto_assigned').length,
        approved: pipelineCases.filter((item) => item.decision === 'approved').length,
        modified: pipelineCases.filter((item) => item.decision === 'modified').length,
        rejected: pipelineCases.filter((item) => item.decision === 'rejected').length,
        pendingReview: pipelineCases.filter((item) => item.decision === 'pending_review').length,
        handledInFreshService: pipelineCases.filter((item) => item.handledInFreshService).length,
        success: consideredCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.success).length,
        partialSuccess: consideredCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.partialSuccess).length,
        failure: allCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure).length,
        unresolved: allCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.unresolved).length,
        rebounds: uniqueReboundedTicketIds.length,
        stillOpen: allCases.filter((item) => !isClosedLikeStatus(item.status)).length,
        resolvedOrClosed: allCases.filter((item) => isClosedLikeStatus(item.status)).length,
      },
      rates: {},
      topCategories: bucketCounts(
        allCases.filter((item) =>
          item.outcome === DAILY_REVIEW_OUTCOMES.failure
          || item.decision === 'modified'
          || item.decision === 'rejected',
        ),
        taxonomyCategoryName,
      ),
      topTechnicians: bucketCounts(
        allCases.filter((item) => item.changedFromTopRecommendation || item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded)),
        (item) => item.finalAssignee?.name || item.pipelineAssignedTech?.name || null,
      ),
      competencyCategories: competencyCategories.map((item) => ({
        id: item.id,
        name: item.name,
        parentId: item.parentId || null,
      })),
    };

    const denominator = Math.max(consideredCases.length, 1);
    summaryMetrics.rates = {
      successRate: toPct(summaryMetrics.totals.success, denominator),
      partialSuccessRate: toPct(summaryMetrics.totals.partialSuccess, denominator),
      failureRate: toPct(summaryMetrics.totals.failure, allCases.length || 1),
      rejectionRate: toPct(
        pipelineCases.filter((item) => item.decision === 'rejected').length,
        Math.max(pipelineCases.length, 1),
      ),
      reboundRate: toPct(summaryMetrics.totals.rebounds, Math.max(uniqueReviewedTicketIds.length, 1)),
    };

    const warnings = [...hydration.warnings];
    if (hydration.hydratedActivities > 0 || hydration.hydratedConversations > 0) {
      warnings.push(`Hydrated FreshService threads during this run: ${hydration.activitiesFetched} activity row(s) across ${hydration.hydratedActivities} ticket(s), ${hydration.conversationsFetched} conversation row(s) across ${hydration.hydratedConversations} ticket(s).`);
    }

    // Per-source coverage of what the LLM will actually see. These numbers
    // are surfaced in the run detail so the admin can verify the analysis
    // had real conversation context to work with — not just state-change
    // events from the activity log.
    const conversationEntries = threadEntries.filter((e) => e.source === 'freshservice_conversation');
    const activityEntries = threadEntries.filter((e) => e.source !== 'freshservice_conversation');
    const ticketsWithConversations = new Set(conversationEntries.map((e) => e.ticketId)).size;
    const ticketsWithActivities = new Set(activityEntries.map((e) => e.ticketId)).size;

    const collectionDiagnostics = {
      candidateTickets: ticketsForHydration.length,
      ticketsWithLocalActivitiesBeforeRun: ticketsForHydration.length - missingActivities,
      ticketsWithLocalConversationsBeforeRun: ticketsForHydration.length - missingConversations,
      ticketsRequestingActivities: missingActivities,
      ticketsRequestingConversations: missingConversations,
      ticketsHydratedActivities: hydration.hydratedActivities,
      ticketsHydratedConversations: hydration.hydratedConversations,
      activityRowsFetched: hydration.activitiesFetched,
      conversationRowsFetched: hydration.conversationsFetched,
      hydrationFailures: hydration.failed,
      forceRefresh: hydration.forceRefresh === true,
      threadEntriesAvailable: threadEntries.length,
      conversationEntriesAvailable: conversationEntries.length,
      activityEntriesAvailable: activityEntries.length,
      ticketsWithConversations,
      ticketsWithActivities,
      ticketsWithNoThreadContext: Math.max(0, ticketsForHydration.length - new Set(threadEntries.map((e) => e.ticketId)).size),
      perTicket: hydration.perTicket || [],
      episodes: episodes.length,
      assignmentActions: assignments.length,
      pipelineRuns: runs.length,
      bypassTickets: bypassTickets.length,
    };

    emitProgress(`Collection complete: ${summaryMetrics.totals.totalTicketsReviewed} ticket(s) ready. ${ticketsWithConversations}/${ticketsForHydration.length} have conversation bodies for the LLM to read.`, {
      percent: 100,
      stats: {
        totalTicketsReviewed: summaryMetrics.totals.totalTicketsReviewed,
        success: summaryMetrics.totals.success,
        failure: summaryMetrics.totals.failure,
        unresolved: summaryMetrics.totals.unresolved,
        ticketsWithConversations,
        ticketsWithActivities,
        conversationEntriesAvailable: conversationEntries.length,
      },
    });

    return {
      workspaceId,
      workspaceName: workspace.name,
      timezone,
      reviewDate: dateStr,
      reviewStartDate: startDate,
      reviewEndDate: endDate,
      range,
      config,
      summaryMetrics,
      cases: allCases,
      warnings,
      analyzedTicketIds: allCases.map((item) => item.ticketId),
      competencyCategories,
      collectionDiagnostics,
    };
  }

  _buildHeuristicRecommendations(dataset) {
    const promptRecommendations = [];
    const processRecommendations = [];
    const skillRecommendations = [];
    const taxonomyRecommendations = this._buildDeterministicTaxonomyRecommendations(dataset);

    const failureCases = dataset.cases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure);
    const outsidePoolCases = failureCases.filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.rejectedReassigned);
    const reboundCases = failureCases.filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.rebounded);

    if (outsidePoolCases.length >= 2) {
      promptRecommendations.push({
        title: 'Tighten reasoning around override patterns',
        severity: outsidePoolCases.length >= 4 ? 'high' : 'medium',
        rationale: 'Multiple tickets finished with a technician outside the recommendation pool, which suggests the prompt is missing an operational signal the reviewers are using.',
        suggestedAction: 'Review these tickets and add explicit prompt guidance for the missing routing factors, especially around category interpretation and when to trust historical ownership over the immediate recommendation.',
        supportingTicketIds: outsidePoolCases.slice(0, 5).map((item) => item.ticketId),
        supportingFreshserviceTicketIds: outsidePoolCases.slice(0, 5).map((item) => item.freshserviceTicketId),
      });
    }

    if (reboundCases.length > 0) {
      processRecommendations.push({
        title: 'Audit rebound handling and rejection follow-up',
        severity: reboundCases.length >= 3 ? 'high' : 'medium',
        rationale: 'Tickets rebounded after assignment, which indicates the system is still routing some tickets to agents who will not keep ownership.',
        suggestedAction: 'Review rejection notes, group routing, and rebound guardrails. Consider earlier manual review for similar tickets or stronger exclusion logic for recently rejected technician-ticket pairs.',
        supportingTicketIds: reboundCases.slice(0, 5).map((item) => item.ticketId),
        supportingFreshserviceTicketIds: reboundCases.slice(0, 5).map((item) => item.freshserviceTicketId),
      });
    }

    const topCategory = dataset.summaryMetrics.topCategories[0];
    if (topCategory && topCategory.name && topCategory.name !== 'Uncategorized') {
      const caseTaxonomyName = (item) => {
        if (item.internalCategory?.name && item.internalCategory?.subcategory?.name) {
          return `${item.internalCategory.name} > ${item.internalCategory.subcategory.name}`;
        }
        return item.internalCategory?.name || item.category || null;
      };
      taxonomyRecommendations.push({
        title: `Review skill coverage for ${topCategory.name}`,
        severity: topCategory.count >= 3 ? 'high' : 'medium',
        rationale: 'The highest-friction category from this review day likely needs cleaner taxonomy coverage or better normalization in the category map.',
        suggestedAction: `Check whether "${topCategory.name}" should be added, split, merged, or mapped more explicitly to one or more technician competencies.`,
        taxonomyAction: 'update',
        categoryName: topCategory.name,
        metadata: {
          taxonomy: {
            source: 'heuristic_top_friction_category',
            taxonomyAction: 'update',
            categoryName: topCategory.name,
          },
        },
        supportingTicketIds: dataset.cases
          .filter((item) => caseTaxonomyName(item) === topCategory.name)
          .slice(0, 5)
          .map((item) => item.ticketId),
        supportingFreshserviceTicketIds: dataset.cases
          .filter((item) => caseTaxonomyName(item) === topCategory.name)
          .slice(0, 5)
          .map((item) => item.freshserviceTicketId),
      });
    }

    if (dataset.summaryMetrics.totals.bypassedTickets > 0) {
      processRecommendations.push({
        title: 'Investigate pipeline bypass tickets',
        severity: dataset.summaryMetrics.totals.bypassedTickets >= 3 ? 'high' : 'medium',
        rationale: 'Some tickets were assigned in FreshService without a pipeline run, which reduces the review loop quality and weakens training data.',
        suggestedAction: 'Check poll timing, webhook coverage, and manual assignment timing to reduce untracked same-day ownership changes.',
        supportingTicketIds: dataset.cases
          .filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed)
          .slice(0, 5)
          .map((item) => item.ticketId),
        supportingFreshserviceTicketIds: dataset.cases
          .filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed)
          .slice(0, 5)
          .map((item) => item.freshserviceTicketId),
      });
    }

    return {
      executiveSummary: `Reviewed ${dataset.summaryMetrics.totals.totalTicketsReviewed} ticket(s) for ${dataset.reviewDate}. Success rate was ${dataset.summaryMetrics.rates.successRate}% with ${dataset.summaryMetrics.totals.failure} failure-classified case(s) and ${dataset.summaryMetrics.totals.rebounds} rebound(s).`,
      promptRecommendations,
      processRecommendations,
      taxonomyRecommendations,
      skillRecommendations,
      warnings: ['Used heuristic recommendations because LLM analysis was unavailable.'],
      transcript: '',
      totalTokensUsed: 0,
    };
  }

  // Strip any supporting ticket id the LLM returned that wasn't in the
  // input set. The tool schema accepts arbitrary integers so an unbounded
  // model can (and does, occasionally) invent plausible-looking ticket
  // numbers. Keeping only ids we sent in guarantees every recommendation
  // is grounded in the current workspace's review cohort.
  _sanitizeRecommendationItems(items = [], { allowedInternalIds, allowedFreshserviceIds }) {
    if (!Array.isArray(items)) return { items: [], droppedInternal: 0, droppedExternal: 0 };
    let droppedInternal = 0;
    let droppedExternal = 0;
    const sanitized = items.map((item) => {
      const cleanedInternal = Array.isArray(item.supportingTicketIds)
        ? item.supportingTicketIds.filter((id) => {
          if (allowedInternalIds.has(Number(id))) return true;
          droppedInternal++;
          return false;
        })
        : [];
      const cleanedExternal = Array.isArray(item.supportingFreshserviceTicketIds)
        ? item.supportingFreshserviceTicketIds.filter((id) => {
          if (allowedFreshserviceIds.has(Number(id))) return true;
          droppedExternal++;
          return false;
        })
        : [];
      return {
        ...item,
        supportingTicketIds: cleanedInternal,
        supportingFreshserviceTicketIds: cleanedExternal,
      };
    });
    return { items: sanitized, droppedInternal, droppedExternal };
  }

  // Some prod tickets have an assignedTechId pointing at a technician row
  // belonging to a different workspace (a pre-existing data integrity issue
  // we don't try to fix here). We still want the daily review to be honest
  // about the scope, so we surface those as warnings and blank the tech
  // names so they don't end up quoted in the LLM's output as if they were
  // members of the current workspace.
  async _detectCrossWorkspaceAssignments(workspaceId, cases = []) {
    const techIds = new Set();
    for (const item of cases) {
      if (item.finalAssignee?.id) techIds.add(item.finalAssignee.id);
      if (item.pipelineAssignedTech?.id) techIds.add(item.pipelineAssignedTech.id);
      for (const action of item.assignmentActions || []) {
        if (action.assignedToId) techIds.add(action.assignedToId);
      }
      for (const episode of item.episodeSummary || []) {
        if (episode.technicianId) techIds.add(episode.technicianId);
      }
    }
    if (techIds.size === 0) return { foreignTechIds: new Set(), warnings: [] };

    const techs = await prisma.technician.findMany({
      where: { id: { in: Array.from(techIds) } },
      select: { id: true, workspaceId: true, name: true },
    });
    const foreign = techs.filter((t) => t.workspaceId !== workspaceId);
    const foreignTechIds = new Set(foreign.map((t) => t.id));
    const warnings = foreign.length > 0
      ? [`${foreign.length} technician reference(s) in this review (e.g. ${foreign.slice(0, 3).map((t) => t.name).join(', ')}) belong to other workspaces. Their names were redacted from the LLM input to avoid cross-workspace recommendations.`]
      : [];
    return { foreignTechIds, warnings };
  }

  _redactForeignTechFromCase(item, foreignTechIds) {
    if (foreignTechIds.size === 0) return item;
    const safe = (tech) => (tech && foreignTechIds.has(tech.id)
      ? { id: tech.id, name: '(out-of-workspace technician)' }
      : tech);
    return {
      ...item,
      finalAssignee: safe(item.finalAssignee),
      pipelineAssignedTech: safe(item.pipelineAssignedTech),
      assignmentActions: (item.assignmentActions || []).map((action) => (
        action.assignedToId && foreignTechIds.has(action.assignedToId)
          ? { ...action, assignedToName: '(out-of-workspace technician)' }
          : action
      )),
      episodeSummary: (item.episodeSummary || []).map((episode) => (
        episode.technicianId && foreignTechIds.has(episode.technicianId)
          ? { ...episode, technicianName: '(out-of-workspace technician)' }
          : episode
      )),
    };
  }

  async _analyzeDataset(workspaceId, dataset, llmModel, options = {}) {
    this._throwIfCancelled(options.signal);
    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) {
      return this._buildHeuristicRecommendations(dataset);
    }

    try {
      this._throwIfCancelled(options.signal);
      const publishedPrompt = await promptRepository.getPublished(workspaceId);

      const { foreignTechIds, warnings: techWarnings } = await this._detectCrossWorkspaceAssignments(
        workspaceId,
        dataset.cases,
      );
      const safeCases = dataset.cases.map((item) => this._redactForeignTechFromCase(item, foreignTechIds));

      const analyzedCases = safeCases
        .filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure || item.outcome === DAILY_REVIEW_OUTCOMES.partialSuccess)
        .slice(0, MAX_CASES_FOR_ANALYSIS);

      // The id sets the LLM is allowed to cite as supporting evidence — built
      // from the actual cases we hand to the model. Anything the model returns
      // outside these sets is treated as a hallucination and dropped.
      const allowedInternalIds = new Set(analyzedCases.map((item) => Number(item.ticketId)).filter(Boolean));
      const allowedFreshserviceIds = new Set(analyzedCases.map((item) => Number(item.freshserviceTicketId)).filter(Boolean));

      const analysisInput = {
        reviewDate: dataset.reviewDate,
        workspaceId,
        workspaceName: dataset.workspaceName,
        timezone: dataset.timezone,
        summary: dataset.summaryMetrics,
        // Each case ships full structured context: header metadata, the
        // chronological thread (notes + replies + state-change events with
        // visibility tags) and a one-line summary line. The structured
        // threadExcerpts give the model real conversation bodies to read,
        // which is what was missing before — previously only the joined
        // summary string was sent and it was capped to 220 chars per item
        // and only included activity-stream events (no actual note bodies).
        cases: analyzedCases.map((item) => ({
          ticketId: item.ticketId,
          freshserviceTicketId: item.freshserviceTicketId,
          subject: item.subject,
          // The user's actual request, normalized + truncated. Without this,
          // the LLM was reasoning about routing decisions blind to what was
          // actually being asked for (which is exactly what made the output
          // feel generic and uninformed in the screenshots).
          description: truncate(item.descriptionText, MAX_DESCRIPTION_CHARS_FOR_LLM),
          // Who asked, what they do, where they sit. Department + jobTitle
          // explain why a "BST" ticket from Finance might be misrouted; the
          // timezone explains why an after-hours assignment was suboptimal.
          requester: item.requester
            ? {
              name: item.requester.name || null,
              email: item.requester.email || null,
              department: item.requester.department || null,
              jobTitle: item.requester.jobTitle || null,
              timeZone: item.requester.timeZone || null,
            }
            : null,
          category: item.category,
          internalCategory: item.internalCategory,
          taxonomyFit: item.taxonomyFit,
          priority: item.priority,
          status: item.status,
          outcome: item.outcome,
          primaryTag: item.primaryTag,
          decision: item.decision,
          triggerSource: item.triggerSource,
          rejectionCount: item.rejectionCount,
          topRecommendation: item.topRecommendation,
          // finalAssignee carries location + timezone now (set in collect step)
          // so the LLM can flag wrong-region assignments and after-hours work.
          finalAssignee: item.finalAssignee,
          pipelineAssignedTech: item.pipelineAssignedTech,
          changedFromTopRecommendation: item.changedFromTopRecommendation,
          handledInFreshService: item.handledInFreshService,
          overrideReason: item.overrideReason,
          decisionNote: item.decisionNote,
          ticketCreatedAt: item.ticketCreatedAt,
          resolvedAt: item.resolvedAt,
          closedAt: item.closedAt,
          rebounded: Array.isArray(item.tags) && item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded),
          episodeSummary: (item.episodeSummary || []).map((ep) => ({
            technicianName: ep.technicianName,
            startMethod: ep.startMethod,
            endMethod: ep.endMethod,
            endActorName: ep.endActorName,
          })),
          assignmentActions: (item.assignmentActions || []).map((a) => ({
            source: a.source,
            assignedToName: a.assignedToName,
            assignedByEmail: a.assignedByEmail,
            note: a.note,
          })),
          threadExcerpts: (item.threadExcerpts || []).map((ex) => ({
            source: ex.source,
            eventType: ex.eventType,
            visibility: ex.visibility,
            actorName: ex.actorName,
            occurredAt: ex.occurredAt,
            excerpt: ex.excerpt,
          })),
          summary: this._summarizeCase(item),
        })),
        competencyCategories: dataset.competencyCategories.map((item) => ({
          id: item.id,
          name: item.name,
          parentId: item.parentId || null,
          description: item.description || null,
        })),
        categoryTree: buildDailyReviewCategoryTree(dataset.competencyCategories),
        currentPromptVersion: publishedPrompt?.version || null,
        allowedSupportingTicketIds: Array.from(allowedInternalIds),
        allowedSupportingFreshserviceTicketIds: Array.from(allowedFreshserviceIds),
      };

      const workspaceLabel = dataset.workspaceName || 'this';

      const TOOL = {
        name: 'submit_daily_review_findings',
        description: `Submit the final daily review findings for the "${workspaceLabel}" workspace. You must call this tool exactly once. Every supportingTicketIds entry must come from analysisInput.allowedSupportingTicketIds and every supportingFreshserviceTicketIds entry must come from analysisInput.allowedSupportingFreshserviceTicketIds — do not invent ids.`,
        input_schema: {
          type: 'object',
          properties: {
            executiveSummary: { type: 'string' },
            promptRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            processRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            taxonomyRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  skillsAffected: { type: 'array', items: { type: 'string' } },
                  taxonomyAction: { type: ['string', 'null'], enum: ['add', 'rename', 'update', 'move', 'merge', 'deprecate', null] },
                  categoryId: { type: ['integer', 'null'] },
                  categoryName: { type: ['string', 'null'] },
                  parentCategoryId: { type: ['integer', 'null'] },
                  parentCategoryName: { type: ['string', 'null'] },
                  newName: { type: ['string', 'null'] },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            skillRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  skillsAffected: { type: 'array', items: { type: 'string' } },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: [
            'executiveSummary',
            'promptRecommendations',
            'processRecommendations',
            'taxonomyRecommendations',
            'skillRecommendations',
            'warnings',
          ],
        },
      };

      const systemPrompt = `You are reviewing one business day of auto-assignment outcomes for the "${workspaceLabel}" workspace ONLY.

Strict scoping rules:
- Every recommendation must be about the "${workspaceLabel}" workspace. Do not reference tickets, technicians, or processes from any other workspace.
- supportingTicketIds MUST come from the analysisInput.allowedSupportingTicketIds list. Anything else will be discarded as a hallucination.
- supportingFreshserviceTicketIds MUST come from the analysisInput.allowedSupportingFreshserviceTicketIds list. Anything else will be discarded as a hallucination.
- Never invent ticket numbers, technician names, or workflow names that are not present in the supplied cases.

Your job is to recommend improvements in exactly four areas:
1. Prompt changes
2. Process changes
3. Taxonomy/category changes
4. Agent skill changes

Rules:
- Base every recommendation on evidence from the supplied cases and metrics.
- Pay special attention to cases with taxonomyFit.reviewNeeded=true, weak/none categoryFit, weak/none subcategoryFit, or suggested internal category/subcategory names.
- Treat assignment-agent taxonomy suggestions as evidence, not truth: compare them against ticket descriptions, thread excerpts, outcomes, and the full categoryTree before recommending taxonomy changes.
- taxonomyRecommendations may include adding, moving, renaming, merging, deprecating, remapping, or updating descriptions for internal top-level categories or subcategories when the evidence supports it.
- For taxonomyRecommendations, populate taxonomyAction and the relevant categoryId/categoryName/parentCategoryId/parentCategoryName/newName fields so consolidation can turn them into precise admin-reviewed Taxonomy Changes.
- skillRecommendations are only agent skill/technician competency changes: add, remove, or change a technician's competency mapping or proficiency. Do not put category/subcategory structure changes there.
- Be conservative. Fewer strong recommendations are better than many weak ones.
- Do not rewrite the prompt or mutate the competency matrix directly.
- Focus on why the system missed and how to improve future assignments.
- Use the tool once with concise, actionable recommendations.`;

      const userMessage = `Daily review dataset:
\n\n${JSON.stringify(analysisInput, null, 2)}\n\nSubmit the structured findings using the tool.`;

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: llmModel || 'claude-sonnet-4-6-20260217',
        max_tokens: 4096,
        system: systemPrompt,
        tools: [TOOL],
        messages: [{ role: 'user', content: userMessage }],
      }, {
        signal: options.signal,
      });
      this._throwIfCancelled(options.signal);

      const transcript = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const submission = response.content.find(
        (block) => block.type === 'tool_use' && block.name === 'submit_daily_review_findings',
      )?.input;

      if (!submission) {
        logger.warn('Daily review analysis returned without a tool submission');
        const heuristic = this._buildHeuristicRecommendations(dataset);
        heuristic.warnings.push('LLM response did not contain a structured submission; heuristic recommendations were used instead.');
        heuristic.transcript = transcript;
        heuristic.totalTokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
        return heuristic;
      }

      // Strip any supporting ticket id the LLM hallucinated; everything cited
      // must be present in the actual analyzedCases set we sent in.
      const sanitizationCtx = { allowedInternalIds, allowedFreshserviceIds };
      const promptSanitized = this._sanitizeRecommendationItems(submission.promptRecommendations, sanitizationCtx);
      const processSanitized = this._sanitizeRecommendationItems(submission.processRecommendations, sanitizationCtx);
      const taxonomySanitized = this._sanitizeRecommendationItems(submission.taxonomyRecommendations, sanitizationCtx);
      const skillSanitized = this._sanitizeRecommendationItems(submission.skillRecommendations, sanitizationCtx);
      const totalDroppedInternal = promptSanitized.droppedInternal + processSanitized.droppedInternal + taxonomySanitized.droppedInternal + skillSanitized.droppedInternal;
      const totalDroppedExternal = promptSanitized.droppedExternal + processSanitized.droppedExternal + taxonomySanitized.droppedExternal + skillSanitized.droppedExternal;
      const sanitizationWarnings = [];
      if (totalDroppedInternal > 0 || totalDroppedExternal > 0) {
        const dropMsg = `Dropped ${totalDroppedInternal + totalDroppedExternal} hallucinated supporting ticket id reference(s) (${totalDroppedInternal} internal, ${totalDroppedExternal} freshservice) returned by the LLM that were not part of this workspace's review cohort.`;
        logger.warn(dropMsg, { workspaceId, runDate: dataset.reviewDate });
        sanitizationWarnings.push(dropMsg);
      }

      return {
        executiveSummary: submission.executiveSummary || '',
        promptRecommendations: promptSanitized.items,
        processRecommendations: processSanitized.items,
        taxonomyRecommendations: taxonomySanitized.items,
        skillRecommendations: skillSanitized.items,
        warnings: [
          ...(submission.warnings || []),
          ...techWarnings,
          ...sanitizationWarnings,
        ],
        transcript,
        totalTokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      };
    } catch (error) {
      if (this._isCancellationError(error)) throw error;
      logger.error('Daily review LLM analysis failed, falling back to heuristics', {
        workspaceId,
        error: error.message,
      });
      const heuristic = this._buildHeuristicRecommendations(dataset);
      heuristic.warnings.push(`LLM analysis failed: ${error.message}`);
      return heuristic;
    }
  }

  // Throttled progress persister: writes the latest progress payload to the
  // run row no more than once per second. Polling clients read this column
  // to render the live phase / percent / message / stats — same UX SSE
  // used to provide, but resilient to the Azure App Service 230-second
  // request timeout that kills long-lived SSE connections.
  _makeProgressPersister(runId) {
    const state = { lastPersistAt: 0, latest: null, pendingTimer: null };
    const flush = () => {
      const payload = state.latest;
      state.latest = null;
      state.lastPersistAt = Date.now();
      state.pendingTimer = null;
      prisma.assignmentDailyReviewRun.update({
        where: { id: runId },
        data: {
          progress: sanitizeJsonForPostgres(payload),
          progressUpdatedAt: new Date(),
        },
      }).catch((err) => {
        logger.warn('Daily review progress persist failed', { runId, error: err.message });
      });
    };
    return (payload) => {
      state.latest = payload;
      const elapsed = Date.now() - state.lastPersistAt;
      if (elapsed >= 1000) {
        flush();
      } else if (!state.pendingTimer) {
        state.pendingTimer = setTimeout(flush, 1000 - elapsed);
      }
    };
  }

  // Look up an existing run, or create a new one. The HTTP-facing kickoff
  // path uses this and then dispatches _executeRun() in the background so
  // it can return a runId to the client without holding the request open.
  async _setupRun(workspaceId, reviewDate, triggeredBy, options = {}) {
    await this._markStaleRunsFailed();

    const { workspace, config, timezone } = await this._getWorkspaceContext(workspaceId);
    const reviewWindow = await this._getReviewWindow(workspaceId, reviewDate, timezone, options);
    const { dateStr, startDate, endDate, reviewDateValue, range } = reviewWindow;

    const activeExisting = await prisma.assignmentDailyReviewRun.findFirst({
      where: {
        workspaceId,
        reviewDate: reviewDateValue,
        rangeStart: range.start,
        rangeEnd: range.end,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (activeExisting) {
      return { run: activeExisting, alreadyActive: true, workspace, config, timezone, dateStr, startDate, endDate, reviewDateValue };
    }

    // When force is false (scheduled job), short-circuit if today's review
    // has already completed so we don't pile on duplicate rows. Manual UI
    // clicks always pass force=true so each rerun gets its own row.
    if (!options.force) {
      const lastCompleted = await prisma.assignmentDailyReviewRun.findFirst({
        where: {
          workspaceId,
          reviewDate: reviewDateValue,
          rangeStart: range.start,
          rangeEnd: range.end,
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (lastCompleted) {
        return { run: lastCompleted, alreadyCompleted: true, workspace, config, timezone, dateStr, startDate, endDate, reviewDateValue };
      }
    }

    const run = await prisma.assignmentDailyReviewRun.create({
      data: {
        workspaceId,
        reviewDate: reviewDateValue,
        timezone,
        rangeStart: range.start,
        rangeEnd: range.end,
        triggerSource: options.triggerSource || 'manual',
        status: 'collecting',
        triggeredBy,
        llmModel: config?.llmModel || 'claude-sonnet-4-6-20260217',
        progress: sanitizeJsonForPostgres({
          phase: 'collecting',
          percent: 2,
          message: 'Queued for execution. Pulling dataset shortly...',
          stats: {},
        }),
        progressUpdatedAt: new Date(),
      },
    });
    return { run, workspace, config, timezone, dateStr, startDate, endDate, reviewDateValue };
  }

  // Background-friendly entry point used by the HTTP layer. Creates the
  // run row, fires _executeRun in the background, and returns the row to
  // the caller within milliseconds. The frontend polls the run row to
  // render progress instead of holding an SSE connection open.
  async kickOffReview(workspaceId, reviewDate, triggeredBy = 'system', options = {}) {
    const lockKey = [
      workspaceId,
      reviewDate || '',
      options.reviewStartDate || options.startDate || '',
      options.reviewEndDate || options.endDate || '',
      options.triggerSource || 'manual',
      options.force === false ? 'noforce' : 'force',
    ].join(':');

    const existingKickoff = this.kickoffLocks.get(lockKey);
    if (existingKickoff) return existingKickoff;

    const kickoffPromise = (async () => {
      const setup = await this._setupRun(workspaceId, reviewDate, triggeredBy, options);
      if (setup.alreadyActive || setup.alreadyCompleted) {
        return setup.run;
      }

      // Fire-and-forget: errors are caught inside _executeRun and persisted
      // to the run row (status='failed', errorMessage), so nothing should
      // ever escape this promise.
      setImmediate(() => {
        this._executeRun(setup, { ...options, _runStartedAt: Date.now() }).catch((err) => {
          logger.error('Background daily review crashed', { runId: setup.run.id, error: err.message });
        });
      });

      return setup.run;
    })();

    this.kickoffLocks.set(lockKey, kickoffPromise);
    kickoffPromise.finally(() => {
      setTimeout(() => this.kickoffLocks.delete(lockKey), 5000);
    });
    return kickoffPromise;
  }

  // Backwards-compatible synchronous run (used by the scheduled job and by
  // the test scripts). The HTTP layer now uses kickOffReview() instead.
  async runReview(workspaceId, reviewDate, triggeredBy = 'system', options = {}) {
    const setup = await this._setupRun(workspaceId, reviewDate, triggeredBy, options);
    if (setup.alreadyActive || setup.alreadyCompleted) {
      try { options.onEvent?.({ type: 'error', message: `A review is already running for ${setup.dateStr} (run #${setup.run.id}).` }); } catch { /* ignore */ }
      return setup.run;
    }
    return this._executeRun(setup, { ...options, _runStartedAt: Date.now() });
  }

  async _executeRun(setup, options = {}) {
    const startedAt = options._runStartedAt || Date.now();
    const { workspace, config, dateStr, startDate, endDate } = setup;
    let run = setup.run;
    const persistProgress = this._makeProgressPersister(run.id);
    const emit = (event) => {
      try { options.onEvent?.(event); } catch { /* ignore stream errors */ }
    };
    let lastHeartbeatAt = 0;
    const heartbeatRun = (status) => {
      const now = Date.now();
      if (!run?.id || now - lastHeartbeatAt < 10000) return;
      lastHeartbeatAt = now;
      prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: { status },
      }).catch((error) => {
        logger.warn('Daily review heartbeat failed', { runId: run.id, error: error.message });
      });
    };

    const abortController = new AbortController();
    this.activeRunControllers.set(run.id, abortController);

    emit({ type: 'daily_review_started', runId: run.id, reviewDate: dateStr, reviewStartDate: startDate, reviewEndDate: endDate, workspaceName: workspace.name });

    try {
      const startMsg = {
        phase: 'collecting',
        percent: 2,
        message: 'Collecting ticket outcomes, thread history, and assignment evidence...',
        stats: {},
      };
      emit({ type: 'phase_update', ...startMsg });
      persistProgress(startMsg);
      const dataset = await this.collectDailyDataset(workspace.id, dateStr, {
        signal: abortController.signal,
        reviewStartDate: startDate,
        reviewEndDate: endDate,
        forceRefreshThreads: options.forceRefreshThreads === true,
        onProgress: (event) => {
          heartbeatRun('collecting');
          const payload = {
            phase: event.phase || 'collecting',
            message: event.message,
            percent: event.percent,
            stats: event.stats,
          };
          emit({ type: 'phase_update', ...payload });
          persistProgress(payload);
        },
      });

      await prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: {
          status: 'analyzing',
          rangeStart: dataset.range.start,
          rangeEnd: dataset.range.end,
          summaryMetrics: sanitizeJsonForPostgres({
            ...dataset.summaryMetrics,
            collectionDiagnostics: dataset.collectionDiagnostics,
          }),
          analyzedTicketIds: dataset.analyzedTicketIds,
          evidenceCases: sanitizeJsonForPostgres(dataset.cases),
          warnings: sanitizeJsonForPostgres(dataset.warnings),
        },
      });

      emit({
        type: 'dataset_collected',
        totals: dataset.summaryMetrics.totals,
        topCategories: dataset.summaryMetrics.topCategories,
      });
      const analyzingPayload = {
        phase: 'analyzing',
        percent: 92,
        message: 'Generating prompt, process, taxonomy, and agent-skill recommendations...',
        stats: dataset.summaryMetrics.totals || {},
      };
      emit({ type: 'phase_update', ...analyzingPayload });
      persistProgress(analyzingPayload);

      this._throwIfCancelled(abortController.signal);
      const analysis = await this._analyzeDatasetWithTimeout(workspace.id, dataset, config?.llmModel, abortController.signal);
      this._throwIfCancelled(abortController.signal);
      const skillSplit = this._splitSkillAndTaxonomyRecommendations(analysis.skillRecommendations);
      const taxonomyRecommendations = this._mergeTaxonomyRecommendations([
        ...toArray(analysis.taxonomyRecommendations),
        ...skillSplit.taxonomyRecommendations,
        ...this._buildDeterministicTaxonomyRecommendations(dataset),
      ]);
      const agentSkillRecommendations = skillSplit.skillRecommendations;
      const mergedWarnings = [...dataset.warnings, ...(analysis.warnings || [])];

      run = await prisma.$transaction(async (tx) => {
        const updatedRun = await tx.assignmentDailyReviewRun.update({
          where: { id: run.id },
          data: {
            status: 'completed',
            summaryMetrics: sanitizeJsonForPostgres({
              ...dataset.summaryMetrics,
              executiveSummary: analysis.executiveSummary,
              collectionDiagnostics: dataset.collectionDiagnostics,
            }),
            analyzedTicketIds: dataset.analyzedTicketIds,
            evidenceCases: sanitizeJsonForPostgres(dataset.cases),
            promptRecommendations: sanitizeJsonForPostgres(analysis.promptRecommendations),
            processRecommendations: sanitizeJsonForPostgres(analysis.processRecommendations),
            skillRecommendations: sanitizeJsonForPostgres(agentSkillRecommendations),
            warnings: sanitizeJsonForPostgres(mergedWarnings),
            fullTranscript: sanitizeJsonForPostgres(analysis.transcript || null),
            totalTokensUsed: analysis.totalTokensUsed || 0,
            totalDurationMs: Date.now() - startedAt,
            completedAt: new Date(),
          },
        });
        await this._replaceRecommendationsForRun(tx, updatedRun, {
          promptRecommendations: analysis.promptRecommendations,
          processRecommendations: analysis.processRecommendations,
          taxonomyRecommendations,
          skillRecommendations: agentSkillRecommendations,
        });
        return updatedRun;
      });

      emit({
        type: 'recommendations_ready',
        executiveSummary: analysis.executiveSummary,
        promptCount: analysis.promptRecommendations?.length || 0,
        processCount: analysis.processRecommendations?.length || 0,
        taxonomyCount: taxonomyRecommendations.length,
        skillCount: agentSkillRecommendations.length,
      });
      const completedPayload = {
        phase: 'completed',
        percent: 100,
        message: 'Review complete.',
        stats: dataset.summaryMetrics.totals || {},
      };
      emit({ type: 'phase_update', ...completedPayload });
      // Final flush: write the terminal payload directly so polling clients
      // see "completed" the moment the next poll lands without any throttle delay.
      await prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: { progress: sanitizeJsonForPostgres(completedPayload), progressUpdatedAt: new Date() },
      }).catch(() => { /* progress is best-effort */ });
      emit({ type: 'daily_review_complete', runId: run.id });
      return run;
    } catch (error) {
      if (this._isCancellationError(error)) {
        run = await prisma.assignmentDailyReviewRun.update({
          where: { id: run.id },
          data: {
            status: 'cancelled',
            totalDurationMs: Date.now() - startedAt,
            completedAt: new Date(),
            progress: sanitizeJsonForPostgres({ phase: 'cancelled', percent: 100, message: error.message, stats: {} }),
            progressUpdatedAt: new Date(),
          },
        });
        emit({ type: 'phase_update', phase: 'cancelled', message: error.message, percent: 100 });
        emit({ type: 'cancelled', runId: run.id, message: error.message });
        emit({ type: 'daily_review_complete', runId: run.id });
        return run;
      }

      logger.error('Daily review run failed', { workspaceId: workspace.id, reviewDate: dateStr, error: error.message });
      run = await prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: error.message,
          totalDurationMs: Date.now() - startedAt,
          completedAt: new Date(),
          progress: sanitizeJsonForPostgres({ phase: 'failed', percent: 100, message: error.message, stats: {} }),
          progressUpdatedAt: new Date(),
        },
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'daily_review_complete', runId: run.id });
      return run;
    } finally {
      this.activeRunControllers.delete(run?.id);
    }
  }

  async getRuns(workspaceId, { limit = 20, offset = 0 } = {}) {
    await this._markStaleRunsFailed(workspaceId);
    await this._migrateRecentTaxonomySkillRecommendations(workspaceId);
    const [items, total] = await Promise.all([
      prisma.assignmentDailyReviewRun.findMany({
        where: { workspaceId },
        // History is an execution log. Sort by when a run was created, not
        // the reviewed business date, so manual backfills/range reviews do not
        // disappear behind newer scheduled failures for a later review date.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.assignmentDailyReviewRun.count({ where: { workspaceId } }),
    ]);
    await this._ensureRecommendationRowsForRuns(workspaceId, items);

    const runIds = items.map((item) => item.id);
    const rows = runIds.length > 0
      ? await prisma.assignmentDailyReviewRecommendation.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, status: true },
      })
      : [];

    const countsByRun = new Map();
    for (const row of rows) {
      if (!countsByRun.has(row.runId)) {
        countsByRun.set(row.runId, {
          pending: 0,
          approved: 0,
          rejected: 0,
          applied: 0,
        });
      }
      countsByRun.get(row.runId)[row.status] += 1;
    }

    return {
      items: items.map((item) => ({
        ...item,
        recommendationStatusCounts: countsByRun.get(item.id) || {
          pending: 0,
          approved: 0,
          rejected: 0,
          applied: 0,
        },
      })),
      total,
    };
  }

  async getRun(id) {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id } });
    if (!run) return null;

    await this._markStaleRunsFailed(run.workspaceId);
    const refreshedRun = ACTIVE_STATUSES.includes(run.status)
      ? await prisma.assignmentDailyReviewRun.findUnique({ where: { id } })
      : run;

    await this._migrateRecentTaxonomySkillRecommendations(refreshedRun.workspaceId);
    await this._ensureRecommendationRowsForRuns(refreshedRun.workspaceId, [refreshedRun]);
    const rows = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: { runId: id },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
      orderBy: [{ kind: 'asc' }, { ordinal: 'asc' }],
    });

    return {
      ...refreshedRun,
      ...this._groupRecommendations(rows),
    };
  }

  async listRecommendations(workspaceId, {
    status,
    kind,
    severity,
    startDate,
    endDate,
    runId,
    limit = 100,
    offset = 0,
  } = {}) {
    if (status && status !== 'all') this._validateRecommendationStatus(status);
    if (kind) this._validateRecommendationKind(kind);

    await this._markStaleRunsFailed(workspaceId);
    await this._migrateRecentTaxonomySkillRecommendations(workspaceId);
    await this._ensureRecommendationRowsForWorkspace(workspaceId, { startDate, endDate });

    const where = { workspaceId };
    if (status && status !== 'all') where.status = status;
    if (kind && kind !== 'all') where.kind = kind;
    if (severity && severity !== 'all') where.severity = String(severity).toLowerCase();
    if (startDate || endDate) {
      where.reviewDate = {};
      if (startDate) where.reviewDate.gte = reviewDateKey(startDate);
      if (endDate) where.reviewDate.lte = reviewDateKey(endDate);
    }
    // Accepts a numeric id, a numeric string, or a label like "Run #12" /
    // "#12" / "run 12" — anything the admin would type after seeing the
    // "Run #N" label in the UI. Non-matching input narrows to no rows so
    // the UI shows "no results" instead of silently ignoring the filter.
    if (runId !== undefined && runId !== null && runId !== '') {
      const numeric = typeof runId === 'number'
        ? runId
        : parseInt(String(runId).replace(/[^0-9]/g, ''), 10);
      where.runId = Number.isInteger(numeric) && numeric > 0 ? numeric : -1;
    }

    const [items, total] = await Promise.all([
      prisma.assignmentDailyReviewRecommendation.findMany({
        where,
        include: {
          run: {
            select: { id: true, reviewDate: true, triggeredBy: true, status: true },
          },
        },
        orderBy: [{ reviewDate: 'desc' }, { kind: 'asc' }, { ordinal: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.assignmentDailyReviewRecommendation.count({ where }),
    ]);

    return {
      items: items.map((item) => this._toRecommendationDto(item)),
      total,
    };
  }

  async updateRecommendation(id, workspaceId, { status, reviewNotes, actorEmail }) {
    this._validateRecommendationStatus(status);

    const existing = await prisma.assignmentDailyReviewRecommendation.findUnique({
      where: { id },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });
    if (!existing) return null;
    if (existing.workspaceId !== workspaceId) {
      throw new Error('Recommendation belongs to a different workspace');
    }
    if (status === 'applied' && !['approved', 'applied'].includes(existing.status)) {
      throw new Error('Recommendation must be approved before it can be marked as applied');
    }

    const now = new Date();
    const data = {
      status,
    };

    if (reviewNotes !== undefined) {
      data.reviewNotes = reviewNotes?.trim() || null;
    }

    if (status === 'pending') {
      data.reviewedBy = null;
      data.reviewedAt = null;
      data.appliedBy = null;
      data.appliedAt = null;
    } else if (status === 'approved' || status === 'rejected') {
      data.reviewedBy = actorEmail;
      data.reviewedAt = now;
      data.appliedBy = null;
      data.appliedAt = null;
    } else if (status === 'applied') {
      data.appliedBy = actorEmail;
      data.appliedAt = now;
      if (!existing.reviewedAt) {
        data.reviewedBy = actorEmail;
        data.reviewedAt = now;
      }
    }

    const updated = await prisma.assignmentDailyReviewRecommendation.update({
      where: { id },
      data,
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });

    return this._toRecommendationDto(updated);
  }

  async bulkUpdateRecommendations(workspaceId, { ids = [], status, reviewNotes, actorEmail }) {
    this._validateRecommendationStatus(status);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('ids must contain at least one recommendation id');
    }

    const existing = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: { id: { in: ids } },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });

    if (existing.some((item) => item.workspaceId !== workspaceId)) {
      throw new Error('One or more recommendations belong to a different workspace');
    }
    if (status === 'applied' && existing.some((item) => !['approved', 'applied'].includes(item.status))) {
      throw new Error('All selected recommendations must be approved before they can be marked as applied');
    }

    const updates = await Promise.all(existing.map((item) => this.updateRecommendation(item.id, workspaceId, {
      status,
      reviewNotes,
      actorEmail,
    })));

    return {
      updated: updates.length,
      items: updates,
    };
  }

  // Generates a one-page meeting briefing from a completed daily review.
  // The briefing is intentionally separate from the structured prompt /
  // process / skill recommendations: those are *operational* artifacts the
  // admin acts on; the briefing is a *narrative* summary the team reads at
  // the next-day standup. We persist it on the run record so it survives
  // refreshes; regeneration overwrites the previous version.
  async generateMeetingBriefing(runId, workspaceId, { actorEmail = 'admin', tone = 'standup' } = {}) {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error('Daily review run not found');
    if (run.workspaceId !== workspaceId) throw new Error('Run belongs to a different workspace');
    if (run.status !== 'completed') {
      throw new Error(`Briefing can only be generated for completed runs (current status: ${run.status})`);
    }

    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) throw new Error('Anthropic API key is not configured on the server');

    const summary = run.summaryMetrics || {};
    const totals = summary.totals || {};
    const rates = summary.rates || {};
    const cases = Array.isArray(run.evidenceCases) ? run.evidenceCases : [];

    // Compact case payload — same shape we use for the recommendation
    // analysis, but also passing finalAssignee and rebound context so the
    // briefing can name names and tell a chronological story.
    const trimmedCases = cases
      .slice(0, 30)
      .map((item) => ({
        ticketId: item.ticketId,
        freshserviceTicketId: item.freshserviceTicketId,
        subject: item.subject,
        category: item.category,
        priority: item.priority,
        status: item.status,
        outcome: item.outcome,
        primaryTag: item.primaryTag,
        decision: item.decision,
        triggerSource: item.triggerSource,
        topRecommendation: item.topRecommendation?.techName || null,
        finalAssignee: item.finalAssignee?.name || null,
        rebounded: item.tags?.includes('rebounded') || false,
        overrideReason: item.overrideReason || null,
        decisionNote: item.decisionNote || null,
        ticketCreatedAt: item.ticketCreatedAt,
        resolvedAt: item.resolvedAt,
      }));

    const recommendationsContext = {
      prompt: (run.promptRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
      process: (run.processRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
      skill: (run.skillRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
    };

    const reviewDateStr = run.reviewDate instanceof Date
      ? run.reviewDate.toISOString().slice(0, 10)
      : String(run.reviewDate).slice(0, 10);

    const allowedFreshserviceIds = new Set(
      trimmedCases.map((c) => Number(c.freshserviceTicketId)).filter(Boolean),
    );
    const allowedInternalIds = new Set(
      trimmedCases.map((c) => Number(c.ticketId)).filter(Boolean),
    );

    const briefingInput = {
      workspaceName: summary.workspaceName || 'this workspace',
      reviewDate: reviewDateStr,
      timezone: run.timezone,
      reviewWindow: summary.reviewWindow || null,
      totals,
      rates,
      topCategories: summary.topCategories || [],
      topTechnicians: summary.topTechnicians || [],
      executiveSummary: summary.executiveSummary || null,
      cases: trimmedCases,
      recommendations: recommendationsContext,
      warnings: run.warnings || [],
      allowedSupportingTicketIds: Array.from(allowedInternalIds),
      allowedSupportingFreshserviceTicketIds: Array.from(allowedFreshserviceIds),
    };

    const TOOL = {
      name: 'submit_meeting_briefing',
      description: `Submit the one-page meeting briefing for the "${briefingInput.workspaceName}" workspace's ${reviewDateStr} daily review. Call this tool exactly once. Every ticket id you cite must come from briefingInput.allowedSupportingFreshserviceTicketIds — do not invent ids or technician names.`,
      input_schema: {
        type: 'object',
        properties: {
          headline: {
            type: 'string',
            description: 'A punchy, specific one-line summary of the day (max ~120 chars). Avoid generic phrasing like "Daily review summary"; name what actually drove the day.',
          },
          narrative: {
            type: 'string',
            description: 'A 2-4 short paragraph story of the day in clear conversational English. Tell the day chronologically when possible. Reference real ticket categories, technician names, and notable cases. Keep it readable in under 60 seconds out loud.',
          },
          keyMetrics: {
            type: 'array',
            description: 'The 3-6 numbers worth saying out loud at the standup. Each is a label + value + a short bit of context.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string', description: 'The metric value as a string (e.g., "47", "92%", "2 reroutes").' },
                context: { type: 'string', description: 'Optional short qualifier (e.g., "vs typical 35").' },
                tone: { type: 'string', enum: ['good', 'bad', 'neutral', 'watch'] },
              },
              required: ['label', 'value', 'tone'],
            },
          },
          highlights: {
            type: 'array',
            description: 'Scannable callouts grouped by tone. Examples: a clean win, a problem ticket, a tech who carried load, a category that caused friction.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
                tone: { type: 'string', enum: ['good', 'bad', 'neutral', 'watch'] },
                supportingFreshserviceTicketIds: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'Optional ticket ids from briefingInput.allowedSupportingFreshserviceTicketIds that back up this highlight.',
                },
              },
              required: ['title', 'detail', 'tone'],
            },
          },
          talkingPoints: {
            type: 'array',
            description: 'Concrete questions or follow-ups for the team to discuss in the standup (e.g., "Should we add a Tableau competency?").',
            items: { type: 'string' },
          },
          shoutouts: {
            type: 'array',
            description: 'Optional named shoutouts to technicians who carried meaningful load or handled tricky cases. Only include techs that appear in the supplied cases.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['name', 'reason'],
            },
          },
          lookahead: {
            type: 'string',
            description: '1-2 sentences about what the team should watch today (carried-over tickets, repeat offenders, follow-ups).',
          },
        },
        required: ['headline', 'narrative', 'keyMetrics', 'highlights', 'talkingPoints', 'lookahead'],
      },
    };

    const toneGuidance = tone === 'executive'
      ? 'Tone: executive briefing. Crisp, business-focused, no jargon.'
      : 'Tone: morning standup. Conversational, scannable, useful for a 5-minute daily team sync.';

    const systemPrompt = `You are preparing a one-page meeting briefing for the "${briefingInput.workspaceName}" team's daily standup. The briefing covers the previous business day of automated ticket assignments.

${toneGuidance}

Hard rules:
- Make the day come alive: highlight what went well, what went wrong, who carried the load, what categories caused friction, and what should be on the team's radar today.
- The headline must be specific to today's data — never generic.
- Reference real ticket categories, technician names, and ticket numbers from the supplied cases. Do NOT invent ids, names, or events that are not in the data.
- Every ticket id you cite in highlights.supportingFreshserviceTicketIds MUST come from briefingInput.allowedSupportingFreshserviceTicketIds. Anything else will be discarded.
- Stay scoped to the "${briefingInput.workspaceName}" workspace. Do not reference other workspaces.
- Use the tool exactly once.`;

    const userMessage = `Daily review dataset for the meeting briefing:\n\n${JSON.stringify(briefingInput, null, 2)}\n\nSubmit the briefing using the tool.`;

    const llmModel = run.llmModel || 'claude-sonnet-4-6-20260217';
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: llmModel,
      max_tokens: 3000,
      system: systemPrompt,
      tools: [TOOL],
      messages: [{ role: 'user', content: userMessage }],
    });

    const submission = response.content.find(
      (block) => block.type === 'tool_use' && block.name === 'submit_meeting_briefing',
    )?.input;

    if (!submission) {
      throw new Error('LLM did not return a structured meeting briefing');
    }

    // Defence-in-depth: same allow-list filtering pattern we use for the
    // recommendation supporting-ids, applied to the briefing's highlight
    // citations. Any ticket id outside the allow-list is dropped to prevent
    // hallucinated cross-workspace references from leaking into the standup.
    const cleanedHighlights = (submission.highlights || []).map((item) => {
      const cleanedIds = Array.isArray(item.supportingFreshserviceTicketIds)
        ? item.supportingFreshserviceTicketIds.filter((id) => allowedFreshserviceIds.has(Number(id)))
        : [];
      return { ...item, supportingFreshserviceTicketIds: cleanedIds };
    });

    const briefing = {
      headline: String(submission.headline || '').trim(),
      narrative: String(submission.narrative || '').trim(),
      keyMetrics: Array.isArray(submission.keyMetrics) ? submission.keyMetrics : [],
      highlights: cleanedHighlights,
      talkingPoints: Array.isArray(submission.talkingPoints) ? submission.talkingPoints : [],
      shoutouts: Array.isArray(submission.shoutouts) ? submission.shoutouts : [],
      lookahead: String(submission.lookahead || '').trim(),
      generatedAt: new Date().toISOString(),
      tone,
    };

    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    const updated = await prisma.assignmentDailyReviewRun.update({
      where: { id: runId },
      data: {
        meetingBriefing: briefing,
        meetingBriefingGeneratedAt: new Date(),
        meetingBriefingTokens: tokens,
        meetingBriefingModel: llmModel,
        meetingBriefingBy: actorEmail,
      },
    });

    return {
      briefing: updated.meetingBriefing,
      generatedAt: updated.meetingBriefingGeneratedAt,
      tokens: updated.meetingBriefingTokens,
      model: updated.meetingBriefingModel,
      generatedBy: updated.meetingBriefingBy,
    };
  }

  async cancelRun(id, workspaceId, cancelledBy = 'admin') {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id } });
    if (!run) return null;
    if (run.workspaceId !== workspaceId) {
      throw new Error('Run belongs to a different workspace');
    }
    if (!ACTIVE_STATUSES.includes(run.status)) {
      throw new Error(`Run is not running (status: ${run.status})`);
    }

    this.activeRunControllers.get(id)?.abort();

    return prisma.assignmentDailyReviewRun.update({
      where: { id },
      data: {
        status: 'cancelled',
        errorMessage: `Cancelled by ${cancelledBy}`,
        completedAt: new Date(),
      },
    });
  }

  async deleteRun(id, workspaceId) {
    const run = await prisma.assignmentDailyReviewRun.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, status: true },
    });
    if (!run) return null;
    if (run.workspaceId !== workspaceId) {
      throw new Error('Run belongs to a different workspace');
    }
    if (ACTIVE_STATUSES.includes(run.status)) {
      throw new Error('Cancel this run before deleting it');
    }

    return prisma.$transaction(async (tx) => {
      await tx.assignmentDailyReviewRecommendation.deleteMany({ where: { runId: id } });
      return tx.assignmentDailyReviewRun.delete({ where: { id } });
    });
  }

  async maybeRunScheduledReview(workspace) {
    const { config, timezone } = await this._getWorkspaceContext(workspace.id);
    if (!config?.dailyReviewEnabled) return { triggered: false, reason: 'disabled' };

    const now = new Date();
    const zoned = toZonedTime(now, timezone);
    const dayOfWeek = zoned.getDay();
    const hours = await availabilityService.getBusinessHours(workspace.id);
    const dayConfig = hours.find((entry) => entry.dayOfWeek === dayOfWeek && entry.isEnabled);
    if (!dayConfig) return { triggered: false, reason: 'non_business_day' };

    const reviewDate = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
    const scheduledAt = new Date(
      formatInTimeZone(
        new Date(`${reviewDate}T12:00:00.000Z`),
        timezone,
        `yyyy-MM-dd'T'${String(config.dailyReviewRunHour).padStart(2, '0')}:${String(config.dailyReviewRunMinute).padStart(2, '0')}:00XXX`,
      ),
    );

    if (now < scheduledAt) {
      return { triggered: false, reason: 'before_window' };
    }

    // Latest run for this date — there can now be multiple (each manual rerun
    // creates a fresh row), so we look at the newest one to decide whether
    // the scheduled job should pile on yet another run.
    const existing = await prisma.assignmentDailyReviewRun.findFirst({
      where: {
        workspaceId: workspace.id,
        reviewDate: reviewDateKey(reviewDate),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      if (existing.status === 'completed' || ACTIVE_STATUSES.includes(existing.status)) {
        return { triggered: false, reason: 'already_exists' };
      }
      if (existing.status === 'failed') {
        return { triggered: false, reason: 'already_failed_today' };
      }
      if (existing.status === 'cancelled') {
        return { triggered: false, reason: 'already_cancelled_today' };
      }
    }

    await this.runReview(workspace.id, reviewDate, 'scheduled_daily_review', {
      triggerSource: 'scheduled',
      force: false,
    });
    return { triggered: true };
  }
}

export default new AssignmentDailyReviewService();
