import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketSourceLabel } from '../utils/ticketOrigin.js';
import notificationWorkflowEngine from './notificationWorkflowEngine.js';
import statusService, { TERMINAL_BASE_STATUSES } from './statusService.js';

const TERMINAL_STATUS_VALUES = new Set(['resolved', 'closed', '4', '5']);

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableTicketId(ticket) {
  return asNumber(ticket?.id)
    || ticket?.freshserviceTicketId?.toString?.()
    || ticket?.freshserviceTicketId
    || 'ticket';
}

function stableAssignmentEvidence(upsertedTicket = {}, existingTicket = null) {
  return dateIso(upsertedTicket.firstAssignedAt)
    || dateIso(upsertedTicket.assignedAt)
    || upsertedTicket.assignmentEpisodeId
    || upsertedTicket.assignmentActivityId
    || upsertedTicket.freshserviceAssignmentActivityId
    || `${asNumber(existingTicket?.assignedTechId) || 'none'}-${asNumber(upsertedTicket.assignedTechId) || 'none'}`;
}

/**
 * Workspace-less terminal heuristic (FS ints + substrings) — the pre-8c
 * behavior, kept as the fallback for raw FS payload labels and for callers
 * without a workspace resolver (deriveTicketLifecycleEvents default).
 * A custom label like "Needs Rework" is invisible to this heuristic; the
 * registry-aware resolver below handles it.
 */
function isTerminalStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return false;
  return TERMINAL_STATUS_VALUES.has(value) || value.includes('resolved') || value.includes('closed');
}

/**
 * Registry-aware terminal check for a workspace (Phase 8c): a status is
 * terminal when its BASE is Resolved/Closed per the workspace's status
 * definitions; unknown labels keep the FS-int/substring heuristic so raw
 * FreshService payload values ('4', 'Closed') still resolve. Returns a SYNC
 * predicate so deriveTicketLifecycleEvents stays synchronous.
 */
