import prisma from './prisma.js';
import { getNotificationProviderStatus } from './notificationProviders.js';
import notificationDeliveryService from './notificationDeliveryService.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const ESCALATION_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'phone_call']);

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function freshserviceLink(ticket) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  return fsId && host ? `https://${host}/a/tickets/${fsId}` : null;
}

function buildEscalationMessage({ ticket, priority }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const link = freshserviceLink(ticket);
  return [
    'Ticket Pulse after-hours escalation:',
    fsId ? `ticket #${fsId}` : 'a ticket',
    `was assessed as ${priority}.`,
    'Assignment is queued for business-hours reassessment.',
    link ? `Open: ${link}` : null,
  ].filter(Boolean).join(' ');
}

function buildWhatsAppVariables({ ticket, priority, message }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const link = freshserviceLink(ticket) || '';
  return {
    message,
    priority: priority || '',
    ticketId: fsId ? String(fsId) : '',
    link,
  };
}

async function hydrateRun(run) {
  if (!run?.id) return null;
  if (run.ticket?.id && run.recommendation) return run;
  return prisma.assignmentPipelineRun.findUnique({
    where: { id: run.id },
    include: {
      ticket: {
        select: {
          id: true,
          workspaceId: true,
          freshserviceTicketId: true,
          subject: true,
          assessedPriority: true,
          assessedPriorityId: true,
          priorityRationale: true,
        },
      },
    },
  });
}

class AfterHoursUrgentEscalationService {
  async queueForPriorityRun(run) {
    const hydratedRun = await hydrateRun(run);
    const ticket = hydratedRun?.ticket;
    const priority = hydratedRun?.recommendation?.assessedPriority || ticket?.assessedPriority;

    if (!hydratedRun?.id || !ticket?.id || priority !== 'Urgent') {
      return { queued: 0, skipped: 'not_urgent' };
    }

    const escalationConfig = await prisma.assignmentConfig.findUnique({
      where: { workspaceId: hydratedRun.workspaceId },
      select: {
        afterHoursUrgentEscalationEnabled: true,
        afterHoursUrgentEscalationChannels: true,
        afterHoursUrgentEscalationEmails: true,
        afterHoursUrgentEscalationPhones: true,
      },
    });

    if (!escalationConfig?.afterHoursUrgentEscalationEnabled) {
      return { queued: 0, skipped: 'disabled' };
    }

    const providerStatus = await getNotificationProviderStatus();
    const requestedChannels = normalizeList(escalationConfig.afterHoursUrgentEscalationChannels)
      .filter((channel) => ESCALATION_CHANNELS.includes(channel));
    const emails = normalizeList(escalationConfig.afterHoursUrgentEscalationEmails);
    const phones = normalizeList(escalationConfig.afterHoursUrgentEscalationPhones);

    const message = buildEscalationMessage({ ticket, priority });
    const whatsappVariables = buildWhatsAppVariables({ ticket, priority, message });
    const deliveries = [];
    const queuedChannels = new Set();

    for (const channel of requestedChannels) {
      const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
      if (!provider.configured) continue;

      const recipients = channel === 'email' ? emails : phones;
      for (const recipient of recipients) {
        queuedChannels.add(channel);
        deliveries.push({
          workspaceId: hydratedRun.workspaceId,
          technicianId: null,
          ticketId: ticket.id,
          pipelineRunId: hydratedRun.id,
          channel,
          status: 'queued',
          assessedPriority: priority,
          recipient,
          provider: provider.provider,
          dedupeKey: `after-hours-urgent:${hydratedRun.id}:${ticket.id}:${channel}:${recipient}`,
          payload: {
            message,
            voiceMessage: message,
            whatsappVariables,
            providerConfigured: provider.configured,
            providerMissing: provider.missing,
            freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
            escalationType: 'after_hours_urgent',
          },
        });
      }
    }

    if (deliveries.length === 0) {
      return { queued: 0, skipped: 'no_configured_channel_or_recipient' };
    }

    const result = await prisma.notificationDelivery.createMany({
      data: deliveries,
      skipDuplicates: true,
    });

    if (result.count > 0) {
      notificationDeliveryService.processQueuedDeliveries({ limit: result.count }).catch((error) => {
        logger.warn('After-hours urgent escalation delivery processing failed', {
          runId: hydratedRun.id,
          ticketId: ticket.id,
          error: error.message,
        });
      });
    }

    return { queued: result.count, channels: [...queuedChannels] };
  }
}

export const __testing = {
  buildEscalationMessage,
  buildWhatsAppVariables,
};

export default new AfterHoursUrgentEscalationService();
