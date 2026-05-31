import crypto from 'node:crypto';
import prisma from './prisma.js';
import { getNotificationProviderStatus } from './notificationProviders.js';
import notificationDeliveryService from './notificationDeliveryService.js';
import freshServiceActionService from './freshServiceActionService.js';
import {
  enrichEventContextWithNotificationPolicy,
  getNotificationWorkflowPolicy,
  getNotificationWorkflowSchedulePreview,
  isOffHoursPolicyActive,
} from './notificationWorkflowPolicyService.js';
import {
  buildPublicTicketStatusUrl,
  buildTicketEscalationUrl,
  buildTicketUrgencyUrl,
  hashPublicStatusToken,
} from './publicTicketStatusService.js';
import notificationPreferenceService from './notificationPreferenceService.js';
import {
  defaultRotationAnchorDate,
  normalizeAfterHoursContactMode,
  normalizeRotationOrder,
  resolveAfterHoursActiveContact,
} from './urgentEscalationContactService.js';
import { PRIORITY_ID_TO_LABEL } from './priorityAssessment.js';
import config from '../config/index.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const ESCALATION_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'phone_call']);
const PHONE_CHANNELS = new Set(['sms', 'whatsapp', 'phone_call']);
const DEFAULT_CONFIRMATION_BODY = [
  'Use this only when the request cannot wait until regular business hours.',
  'Ticket Pulse will mark the ticket as Urgent and notify the after-hours escalation roster.',
].join(' ');
const DEFAULT_AFTER_HOURS_RESPONSE_COPY = Object.freeze({
  businessHours:
    'Simply press the button to send an urgent message to the IT department. A representative will respond promptly, or as soon as possible.',
  afterHours:
    'In the event of an emergency outside of business hours, an urgent message will be sent to our dedicated after-hours phone, and you should expect a response within two hours during our after-hours operation.',
  lateNight:
    "If your message is received during late night hours, we'll make every effort to get back to you as soon as possible, but it might take longer than two hours.",
});
const DEFAULT_AFTER_HOURS_RESPONSE_TABLE = Object.freeze({
  columns: ['Business Hours', 'After-hours', 'Late Night'],
  rows: [
    { label: 'Monday to Friday', businessHours: '5am - 5pm PT', afterHours: '5pm - 10pm PT', lateNight: 'After 10pm PT' },
    { label: 'Weekends', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
    { label: 'Holidays', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
  ],
});
const URGENT_PRIORITY_ID = 4;
const URGENT_PRIORITY_LABEL = PRIORITY_ID_TO_LABEL[URGENT_PRIORITY_ID] || 'Urgent';

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Date) return item.toISOString();
    return item;
  }));
}

function normalizeList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
}

function normalizeIdList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  )];
}

function normalizeCooldown(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(5, Math.min(1440, parsed));
}

function normalizeOptionalId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value, max = 4000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeResponseCopy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    businessHours: cleanText(source.businessHours, 1200) || DEFAULT_AFTER_HOURS_RESPONSE_COPY.businessHours,
    afterHours: cleanText(source.afterHours, 1200) || DEFAULT_AFTER_HOURS_RESPONSE_COPY.afterHours,
    lateNight: cleanText(source.lateNight, 1200) || DEFAULT_AFTER_HOURS_RESPONSE_COPY.lateNight,
  };
}

function normalizeResponseTable(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rows = Array.isArray(source.rows) ? source.rows : DEFAULT_AFTER_HOURS_RESPONSE_TABLE.rows;
  return {
    columns: DEFAULT_AFTER_HOURS_RESPONSE_TABLE.columns,
    rows: rows.slice(0, 12).map((row, index) => ({
      label: cleanText(row?.label, 80) || DEFAULT_AFTER_HOURS_RESPONSE_TABLE.rows[index]?.label || `Row ${index + 1}`,
      businessHours: cleanText(row?.businessHours, 120) || 'N/A',
      afterHours: cleanText(row?.afterHours, 120) || 'N/A',
      lateNight: cleanText(row?.lateNight, 120) || 'N/A',
    })),
  };
}

function hashText(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function freshserviceLink(ticket) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  return fsId && host ? `https://${host}/a/tickets/${fsId}` : null;
}

function preferredPhone(preference = {}) {
  const safePreference = preference || {};
  return safePreference.phoneOverride || safePreference.entraMobilePhone || safePreference.entraPhone || null;
}

function channelLabel(channel) {
  return ({
    email: 'Email',
    sms: 'SMS',
    whatsapp: 'WhatsApp',
    phone_call: 'Voice',
  })[channel] || channel;
}

function channelEnabled(preference, channel) {
  return ({
    email: preference?.emailEnabled,
    sms: preference?.smsEnabled,
    whatsapp: preference?.whatsappEnabled,
    phone_call: preference?.phoneCallEnabled,
  })[channel] === true;
}

function channelRecipient({ technician, preference }, channel) {
  return channel === 'email' ? technician?.email || null : preferredPhone(preference);
}

function readinessForChannel({ technician, preference }, providerStatus, channel) {
  const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
  const enabled = channelEnabled(preference, channel);
  const recipient = channelRecipient({ technician, preference }, channel);
  const phoneVerified = !PHONE_CHANNELS.has(channel) || Boolean(preference?.phoneVerifiedAt);
  const hasRecipient = Boolean(recipient);
  const missing = [];
  if (!enabled) missing.push('not_enabled_by_user');
  if (!hasRecipient) missing.push(channel === 'email' ? 'missing_email' : 'missing_phone');
  if (PHONE_CHANNELS.has(channel) && !phoneVerified) missing.push('phone_not_verified');
  if (!provider.configured) missing.push(...(provider.missing?.length ? provider.missing : ['provider_not_configured']));

  return {
    channel,
    label: channelLabel(channel),
    enabled,
    configured: provider.configured === true,
    provider: provider.provider || null,
    providerMissing: provider.missing || [],
    recipient,
    phoneVerified,
    ready: enabled && hasRecipient && phoneVerified && provider.configured === true,
    reason: missing[0] || null,
    warnings: missing,
  };
}

