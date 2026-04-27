import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import { getTodayRange } from '../utils/timezone.js';

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

function dateKeyToUtcNoon(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`);
}

function inclusiveCalendarDays(startDateKey, endDateKey) {
  const startNoon = dateKeyToUtcNoon(startDateKey);
  const endNoon = dateKeyToUtcNoon(endDateKey);
  return Math.max(1, Math.round((endNoon - startNoon) / 864e5) + 1);
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
  const value = await producer();
  cache.set(key, { createdAt: Date.now(), value });
  return value;
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
      'Category analytics use ticketCategory; category, subCategory, department, and internalCategoryId are sparse.',
      'CSAT cards show sample size because survey coverage is low.',
    ],
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

function ticketBaseWhere(workspaceId, rangeInfo, excludeNoise, dateField = 'createdAt') {
  return {
    workspaceId,
    ...(excludeNoise ? { isNoise: false } : {}),
    [dateField]: { gte: rangeInfo.start, lte: rangeInfo.end },
  };
}

function assignmentRangeWhere(workspaceId, rangeInfo, excludeNoise = false) {
  return {
    workspaceId,
    ...(excludeNoise ? { isNoise: false } : {}),
    OR: [
      { firstAssignedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
      {
        firstAssignedAt: null,
        createdAt: { gte: rangeInfo.start, lte: rangeInfo.end },
      },
    ],
  };
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

function compactTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    freshserviceTicketId: ticket.freshserviceTicketId ? String(ticket.freshserviceTicketId) : null,
    subject: ticket.subject || '(no subject)',
    status: ticket.status,
    priority: ticket.priority,
    ticketCategory: ticket.ticketCategory || null,
    createdAt: ticket.createdAt,
    firstAssignedAt: ticket.firstAssignedAt,
    dueBy: ticket.dueBy,
    frDueBy: ticket.frDueBy,
    assignedTechName: ticket.assignedTech?.name || null,
    requesterName: ticket.requester?.name || null,
    requesterEmail: ticket.requester?.email || null,
  };
}

function compactCsatTicket(ticket) {
  const compact = compactTicket(ticket);
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

async function fetchRangeTickets(workspaceId, rangeInfo, excludeNoise) {
  return prisma.ticket.findMany({
    where: assignmentRangeWhere(workspaceId, rangeInfo, excludeNoise),
    select: {
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
      resolutionTimeSeconds: true,
      csatScore: true,
      csatTotalScore: true,
      csatSubmittedAt: true,
      isNoise: true,
      rejectionCount: true,
      requester: { select: { name: true, email: true } },
      assignedTech: { select: { id: true, name: true, photoUrl: true } },
    },
  });
}

async function fetchOpenTickets(workspaceId, excludeNoise) {
  return prisma.ticket.findMany({
    where: {
      workspaceId,
      ...(excludeNoise ? { isNoise: false } : {}),
      status: { in: OPEN_STATUSES },
    },
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
      assignedTech: { select: { id: true, name: true, photoUrl: true } },
      requester: { select: { name: true, email: true } },
    },
  });
}

async function periodCounts(workspaceId, rangeInfo, excludeNoise, period = 'current') {
  const target = period === 'previous'
    ? { ...rangeInfo, start: rangeInfo.previousStart, end: rangeInfo.previousEnd }
    : rangeInfo;
  const [created, assignedTickets, csatTickets] = await Promise.all([
    prisma.ticket.count({ where: ticketBaseWhere(workspaceId, target, excludeNoise, 'createdAt') }),
    prisma.ticket.findMany({
      where: assignmentRangeWhere(workspaceId, target, excludeNoise),
      select: { status: true, resolutionTimeSeconds: true },
    }),
    prisma.ticket.findMany({
      where: {
        workspaceId,
        ...(excludeNoise ? { isNoise: false } : {}),
        csatScore: { not: null },
        csatSubmittedAt: { gte: target.start, lte: target.end },
      },
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
    const [current, previous, rangeTickets, openTickets, serviceAccountNames] = await Promise.all([
      periodCounts(workspaceId, rangeInfo, excludeNoise, 'current'),
      rangeInfo.compare === 'none' ? Promise.resolve(null) : periodCounts(workspaceId, rangeInfo, excludeNoise, 'previous'),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise),
      fetchOpenTickets(workspaceId, excludeNoise),
      getServiceAccountNames(),
    ]);

    const now = new Date();
    const overdueTickets = openTickets.filter((t) => t.dueBy && new Date(t.dueBy) < now);
    const firstResponseRisk = openTickets.filter((t) => t.frDueBy && new Date(t.frDueBy) < now);
    const assignmentMix = { selfPicked: 0, coordinatorAssigned: 0, appAssigned: 0, unknown: 0 };
    for (const ticket of rangeTickets) {
      assignmentMix[assignmentSource(ticket, serviceAccountNames)] += 1;
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise }),
      cards: {
        created: rangeInfo.compare === 'none' ? { current: current.created } : calculateDelta(current.created, previous.created),
        resolved: rangeInfo.compare === 'none' ? { current: current.resolved } : calculateDelta(current.resolved, previous.resolved),
        netChange: rangeInfo.compare === 'none' ? { current: current.netChange } : calculateDelta(current.netChange, previous.netChange),
        openBacklog: { current: openTickets.length },
        overdue: { current: overdueTickets.length, sample: overdueTickets.slice(0, 10).map(compactTicket) },
        firstResponseRisk: { current: firstResponseRisk.length, sample: firstResponseRisk.slice(0, 10).map(compactTicket) },
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
      },
    };
  });
}

export async function getDemandFlow(workspaceId, query = {}) {
  return withCache(workspaceId, 'demand-flow', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const [createdTickets, assignedTickets] = await Promise.all([
      prisma.ticket.findMany({
        where: ticketBaseWhere(workspaceId, rangeInfo, excludeNoise, 'createdAt'),
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
          isNoise: true,
          requester: { select: { name: true, email: true } },
          assignedTech: { select: { name: true } },
        },
      }),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise),
    ]);

    const trendMap = new Map();
    const priorityMap = new Map();
    const sourceMap = new Map();
    const categoryMap = new Map();
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
      increment(categoryMap, ticket.ticketCategory || 'Uncategorized');
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

    return {
      metadata: metadata(rangeInfo, { excludeNoise }),
      trend: Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      heatmap: Array.from(heatmap.entries()).map(([key, count]) => {
        const [day, hour] = key.split('|');
        return { day, hour: Number(hour), count };
      }),
      breakdowns: {
        priority: topFromMap(priorityMap),
        source: topFromMap(sourceMap),
        category: topFromMap(categoryMap),
        requester: topFromMap(requesterMap),
        noiseShare: {
          count: noiseCount,
          pct: createdTickets.length ? Number(((noiseCount / createdTickets.length) * 100).toFixed(1)) : 0,
        },
      },
      drilldown: createdTickets.slice(0, 100).map(compactTicket),
    };
  });
}

export async function getTeamBalance(workspaceId, query = {}) {
  return withCache(workspaceId, 'team-balance', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const [technicians, tickets, episodes, openTickets, leaves, serviceAccountNames] = await Promise.all([
      prisma.technician.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, email: true, photoUrl: true, workStartTime: true, workEndTime: true },
        orderBy: { name: 'asc' },
      }),
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise),
      prisma.ticketAssignmentEpisode.findMany({
        where: {
          workspaceId,
          OR: [
            { startedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
            { endedAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
          ],
        },
        select: { technicianId: true, endMethod: true, startedAt: true, endedAt: true },
      }),
      fetchOpenTickets(workspaceId, excludeNoise),
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

    for (const ticket of tickets) {
      if (!ticket.assignedTechId || !byTech.has(ticket.assignedTechId)) continue;
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
      const category = ticket.ticketCategory || 'Uncategorized';
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
        if (leave.isFullDay) row.leaveFullDays += 1;
        else row.leaveHalfDays += 1;
        row.leaveTypes[label] = (row.leaveTypes[label] || 0) + leaveAmount;
        const period = groupKey(dateKeyToUtcNoon(leave.leaveDate.toISOString().slice(0, 10)), rangeInfo);
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
    const avg = assignedCounts.length ? assignedCounts.reduce((a, b) => a + b, 0) / assignedCounts.length : 0;
    const variance = assignedCounts.length
      ? assignedCounts.reduce((sum, n) => sum + ((n - avg) ** 2), 0) / assignedCounts.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const balanceScore = avg > 0 ? Math.max(0, Math.round(100 - ((stdDev / avg) * 100))) : 100;

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
      metadata: metadata(rangeInfo, { excludeNoise }),
      summary: {
        activeTechnicians: technicians.length,
        totalAssigned: tickets.length,
        avgAssignedPerTech: Number(avg.toFixed(1)),
        stdDev: Number(stdDev.toFixed(1)),
        balanceScore,
        spread: assignedCounts.length ? Math.max(...assignedCounts) - Math.min(...assignedCounts) : 0,
        openAgeBuckets: ageBuckets,
      },
      technicians: rows.sort((a, b) => a.name.localeCompare(b.name)),
      timeline: Array.from(timelineMap.values()).sort((a, b) => a.period.localeCompare(b.period) || a.name.localeCompare(b.name)),
      notes: [
        'Team Balance is sorted alphabetically and avoids ranked winner/loser framing by design.',
        'Leave-aware capacity is shown as context; v1 does not normalize every metric by scheduled hours.',
      ],
    };
  });
}

export async function getQuality(workspaceId, query = {}) {
  return withCache(workspaceId, 'quality', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const excludeNoise = query.excludeNoise === 'true';
    const [tickets, csatTickets, openTickets] = await Promise.all([
      fetchRangeTickets(workspaceId, rangeInfo, excludeNoise),
      prisma.ticket.findMany({
        where: {
          workspaceId,
          ...(excludeNoise ? { isNoise: false } : {}),
          csatScore: { not: null },
          csatSubmittedAt: { gte: rangeInfo.start, lte: rangeInfo.end },
        },
        orderBy: { csatSubmittedAt: 'desc' },
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          priority: true,
          csatScore: true,
          csatTotalScore: true,
          csatRatingText: true,
          csatFeedback: true,
          csatSubmittedAt: true,
          requester: { select: { name: true, email: true } },
          assignedTech: { select: { name: true } },
        },
      }),
      fetchOpenTickets(workspaceId, excludeNoise),
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
      metadata: metadata(rangeInfo, { excludeNoise }),
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
        lowScoreTickets: lowCsat.slice(0, 25).map(compactCsatTicket),
        recentResponses: csatTickets.slice(0, 25).map(compactCsatTicket),
      },
    };
  });
}

export async function getAutomationOps(workspaceId, query = {}) {
  return withCache(workspaceId, 'automation-ops', query, async () => {
    const rangeInfo = parseAnalyticsRange(query);
    const [runs, steps, syncLogs, backfillRuns, dailyReviewRuns, recommendationCounts] = await Promise.all([
      prisma.assignmentPipelineRun.findMany({
        where: { workspaceId, createdAt: { gte: rangeInfo.start, lte: rangeInfo.end } },
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
        where: { pipelineRun: { workspaceId, createdAt: { gte: rangeInfo.start, lte: rangeInfo.end } } },
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
      metadata: metadata(rangeInfo),
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
    const [overview, demand, team, quality, ops] = await Promise.all([
      getOverview(workspaceId, query),
      getDemandFlow(workspaceId, query),
      getTeamBalance(workspaceId, query),
      getQuality(workspaceId, query),
      getAutomationOps(workspaceId, query),
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
        rule: 'Team balance score is below 70 after comparing assignment counts across active technicians.',
        evidenceCount: team.summary.totalAssigned,
        affected: [`Balance score: ${team.summary.balanceScore}`, `Spread: ${team.summary.spread}`],
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
        rule: 'Top ticketCategory has at least 10 tickets and at least 35% of created demand.',
        evidenceCount: demand.breakdowns.category[0].count,
        affected: [demand.breakdowns.category[0].name],
        drilldown: demand.breakdowns.category,
      }));
    }

    return {
      metadata: metadata(rangeInfo, { excludeNoise }),
      insights,
      emptyState: insights.length === 0
        ? 'No deterministic insight rules crossed their thresholds for this range.'
        : null,
    };
  });
}

export default {
  parseAnalyticsRange,
  calculateDelta,
  summarizeNumeric,
  buildInsight,
  getOverview,
  getDemandFlow,
  getTeamBalance,
  getQuality,
  getAutomationOps,
  getInsights,
};
