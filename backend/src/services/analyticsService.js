import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import competencyRepository from './competencyRepository.js';
import { getTodayRange } from '../utils/timezone.js';
import { getCategoryMode, normalizeTicketCategory } from '../utils/ticketCategoryNormalizer.js';

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const OPEN_STATUSES = ['Open', 'Pending', 'Waiting on Customer'];
const CLOSED_STATUSES = ['Closed', 'Resolved'];
const RANGE_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const CACHE_TTL_MS = 15_000;
const cache = new Map();
const pendingCache = new Map();

const PRIORITY_LABELS = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

const SOURCE_LABELS = {
  1: 'Email',
  2: 'Portal',
  3: 'Phone',
  4: 'Chat',
  9: 'Feedback Widget',
  14: 'Bot',
  15: 'Marketplace',
  1001: 'System',
  1002: 'Workflow',
};

const CATEGORY_TICKET_SELECT = {
  id: true,
  freshserviceTicketId: true,
  subject: true,
  status: true,
  priority: true,
  source: true,
  createdAt: true,
  firstAssignedAt: true,
  dueBy: true,
  frDueBy: true,
  assignedBy: true,
  assignedTechId: true,
  isSelfPicked: true,
  ticketCategory: true,
  tpSkill: true,
  tpSubskill: true,
  internalCategoryId: true,
  internalCategory: { select: { id: true, name: true } },
  internalSubcategoryId: true,
  internalSubcategory: { select: { id: true, name: true, parentId: true } },
  internalCategoryFit: true,
  internalSubcategoryFit: true,
  taxonomyReviewNeeded: true,
  resolutionTimeSeconds: true,
  csatScore: true,
  csatTotalScore: true,
  csatSubmittedAt: true,
  isNoise: true,
  rejectionCount: true,
  requester: { select: { name: true, email: true } },
  assignedTech: { select: { id: true, name: true, photoUrl: true } },
};

