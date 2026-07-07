import prisma from './prisma.js';
import logger from '../utils/logger.js';
import notificationWorkflowEngine from './notificationWorkflowEngine.js';

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

function isTerminalStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return false;
  return TERMINAL_STATUS_VALUES.has(value) || value.includes('resolved') || value.includes('closed');
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

export function deriveTicketLifecycleEvents(existingTicket, upsertedTicket) {
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
    if (isTerminalStatus(upsertedTicket.status)) {
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

  if (!isTerminalStatus(existingTicket.status) && isTerminalStatus(upsertedTicket.status)) {
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

function buildEventContext({ event, ticket, previousAgent, source }) {
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
      priority: ticket.priority,
      priorityLabel: priorityLabel(ticket),
      impact: ticket.impact ?? null,
      urgency: ticket.urgency ?? null,
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

  const events = deriveTicketLifecycleEvents(existingTicket, upsertedTicket);
  if (events.length === 0) return { status: 'skipped', reason: 'No lifecycle notification events' };

  const ticket = await hydrateTicket(upsertedTicket.id);
  if (!ticket) return { status: 'skipped', reason: 'Ticket not found after upsert' };
  const previousAgent = await hydratePreviousAgent(existingTicket);

  const results = [];
  for (const event of events) {
    const eventContext = buildEventContext({ event, ticket, previousAgent, source });
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
  const eventContext = buildEventContext({ event, ticket, previousAgent: null, source });
  if (extra) eventContext.event.extra = extra;

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