async function workspaceTerminalResolver(workspaceId) {
  const wsId = Number(workspaceId);
  if (!Number.isFinite(wsId) || wsId <= 0) return isTerminalStatus;
  let knownTerminal = null;
  try {
    // includeInactive: retired custom statuses linger on historical rows and
    // must still resolve their base.
    const rows = await statusService.listStatuses(wsId, { includeInactive: true });
    knownTerminal = new Map(rows.map((r) => [
      r.name.toLowerCase(),
      TERMINAL_BASE_STATUSES.includes(r.baseStatus),
    ]));
  } catch {
    return isTerminalStatus; // registry unreadable → pre-8c behavior
  }
  return (status) => {
    const value = String(status || '').trim().toLowerCase();
    if (!value) return false;
    // Registry rows are AUTHORITATIVE for both directions — a non-terminal
    // custom label must not fall through to a substring match. Heuristics
    // only cover labels the registry has never seen (raw FS values).
    if (knownTerminal.has(value)) return knownTerminal.get(value);
    return isTerminalStatus(value);
  };
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

function emailList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hasPriorAssignmentEvidence(ticket) {
  if (!ticket) return false;
  return Boolean(
    asNumber(ticket.assignedTechId)
    || ticket.firstAssignedAt
    || ticket.assignedAt,
  );
}

function eventStamp(eventType, upsertedTicket, existingTicket = null) {
  if (eventType === 'ticket.created') return dateIso(upsertedTicket.createdAt) || dateIso(upsertedTicket.freshserviceUpdatedAt);
  if (eventType === 'ticket.assigned') {
    return dateIso(upsertedTicket.firstAssignedAt)
      || dateIso(upsertedTicket.assignedAt)
      || `${asNumber(existingTicket?.assignedTechId) || 'none'}-${asNumber(upsertedTicket.assignedTechId) || 'none'}`;
  }
  if (eventType === 'ticket.reassigned') {
    return dateIso(upsertedTicket.assignedAt)
      || dateIso(upsertedTicket.firstAssignedAt)
      || `${asNumber(existingTicket?.assignedTechId) || 'none'}-${asNumber(upsertedTicket.assignedTechId) || 'none'}`;
  }
  if (eventType === 'ticket.resolved_closed') {
    return dateIso(upsertedTicket.resolvedAt)
      || dateIso(upsertedTicket.closedAt)
      || dateIso(upsertedTicket.freshserviceUpdatedAt)
      || String(upsertedTicket.status || 'terminal');
  }
  if (eventType === 'ticket.status_changed') {
    // Composite of the transition + the source's own change timestamp: stable
    // across sync retries (FS re-delivers the same freshserviceUpdatedAt), and
    // unique per live TP change (updatedAt bumps on every write).
    return `${String(existingTicket?.status || '').trim()}->${String(upsertedTicket.status || '').trim()}:${
      dateIso(upsertedTicket.freshserviceUpdatedAt) || dateIso(upsertedTicket.updatedAt) || 'live'}`;
  }
  return dateIso(upsertedTicket.freshserviceUpdatedAt) || new Date().toISOString();
}

export function lifecycleNotificationFingerprint(eventType, upsertedTicket, existingTicket = null) {
  const workspaceId = asNumber(upsertedTicket?.workspaceId)
    || asNumber(existingTicket?.workspaceId)
    || 'workspace';
  const ticketId = stableTicketId(upsertedTicket) || stableTicketId(existingTicket);
  if (eventType === 'ticket.assigned') {
    return [
      workspaceId,
      eventType,
      ticketId,
      asNumber(upsertedTicket?.assignedTechId) || 'none',
      stableAssignmentEvidence(upsertedTicket, existingTicket),
    ].join(':');
  }
  if (eventType === 'ticket.reassigned') {
    return [
      workspaceId,
      eventType,
      ticketId,
      asNumber(existingTicket?.assignedTechId) || 'none',
      asNumber(upsertedTicket?.assignedTechId) || 'none',
      stableAssignmentEvidence(upsertedTicket, existingTicket),
    ].join(':');
  }
  if (eventType === 'ticket.created') {
    return [
      workspaceId,
      eventType,
      ticketId,
      dateIso(upsertedTicket?.createdAt) || eventStamp(eventType, upsertedTicket, existingTicket),
    ].join(':');
  }
  if (eventType === 'ticket.resolved_closed') {
    return [
      workspaceId,
      eventType,
      ticketId,
      dateIso(upsertedTicket?.resolvedAt)
        || dateIso(upsertedTicket?.closedAt)
        || String(upsertedTicket?.status || 'terminal'),
    ].join(':');
  }
  return [
    workspaceId,
    eventType,
    ticketId,
    eventStamp(eventType, upsertedTicket, existingTicket),
  ].join(':');
}

export function deriveTicketLifecycleEvents(existingTicket, upsertedTicket, { isTerminal = isTerminalStatus } = {}) {
  const events = [];
  if (!upsertedTicket) return events;

  if (!existingTicket) {
    events.push({
      type: 'ticket.created',
      occurredAt: dateIso(upsertedTicket.createdAt) || dateIso(upsertedTicket.freshserviceUpdatedAt) || new Date().toISOString(),
      dedupeStamp: eventStamp('ticket.created', upsertedTicket, existingTicket),
      notificationFingerprint: lifecycleNotificationFingerprint('ticket.created', upsertedTicket, existingTicket),
    });
    if (upsertedTicket.assignedTechId) {
      events.push({
        type: 'ticket.assigned',
        occurredAt: dateIso(upsertedTicket.assignedAt)
          || dateIso(upsertedTicket.firstAssignedAt)
          || dateIso(upsertedTicket.freshserviceUpdatedAt)
          || new Date().toISOString(),
        dedupeStamp: eventStamp('ticket.assigned', upsertedTicket, existingTicket),
        notificationFingerprint: lifecycleNotificationFingerprint('ticket.assigned', upsertedTicket, existingTicket),
      });
    }
    if (isTerminal(upsertedTicket.status)) {
      events.push({
        type: 'ticket.resolved_closed',
        occurredAt: dateIso(upsertedTicket.resolvedAt)
          || dateIso(upsertedTicket.closedAt)
          || dateIso(upsertedTicket.freshserviceUpdatedAt)
          || new Date().toISOString(),
        dedupeStamp: eventStamp('ticket.resolved_closed', upsertedTicket, existingTicket),
        notificationFingerprint: lifecycleNotificationFingerprint('ticket.resolved_closed', upsertedTicket, existingTicket),
      });
    }
    return events;
  }

  const oldTechId = asNumber(existingTicket.assignedTechId);
  const newTechId = asNumber(upsertedTicket.assignedTechId);
  if (newTechId && oldTechId !== newTechId) {
    const type = hasPriorAssignmentEvidence(existingTicket) ? 'ticket.reassigned' : 'ticket.assigned';
    events.push({
      type,
      occurredAt: dateIso(upsertedTicket.assignedAt)
        || dateIso(upsertedTicket.firstAssignedAt)
        || dateIso(upsertedTicket.freshserviceUpdatedAt)
        || new Date().toISOString(),
      dedupeStamp: eventStamp(type, upsertedTicket, existingTicket),
      notificationFingerprint: lifecycleNotificationFingerprint(type, upsertedTicket, existingTicket),
    });
  }

  if (!isTerminal(existingTicket.status) && isTerminal(upsertedTicket.status)) {
    events.push({
      type: 'ticket.resolved_closed',
      occurredAt: dateIso(upsertedTicket.resolvedAt)
        || dateIso(upsertedTicket.closedAt)
        || dateIso(upsertedTicket.freshserviceUpdatedAt)
        || new Date().toISOString(),
      dedupeStamp: eventStamp('ticket.resolved_closed', upsertedTicket, existingTicket),
      notificationFingerprint: lifecycleNotificationFingerprint('ticket.resolved_closed', upsertedTicket, existingTicket),
    });
  }

  // Any status transition fires ticket.status_changed — for BOTH origins.
  // (Previously only TP-native in-app changes emitted this, so FS-synced
  // transitions like Open→Pending never triggered workflows.) The from/to pair
  // rides on event.extra for conditions. resolved_closed above still fires for
  // terminal transitions; they are distinct trigger types.
  const oldStatus = String(existingTicket.status || '').trim();
  const newStatus = String(upsertedTicket.status || '').trim();
  if (oldStatus && newStatus && oldStatus !== newStatus) {
    events.push({
      type: 'ticket.status_changed',
      occurredAt: dateIso(upsertedTicket.resolvedAt)
        || dateIso(upsertedTicket.closedAt)
        || dateIso(upsertedTicket.freshserviceUpdatedAt)
        || new Date().toISOString(),
      dedupeStamp: eventStamp('ticket.status_changed', upsertedTicket, existingTicket),
      notificationFingerprint: lifecycleNotificationFingerprint('ticket.status_changed', upsertedTicket, existingTicket),
      extra: { from: oldStatus, to: newStatus },
    });
  }

  return events;
}

async function hydrateTicket(ticketId) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      workspace: true,
      requester: true,
      assignedTech: true,
      internalCategory: true,
      internalSubcategory: true,
      tagLinks: { select: { tag: { select: { name: true } } } },
    },
  });
}

