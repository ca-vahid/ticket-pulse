/**
 * "An alert went out" on the ticket's Activity tab (QA 11-24 item 9).
 *
 * A priority, assignment or after-hours alert, or a person's own alert
 * subscription, used to reach the agent by e-mail / SMS / call with nothing
 * on the ticket to say so. Every alert sent about a ticket now leaves ONE
 * `ticket_activities` row per person and alert:
 *
 *   activityType 'alert_sent', performedBy 'Ticket Pulse'
 *   details = { sentence, kind, technicianId, technicianName, priority,
 *               channels: { sent: [], failed: [{ channel, error }], queued: [] },
 *               reason, deliveryIds, fallbackReasons?, actorKind: 'system' }
 *
 *   "Urgent-priority alert sent to Jordan Lee by e-mail and SMS: assignee,
 *    subscribed to High and Urgent alerts"
 *
 * Nothing here throws: an alert's history row must never cost the alert.
 */
import prisma from './prisma.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import logger from '../utils/logger.js';

export const ALERT_SENT_ACTIVITY = 'alert_sent';

const CHANNEL_WORDS = Object.freeze({
  email: 'e-mail',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  phone_call: 'phone call',
  phone: 'phone call',
  teams: 'Teams',
});

const THRESHOLD_WORDS = Object.freeze({
  urgent_only: 'subscribed to Urgent alerts',
  high_urgent: 'subscribed to High and Urgent alerts',
});

const KIND_WORDS = Object.freeze({
  priority: 'alert',
  assignment: 'assignment alert',
  escalation: 'urgent escalation',
  custom: 'alert',
});

/** "e-mail", "e-mail and SMS", "e-mail, SMS and phone call". */
export function channelWords(channels = []) {
  const words = [...new Set((Array.isArray(channels) ? channels : []).map((c) => CHANNEL_WORDS[c] || String(c)))].filter(Boolean);
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Why this person got the alert, in words ("assignee, subscribed to Urgent alerts"). */
export function alertReason({ kind, threshold = null, escalationType = null, subscriptionLabel = null } = {}) {
  if (kind === 'custom') return subscriptionLabel ? `subscribed to the alert "${subscriptionLabel}"` : 'subscribed to this alert';
  if (kind === 'escalation') {
    if (escalationType === 'self_service') return 'the requester escalated the ticket';
    if (escalationType === 'business_urgency') return 'the requester raised the urgency';
    return 'after-hours urgent escalation';
  }
  const who = kind === 'assignment' ? 'assigned to them' : 'assignee';
  const sub = THRESHOLD_WORDS[threshold] || null;
  return sub ? `${who}, ${sub}` : who;
}

/** The one line the Activity tab shows. */
export function alertSentence({ kind, priority = null, technicianName = null, sent = [], failed = [], queued = [], reason = null } = {}) {
  const who = technicianName || 'the agent';
  const what = kind === 'escalation'
    ? 'Urgent escalation'
    : `${priority ? `${priority}-priority ` : ''}${KIND_WORDS[kind] || 'alert'}`;
  const head = what.charAt(0).toUpperCase() + what.slice(1);
  const failedChannels = failed.map((f) => f.channel);
  let line;
  if (sent.length) {
    line = `${head} sent to ${who} by ${channelWords(sent)}`;
    if (failedChannels.length) line += ` (${channelWords(failedChannels)} failed)`;
  } else if (failedChannels.length) {
    line = `${head} to ${who} could not be sent by ${channelWords(failedChannels)}`;
  } else if (queued.length) {
    line = `${head} to ${who} is waiting to go by ${channelWords(queued)}`;
  } else {
    line = `${head} to ${who}: nothing was sent`;
  }
  return reason ? `${line}: ${reason}` : line;
}

const FAILED_STATUSES = new Set(['failed', 'failed_permanent']);

/**
 * Write one row for one person's alert on one ticket. `deliveries` are
 * notification_deliveries rows (channel, status, error, payload, id), or the
 * plain channel results of a direct send ({ channel, sent, error }).
 * @returns {Promise<object|null>} the row, or null
 */
export async function recordAlertActivity({
  ticketId, kind, priority = null, technicianId = null, technicianName = null, reason = null, deliveries = [], at = null,
} = {}) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const list = Array.isArray(deliveries) ? deliveries : [];
  if (!list.length) return null;
  const sent = [];
  const failed = [];
  const queued = [];
  const fallbackReasons = [];
  for (const d of list) {
    const channel = d.channel;
    const status = d.status || (d.sent === true ? 'sent' : d.sent === false ? 'failed' : 'queued');
    if (status === 'sent') sent.push(channel);
    else if (FAILED_STATUSES.has(status)) failed.push({ channel, error: d.error ? String(d.error).slice(0, 300) : null });
    // A delivery the transport chose not to send (no real recipient left) did not reach the person.
    else if (status === 'skipped') failed.push({ channel, error: d.payload?.skippedReason || 'not sent' });
    else queued.push(channel);
    const why = d.payload && typeof d.payload === 'object' ? d.payload.fallbackReason : null;
    if (why) fallbackReasons.push({ channel, reason: String(why).slice(0, 500) });
  }
  const sentence = alertSentence({ kind, priority, technicianName, sent, failed, queued, reason });
  try {
    return await ticketActivityRepository.create({
      ticketId: id,
      activityType: ALERT_SENT_ACTIVITY,
      performedBy: 'Ticket Pulse',
      performedAt: at ? new Date(at) : new Date(),
      details: {
        sentence,
        kind,
        priority: priority || null,
        technicianId: technicianId ?? null,
        technicianName: technicianName || null,
        reason: reason || null,
        channels: { sent, failed, queued },
        deliveryIds: list.map((d) => d.id).filter((v) => v !== undefined && v !== null),
        ...(fallbackReasons.length ? { fallbackReasons } : {}),
        actorKind: 'system',
      },
    });
  } catch (error) {
    logger.warn(`Alert history row not written for ticket ${id} (non-fatal): ${error.message}`);
    return null;
  }
}

