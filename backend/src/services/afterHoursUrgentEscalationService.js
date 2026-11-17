import crypto from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
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
import { resolveAfterHoursActiveContact } from './urgentEscalationContactService.js';
import { PRIORITY_ID_TO_LABEL } from './priorityAssessment.js';
import config from '../config/index.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { ticketLinkUrl } from '../utils/ticketLink.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { repairCp437Mojibake } from '../utils/mojibake.js';

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

// QA 11-16 public page: the short "What to expect" lines. A workspace that wrote its
// own response copy in Settings sees its own words instead.
const PUBLIC_EXPECT_COPY = Object.freeze({
  businessHours: 'We answer tickets as they come in.',
  afterHours: 'For high-priority issues. We reply within about 2 hours.',
  lateNight: "We'll still try, but it can take longer than 2 hours.",
});

function publicExpectCopy(responseCopy = {}) {
  const pick = (key) => {
    const own = cleanText(responseCopy?.[key], 1200);
    return own && own !== DEFAULT_AFTER_HOURS_RESPONSE_COPY[key] ? own : PUBLIC_EXPECT_COPY[key];
  };
  return { businessHours: pick('businessHours'), afterHours: pick('afterHours'), lateNight: pick('lateNight') };
}

/** "5pm", "5:30 PM", "17:00" → minutes after midnight, or null. */
function parseClockMinutes(text) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(String(text || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = String(match[3] || '').toLowerCase().replace(/\./g, '');
  if (hour > 24 || minute > 59) return null;
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** A policy cell such as "5pm - 10pm PT" → { start, end } in minutes, or null. */
function parseWindowCell(text) {
  const parts = String(text || '')
    .replace(/\b(?:PT|PST|PDT)\b/gi, '')
    .trim()
    .split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const start = parseClockMinutes(parts[0]);
  const end = parseClockMinutes(parts[1]);
  return start === null || end === null ? null : { start, end };
}

function responseRowForDay(rows = [], { isHoliday, dayOfWeek }) {
  const find = (pattern) => rows.find((row) => pattern.test(String(row?.label || '')));
  if (isHoliday) {
    const holidayRow = find(/holiday/i);
    if (holidayRow) return holidayRow;
  }
  if (dayOfWeek === 0 || dayOfWeek === 6) return find(/weekend|saturday|sunday/i) || null;
  return find(/mon|weekday/i) || rows[0] || null;
}

/**
 * Which support window applies at `at`: 'business', 'after_hours' or 'late_night'.
 * Business hours come from the availability check; after-hours vs late night from the
 * policy's response table (the after-hours cell of today's row), so Settings still
 * drives it. An after-hours cell we cannot read counts as after-hours (the softer
 * promise is never made by guessing).
 */
function publicSupportPhase({ availability, responseTable, timezone, at }) {
  if (!availability) return null;
  if (availability.isBusinessHours === true) return 'business';
  const tz = timezone || 'America/Vancouver';
  const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const dayOfWeek = Number(formatInTimeZone(when, tz, 'i')) % 7;
  const row = responseRowForDay(responseTable?.rows || [], { isHoliday: availability.isHoliday === true, dayOfWeek });
  const cell = String(row?.afterHours || '').trim();
  if (/^n\/?a$/i.test(cell)) return 'late_night';
  const window = parseWindowCell(cell);
  if (!window) return 'after_hours';
  const minutes = Number(formatInTimeZone(when, tz, 'H')) * 60 + Number(formatInTimeZone(when, tz, 'm'));
  const inside = window.start <= window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end;
  return inside ? 'after_hours' : 'late_night';
}

function clockLabel(date, tz) {
  return formatInTimeZone(date, tz, 'mm') === '00'
    ? formatInTimeZone(date, tz, 'h a')
    : formatInTimeZone(date, tz, 'h:mm a');
}

/**
 * The headline's "until …": just the time when it is today or tomorrow ("5 AM"),
 * the weekday within a week ("Monday 5 AM"), otherwise the date ("Tue, Dec 29, 5 AM").
 */
function shortNextBusinessLabel(nextBusinessTime, timezone, now = new Date()) {
  const next = nextBusinessTime ? new Date(nextBusinessTime) : null;
  if (!next || Number.isNaN(next.getTime())) return null;
  const tz = timezone || 'America/Vancouver';
  const today = formatInTimeZone(now, tz, 'yyyy-MM-dd');
  const nextDay = formatInTimeZone(next, tz, 'yyyy-MM-dd');
  const dayGap = Math.round((Date.parse(`${nextDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const time = clockLabel(next, tz);
  if (dayGap <= 1) return time;
  if (dayGap <= 6) return `${formatInTimeZone(next, tz, 'EEEE')} ${time}`;
  return `${formatInTimeZone(next, tz, 'EEE, MMM d')}, ${time}`;
}

/** When the request went to after-hours support: "9:41 PM" today, with the date otherwise. */
function sentAtLabel(sentAt, timezone, now = new Date()) {
  const tz = timezone || 'America/Vancouver';
  const sameDay = formatInTimeZone(sentAt, tz, 'yyyy-MM-dd') === formatInTimeZone(now, tz, 'yyyy-MM-dd');
  return sameDay
    ? formatInTimeZone(sentAt, tz, 'h:mm a')
    : formatInTimeZone(sentAt, tz, 'EEE, MMM d, h:mm a');
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

/**
 * 16 Nov 2026 (IT cutover): the person on call is paged to the ticket in Ticket Pulse, where IT
 * now works it, not the FreshService copy. The ticket's own reference (TP-n for a Ticket Pulse
 * ticket) and the app's short link (/it/TP-n); the FreshService link only if no app link can
 * be built (a ticket object without an id).
 */
function ticketAppLink(ticket) {
  if (!ticket?.id) return null;
  return ticketLinkUrl(resolvePublicBaseUrl({ warn: (m) => logger.warn(m) }), ticket);
}

function escalationTicketRef(ticket) {
  if (!ticket) return null;
  const hasNumbers = ticket.nativeNumber !== null && ticket.nativeNumber !== undefined
    || ticket.freshserviceTicketId !== null && ticket.freshserviceTicketId !== undefined;
  return hasNumbers ? ticketDisplayRef(ticket) : null;
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

function normalizeDisabledChannels(value) {
  return normalizeList(value).filter((channel) => ESCALATION_CHANNELS.includes(channel) && channel !== 'email');
}

/**
 * `alwaysText` (16 Nov 2026, Vahid: "sms alert should go to emergency agents
 * regardless of their sms on and off status"): when paging the after-hours
 * contacts, a verified phone gets the text even if the person's own SMS
 * switch is off. Their phone must still be verified, the workspace must not
 * have paused SMS, and the provider must be set up.
 */
function readinessForChannel({ technician, preference }, providerStatus, channel, disabledChannels = [], { alwaysText = false } = {}) {
  const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
  const pausedByWorkspace = normalizeDisabledChannels(disabledChannels).includes(channel);
  const enabled = channelEnabled(preference, channel) || (alwaysText && channel === 'sms');
  const recipient = channelRecipient({ technician, preference }, channel);
  const phoneVerified = !PHONE_CHANNELS.has(channel) || Boolean(preference?.phoneVerifiedAt);
  const hasRecipient = Boolean(recipient);
  const missing = [];
  if (pausedByWorkspace) missing.push('channel_paused_for_workspace');
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
    pausedByWorkspace,
    ready: !pausedByWorkspace && enabled && hasRecipient && phoneVerified && provider.configured === true,
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
    showAfterHoursPhoneInEmail: row?.showAfterHoursPhoneInEmail !== false,
    disabledChannels: normalizeDisabledChannels(row?.disabledChannels),
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
  const ref = escalationTicketRef(ticket);
  const link = ticketAppLink(ticket) || freshserviceLink(ticket);
  const prefix = source === 'self_service'
    ? 'Ticket Pulse urgent self-escalation:'
    : source === 'business_urgency'
      ? 'Ticket Pulse requester priority raise:'
      : 'Ticket Pulse after-hours escalation:';
  return [
    prefix,
    ref ? `ticket ${ref}` : 'a ticket',
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
  // Read aloud: "T P 12591" for a Ticket Pulse ticket, "number 252303" for a FreshService one.
  const ref = escalationTicketRef(ticket);
  const spoken = ref ? ref.replace(/^TP-/, 'T P ').replace(/^#/, 'number ') : null;
  return [
    'Ticket Pulse urgent escalation.',
    spoken ? `Ticket ${spoken}` : 'A ticket',
    source === 'self_service'
      ? 'was escalated by the requester after hours.'
      : source === 'business_urgency'
        ? 'was marked urgent by the requester.'
        : 'was automatically assessed as urgent after hours.',
  ].filter(Boolean).join(' ');
}

function buildWhatsAppVariables({ ticket, priority, message }) {
  return {
    message,
    priority: priority || '',
    ticketId: escalationTicketRef(ticket) || '',
    link: ticketAppLink(ticket) || freshserviceLink(ticket) || '',
  };
}

/** What an unauthenticated page may learn about who was alerted: how many, and by which channels. */
function publicNotificationSummary(summary) {
  const lists = [summary?.channels, summary?.assignedAgent?.channels, summary?.supervisors?.channels];
  const channels = [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])).filter((c) => typeof c === 'string'))];
  return { queued: Number(summary?.queued) || 0, channels };
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

function isCompletedSelfServiceEscalation(event) {
  return ['completed', 'completed_with_writeback_error'].includes(String(event?.status || '').toLowerCase());
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

/**
 * QA 10-26 #8: who the urgent-response people list shows. Every technician
 * row of a workspace used to be listed, which pulled in vendor and former
 * FreshService agents and showed a person twice when they had both a
 * FreshService row and a local-agent row. A person belongs to the workspace
 * when they are an active agent, an assignable-only agent, or an app member
 * (workspace access by e-mail). Anyone already picked stays listed so they
 * can be removed. One row per lower-cased e-mail: the picked row wins, then
 * the active one, the assignable one, the one with notification settings,
 * the FreshService one, the oldest.
 */
export function workspacePeople(technicians = [], { accessEmails = new Set(), selectedIds = new Set() } = {}) {
  const MEMBERSHIP_ORDER = ['agent', 'assignable', 'member'];
  const keyOf = (technician) => String(technician.email || '').trim().toLowerCase() || `id:${technician.id}`;
  const membershipOf = (technician) => {
    if (technician.isActive) return 'agent';
    if (technician.assignableOnly) return 'assignable';
    if (accessEmails.has(keyOf(technician))) return 'member';
    return null;
  };
  const rank = (technician) => [
    selectedIds.has(technician.id) ? 0 : 1,
    technician.isActive ? 0 : 1,
    technician.assignableOnly ? 0 : 1,
    technician.notificationPreference ? 0 : 1,
    technician.origin === 'local' ? 1 : 0,
    technician.id,
  ];
  const better = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let index = 0; index < ra.length; index += 1) {
      if (ra[index] !== rb[index]) return ra[index] < rb[index];
    }
    return false;
  };

  const groups = new Map();
  for (const technician of technicians) {
    const key = keyOf(technician);
    groups.set(key, [...(groups.get(key) || []), technician]);
  }

  const people = [];
  for (const rows of groups.values()) {
    // Membership is the person's, whichever of their rows earns it.
    const memberships = rows.map(membershipOf).filter(Boolean);
    const membership = MEMBERSHIP_ORDER.find((value) => memberships.includes(value)) || 'outside';
    const picked = rows.filter((technician) => selectedIds.has(technician.id));
    if (membership === 'outside' && picked.length === 0) continue;
    const winner = rows.reduce((best, technician) => (better(technician, best) ? technician : best));
    people.push({ technician: winner, membership });
    // Two rows of one person both picked: keep both so neither is lost.
    for (const technician of picked) {
      if (technician !== winner) people.push({ technician, membership });
    }
  }
  return people;
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
              internalDomains: true,
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

// QA 10-15 #5: requesters may open a Teams chat with the assigned agent from
// the urgency page. Off until the agent opts in (Mail & alerts → Teams).
const TEAMS_CHAT_ACTIVITY = 'requester_teams_chat';
const TEAMS_CHAT_REPEAT_MS = 10 * 60 * 1000;

function emailDomain(email) {
  const at = String(email || '').trim().toLowerCase().split('@');
  return at.length === 2 && at[0] && at[1] ? at[1] : '';
}

function domainMatches(domain, list) {
  return list.some((d) => {
    const dd = String(d || '').trim().toLowerCase().replace(/^@/, '');
    return dd && (domain === dd || domain.endsWith(`.${dd}`));
  });
}

/**
 * Outside requesters cannot chat in the company's Teams: the requester must be
 * on one of the workspace's internal domains, or (none configured) share the
 * agent's domain.
 */
function requesterIsInternal(requesterEmail, agentEmail, internalDomains) {
  const requesterDomain = emailDomain(requesterEmail);
  if (!requesterDomain) return false;
  const list = Array.isArray(internalDomains) ? internalDomains.filter(Boolean) : [];
  if (list.length > 0) return domainMatches(requesterDomain, list);
  const agentDomain = emailDomain(agentEmail);
  return Boolean(agentDomain) && agentDomain === requesterDomain;
}

async function agentAllowsRequesterTeamsChat(workspaceId, technicianId) {
  try {
    const row = await prisma.notificationPreference.findUnique({
      where: { workspaceId_technicianId: { workspaceId: Number(workspaceId), technicianId: Number(technicianId) } },
      select: { options: true },
    });
    return row?.options?.requesterTeamsChat === true;
  } catch {
    return false;
  }
}

/** Everything the page and the POST need; the agent's e-mail never leaves the server. */
async function requesterTeamsChatState(ticket, workspaceId) {
  const agent = ticket?.assignedTech || null;
  const firstName = agent?.name ? String(agent.name).trim().split(/\s+/)[0] : null;
  const no = (reason) => ({ available: false, reason, agentName: null, agentFirstName: null, agentEmail: null });
  if (isTerminalTicket(ticket)) return no('ticket_closed_or_resolved');
  if (!agent?.id || !agent?.email) return no('no_assigned_agent');
  if (!ticket?.requester?.email) return no('requester_not_internal');
  if (!requesterIsInternal(ticket.requester.email, agent.email, ticket.workspace?.internalDomains)) {
    return no('requester_not_internal');
  }
  if (!(await agentAllowsRequesterTeamsChat(workspaceId, agent.id))) return no('agent_not_opted_in');
  return {
    available: true,
    reason: null,
    agentName: agent.name || null,
    agentFirstName: firstName,
    agentEmail: String(agent.email).trim(),
  };
}

function buildTeamsChatUrl(agentEmail, ticket) {
  const subject = String(ticket?.subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const message = `About ${ticketDisplayRef(ticket)}${subject ? ` – ${subject}` : ''}: `;
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(agentEmail)}&message=${encodeURIComponent(message)}`;
}

class AfterHoursUrgentEscalationService {
  async getPolicy(workspaceId) {
    let row;
    try {
      row = await prisma.urgentEscalationPolicy.upsert({
        where: { workspaceId },
        update: {},
        create: { workspaceId },
        include: { recipients: true },
      });
    } catch (err) {
      // Two first reads at once (30 Sep 2026: GET /settings/urgent-escalation
      // → 500) both try to create the default row; the loser reads the
      // winner's row instead of failing.
      if (err?.code !== 'P2002') throw err;
      row = await prisma.urgentEscalationPolicy.findUnique({ where: { workspaceId }, include: { recipients: true } });
      if (!row) throw err;
    }
    return normalizePolicy(row);
  }

  async getPolicyWithDependencies(workspaceId) {
    const [policy, assignmentConfig, routingPolicy, routingPreview, activeContact] = await Promise.all([
      this.getPolicy(workspaceId),
      prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: {
          priorityAssessmentEnabled: true,
          priorityWritebackEnabled: true,
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
        priorityAssessmentEnabled: assignmentConfig?.priorityAssessmentEnabled !== false,
        priorityWritebackEnabled: assignmentConfig?.priorityWritebackEnabled !== false,
        afterHoursPriorityAssessmentEnabled: assignmentConfig?.priorityAssessmentAfterHoursEnabled === true,
        afterHoursWorkflowRoutingEnabled: routingPolicy.afterHoursEnabled === true,
        holidaysIncluded: routingPolicy.holidaysEnabled === true,
        routingPreview,
      },
    };
  }

  async updatePolicy(workspaceId, input = {}, actor = null) {
    const current = await this.getPolicy(workspaceId);
    // QA 10-23 #2: the after-hours contact in e-mails is the on-call person
    // (Urgent response → On-call). The old manual contact and weekly rotation
    // are no longer read or written; their columns stay as they were.
    const baseRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList(input.baseRecipientIds ?? current.baseRecipientIds),
    );
    const selfExtraRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList(input.selfExtraRecipientIds ?? current.selfExtraRecipientIds),
    );
    const businessSupervisorRecipientIds = await validateTechnicians(
      workspaceId,
      normalizeIdList(input.businessSupervisorRecipientIds ?? current.businessSupervisorRecipientIds),
    );

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
      showAfterHoursPhoneInEmail: input.showAfterHoursPhoneInEmail !== undefined
        ? !!input.showAfterHoursPhoneInEmail
        : current.showAfterHoursPhoneInEmail !== false,
      disabledChannels: input.disabledChannels !== undefined
        ? normalizeDisabledChannels(input.disabledChannels)
        : normalizeDisabledChannels(current.disabledChannels),
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
    const [providerStatus, policy, technicians, accessRows] = await Promise.all([
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
      // App members of this workspace (Settings → Members). Optional: a
      // failed read only narrows the list to the workspace's agents.
      Promise.resolve()
        .then(() => prisma.workspaceAccess.findMany({ where: { workspaceId }, select: { email: true } }))
        .catch(() => []),
    ]);

    const selectedBase = new Set(policy.baseRecipientIds);
    const selectedSelfExtra = new Set(policy.selfExtraRecipientIds);
    const selectedBusinessSupervisor = new Set(policy.businessSupervisorRecipientIds);
    const people = workspacePeople(technicians, {
      accessEmails: new Set((accessRows || []).map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean)),
      selectedIds: new Set([...selectedBase, ...selectedSelfExtra, ...selectedBusinessSupervisor]),
    });

    return {
      providerStatus,
      disabledChannels: policy.disabledChannels || [],
      candidates: people.map(({ technician, membership }) => {
        const context = { technician, preference: technician.notificationPreference || null };
        const channels = Object.fromEntries(
          ESCALATION_CHANNELS.map((channel) => [channel, readinessForChannel(context, providerStatus, channel, policy.disabledChannels)]),
        );
        return {
          id: technician.id,
          name: repairCp437Mojibake(technician.name),
          email: technician.email,
          photoUrl: technician.photoUrl,
          isActive: technician.isActive,
          membership,
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
    // After hours the person on call is paged too (16 Nov 2026): the e-mail
    // showed the requester their number, so they must be the one who hears.
    // Business-hours urgency keeps its own supervisor list.
    if (source !== 'business_urgency') {
      const onCall = await this._onCallRow(workspaceId);
      if (onCall && !byTech.has(onCall.technicianId)) byTech.set(onCall.technicianId, onCall);
      else if (onCall) byTech.get(onCall.technicianId).onCall = true;
    }
    return [...byTech.values()];
  }

  /** The ticket with the fields its reference and app link need. Never throws: falls back to what it was given. */
  async _ticketForMessage(ticket) {
    if (!ticket?.id) return ticket;
    try {
      const row = await prisma.ticket.findUnique({
        where: { id: Number(ticket.id) },
        select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
      });
      return row ? { ...ticket, ...row } : ticket;
    } catch (err) {
      logger.debug?.(`Urgent escalation: ticket numbers for the message not read (${err.message})`);
      return ticket;
    }
  }

  /** The current on-call person as a recipient row, or null (not set up, nobody, away with no cover). Never throws. */
  async _onCallRow(workspaceId, at = new Date()) {
    try {
      const { default: onCallService } = await import('./urgentResponse/onCallService.js');
      const current = await onCallService.current(workspaceId, at);
      if (!current?.configured || !current.technician?.id || current.onLeaveNoCover) return null;
      const technician = await prisma.technician.findFirst({
        where: { id: current.technician.id, workspaceId, isActive: true },
        include: { notificationPreference: true },
      });
      return technician ? { technicianId: technician.id, technician, scope: 'on_call', onCall: true } : null;
    } catch (err) {
      logger.warn(`Urgent escalation: on-call lookup failed for workspace ${workspaceId} (non-fatal): ${err.message}`);
      return null;
    }
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
    // The callers' ticket objects carry different fields (a public link's include, a pipeline
    // run's select); read the numbers the reference and the short link need, once.
    const refTicket = await this._ticketForMessage(ticket);
    const message = buildEscalationMessage({ ticket: refTicket, priority: URGENT_PRIORITY_LABEL, source });
    const voiceMessage = buildVoiceMessage({ ticket: refTicket, source });
    const whatsappVariables = buildWhatsAppVariables({ ticket: refTicket, priority: URGENT_PRIORITY_LABEL, message });
    const deliveries = [];
    const skipped = [];
    const queuedChannels = new Set();
    const recipientKeys = new Set();

    for (const row of selectedRows) {
      const context = {
        technician: row.technician,
        preference: row.technician.notificationPreference || null,
      };
      // After-hours contacts are texted whatever their own SMS switch says.
      const alwaysText = source !== 'business_urgency';
      for (const channel of ESCALATION_CHANNELS) {
        const readiness = readinessForChannel(context, providerStatus, channel, policy?.disabledChannels, { alwaysText });
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
        notificationDeliveryService.processQueuedDeliveries({
          limit: count,
          dedupeKeys: deliveries.map((delivery) => delivery.dedupeKey),
        }).catch((error) => {
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
    const pausedChannels = new Set(normalizeDisabledChannels(policy.disabledChannels));
    const channels = normalizeList(policy.legacyChannels).filter((channel) => ESCALATION_CHANNELS.includes(channel));
    const emails = normalizeList(policy.legacyEmails);
    const phones = normalizeList(policy.legacyPhones);

    for (const channel of channels) {
      const provider = providerStatus[channel] || { provider: null, configured: false, missing: [] };
      const recipients = channel === 'email' ? emails : phones;
      if (pausedChannels.has(channel)) {
        skipped.push({ legacy: true, channel, reason: 'channel_paused_for_workspace', warnings: ['channel_paused_for_workspace'] });
        continue;
      }
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
    // One incident pages once (16 Nov 2026, with the on-call person now always
    // texted): a ticket that already paged within the cooldown — a re-run after
    // a rebound, a flapping alert reopened by its occurrences — pages no one again.
    // Same window as the requester button.
    const recent = await Promise.resolve()
      .then(() => prisma.urgentEscalationEvent.findFirst({
        where: { ticketId: ticket.id, createdAt: { gte: new Date(Date.now() - policy.cooldownMinutes * 60 * 1000) } },
        select: { id: true },
      }))
      .catch(() => null);
    if (recent) {
      return { queued: 0, skipped: 'cooldown', previousEventId: recent.id };
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
        timezone: ticket.workspace?.defaultTimezone || 'America/Vancouver',
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
    const alreadyUrgent = isUrgentTicket(ticket);
    const alreadyEscalated = isCompletedSelfServiceEscalation(lastEvent);
    const terminal = isTerminalTicket(ticket);
    const reasons = [];
    if (!policy.selfServiceEnabled) reasons.push('self_service_disabled');
    if (!offHoursActive) reasons.push('not_after_hours');
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
      alreadyUrgent,
      alreadyEscalated,
      lastEscalationAt: lastEvent?.createdAt ? new Date(lastEvent.createdAt) : null,
      terminal,
      reasons,
      available: reasons.length === 0,
    };
  }

  /**
   * The public after-hours page's payload. No person is named here (QA 11-16): the
   * assigned agent, the requester and the on-call contact stay out of this
   * unauthenticated response.
   */
  _publicSelfEscalationResponse(state, status = null, { sentAt = null } = {}) {
    const ticket = state.ticket;
    const workspace = ticket.workspace;
    const timezone = workspace?.defaultTimezone || 'America/Vancouver';
    const availability = state.policyContext.availability || null;
    const now = new Date();
    const checkedAt = availability?.checkedAt ? new Date(availability.checkedAt) : now;
    const support = { ...(state.policyContext.afterHoursSupport || {}) };
    delete support.activeContact;
    const escalationAt = sentAt || state.lastEscalationAt || null;
    const shownAt = escalationAt && !Number.isNaN(new Date(escalationAt).getTime()) ? new Date(escalationAt) : null;
    return {
      status: status || (state.available ? 'available' : 'unavailable'),
      available: state.available,
      reasons: state.reasons,
      alreadyUrgent: state.alreadyUrgent,
      alreadyEscalated: state.alreadyEscalated,
      cooldownUntil: state.cooldownUntil?.toISOString?.() || null,
      afterHours: {
        active: state.offHoursActive,
        availability,
        support: state.policyContext.afterHoursSupport ? support : null,
        responseCopy: state.policy.afterHoursResponseCopy,
        responseTable: state.policy.afterHoursResponseTable,
        // QA 11-16: which row of the hours table applies now, the local hour for the
        // greeting, and the short "until 5 AM" for the headline (server clock: the
        // browser's tzdata may still put BC on PST/PDT).
        phase: publicSupportPhase({
          availability,
          responseTable: state.policy.afterHoursResponseTable,
          timezone,
          at: checkedAt,
        }),
        localHour: Number(formatInTimeZone(checkedAt, timezone, 'H')),
        nextBusinessShort: shortNextBusinessLabel(availability?.nextBusinessTime, timezone, checkedAt),
        expect: publicExpectCopy(state.policy.afterHoursResponseCopy),
      },
      escalation: {
        sentAt: shownAt ? shownAt.toISOString() : null,
        sentAtLocal: shownAt ? sentAtLabel(shownAt, timezone, now) : null,
      },
      confirmation: {
        title: state.policy.confirmationTitle,
        body: state.policy.confirmationBody,
      },
      ticket: {
        id: ticket.id,
        // The ticket's own reference (TP-n for a Ticket Pulse ticket), never the
        // FreshService copy's number when it has one of its own (QA 11-16).
        ref: ticketDisplayRef(ticket),
        freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
        subject: ticket.subject || 'Ticket',
        status: ticket.status,
        priority: ticket.assessedPriority || PRIORITY_ID_TO_LABEL[Number(ticket.priority)] || String(ticket.priority || ''),
        publicStatusUrl: buildPublicTicketStatusUrl(state.token),
        raiseUrgencyUrl: buildTicketUrgencyUrl(state.token),
      },
      workspace: {
        id: workspace?.id || state.link.workspaceId,
        name: workspace?.name || 'Ticket Pulse',
        timezone: workspace?.defaultTimezone || 'America/Vancouver',
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
    // Unauthenticated response (QA 11-16 review): counts only. The full summary names the
    // staff who were skipped and the write-back error can carry FreshService's own text; both
    // stay on the escalation event for the team.
    return {
      ...this._publicSelfEscalationResponse(refreshed, 'submitted', { sentAt: event.createdAt || new Date() }),
      eventId: event.id,
      writeback: {
        success: writeback.success === true,
        skipped: writeback.skipped === true,
      },
      notificationSummary: publicNotificationSummary(notificationSummary),
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
        timezone: ticket.workspace?.defaultTimezone || 'America/Vancouver',
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
    const teamsChat = await requesterTeamsChatState(ticket, workspaceId);

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
      teamsChat,
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
        // TP-born tickets show their TP number, FS-born keep "#12345".
        displayRef: ticketDisplayRef(ticket),
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
      // No e-mail address here: the Teams link is built by the POST.
      teamsChat: {
        available: state.teamsChat?.available === true,
        agentName: state.teamsChat?.agentName || null,
        agentFirstName: state.teamsChat?.agentFirstName || null,
        // Why it is not offered stays on the server: it would tell an outsider whether the agent opted in.
      },
      workspace: {
        id: workspace?.id || state.link.workspaceId,
        name: workspace?.name || 'Ticket Pulse',
        timezone: workspace?.defaultTimezone || 'America/Vancouver',
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

  /**
   * QA 10-15 #5: the requester asks to chat with the assigned agent in Teams.
   * Re-checks the rules, notes it in the ticket history (once per 10 minutes)
   * and hands back the Teams deep link. Independent of raising urgency.
   */
  async startRequesterTeamsChat(token, requestMeta = {}) {
    const { link } = await getPublicLinkByToken(token);
    const ticket = link.ticket;
    const chat = await requesterTeamsChatState(ticket, link.workspaceId);
    if (!chat.available) {
      return { available: false, url: null };
    }

    const url = buildTeamsChatUrl(chat.agentEmail, ticket);
    try {
      const since = new Date(Date.now() - TEAMS_CHAT_REPEAT_MS);
      const recent = await prisma.ticketActivity.findFirst({
        where: { ticketId: ticket.id, activityType: TEAMS_CHAT_ACTIVITY, performedAt: { gte: since } },
        select: { id: true },
      });
      if (!recent) {
        await prisma.ticketActivity.create({
          data: {
            ticketId: ticket.id,
            activityType: TEAMS_CHAT_ACTIVITY,
            performedBy: String(ticket.requester?.name || ticket.requester?.email || 'Requester').slice(0, 255),
            performedAt: new Date(),
            details: safeJson({
              via: 'urgency_page',
              actorKind: 'human',
              requesterEmail: ticket.requester?.email || null,
              technicianId: ticket.assignedTech?.id || null,
              agentName: chat.agentName,
              note: `Opened a Teams chat with ${chat.agentName || 'the assigned agent'} from the urgency page.`,
              ipHash: hashText(requestMeta.ip || ''),
            }),
          },
        });
      }
    } catch (error) {
      // The chat still opens; the history line is best effort.
      logger.warn(`Requester Teams chat: could not record activity on ticket ${ticket.id}: ${error.message}`);
    }

    return { available: true, agentName: chat.agentName, agentFirstName: chat.agentFirstName, url };
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
      },
      notificationSummary: publicNotificationSummary(notificationSummary),
    });
  }
}

export const __testing = {
  buildEscalationMessage,
  buildWhatsAppVariables,
  readinessForChannel,
  normalizePolicy,
  publicSupportPhase,
  shortNextBusinessLabel,
};

export default new AfterHoursUrgentEscalationService();