function normalizePolicy(row = {}) {
  return {
    id: row?.id || null,
    workspaceId: row?.workspaceId || null,
    automaticEnabled: row?.automaticEnabled === true,
    selfServiceEnabled: row?.selfServiceEnabled === true,
    businessUrgencyEnabled: row?.businessUrgencyEnabled !== false,
    businessUrgencyNotifyAssigned: true,
    businessUrgencyNotifySupervisors: row?.businessUrgencyNotifySupervisors === true,
    cooldownMinutes: normalizeCooldown(row?.cooldownMinutes ?? 60),
    confirmationTitle: cleanText(row?.confirmationTitle, 160) || 'Request urgent after-hours assistance',
    confirmationBody: cleanText(row?.confirmationBody) || DEFAULT_CONFIRMATION_BODY,
    afterHoursResponseCopy: normalizeResponseCopy(row?.afterHoursResponseCopy),
    afterHoursResponseTable: normalizeResponseTable(row?.afterHoursResponseTable),
    afterHoursContactMode: normalizeAfterHoursContactMode(row?.afterHoursContactMode),
    afterHoursManualTechnicianId: normalizeOptionalId(row?.afterHoursManualTechnicianId),
    afterHoursRotationOrder: normalizeRotationOrder(row?.afterHoursRotationOrder),
    afterHoursRotationAnchorDate: row?.afterHoursRotationAnchorDate?.toISOString?.() || row?.afterHoursRotationAnchorDate || null,
    showAfterHoursPhoneInEmail: row?.showAfterHoursPhoneInEmail !== false,
    legacyChannels: normalizeList(row?.legacyChannels).filter((channel) => ESCALATION_CHANNELS.includes(channel)),
    legacyEmails: normalizeList(row?.legacyEmails),
    legacyPhones: normalizeList(row?.legacyPhones),
    updatedBy: row?.updatedBy || null,
    createdAt: row?.createdAt?.toISOString?.() || row?.createdAt || null,
    updatedAt: row?.updatedAt?.toISOString?.() || row?.updatedAt || null,
    baseRecipientIds: normalizeIdList(
      row?.recipients?.filter((recipient) => recipient.scope === 'base').map((recipient) => recipient.technicianId),
    ),
    selfExtraRecipientIds: normalizeIdList(
      row?.recipients?.filter((recipient) => recipient.scope === 'self_extra').map((recipient) => recipient.technicianId),
    ),
    businessSupervisorRecipientIds: normalizeIdList(
      row?.recipients?.filter((recipient) => recipient.scope === 'business_supervisor').map((recipient) => recipient.technicianId),
    ),
  };
}

function buildEscalationMessage({ ticket, priority, source }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const link = freshserviceLink(ticket);
  const prefix = source === 'self_service'
    ? 'Ticket Pulse urgent self-escalation:'
    : source === 'business_urgency'
      ? 'Ticket Pulse requester priority raise:'
      : 'Ticket Pulse after-hours escalation:';
  return [
    prefix,
    fsId ? `ticket #${fsId}` : 'a ticket',
    source === 'self_service'
      ? 'was escalated by the requester for immediate after-hours assistance.'
      : source === 'business_urgency'
        ? 'was marked urgent by the requester from the public ticket page.'
        : `was assessed as ${priority}.`,
    'Priority is Urgent.',
    link ? `Open: ${link}` : null,
  ].filter(Boolean).join(' ');
}

function buildVoiceMessage({ ticket, source }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  return [
    'Ticket Pulse urgent escalation.',
    fsId ? `Ticket number ${fsId}` : 'A ticket',
    source === 'self_service'
      ? 'was escalated by the requester after hours.'
      : source === 'business_urgency'
        ? 'was marked urgent by the requester.'
        : 'was automatically assessed as urgent after hours.',
  ].filter(Boolean).join(' ');
}

function buildWhatsAppVariables({ ticket, priority, message }) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  return {
    message,
    priority: priority || '',
    ticketId: fsId ? String(fsId) : '',
    link: freshserviceLink(ticket) || '',
  };
}

function isTerminalTicket(ticket) {
  const status = String(ticket?.status || '').toLowerCase();
  return status.includes('closed') || status.includes('resolved') || status.includes('deleted');
}

function isUrgentTicket(ticket) {
  return Number(ticket?.assessedPriorityId) === URGENT_PRIORITY_ID
    || Number(ticket?.priority) === URGENT_PRIORITY_ID
    || String(ticket?.assessedPriority || '').toLowerCase() === 'urgent';
}

function isPublicActionAfterHours(policyContext) {
  const availability = policyContext?.availability || {};
  if (availability.isAfterHours === true || availability.isHoliday === true) return true;
  if (availability.isBusinessHours === true) return false;
  return isOffHoursPolicyActive(policyContext, policyContext?.notificationPolicy);
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
          status: true,
          priority: true,
          assessedPriority: true,
          assessedPriorityId: true,
          priorityRationale: true,
        },
      },
    },
  });
}

async function validateTechnicians(workspaceId, ids) {
  if (!ids.length) return [];
  const rows = await prisma.technician.findMany({
    where: {
      id: { in: ids },
      workspaceId,
    },
    select: { id: true },
  });
  const valid = new Set(rows.map((row) => row.id));
  const invalid = ids.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new ValidationError('One or more selected users are not in the current workspace', { invalid });
  }
  return ids;
}

function publicPriorityEventDedupeKey(event, fromPriorityId) {
  return `public-urgency:${event.id}:${event.ticketId}:${fromPriorityId || 'none'}:${URGENT_PRIORITY_ID}`.slice(0, 255);
}

