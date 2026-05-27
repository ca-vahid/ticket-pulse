import { randomInt } from 'node:crypto';
import prisma from './prisma.js';
import graphMailClient from '../integrations/graphMailClient.js';
import { ValidationError } from '../utils/errors.js';
import { resolveAgentTechnician } from './agentCompetencyService.js';
import { priorityMeetsThreshold } from './priorityAssessment.js';
import { getNotificationProviderStatus } from './notificationProviders.js';
import notificationDeliveryService from './notificationDeliveryService.js';
import { sendVerificationSms } from './twilioNotificationService.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export const NOTIFICATION_THRESHOLDS = Object.freeze(['disabled', 'high_urgent', 'urgent_only']);
export const NOTIFICATION_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'phone_call']);

const CHANNEL_FIELD = Object.freeze({
  email: 'emailEnabled',
  sms: 'smsEnabled',
  whatsapp: 'whatsappEnabled',
  phone_call: 'phoneCallEnabled',
});

const PHONE_CHANNELS = new Set(['sms', 'whatsapp', 'phone_call']);

function normalizeThreshold(value = 'high_urgent') {
  const threshold = String(value || 'high_urgent').trim();
  if (!NOTIFICATION_THRESHOLDS.includes(threshold)) {
    throw new ValidationError('Invalid notification threshold');
  }
  return threshold;
}

function normalizePhone(value) {
  const phone = String(value || '').trim();
  return phone ? phone.slice(0, 50) : null;
}

function preferredPhone(preference = {}) {
  return preference.phoneOverride || preference.entraMobilePhone || preference.entraPhone || null;
}

export function notificationPreferenceAllows(preference = {}, priority, channel) {
  if (!NOTIFICATION_CHANNELS.includes(channel)) return false;
  if (!preference[CHANNEL_FIELD[channel]]) return false;
  if (!priorityMeetsThreshold(priority, preference.threshold || 'high_urgent')) return false;
  if (PHONE_CHANNELS.has(channel) && !preference.phoneVerifiedAt) return false;
  if (PHONE_CHANNELS.has(channel) && !preferredPhone(preference)) return false;
  return true;
}

export function buildNotificationMessage({ ticket, priority }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  const link = fsId && host ? `https://${host}/a/tickets/${fsId}` : null;
  return [
    fsId ? `Ticket #${fsId}` : 'A ticket',
    `${priority} priority`,
    'has been assigned to you.',
    link ? `Open: ${link}` : null,
  ].filter(Boolean).join(' ');
}

export function buildPriorityChangeNotificationMessage({ ticket, priority }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  const link = fsId && host ? `https://${host}/a/tickets/${fsId}` : null;
  return [
    fsId ? `Ticket #${fsId}` : 'A ticket',
    `is now ${priority} priority.`,
    'You are assigned in FreshService.',
    link ? `Open: ${link}` : null,
  ].filter(Boolean).join(' ');
}

function buildWhatsAppVariables({ ticket, priority, message }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  const link = fsId && host ? `https://${host}/a/tickets/${fsId}` : '';
  return {
    message,
    priority: priority || '',
    ticketId: fsId ? String(fsId) : '',
    link,
  };
}

export function buildVoiceNotificationMessage({ ticket, priority }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  return [
    'Ticket Pulse alert.',
    fsId ? `Ticket number ${fsId}` : 'A ticket',
    `is ${priority} priority and has been assigned to you.`,
  ].filter(Boolean).join(' ');
}

export function buildPriorityChangeVoiceNotificationMessage({ ticket, priority }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  return [
    'Ticket Pulse priority alert.',
    fsId ? `Ticket number ${fsId}` : 'A ticket',
    `is now ${priority} priority.`,
    'You are assigned in FreshService.',
  ].filter(Boolean).join(' ');
}

async function getGraphPhones(email) {
  if (!email) return { entraPhone: null, entraMobilePhone: null };
  const profile = await graphMailClient.getUserProfile(email);
  if (profile?.error) return { entraPhone: null, entraMobilePhone: null, graphError: profile.error };
  return {
    entraPhone: normalizePhone(profile.businessPhones?.[0]),
    entraMobilePhone: normalizePhone(profile.mobilePhone),
  };
}