async function hydratePreviousAgent(existingTicket) {
  if (!existingTicket?.assignedTechId) return null;
  return prisma.technician.findUnique({
    where: { id: existingTicket.assignedTechId },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });
}


// Compact webhook payload from an event context (gap plan 2 P3) — enough for
// integrations to react without a follow-up read; full detail via /api/v1.
// Carries the internal taxonomy NAMES + customFields (FR 08-05 Phase 1b) so
// API senders can see their intake enrichment round-trip.
export function webhookPayloadFromContext(eventContext) {
  const t = eventContext.ticket || {};
  return {
    ticket: {
      id: t.id,
      ref: t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `TP-${t.id}`,
      subject: t.subject,
      status: t.status,
      statusBase: t.statusBase ?? null,
      priority: t.priority,
      origin: t.origin,
      tags: t.tags || [],
      category: t.internalCategory?.name || null,
      subcategory: t.internalSubcategory?.name || null,
      customFields: t.customFields || {},
    },
    requester: eventContext.requester ? { name: eventContext.requester.name, email: eventContext.requester.email } : null,
    assignedAgent: eventContext.assignedAgent ? { name: eventContext.assignedAgent.name } : null,
    extra: eventContext.event?.extra || null,
  };
}

async function dispatchLifecycleWebhook(eventContext) {
  try {
    const { dispatchWebhookEvent } = await import('./webhookDispatchService.js');
    dispatchWebhookEvent(eventContext.workspace?.id, eventContext.event?.type, webhookPayloadFromContext(eventContext));
  } catch { /* integrations never break the pipeline */ }
}