function dateKeyToUtcNoon(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`);
}

function inclusiveCalendarDays(startDateKey, endDateKey) {
  const startNoon = dateKeyToUtcNoon(startDateKey);
  const endNoon = dateKeyToUtcNoon(endDateKey);
  return Math.max(1, Math.round((endNoon - startNoon) / 864e5) + 1);
}

function businessDays(startDateKey, endDateKey) {
  let count = 0;
  const cursor = dateKeyToUtcNoon(startDateKey);
  const end = dateKeyToUtcNoon(endDateKey);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, count);
}

function isBusinessDateKey(dateKey) {
  const day = dateKeyToUtcNoon(dateKey).getUTCDay();
  return day !== 0 && day !== 6;
}

export function parseAnalyticsRange(query = {}, reference = new Date()) {
  const timezone = query.timezone || DEFAULT_TIMEZONE;
  const range = query.range || '30d';
  const compare = query.compare === 'none' ? 'none' : 'previous';
  const groupBy = ['day', 'week', 'month'].includes(query.groupBy) ? query.groupBy : 'day';

  let start;
  let end;

  if (range === 'custom' && query.start && query.end) {
    start = getTodayRange(timezone, new Date(`${query.start}T12:00:00Z`)).start;
    end = getTodayRange(timezone, new Date(`${query.end}T12:00:00Z`)).end;
  } else if (range === '12m') {
    const endDay = getTodayRange(timezone, reference);
    const startRef = new Date(endDay.end);
    startRef.setMonth(startRef.getMonth() - 11);
    start = getTodayRange(timezone, startRef).start;
    end = endDay.end;
  } else {
    const days = RANGE_DAYS[range] || RANGE_DAYS['30d'];
    const endDay = getTodayRange(timezone, reference);
    const startRef = new Date(endDay.end);
    startRef.setDate(startRef.getDate() - (days - 1));
    start = getTodayRange(timezone, startRef).start;
    end = endDay.end;
  }

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  const startDate = formatInTimeZone(start, timezone, 'yyyy-MM-dd');
  const endDate = formatInTimeZone(end, timezone, 'yyyy-MM-dd');
  const days = inclusiveCalendarDays(startDate, endDate);
  const previousEndRef = dateKeyToUtcNoon(startDate);
  previousEndRef.setUTCDate(previousEndRef.getUTCDate() - 1);
  const previousStartRef = new Date(previousEndRef);
  previousStartRef.setUTCDate(previousStartRef.getUTCDate() - (days - 1));
  const previousEnd = getTodayRange(timezone, previousEndRef).end;
  const previousStart = getTodayRange(timezone, previousStartRef).start;

  return {
    range,
    timezone,
    groupBy,
    compare,
    start,
    end,
    previousStart,
    previousEnd,
    startDate,
    endDate,
    previousStartDate: formatInTimeZone(previousStart, timezone, 'yyyy-MM-dd'),
    previousEndDate: formatInTimeZone(previousEnd, timezone, 'yyyy-MM-dd'),
  };
}

export function calculateDelta(current, previous) {
  const safeCurrent = Number(current || 0);
  const safePrevious = Number(previous || 0);
  const change = safeCurrent - safePrevious;
  return {
    current: safeCurrent,
    previous: safePrevious,
    change,
    pct: safePrevious === 0 ? null : Number(((change / safePrevious) * 100).toFixed(1)),
  };
}

export function summarizeNumeric(values = []) {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, avg: null, median: null, p90: null, min: null, max: null };
  }
  const percentile = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    avg: Number((sum / sorted.length).toFixed(1)),
    median: percentile(50),
    p90: percentile(90),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function buildInsight({ id, title, severity = 'info', rule, evidenceCount = 0, affected = [], drilldown = [], description }) {
  return {
    id,
    title,
    severity,
    rule,
    evidenceCount,
    affected,
    drilldown,
    description,
  };
}

function cacheKey(workspaceId, endpoint, query) {
  const normalized = Object.keys(query || {})
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&');
  return `${workspaceId}:${endpoint}:${normalized}`;
}

async function withCache(workspaceId, endpoint, query, producer) {
  const key = cacheKey(workspaceId, endpoint, query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.createdAt < CACHE_TTL_MS) return hit.value;

  const pending = pendingCache.get(key);
  if (pending) return pending;

  const pendingValue = producer()
    .then((value) => {
      cache.set(key, { createdAt: Date.now(), value });
      return value;
    })
    .finally(() => {
      pendingCache.delete(key);
    });

  pendingCache.set(key, pendingValue);
  return pendingValue;
}

function metadata(rangeInfo, extra = {}) {
  return {
    range: {
      key: rangeInfo.range,
      start: rangeInfo.startDate,
      end: rangeInfo.endDate,
      timezone: rangeInfo.timezone,
      groupBy: rangeInfo.groupBy,
      compare: rangeInfo.compare,
      previousStart: rangeInfo.compare === 'none' ? null : rangeInfo.previousStartDate,
      previousEnd: rangeInfo.compare === 'none' ? null : rangeInfo.previousEndDate,
    },
    caveats: [
      'Resolution analytics use resolutionTimeSeconds because closedAt/resolvedAt are sparse in the local dataset.',
      'First-response analytics are intentionally omitted because firstPublicAgentReplyAt is not populated.',
      'Category analytics use Ticket Pulse category/subcategory first, then Freshservice mirror fields, then legacy ticketCategory only for historical continuity.',
      'CSAT cards show sample size because survey coverage is low.',
    ],
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

function parseCsvStrings(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function parseCsvInts(value) {
  return parseCsvStrings(value)
    .map((item) => Number(item))
    .filter(Number.isInteger);
}

export function categoryFilterForQuery(workspaceId, query = {}) {
  const mode = getCategoryMode(workspaceId);
  if (mode === 'canonical') {
    const categoryIds = parseCsvInts(query.categoryIds);
    const subcategoryIds = parseCsvInts(query.subcategoryIds);
    let where = {};
    if (categoryIds.length > 0 && subcategoryIds.length > 0) {
      where = {
        OR: [
          { internalCategoryId: { in: categoryIds } },
          { internalSubcategoryId: { in: subcategoryIds } },
        ],
      };
    } else if (categoryIds.length > 0) {
      where = { internalCategoryId: { in: categoryIds } };
    } else if (subcategoryIds.length > 0) {
      where = { internalSubcategoryId: { in: subcategoryIds } };
    }
    return {
      mode,
      where,
      selected: { categoryIds, subcategoryIds, legacyCategories: [] },
    };
  }

  const legacyCategories = parseCsvStrings(query.legacyCategories);
  return {
    mode,
    where: legacyCategories.length > 0 ? { ticketCategory: { in: legacyCategories } } : {},
    selected: { categoryIds: [], subcategoryIds: [], legacyCategories },
  };
}

function hasWhereClause(where = {}) {
  return Object.keys(where || {}).length > 0;
}

function withCategoryWhere(baseWhere, categoryWhere = {}) {
  if (!hasWhereClause(categoryWhere)) return baseWhere;
  return {
    ...baseWhere,
    AND: [
      ...(Array.isArray(baseWhere.AND) ? baseWhere.AND : baseWhere.AND ? [baseWhere.AND] : []),
      categoryWhere,
    ],
  };
}

function ticketRelationWhere(excludeNoise, categoryWhere = {}) {
  const base = excludeNoise ? { isNoise: false } : {};
  return withCategoryWhere(base, categoryWhere);
}

function ticketBaseWhere(workspaceId, rangeInfo, excludeNoise, dateField = 'createdAt', categoryWhere = {}) {
  return withCategoryWhere({
    workspaceId,
    ...(excludeNoise ? { isNoise: false } : {}),
    [dateField]: { gte: rangeInfo.start, lte: rangeInfo.end },
  }, categoryWhere);
}

function assignmentRangeWhere(workspaceId, rangeInfo, excludeNoise = false, categoryWhere = {}) {
  return withCategoryWhere({
    workspaceId,
    ...(excludeNoise ? { isNoise: false } : {}),
    OR: [
      { firstAssignedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
      {
        firstAssignedAt: null,
        createdAt: { gte: rangeInfo.start, lte: rangeInfo.end },
      },
    ],
  }, categoryWhere);
}

function dbDateRange(rangeInfo) {
  return {
    start: new Date(`${rangeInfo.startDate}T00:00:00.000Z`),
    end: new Date(`${rangeInfo.endDate}T23:59:59.999Z`),
  };
}

function assignedAt(ticket) {
  return ticket.firstAssignedAt || ticket.createdAt;
}

function groupKey(date, rangeInfo) {
  if (!date) return 'unknown';
  if (rangeInfo.groupBy === 'month') {
    return formatInTimeZone(date, rangeInfo.timezone, 'yyyy-MM');
  }
  if (rangeInfo.groupBy === 'week') {
    const dayKey = formatInTimeZone(date, rangeInfo.timezone, 'yyyy-MM-dd');
    const d = new Date(`${dayKey}T12:00:00Z`);
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return formatInTimeZone(d, rangeInfo.timezone, 'yyyy-MM-dd');
  }
  return formatInTimeZone(date, rangeInfo.timezone, 'yyyy-MM-dd');
}

function timelineKeys(rangeInfo) {
  const keys = [];
  const seen = new Set();
  const cursor = dateKeyToUtcNoon(rangeInfo.startDate);
  const end = dateKeyToUtcNoon(rangeInfo.endDate);
  while (cursor <= end) {
    const key = groupKey(cursor, rangeInfo);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function topFromMap(map, limit = 10) {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name: name || 'Unknown', count }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);
}

function ticketPulseCategoryParts(ticket, workspaceId) {
  const normalized = normalizeTicketCategory(ticket, workspaceId);
  return {
    categoryId: normalized.categoryId,
    subcategoryId: normalized.subcategoryId,
    category: normalized.categoryName,
    subcategory: normalized.subcategoryName,
    label: normalized.categoryLabel || 'Uncategorized',
    source: normalized.categorySource,
    legacyCategory: normalized.legacyCategory,
    reviewNeeded: normalized.taxonomyReviewNeeded,
  };
}

function canonicalSkillLabel(ticket, workspaceId) {
  return ticketPulseCategoryParts(ticket, workspaceId).label;
}

export function categoryBreakdownFromTickets(tickets, limit = 10, workspaceId = null) {
  const byLabel = new Map();
  const coverage = {
    canonical: 0,
    legacyFallback: 0,
    legacy: 0,
    reviewNeeded: 0,
    unmapped: 0,
    total: tickets.length,
  };
  for (const ticket of tickets) {
    const parts = ticketPulseCategoryParts(ticket, workspaceId);
    coverage[parts.source] += 1;
    if (parts.reviewNeeded) coverage.reviewNeeded += 1;
    const row = byLabel.get(parts.label) || {
      name: parts.label,
      count: 0,
      categoryId: parts.categoryId,
      subcategoryId: parts.subcategoryId,
      canonicalCount: 0,
      legacyFallbackCount: 0,
      legacyCount: 0,
      unmappedCount: 0,
      reviewNeededCount: 0,
      source: parts.source,
    };
    row.count += 1;
    if (parts.source === 'canonical') row.canonicalCount += 1;
    if (parts.source === 'legacyFallback') row.legacyFallbackCount += 1;
    if (parts.source === 'legacy') row.legacyCount += 1;
    if (parts.source === 'unmapped') row.unmappedCount += 1;
    if (parts.reviewNeeded) row.reviewNeededCount += 1;
    if (row.canonicalCount > 0) row.source = 'canonical';
    else if (row.legacyFallbackCount > 0) row.source = 'legacyFallback';
    else if (row.legacyCount > 0) row.source = 'legacy';
    else row.source = 'unmapped';
    byLabel.set(parts.label, row);
  }
  const rows = Array.from(byLabel.values())
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((row) => ({
      ...row,
      pct: coverage.total ? Number(((row.count / coverage.total) * 100).toFixed(1)) : 0,
    }));
  return { rows, coverage };
}

function categoryIdentity(ticket, workspaceId) {
  const parts = ticketPulseCategoryParts(ticket, workspaceId);
  const categoryId = parts.categoryId ?? null;
  const subcategoryId = parts.subcategoryId ?? null;
  const categoryName = parts.category || (parts.source === 'legacy' ? parts.label : null);
  const subcategoryName = parts.subcategory || null;
  const isCanonical = getCategoryMode(workspaceId) === 'canonical';
  const categoryKey = isCanonical && categoryId
    ? `category:${categoryId}`
    : `category-label:${categoryName || parts.label || 'Uncategorized'}`;
  const leafKey = isCanonical && subcategoryId
    ? `subcategory:${subcategoryId}`
    : categoryKey;
  const label = subcategoryName && categoryName
    ? `${categoryName} / ${subcategoryName}`
    : (categoryName || parts.label || 'Uncategorized');

  return {
    ...parts,
    categoryKey,
    leafKey,
    categoryName: categoryName || 'Uncategorized',
    subcategoryName,
    label,
    isSubcategory: leafKey !== categoryKey,
  };
}

function emptyCategoryRow(identity, source = 'canonical') {
  return {
    key: identity.leafKey,
    categoryKey: identity.categoryKey,
    name: identity.label,
    categoryName: identity.categoryName,
    subcategoryName: identity.subcategoryName,
    categoryId: identity.categoryId,
    subcategoryId: identity.subcategoryId,
    source: identity.source || source,
    created: 0,
    assigned: 0,
    open: 0,
    overdue: 0,
    reviewNeeded: 0,
    unmapped: 0,
    reviewTicketIds: new Set(),
    unmappedTicketIds: new Set(),
    selfPicked: 0,
    coordinatorAssigned: 0,
    appAssigned: 0,
    unknown: 0,
    csatResponses: 0,
    csatTotal: 0,
    resolutionValues: [],
    recentTickets: [],
    automationRuns: 0,
    automationFailures: 0,
    automationRebounds: 0,
  };
}

function finalizeCategoryRow(row, totalCreated = 0) {
  const resolution = summarizeNumeric(row.resolutionValues || []);
  const reviewNeeded = row.reviewTicketIds?.size || row.reviewNeeded || 0;
  const unmapped = row.unmappedTicketIds?.size || row.unmapped || 0;
  return {
    key: row.key,
    categoryKey: row.categoryKey,
    name: row.name,
    categoryName: row.categoryName,
    subcategoryName: row.subcategoryName,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    source: row.source,
    created: row.created,
    assigned: row.assigned,
    open: row.open,
    overdue: row.overdue,
    reviewNeeded,
    unmapped,
    createdPct: totalCreated ? Number(((row.created / totalCreated) * 100).toFixed(1)) : 0,
    assignmentMix: {
      selfPicked: row.selfPicked,
      coordinatorAssigned: row.coordinatorAssigned,
      appAssigned: row.appAssigned,
      unknown: row.unknown,
    },
    csatAverage: row.csatResponses ? Number((row.csatTotal / row.csatResponses).toFixed(2)) : null,
    csatResponses: row.csatResponses,
    resolutionSample: resolution.count,
    medianResolutionHours: resolution.median === null ? null : Number((resolution.median / 3600).toFixed(1)),
    p90ResolutionHours: resolution.p90 === null ? null : Number((resolution.p90 / 3600).toFixed(1)),
    automationRuns: row.automationRuns,
    automationFailures: row.automationFailures,
    automationFailureRatePct: row.automationRuns ? Number(((row.automationFailures / row.automationRuns) * 100).toFixed(1)) : 0,
    automationRebounds: row.automationRebounds,
    pressureScore: (row.open * 2) + (row.overdue * 4) + reviewNeeded + row.automationFailures,
    recentTickets: row.recentTickets.slice(0, 15),
  };
}

function buildCategoryHierarchy(rows, mode) {
  const visibleRows = rows.filter((row) => (
    (row.created || 0) > 0
    // Canonical IT treemap is taxonomy-only. Fallback/unmapped rows stay in data-quality
    // totals, insights, and row lists, but should not become chart sections for some ranges.
    && (mode !== 'canonical' || row.source === 'canonical')
  ));
  const canonicalCategoryByName = new Map();
  if (mode === 'canonical') {
    for (const row of visibleRows) {
      if (!row.categoryId || !row.categoryName) continue;
      canonicalCategoryByName.set(String(row.categoryName).trim().toLowerCase(), {
        key: row.categoryKey,
        id: row.categoryId,
        name: row.categoryName,
      });
    }
  }
  const resolvedRows = visibleRows.map((row) => {
    const categoryName = row.categoryName || row.name;
    const canonicalCategory = mode === 'canonical' && !row.categoryId && categoryName
      ? canonicalCategoryByName.get(String(categoryName).trim().toLowerCase())
      : null;
    const unmatchedLegacyFallback = mode === 'canonical'
      && !canonicalCategory
      && !row.categoryId
      && row.source === 'legacyFallback';
    return {
      ...row,
      categoryKey: canonicalCategory?.key || (unmatchedLegacyFallback ? 'legacy-fallback' : row.categoryKey),
      categoryId: canonicalCategory?.id || row.categoryId,
      categoryName: canonicalCategory?.name || (unmatchedLegacyFallback ? 'Legacy fallback' : categoryName),
      isCategoryOnlyRow: row.key === row.categoryKey && !unmatchedLegacyFallback,
      agentLeafKey: row.key,
    };
  });
  const nodes = [];
  const categoryNodes = new Map();
  const categoryTotals = new Map();
  const groupedSmallByCategory = new Map();
  const categoryOnlyByCategory = new Map();
  const smallNodeThreshold = mode === 'canonical' ? 5 : 0;
  const smallChildCounts = new Map();
  if (smallNodeThreshold > 0) {
    for (const row of resolvedRows) {
      if (row.isCategoryOnlyRow) continue;
      if ((row.created || 0) > 0 && (row.created || 0) < smallNodeThreshold) {
        smallChildCounts.set(row.categoryKey, (smallChildCounts.get(row.categoryKey) || 0) + 1);
      }
    }
  }
  for (const row of resolvedRows) {
    if (!categoryNodes.has(row.categoryKey)) {
      const categoryName = row.categoryName || row.name;
      categoryNodes.set(row.categoryKey, {
        id: row.categoryKey,
        name: mode === 'canonical' ? categoryName : (categoryName || 'Legacy category'),
        value: 0,
        colorValue: 0,
        custom: {
          key: row.categoryKey,
          categoryKey: row.categoryKey,
          name: categoryName,
          categoryName,
          subcategoryName: null,
          categoryId: row.categoryId,
          subcategoryId: null,
          source: row.source,
          created: 0,
          assigned: 0,
          open: 0,
          overdue: 0,
          reviewNeeded: 0,
          unmapped: 0,
          automationRuns: 0,
          automationFailures: 0,
          automationRebounds: 0,
          pressureScore: 0,
          nodeType: 'category',
        },
      });
    }
    const parent = categoryNodes.get(row.categoryKey);
    parent.value += row.created || 0;
    parent.colorValue = Math.max(parent.colorValue || 0, row.pressureScore || 0);
    const total = categoryTotals.get(row.categoryKey) || parent.custom;
    total.created += row.created || 0;
    total.assigned += row.assigned || 0;
    total.open += row.open || 0;
    total.overdue += row.overdue || 0;
    total.reviewNeeded += row.reviewNeeded || 0;
    total.unmapped += row.unmapped || 0;
    total.automationRuns += row.automationRuns || 0;
    total.automationFailures += row.automationFailures || 0;
    total.automationRebounds += row.automationRebounds || 0;
    total.pressureScore += row.pressureScore || 0;
    categoryTotals.set(row.categoryKey, total);

    if (row.isCategoryOnlyRow) {
      if (mode === 'canonical') {
        const categoryOnlyKey = `${row.categoryKey}:no-subcategory`;
        const categoryOnly = categoryOnlyByCategory.get(row.categoryKey) || {
          id: categoryOnlyKey,
          parent: row.categoryKey,
          name: 'No subcategory',
          value: 0,
          colorValue: 0,
          custom: {
            ...row,
            key: categoryOnlyKey,
            agentLeafKeys: [],
            name: 'No subcategory',
            subcategoryName: 'No subcategory',
            created: 0,
            assigned: 0,
            open: 0,
            overdue: 0,
            reviewNeeded: 0,
            unmapped: 0,
            automationRuns: 0,
            automationFailures: 0,
            automationRebounds: 0,
            pressureScore: 0,
            nodeType: 'categoryOnly',
          },
        };
        categoryOnly.value += row.created || 0;
        categoryOnly.colorValue = Math.max(categoryOnly.colorValue || 0, row.pressureScore || 0);
        categoryOnly.custom.created += row.created || 0;
        categoryOnly.custom.assigned += row.assigned || 0;
        categoryOnly.custom.open += row.open || 0;
        categoryOnly.custom.overdue += row.overdue || 0;
        categoryOnly.custom.reviewNeeded += row.reviewNeeded || 0;
        categoryOnly.custom.unmapped += row.unmapped || 0;
        categoryOnly.custom.automationRuns += row.automationRuns || 0;
        categoryOnly.custom.automationFailures += row.automationFailures || 0;
        categoryOnly.custom.automationRebounds += row.automationRebounds || 0;
        categoryOnly.custom.pressureScore += row.pressureScore || 0;
        if (!categoryOnly.custom.agentLeafKeys.includes(row.agentLeafKey)) {
          categoryOnly.custom.agentLeafKeys.push(row.agentLeafKey);
        }
        categoryOnlyByCategory.set(row.categoryKey, categoryOnly);
      }
      continue;
    }

    const shouldGroupSmallNode = smallNodeThreshold > 0
      && (smallChildCounts.get(row.categoryKey) || 0) >= 2
      && (row.created || 0) > 0
      && (row.created || 0) < smallNodeThreshold;
    if (shouldGroupSmallNode) {
      const groupedKey = `${row.categoryKey}:other-small`;
      const grouped = groupedSmallByCategory.get(row.categoryKey) || {
        id: groupedKey,
        parent: row.categoryKey,
        name: 'Other subcategories',
        value: 0,
        colorValue: 0,
        custom: {
          key: groupedKey,
          categoryKey: row.categoryKey,
          name: 'Other subcategories',
          categoryName: row.categoryName,
          subcategoryName: 'Other subcategories',
          categoryId: row.categoryId,
          subcategoryId: null,
          source: row.source,
          created: 0,
          assigned: 0,
          open: 0,
          overdue: 0,
          reviewNeeded: 0,
          unmapped: 0,
          automationRuns: 0,
          automationFailures: 0,
          automationRebounds: 0,
          pressureScore: 0,
          nodeType: 'subcategoryGroup',
          groupedCount: 0,
          groupedNames: [],
        },
      };
      grouped.value += row.created || 0;
      grouped.colorValue = Math.max(grouped.colorValue || 0, row.pressureScore || 0);
      grouped.custom.created += row.created || 0;
      grouped.custom.assigned += row.assigned || 0;
      grouped.custom.open += row.open || 0;
      grouped.custom.overdue += row.overdue || 0;
      grouped.custom.reviewNeeded += row.reviewNeeded || 0;
      grouped.custom.unmapped += row.unmapped || 0;
      grouped.custom.automationRuns += row.automationRuns || 0;
      grouped.custom.automationFailures += row.automationFailures || 0;
      grouped.custom.automationRebounds += row.automationRebounds || 0;
      grouped.custom.pressureScore += row.pressureScore || 0;
      grouped.custom.groupedCount += 1;
      if (grouped.custom.groupedNames.length < 8) grouped.custom.groupedNames.push(row.subcategoryName || row.name);
      groupedSmallByCategory.set(row.categoryKey, grouped);
      continue;
    }
    nodes.push({
      id: row.key,
      parent: row.categoryKey,
      name: row.subcategoryName || row.name,
      value: row.created,
      colorValue: row.pressureScore,
      custom: { ...row, nodeType: 'subcategory' },
    });
  }

  return [
    ...Array.from(categoryNodes.values()).map((node) => ({
      ...node,
      custom: categoryTotals.get(node.id) || node.custom,
    })),
    ...Array.from(groupedSmallByCategory.values()),
    ...Array.from(categoryOnlyByCategory.values()),
    ...nodes,
  ];
}

function buildCategoryAgentLens(createdTickets = [], workspaceId, totalCreated = 0) {
  const byAgent = new Map();

  const ensureAgent = (ticket) => {
    const techId = ticket.assignedTechId || ticket.assignedTech?.id || null;
    const key = techId ? `tech:${techId}` : 'unassigned';
    if (!byAgent.has(key)) {
      byAgent.set(key, {
        technicianId: techId,
        name: ticket.assignedTech?.name || 'Unassigned',
        photoUrl: ticket.assignedTech?.photoUrl || null,
        totalCreated: 0,
        categories: new Map(),
        topCategories: new Map(),
      });
    }
    return byAgent.get(key);
  };

  for (const ticket of createdTickets) {
    const identity = categoryIdentity(ticket, workspaceId);
    const agent = ensureAgent(ticket);
    agent.totalCreated += 1;

    const leaf = agent.categories.get(identity.leafKey) || {
      key: identity.leafKey,
      categoryKey: identity.categoryKey,
      name: identity.label,
      categoryName: identity.categoryName,
      subcategoryName: identity.subcategoryName,
      count: 0,
    };
    leaf.count += 1;
    agent.categories.set(identity.leafKey, leaf);

    const top = agent.topCategories.get(identity.categoryKey) || {
      key: identity.categoryKey,
      name: identity.categoryName,
      count: 0,
    };
    top.count += 1;
    agent.topCategories.set(identity.categoryKey, top);
  }

  return Array.from(byAgent.values())
    .map((agent) => ({
      ...agent,
      teamSharePct: totalCreated ? Number(((agent.totalCreated / totalCreated) * 100).toFixed(1)) : 0,
      categories: Array.from(agent.categories.values())
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      topCategories: Array.from(agent.topCategories.values())
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.totalCreated - a.totalCreated || a.name.localeCompare(b.name));
}

function buildCategoryAssignmentFlow(rows) {
  const byCategory = new Map();
  for (const row of rows) {
    const key = row.categoryKey || row.name;
    const current = byCategory.get(key) || {
      name: row.categoryName || row.name,
      assigned: 0,
      assignmentMix: { selfPicked: 0, coordinatorAssigned: 0, appAssigned: 0, unknown: 0 },
      automationRuns: 0,
      automationFailures: 0,
      automationRebounds: 0,
    };
    current.assigned += row.assigned || 0;
    for (const [source, count] of Object.entries(row.assignmentMix || {})) {
      current.assignmentMix[source] = (current.assignmentMix[source] || 0) + (count || 0);
    }
    current.automationRuns += row.automationRuns || 0;
    current.automationFailures += row.automationFailures || 0;
    current.automationRebounds += row.automationRebounds || 0;
    byCategory.set(key, current);
  }

  const flow = [];
  for (const row of Array.from(byCategory.values()).sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name))) {
    for (const [source, count] of Object.entries(row.assignmentMix)) {
      if (count > 0) flow.push({ from: labelFromAssignmentSource(source), to: row.name, weight: count });
    }

    let remaining = row.assigned || 0;
    const failed = Math.min(remaining, row.automationFailures || 0);
    if (failed > 0) {
      flow.push({ from: row.name, to: 'Automation failed', weight: failed });
      remaining -= failed;
    }

    const rebounded = Math.min(remaining, row.automationRebounds || 0);
    if (rebounded > 0) {
      flow.push({ from: row.name, to: 'Rebound', weight: rebounded });
      remaining -= rebounded;
    }

    const successful = Math.min(remaining, Math.max(0, (row.automationRuns || 0) - (row.automationFailures || 0)));
    if (successful > 0) {
      flow.push({ from: row.name, to: 'Automation succeeded', weight: successful });
      remaining -= successful;
    }

    if (remaining > 0) flow.push({ from: row.name, to: 'No linked automation run', weight: remaining });
  }
  return flow;
}

function addTrendCount(map, key, label, period, amount = 1) {
  const mapKey = `${key}:${period}`;
  const row = map.get(mapKey) || { key, name: label, period, count: 0 };
  row.count += amount;
  map.set(mapKey, row);
}

export function buildCategoryIntelligence({
  workspaceId,
  rangeInfo,
  categoryMode,
  createdTickets = [],
  assignedTickets = [],
  openTickets = [],
  previousCreatedTickets = [],
  pipelineRuns = [],
  serviceAccountNames = [],
}) {
  const rowsByKey = new Map();
  const previousByKey = new Map();
  const trendMap = new Map();
  const now = new Date();

  const ensureRow = (identity) => {
    if (!rowsByKey.has(identity.leafKey)) rowsByKey.set(identity.leafKey, emptyCategoryRow(identity, categoryMode));
    return rowsByKey.get(identity.leafKey);
  };

  for (const ticket of createdTickets) {
    const identity = categoryIdentity(ticket, workspaceId);
    const row = ensureRow(identity);
    row.created += 1;
    if (identity.reviewNeeded) row.reviewTicketIds.add(ticket.id);
    if (identity.source === 'unmapped') row.unmappedTicketIds.add(ticket.id);
    if (row.recentTickets.length < 20) row.recentTickets.push(compactTicket(ticket, workspaceId));
    addTrendCount(trendMap, identity.leafKey, identity.label, groupKey(ticket.createdAt, rangeInfo));
  }

  for (const ticket of previousCreatedTickets) {
    const identity = categoryIdentity(ticket, workspaceId);
    const row = previousByKey.get(identity.leafKey) || { key: identity.leafKey, name: identity.label, count: 0 };
    row.count += 1;
    previousByKey.set(identity.leafKey, row);
  }

  for (const ticket of assignedTickets) {
    const identity = categoryIdentity(ticket, workspaceId);
    const row = ensureRow(identity);
    row.assigned += 1;
    row[assignmentSource(ticket, serviceAccountNames)] += 1;
    if (Number.isFinite(ticket.resolutionTimeSeconds)) row.resolutionValues.push(ticket.resolutionTimeSeconds);
    if (ticket.csatScore !== null && ticket.csatScore !== undefined) {
      row.csatResponses += 1;
      row.csatTotal += ticket.csatScore || 0;
    }
    if (identity.reviewNeeded) row.reviewTicketIds.add(ticket.id);
  }

  for (const ticket of openTickets) {
    const identity = categoryIdentity(ticket, workspaceId);
    const row = ensureRow(identity);
    row.open += 1;
    if (ticket.dueBy && new Date(ticket.dueBy) < now) row.overdue += 1;
    if (identity.reviewNeeded) row.reviewTicketIds.add(ticket.id);
  }

  for (const run of pipelineRuns) {
    if (!run.ticket) continue;
    const identity = categoryIdentity(run.ticket, workspaceId);
    const row = ensureRow(identity);
    row.automationRuns += 1;
    if (run.status === 'failed' || run.errorMessage || run.syncStatus === 'failed') row.automationFailures += 1;
    if (run.reboundFrom || ['rebound', 'rebound_exhausted'].includes(run.triggerSource)) row.automationRebounds += 1;
  }

  const allRows = Array.from(rowsByKey.values())
    .sort((a, b) => b.created - a.created || b.open - a.open || String(a.name).localeCompare(String(b.name)));
  const totalCreated = createdTickets.length;
  const rows = allRows.map((row) => finalizeCategoryRow(row, totalCreated));
  const trend = Array.from(trendMap.values())
    .sort((a, b) => a.period.localeCompare(b.period) || String(a.name).localeCompare(String(b.name)));

  const assignmentFlow = buildCategoryAssignmentFlow(rows);

  const previousRows = Array.from(previousByKey.values())
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
    .slice(0, 16);

  return {
    summary: {
      categoryMode,
      totalCreated,
      totalAssigned: assignedTickets.length,
      open: openTickets.length,
      overdue: openTickets.filter((ticket) => ticket.dueBy && new Date(ticket.dueBy) < now).length,
      reviewNeeded: rows.reduce((sum, row) => sum + (row.reviewNeeded || 0), 0),
      unmapped: rows.reduce((sum, row) => sum + (row.unmapped || 0), 0),
      automationRuns: rows.reduce((sum, row) => sum + (row.automationRuns || 0), 0),
      automationFailures: rows.reduce((sum, row) => sum + (row.automationFailures || 0), 0),
    },
    rows,
    hierarchy: buildCategoryHierarchy(rows, categoryMode),
    agentLens: buildCategoryAgentLens(createdTickets, workspaceId, totalCreated),
    trend,
    pressure: rows.map((row) => ({
      key: row.key,
      name: row.name,
      x: row.created,
      y: row.p90ResolutionHours ?? row.medianResolutionHours ?? 0,
      z: Math.max(1, row.open || 0),
      open: row.open,
      overdue: row.overdue,
      reviewNeeded: row.reviewNeeded,
      automationFailureRatePct: row.automationFailureRatePct,
      resolutionSample: row.resolutionSample,
    })),
    assignmentFlow,
    previousRows,
  };
}

function labelFromAssignmentSource(source) {
  return {
    appAssigned: 'Ticket Pulse assigned',
    coordinatorAssigned: 'Coordinator assigned',
    selfPicked: 'Self-picked',
    unknown: 'Source unavailable',
  }[source] || 'Source unavailable';
}

function compactTicket(ticket, workspaceId) {
  if (!ticket) return null;
  const categoryParts = ticketPulseCategoryParts(ticket, workspaceId);
  return {
    id: ticket.id,
    freshserviceTicketId: ticket.freshserviceTicketId ? String(ticket.freshserviceTicketId) : null,
    subject: ticket.subject || '(no subject)',
    status: ticket.status,
    priority: ticket.priority,
    ticketCategory: ticket.ticketCategory || null,
    legacyCategory: categoryParts.legacyCategory,
    categoryId: categoryParts.categoryId,
    subcategoryId: categoryParts.subcategoryId,
    category: categoryParts.category,
    subcategory: categoryParts.subcategory,
    canonicalCategory: categoryParts.label,
    canonicalCategorySource: categoryParts.source,
    categoryLabel: categoryParts.label,
    categorySource: categoryParts.source,
    taxonomyReviewNeeded: categoryParts.reviewNeeded,
    skill: categoryParts.category,
    subskill: categoryParts.subcategory,
    canonicalSkill: categoryParts.label,
    createdAt: ticket.createdAt,
    firstAssignedAt: ticket.firstAssignedAt,
    dueBy: ticket.dueBy,
    frDueBy: ticket.frDueBy,
    assignedTechName: ticket.assignedTech?.name || null,
    requesterName: ticket.requester?.name || null,
    requesterEmail: ticket.requester?.email || null,
  };
}

function compactCsatTicket(ticket, workspaceId) {
  const compact = compactTicket(ticket, workspaceId);
  if (!compact) return null;
  return {
    ...compact,
    csatScore: ticket.csatScore,
    csatTotalScore: ticket.csatTotalScore,
    csatRatingText: ticket.csatRatingText || null,
    csatFeedback: ticket.csatFeedback || null,
    csatSubmittedAt: ticket.csatSubmittedAt,
  };
}

async function getServiceAccountNames() {
  const rows = await prisma.appSettings.findMany({
    where: {
      key: { in: ['service_account_names', 'SERVICE_ACCOUNT_NAMES'] },
    },
    select: { value: true },
  });
  return rows
    .flatMap((row) => {
      try {
        const parsed = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed : [row.value];
      } catch {
        return String(row.value || '').split(',');
      }
    })
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
}

function assignmentSource(ticket, serviceAccountNames = []) {
  const assignedBy = String(ticket.assignedBy || '').trim();
  if (ticket.isSelfPicked || (assignedBy && assignedBy === ticket.assignedTech?.name)) return 'selfPicked';
  if (assignedBy && serviceAccountNames.includes(assignedBy.toLowerCase())) return 'appAssigned';
  if (assignedBy) return 'coordinatorAssigned';
  return 'unknown';
}

async function fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryWhere = {}) {
  return prisma.ticket.findMany({
    where: assignmentRangeWhere(workspaceId, rangeInfo, excludeNoise, categoryWhere),
    select: CATEGORY_TICKET_SELECT,
  });
}

async function fetchCreatedTickets(workspaceId, rangeInfo, excludeNoise, categoryWhere = {}) {
  return prisma.ticket.findMany({
    where: ticketBaseWhere(workspaceId, rangeInfo, excludeNoise, 'createdAt', categoryWhere),
    select: CATEGORY_TICKET_SELECT,
  });
}

async function fetchOpenTickets(workspaceId, excludeNoise, categoryWhere = {}) {
  return prisma.ticket.findMany({
    where: withCategoryWhere({
      workspaceId,
      ...(excludeNoise ? { isNoise: false } : {}),
      status: { in: OPEN_STATUSES },
    }, categoryWhere),
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      status: true,
      priority: true,
      createdAt: true,
      firstAssignedAt: true,
      dueBy: true,
      frDueBy: true,
      ticketCategory: true,
      tpSkill: true,
      tpSubskill: true,
      internalCategoryId: true,
      internalCategory: { select: { id: true, name: true } },
      internalSubcategoryId: true,
      internalSubcategory: { select: { id: true, name: true, parentId: true } },
      internalCategoryFit: true,
      internalSubcategoryFit: true,
      taxonomyReviewNeeded: true,
      assignedTech: { select: { id: true, name: true, photoUrl: true } },
      requester: { select: { name: true, email: true } },
    },
  });
}

async function periodCounts(workspaceId, rangeInfo, excludeNoise, period = 'current', categoryWhere = {}) {
  const target = period === 'previous'
    ? { ...rangeInfo, start: rangeInfo.previousStart, end: rangeInfo.previousEnd }
    : rangeInfo;
  const [created, assignedTickets, csatTickets] = await Promise.all([
    prisma.ticket.count({ where: ticketBaseWhere(workspaceId, target, excludeNoise, 'createdAt', categoryWhere) }),
    prisma.ticket.findMany({
      where: assignmentRangeWhere(workspaceId, target, excludeNoise, categoryWhere),
      select: { status: true, resolutionTimeSeconds: true },
    }),
    prisma.ticket.findMany({
      where: withCategoryWhere({
        workspaceId,
        ...(excludeNoise ? { isNoise: false } : {}),
        csatScore: { not: null },
        csatSubmittedAt: { gte: target.start, lte: target.end },
      }, categoryWhere),
      select: { csatScore: true, csatTotalScore: true },
    }),
  ]);
  const resolved = assignedTickets.filter((t) => CLOSED_STATUSES.includes(t.status)).length;
  const resolutionSeconds = summarizeNumeric(assignedTickets.map((t) => t.resolutionTimeSeconds).filter((v) => v !== null));
  const csatAverage = csatTickets.length
    ? Number((csatTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / csatTickets.length).toFixed(2))
    : null;
  return { created, resolved, netChange: created - resolved, resolutionSeconds, csatCount: csatTickets.length, csatAverage };
}

export async function getOverview(workspaceId, query = {}) {
  return withCache(workspaceId, 'overview', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const [current, previous, rangeTickets, openTickets, serviceAccountNames] = await Promise.all([
      periodCounts(workspaceId, rangeInfo, excludeNoise, 'current', categoryFilter.where),
      rangeInfo.compare === 'none' ? Promise.resolve(null) : periodCounts(workspaceId, rangeInfo, excludeNoise, 'previous', categoryFilter.where),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
      fetchOpenTickets(workspaceId, excludeNoise, categoryFilter.where),
      getServiceAccountNames(),
    ]);
    const categoryCoverage = categoryBreakdownFromTickets(rangeTickets, 10, workspaceId).coverage;

    const now = new Date();
    const overdueTickets = openTickets.filter((t) => t.dueBy && new Date(t.dueBy) < now);
    const firstResponseRisk = openTickets.filter((t) => t.frDueBy && new Date(t.frDueBy) < now);
    const assignmentMix = { selfPicked: 0, coordinatorAssigned: 0, appAssigned: 0, unknown: 0 };
    for (const ticket of rangeTickets) {
      assignmentMix[assignmentSource(ticket, serviceAccountNames)] += 1;
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      cards: {
        created: rangeInfo.compare === 'none' ? { current: current.created } : calculateDelta(current.created, previous.created),
        resolved: rangeInfo.compare === 'none' ? { current: current.resolved } : calculateDelta(current.resolved, previous.resolved),
        netChange: rangeInfo.compare === 'none' ? { current: current.netChange } : calculateDelta(current.netChange, previous.netChange),
        openBacklog: { current: openTickets.length },
        overdue: { current: overdueTickets.length, sample: overdueTickets.slice(0, 10).map((ticket) => compactTicket(ticket, workspaceId)) },
        firstResponseRisk: { current: firstResponseRisk.length, sample: firstResponseRisk.slice(0, 10).map((ticket) => compactTicket(ticket, workspaceId)) },
        avgResolutionHours: {
          current: current.resolutionSeconds.avg === null ? null : Number((current.resolutionSeconds.avg / 3600).toFixed(1)),
          previous: previous?.resolutionSeconds?.avg === null || !previous ? null : Number((previous.resolutionSeconds.avg / 3600).toFixed(1)),
          sampleSize: current.resolutionSeconds.count,
        },
        csat: {
          average: current.csatAverage,
          responses: current.csatCount,
          previousAverage: previous?.csatAverage ?? null,
          previousResponses: previous?.csatCount ?? null,
        },
      },
      assignmentMix,
      dataQuality: {
        rangeTicketCount: rangeTickets.length,
        resolutionTimeCoverage: rangeTickets.length
          ? Number(((rangeTickets.filter((t) => t.resolutionTimeSeconds !== null).length / rangeTickets.length) * 100).toFixed(1))
          : 0,
        csatSampleCount: current.csatCount,
        firstResponsePopulated: 0,
        categoryMode: categoryFilter.mode,
        categoryCoverage,
        canonicalClassifiedCount: categoryCoverage.canonical,
        legacyFallbackCount: categoryCoverage.legacyFallback + categoryCoverage.legacy,
        categoryReviewNeededCount: categoryCoverage.reviewNeeded,
        unclassifiedCount: categoryCoverage.unmapped,
      },
    };
  });
}

export async function getDemandFlow(workspaceId, query = {}) {
  return withCache(workspaceId, 'demand-flow', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const [createdTickets, assignedTickets] = await Promise.all([
      prisma.ticket.findMany({
        where: ticketBaseWhere(workspaceId, rangeInfo, excludeNoise, 'createdAt', categoryFilter.where),
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          priority: true,
          source: true,
          createdAt: true,
          firstAssignedAt: true,
          ticketCategory: true,
          tpSkill: true,
          tpSubskill: true,
          internalCategoryId: true,
          internalCategory: { select: { id: true, name: true } },
          internalSubcategoryId: true,
          internalSubcategory: { select: { id: true, name: true, parentId: true } },
          internalCategoryFit: true,
          internalSubcategoryFit: true,
          taxonomyReviewNeeded: true,
          isNoise: true,
          requester: { select: { name: true, email: true } },
          assignedTech: { select: { name: true } },
        },
      }),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
    ]);

    const trendMap = new Map();
    const priorityMap = new Map();
    const sourceMap = new Map();
    const requesterMap = new Map();
    const heatmap = new Map();
    const noiseCount = createdTickets.filter((t) => t.isNoise).length;

    for (const ticket of createdTickets) {
      const key = groupKey(ticket.createdAt, rangeInfo);
      const row = trendMap.get(key) || { date: key, created: 0, resolved: 0, net: 0 };
      row.created += 1;
      row.net += 1;
      trendMap.set(key, row);
      increment(priorityMap, PRIORITY_LABELS[ticket.priority] || `P${ticket.priority || 'Unknown'}`);
      increment(sourceMap, SOURCE_LABELS[ticket.source] || `Source ${ticket.source || 'Unknown'}`);
      increment(requesterMap, ticket.requester?.name || ticket.requester?.email || 'Unknown requester');
      const dow = formatInTimeZone(ticket.createdAt, rangeInfo.timezone, 'EEE');
      const hour = formatInTimeZone(ticket.createdAt, rangeInfo.timezone, 'HH');
      increment(heatmap, `${dow}|${hour}`);
    }

    for (const ticket of assignedTickets) {
      if (!CLOSED_STATUSES.includes(ticket.status)) continue;
      const key = groupKey(assignedAt(ticket), rangeInfo);
      const row = trendMap.get(key) || { date: key, created: 0, resolved: 0, net: 0 };
      row.resolved += 1;
      row.net -= 1;
      trendMap.set(key, row);
    }
    const categoryBreakdown = categoryBreakdownFromTickets(createdTickets, 10, workspaceId);

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      trend: Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      heatmap: Array.from(heatmap.entries()).map(([key, count]) => {
        const [day, hour] = key.split('|');
        return { day, hour: Number(hour), count };
      }),
      breakdowns: {
        priority: topFromMap(priorityMap),
        source: topFromMap(sourceMap),
        category: categoryBreakdown.rows,
        categoryCoverage: categoryBreakdown.coverage,
        requester: topFromMap(requesterMap),
        noiseShare: {
          count: noiseCount,
          pct: createdTickets.length ? Number(((noiseCount / createdTickets.length) * 100).toFixed(1)) : 0,
        },
      },
      drilldown: createdTickets.slice(0, 100).map((ticket) => compactTicket(ticket, workspaceId)),
    };
  });
}

export async function getCategoryIntelligence(workspaceId, query = {}) {
  return withCache(workspaceId, 'category-intelligence', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const previousRange = {
      ...rangeInfo,
      start: rangeInfo.previousStart,
      end: rangeInfo.previousEnd,
      startDate: rangeInfo.previousStartDate,
      endDate: rangeInfo.previousEndDate,
    };
    const relationWhere = ticketRelationWhere(excludeNoise, categoryFilter.where);
    const pipelineTicketWhere = hasWhereClause(relationWhere) ? { ticket: { is: relationWhere } } : {};
    const [
      createdTickets,
      assignedTickets,
      openTickets,
      previousCreatedTickets,
      pipelineRuns,
      serviceAccountNames,
    ] = await Promise.all([
      fetchCreatedTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
      fetchOpenTickets(workspaceId, excludeNoise, categoryFilter.where),
      rangeInfo.compare === 'none'
        ? Promise.resolve([])
        : fetchCreatedTickets(workspaceId, previousRange, excludeNoise, categoryFilter.where),
      prisma.assignmentPipelineRun.findMany({
        where: {
          workspaceId,
          createdAt: { gte: rangeInfo.start, lte: rangeInfo.end },
          ...pipelineTicketWhere,
        },
        select: {
          status: true,
          decision: true,
          triggerSource: true,
          reboundFrom: true,
          errorMessage: true,
          syncStatus: true,
          ticket: { select: CATEGORY_TICKET_SELECT },
        },
      }),
      getServiceAccountNames(),
    ]);

    const categoryData = buildCategoryIntelligence({
      workspaceId,
      rangeInfo,
      categoryMode: categoryFilter.mode,
      createdTickets,
      assignedTickets,
      openTickets,
      previousCreatedTickets,
      pipelineRuns,
      serviceAccountNames,
    });

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      ...categoryData,
      notes: categoryFilter.mode === 'canonical'
        ? ['Canonical category/subcategory metrics use Ticket Pulse hierarchy fields and fall back only where historical tickets are not migrated.']
        : ['This workspace is still on legacy category filtering, so subcategory intelligence is intentionally hidden until migration.'],
    };
  });
}

export async function getTeamBalance(workspaceId, query = {}) {
  return withCache(workspaceId, 'team-balance', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const rangeBusinessDays = businessDays(rangeInfo.startDate, rangeInfo.endDate);
    const [technicians, tickets, episodes, openTickets, leaves, serviceAccountNames] = await Promise.all([
      prisma.technician.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, email: true, photoUrl: true, workStartTime: true, workEndTime: true },
        orderBy: { name: 'asc' },
      }),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
      prisma.ticketAssignmentEpisode.findMany({
        where: {
          workspaceId,
          ...(hasWhereClause(categoryFilter.where) ? { ticket: { is: categoryFilter.where } } : {}),
          OR: [
            { startedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
            { endedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
          ],
        },
        select: { technicianId: true, endMethod: true, startedAt: true, endedAt: true },
      }),
      fetchOpenTickets(workspaceId, excludeNoise, categoryFilter.where),
      prisma.technicianLeave.findMany({
        where: {
          workspaceId,
          status: 'APPROVED',
          leaveDate: { gte: dbDateRange(rangeInfo).start, lte: dbDateRange(rangeInfo).end },
        },
        select: {
          technicianId: true,
          leaveDate: true,
          leaveTypeName: true,
          category: true,
          isFullDay: true,
          halfDayPart: true,
        },
      }).catch(() => []),
      getServiceAccountNames(),
    ]);

    const byTech = new Map(technicians.map((t) => [t.id, {
      technicianId: t.id,
      name: t.name,
      email: t.email,
      photoUrl: t.photoUrl,
      assigned: 0,
      selfPicked: 0,
      coordinatorAssigned: 0,
      appAssigned: 0,
      unknown: 0,
      closed: 0,
      openNow: 0,
      rejected: 0,
      reassignedAway: 0,
      availableDays: rangeBusinessDays,
      assignedPerAvailableDay: 0,
      capacityLeaveDays: 0,
      leaveDays: 0,
      wfhDays: 0,
      leaveFullDays: 0,
      leaveHalfDays: 0,
      leaveTypes: {},
      avgResolutionHours: null,
      resolutionSample: 0,
      csatAverage: null,
      csatCount: 0,
      topCategories: {},
    }]));
    const periods = timelineKeys(rangeInfo);
    const timelineMap = new Map();
    const ensureTimelineRow = (technicianId, period) => {
      const tech = byTech.get(technicianId);
      if (!tech) return null;
      const key = `${technicianId}:${period}`;
      if (!timelineMap.has(key)) {
        timelineMap.set(key, {
          technicianId,
          name: tech.name,
          period,
          assigned: 0,
          closed: 0,
          selfPicked: 0,
          coordinatorAssigned: 0,
          appAssigned: 0,
          unknown: 0,
          rejected: 0,
          leaveDays: 0,
          wfhDays: 0,
        });
      }
      return timelineMap.get(key);
    };
    for (const tech of technicians) {
      for (const period of periods) ensureTimelineRow(tech.id, period);
    }
    const resolutionByTech = new Map();
    const csatByTech = new Map();
    let unassignedTickets = 0;
    let hiddenAssignedTickets = 0;

    for (const ticket of tickets) {
      if (!ticket.assignedTechId) {
        unassignedTickets += 1;
        continue;
      }
      if (!byTech.has(ticket.assignedTechId)) {
        hiddenAssignedTickets += 1;
        continue;
      }
      const row = byTech.get(ticket.assignedTechId);
      row.assigned += 1;
      const source = assignmentSource(ticket, serviceAccountNames);
      row[source] += 1;
      const period = groupKey(assignedAt(ticket), rangeInfo);
      const timelineRow = ensureTimelineRow(ticket.assignedTechId, period);
      if (timelineRow) {
        timelineRow.assigned += 1;
        timelineRow[source] += 1;
      }
      if (CLOSED_STATUSES.includes(ticket.status)) {
        row.closed += 1;
        if (timelineRow) timelineRow.closed += 1;
      }
      if (Number.isFinite(ticket.resolutionTimeSeconds)) {
        const values = resolutionByTech.get(ticket.assignedTechId) || [];
        values.push(ticket.resolutionTimeSeconds);
        resolutionByTech.set(ticket.assignedTechId, values);
      }
      if (ticket.csatScore !== null && ticket.csatScore !== undefined) {
        const values = csatByTech.get(ticket.assignedTechId) || [];
        values.push(ticket.csatScore);
        csatByTech.set(ticket.assignedTechId, values);
      }
      const category = canonicalSkillLabel(ticket, workspaceId);
      row.topCategories[category] = (row.topCategories[category] || 0) + 1;
    }
    for (const ticket of openTickets) {
      const id = ticket.assignedTech?.id;
      if (id && byTech.has(id)) byTech.get(id).openNow += 1;
    }
    for (const episode of episodes) {
      if (!byTech.has(episode.technicianId)) continue;
      if (episode.endMethod === 'rejected') {
        byTech.get(episode.technicianId).rejected += 1;
        const period = groupKey(episode.endedAt || episode.startedAt, rangeInfo);
        const timelineRow = ensureTimelineRow(episode.technicianId, period);
        if (timelineRow) timelineRow.rejected += 1;
      }
      if (episode.endMethod === 'reassigned') byTech.get(episode.technicianId).reassignedAway += 1;
    }
    for (const leave of leaves) {
      if (!byTech.has(leave.technicianId)) continue;
      const row = byTech.get(leave.technicianId);
      const leaveAmount = leave.isFullDay ? 1 : 0.5;
      const leaveDateKey = leave.leaveDate.toISOString().slice(0, 10);
      const label = leave.leaveTypeName || leave.category || 'Leave';
      const normalizedLabel = label.trim().toLowerCase();
      const normalizedCategory = String(leave.category || '').trim().toLowerCase();
      const isWfh = normalizedLabel === 'wfh' || normalizedLabel.includes('work from home') || normalizedCategory === 'wfh';

      if (isWfh) {
        row.wfhDays += leaveAmount;
        const period = groupKey(dateKeyToUtcNoon(leave.leaveDate.toISOString().slice(0, 10)), rangeInfo);
        const timelineRow = ensureTimelineRow(leave.technicianId, period);
        if (timelineRow) timelineRow.wfhDays += leaveAmount;
      } else {
        row.leaveDays += leaveAmount;
        if (isBusinessDateKey(leaveDateKey)) row.capacityLeaveDays += leaveAmount;
        if (leave.isFullDay) row.leaveFullDays += 1;
        else row.leaveHalfDays += 1;
        row.leaveTypes[label] = (row.leaveTypes[label] || 0) + leaveAmount;
        const period = groupKey(dateKeyToUtcNoon(leaveDateKey), rangeInfo);
        const timelineRow = ensureTimelineRow(leave.technicianId, period);
        if (timelineRow) timelineRow.leaveDays += leaveAmount;
      }
    }
    for (const [techId, values] of resolutionByTech.entries()) {
      const row = byTech.get(techId);
      const summary = summarizeNumeric(values);
      row.resolutionSample = summary.count;
      row.avgResolutionHours = summary.avg === null ? null : Number((summary.avg / 3600).toFixed(1));
    }
    for (const [techId, values] of csatByTech.entries()) {
      const row = byTech.get(techId);
      row.csatCount = values.length;
      row.csatAverage = values.length
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : null;
    }
    for (const row of byTech.values()) {
      row.availableDays = Number(Math.max(0, rangeBusinessDays - row.capacityLeaveDays).toFixed(1));
      row.assignedPerAvailableDay = row.availableDays > 0
        ? Number((row.assigned / row.availableDays).toFixed(1))
        : null;
      row.closeRatePct = row.assigned ? Number(((row.closed / row.assigned) * 100).toFixed(1)) : 0;
      row.selfPickRatePct = row.assigned ? Number(((row.selfPicked / row.assigned) * 100).toFixed(1)) : 0;
      row.rejectionRatePct = row.assigned ? Number(((row.rejected / row.assigned) * 100).toFixed(1)) : 0;
      row.topCategories = Object.entries(row.topCategories)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      row.leaveTypes = Object.entries(row.leaveTypes)
        .map(([name, days]) => ({ name, days }))
        .sort((a, b) => b.days - a.days);
    }

    const rows = Array.from(byTech.values());
    const assignedCounts = rows.map((r) => r.assigned);
    const representedAssigned = rows.reduce((sum, row) => sum + row.assigned, 0);
    const avg = assignedCounts.length ? assignedCounts.reduce((a, b) => a + b, 0) / assignedCounts.length : 0;
    const variance = assignedCounts.length
      ? assignedCounts.reduce((sum, n) => sum + ((n - avg) ** 2), 0) / assignedCounts.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const rawBalanceScore = avg > 0 ? Math.max(0, Math.round(100 - ((stdDev / avg) * 100))) : 100;
    const rateValues = rows
      .map((row) => row.assignedPerAvailableDay)
      .filter((value) => Number.isFinite(value));
    const rateAvg = rateValues.length ? rateValues.reduce((a, b) => a + b, 0) / rateValues.length : 0;
    const rateVariance = rateValues.length
      ? rateValues.reduce((sum, n) => sum + ((n - rateAvg) ** 2), 0) / rateValues.length
      : 0;
    const rateStdDev = Math.sqrt(rateVariance);
    const balanceScore = rateAvg > 0 ? Math.max(0, Math.round(100 - ((rateStdDev / rateAvg) * 100))) : 100;
    const activeCapacityDays = rows.reduce((sum, row) => sum + (row.availableDays || 0), 0);

    const now = new Date();
    const ageBuckets = { under4h: 0, h4to8: 0, h8to24: 0, over24h: 0 };
    for (const ticket of openTickets) {
      const ageHours = (now - new Date(ticket.createdAt)) / 36e5;
      if (ageHours < 4) ageBuckets.under4h += 1;
      else if (ageHours < 8) ageBuckets.h4to8 += 1;
      else if (ageHours < 24) ageBuckets.h8to24 += 1;
      else ageBuckets.over24h += 1;
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      summary: {
        activeTechnicians: technicians.length,
        rangeBusinessDays,
        totalAssigned: representedAssigned,
        rangeTickets: tickets.length,
        unassignedTickets,
        hiddenAssignedTickets,
        excludedFromDistribution: unassignedTickets + hiddenAssignedTickets,
        avgAssignedPerTech: Number(avg.toFixed(1)),
        avgAssignedPerAvailableDay: activeCapacityDays > 0
          ? Number((representedAssigned / activeCapacityDays).toFixed(1))
          : 0,
        stdDev: Number(stdDev.toFixed(1)),
        rawBalanceScore,
        balanceScore,
        spread: assignedCounts.length ? Math.max(...assignedCounts) - Math.min(...assignedCounts) : 0,
        availableDayRateSpread: rateValues.length ? Number((Math.max(...rateValues) - Math.min(...rateValues)).toFixed(1)) : 0,
        openAgeBuckets: ageBuckets,
      },
      technicians: rows.sort((a, b) => a.name.localeCompare(b.name)),
      timeline: Array.from(timelineMap.values()).sort((a, b) => a.period.localeCompare(b.period) || a.name.localeCompare(b.name)),
      notes: [
        'Team Balance is sorted alphabetically and avoids ranked winner/loser framing by design.',
        'Balance Score uses assignments per available weekday, subtracting OFF/OTHER leave days from either Vacation Tracker or shared mailbox sync.',
      ],
    };
  });
}

export async function getQuality(workspaceId, query = {}) {
  return withCache(workspaceId, 'quality', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const [tickets, csatTickets, openTickets] = await Promise.all([
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise, categoryFilter.where),
      prisma.ticket.findMany({
        where: withCategoryWhere({
          workspaceId,
          ...(excludeNoise ? { isNoise: false } : {}),
          csatScore: { not: null },
          csatSubmittedAt: { gte: rangeInfo.start, lte: rangeInfo.end },
        }, categoryFilter.where),
        orderBy: { csatSubmittedAt: 'desc' },
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          priority: true,
          ticketCategory: true,
          tpSkill: true,
          tpSubskill: true,
          internalCategoryId: true,
          internalCategory: { select: { id: true, name: true } },
          internalSubcategoryId: true,
          internalSubcategory: { select: { id: true, name: true, parentId: true } },
          internalCategoryFit: true,
          internalSubcategoryFit: true,
          taxonomyReviewNeeded: true,
          csatScore: true,
          csatTotalScore: true,
          csatRatingText: true,
          csatFeedback: true,
          csatSubmittedAt: true,
          requester: { select: { name: true, email: true } },
          assignedTech: { select: { name: true } },
        },
      }),
      fetchOpenTickets(workspaceId, excludeNoise, categoryFilter.where),
    ]);

    const resolution = summarizeNumeric(tickets.map((t) => t.resolutionTimeSeconds).filter((v) => v !== null));
    const resolutionBuckets = { under4h: 0, h4to8: 0, h8to24: 0, d1to3: 0, over3d: 0 };
    for (const ticket of tickets) {
      if (!Number.isFinite(ticket.resolutionTimeSeconds)) continue;
      const hours = ticket.resolutionTimeSeconds / 3600;
      if (hours < 4) resolutionBuckets.under4h += 1;
      else if (hours < 8) resolutionBuckets.h4to8 += 1;
      else if (hours < 24) resolutionBuckets.h8to24 += 1;
      else if (hours < 72) resolutionBuckets.d1to3 += 1;
      else resolutionBuckets.over3d += 1;
    }

    const csatTrendMap = new Map();
    for (const ticket of csatTickets) {
      const key = groupKey(ticket.csatSubmittedAt, rangeInfo);
      const row = csatTrendMap.get(key) || { date: key, responses: 0, total: 0, average: null };
      row.responses += 1;
      row.total += ticket.csatScore || 0;
      row.average = Number((row.total / row.responses).toFixed(2));
      csatTrendMap.set(key, row);
    }
    const lowCsat = csatTickets.filter((t) => t.csatScore !== null && t.csatScore <= 2);
    const now = new Date();
    const agingBuckets = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 };
    for (const ticket of openTickets) {
      const days = (now - new Date(ticket.createdAt)) / 864e5;
      if (days < 1) agingBuckets.under1d += 1;
      else if (days < 3) agingBuckets.d1to3 += 1;
      else if (days < 7) agingBuckets.d3to7 += 1;
      else agingBuckets.over7d += 1;
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      resolution: {
        seconds: resolution,
        hours: {
          avg: resolution.avg === null ? null : Number((resolution.avg / 3600).toFixed(1)),
          median: resolution.median === null ? null : Number((resolution.median / 3600).toFixed(1)),
          p90: resolution.p90 === null ? null : Number((resolution.p90 / 3600).toFixed(1)),
        },
        buckets: resolutionBuckets,
      },
      openAging: agingBuckets,
      csat: {
        responses: csatTickets.length,
        average: csatTickets.length
          ? Number((csatTickets.reduce((sum, t) => sum + (t.csatScore || 0), 0) / csatTickets.length).toFixed(2))
          : null,
        trend: Array.from(csatTrendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        lowScoreCount: lowCsat.length,
        lowScoreTickets: lowCsat.slice(0, 25).map((ticket) => compactCsatTicket(ticket, workspaceId)),
        recentResponses: csatTickets.slice(0, 25).map((ticket) => compactCsatTicket(ticket, workspaceId)),
      },
    };
  });
}

export async function getAutomationOps(workspaceId, query = {}) {
  return withCache(workspaceId, 'automation-ops', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const relationWhere = ticketRelationWhere(excludeNoise, categoryFilter.where);
    const pipelineTicketWhere = hasWhereClause(relationWhere)
      ? { ticket: { is: relationWhere } }
      : {};
    const pipelineRunWhere = {
      workspaceId,
      createdAt: { gte: rangeInfo.start, lte: rangeInfo.end },
      ...pipelineTicketWhere,
    };
    const [runs, steps, syncLogs, backfillRuns, dailyReviewRuns, recommendationCounts] = await Promise.all([
      prisma.assignmentPipelineRun.findMany({
        where: pipelineRunWhere,
        select: {
          id: true,
          status: true,
          decision: true,
          triggerSource: true,
          totalDurationMs: true,
          errorMessage: true,
          createdAt: true,
          decidedAt: true,
          syncStatus: true,
          reboundFrom: true,
        },
      }),
      prisma.assignmentPipelineStep.findMany({
        where: { pipelineRun: pipelineRunWhere },
        select: { stepName: true, status: true, durationMs: true, errorMessage: true },
      }),
      prisma.syncLog.findMany({
        where: { workspaceId, startedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
        select: { syncType: true, status: true, recordsProcessed: true, startedAt: true, completedAt: true, errorMessage: true },
        orderBy: { startedAt: 'desc' },
        take: 500,
      }),
      prisma.backfillRun.findMany({
        where: { workspaceId, startedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
        orderBy: { startedAt: 'desc' },
        take: 20,
      }),
      prisma.assignmentDailyReviewRun.findMany({
        where: { workspaceId, createdAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
        select: { id: true, reviewDate: true, status: true, totalDurationMs: true, totalTokensUsed: true, createdAt: true, completedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      prisma.assignmentDailyReviewRecommendation.groupBy({
        by: ['kind', 'status', 'severity'],
        where: { workspaceId, createdAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
        _count: { _all: true },
      }),
    ]);

    const funnel = {};
    const triggerSources = {};
    const pipelineTrend = new Map();
    let rebounds = 0;
    for (const run of runs) {
      const key = run.decision || run.status || 'unknown';
      funnel[key] = (funnel[key] || 0) + 1;
      triggerSources[run.triggerSource || 'unknown'] = (triggerSources[run.triggerSource || 'unknown'] || 0) + 1;
      const isRebound = Boolean(run.reboundFrom || ['rebound', 'rebound_exhausted'].includes(run.triggerSource));
      if (isRebound) rebounds += 1;
      const period = groupKey(run.createdAt, rangeInfo);
      const trendRow = pipelineTrend.get(period) || { period, runs: 0, errors: 0, rebounds: 0, durationValues: [] };
      trendRow.runs += 1;
      if (run.errorMessage || run.status === 'failed') trendRow.errors += 1;
      if (isRebound) trendRow.rebounds += 1;
      if (Number.isFinite(run.totalDurationMs)) trendRow.durationValues.push(run.totalDurationMs);
      pipelineTrend.set(period, trendRow);
    }

    const stepMap = new Map();
    for (const step of steps) {
      const row = stepMap.get(step.stepName) || { stepName: step.stepName, completed: 0, failed: 0, skipped: 0, durations: [] };
      row[step.status] = (row[step.status] || 0) + 1;
      if (Number.isFinite(step.durationMs)) row.durations.push(step.durationMs);
      stepMap.set(step.stepName, row);
    }

    const syncCounts = {};
    const syncTrend = new Map();
    let staleStarted = 0;
    const now = new Date();
    for (const log of syncLogs) {
      const key = `${log.syncType || 'unknown'}:${log.status || 'unknown'}`;
      syncCounts[key] = (syncCounts[key] || 0) + 1;
      if (log.status === 'started' && now - new Date(log.startedAt) > 30 * 60 * 1000) staleStarted += 1;
      const period = groupKey(log.startedAt, rangeInfo);
      const trendRow = syncTrend.get(period) || { period, total: 0, completed: 0, failed: 0, started: 0, recordsProcessed: 0 };
      trendRow.total += 1;
      if (log.status === 'completed') trendRow.completed += 1;
      else if (log.status === 'failed') trendRow.failed += 1;
      else if (log.status === 'started') trendRow.started += 1;
      trendRow.recordsProcessed += Number(log.recordsProcessed || 0);
      syncTrend.set(period, trendRow);
    }
    const failedSyncs = syncLogs.filter((l) => l.status === 'failed').length;

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      pipeline: {
        totalRuns: runs.length,
        funnel,
        triggerSources,
        rebounds,
        trend: Array.from(pipelineTrend.values()).map((row) => {
          const durations = summarizeNumeric(row.durationValues);
          return {
            period: row.period,
            runs: row.runs,
            errors: row.errors,
            rebounds: row.rebounds,
            avgDurationMs: durations.avg,
          };
        }).sort((a, b) => a.period.localeCompare(b.period)),
        durationMs: summarizeNumeric(runs.map((r) => r.totalDurationMs).filter((v) => v !== null)),
        errorRuns: runs.filter((r) => r.errorMessage).slice(0, 20),
      },
      steps: Array.from(stepMap.values()).map((row) => {
        const durations = summarizeNumeric(row.durations);
        return { ...row, durations: undefined, avgDurationMs: durations.avg, p90DurationMs: durations.p90 };
      }).sort((a, b) => (b.failed || 0) - (a.failed || 0) || a.stepName.localeCompare(b.stepName)),
      sync: {
        total: syncLogs.length,
        failed: failedSyncs,
        failureRatePct: syncLogs.length ? Number(((failedSyncs / syncLogs.length) * 100).toFixed(1)) : 0,
        staleStarted,
        counts: syncCounts,
        trend: Array.from(syncTrend.values()).sort((a, b) => a.period.localeCompare(b.period)),
        recentFailures: syncLogs.filter((l) => l.status === 'failed').slice(0, 20),
      },
      backfills: backfillRuns.map((run) => ({
        id: run.id,
        status: run.status,
        startDate: run.startDate,
        endDate: run.endDate,
        progressPct: run.progressPct,
        ticketsProcessed: run.ticketsProcessed,
        ticketsTotal: run.ticketsTotal,
        elapsedMs: run.elapsedMs,
        errorMessage: run.errorMessage,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      })),
      dailyReviews: {
        runs: dailyReviewRuns,
        recommendations: recommendationCounts.map((row) => ({
          kind: row.kind,
          status: row.status,
          severity: row.severity,
          count: row._count._all,
        })),
      },
    };
  });
}

export async function getInsights(workspaceId, query = {}) {
  return withCache(workspaceId, 'insights', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const categoryFilter = categoryFilterForQuery(workspaceId, query);
    const [overview, demand, team, quality, ops, categories] = await Promise.all([
      getOverview(workspaceId, query),
      getDemandFlow(workspaceId, query),
      getTeamBalance(workspaceId, query),
      getQuality(workspaceId, query),
      getAutomationOps(workspaceId, query),
      getCategoryIntelligence(workspaceId, query),
    ]);

    const insights = [];
    if (overview.cards.created.pct !== null && overview.cards.created.pct >= 25 && overview.cards.created.current >= 10) {
      insights.push(buildInsight({
        id: 'demand-spike',
        title: 'Ticket demand is elevated',
        severity: overview.cards.created.pct >= 50 ? 'warning' : 'info',
        rule: 'Current created-ticket count is at least 25% above the previous comparable period and has at least 10 tickets.',
        evidenceCount: overview.cards.created.current,
        affected: [`${overview.cards.created.pct}% vs previous period`],
        drilldown: demand.drilldown.slice(0, 10),
      }));
    }
    if (overview.cards.netChange.current > 0) {
      insights.push(buildInsight({
        id: 'backlog-growth',
        title: 'Backlog grew during this period',
        severity: overview.cards.netChange.current >= 10 ? 'warning' : 'info',
        rule: 'Created tickets minus closed/resolved tickets assigned in the range is positive.',
        evidenceCount: overview.cards.netChange.current,
        affected: [`Open backlog now: ${overview.cards.openBacklog.current}`],
        drilldown: demand.trend.filter((row) => row.net > 0).slice(0, 10),
      }));
    }
    if (overview.cards.overdue.current > 0) {
      insights.push(buildInsight({
        id: 'overdue-risk',
        title: 'Open tickets are past due',
        severity: overview.cards.overdue.current >= 5 ? 'critical' : 'warning',
        rule: 'Open/Pending tickets with dueBy earlier than now.',
        evidenceCount: overview.cards.overdue.current,
        affected: ['Current open queue'],
        drilldown: overview.cards.overdue.sample,
      }));
    }
    if (team.summary.balanceScore < 70 && team.summary.totalAssigned >= team.summary.activeTechnicians) {
      insights.push(buildInsight({
        id: 'load-imbalance',
        title: 'Assignments are unevenly distributed',
        severity: team.summary.balanceScore < 50 ? 'warning' : 'info',
        rule: 'Team balance score is below 70 after comparing assignments per available weekday across active technicians.',
        evidenceCount: team.summary.totalAssigned,
        affected: [`Balance score: ${team.summary.balanceScore}`, `Rate spread: ${team.summary.availableDayRateSpread}`],
        drilldown: team.technicians,
      }));
    }
    if (quality.openAging.over7d > 0) {
      insights.push(buildInsight({
        id: 'stale-open-tickets',
        title: 'Some open tickets are older than 7 days',
        severity: quality.openAging.over7d >= 5 ? 'warning' : 'info',
        rule: 'Open/Pending ticket age exceeds seven days.',
        evidenceCount: quality.openAging.over7d,
        affected: ['Open queue aging bucket'],
        drilldown: quality.openAging,
      }));
    }
    if (ops.sync.failureRatePct >= 5 && ops.sync.total >= 10) {
      insights.push(buildInsight({
        id: 'sync-degradation',
        title: 'Sync reliability needs attention',
        severity: ops.sync.failureRatePct >= 15 ? 'critical' : 'warning',
        rule: 'Sync failure rate is at least 5% over a range with at least 10 sync log entries.',
        evidenceCount: ops.sync.failed,
        affected: [`Failure rate: ${ops.sync.failureRatePct}%`],
        drilldown: ops.sync.recentFailures,
      }));
    }
    if (overview.dataQuality.resolutionTimeCoverage < 80 && overview.dataQuality.rangeTicketCount >= 10) {
      insights.push(buildInsight({
        id: 'weak-resolution-coverage',
        title: 'Resolution-time coverage is weak',
        severity: 'info',
        rule: 'Less than 80% of range tickets have resolutionTimeSeconds populated.',
        evidenceCount: overview.dataQuality.rangeTicketCount,
        affected: [`Coverage: ${overview.dataQuality.resolutionTimeCoverage}%`],
        drilldown: [],
      }));
    }
    if (quality.csat.responses > 0 && quality.csat.average !== null && quality.csat.average < 3) {
      insights.push(buildInsight({
        id: 'csat-warning',
        title: 'CSAT average is below target',
        severity: 'warning',
        rule: 'Average CSAT score in the selected range is below 3.0.',
        evidenceCount: quality.csat.responses,
        affected: [`Average: ${quality.csat.average}`],
        drilldown: quality.csat.lowScoreTickets,
      }));
    }
    if (demand.breakdowns.category[0]?.count >= 10 && demand.breakdowns.category[0].count >= (overview.cards.created.current * 0.35)) {
      insights.push(buildInsight({
        id: 'category-concentration',
        title: 'Demand is concentrated in one category',
        severity: 'info',
        rule: 'Top Ticket Pulse category/subcategory path has at least 10 tickets and at least 35% of created demand; legacy category is used only where canonical values are missing.',
        evidenceCount: demand.breakdowns.category[0].count,
        affected: [demand.breakdowns.category[0].name],
        drilldown: demand.breakdowns.category,
      }));
    }
    const fastRiser = categories.rows
      .map((row) => {
        const previous = categories.previousRows.find((item) => item.key === row.key)?.count || 0;
        return {
          ...row,
          previous,
          change: row.created - previous,
          pct: previous === 0 ? null : Number((((row.created - previous) / previous) * 100).toFixed(1)),
        };
      })
      .filter((row) => row.created >= 5 && (row.change >= 5 || row.pct >= 50))
      .sort((a, b) => b.change - a.change)[0];
    if (fastRiser) {
      insights.push(buildInsight({
        id: 'category-rising',
        title: 'A category is rising quickly',
        severity: fastRiser.change >= 10 ? 'warning' : 'info',
        rule: 'Category created-ticket volume increased materially versus the previous comparable period.',
        evidenceCount: fastRiser.created,
        affected: [fastRiser.name, `Change: +${fastRiser.change}`],
        drilldown: fastRiser.recentTickets || [],
      }));
    }
    const slowCategory = categories.rows
      .filter((row) => row.resolutionSample >= 5 && row.p90ResolutionHours !== null)
      .sort((a, b) => b.p90ResolutionHours - a.p90ResolutionHours)[0];
    if (slowCategory && slowCategory.p90ResolutionHours >= 72) {
      insights.push(buildInsight({
        id: 'category-slow-resolution',
        title: 'A category has slow resolution outcomes',
        severity: slowCategory.p90ResolutionHours >= 120 ? 'warning' : 'info',
        rule: 'Category p90 resolution is at least 72 hours with at least five resolved samples.',
        evidenceCount: slowCategory.resolutionSample,
        affected: [slowCategory.name, `P90: ${slowCategory.p90ResolutionHours}h`],
        drilldown: categories.rows,
      }));
    }
    const reviewSpike = categories.rows.find((row) => row.reviewNeeded >= 5);
    if (reviewSpike) {
      insights.push(buildInsight({
        id: 'category-review-needed',
        title: 'Category classification needs review',
        severity: reviewSpike.reviewNeeded >= 10 ? 'warning' : 'info',
        rule: 'One category/subcategory has at least five tickets flagged for taxonomy review.',
        evidenceCount: reviewSpike.reviewNeeded,
        affected: [reviewSpike.name],
        drilldown: categories.rows,
      }));
    }
    if (categories.summary.unmapped >= 5) {
      insights.push(buildInsight({
        id: 'category-unmapped-drift',
        title: 'Some tickets are not classified',
        severity: categories.summary.unmapped >= 15 ? 'warning' : 'info',
        rule: 'The selected range includes at least five tickets with no usable category value.',
        evidenceCount: categories.summary.unmapped,
        affected: ['Category data quality'],
        drilldown: categories.rows.filter((row) => row.unmapped > 0),
      }));
    }
    const automationMismatch = categories.rows.find((row) => row.automationRuns >= 5 && row.automationFailureRatePct >= 20);
    if (automationMismatch) {
      insights.push(buildInsight({
        id: 'category-automation-mismatch',
        title: 'Automation is struggling in one category',
        severity: automationMismatch.automationFailureRatePct >= 40 ? 'warning' : 'info',
        rule: 'A category has at least five assignment pipeline runs and a failure rate of at least 20%.',
        evidenceCount: automationMismatch.automationFailures,
        affected: [automationMismatch.name, `${automationMismatch.automationFailureRatePct}% failure rate`],
        drilldown: categories.rows,
      }));
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise, categoryMode: categoryFilter.mode, categoryFilters: categoryFilter.selected }),
      insights,
      emptyState: insights.length === 0
        ? 'No deterministic insight rules crossed their thresholds for this range.'
        : null,
    };
  });
}

export async function getCategoryMetadata(workspaceId) {
  return withCache(workspaceId, 'categories', {}, async () => {
    const categoryMode = getCategoryMode(workspaceId);
    if (categoryMode === 'canonical') {
      const categories = await competencyRepository.getActiveCategories(workspaceId);
      return {
        categoryMode,
        categories,
        categoryTree: competencyRepository.buildCategoryTree(categories),
        legacyCategories: [],
      };
    }

    const rows = await prisma.ticket.findMany({
      where: {
        workspaceId,
        ticketCategory: { not: null },
      },
      distinct: ['ticketCategory'],
      select: { ticketCategory: true },
      orderBy: { ticketCategory: 'asc' },
    });

    return {
      categoryMode,
      categories: [],
      categoryTree: [],
      legacyCategories: rows.map((row) => row.ticketCategory).filter(Boolean),
    };
  });
}

export default {
  parseAnalyticsRange,
  calculateDelta,
  summarizeNumeric,
  buildInsight,
  categoryFilterForQuery,
  categoryBreakdownFromTickets,
  getOverview,
  getDemandFlow,
  getTeamBalance,
  getQuality,
  getAutomationOps,
  getCategoryIntelligence,
  getInsights,
  getCategoryMetadata,
};