function serializePreference(preference, providerStatus = null) {
  const phone = preferredPhone(preference);
  return {
    id: preference.id,
    workspaceId: preference.workspaceId,
    technicianId: preference.technicianId,
    threshold: preference.threshold,
    channels: {
      email: !!preference.emailEnabled,
      sms: !!preference.smsEnabled,
      whatsapp: !!preference.whatsappEnabled,
      phone_call: !!preference.phoneCallEnabled,
    },
    entraPhone: preference.entraPhone,
    entraMobilePhone: preference.entraMobilePhone,
    phoneOverride: preference.phoneOverride,
    effectivePhone: phone,
    phoneVerified: !!preference.phoneVerifiedAt,
    phoneVerifiedAt: preference.phoneVerifiedAt,
    providerStatus,
  };
}

class NotificationPreferenceService {
  async getMyPreferences(email, workspaceId = null) {
    const { technician, matches } = await resolveAgentTechnician(email, workspaceId);
    let preference = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId: technician.id },
    });

    const graphPhones = await getGraphPhones(technician.email || email);
    const phoneUpdates = {};
    if (graphPhones.entraPhone && graphPhones.entraPhone !== preference?.entraPhone) phoneUpdates.entraPhone = graphPhones.entraPhone;
    if (graphPhones.entraMobilePhone && graphPhones.entraMobilePhone !== preference?.entraMobilePhone) phoneUpdates.entraMobilePhone = graphPhones.entraMobilePhone;

    if (!preference) {
      preference = await prisma.technicianNotificationPreference.create({
        data: {
          workspaceId: technician.workspaceId,
          technicianId: technician.id,
          threshold: 'high_urgent',
          ...phoneUpdates,
        },
      });
    } else if (Object.keys(phoneUpdates).length > 0) {
      preference = await prisma.technicianNotificationPreference.update({
        where: { technicianId: technician.id },
        data: phoneUpdates,
      });
    }

    const providerStatus = await getNotificationProviderStatus();

    return {
      technician: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        workspaceId: technician.workspaceId,
      },
      profiles: matches.map((match) => ({
        id: match.id,
        name: match.name,
        email: match.email,
        workspaceId: match.workspaceId,
        workspace: match.workspace,
      })),
      graphError: graphPhones.graphError || null,
      preferences: serializePreference(preference, providerStatus),
    };
  }

  async saveMyPreferences(email, body = {}) {
    const { technician } = await resolveAgentTechnician(email, body.workspaceId);
    const current = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId: technician.id },
    });

    const phoneOverride = body.phoneOverride !== undefined
      ? normalizePhone(body.phoneOverride)
      : current?.phoneOverride || null;
    const phoneChanged = body.phoneOverride !== undefined && phoneOverride !== (current?.phoneOverride || null);
    const threshold = normalizeThreshold(body.threshold ?? current?.threshold ?? 'high_urgent');
    const channels = body.channels || {};

    const next = {
      threshold,
      emailEnabled: channels.email !== undefined ? !!channels.email : !!current?.emailEnabled,
      smsEnabled: channels.sms !== undefined ? !!channels.sms : !!current?.smsEnabled,
      whatsappEnabled: channels.whatsapp !== undefined ? !!channels.whatsapp : !!current?.whatsappEnabled,
      phoneCallEnabled: channels.phone_call !== undefined ? !!channels.phone_call : !!current?.phoneCallEnabled,
      phoneOverride,
      ...(phoneChanged ? { phoneVerifiedAt: null, phoneVerificationCode: null, phoneVerificationRequestedAt: null } : {}),
    };

    const phoneVerifiedAt = phoneChanged ? null : current?.phoneVerifiedAt || null;
    const effectivePhone = phoneOverride || current?.entraMobilePhone || current?.entraPhone || null;
    if ((next.smsEnabled || next.whatsappEnabled || next.phoneCallEnabled) && (!phoneVerifiedAt || !effectivePhone)) {
      throw new ValidationError('Verify a phone number before enabling SMS, WhatsApp, or phone-call notifications');
    }

    const providerStatus = await getNotificationProviderStatus();
    const unavailableChannels = [
      next.emailEnabled && !providerStatus.email?.configured ? 'email' : null,
      next.smsEnabled && !providerStatus.sms?.configured ? 'SMS' : null,
      next.whatsappEnabled && !providerStatus.whatsapp?.configured ? 'WhatsApp' : null,
      next.phoneCallEnabled && !providerStatus.phone_call?.configured ? 'phone-call' : null,
    ].filter(Boolean);
    if (unavailableChannels.length > 0) {
      throw new ValidationError(`Cannot enable ${unavailableChannels.join(', ')} notifications until the provider is configured`);
    }

    const preference = await prisma.technicianNotificationPreference.upsert({
      where: { technicianId: technician.id },
      create: {
        workspaceId: technician.workspaceId,
        technicianId: technician.id,
        ...next,
      },
      update: next,
    });

    return serializePreference(preference, providerStatus);
  }

  async requestPhoneVerification(email, body = {}) {
    const { technician } = await resolveAgentTechnician(email, body.workspaceId);
    const preference = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId: technician.id },
    });
    const phone = preferredPhone(preference || {});
    if (!phone) throw new ValidationError('Add a phone number before requesting verification');

    const code = String(randomInt(100000, 1000000));
    const providerStatus = await getNotificationProviderStatus();
    const smsProvider = providerStatus.sms || { configured: false };

    if (smsProvider.configured) {
      await sendVerificationSms({ to: phone, code });
    } else if (process.env.NODE_ENV === 'production') {
      throw new ValidationError('Twilio SMS is not configured');
    }

    await prisma.technicianNotificationPreference.upsert({
      where: { technicianId: technician.id },
      create: {
        workspaceId: technician.workspaceId,
        technicianId: technician.id,
        threshold: 'high_urgent',
        phoneVerificationCode: code,
        phoneVerificationRequestedAt: new Date(),
      },
      update: {
        phoneVerificationCode: code,
        phoneVerificationRequestedAt: new Date(),
      },
    });

    return {
      sent: smsProvider.configured,
      channel: smsProvider.configured ? 'sms' : null,
      devCode: smsProvider.configured || process.env.NODE_ENV === 'production' ? undefined : code,
    };
  }

  async confirmPhoneVerification(email, body = {}) {
    const { technician } = await resolveAgentTechnician(email, body.workspaceId);
    const code = String(body.code || '').trim();
    const preference = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId: technician.id },
    });
    if (!preference?.phoneVerificationCode || preference.phoneVerificationCode !== code) {
      throw new ValidationError('Invalid phone verification code');
    }

    const updated = await prisma.technicianNotificationPreference.update({
      where: { technicianId: technician.id },
      data: {
        phoneVerifiedAt: new Date(),
        phoneVerificationCode: null,
        phoneVerificationRequestedAt: null,
      },
    });

    return serializePreference(updated, await getNotificationProviderStatus());
  }

  async queueNotificationsForAssignment(run, action) {
    const ticket = run.ticket || await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: {
        id: true,
        workspaceId: true,
        freshserviceTicketId: true,
        assessedPriority: true,
        assessedPriorityId: true,
      },
    });

    if (!ticket?.assessedPriority || !action?.techId) {
      return { queued: 0, skipped: 'missing_priority_or_technician' };
    }

    const preference = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId: action.techId },
      include: { technician: { select: { email: true } } },
    });
    if (!preference) return { queued: 0, skipped: 'no_preferences' };

    const providerStatus = await getNotificationProviderStatus();
    const channels = NOTIFICATION_CHANNELS.filter((channel) => (
      notificationPreferenceAllows(preference, ticket.assessedPriority, channel)
      && providerStatus[channel]?.configured
    ));
    if (channels.length === 0) return { queued: 0, skipped: 'threshold_channel_or_provider_disabled' };

    const message = buildNotificationMessage({ ticket, priority: ticket.assessedPriority });
    const voiceMessage = buildVoiceNotificationMessage({ ticket, priority: ticket.assessedPriority });
    const whatsappVariables = buildWhatsAppVariables({
      ticket,
      priority: ticket.assessedPriority,
      message,
    });
    const deliveries = channels.map((channel) => {
      const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
      const recipient = channel === 'email'
        ? action.techEmail || preference.technician?.email || null
        : preferredPhone(preference);
      return {
        workspaceId: run.workspaceId,
        technicianId: action.techId,
        ticketId: run.ticketId,
        pipelineRunId: run.id,
        channel,
        status: 'queued',
        assessedPriority: ticket.assessedPriority,
        recipient,
        provider: provider.provider,
        dedupeKey: `${run.id}:${run.ticketId}:${action.techId}:${channel}`,
        payload: {
          message,
          voiceMessage,
          whatsappVariables,
          providerConfigured: provider.configured,
          providerMissing: provider.missing,
          freshserviceTicketId: Number(ticket.freshserviceTicketId),
        },
      };
    });

    if (deliveries.length === 0) return { queued: 0 };

    const result = await prisma.notificationDelivery.createMany({
      data: deliveries,
      skipDuplicates: true,
    });

    if (result.count > 0) {
      notificationDeliveryService.processQueuedDeliveries({ limit: result.count }).catch((error) => {
        logger.warn('Notification delivery processing failed', {
          runId: run.id,
          ticketId: run.ticketId,
          error: error.message,
        });
      });
    }

    return { queued: result.count, channels };
  }

  async queueNotificationsForPriorityChange(event) {
    const hydratedEvent = event?.ticket?.id ? event : await prisma.ticketPriorityEvent.findUnique({
      where: { id: event?.id },
      include: {
        ticket: {
          select: {
            id: true,
            workspaceId: true,
            freshserviceTicketId: true,
            subject: true,
            assignedTechId: true,
            assignedTech: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    const ticket = hydratedEvent?.ticket;
    const priority = hydratedEvent?.toPriorityLabel;
    const technicianId = ticket?.assignedTechId;
    if (!hydratedEvent?.id || !ticket?.id || !priority) {
      return { queued: 0, skipped: 'missing_priority_event_context' };
    }
    if (!technicianId) {
      return { queued: 0, skipped: 'no_assigned_technician' };
    }

    const preference = await prisma.technicianNotificationPreference.findUnique({
      where: { technicianId },
      include: { technician: { select: { email: true } } },
    });
    if (!preference) return { queued: 0, skipped: 'no_preferences' };

    const providerStatus = await getNotificationProviderStatus();
    const channels = NOTIFICATION_CHANNELS.filter((channel) => (
      notificationPreferenceAllows(preference, priority, channel)
      && providerStatus[channel]?.configured
    ));
    if (channels.length === 0) return { queued: 0, skipped: 'threshold_channel_or_provider_disabled' };

    const message = buildPriorityChangeNotificationMessage({ ticket, priority });
    const voiceMessage = buildPriorityChangeVoiceNotificationMessage({ ticket, priority });
    const whatsappVariables = buildWhatsAppVariables({ ticket, priority, message });
    const deliveries = channels.map((channel) => {
      const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
      const recipient = channel === 'email'
        ? preference.technician?.email || ticket.assignedTech?.email || null
        : preferredPhone(preference);
      return {
        workspaceId: hydratedEvent.workspaceId,
        technicianId,
        ticketId: ticket.id,
        pipelineRunId: null,
        priorityEventId: hydratedEvent.id,
        channel,
        status: 'queued',
        assessedPriority: priority,
        recipient,
        provider: provider.provider,
        dedupeKey: `priority-change:${hydratedEvent.id}:${ticket.id}:${technicianId}:${channel}`,
        payload: {
          message,
          voiceMessage,
          whatsappVariables,
          providerConfigured: provider.configured,
          providerMissing: provider.missing,
          freshserviceTicketId: Number(ticket.freshserviceTicketId),
          notificationType: 'freshservice_priority_change',
          priorityChange: {
            fromPriorityId: hydratedEvent.fromPriorityId,
            fromPriorityLabel: hydratedEvent.fromPriorityLabel,
            toPriorityId: hydratedEvent.toPriorityId,
            toPriorityLabel: hydratedEvent.toPriorityLabel,
            sourceUpdatedAt: hydratedEvent.sourceUpdatedAt,
          },
        },
      };
    });

    if (deliveries.length === 0) return { queued: 0 };

    const result = await prisma.notificationDelivery.createMany({
      data: deliveries,
      skipDuplicates: true,
    });

    if (result.count > 0) {
      notificationDeliveryService.processQueuedDeliveries({ limit: result.count }).catch((error) => {
        logger.warn('Priority-change notification delivery processing failed', {
          priorityEventId: hydratedEvent.id,
          ticketId: ticket.id,
          error: error.message,
        });
      });
    }

    return { queued: result.count, channels };
  }
}

export default new NotificationPreferenceService();
