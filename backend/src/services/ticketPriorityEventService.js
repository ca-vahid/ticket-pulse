import prisma from './prisma.js';
import assignmentPipelineService from './assignmentPipelineService.js';
import notificationPreferenceService from './notificationPreferenceService.js';
import { PRIORITY_ID_TO_LABEL, PRIORITY_LABEL_TO_ID } from './priorityAssessment.js';
import logger from '../utils/logger.js';

const NOTIFY_PRIORITY_FLOOR = PRIORITY_LABEL_TO_ID.High;

function priorityLabel(priorityId) {
  const id = Number(priorityId);
  return PRIORITY_ID_TO_LABEL[id] || `P${id}`;
}

function priorityDirection(fromPriorityId, toPriorityId) {
  const fromId = Number(fromPriorityId || 0);
  const toId = Number(toPriorityId || 0);
  if (toId > fromId) return 'raised';
  if (toId < fromId) return 'lowered';
  return 'changed';
}

function eventDedupeKey({ ticketId, fromPriorityId, toPriorityId, sourceUpdatedAt }) {
  const sourceStamp = sourceUpdatedAt ? new Date(sourceUpdatedAt).toISOString() : 'unknown-source-time';
  return `fs-priority:${ticketId}:${fromPriorityId || 'none'}:${toPriorityId}:${sourceStamp}`;
}

function shouldNotify(event) {
  return event?.direction === 'raised' && Number(event.toPriorityId) >= NOTIFY_PRIORITY_FLOOR;
}

async function safeFindEvent(dedupeKey) {
  return prisma.ticketPriorityEvent.findUnique({ where: { dedupeKey } }).catch((error) => {
    logger.warn('Priority event lookup failed', { dedupeKey, error: error.message });
    return null;
  });
}

class TicketPriorityEventService {
  async recordFreshServicePriorityChange({
    existingTicket,
    upsertedTicket,
    source = 'freshservice_sync',
    processAsync = true,
  } = {}) {
    const fromPriorityId = Number(existingTicket?.priority);
    const toPriorityId = Number(upsertedTicket?.priority);
    if (!existingTicket?.id || !upsertedTicket?.id || !Number.isFinite(fromPriorityId) || !Number.isFinite(toPriorityId)) {
      return { recorded: false, skipped: 'missing_ticket_priority_context' };
    }
    if (fromPriorityId === toPriorityId) {
      return { recorded: false, skipped: 'priority_unchanged' };
    }

    const sourceUpdatedAt = upsertedTicket.freshserviceUpdatedAt || existingTicket.freshserviceUpdatedAt || null;
    const dedupeKey = eventDedupeKey({
      ticketId: upsertedTicket.id,
      fromPriorityId,
      toPriorityId,
      sourceUpdatedAt,
    });

    const existingEvent = await safeFindEvent(dedupeKey);
    if (existingEvent) {
      return { recorded: false, skipped: 'already_recorded', event: existingEvent };
    }

    let event;
    try {
      event = await prisma.ticketPriorityEvent.create({
        data: {
          workspaceId: upsertedTicket.workspaceId,
          ticketId: upsertedTicket.id,
          eventType: 'freshservice_priority_changed',
          source,
          fromPriorityId,
          fromPriorityLabel: priorityLabel(fromPriorityId),
          toPriorityId,
          toPriorityLabel: priorityLabel(toPriorityId),
          direction: priorityDirection(fromPriorityId, toPriorityId),
          sourceUpdatedAt,
          dedupeKey,
        },
      });
    } catch (error) {
      if (error.code === 'P2002') {
        const duplicate = await safeFindEvent(dedupeKey);
        return { recorded: false, skipped: 'already_recorded', event: duplicate };
      }
      throw error;
    }

    logger.info('FreshService priority change recorded', {
      priorityEventId: event.id,
      ticketId: event.ticketId,
      workspaceId: event.workspaceId,
      fromPriorityId,
      toPriorityId,
      direction: event.direction,
    });

    if (processAsync) {
      this.processEvent(event.id).catch((error) => {
        logger.warn('Priority-change event processing failed', {
          priorityEventId: event.id,
          ticketId: event.ticketId,
          error: error.message,
        });
      });
    }

    return { recorded: true, event };
  }

  async processPendingEvents(workspaceId, { limit = 25 } = {}) {
    const events = await prisma.ticketPriorityEvent.findMany({
      where: {
        workspaceId,
        status: { in: ['recorded', 'failed'] },
      },
      orderBy: { detectedAt: 'asc' },
      take: Math.max(1, Math.min(Number(limit) || 25, 100)),
      select: { id: true },
    });

    let processed = 0;
    for (const event of events) {
      await this.processEvent(event.id);
      processed += 1;
    }
    return { checked: events.length, processed };
  }

  async processEvent(eventId) {
    const event = await prisma.ticketPriorityEvent.findUnique({
      where: { id: eventId },
      include: {
        ticket: {
          select: {
            id: true,
            workspaceId: true,
            freshserviceTicketId: true,
            subject: true,
            assignedTechId: true,
            assignedTech: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!event) return { processed: false, skipped: 'event_not_found' };

    let notificationResult = { queued: 0, skipped: 'not_notification_eligible' };
    let notificationStatus = 'skipped';
    const reassessmentRunId = event.reassessmentRunId || null;

    try {
      if (shouldNotify(event)) {
        notificationResult = await notificationPreferenceService.queueNotificationsForPriorityChange(event);
        notificationStatus = notificationResult.queued > 0 ? 'queued' : 'skipped';
      }

      const rememberReassessmentRun = (runId) => {
        if (!runId) return;
        prisma.ticketPriorityEvent.update({
          where: { id: event.id },
          data: { reassessmentRunId: runId },
        }).catch((error) => {
          logger.warn('Priority-change reassessment run link update failed', {
            priorityEventId: event.id,
            reassessmentRunId: runId,
            error: error.message,
          });
        });
      };

      assignmentPipelineService.runPipeline(
        event.ticketId,
        event.workspaceId,
        'priority_changed',
        (pipelineEvent) => {
          if (pipelineEvent?.type === 'run_started') {
            rememberReassessmentRun(pipelineEvent.runId);
          }
        },
        null,
        { priorityEventId: event.id },
      ).then((run) => {
        const runId = run?.id || run?.existingRunId || null;
        rememberReassessmentRun(runId);
        return null;
      }).catch((error) => {
        logger.warn('Priority-change reassessment run failed', {
          priorityEventId: event.id,
          ticketId: event.ticketId,
          error: error.message,
        });
      });

      await prisma.ticketPriorityEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          skipReason: notificationResult.skipped || null,
          notificationSummary: {
            notificationStatus,
            ...notificationResult,
          },
          reassessmentRunId,
        },
      });

      return {
        processed: true,
        notificationStatus,
        ...notificationResult,
        reassessmentRunId,
      };
    } catch (error) {
      await prisma.ticketPriorityEvent.update({
        where: { id: event.id },
        data: {
          status: 'failed',
          skipReason: error.message,
          notificationSummary: {
            notificationStatus: 'failed',
            error: error.message,
          },
          reassessmentRunId,
        },
      });
      throw error;
    }
  }
}

export const __testing = {
  eventDedupeKey,
  priorityDirection,
  priorityLabel,
  shouldNotify,
};

export default new TicketPriorityEventService();
