/**
 * Priority history (QA 11-23 item 2).
 *
 * Every change to tickets.priority leaves ONE `ticket_activities` row of type
 * `priority_changed`, whoever made it: the requester's status link, an agent in
 * the app, the AI assessment, a workflow, the v1 API (integration or personal
 * key), the same-day repeat bump, or the FreshService sync. Before this the
 * requester's urgency raise left no history at all (TP-1042 went to Urgent with
 * only an urgent_escalation_events row), and the other paths each wrote their
 * own shape (fields_updated, workflow_updated_ticket, nothing).
 *
 * Row: activityType 'priority_changed', performedBy = the actor's name,
 * details = { from, to, fromId, toId, source, actorKind, actorName, actorEmail,
 * via?, note?, ...context }. from/to are labels (Low | Medium | High | Urgent),
 * from may be null when the old value was unknown.
 *
 * Also here: the "why this priority" line for the ticket payload, and the weekly
 * "the requester raised it" list for coordinators.
 */
import prisma from './prisma.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import logger from '../utils/logger.js';
import { PRIORITY_ID_TO_LABEL, PRIORITY_LABEL_TO_ID } from './priorityAssessment.js';
import { actorKindOf } from '../utils/actorKind.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

export const PRIORITY_CHANGED_ACTIVITY = 'priority_changed';

export const PRIORITY_CHANGE_SOURCES = Object.freeze([
  'requester_link',
  'agent',
  'ai_assessment',
  'workflow',
  'api',
  'personal_key',
  'repeat_report',
  'sync',
]);

const SOURCE_ACTOR_KIND = Object.freeze({
  requester_link: 'human',
  agent: 'human',
  ai_assessment: 'ai',
  workflow: 'workflow',
  api: 'api',
  personal_key: 'personal_key',
  repeat_report: 'system',
  sync: 'freshservice_sync',
});

const SOURCE_DEFAULT_NAME = Object.freeze({
  requester_link: 'Requester',
  ai_assessment: 'Ticket Pulse AI',
  workflow: 'Workflow',
  api: 'API',
  repeat_report: 'Ticket Pulse',
  sync: 'FreshService',
});

/** A second identical row inside this window is the same change seen twice. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const NOTE_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "Urgent" for 4, '4', 'urgent' or 'Urgent'; null for anything else. */
export function priorityLabelOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n) && PRIORITY_ID_TO_LABEL[n]) return PRIORITY_ID_TO_LABEL[n];
  const text = String(value).trim().toLowerCase();
  return Object.keys(PRIORITY_LABEL_TO_ID).find((label) => label.toLowerCase() === text) || null;
}

export function priorityIdOf(value) {
  const label = priorityLabelOf(value);
  return label ? PRIORITY_LABEL_TO_ID[label] : null;
}

/** Which source a ticketService actor stands for (agent, api, personal key, workflow…). */
export function prioritySourceForActor(actor) {
  if (actor?.via?.kind === 'personal_key') return 'personal_key';
  const kind = actorKindOf(actor);
  if (kind === 'api') return 'api';
  if (kind === 'workflow') return 'workflow';
  if (kind === 'ai') return 'ai_assessment';
  if (kind === 'freshservice_sync' || kind === 'reconcile') return 'sync';
  return 'agent';
}

