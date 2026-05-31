import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { resolveAfterHoursActiveContact } from './urgentEscalationContactService.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';
import { getTodayRange } from '../utils/timezone.js';

export const DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS = {
  enabled: true,
  expiryDays: 60,
  showRequesterName: false,
  showRequesterEmail: false,
  showAssignedAgent: true,
  showAssignedAgentAvatar: true,
  showSummary: true,
  showPriority: true,
  showCategory: true,
  showWorkspaceStats: true,
  etaLookbackDays: 180,
  etaMinSampleSize: 8,
  etaPercentile: 75,
  brandName: null,
  logoDataUrl: null,
  logoAltText: null,
  trademarkText: null,
  accentColor: '#2563eb',
};

const CLOSED_STATUSES = ['Closed', 'Resolved', 'closed', 'resolved'];
const MAX_SUMMARY_LENGTH = 360;
const MAX_ETA_SAMPLES = 700;
const MAX_BRANDING_TEXT_LENGTH = 300;
const MAX_LOGO_DATA_URL_LENGTH = 700_000;
const ALLOWED_LOGO_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Date) return item.toISOString();
    return item;
  }));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function nullableInt(value, fallback, { min = 1, max = 3650 } = {}) {
  if (value === null) return null;
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function intInRange(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function cleanText(value, maxLength = MAX_BRANDING_TEXT_LENGTH) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanAccentColor(value) {
  const text = String(value || '').trim();
  return HEX_COLOR_RE.test(text) ? text : DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.accentColor;
}

function cleanLogoDataUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (text.length > MAX_LOGO_DATA_URL_LENGTH) {
    throw new ValidationError('Logo image is too large. Use a PNG, JPG, WEBP, or GIF under 512 KB.');
  }
  if (!ALLOWED_LOGO_DATA_URL.test(text)) {
    throw new ValidationError('Logo must be a PNG, JPG, WEBP, or GIF image data URL.');
  }
  return text.replace(/\s/g, '');
}

export function normalizePublicTicketStatusSettings(row = {}) {
  return {
    enabled: bool(row.enabled, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.enabled),
    expiryDays: row.expiryDays === null
      ? null
      : nullableInt(row.expiryDays, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.expiryDays, { min: 1, max: 3650 }),
    showRequesterName: bool(row.showRequesterName, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showRequesterName),
    showRequesterEmail: bool(row.showRequesterEmail, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showRequesterEmail),
    showAssignedAgent: bool(row.showAssignedAgent, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showAssignedAgent),
    showAssignedAgentAvatar: bool(row.showAssignedAgentAvatar, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showAssignedAgentAvatar),
    showSummary: bool(row.showSummary, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showSummary),
    showPriority: bool(row.showPriority, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showPriority),
    showCategory: bool(row.showCategory, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showCategory),
    showWorkspaceStats: bool(row.showWorkspaceStats, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.showWorkspaceStats),
    etaLookbackDays: intInRange(row.etaLookbackDays, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.etaLookbackDays, 30, 1095),
    etaMinSampleSize: intInRange(row.etaMinSampleSize, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.etaMinSampleSize, 3, 100),
    etaPercentile: intInRange(row.etaPercentile, DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.etaPercentile, 50, 95),
    brandName: cleanText(row.brandName, 120),
    logoDataUrl: row.logoDataUrl || null,
    logoAltText: cleanText(row.logoAltText, 160),
    trademarkText: cleanText(row.trademarkText, 300),
    accentColor: cleanAccentColor(row.accentColor),
    updatedBy: row.updatedBy || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

function normalizeSettingsInput(input = {}) {
  const normalized = normalizePublicTicketStatusSettings({
    ...DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS,
    ...input,
  });
  return {
    enabled: normalized.enabled,
    expiryDays: normalized.expiryDays,
    showRequesterName: normalized.showRequesterName,
    showRequesterEmail: normalized.showRequesterEmail,
    showAssignedAgent: normalized.showAssignedAgent,
    showAssignedAgentAvatar: normalized.showAssignedAgentAvatar,
    showSummary: normalized.showSummary,
    showPriority: normalized.showPriority,
    showCategory: normalized.showCategory,
    showWorkspaceStats: normalized.showWorkspaceStats,
    etaLookbackDays: normalized.etaLookbackDays,
    etaMinSampleSize: normalized.etaMinSampleSize,
    etaPercentile: normalized.etaPercentile,
    brandName: cleanText(input.brandName, 120),
    logoDataUrl: cleanLogoDataUrl(input.logoDataUrl),
    logoAltText: cleanText(input.logoAltText, 160),
    trademarkText: cleanText(input.trademarkText, 300),
    accentColor: cleanAccentColor(input.accentColor),
  };
}

function hashText(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashPublicStatusToken(token) {
  return hashText(String(token || '').trim());
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function computeExpiresAt(settings, now = new Date()) {
  if (settings.expiryDays === null) return null;
  return new Date(now.getTime() + settings.expiryDays * 24 * 60 * 60 * 1000);
}

function publicBaseUrl(baseUrl = null) {
  const configured = process.env.PUBLIC_APP_URL
    || process.env.FRONTEND_PUBLIC_URL
    || process.env.FRONTEND_URL
    || process.env.APP_URL
    || process.env.CORS_ORIGIN?.split(',')?.[0]
    || baseUrl
    || 'http://localhost:5173';
  return String(configured).trim().replace(/\/+$/, '');
}

export function buildPublicTicketStatusUrl(token, baseUrl = null) {
  return `${publicBaseUrl(baseUrl)}/ticket-status/${encodeURIComponent(token)}`;
}

export function buildTicketEscalationUrl(token, baseUrl = null) {
  return `${publicBaseUrl(baseUrl)}/ticket-escalation/${encodeURIComponent(token)}`;
}

export function buildTicketUrgencyUrl(token, baseUrl = null) {
  return `${publicBaseUrl(baseUrl)}/ticket-urgency/${encodeURIComponent(token)}`;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarize(text) {
  const clean = stripHtml(text);
  if (!clean) return null;
  return clean.length > MAX_SUMMARY_LENGTH ? `${clean.slice(0, MAX_SUMMARY_LENGTH - 1).trim()}...` : clean;
}

function priorityLabel(ticket) {
  if (ticket?.assessedPriority) return ticket.assessedPriority;
  return {
    1: 'Low',
    2: 'Medium',
    3: 'High',
    4: 'Urgent',
  }[Number(ticket?.priority)] || String(ticket?.priority || '');
}

function statusTone(status) {
  const text = String(status || '').toLowerCase();
  if (text.includes('closed') || text.includes('resolved')) return 'resolved';
  if (text.includes('pending')) return 'waiting';
  if (text.includes('open')) return 'open';
  return 'neutral';
}

function isPendingStatus(status) {
  const text = String(status || '').toLowerCase();
  return text.includes('pending') || text.includes('waiting') || text.includes('on hold');
}

function secondsLabel(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return 'Not enough history yet';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.round((value % 3600) / 60);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrNull(value) {
  const date = dateOrNull(value);
  return date ? date.toISOString() : null;
}

function isResolvedStatus(status) {
  return statusTone(status) === 'resolved';
}

function lifecycleStartAt(ticket) {
  return dateOrNull(ticket?.createdAt);
}

function lifecycleUpdatedAt(ticket) {
  return dateOrNull(ticket?.freshserviceUpdatedAt);
}

function lifecycleCompletedAt(ticket) {
  const explicit = dateOrNull(ticket?.closedAt) || dateOrNull(ticket?.resolvedAt);
  if (explicit) return explicit;
  if (!isResolvedStatus(ticket?.status)) return null;

  const startAt = lifecycleStartAt(ticket);
  const resolutionSeconds = Number(ticket?.resolutionTimeSeconds);
  if (startAt && Number.isFinite(resolutionSeconds) && resolutionSeconds > 0) {
    return new Date(startAt.getTime() + resolutionSeconds * 1000);
  }

  return lifecycleUpdatedAt(ticket);
}

function lifecycleAssignedAt(ticket) {
  return dateOrNull(ticket?.firstAssignedAt) || dateOrNull(ticket?.assignedAt);
}

function actualResolutionSeconds(ticket, startAt, completedAt) {
  const storedSeconds = Number(ticket?.resolutionTimeSeconds);
  if (Number.isFinite(storedSeconds) && storedSeconds > 0) return storedSeconds;
  if (!startAt || !completedAt) return null;
  const seconds = Math.round((completedAt.getTime() - startAt.getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

function percentile(values, percentileValue) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function trimOutliers(values) {
  if (values.length < 20) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  return sorted.slice(trimCount, sorted.length - trimCount);
}

function priorityFilter(ticket) {
  const clauses = [];
  if (ticket.assessedPriority) clauses.push({ assessedPriority: ticket.assessedPriority });
  if (Number.isInteger(Number(ticket.priority))) clauses.push({ priority: Number(ticket.priority) });
  return clauses.length ? { OR: clauses } : null;
}

function categoryValueFilters(ticket) {
  const filters = [];
  if (ticket.internalCategoryId) filters.push({ internalCategoryId: ticket.internalCategoryId });
  if (ticket.internalSubcategoryId) filters.push({ internalSubcategoryId: ticket.internalSubcategoryId });
  if (ticket.tpSkill) filters.push({ tpSkill: ticket.tpSkill });
  if (ticket.tpSubskill) filters.push({ tpSubskill: ticket.tpSubskill });
  return filters;
}

function etaTiers(ticket) {
  const priority = priorityFilter(ticket);
  const tiers = [];

  if (ticket.internalCategoryId && ticket.internalSubcategoryId) {
    tiers.push({
      key: 'internal_subcategory_priority',
      label: 'Internal category, subcategory, and priority',
      filters: [
        { internalCategoryId: ticket.internalCategoryId },
        { internalSubcategoryId: ticket.internalSubcategoryId },
        priority,
      ].filter(Boolean),
    });
  }

  if (ticket.tpSkill || ticket.tpSubskill) {
    tiers.push({
      key: 'ticket_pulse_skill_priority',
      label: 'Ticket Pulse category/subcategory and priority',
      filters: [
        ticket.tpSkill ? { tpSkill: ticket.tpSkill } : null,
        ticket.tpSubskill ? { tpSubskill: ticket.tpSubskill } : null,
        priority,
      ].filter(Boolean),
    });
  }

  const categoryFilters = categoryValueFilters(ticket);
  if (categoryFilters.length > 0) {
    tiers.push({
      key: 'category_only',
      label: 'Closest matching category history',
      filters: [{ OR: categoryFilters }],
    });
  }

  if (priority) {
    tiers.push({
      key: 'priority_only',
      label: 'Same priority history',
      filters: [priority],
    });
  }

  tiers.push({
    key: 'workspace_baseline',
    label: 'Workspace-wide resolution history',
    filters: [],
  });

  return tiers;
}

function baseResolvedWhere(ticket, settings) {
  const lookbackStart = new Date(Date.now() - settings.etaLookbackDays * 24 * 60 * 60 * 1000);
  return {
    workspaceId: ticket.workspaceId,
    id: { not: ticket.id },
    isNoise: false,
    resolutionTimeSeconds: { gt: 0 },
    createdAt: { gte: lookbackStart },
    OR: [
      { resolvedAt: { not: null } },
      { closedAt: { not: null } },
      { status: { in: CLOSED_STATUSES } },
    ],
  };
}

function etaConfidence(sampleSize, tierKey, minSampleSize) {
  if (sampleSize >= minSampleSize * 3 && !['priority_only', 'workspace_baseline'].includes(tierKey)) return 'high';
  if (sampleSize >= minSampleSize && tierKey !== 'workspace_baseline') return 'medium';
  return 'low';
}

async function samplesForTier(ticket, settings, tier) {
  const rows = await prisma.ticket.findMany({
    where: {
      AND: [
        baseResolvedWhere(ticket, settings),
        ...tier.filters,
      ],
    },
    select: {
      resolutionTimeSeconds: true,
    },
    orderBy: [
      { resolvedAt: 'desc' },
      { closedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    take: MAX_ETA_SAMPLES,
  });
  return rows
    .map(row => Number(row.resolutionTimeSeconds))
    .filter(value => Number.isFinite(value) && value > 0);
}

export async function computeTicketEta(ticket, settingsInput = DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS) {
  const settings = normalizePublicTicketStatusSettings(settingsInput);
  let bestFallback = null;

  for (const tier of etaTiers(ticket)) {
    const samples = await samplesForTier(ticket, settings, tier);
    if (samples.length === 0) continue;

    const trimmed = trimOutliers(samples);
    const estimatedSeconds = percentile(trimmed, settings.etaPercentile);
    const result = {
      estimatedSeconds,
      label: secondsLabel(estimatedSeconds),
      percentile: settings.etaPercentile,
      lookbackDays: settings.etaLookbackDays,
      sampleSize: samples.length,
      trimmedSampleSize: trimmed.length,
      minSampleSize: settings.etaMinSampleSize,
      matchTier: tier.key,
      matchLabel: tier.label,
      confidence: etaConfidence(samples.length, tier.key, settings.etaMinSampleSize),
    };

    if (samples.length >= settings.etaMinSampleSize) {
      return withTicketEtaTiming(ticket, result);
    }
    if (!bestFallback) bestFallback = result;
  }

  return bestFallback
    ? withTicketEtaTiming(ticket, { ...bestFallback, confidence: 'low', lowSampleWarning: true })
    : withTicketEtaTiming(ticket, {
      estimatedSeconds: null,
      label: 'Not enough history yet',
      confidence: 'none',
      percentile: settings.etaPercentile,
      lookbackDays: settings.etaLookbackDays,
      sampleSize: 0,
      minSampleSize: settings.etaMinSampleSize,
      matchTier: 'none',
      matchLabel: 'No comparable resolved tickets found',
    });
}

function withTicketEtaTiming(ticket, eta) {
  const startedAt = lifecycleStartAt(ticket);
  const completedAt = lifecycleCompletedAt(ticket);
  const isDone = isResolvedStatus(ticket.status) || Boolean(completedAt);
  const isPaused = !isDone && isPendingStatus(ticket.status);
  const expectedAt = startedAt && eta.estimatedSeconds
    ? new Date(startedAt.getTime() + eta.estimatedSeconds * 1000)
    : null;
  const remainingSeconds = expectedAt && !isDone && !isPaused
    ? Math.max(0, Math.round((expectedAt.getTime() - Date.now()) / 1000))
    : null;
  const overdue = Boolean(expectedAt && !isDone && !isPaused && expectedAt.getTime() < Date.now());
  const actualSeconds = isDone ? actualResolutionSeconds(ticket, startedAt, completedAt) : null;
  const actualLabel = actualSeconds ? secondsLabel(actualSeconds) : null;
  const estimateLabel = eta.estimatedSeconds ? secondsLabel(eta.estimatedSeconds) : null;

  let state = 'unknown';
  let displayLabel = estimateLabel || eta.label || 'Not enough history yet';
  let statusLabel = 'Expected resolution';
  let summary = eta.matchLabel || 'Not enough resolved ticket history for this workspace yet.';

  if (isDone) {
    state = 'resolved';
    statusLabel = String(ticket.status || '').toLowerCase().includes('closed') ? 'Closed' : 'Resolved';
    displayLabel = actualLabel || 'Completed';
    summary = actualLabel
      ? `Completed in ${actualLabel}${estimateLabel ? `; typical similar tickets take about ${estimateLabel}.` : '.'}`
      : estimateLabel
        ? `This ticket is complete. Typical similar tickets take about ${estimateLabel}.`
        : 'This ticket is complete.';
  } else if (isPaused) {
    state = 'paused';
    statusLabel = 'Estimate paused';
    displayLabel = 'Pending dependency';
    summary = estimateLabel
      ? `Historical estimate is ${estimateLabel}, but pending tickets are waiting on information, access, vendor work, or another dependency.`
      : 'Pending tickets are waiting on information, access, vendor work, or another dependency.';
  } else if (overdue) {
    state = 'overdue';
    statusLabel = 'Past estimate';
    displayLabel = 'Past estimate';
    summary = estimateLabel
      ? `Typical similar tickets resolve in about ${estimateLabel}. This ticket is still active past that point.`
      : 'This ticket is still active and past the available historical estimate.';
  } else if (expectedAt) {
    state = 'on_track';
    statusLabel = 'Expected resolution';
    displayLabel = remainingSeconds === null ? estimateLabel : secondsLabel(remainingSeconds);
    summary = `Typical similar tickets resolve in about ${estimateLabel}. Current estimate points to ${expectedAt.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })}.`;
  }

  return {
    ...eta,
    startedAt: isoOrNull(startedAt),
    completedAt: isoOrNull(completedAt),
    expectedAt: expectedAt ? expectedAt.toISOString() : null,
    estimatedResolutionLabel: estimateLabel,
    percentileLabel: eta.percentile ? `P${eta.percentile}` : null,
    state,
    isComplete: isDone,
    statusLabel,
    displayLabel,
    summary,
    paused: isPaused,
    pausedReason: isPaused ? 'Pending status pauses historical resolution estimates.' : null,
    remainingSeconds,
    remainingLabel: isPaused
      ? 'Paused while pending'
      : remainingSeconds === null
        ? null
        : overdue || remainingSeconds === 0
          ? 'Past estimate'
          : secondsLabel(remainingSeconds),
    overdue,
    actualResolutionSeconds: actualSeconds,
    actualResolutionLabel: actualLabel,
  };
}

async function workspaceStats(ticket, settings) {
  if (!settings.showWorkspaceStats) return null;
  const timezone = ticket.workspace?.defaultTimezone || 'America/Los_Angeles';
  const { start, end } = getTodayRange(timezone);
  const weekStart = new Date(start.getTime() - 6 * 24 * 60 * 60 * 1000);
  const [createdToday, resolvedToday, createdWeek, resolvedWeek] = await Promise.all([
    prisma.ticket.count({
      where: {
        workspaceId: ticket.workspaceId,
        createdAt: { gte: start, lte: end },
      },
    }),
    prisma.ticket.count({
      where: {
        workspaceId: ticket.workspaceId,
        OR: [
          { resolvedAt: { gte: start, lte: end } },
          { closedAt: { gte: start, lte: end } },
        ],
      },
    }),
    prisma.ticket.count({
      where: {
        workspaceId: ticket.workspaceId,
        createdAt: { gte: weekStart, lte: end },
      },
    }),
    prisma.ticket.count({
      where: {
        workspaceId: ticket.workspaceId,
        OR: [
          { resolvedAt: { gte: weekStart, lte: end } },
          { closedAt: { gte: weekStart, lte: end } },
        ],
      },
    }),
  ]);

  return {
    timezone,
    windowLabel: 'Today and last 7 days',
    todayCreated: createdToday,
    todayResolvedOrClosed: resolvedToday,
    weekCreated: createdWeek,
    weekResolvedOrClosed: resolvedWeek,
  };
}

export async function getPublicTicketStatusSettings(workspaceId) {
  const row = await prisma.publicTicketStatusSettings.upsert({
    where: { workspaceId },
    update: {},
    create: {
      workspaceId,
      ...DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS,
    },
  });
  return normalizePublicTicketStatusSettings(row);
}

export async function updatePublicTicketStatusSettings(workspaceId, input = {}, actor = null) {
  const data = normalizeSettingsInput(input);
  const actorEmail = actor?.email || actor?.username || null;
  const row = await prisma.publicTicketStatusSettings.upsert({
    where: { workspaceId },
    update: {
      ...data,
      updatedBy: actorEmail,
    },
    create: {
      workspaceId,
      ...data,
      updatedBy: actorEmail,
    },
  });
  return normalizePublicTicketStatusSettings(row);
}

async function getTicketForLink(workspaceId, ticketId) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: { id: true, workspaceId: true },
  });
  if (!ticket) throw new NotFoundError('Ticket not found in this workspace');
  return ticket;
}

export async function ensurePublicTicketStatusLink({
  workspaceId,
  ticketId,
  actor = null,
  baseUrl = null,
} = {}) {
  if (!workspaceId || !ticketId) throw new ValidationError('Workspace id and ticket id are required');
  const settings = await getPublicTicketStatusSettings(workspaceId);
  if (!settings.enabled) {
    return {
      enabled: false,
      url: null,
      expiresAt: null,
      reason: 'Public ticket status is disabled for this workspace',
    };
  }

  await getTicketForLink(workspaceId, ticketId);
  const existing = await prisma.publicTicketStatusLink.findUnique({
    where: { workspaceId_ticketId: { workspaceId, ticketId } },
  });

  if (existing && existing.enabled && !existing.revokedAt) {
    return {
      enabled: true,
      url: buildPublicTicketStatusUrl(existing.token, baseUrl),
      expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : null,
      existing: true,
    };
  }

  const token = newToken();
  const row = await prisma.publicTicketStatusLink.upsert({
    where: { workspaceId_ticketId: { workspaceId, ticketId } },
    update: {
      token,
      tokenHash: hashPublicStatusToken(token),
      tokenPrefix: token.slice(0, 10),
      enabled: true,
      expiresAt: computeExpiresAt(settings),
      revokedAt: null,
      revokedBy: null,
    },
    create: {
      workspaceId,
      ticketId,
      token,
      tokenHash: hashPublicStatusToken(token),
      tokenPrefix: token.slice(0, 10),
      enabled: true,
      expiresAt: computeExpiresAt(settings),
      createdBy: actor?.email || actor?.username || null,
    },
  });

  return {
    enabled: true,
    url: buildPublicTicketStatusUrl(token, baseUrl),
    token,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    existing: false,
  };
}

export async function resetPublicTicketStatusLink({
  workspaceId,
  ticketId,
  actor = null,
  baseUrl = null,
} = {}) {
  if (!workspaceId || !ticketId) throw new ValidationError('Workspace id and ticket id are required');
  const settings = await getPublicTicketStatusSettings(workspaceId);
  await getTicketForLink(workspaceId, ticketId);

  const token = newToken();
  const row = await prisma.publicTicketStatusLink.upsert({
    where: { workspaceId_ticketId: { workspaceId, ticketId } },
    update: {
      token,
      tokenHash: hashPublicStatusToken(token),
      tokenPrefix: token.slice(0, 10),
      enabled: true,
      expiresAt: computeExpiresAt(settings),
      revokedAt: null,
      revokedBy: null,
      viewCount: 0,
      lastViewedAt: null,
    },
    create: {
      workspaceId,
      ticketId,
      token,
      tokenHash: hashPublicStatusToken(token),
      tokenPrefix: token.slice(0, 10),
      enabled: true,
      expiresAt: computeExpiresAt(settings),
      createdBy: actor?.email || actor?.username || null,
    },
  });

  await prisma.publicTicketStatusView.create({
    data: {
      workspaceId,
      ticketId,
      linkId: row.id,
      payload: safeJson({
        action: 'reset',
        actorEmail: actor?.email || actor?.username || null,
      }),
    },
  });

  return {
    url: buildPublicTicketStatusUrl(token, baseUrl),
    token,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export async function revokePublicTicketStatusLink({ workspaceId, ticketId, actor = null } = {}) {
  if (!workspaceId || !ticketId) throw new ValidationError('Workspace id and ticket id are required');
  const existing = await prisma.publicTicketStatusLink.findUnique({
    where: { workspaceId_ticketId: { workspaceId, ticketId } },
  });
  if (!existing) throw new NotFoundError('Public ticket status link not found');

  const row = await prisma.publicTicketStatusLink.update({
    where: { id: existing.id },
    data: {
      enabled: false,
      revokedAt: new Date(),
      revokedBy: actor?.email || actor?.username || null,
    },
  });

  await prisma.publicTicketStatusView.create({
    data: {
      workspaceId,
      ticketId,
      linkId: row.id,
      payload: safeJson({
        action: 'revoke',
        actorEmail: actor?.email || actor?.username || null,
      }),
    },
  });

  return { revoked: true };
}

async function ticketWithPublicData(where) {
  return prisma.ticket.findFirst({
    where,
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          defaultTimezone: true,
        },
      },
      requester: {
        select: {
          name: true,
          email: true,
        },
      },
      assignedTech: {
        select: {
          id: true,
          name: true,
          email: true,
          photoUrl: true,
        },
      },
      internalCategory: {
        select: {
          id: true,
          name: true,
        },
      },
      internalSubcategory: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
}

function publicTicket(ticket, settings) {
  const startedAt = lifecycleStartAt(ticket);
  const assignedAt = lifecycleAssignedAt(ticket);
  const completedAt = lifecycleCompletedAt(ticket);
  const freshserviceUpdatedAt = lifecycleUpdatedAt(ticket);
  return {
    freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
    subject: ticket.subject || 'Ticket status',
    summary: settings.showSummary ? summarize(ticket.descriptionText || ticket.description) : null,
    status: ticket.status,
    statusTone: statusTone(ticket.status),
    priority: settings.showPriority ? priorityLabel(ticket) : null,
    category: settings.showCategory ? {
      ticketPulseCategory: ticket.internalCategory?.name || ticket.tpSkill || null,
      ticketPulseSubcategory: ticket.internalSubcategory?.name || ticket.tpSubskill || null,
      source: ticket.internalCategory?.name
        ? 'internal_taxonomy'
        : ticket.tpSkill || ticket.tpSubskill
          ? 'ticket_pulse_fields'
          : 'not_classified',
    } : null,
    requester: (settings.showRequesterName || settings.showRequesterEmail) ? {
      name: settings.showRequesterName ? ticket.requester?.name || null : null,
      email: settings.showRequesterEmail ? ticket.requester?.email || null : null,
    } : null,
    assignedAgent: settings.showAssignedAgent ? {
      name: ticket.assignedTech?.name || null,
      photoUrl: settings.showAssignedAgentAvatar ? ticket.assignedTech?.photoUrl || null : null,
    } : null,
    createdAt: isoOrNull(startedAt),
    assignedAt: isoOrNull(assignedAt),
    resolvedAt: isoOrNull(ticket.resolvedAt),
    closedAt: isoOrNull(ticket.closedAt),
    completedAt: isoOrNull(completedAt),
    updatedAt: isoOrNull(freshserviceUpdatedAt),
  };
}

function publicTimeline(ticket) {
  const startedAt = lifecycleStartAt(ticket);
  const assignedAt = lifecycleAssignedAt(ticket);
  const updatedAt = lifecycleUpdatedAt(ticket);
  const completedAt = lifecycleCompletedAt(ticket);
  const isClosed = String(ticket.status || '').toLowerCase().includes('closed');
  const timeline = [
    {
      key: 'received',
      label: 'Received',
      tone: 'blue',
      at: isoOrNull(startedAt),
      detail: 'The helpdesk received this request.',
    },
  ];

  if (assignedAt || ticket.assignedTech?.name) {
    timeline.push({
      key: 'assigned',
      label: 'Assigned',
      tone: 'indigo',
      at: isoOrNull(assignedAt),
      detail: ticket.assignedTech?.name ? `Assigned to ${ticket.assignedTech.name}.` : 'Assigned to an agent.',
    });
  }

  if (updatedAt && (!completedAt || updatedAt.getTime() !== completedAt.getTime())) {
    timeline.push({
      key: 'updated',
      label: 'Updated',
      tone: 'cyan',
      at: isoOrNull(updatedAt),
      detail: 'FreshService has a newer activity or status update for this ticket.',
    });
  }

  if (isPendingStatus(ticket.status)) {
    timeline.push({
      key: 'pending',
      label: 'Pending',
      tone: 'amber',
      at: isoOrNull(updatedAt),
      detail: 'The ticket is waiting on information, access, vendor work, or another dependency.',
    });
  } else if (completedAt || statusTone(ticket.status) === 'resolved') {
    timeline.push({
      key: isClosed ? 'closed' : 'resolved',
      label: isClosed ? 'Closed' : 'Resolved',
      tone: 'emerald',
      at: isoOrNull(completedAt),
      detail: isClosed ? 'The ticket has been closed.' : 'The ticket has been resolved.',
    });
  } else {
    timeline.push({
      key: 'active',
      label: 'In progress',
      tone: 'emerald',
      at: isoOrNull(updatedAt || assignedAt || startedAt),
      detail: 'The assigned team is working through the request.',
    });
  }

  return timeline;
}

async function serializePublicStatus({ link, ticket, settings, token = null }) {
  const [eta, stats, latestImmediateSupportEvent, latestUrgencyEvent] = await Promise.all([
    computeTicketEta(ticket, settings),
    workspaceStats(ticket, settings),
    prisma.urgentEscalationEvent.findFirst({
      where: {
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        source: 'self_service',
        status: { notIn: ['failed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, priorityWritebackStatus: true },
    }).catch(() => null),
    prisma.urgentEscalationEvent.findFirst({
      where: {
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        source: 'business_urgency',
        status: { notIn: ['failed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, priorityWritebackStatus: true },
    }).catch(() => null),
  ]);
  return {
    workspace: {
      name: ticket.workspace?.name || ticket.workspaceName || 'Ticket Pulse',
      timezone: ticket.workspace?.defaultTimezone || 'America/Los_Angeles',
    },
    ticket: publicTicket(ticket, settings),
    timeline: publicTimeline(ticket),
    eta,
    stats,
    branding: {
      brandName: settings.brandName || ticket.workspace?.name || 'Ticket Pulse',
      logoDataUrl: settings.logoDataUrl || null,
      logoAltText: settings.logoAltText || settings.brandName || ticket.workspace?.name || 'Ticket Pulse',
      trademarkText: settings.trademarkText || null,
      accentColor: settings.accentColor || DEFAULT_PUBLIC_TICKET_STATUS_SETTINGS.accentColor,
    },
    link: {
      expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      revoked: Boolean(link.revokedAt),
      viewCount: link.viewCount || 0,
      url: token ? buildPublicTicketStatusUrl(token) : null,
      raiseUrgencyUrl: token ? buildTicketUrgencyUrl(token) : null,
      immediateSupportUrl: token ? buildTicketEscalationUrl(token) : null,
    },
    publicActions: {
      immediateSupportRequested: Boolean(latestImmediateSupportEvent),
      immediateSupportRequestedAt: latestImmediateSupportEvent?.createdAt?.toISOString?.() || null,
      immediateSupportStatus: latestImmediateSupportEvent?.status || null,
      urgencyRaised: Boolean(latestUrgencyEvent),
      urgencyRaisedAt: latestUrgencyEvent?.createdAt?.toISOString?.() || null,
      urgencyStatus: latestUrgencyEvent?.status || null,
    },
    settings: {
      showRequesterName: settings.showRequesterName,
      showRequesterEmail: settings.showRequesterEmail,
      showAssignedAgentAvatar: settings.showAssignedAgentAvatar,
      manualRefreshOnly: true,
    },
    refreshedAt: new Date().toISOString(),
  };
}

export async function getPublicTicketStatusByToken(token, requestMeta = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new NotFoundError('Ticket status link not found');
  const tokenHash = hashPublicStatusToken(trimmed);
  const link = await prisma.publicTicketStatusLink.findUnique({
    where: { tokenHash },
  });
  if (!link) throw new NotFoundError('Ticket status link not found');
  if (!link.enabled || link.revokedAt) throw new AuthorizationError('This ticket status link has been revoked');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    throw new AuthorizationError('This ticket status link has expired');
  }

  const settings = await getPublicTicketStatusSettings(link.workspaceId);
  if (!settings.enabled) {
    throw new AuthorizationError('Public ticket status is disabled for this workspace');
  }

  const ticket = await ticketWithPublicData({
    id: link.ticketId,
    workspaceId: link.workspaceId,
  });
  if (!ticket) throw new NotFoundError('Ticket not found');

  const response = await serializePublicStatus({ link, ticket, settings, token: trimmed });
  await prisma.$transaction([
    prisma.publicTicketStatusLink.update({
      where: { id: link.id },
      data: {
        viewCount: { increment: 1 },
        lastViewedAt: new Date(),
      },
    }),
    prisma.publicTicketStatusView.create({
      data: {
        workspaceId: link.workspaceId,
        ticketId: link.ticketId,
        linkId: link.id,
        ipHash: hashText(requestMeta.ip || ''),
        userAgent: String(requestMeta.userAgent || '').slice(0, 500) || null,
        statusAtView: ticket.status || null,
        payload: safeJson({
          public: true,
          expiresAt: response.link.expiresAt,
          eta: response.eta ? {
            estimatedSeconds: response.eta.estimatedSeconds,
            sampleSize: response.eta.sampleSize,
            matchTier: response.eta.matchTier,
            confidence: response.eta.confidence,
          } : null,
        }),
      },
    }),
  ]);

  return response;
}

export async function previewPublicTicketStatus(workspaceId, ticketId) {
  const settings = await getPublicTicketStatusSettings(workspaceId);
  const ticket = await ticketWithPublicData({ id: ticketId, workspaceId });
  if (!ticket) throw new NotFoundError('Ticket not found in this workspace');
  return serializePublicStatus({
    link: { expiresAt: computeExpiresAt(settings), revokedAt: null, viewCount: 0 },
    ticket,
    settings,
  });
}

export async function enrichEventContextWithPublicStatusUrl(eventContext, options = {}) {
  const context = safeJson(eventContext || {});
  const workspaceId = Number(context.workspace?.id || context.ticket?.workspaceId);
  const ticketId = Number(context.ticket?.id);
  if (!workspaceId || !ticketId) return context;

  try {
    const link = await ensurePublicTicketStatusLink({
      workspaceId,
      ticketId,
      actor: options.actor || null,
      baseUrl: options.baseUrl || null,
    });
    const token = link.token || null;
    const savedLink = !token ? await prisma.publicTicketStatusLink.findUnique({
      where: { workspaceId_ticketId: { workspaceId, ticketId } },
      select: { token: true },
    }) : null;
    const publicToken = token || savedLink?.token || null;
    const escalationPolicy = prisma.urgentEscalationPolicy?.findUnique
      ? await prisma.urgentEscalationPolicy.findUnique({
        where: { workspaceId },
        select: {
          selfServiceEnabled: true,
          businessUrgencyEnabled: true,
        },
      }).catch(() => null)
      : null;
    const activeContact = await resolveAfterHoursActiveContact(workspaceId, {
      timezone: context.workspace?.timezone,
    }).catch((error) => ({
      technicianId: null,
      name: null,
      email: null,
      photoUrl: null,
      phone: null,
      rotationLabel: 'Unable to resolve current contact',
      source: 'error',
      phoneVerified: false,
      warnings: [error.message],
    }));
    const selfEscalationUrl = escalationPolicy?.selfServiceEnabled && publicToken
      ? buildTicketEscalationUrl(publicToken, options.baseUrl || null)
      : null;
    const raiseUrgencyUrl = escalationPolicy?.businessUrgencyEnabled !== false && publicToken
      ? buildTicketUrgencyUrl(publicToken, options.baseUrl || null)
      : null;
    context.publicStatusUrl = link.url || null;
    context.ticket.publicStatusUrl = link.url || null;
    context.ticket.publicStatusExpiresAt = link.expiresAt || null;
    context.raiseUrgencyUrl = raiseUrgencyUrl;
    context.ticket.raiseUrgencyUrl = raiseUrgencyUrl;
    context.ticket.urgencyRaiseUrl = raiseUrgencyUrl;
    context.selfEscalationUrl = selfEscalationUrl;
    context.afterHoursEscalationUrl = selfEscalationUrl;
    context.ticket.selfEscalationUrl = selfEscalationUrl;
    context.ticket.afterHoursEscalationUrl = selfEscalationUrl;
    context.afterHoursSupport = {
      ...(context.afterHoursSupport && typeof context.afterHoursSupport === 'object'
        ? context.afterHoursSupport
        : {}),
      selfEscalationUrl,
      immediateSupportUrl: selfEscalationUrl,
      activeContact,
      ...(selfEscalationUrl ? { emergencySupportUrl: selfEscalationUrl } : {}),
    };
  } catch (error) {
    logger.warn('Unable to enrich notification context with public ticket status URL', {
      workspaceId,
      ticketId,
      error: error.message,
    });
    context.publicStatusUrl = null;
    context.selfEscalationUrl = null;
    context.raiseUrgencyUrl = null;
    context.afterHoursEscalationUrl = null;
    if (context.ticket) {
      context.ticket.publicStatusUrl = null;
      context.ticket.selfEscalationUrl = null;
      context.ticket.raiseUrgencyUrl = null;
      context.ticket.urgencyRaiseUrl = null;
      context.ticket.afterHoursEscalationUrl = null;
      context.ticket.publicStatusError = error.message;
    }
    context.afterHoursSupport = {
      ...(context.afterHoursSupport && typeof context.afterHoursSupport === 'object'
        ? context.afterHoursSupport
        : {}),
      selfEscalationUrl: null,
      immediateSupportUrl: null,
      activeContact: null,
    };
  }
  return context;
}

export default {
  getPublicTicketStatusSettings,
  updatePublicTicketStatusSettings,
  ensurePublicTicketStatusLink,
  resetPublicTicketStatusLink,
  revokePublicTicketStatusLink,
  getPublicTicketStatusByToken,
  previewPublicTicketStatus,
  computeTicketEta,
  enrichEventContextWithPublicStatusUrl,
  buildPublicTicketStatusUrl,
  buildTicketEscalationUrl,
  buildTicketUrgencyUrl,
};
