import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import { AFTER_HOURS_WORKFLOW_KEY } from './notificationWorkflowDefinition.js';
import { resolveAfterHoursActiveContact } from './urgentEscalationContactService.js';

const DEFAULT_EMERGENCY_LABEL = 'Request after-hours support';
const DEFAULT_OFF_HOURS_MESSAGE = 'Our team is currently outside regular business hours. We will review your request when business hours resume.';
const DEFAULT_HOLIDAY_MESSAGE = 'Our team is currently observing a holiday. We will review your request when business hours resume.';
const ROUTING_PREVIEW_LOOKBACK_DAYS = 14;
const ROUTING_PREVIEW_LOOKAHEAD_DAYS = 35;
const DISPLAY_DATE_FORMAT = 'EEE, MMM d, h:mm a zzz';

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function actorEmail(actor = null) {
  return String(actor?.email || actor || '').trim() || null;
}

function cleanText(value, max = 4000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function localDateString(date, timezone) {
  return formatInTimeZone(date, timezone, 'yyyy-MM-dd');
}

function addDateStrDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeekForDateStr(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

function localDateTimeToUtc(dateStr, time, timezone) {
  const offset = formatInTimeZone(new Date(`${dateStr}T12:00:00.000Z`), timezone, 'XXX');
  return new Date(`${dateStr}T${time}:00${offset}`);
}

function localDayStartUtc(dateStr, timezone) {
  return localDateTimeToUtc(dateStr, '00:00', timezone);
}

function localDayEndUtc(dateStr, timezone) {
  return localDayStartUtc(addDateStrDays(dateStr, 1), timezone);
}

function formatLocal(date, timezone) {
  return date ? formatInTimeZone(date, timezone, DISPLAY_DATE_FORMAT) : null;
}

function durationLabel(startAt, endAt) {
  if (!startAt || !endAt) return null;
  const minutes = Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

function serializeWindow(window, timezone) {
  if (!window) return null;
  return {
    mode: window.mode,
    label: window.label,
    startsAt: window.startsAt?.toISOString?.() || null,
    endsAt: window.endsAt?.toISOString?.() || null,
    startsAtLocal: formatLocal(window.startsAt, timezone),
    endsAtLocal: formatLocal(window.endsAt, timezone),
    duration: durationLabel(window.startsAt, window.endsAt),
    holidayName: window.holidayName || null,
    reason: window.reason || null,
  };
}

function summarizeBusinessHours(rows = []) {
  return [...rows]
    .filter((row) => row.isEnabled)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((row) => ({
      dayOfWeek: row.dayOfWeek,
      dayLabel: DAY_LABELS[row.dayOfWeek] || `Day ${row.dayOfWeek}`,
      startTime: row.startTime,
      endTime: row.endTime,
      timezone: row.timezone,
    }));
}

export function normalizeNotificationWorkflowPolicy(policy = null) {
  return {
    id: policy?.id || null,
    workspaceId: policy?.workspaceId || null,
    afterHoursEnabled: policy?.afterHoursEnabled === true,
    holidaysEnabled: policy?.holidaysEnabled !== false,
    suppressStandardTicketCreated: policy?.suppressStandardTicketCreated !== false,
    offHoursWorkflowKey: cleanText(policy?.offHoursWorkflowKey, 80) || AFTER_HOURS_WORKFLOW_KEY,
    emergencySupportUrl: cleanUrl(policy?.emergencySupportUrl),
    emergencySupportLabel: cleanText(policy?.emergencySupportLabel, 160) || DEFAULT_EMERGENCY_LABEL,
    offHoursMessage: cleanText(policy?.offHoursMessage) || DEFAULT_OFF_HOURS_MESSAGE,
    holidayMessage: cleanText(policy?.holidayMessage) || DEFAULT_HOLIDAY_MESSAGE,
    updatedBy: policy?.updatedBy || null,
    createdAt: policy?.createdAt || null,
    updatedAt: policy?.updatedAt || null,
  };
}

export async function getNotificationWorkflowPolicy(workspaceId) {
  const row = await prisma.notificationWorkflowPolicy.findUnique({
    where: { workspaceId },
  });
  return normalizeNotificationWorkflowPolicy(row || { workspaceId });
}

export async function updateNotificationWorkflowPolicy(workspaceId, data = {}, actor = null) {
  const normalized = normalizeNotificationWorkflowPolicy({
    workspaceId,
    afterHoursEnabled: data.afterHoursEnabled,
    holidaysEnabled: data.holidaysEnabled,
    suppressStandardTicketCreated: data.suppressStandardTicketCreated,
    offHoursWorkflowKey: data.offHoursWorkflowKey,
    emergencySupportUrl: data.emergencySupportUrl,
    emergencySupportLabel: data.emergencySupportLabel,
    offHoursMessage: data.offHoursMessage,
    holidayMessage: data.holidayMessage,
  });

  const row = await prisma.notificationWorkflowPolicy.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      afterHoursEnabled: normalized.afterHoursEnabled,
      holidaysEnabled: normalized.holidaysEnabled,
      suppressStandardTicketCreated: normalized.suppressStandardTicketCreated,
      offHoursWorkflowKey: normalized.offHoursWorkflowKey,
      emergencySupportUrl: normalized.emergencySupportUrl,
      emergencySupportLabel: normalized.emergencySupportLabel,
      offHoursMessage: normalized.offHoursMessage,
      holidayMessage: normalized.holidayMessage,
      updatedBy: actorEmail(actor),
    },
    update: {
      afterHoursEnabled: normalized.afterHoursEnabled,
      holidaysEnabled: normalized.holidaysEnabled,
      suppressStandardTicketCreated: normalized.suppressStandardTicketCreated,
      offHoursWorkflowKey: normalized.offHoursWorkflowKey,
      emergencySupportUrl: normalized.emergencySupportUrl,
      emergencySupportLabel: normalized.emergencySupportLabel,
      offHoursMessage: normalized.offHoursMessage,
      holidayMessage: normalized.holidayMessage,
      updatedBy: actorEmail(actor),
    },
  });

  return normalizeNotificationWorkflowPolicy(row);
}