async function getPublicLinkByToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new NotFoundError('Escalation link not found');
  const link = await prisma.publicTicketStatusLink.findUnique({
    where: { tokenHash: hashPublicStatusToken(trimmed) },
    include: {
      ticket: {
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
            select: { name: true, email: true },
          },
          assignedTech: {
            select: { id: true, name: true, email: true, photoUrl: true },
          },
        },
      },
    },
  });
  if (!link) throw new NotFoundError('Escalation link not found');
  if (!link.enabled || link.revokedAt) throw new AuthorizationError('This escalation link has been revoked');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    throw new AuthorizationError('This escalation link has expired');
  }
  if (!link.ticket) throw new NotFoundError('Ticket not found');
  return { token: trimmed, link };
}

function publicBranding(settings, workspace) {
  return {
    brandName: settings?.brandName || workspace?.name || 'Ticket Pulse',
    logoDataUrl: settings?.logoDataUrl || null,
    logoAltText: settings?.logoAltText || settings?.brandName || workspace?.name || 'Ticket Pulse',
    trademarkText: settings?.trademarkText || null,
    accentColor: settings?.accentColor || '#2563eb',
  };
}

class AfterHoursUrgentEscalationService {
  async getPolicy(workspaceId) {
    const row = await prisma.urgentEscalationPolicy.upsert({
      where: { workspaceId },
      update: {},
      create: { workspaceId },
      include: { recipients: true },
    });
    return normalizePolicy(row);
  }