function cleanNote(note) {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function isDuplicate(ticketId, fromLabel, toLabel, at) {
  try {
    const last = await prisma.ticketActivity.findFirst({
      where: { ticketId, activityType: PRIORITY_CHANGED_ACTIVITY },
      orderBy: { performedAt: 'desc' },
      select: { performedAt: true, details: true },
    });
    if (!last?.details) return false;
    const close = Math.abs(new Date(last.performedAt).getTime() - at.getTime()) <= DUPLICATE_WINDOW_MS;
    return close && last.details.to === toLabel && (last.details.from ?? null) === (fromLabel ?? null);
  } catch {
    return false; // a failed lookup never costs the history row
  }
}

/**
 * Record one priority change. Never throws; returns the row, or null when there
 * was nothing to record (same level, unknown target, a duplicate) or the write
 * failed.
 *
 * @param {object} p
 * @param {number} p.ticketId
 * @param {number|string|null} p.from   old priority (id 1–4 or label)
 * @param {number|string} p.to          new priority (id 1–4 or label)
 * @param {string} [p.source]           one of PRIORITY_CHANGE_SOURCES; derived from `actor` when absent
 * @param {object} [p.actor]            ticketService-style actor { name, email, role, via }
 * @param {string} [p.actorKind]        overrides the kind derived from actor/source
 * @param {string} [p.actorName]
 * @param {string} [p.actorEmail]
 * @param {object} [p.via]              e.g. { kind: 'personal_key', keyId, keyName }
 * @param {string} [p.note]             one plain sentence (why), shown under the line
 * @param {Date}   [p.at]
 * @param {object} [p.details]          extra context (run id, event id…); never overrides the contract keys
 */
export async function recordPriorityChange({
  ticketId,
  from = null,
  to,
  source = null,
  actor = null,
  actorKind = null,
  actorName = null,
  actorEmail = null,
  via = null,
  note = null,
  at = null,
  details: extra = null,
} = {}) {
  const id = Number(ticketId);
  const toLabel = priorityLabelOf(to);
  if (!Number.isInteger(id) || id <= 0 || !toLabel) return null;
  const fromLabel = priorityLabelOf(from);
  if (fromLabel === toLabel) return null;

  const src = PRIORITY_CHANGE_SOURCES.includes(source) ? source : prioritySourceForActor(actor);
  const kind = actorKind
    || (actor
      ? (actor.via?.kind === 'personal_key' ? 'personal_key' : actorKindOf(actor))
      : SOURCE_ACTOR_KIND[src]);
  const name = String(actorName || actor?.name || actor?.email || SOURCE_DEFAULT_NAME[src] || 'Ticket Pulse').slice(0, 255);
  const email = actorEmail ?? actor?.email ?? null;
  const viaValue = via || (actor?.via?.kind === 'personal_key'
    ? { kind: 'personal_key', keyId: actor.via.keyId ?? null, keyName: actor.via.keyName ?? null }
    : null);
  const when = at ? new Date(at) : new Date();
  const cleanedNote = cleanNote(note);

  if (await isDuplicate(id, fromLabel, toLabel, when)) return null;

  try {
    return await ticketActivityRepository.create({
      ticketId: id,
      activityType: PRIORITY_CHANGED_ACTIVITY,
      performedBy: name,
      performedAt: when,
      details: {
        ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
        from: fromLabel,
        to: toLabel,
        fromId: fromLabel ? PRIORITY_LABEL_TO_ID[fromLabel] : null,
        toId: PRIORITY_LABEL_TO_ID[toLabel],
        source: src,
        actorKind: kind,
        actorName: name,
        actorEmail: email,
        ...(viaValue ? { via: viaValue } : {}),
        ...(cleanedNote ? { note: cleanedNote } : {}),
      },
    });
  } catch (error) {
    logger.warn(`Priority history row not written for ticket ${id} (non-fatal): ${error.message}`);
    return null;
  }
}

/**
 * The "Why this priority" line (contract: { level, source, actorName, at, note } | null).
 * The latest priority_changed row when it still describes the current priority;
 * otherwise the assessment rationale when it describes the current priority;
 * otherwise null — never a reason for a level the ticket no longer has.
 *
 * @param {object} ticket      the ticket row (priority, assessedPriority(Id), priorityRationale, …)
 * @param {Array}  activities  its ticket_activities rows (any order)
 */
export function priorityReasonFrom(ticket, activities = []) {
  if (!ticket) return null;
  const current = priorityLabelOf(ticket.priority);
  const rows = (Array.isArray(activities) ? activities : [])
    .filter((a) => a?.activityType === PRIORITY_CHANGED_ACTIVITY && a.details && typeof a.details === 'object')
    .sort((a, b) => new Date(b.performedAt).getTime() - new Date(a.performedAt).getTime());
  const latest = rows[0];
  if (latest && (!current || latest.details.to === current)) {
    return {
      level: latest.details.to || current,
      source: latest.details.source || null,
      actorName: latest.details.actorName || latest.performedBy || null,
      at: iso(latest.performedAt),
      note: latest.details.note || null,
    };
  }

  const rationale = cleanNote(ticket.priorityRationale);
  if (!rationale) return null;
  const assessed = priorityLabelOf(ticket.assessedPriority) || priorityLabelOf(ticket.assessedPriorityId);
  if (current && assessed && assessed !== current) return null;
  const byRequester = String(ticket.priorityConfidence || '').toLowerCase() === 'requester';
  return {
    level: assessed || current,
    source: byRequester ? 'requester_link' : 'ai_assessment',
    actorName: byRequester ? (ticket.requester?.name || ticket.requester?.email || 'Requester') : 'Ticket Pulse AI',
    at: iso(ticket.priorityAssessedAt),
    note: rationale,
  };
}

/**
 * priorityReasonFrom for a ticket whose history is not loaded (the Assignment
 * Review run detail): reads its latest priority_changed row. Never throws; a
 * failed read falls back to the rationale.
 */
export async function priorityReasonForTicket(ticket) {
  if (!ticket?.id) return null;
  let rows = [];
  try {
    const latest = await prisma.ticketActivity.findFirst({
      where: { ticketId: Number(ticket.id), activityType: PRIORITY_CHANGED_ACTIVITY },
      orderBy: { performedAt: 'desc' },
      select: { activityType: true, performedBy: true, performedAt: true, details: true },
    });
    rows = latest ? [latest] : [];
  } catch (error) {
    logger.warn(`Priority reason: history not read for ticket ${ticket.id} (${error.message})`);
  }
  return priorityReasonFrom(ticket, rows);
}

const RAISE_SOURCES = Object.freeze(['business_urgency', 'self_service']);
const LOW_AI_LEVELS = new Set(['Low', 'Medium']);

function payloadOf(event) {
  return event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
}

/**
 * The AI's own level before the raise. New events carry it on the payload
 * (fromAssessedPriority); older ones fall back to the last completed AI run
 * before the raise.
 */
async function aiLevelsBefore(events, workspaceId) {
  const levels = new Map(); // eventId -> label | null
  const missing = [];
  for (const event of events) {
    const payload = payloadOf(event);
    // A level an earlier requester raise wrote is not the AI's.
    const label = payload.fromAssessedBy === 'requester' ? null : priorityLabelOf(payload.fromAssessedPriority);
    if (label) levels.set(event.id, label);
    else missing.push(event);
  }
  if (!missing.length) return levels;
  try {
    const ticketIds = [...new Set(missing.map((e) => e.ticketId))];
    const runs = await prisma.assignmentPipelineRun.findMany({
      where: { workspaceId, ticketId: { in: ticketIds }, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, ticketIds.length * 10),
      select: { ticketId: true, createdAt: true, recommendation: true },
    });
    for (const event of missing) {
      const raisedAt = new Date(event.createdAt).getTime();
      const run = (runs || []).find((r) => r.ticketId === event.ticketId
        && new Date(r.createdAt).getTime() < raisedAt
        && priorityLabelOf(r.recommendation?.assessedPriority));
      levels.set(event.id, run ? priorityLabelOf(run.recommendation.assessedPriority) : null);
    }
  } catch (error) {
    logger.warn(`Priority raises: AI level lookup failed (${error.message}); older raises are left out`);
  }
  return levels;
}

/**
 * Weekly "the requester raised it" list: tickets the AI had at Medium or Low
 * that the requester raised from their status link (urgency raise or after-hours
 * escalation). One row per ticket (its earliest raise in the window against an
 * AI level of Low or Medium), newest first. Read-only.
 *
 * @returns {Promise<Array<{ ticketId, displayRef, subject, aiPriority, raisedTo, raisedAt, requesterName }>>}
 */
export async function listRequesterPriorityRaises({ workspaceId, days = 7, now = new Date() } = {}) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return [];
  const span = Math.min(90, Math.max(1, Math.floor(Number(days)) || 7));
  const since = new Date(new Date(now).getTime() - span * DAY_MS);

  const events = await prisma.urgentEscalationEvent.findMany({
    where: { workspaceId: ws, source: { in: [...RAISE_SOURCES] }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      id: true,
      ticketId: true,
      source: true,
      createdAt: true,
      payload: true,
      ticket: {
        select: {
          id: true,
          workspaceId: true,
          origin: true,
          nativeNumber: true,
          freshserviceTicketId: true,
          subject: true,
          requester: { select: { name: true, email: true } },
        },
      },
    },
  });

  // A second raise of the same ticket sees the Urgent the first raise wrote, not
  // the AI's level. So per ticket the row is its EARLIEST raise in the window
  // whose earlier AI level was Low or Medium (second-look review, QA 11-23).
  const withTicket = (events || []).filter((event) => event?.ticket);
  const aiLevels = await aiLevelsBefore(withTicket, ws);
  const chosen = new Map(); // ticketId -> event
  for (const event of [...withTicket].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    if (chosen.has(event.ticketId) || !LOW_AI_LEVELS.has(aiLevels.get(event.id))) continue;
    chosen.set(event.ticketId, event);
  }
  return [...chosen.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((event) => {
      const payload = payloadOf(event);
      const ticket = event.ticket;
      return {
        ticketId: ticket.id,
        displayRef: ticketDisplayRef(ticket),
        subject: ticket.subject || null,
        aiPriority: aiLevels.get(event.id),
        raisedTo: priorityLabelOf(payload.toPriorityLabel) || 'Urgent',
        raisedAt: iso(event.createdAt),
        requesterName: ticket.requester?.name || ticket.requester?.email || null,
      };
    });
}

export default {
  PRIORITY_CHANGED_ACTIVITY,
  PRIORITY_CHANGE_SOURCES,
  priorityLabelOf,
  priorityIdOf,
  prioritySourceForActor,
  recordPriorityChange,
  priorityReasonFrom,
  priorityReasonForTicket,
  listRequesterPriorityRaises,
};