function dateFromContext(context = {}) {
  const value = context.event?.occurredAt
    || context.ticket?.createdAt
    || context.ticket?.freshserviceUpdatedAt
    || new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function availabilityForContext(context = {}, policy = null) {
  const { default: availabilityService } = await import('./availabilityService.js');
  const workspaceId = Number(context.workspace?.id || context.ticket?.workspaceId || policy?.workspaceId || 0) || null;
  const timezone = context.workspace?.timezone || 'America/Los_Angeles';
  const checkedAt = dateFromContext(context);
  const [businessHours, holiday] = await Promise.all([
    availabilityService.isBusinessHours(checkedAt, timezone, workspaceId),
    availabilityService.isHoliday(checkedAt, timezone, workspaceId),
  ]);
  const nextBusiness = !businessHours.isBusinessHours
    ? await availabilityService.getNextBusinessTime(checkedAt, timezone, workspaceId)
    : null;

  return {
    isBusinessHours: businessHours.isBusinessHours === true,
    isAfterHours: businessHours.isBusinessHours !== true,
    isHoliday: holiday.isHoliday === true,
    holidayName: holiday.name || null,
    reason: businessHours.reason || null,
    timezone,
    checkedAt: checkedAt.toISOString(),
    nextBusinessTime: nextBusiness?.nextBusinessTime?.toISOString?.() || null,
    nextBusinessTimeLocal: nextBusiness?.nextBusinessTime
      ? formatInTimeZone(nextBusiness.nextBusinessTime, timezone, 'EEE, MMM d, h:mm a zzz')
      : null,
  };
}

async function routingPreviewInputs(workspaceId, policyDraft = null, referenceDate = new Date()) {
  const { default: availabilityService } = await import('./availabilityService.js');
  const [workspace, savedPolicy] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, defaultTimezone: true },
    }),
    getNotificationWorkflowPolicy(workspaceId),
  ]);
  const policy = normalizeNotificationWorkflowPolicy({
    ...savedPolicy,
    ...(policyDraft || {}),
    workspaceId,
  });
  const timezone = workspace?.defaultTimezone || 'America/Los_Angeles';
  const businessHours = await availabilityService.getBusinessHours(workspaceId);
  return {
    availabilityService,
    workspace,
    policy,
    timezone,
    businessHours,
    now: referenceDate,
  };
}