// A new requester reply may shift their tone — re-classify sentiment
// (debounced; gap plan 2 P5.1). Fire-and-forget like the webhook dispatch.
async function maybeRefreshSentiment(eventContext) {
  if (eventContext.event?.type !== 'ticket.reply_received') return;
  try {
    const { default: ticketSentimentService } = await import('./ticketSentimentService.js');
    ticketSentimentService.scheduleRefresh(eventContext.ticket?.id, eventContext.workspace?.id);
  } catch { /* sentiment is an annotation, never a pipeline step */ }
}

function buildEventContext({ event, ticket, previousAgent, source, statusBase = null }) {
  return {
    event: {
      type: event.type,
      source,
      occurredAt: event.occurredAt,
      dedupeStamp: event.dedupeStamp,
      notificationFingerprint: event.notificationFingerprint,
      ...(event.extra ? { extra: event.extra } : {}),
    },
    workspace: {
      id: ticket.workspaceId,
      name: ticket.workspace?.name || ticket.workspaceName || null,
      timezone: ticket.workspace?.defaultTimezone || 'America/Los_Angeles',
    },
    ticket: {
      id: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || ticket.freshserviceTicketId,
      subject: ticket.subject,
      descriptionText: ticket.descriptionText,
      status: ticket.status,
      // Base status (Phase 8c): the label's canonical base per the workspace
      // registry, so conditions can match "any Pending-base status" without
      // enumerating custom labels.
      statusBase,
      priority: ticket.priority,
      priorityLabel: priorityLabel(ticket),
      impact: ticket.impact ?? null,
      urgency: ticket.urgency ?? null,
      // Requester sentiment (P5.1) — requester state only, team-safe.
      sentiment: ticket.sentiment || null,
      assessedPriority: ticket.assessedPriority || null,
      toEmails: emailList(ticket.toEmails),
      ccEmails: emailList(ticket.ccEmails),
      replyCcEmails: emailList(ticket.replyCcEmails),
      fwdEmails: emailList(ticket.fwdEmails),
      category: ticket.category,
      subCategory: ticket.subCategory,
      ticketCategory: ticket.ticketCategory,
      tpSkill: ticket.tpSkill,
      tpSubskill: ticket.tpSubskill,
      internalCategory: ticket.internalCategory ? {
        id: ticket.internalCategory.id,
        name: ticket.internalCategory.name,
      } : null,
      internalSubcategory: ticket.internalSubcategory ? {
        id: ticket.internalSubcategory.id,
        name: ticket.internalSubcategory.name,
      } : null,
      isNoise: ticket.isNoise === true,
      origin: ticket.origin || 'freshservice',
      // Arrival channel (QA 07-07 #1): numeric code + friendly label
      // ("Email", "Portal", "Phone", "API", "Agent"…) for conditions.
      source: ticket.source ?? null,
      sourceLabel: ticketSourceLabel(ticket.source),
      // Per-workspace ticket type ("Incident", "Case", …) for conditions.
      ticketType: ticket.ticketType || null,
      customFields: ticket.customFields || {},
      // Tag NAMES (lowercased for case-insensitive condition matching); also
      // exposed to templates as {{ ticket.tags }}.
      tags: (ticket.tagLinks || []).map((l) => l.tag?.name).filter(Boolean).map((n) => n.toLowerCase()),
      createdAt: dateIso(ticket.createdAt),
      assignedAt: dateIso(ticket.assignedAt),
      resolvedAt: dateIso(ticket.resolvedAt),
      closedAt: dateIso(ticket.closedAt),
      dueBy: dateIso(ticket.dueBy),
      frDueBy: dateIso(ticket.frDueBy),
      freshserviceUpdatedAt: dateIso(ticket.freshserviceUpdatedAt),
    },
    requester: ticket.requester ? {
      id: ticket.requester.id,
      name: ticket.requester.name,
      email: ticket.requester.email,
    } : null,
    assignedAgent: ticket.assignedTech ? {
      id: ticket.assignedTech.id,
      name: ticket.assignedTech.name,
      email: ticket.assignedTech.email,
    } : null,
    previousAgent: previousAgent ? {
      id: previousAgent.id,
      name: previousAgent.name,
      email: previousAgent.email,
    } : null,
  };
}

