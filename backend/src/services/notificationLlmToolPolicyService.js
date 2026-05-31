import { z } from 'zod';
import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';

export const NOTIFICATION_LLM_POLICY_MODES = ['off', 'context_only', 'tools_enabled'];

export const NOTIFICATION_LLM_TOOL_CATALOG = [
  {
    name: 'get_notification_context',
    label: 'Notification context',
    description: 'Provides the redacted ticket, recipient, business-window, thread, similar-ticket, and signal bundle for the current workflow run.',
    riskLevel: 'read_only',
    defaultEnabled: true,
    phase: 1,
  },
  {
    name: 'get_ticket_thread_summary',
    label: 'Ticket thread',
    description: 'Returns bounded FreshService thread entries for the current ticket with private-note handling controlled by workspace policy.',
    riskLevel: 'read_only_internal_notes',
    defaultEnabled: true,
    phase: 2,
  },
  {
    name: 'find_similar_tickets',
    label: 'Similar tickets',
    description: 'Searches recent workspace tickets by category, requester department, and keywords to find related cases.',
    riskLevel: 'read_only',
    defaultEnabled: true,
    phase: 2,
  },
  {
    name: 'detect_related_ticket_spike',
    label: 'Related ticket spike',
    description: 'Counts recent similar tickets and returns conservative public wording allowed by deterministic thresholds.',
    riskLevel: 'read_only',
    defaultEnabled: true,
    phase: 2,
  },
  {
    name: 'search_recent_tickets',
    label: 'Recent ticket search',
    description: 'Runs a bounded workspace-scoped search over recent tickets for broader "is this happening today?" checks.',
    riskLevel: 'read_only',
    defaultEnabled: false,
    phase: 2,
  },
];

const DEFAULT_ENABLED_TOOLS = NOTIFICATION_LLM_TOOL_CATALOG
  .filter((tool) => tool.defaultEnabled)
  .map((tool) => tool.name);

export const DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS = {
  context: {
    includeThreadHistory: true,
    includeSimilarTickets: true,
    includeOutageSignals: true,
    maxThreadEntries: 6,
    maxSimilarTickets: 5,
    lookbackHours: [1, 4, 24],
  },
  outageSignals: {
    watchThreshold: 3,
    possibleBroaderIssueThreshold: 5,
    distinctRequesterThreshold: 3,
    distinctDepartmentThreshold: 2,
  },
  safety: {
    maxContextBytes: 40000,
    maxToolOutputBytes: 12000,
  },
};

export const DEFAULT_NOTIFICATION_LLM_TOOL_POLICY = {
  mode: 'context_only',
  enabledTools: DEFAULT_ENABLED_TOOLS,
  toolSettings: DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS,
  maxTurns: 4,
  maxToolCalls: 6,
  totalTimeoutMs: 20000,
  perToolTimeoutMs: 3000,
  includePrivateNotes: false,
  redactionEnabled: true,
  policyVersion: 1,
  updatedBy: null,
};

const catalogNames = new Set(NOTIFICATION_LLM_TOOL_CATALOG.map((tool) => tool.name));