async function buildBusinessWindows({ availabilityService, businessHours, workspaceId, timezone, now }) {
  const startDateStr = addDateStrDays(localDateString(now, timezone), -ROUTING_PREVIEW_LOOKBACK_DAYS);
  const totalDays = ROUTING_PREVIEW_LOOKBACK_DAYS + ROUTING_PREVIEW_LOOKAHEAD_DAYS + 1;
  const enabledHours = [...businessHours].filter((row) => row.isEnabled);
  const windows = [];
  const holidays = [];

  for (let index = 0; index < totalDays; index += 1) {
    const dateStr = addDateStrDays(startDateStr, index);
    const dayOfWeek = dayOfWeekForDateStr(dateStr);
    const dayHours = enabledHours.find((row) => row.dayOfWeek === dayOfWeek);
    const dayReference = localDateTimeToUtc(dateStr, '12:00', timezone);
    const holiday = await availabilityService.isHoliday(dayReference, timezone, workspaceId);

    if (holiday.isHoliday) {
      holidays.push({
        date: dateStr,
        name: holiday.name || 'Holiday',
        startsAt: localDayStartUtc(dateStr, timezone),
        endsAt: localDayEndUtc(dateStr, timezone),
      });
    }

    if (!dayHours || holiday.isHoliday) continue;
    const startsAt = localDateTimeToUtc(dateStr, dayHours.startTime, timezone);
    const endsAt = localDateTimeToUtc(dateStr, dayHours.endTime, timezone);
    if (endsAt > startsAt) {
      windows.push({
        date: dateStr,
        dayOfWeek,
        startsAt,
        endsAt,
        startTime: dayHours.startTime,
        endTime: dayHours.endTime,
      });
    }
  }

  return {
    businessWindows: windows.sort((a, b) => a.startsAt - b.startsAt),
    holidays,
  };
}

function holidayOverlappingInterval(holidays, startsAt, endsAt) {
  return holidays.find((holiday) => holiday.startsAt < endsAt && holiday.endsAt > startsAt) || null;
}

function classifyRoutingWindow(policy, holidays, startsAt, endsAt) {
  const holiday = policy.holidaysEnabled ? holidayOverlappingInterval(holidays, startsAt, endsAt) : null;
  return {
    mode: holiday ? 'holiday' : 'after_hours',
    label: holiday ? 'Holiday routing' : 'After-hours routing',
    holidayName: holiday?.name || null,
  };
}

function buildOffHoursWindows({ policy, businessWindows, holidays, timezone, now }) {
  if (!policy.afterHoursEnabled) return [];
  if (businessWindows.length === 0) {
    const startsAt = localDayStartUtc(localDateString(now, timezone), timezone);
    return [{
      mode: 'after_hours',
      label: 'After-hours routing',
      startsAt,
      endsAt: null,
      reason: 'No business hours are configured for this workspace.',
    }];
  }

  const windows = [];
  for (let index = 0; index < businessWindows.length - 1; index += 1) {
    const startsAt = businessWindows[index].endsAt;
    const endsAt = businessWindows[index + 1].startsAt;
    if (endsAt <= startsAt) continue;
    const classification = classifyRoutingWindow(policy, holidays, startsAt, endsAt);
    windows.push({
      ...classification,
      startsAt,
      endsAt,
    });
  }
  return windows;
}

function activeOffHoursWindow(offHoursWindows, now) {
  return offHoursWindows.find((window) => (
    window.startsAt <= now && (!window.endsAt || window.endsAt > now)
  )) || null;
}