export async function emitTicketLifecycleNotifications({
  existingTicket,
  upsertedTicket,
  source = 'freshservice_sync',
  allowNotificationWorkflows = false,
} = {}) {
  if (!allowNotificationWorkflows) {
    return { status: 'skipped', reason: 'Notification workflows disabled for this ingest path' };
  }

  // Terminal detection is per-workspace since 8c: a custom "Done" (Resolved
  // base) fires resolved_closed; a custom "Needs Rework" (Pending base) never
  // does. Unknown labels keep the FS-int/substring heuristics.
  const workspaceId = asNumber(upsertedTicket?.workspaceId) || asNumber(existingTicket?.workspaceId);
  const isTerminal = await workspaceTerminalResolver(workspaceId);
  const events = deriveTicketLifecycleEvents(existingTicket, upsertedTicket, { isTerminal });
  if (events.length === 0) return { status: 'skipped', reason: 'No lifecycle notification events' };

  const ticket = await hydrateTicket(upsertedTicket.id);
  if (!ticket) return { status: 'skipped', reason: 'Ticket not found after upsert' };
  const previousAgent = await hydratePreviousAgent(existingTicket);
  const statusBase = await statusService.resolveBaseStatus(ticket.workspaceId, ticket.status).catch(() => null);

  const results = [];
  for (const event of events) {
    // status_changed conditions get the transition's BASES alongside the
    // names ("left an Open-base status", "entered any Pending-base status").
    if (event.type === 'ticket.status_changed' && event.extra) {
      event.extra = {
        ...event.extra,
        fromBase: await statusService.resolveBaseStatus(ticket.workspaceId, event.extra.from).catch(() => null),
        toBase: await statusService.resolveBaseStatus(ticket.workspaceId, event.extra.to).catch(() => null),
      };
    }
    const eventContext = buildEventContext({ event, ticket, previousAgent, source, statusBase });
    dispatchLifecycleWebhook(eventContext);
    maybeRefreshSentiment(eventContext);
    try {
      results.push(await notificationWorkflowEngine.executeForEvent(eventContext, {
        triggerSource: source,
      }));
    } catch (error) {
      logger.warn('Ticket lifecycle notification event failed', {
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        eventType: event.type,
        source,
        error: error.message,
      });
      results.push({ status: 'failed', eventType: event.type, error: error.message });
    }
  }

  return {
    status: 'completed',
    events: events.map((event) => event.type),
    results,
  };
}

/**
 * Fire a single registered workflow event for a ticket (Phase 5 events like
 * ticket.reply_received / ticket.note_added / ticket.status_changed).
 * Pass a stable dedupeStamp (e.g. "reply:<entryId>") so retries don't
 * double-send through the engine's delivery dedupe.
 */
export async function emitTicketEvent(eventType, ticketId, {
  source = 'ticketpulse_native',
  dedupeStamp = null,
  extra = null,
  onlyWorkflowId = null, // time-trigger/manual dispatch targets one workflow
} = {}) {
  const ticket = await hydrateTicket(ticketId);
  if (!ticket) return { status: 'skipped', reason: 'Ticket not found' };

  const stamp = dedupeStamp || `${eventType}:${ticket.id}:${new Date().toISOString()}`;
  const event = {
    type: eventType,
    occurredAt: new Date().toISOString(),
    dedupeStamp: stamp,
    notificationFingerprint: `wf:${ticket.workspaceId}:${eventType}:${stamp}`,
  };
  const statusBase = await statusService.resolveBaseStatus(ticket.workspaceId, ticket.status).catch(() => null);
  const eventContext = buildEventContext({ event, ticket, previousAgent: null, source, statusBase });
  if (extra) eventContext.event.extra = extra;
  dispatchLifecycleWebhook(eventContext);
  maybeRefreshSentiment(eventContext);

  try {
    return await notificationWorkflowEngine.executeForEvent(eventContext, {
      triggerSource: source,
      ...(onlyWorkflowId ? { onlyWorkflowId } : {}),
    });
  } catch (error) {
    logger.warn('Ticket event workflow dispatch failed', {
      workspaceId: ticket.workspaceId, ticketId: ticket.id, eventType, error: error.message,
    });
    return { status: 'failed', eventType, error: error.message };
  }
}

export default {
  deriveTicketLifecycleEvents,
  emitTicketLifecycleNotifications,
  emitTicketEvent,
  lifecycleNotificationFingerprint,
};