function actorEmail(actor = null) {
  return String(actor?.email || actor || '').trim() || null;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function uniqueKnownTools(value) {
  const rawTools = Array.isArray(value) ? value : DEFAULT_ENABLED_TOOLS;
  return [...new Set(rawTools.map((tool) => String(tool || '').trim()).filter(Boolean))]
    .filter((tool) => catalogNames.has(tool));
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeLookbackHours(value) {
  const raw = Array.isArray(value) && value.length > 0 ? value : DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.lookbackHours;
  const normalized = raw
    .map((item) => clampInteger(item, null, 1, 168))
    .filter((item) => Number.isFinite(item));
  return [...new Set(normalized)].sort((a, b) => a - b).slice(0, 6);
}

function normalizeToolSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const context = source.context && typeof source.context === 'object' ? source.context : {};
  const outageSignals = source.outageSignals && typeof source.outageSignals === 'object' ? source.outageSignals : {};
  const safety = source.safety && typeof source.safety === 'object' ? source.safety : {};

  return {
    context: {
      includeThreadHistory: normalizeBoolean(
        context.includeThreadHistory,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.includeThreadHistory,
      ),
      includeSimilarTickets: normalizeBoolean(
        context.includeSimilarTickets,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.includeSimilarTickets,
      ),
      includeOutageSignals: normalizeBoolean(
        context.includeOutageSignals,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.includeOutageSignals,
      ),
      maxThreadEntries: clampInteger(
        context.maxThreadEntries,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.maxThreadEntries,
        0,
        20,
      ),
      maxSimilarTickets: clampInteger(
        context.maxSimilarTickets,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.context.maxSimilarTickets,
        0,
        20,
      ),
      lookbackHours: normalizeLookbackHours(context.lookbackHours),
    },
    outageSignals: {
      watchThreshold: clampInteger(
        outageSignals.watchThreshold,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.outageSignals.watchThreshold,
        2,
        100,
      ),
      possibleBroaderIssueThreshold: clampInteger(
        outageSignals.possibleBroaderIssueThreshold,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.outageSignals.possibleBroaderIssueThreshold,
        2,
        200,
      ),
      distinctRequesterThreshold: clampInteger(
        outageSignals.distinctRequesterThreshold,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.outageSignals.distinctRequesterThreshold,
        1,
        100,
      ),
      distinctDepartmentThreshold: clampInteger(
        outageSignals.distinctDepartmentThreshold,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.outageSignals.distinctDepartmentThreshold,
        1,
        100,
      ),
    },
    safety: {
      maxContextBytes: clampInteger(
        safety.maxContextBytes,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.safety.maxContextBytes,
        5000,
        100000,
      ),
      maxToolOutputBytes: clampInteger(
        safety.maxToolOutputBytes,
        DEFAULT_NOTIFICATION_LLM_TOOL_SETTINGS.safety.maxToolOutputBytes,
        1000,
        50000,
      ),
    },
  };
}

export function normalizeNotificationLlmToolPolicy(row = null) {
  const source = row || {};
  const mode = NOTIFICATION_LLM_POLICY_MODES.includes(source.mode)
    ? source.mode
    : DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.mode;

  return {
    id: source.id || null,
    workspaceId: source.workspaceId || null,
    mode,
    enabledTools: uniqueKnownTools(source.enabledTools),
    toolSettings: normalizeToolSettings(source.toolSettings),
    maxTurns: clampInteger(source.maxTurns, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.maxTurns, 1, 8),
    maxToolCalls: clampInteger(source.maxToolCalls, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.maxToolCalls, 0, 20),
    totalTimeoutMs: clampInteger(source.totalTimeoutMs, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.totalTimeoutMs, 2000, 60000),
    perToolTimeoutMs: clampInteger(source.perToolTimeoutMs, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.perToolTimeoutMs, 500, 15000),
    includePrivateNotes: normalizeBoolean(source.includePrivateNotes, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.includePrivateNotes),
    redactionEnabled: normalizeBoolean(source.redactionEnabled, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.redactionEnabled),
    policyVersion: clampInteger(source.policyVersion, DEFAULT_NOTIFICATION_LLM_TOOL_POLICY.policyVersion, 1, 1000000),
    updatedBy: source.updatedBy || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

const updateSchema = z.object({
  mode: z.enum(NOTIFICATION_LLM_POLICY_MODES).optional(),
  enabledTools: z.array(z.string()).optional(),
  toolSettings: z.record(z.any()).optional(),
  maxTurns: z.number().int().optional(),
  maxToolCalls: z.number().int().optional(),
  totalTimeoutMs: z.number().int().optional(),
  perToolTimeoutMs: z.number().int().optional(),
  includePrivateNotes: z.boolean().optional(),
  redactionEnabled: z.boolean().optional(),
});

function validateKnownTools(tools = []) {
  const unknown = tools.filter((tool) => !catalogNames.has(tool));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown notification LLM tool: ${unknown.join(', ')}`);
  }
}

export function notificationLlmToolCatalog() {
  return NOTIFICATION_LLM_TOOL_CATALOG.map((tool) => ({ ...tool }));
}

export async function getNotificationLlmToolPolicy(workspaceId) {
  const row = await prisma.notificationLlmToolPolicy.findUnique({
    where: { workspaceId },
  });
  return normalizeNotificationLlmToolPolicy(row || { workspaceId });
}

export async function updateNotificationLlmToolPolicy(workspaceId, data = {}, actor = null) {
  const parsed = updateSchema.safeParse(data || {});
  if (!parsed.success) {
    throw new ValidationError('Notification LLM tool policy is invalid', parsed.error.issues);
  }
  const current = await getNotificationLlmToolPolicy(workspaceId);
  const mergedTools = parsed.data.enabledTools === undefined
    ? current.enabledTools
    : [...new Set(parsed.data.enabledTools.map((tool) => String(tool || '').trim()).filter(Boolean))];
  validateKnownTools(mergedTools);

  const normalized = normalizeNotificationLlmToolPolicy({
    ...current,
    ...parsed.data,
    enabledTools: mergedTools,
    toolSettings: {
      ...(current.toolSettings || {}),
      ...(parsed.data.toolSettings || {}),
      context: {
        ...(current.toolSettings?.context || {}),
        ...(parsed.data.toolSettings?.context || {}),
      },
      outageSignals: {
        ...(current.toolSettings?.outageSignals || {}),
        ...(parsed.data.toolSettings?.outageSignals || {}),
      },
      safety: {
        ...(current.toolSettings?.safety || {}),
        ...(parsed.data.toolSettings?.safety || {}),
      },
    },
    workspaceId,
    policyVersion: current.id ? current.policyVersion + 1 : 1,
    updatedBy: actorEmail(actor),
  });

  const row = await prisma.notificationLlmToolPolicy.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      mode: normalized.mode,
      enabledTools: normalized.enabledTools,
      toolSettings: normalized.toolSettings,
      maxTurns: normalized.maxTurns,
      maxToolCalls: normalized.maxToolCalls,
      totalTimeoutMs: normalized.totalTimeoutMs,
      perToolTimeoutMs: normalized.perToolTimeoutMs,
      includePrivateNotes: normalized.includePrivateNotes,
      redactionEnabled: normalized.redactionEnabled,
      policyVersion: normalized.policyVersion,
      updatedBy: normalized.updatedBy,
    },
    update: {
      mode: normalized.mode,
      enabledTools: normalized.enabledTools,
      toolSettings: normalized.toolSettings,
      maxTurns: normalized.maxTurns,
      maxToolCalls: normalized.maxToolCalls,
      totalTimeoutMs: normalized.totalTimeoutMs,
      perToolTimeoutMs: normalized.perToolTimeoutMs,
      includePrivateNotes: normalized.includePrivateNotes,
      redactionEnabled: normalized.redactionEnabled,
      policyVersion: { increment: 1 },
      updatedBy: normalized.updatedBy,
    },
  });

  return normalizeNotificationLlmToolPolicy(row);
}

export default {
  notificationLlmToolCatalog,
  getNotificationLlmToolPolicy,
  updateNotificationLlmToolPolicy,
  normalizeNotificationLlmToolPolicy,
};