function activeBusinessWindow(businessWindows, now) {
  return businessWindows.find((window) => window.startsAt <= now && window.endsAt > now) || null;
}

function nextOffHoursWindow(offHoursWindows, now) {
  return offHoursWindows.find((window) => !window.endsAt || window.endsAt > now) || null;
}

function nextFutureOffHoursWindow(offHoursWindows, now) {
  return offHoursWindows.find((window) => window.startsAt > now) || null;
}

export async function getNotificationWorkflowSchedulePreview(workspaceId, policyDraft = null, referenceDate = new Date()) {
  const {
    availabilityService,
    workspace,
    policy,
    timezone,
    businessHours,
    now,
  } = await routingPreviewInputs(workspaceId, policyDraft, referenceDate);

  const [availability, { businessWindows, holidays }] = await Promise.all([
    availabilityForContext({
      event: { occurredAt: now.toISOString() },
      workspace: { id: workspaceId, timezone },
    }, policy),
    buildBusinessWindows({ availabilityService, businessHours, workspaceId, timezone, now }),
  ]);

  const offHoursWindows = buildOffHoursWindows({ policy, businessWindows, holidays, timezone, now });
  const offHoursNow = activeOffHoursWindow(offHoursWindows, now);
  const businessNow = activeBusinessWindow(businessWindows, now);
  const policyActive = isOffHoursPolicyActive({ availability, notificationPolicy: policy }, policy);
  const currentWindow = policyActive && offHoursNow
    ? {
      ...offHoursNow,
      label: availability.isHoliday ? 'Holiday routing' : offHoursNow.label,
      mode: availability.isHoliday ? 'holiday' : offHoursNow.mode,
      holidayName: availability.holidayName || offHoursNow.holidayName || null,
      reason: availability.reason,
    }
    : businessNow
      ? {
        mode: policy.afterHoursEnabled ? 'standard' : 'disabled',
        label: policy.afterHoursEnabled ? 'Standard ticket-arrived routing' : 'After-hours routing disabled',
        startsAt: businessNow.startsAt,
        endsAt: businessNow.endsAt,
        reason: policy.afterHoursEnabled
          ? 'Ticket arrivals use the standard Ticket arrived workflow during this window.'
          : 'The workspace after-hours routing toggle is off.',
      }
      : {
        mode: policy.afterHoursEnabled ? 'standard' : 'disabled',
        label: policy.afterHoursEnabled
          ? 'Standard ticket-arrived routing'
          : 'After-hours routing disabled',
        startsAt: null,
        endsAt: null,
        reason: policy.afterHoursEnabled
          ? 'Holiday routing is excluded by policy, or no active off-hours workflow window is available.'
          : 'The workspace after-hours routing toggle is off.',
      };

  const nextWindow = policyActive && offHoursNow
    ? nextFutureOffHoursWindow(offHoursWindows, now)
    : nextOffHoursWindow(offHoursWindows, now);
  const upcomingWindows = offHoursWindows
    .filter((window) => !window.endsAt || window.endsAt > now)
    .slice(0, 4);
  const nextHolidays = holidays
    .filter((holiday) => holiday.endsAt > now)
    .slice(0, 4)
    .map((holiday) => ({
      name: holiday.name,
      startsAt: holiday.startsAt.toISOString(),
      endsAt: holiday.endsAt.toISOString(),
      startsAtLocal: formatLocal(holiday.startsAt, timezone),
      endsAtLocal: formatLocal(holiday.endsAt, timezone),
    }));

  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : { id: workspaceId, name: null },
    timezone,
    generatedAt: now.toISOString(),
    generatedAtLocal: formatLocal(now, timezone),
    policy: {
      afterHoursEnabled: policy.afterHoursEnabled,
      holidaysEnabled: policy.holidaysEnabled,
      suppressStandardTicketCreated: policy.suppressStandardTicketCreated,
      offHoursWorkflowKey: policy.offHoursWorkflowKey,
    },
    availability,
    activeNow: policyActive,
    current: serializeWindow(currentWindow, timezone),
    nextActiveWindow: serializeWindow(nextWindow, timezone),
    upcomingActiveWindows: upcomingWindows.map((window) => serializeWindow(window, timezone)),
    businessHours: summarizeBusinessHours(businessHours),
    holidays: nextHolidays,
  };
}