/**
 * After a batch of queued deliveries was processed: one row per (ticket,
 * person) from the deliveries as they now stand. `context` = { kind, priority,
 * reason, technicianName, technicianNames: { [technicianId]: name } } for the
 * whole batch.
 */
export async function recordAlertActivityForDeliveries(dedupeKeys = [], context = {}) {
  const keys = [...new Set((Array.isArray(dedupeKeys) ? dedupeKeys : []).filter(Boolean))];
  if (!keys.length) return [];
  let rows = [];
  try {
    rows = await prisma.notificationDelivery.findMany({
      where: { dedupeKey: { in: keys } },
      select: { id: true, ticketId: true, technicianId: true, channel: true, status: true, error: true, payload: true, assessedPriority: true },
    });
  } catch (error) {
    logger.warn(`Alert history: deliveries not read (non-fatal): ${error.message}`);
    return [];
  }
  const groups = new Map();
  for (const row of rows || []) {
    const key = `${row.ticketId}:${row.technicianId ?? 'none'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const written = [];
  for (const group of groups.values()) {
    const first = group[0];
    const row = await recordAlertActivity({
      ticketId: first.ticketId,
      technicianId: first.technicianId ?? null,
      technicianName: context.technicianNames?.[first.technicianId] || context.technicianName || null,
      kind: context.kind || 'priority',
      priority: context.priority || first.assessedPriority || null,
      reason: context.reason || first.payload?.reason || null,
      deliveries: group,
    });
    if (row) written.push(row);
  }
  return written;
}

export default {
  ALERT_SENT_ACTIVITY,
  channelWords,
  alertReason,
  alertSentence,
  recordAlertActivity,
  recordAlertActivityForDeliveries,
};
