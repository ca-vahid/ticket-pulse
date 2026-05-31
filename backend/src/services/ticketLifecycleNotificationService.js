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

function eventStamp(eventType, upsertedTicket, existingTicket = null) {
  if (eventType === 'ticket.created') return dateIso(upsertedTicket.createdAt) || dateIso(upsertedTicket.freshserviceUpdatedAt);
  if (eventType === 'ticket.assigned' || eventType === 'ticket.reassigned') {
    return dateIso(upsertedTicket.assignedAt)
      || dateIso(upsertedTicket.firstAssignedAt)
      || dateIso(upsertedTicket.freshserviceUpdatedAt)
      || `${asNumber(existingTicket?.assignedTechId) || 'none'}-${asNumber(upsertedTicket.assignedTechId) || 'none'}`;
  }
  if (eventType === 'ticket.resolved_closed') {
    return dateIso(upsertedTicket.resolvedAt)
      || dateIso(upsertedTicket.closedAt)
      || dateIso(upsertedTicket.freshserviceUpdatedAt)
      || String(upsertedTicket.status || 'terminal');
  }
  return dateIso(upsertedTicket.freshserviceUpdatedAt) || new Date().toISOString();
}

export function deriveTicketLifecycleEvents(existingTicket, upsertedTicket) {
  const events = [];
  if (!upsertedTicket) return events;

  if (!existingTicket) {
    events.push({
      type: 'ticket.created',
      occurredAt: dateIso(upsertedTicket.createdAt) || dateIso(upsertedTicket.freshserviceUpdatedAt) || new Date().toISOString(),
      dedupeStamp: eventStamp('ticket.created', upsertedTicket, existingTicket),
    });
    if (upsertedTicket.assignedTechId) {
      events.push({
        type: 'ticket.assigned',
        occurredAt: dateIso(upsertedTicket.assignedAt)
          || dateIso(upsertedTicket.firstAssignedAt)
          || dateIso(upsertedTicket.freshserviceUpdatedAt)
          || new Date().toISOString(),
        dedupeStamp: eventStamp('ticket.assigned', upsertedTicket, existingTicket),
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
      });
    }
    return events;
  }

  const oldTechId = asNumber(existingTicket.assignedTechId);
  const newTechId = asNumber(upsertedTicket.assignedTechId);
  if (newTechId && oldTechId !== newTechId) {
    const type = oldTechId ? 'ticket.reassigned' : 'ticket.assigned';
    events.push({
      type,
      occurredAt: dateIso(upsertedTicket.assignedAt)
        || dateIso(upsertedTicket.firstAssignedAt)
        || dateIso(upsertedTicket.freshserviceUpdatedAt)
        || new Date().toISOString(),
      dedupeStamp: eventStamp(type, upsertedTicket, existingTicket),
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
      assessedPriority: ticket.assessedPriority || null,
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
      createdAt: dateIso(ticket.createdAt),
      assignedAt: dateIso(ticket.assignedAt),
      resolvedAt: dateIso(ticket.resolvedAt),
      closedAt: dateIso(ticket.closedAt),
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

export default {
  deriveTicketLifecycleEvents,
  emitTicketLifecycleNotifications,
};