function supportContext(policy, availability) {
  const holiday = availability?.isHoliday === true;
  return {
    enabled: policy.afterHoursEnabled,
    emergencySupportUrl: policy.emergencySupportUrl || '',
    emergencySupportLabel: policy.emergencySupportLabel || DEFAULT_EMERGENCY_LABEL,
    message: holiday ? policy.holidayMessage : policy.offHoursMessage,
  };
}

export async function enrichEventContextWithNotificationPolicy(context = {}) {
  const workspaceId = Number(context.workspace?.id || context.ticket?.workspaceId || 0);
  if (!workspaceId) return context;
  const policy = await getNotificationWorkflowPolicy(workspaceId);
  const availability = await availabilityForContext(context, policy);
  const activeContact = await resolveAfterHoursActiveContact(workspaceId, {
    timezone: context.workspace?.timezone,
  }).catch(() => null);
  const currentSupport = context.afterHoursSupport && typeof context.afterHoursSupport === 'object'
    ? context.afterHoursSupport
    : {};
  return {
    ...context,
    availability,
    afterHoursSupport: {
      ...currentSupport,
      ...supportContext(policy, availability),
      activeContact: activeContact || currentSupport.activeContact || null,
    },
    notificationPolicy: policy,
  };
}

export function isOffHoursPolicyActive(context = {}, policy = null) {
  const effectivePolicy = normalizeNotificationWorkflowPolicy(policy || context.notificationPolicy);
  if (!effectivePolicy.afterHoursEnabled) return false;
  const availability = context.availability || {};
  if (availability.isHoliday === true) return effectivePolicy.holidaysEnabled === true;
  return availability.isAfterHours === true || availability.isBusinessHours === false;
}

export function isOffHoursWorkflow(workflow, policy = null) {
  const effectivePolicy = normalizeNotificationWorkflowPolicy(policy);
  const scheduleMode = workflow?.publishedDefinition?.metadata?.scheduleMode
    || workflow?.draftDefinition?.metadata?.scheduleMode
    || null;
  return workflow?.key === effectivePolicy.offHoursWorkflowKey
    || scheduleMode === 'after_hours';
}

export function selectWorkflowsForNotificationTiming(workflows = [], context = {}) {
  if (context.event?.type !== 'ticket.created') {
    return {
      selected: workflows,
      suppressed: [],
      mode: 'standard',
      reason: null,
    };
  }

  const policy = normalizeNotificationWorkflowPolicy(context.notificationPolicy);
  const offHoursActive = isOffHoursPolicyActive(context, policy);
  const offHours = workflows.filter((workflow) => isOffHoursWorkflow(workflow, policy));
  const standard = workflows.filter((workflow) => !isOffHoursWorkflow(workflow, policy));

  if (!offHoursActive) {
    return {
      selected: standard,
      suppressed: offHours,
      mode: 'standard',
      reason: policy.afterHoursEnabled
        ? 'Business-hours notification routing selected the standard ticket-created workflow'
        : 'After-hours notification routing is disabled for this workspace',
    };
  }

  if (policy.suppressStandardTicketCreated) {
    return {
      selected: offHours,
      suppressed: standard,
      mode: 'after_hours',
      reason: 'After-hours/holiday routing suppressed the standard ticket-created workflow',
    };
  }

  return {
    selected: [...standard, ...offHours],
    suppressed: [],
    mode: 'after_hours_plus_standard',
    reason: 'After-hours/holiday routing is active without standard workflow suppression',
  };
}

export default {
  getNotificationWorkflowPolicy,
  updateNotificationWorkflowPolicy,
  getNotificationWorkflowSchedulePreview,
  enrichEventContextWithNotificationPolicy,
  isOffHoursPolicyActive,
  isOffHoursWorkflow,
  selectWorkflowsForNotificationTiming,
};