  async getPolicyWithDependencies(workspaceId) {
    const [policy, assignmentConfig, routingPolicy, routingPreview, activeContact] = await Promise.all([
      this.getPolicy(workspaceId),
      prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: {
          priorityAssessmentAfterHoursEnabled: true,
        },
      }),
      getNotificationWorkflowPolicy(workspaceId),
      getNotificationWorkflowSchedulePreview(workspaceId).catch((error) => ({
        error: error.message,
      })),
      resolveAfterHoursActiveContact(workspaceId).catch((error) => ({
        technicianId: null,
        name: null,
        email: null,
        photoUrl: null,
        phone: null,
        rotationLabel: 'Unable to resolve current contact',
        source: 'error',
        phoneVerified: false,
        warnings: [error.message],
      })),
    ]);

    return {
      ...policy,
      afterHoursActiveContact: activeContact,
      dependencies: {
        afterHoursPriorityAssessmentEnabled: assignmentConfig?.priorityAssessmentAfterHoursEnabled === true,
        afterHoursWorkflowRoutingEnabled: routingPolicy.afterHoursEnabled === true,
        holidaysIncluded: routingPolicy.holidaysEnabled === true,
        routingPreview,
      },
    };
  }

  async updatePolicy(workspaceId, input = {}, actor = null) {
    const current = await this.getPolicy(workspaceId);
    const requestedContactMode = normalizeAfterHoursContactMode(input.afterHoursContactMode ?? current.afterHoursContactMode);
    const requestedManualContactId = normalizeOptionalId(input.afterHoursManualTechnicianId ?? current.afterHoursManualTechnicianId);
    const requestedRotationOrder = normalizeRotationOrder(input.afterHoursRotationOrder ?? current.afterHoursRotationOrder);
    const baseRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList([
        ...normalizeIdList(input.baseRecipientIds ?? current.baseRecipientIds),
        ...(requestedManualContactId ? [requestedManualContactId] : []),
        ...requestedRotationOrder,
      ]),
    );
    const selfExtraRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList(input.selfExtraRecipientIds ?? current.selfExtraRecipientIds),
    );
    const businessSupervisorRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList(input.businessSupervisorRecipientIds ?? current.businessSupervisorRecipientIds),
    );
    const baseSet = new Set(baseRecipientIds);
    const afterHoursManualTechnicianId = requestedManualContactId && baseSet.has(requestedManualContactId)
      ? requestedManualContactId
      : null;
    const afterHoursRotationOrder = requestedRotationOrder.filter((id) => baseSet.has(id));
    const rotationAnchor = normalizeDate(
      input.afterHoursRotationAnchorDate
      ?? current.afterHoursRotationAnchorDate
      ?? defaultRotationAnchorDate('America/Los_Angeles'),
    ) || defaultRotationAnchorDate('America/Los_Angeles');

    const actorEmail = String(actor?.email || actor?.username || '').trim() || null;
    const data = {
      automaticEnabled: input.automaticEnabled !== undefined ? !!input.automaticEnabled : current.automaticEnabled,
      selfServiceEnabled: input.selfServiceEnabled !== undefined ? !!input.selfServiceEnabled : current.selfServiceEnabled,
      businessUrgencyEnabled: input.businessUrgencyEnabled !== undefined ? !!input.businessUrgencyEnabled : current.businessUrgencyEnabled,
      businessUrgencyNotifyAssigned: true,
      businessUrgencyNotifySupervisors: input.businessUrgencyNotifySupervisors !== undefined ? !!input.businessUrgencyNotifySupervisors : current.businessUrgencyNotifySupervisors,
      cooldownMinutes: normalizeCooldown(input.cooldownMinutes ?? current.cooldownMinutes),
      confirmationTitle: cleanText(input.confirmationTitle, 160) || current.confirmationTitle,
      confirmationBody: cleanText(input.confirmationBody) || current.confirmationBody,
      afterHoursResponseCopy: safeJson(normalizeResponseCopy(input.afterHoursResponseCopy ?? current.afterHoursResponseCopy)),
      afterHoursResponseTable: safeJson(normalizeResponseTable(input.afterHoursResponseTable ?? current.afterHoursResponseTable)),
      afterHoursContactMode: requestedContactMode,
      afterHoursManualTechnicianId,
      afterHoursRotationOrder,
      afterHoursRotationAnchorDate: rotationAnchor,
      showAfterHoursPhoneInEmail: input.showAfterHoursPhoneInEmail !== undefined
        ? !!input.showAfterHoursPhoneInEmail
        : current.showAfterHoursPhoneInEmail !== false,
      updatedBy: actorEmail,
    };

    if (input.clearLegacy === true) {
      data.legacyChannels = [];
      data.legacyEmails = [];
      data.legacyPhones = [];
    }

    const row = await prisma.$transaction(async (tx) => {
      const policy = await tx.urgentEscalationPolicy.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          ...data,
        },
        update: data,
      });

      await tx.urgentEscalationRecipient.deleteMany({
        where: { workspaceId, policyId: policy.id },
      });

      const recipientRows = [
        ...baseRecipientIds.map((technicianId) => ({
          workspaceId,
          policyId: policy.id,
          technicianId,
          scope: 'base',
        })),
        ...selfExtraRecipientIds.map((technicianId) => ({
          workspaceId,
          policyId: policy.id,
          technicianId,
          scope: 'self_extra',
        })),
        ...businessSupervisorRecipientIds.map((technicianId) => ({
          workspaceId,
          policyId: policy.id,
          technicianId,
          scope: 'business_supervisor',
        })),
      ];

      if (recipientRows.length > 0) {
        await tx.urgentEscalationRecipient.createMany({
          data: recipientRows,
          skipDuplicates: true,
        });
      }

      if (input.automaticEnabled !== undefined) {
        await tx.assignmentConfig.upsert({
          where: { workspaceId },
          create: {
            workspaceId,
            priorityAssessmentAfterHoursEnabled: data.automaticEnabled,
          },
          update: {
            priorityAssessmentAfterHoursEnabled: data.automaticEnabled,
          },
        });
      }

      return tx.urgentEscalationPolicy.findUnique({
        where: { id: policy.id },
        include: { recipients: true },
      });
    });

    return this.getPolicyWithDependencies(row.workspaceId);
  }

  async listCandidates(workspaceId) {
    const [providerStatus, policy, technicians] = await Promise.all([
      getNotificationProviderStatus(),
      this.getPolicy(workspaceId),
      prisma.technician.findMany({
        where: { workspaceId },
        include: {
          notificationPreference: true,
        },
        orderBy: [
          { isActive: 'desc' },
          { name: 'asc' },
        ],
      }),
    ]);

    const selectedBase = new Set(policy.baseRecipientIds);
    const selectedSelfExtra = new Set(policy.selfExtraRecipientIds);
    const selectedBusinessSupervisor = new Set(policy.businessSupervisorRecipientIds);

    return {
      providerStatus,
      candidates: technicians.map((technician) => {
        const context = { technician, preference: technician.notificationPreference || null };
        const channels = Object.fromEntries(
          ESCALATION_CHANNELS.map((channel) => [channel, readinessForChannel(context, providerStatus, channel)]),
        );
        return {
          id: technician.id,
          name: technician.name,
          email: technician.email,
          photoUrl: technician.photoUrl,
          isActive: technician.isActive,
          selectedBase: selectedBase.has(technician.id),
          selectedSelfExtra: selectedSelfExtra.has(technician.id),
          selectedBusinessSupervisor: selectedBusinessSupervisor.has(technician.id),
          hasPreferences: Boolean(technician.notificationPreference),
          channels,
          readyChannelCount: Object.values(channels).filter((channel) => channel.ready).length,
        };
      }),
    };
  }

  async _selectedRecipientRows({ workspaceId, source }) {
    const scopes = source === 'self_service'
      ? ['base', 'self_extra']
      : source === 'business_urgency'
        ? ['business_supervisor']
        : ['base'];
    const rows = await prisma.urgentEscalationRecipient.findMany({
      where: { workspaceId, scope: { in: scopes } },
      include: {
        technician: {
          include: {
            notificationPreference: true,
          },
        },
      },
    });

    const byTech = new Map();
    for (const row of rows) {
      if (!byTech.has(row.technicianId)) {
        byTech.set(row.technicianId, row);
      }
    }
    return [...byTech.values()];
  }

  async _queueDeliveries({
    event,
    policy,
    ticket,
    source,
    pipelineRunId = null,
    includeLegacy = true,
  }) {
    const providerStatus = await getNotificationProviderStatus();
    const selectedRows = await this._selectedRecipientRows({
      workspaceId: event.workspaceId,
      source,
    });
    const message = buildEscalationMessage({ ticket, priority: URGENT_PRIORITY_LABEL, source });
    const voiceMessage = buildVoiceMessage({ ticket, source });
    const whatsappVariables = buildWhatsAppVariables({ ticket, priority: URGENT_PRIORITY_LABEL, message });
    const deliveries = [];
    const skipped = [];
    const queuedChannels = new Set();
    const recipientKeys = new Set();

    for (const row of selectedRows) {
      const context = {
        technician: row.technician,
        preference: row.technician.notificationPreference || null,
      };
      for (const channel of ESCALATION_CHANNELS) {
        const readiness = readinessForChannel(context, providerStatus, channel);
        if (!readiness.ready) {
          skipped.push({
            technicianId: row.technicianId,
            technicianName: row.technician.name,
            channel,
            reason: readiness.reason,
            warnings: readiness.warnings,
          });
          continue;
        }
        const recipientKey = `${channel}:${readiness.recipient}`;
        if (recipientKeys.has(recipientKey)) continue;
        recipientKeys.add(recipientKey);
        queuedChannels.add(channel);
        deliveries.push({
          workspaceId: event.workspaceId,
          technicianId: row.technicianId,
          ticketId: ticket.id,
          pipelineRunId,
          urgentEscalationEventId: event.id,
          channel,
          status: 'queued',
          assessedPriority: URGENT_PRIORITY_LABEL,
          notificationType: source === 'self_service'
            ? 'urgent_self_escalation'
            : source === 'business_urgency'
              ? 'ticket_pulse_public_priority_raise_supervisor'
              : 'after_hours_urgent_escalation',
          eventType: source,
          recipient: readiness.recipient,
          provider: readiness.provider,
          dedupeKey: `urgent-escalation:${event.id}:${ticket.id}:${row.technicianId}:${channel}`,
          payload: {
            message,
            voiceMessage,
            whatsappVariables,
            providerConfigured: readiness.configured,
            providerMissing: readiness.providerMissing,
            freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
            escalationType: source,
            urgentEscalationEventId: event.id,
          },
        });
      }
    }

    const legacyDeliveries = includeLegacy ? this._legacyDeliveries({
      event,
      policy,
      ticket,
      source,
      pipelineRunId,
      providerStatus,
      message,
      voiceMessage,
      whatsappVariables,
      recipientKeys,
    }) : { deliveries: [], skipped: [] };
    deliveries.push(...legacyDeliveries.deliveries);
    skipped.push(...legacyDeliveries.skipped);
    legacyDeliveries.deliveries.forEach((delivery) => queuedChannels.add(delivery.channel));

    let count = 0;
    if (deliveries.length > 0) {
      const result = await prisma.notificationDelivery.createMany({
        data: deliveries,
        skipDuplicates: true,
      });
      count = result.count;
      if (count > 0) {
        notificationDeliveryService.processQueuedDeliveries({ limit: count }).catch((error) => {
          logger.warn('Urgent escalation delivery processing failed', {
            eventId: event.id,
            ticketId: ticket.id,
            source,
            error: error.message,
          });
        });
      }
    }

    const summary = {
      queued: count,
      channels: [...queuedChannels],
      skipped,
      selectedRecipients: selectedRows.length,
      legacyQueued: legacyDeliveries.deliveries.length,
    };

    await prisma.urgentEscalationEvent.update({
      where: { id: event.id },
      data: {
        notificationSummary: safeJson(summary),
      },
    });

    return summary;
  }

  _legacyDeliveries({
    event,
    policy,
    ticket,
    source,
    pipelineRunId,
    providerStatus,
    message,
    voiceMessage,
    whatsappVariables,
    recipientKeys,
  }) {
    const deliveries = [];
    const skipped = [];
    const channels = normalizeList(policy.legacyChannels).filter((channel) => ESCALATION_CHANNELS.includes(channel));
    const emails = normalizeList(policy.legacyEmails);
    const phones = normalizeList(policy.legacyPhones);

    for (const channel of channels) {
      const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
      const recipients = channel === 'email' ? emails : phones;
      if (!provider.configured) {
        skipped.push({ legacy: true, channel, reason: 'provider_not_configured', warnings: provider.missing || [] });
        continue;
      }
      for (const recipient of recipients) {
        const recipientKey = `${channel}:${recipient}`;
        if (!recipient || recipientKeys.has(recipientKey)) continue;
        recipientKeys.add(recipientKey);
        deliveries.push({
          workspaceId: event.workspaceId,
          technicianId: null,
          ticketId: ticket.id,
          pipelineRunId,
          urgentEscalationEventId: event.id,
          channel,
          status: 'queued',
          assessedPriority: URGENT_PRIORITY_LABEL,
          notificationType: source === 'self_service'
            ? 'urgent_self_escalation_legacy'
            : 'after_hours_urgent_escalation_legacy',
          eventType: source,
          recipient,
          provider: provider.provider,
          dedupeKey: `urgent-escalation:${event.id}:${ticket.id}:legacy:${channel}:${hashText(recipient).slice(0, 16)}`,
          payload: {
            message,
            voiceMessage,
            whatsappVariables,
            providerConfigured: provider.configured,
            providerMissing: provider.missing,
            freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
            escalationType: source,
            legacyRecipient: true,
            urgentEscalationEventId: event.id,
          },
        });
      }
    }

    return { deliveries, skipped };
  }

  async queueForPriorityRun(run) {
    const hydratedRun = await hydrateRun(run);
    const ticket = hydratedRun?.ticket;
    const priority = hydratedRun?.recommendation?.assessedPriority || ticket?.assessedPriority;

    if (!hydratedRun?.id || !ticket?.id || priority !== URGENT_PRIORITY_LABEL) {
      return { queued: 0, skipped: 'not_urgent' };
    }

    const policy = await this.getPolicy(hydratedRun.workspaceId);
    if (!policy.automaticEnabled) {
      return { queued: 0, skipped: 'disabled' };
    }

    const event = await prisma.urgentEscalationEvent.create({
      data: {
        workspaceId: hydratedRun.workspaceId,
        policyId: policy.id,
        ticketId: ticket.id,
        pipelineRunId: hydratedRun.id,
        source: 'automatic',
        status: 'running',
        triggeredBy: 'priority_assessment_after_hours',
        payload: safeJson({
          priority,
          runId: hydratedRun.id,
          rationale: ticket.priorityRationale,
        }),
      },
    });

    const notificationSummary = await this._queueDeliveries({
      event,
      policy,
      ticket,
      source: 'automatic',
      pipelineRunId: hydratedRun.id,
    });

    await prisma.urgentEscalationEvent.update({
      where: { id: event.id },
      data: {
        status: notificationSummary.queued > 0 ? 'completed' : 'no_recipients',
      },
    });

    return {
      eventId: event.id,
      queued: notificationSummary.queued,
      channels: notificationSummary.channels,
      skipped: notificationSummary.queued > 0 ? undefined : 'no_ready_recipient',
      notificationSummary,
    };
  }

  async _selfEscalationState(token, requestMeta = {}) {
    const { token: trimmedToken, link } = await getPublicLinkByToken(token);
    const ticket = link.ticket;
    const workspaceId = link.workspaceId;
    const [policy, publicSettings] = await Promise.all([
      this.getPolicy(workspaceId),
      prisma.publicTicketStatusSettings.findUnique({ where: { workspaceId } }),
    ]);

    const baseContext = {
      workspace: {
        id: workspaceId,
        name: ticket.workspace?.name,
        timezone: ticket.workspace?.defaultTimezone || 'America/Los_Angeles',
      },
      ticket: {
        id: ticket.id,
        workspaceId,
        createdAt: new Date().toISOString(),
      },
      event: {
        type: 'ticket.created',
        occurredAt: new Date().toISOString(),
      },
    };
    const policyContext = await enrichEventContextWithNotificationPolicy(baseContext);
    const offHoursActive = isPublicActionAfterHours(policyContext);
    const lastEvent = await prisma.urgentEscalationEvent.findFirst({
      where: {
        ticketId: ticket.id,
        workspaceId,
        source: 'self_service',
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const cooldownUntil = lastEvent?.cooldownUntil ? new Date(lastEvent.cooldownUntil) : null;
    const cooldownActive = Boolean(cooldownUntil && cooldownUntil.getTime() > now.getTime());
    const alreadyEscalated = isUrgentTicket(ticket) || lastEvent?.status === 'completed';
    const terminal = isTerminalTicket(ticket);
    const reasons = [];
    if (!policy.selfServiceEnabled) reasons.push('self_service_disabled');
    if (!offHoursActive) reasons.push('not_after_hours');
    if (terminal) reasons.push('ticket_closed_or_resolved');
    if (cooldownActive) reasons.push('cooldown_active');
    if (alreadyEscalated) reasons.push('already_escalated');

    return {
      token: trimmedToken,
      link,
      ticket,
      policy,
      policyContext,
      publicSettings,
      requestMeta,
      offHoursActive,
      cooldownUntil,
      cooldownActive,
      alreadyEscalated,
      terminal,
      reasons,
      available: reasons.length === 0,
    };
  }

  _publicSelfEscalationResponse(state, status = null) {
    const ticket = state.ticket;
    const workspace = ticket.workspace;
    return {
      status: status || (state.available ? 'available' : 'unavailable'),
      available: state.available,
      reasons: state.reasons,
      alreadyEscalated: state.alreadyEscalated,
      cooldownUntil: state.cooldownUntil?.toISOString?.() || null,
      afterHours: {
        active: state.offHoursActive,
        availability: state.policyContext.availability || null,
        support: state.policyContext.afterHoursSupport || null,
        activeContact: state.policyContext.afterHoursSupport?.activeContact || null,
        responseCopy: state.policy.afterHoursResponseCopy,
        responseTable: state.policy.afterHoursResponseTable,
      },
      confirmation: {
        title: state.policy.confirmationTitle,
        body: state.policy.confirmationBody,
      },
      ticket: {
        id: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
        subject: ticket.subject || 'Ticket',
        status: ticket.status,
        priority: ticket.assessedPriority || PRIORITY_ID_TO_LABEL[Number(ticket.priority)] || String(ticket.priority || ''),
        assignedAgent: ticket.assignedTech ? {
          name: ticket.assignedTech.name,
          photoUrl: ticket.assignedTech.photoUrl || null,
        } : null,
        requesterName: ticket.requester?.name || null,
        publicStatusUrl: buildPublicTicketStatusUrl(state.token),
        raiseUrgencyUrl: buildTicketUrgencyUrl(state.token),
      },
      workspace: {
        id: workspace?.id || state.link.workspaceId,
        name: workspace?.name || 'Ticket Pulse',
        timezone: workspace?.defaultTimezone || 'America/Los_Angeles',
      },
      branding: publicBranding(state.publicSettings, workspace),
      refreshedAt: new Date().toISOString(),
    };
  }

  async getPublicSelfEscalation(token, requestMeta = {}) {
    const state = await this._selfEscalationState(token, requestMeta);
    return this._publicSelfEscalationResponse(state);
  }

  async submitPublicSelfEscalation(token, requestMeta = {}) {
    const state = await this._selfEscalationState(token, requestMeta);
    if (state.terminal) {
      return this._publicSelfEscalationResponse(state, 'unavailable');
    }
    if (state.alreadyEscalated) {
      return this._publicSelfEscalationResponse(state, 'already_escalated');
    }
    if (state.cooldownActive) {
      return this._publicSelfEscalationResponse(state, 'cooldown');
    }
    if (!state.available) {
      return this._publicSelfEscalationResponse(state, 'unavailable');
    }

    const cooldownUntil = new Date(Date.now() + state.policy.cooldownMinutes * 60 * 1000);
    const event = await prisma.urgentEscalationEvent.create({
      data: {
        workspaceId: state.link.workspaceId,
        policyId: state.policy.id,
        ticketId: state.ticket.id,
        publicStatusLinkId: state.link.id,
        source: 'self_service',
        status: 'running',
        triggeredBy: 'requester_public_link',
        ipHash: hashText(requestMeta.ip || ''),
        userAgent: String(requestMeta.userAgent || '').slice(0, 500) || null,
        cooldownUntil,
        payload: safeJson({
          publicStatusTokenPrefix: state.link.tokenPrefix || state.token.slice(0, 10),
          afterHours: state.policyContext.availability,
        }),
      },
    });

    await prisma.ticket.update({
      where: { id: state.ticket.id },
      data: {
        assessedPriority: URGENT_PRIORITY_LABEL,
        assessedPriorityId: URGENT_PRIORITY_ID,
        priority: URGENT_PRIORITY_ID,
        priorityRationale: 'Requester requested urgent after-hours assistance through the public escalation link.',
        priorityConfidence: 'requester',
        priorityAssessedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const writeback = await freshServiceActionService.executeDirectPriorityWriteback({
      workspaceId: state.link.workspaceId,
      ticketId: state.ticket.id,
      priorityId: URGENT_PRIORITY_ID,
      priorityLabel: URGENT_PRIORITY_LABEL,
      source: 'urgent-self-escalation',
    });

    const notificationSummary = await this._queueDeliveries({
      event,
      policy: state.policy,
      ticket: {
        ...state.ticket,
        assessedPriority: URGENT_PRIORITY_LABEL,
        assessedPriorityId: URGENT_PRIORITY_ID,
        priority: URGENT_PRIORITY_ID,
      },
      source: 'self_service',
      pipelineRunId: null,
    });

    const status = writeback.success
      ? (notificationSummary.queued > 0 ? 'completed' : 'no_recipients')
      : (notificationSummary.queued > 0 ? 'completed_with_writeback_error' : 'failed');
    await prisma.urgentEscalationEvent.update({
      where: { id: event.id },
      data: {
        status,
        priorityWritebackStatus: writeback.success
          ? (writeback.skipped ? 'skipped' : 'synced')
          : 'failed',
        priorityWritebackError: writeback.success ? null : writeback.error || 'FreshService priority writeback failed',
        notificationSummary: safeJson(notificationSummary),
      },
    });

    const refreshed = await this._selfEscalationState(token, requestMeta);
    return {
      ...this._publicSelfEscalationResponse(refreshed, 'submitted'),
      eventId: event.id,
      writeback: {
        success: writeback.success === true,
        skipped: writeback.skipped === true,
        error: writeback.error || null,
      },
      notificationSummary,
    };
  }

  async _businessUrgencyState(token, requestMeta = {}) {
    const { token: trimmedToken, link } = await getPublicLinkByToken(token);
    const ticket = link.ticket;
    const workspaceId = link.workspaceId;
    const [policy, publicSettings] = await Promise.all([
      this.getPolicy(workspaceId),
      prisma.publicTicketStatusSettings.findUnique({ where: { workspaceId } }),
    ]);

    const baseContext = {
      workspace: {
        id: workspaceId,
        name: ticket.workspace?.name,
        timezone: ticket.workspace?.defaultTimezone || 'America/Los_Angeles',
      },
      ticket: {
        id: ticket.id,
        workspaceId,
        createdAt: new Date().toISOString(),
      },
      event: {
        type: 'ticket.created',
        occurredAt: new Date().toISOString(),
      },
    };
    const policyContext = await enrichEventContextWithNotificationPolicy(baseContext);
    const offHoursActive = isPublicActionAfterHours(policyContext);
    const lastEvent = await prisma.urgentEscalationEvent.findFirst({
      where: {
        ticketId: ticket.id,
        workspaceId,
        source: 'business_urgency',
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const cooldownUntil = lastEvent?.cooldownUntil ? new Date(lastEvent.cooldownUntil) : null;
    const cooldownActive = Boolean(cooldownUntil && cooldownUntil.getTime() > now.getTime());
    const alreadyUrgent = isUrgentTicket(ticket) || lastEvent?.status === 'completed';
    const terminal = isTerminalTicket(ticket);
    const reasons = [];
    if (!policy.businessUrgencyEnabled) reasons.push('business_urgency_disabled');
    if (offHoursActive) reasons.push('after_hours_use_immediate_support');
    if (terminal) reasons.push('ticket_closed_or_resolved');
    if (cooldownActive) reasons.push('cooldown_active');
    if (alreadyUrgent) reasons.push('already_urgent');

    return {
      token: trimmedToken,
      link,
      ticket,
      policy,
      policyContext,
      publicSettings,
      requestMeta,
      offHoursActive,
      cooldownUntil,
      cooldownActive,
      alreadyUrgent,
      terminal,
      reasons,
      available: reasons.length === 0,
    };
  }

  _publicBusinessUrgencyResponse(state, status = null, extras = {}) {
    const ticket = state.ticket;
    const workspace = ticket.workspace;
    return {
      status: status || (state.available ? 'available' : 'unavailable'),
      available: state.available,
      reasons: state.reasons,
      alreadyUrgent: state.alreadyUrgent,
      cooldownUntil: state.cooldownUntil?.toISOString?.() || null,
      businessHours: {
        active: !state.offHoursActive,
        availability: state.policyContext.availability || null,
      },
      afterHours: {
        active: state.offHoursActive,
        immediateSupportUrl: state.policy.selfServiceEnabled ? buildTicketEscalationUrl(state.token) : null,
        activeContact: state.policyContext.afterHoursSupport?.activeContact || null,
        responseCopy: state.policy.afterHoursResponseCopy,
        responseTable: state.policy.afterHoursResponseTable,
      },
      confirmation: {
        title: 'Raise this ticket to urgent',
        body: 'Use this when the ticket needs priority attention during business hours. Ticket Pulse will mark the ticket Urgent and notify the currently assigned agent if their notification preferences allow it.',
      },
      ticket: {
        id: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
        subject: ticket.subject || 'Ticket',
        status: ticket.status,
        priority: ticket.assessedPriority || PRIORITY_ID_TO_LABEL[Number(ticket.priority)] || String(ticket.priority || ''),
        assignedAgent: ticket.assignedTech ? {
          name: ticket.assignedTech.name,
          photoUrl: ticket.assignedTech.photoUrl || null,
        } : null,
        requesterName: ticket.requester?.name || null,
        publicStatusUrl: buildPublicTicketStatusUrl(state.token),
        afterHoursEscalationUrl: state.policy.selfServiceEnabled ? buildTicketEscalationUrl(state.token) : null,
      },
      workspace: {
        id: workspace?.id || state.link.workspaceId,
        name: workspace?.name || 'Ticket Pulse',
        timezone: workspace?.defaultTimezone || 'America/Los_Angeles',
      },
      branding: publicBranding(state.publicSettings, workspace),
      refreshedAt: new Date().toISOString(),
      ...extras,
    };
  }

  async getPublicBusinessUrgency(token, requestMeta = {}) {
    const state = await this._businessUrgencyState(token, requestMeta);
    return this._publicBusinessUrgencyResponse(state);
  }

  async _queueAssignedAgentForBusinessUrgency({ event, ticket, fromPriorityId }) {
    if (!ticket.assignedTechId) {
      return { queued: 0, skipped: 'no_assigned_technician' };
    }
    const fromId = Number(fromPriorityId || 0) || null;
    let priorityEvent;
    try {
      priorityEvent = await prisma.ticketPriorityEvent.create({
        data: {
          workspaceId: event.workspaceId,
          ticketId: ticket.id,
          eventType: 'ticket_pulse_priority_raise',
          source: 'public_urgency_raise',
          fromPriorityId: fromId,
          fromPriorityLabel: fromId ? PRIORITY_ID_TO_LABEL[fromId] || `P${fromId}` : null,
          toPriorityId: URGENT_PRIORITY_ID,
          toPriorityLabel: URGENT_PRIORITY_LABEL,
          direction: fromId && URGENT_PRIORITY_ID <= fromId ? 'changed' : 'raised',
          sourceUpdatedAt: event.createdAt || new Date(),
          dedupeKey: publicPriorityEventDedupeKey(event, fromId),
        },
      });
    } catch (error) {
      if (error.code === 'P2002') {
        priorityEvent = await prisma.ticketPriorityEvent.findUnique({
          where: { dedupeKey: publicPriorityEventDedupeKey(event, fromId) },
        });
      } else {
        throw error;
      }
    }

    if (!priorityEvent) return { queued: 0, skipped: 'priority_event_not_available' };

    try {
      const notificationResult = await notificationPreferenceService.queueNotificationsForPriorityChange({
        ...priorityEvent,
        ticket,
      });
      await prisma.ticketPriorityEvent.update({
        where: { id: priorityEvent.id },
        data: {
          status: 'processed',
          skipReason: notificationResult.skipped || null,
          notificationSummary: safeJson({
            notificationStatus: notificationResult.queued > 0 ? 'queued' : 'skipped',
            publicUrgencyEventId: event.id,
            ...notificationResult,
          }),
        },
      });
      return {
        priorityEventId: priorityEvent.id,
        ...notificationResult,
      };
    } catch (error) {
      await prisma.ticketPriorityEvent.update({
        where: { id: priorityEvent.id },
        data: {
          status: 'failed',
          skipReason: error.message,
          notificationSummary: safeJson({
            notificationStatus: 'failed',
            publicUrgencyEventId: event.id,
            error: error.message,
          }),
        },
      });
      throw error;
    }
  }

  async submitPublicBusinessUrgency(token, requestMeta = {}) {
    const state = await this._businessUrgencyState(token, requestMeta);
    if (state.terminal) {
      return this._publicBusinessUrgencyResponse(state, 'unavailable');
    }
    if (state.alreadyUrgent) {
      return this._publicBusinessUrgencyResponse(state, 'already_urgent');
    }
    if (state.cooldownActive) {
      return this._publicBusinessUrgencyResponse(state, 'cooldown');
    }
    if (!state.available) {
      return this._publicBusinessUrgencyResponse(state, 'unavailable');
    }

    const fromPriorityId = Number(state.ticket.assessedPriorityId || state.ticket.priority || 0) || null;
    const cooldownUntil = new Date(Date.now() + state.policy.cooldownMinutes * 60 * 1000);
    const event = await prisma.urgentEscalationEvent.create({
      data: {
        workspaceId: state.link.workspaceId,
        policyId: state.policy.id,
        ticketId: state.ticket.id,
        publicStatusLinkId: state.link.id,
        source: 'business_urgency',
        status: 'running',
        triggeredBy: 'requester_public_priority_raise',
        ipHash: hashText(requestMeta.ip || ''),
        userAgent: String(requestMeta.userAgent || '').slice(0, 500) || null,
        cooldownUntil,
        payload: safeJson({
          publicStatusTokenPrefix: state.link.tokenPrefix || state.token.slice(0, 10),
          businessHours: state.policyContext.availability,
          assignedAgentPriorityAlerts: 'system_priority_preferences',
          notifySupervisors: state.policy.businessUrgencyNotifySupervisors,
        }),
      },
    });

    const updatedTicket = await prisma.ticket.update({
      where: { id: state.ticket.id },
      data: {
        assessedPriority: URGENT_PRIORITY_LABEL,
        assessedPriorityId: URGENT_PRIORITY_ID,
        priority: URGENT_PRIORITY_ID,
        priorityRationale: 'Requester raised the ticket to urgent through the public ticket urgency link.',
        priorityConfidence: 'requester',
        priorityAssessedAt: new Date(),
        updatedAt: new Date(),
      },
      select: {
        id: true,
        workspaceId: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        priority: true,
        assessedPriority: true,
        assessedPriorityId: true,
        assignedTechId: true,
        assignedTech: { select: { id: true, name: true, email: true } },
      },
    });

    const writeback = await freshServiceActionService.executeDirectPriorityWriteback({
      workspaceId: state.link.workspaceId,
      ticketId: state.ticket.id,
      priorityId: URGENT_PRIORITY_ID,
      priorityLabel: URGENT_PRIORITY_LABEL,
      source: 'public-urgency-raise',
    });

    const assignedNotification = await this._queueAssignedAgentForBusinessUrgency({
      event,
      ticket: updatedTicket,
      fromPriorityId,
    }).catch((error) => ({
      queued: 0,
      skipped: 'assigned_notification_failed',
      error: error.message,
    }));

    let supervisorNotification = { queued: 0, skipped: 'supervisor_notification_disabled' };
    if (state.policy.businessUrgencyNotifySupervisors) {
      supervisorNotification = await this._queueDeliveries({
        event,
        policy: state.policy,
        ticket: updatedTicket,
        source: 'business_urgency',
        pipelineRunId: null,
        includeLegacy: false,
      });
    }

    const notificationSummary = {
      assignedAgent: assignedNotification,
      supervisors: supervisorNotification,
      queued: Number(assignedNotification.queued || 0) + Number(supervisorNotification.queued || 0),
    };
    const status = writeback.success
      ? 'completed'
      : 'completed_with_writeback_error';

    await prisma.urgentEscalationEvent.update({
      where: { id: event.id },
      data: {
        status,
        priorityWritebackStatus: writeback.success
          ? (writeback.skipped ? 'skipped' : 'synced')
          : 'failed',
        priorityWritebackError: writeback.success ? null : writeback.error || 'FreshService priority writeback failed',
        notificationSummary: safeJson(notificationSummary),
      },
    });

    const refreshed = await this._businessUrgencyState(token, requestMeta);
    return this._publicBusinessUrgencyResponse(refreshed, 'submitted', {
      eventId: event.id,
      writeback: {
        success: writeback.success === true,
        skipped: writeback.skipped === true,
        error: writeback.error || null,
      },
      notificationSummary,
    });
  }
}

export const __testing = {
  buildEscalationMessage,
  buildWhatsAppVariables,
  readinessForChannel,
  normalizePolicy,
};

export default new AfterHoursUrgentEscalationService();
