import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef, ticketSourceLabel } from '../utils/ticketOrigin.js';
import notificationWorkflowEngine from './notificationWorkflowEngine.js';
import statusService, { TERMINAL_BASE_STATUSES } from './statusService.js';
import { buildFieldsUpdatedExtra } from './ticketChangeRenderer.js';

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

/**
 * Workspace-less terminal heuristic (FS ints + substrings) — the pre-8c
 * behavior, kept as the fallback for raw FS payload labels and for callers
 * without a workspace resolver (deriveTicketLifecycleEvents default).
 * A custom label like "Needs Rework" is invisible to this heuristic; the
 * registry-aware resolver below handles it.
 */
function isTerminalStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return false;
  return TERMINAL_STATUS_VALUES.has(value) || value.includes('resolved') || value.includes('closed');
}

/**
 * Registry-aware terminal check for a workspace (Phase 8c): a status is
 * terminal when its BASE is Resolved/Closed per the workspace's status
 * definitions; unknown labels keep the FS-int/substring heuristic so raw
 * FreshService payload values ('4', 'Closed') still resolve. Returns a SYNC
 * predicate so deriveTicketLifecycleEvents stays synchronous.
 */
async function workspaceTerminalResolver(workspaceId) {
  const wsId = Number(workspaceId);
  if (!Number.isFinite(wsId) || wsId <= 0) return isTerminalStatus;
  let knownTerminal = null;
  try {
    // includeInactive: retired custom statuses linger on historical rows and
    // must still resolve their base.
    const rows = await statusService.listStatuses(wsId, { includeInactive: true });
    knownTerminal = new Map(rows.map((r) => [
      r.name.toLowerCase(),
      TERMINAL_BASE_STATUSES.includes(r.baseStatus),
    ]));
  } catch {
    return isTerminalStatus; // registry unreadable → pre-8c behavior
  }
  return (status) => {
    const value = String(status || '').trim().toLowerCase();
    if (!value) return false;
    // Registry rows are AUTHORITATIVE for both directions — a non-terminal
    // custom label must not fall through to a substring match. Heuristics
    // only cover labels the registry has never seen (raw FS values).
    if (knownTerminal.has(value)) return knownTerminal.get(value);
    return isTerminalStatus(value);
  };
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

/**
 * FS-side field diff (TU-10). Tracked fields only — status/assignment have
 * their own events, everything else FreshService can change that a workflow
 * might care about. `undefined` on the upserted side means "not in this
 * payload" (partial list upserts) and never counts as a change.
 */
export const FS_DIFF_FIELDS = Object.freeze([
  'subject', 'priority', 'category', 'subCategory', 'ticketCategory', 'ticketType',
  'dueBy', 'frDueBy', 'groupId', 'ccEmails',
]);

function normalizeDiffValue(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (field === 'dueBy' || field === 'frDueBy') return dateIso(value);
  if (field === 'groupId') return String(value);
  if (field === 'ccEmails') {
    return (Array.isArray(value) ? value : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean).sort();
  }
  if (field === 'priority') return asNumber(value);
  return String(value).trim();
}

export function diffTrackedFields(existingTicket, upsertedTicket) {
  const changes = {};
  if (!existingTicket || !upsertedTicket) return changes;
  for (const field of FS_DIFF_FIELDS) {
    const next = normalizeDiffValue(field, upsertedTicket[field]);
    if (next === undefined) continue;
    const prev = normalizeDiffValue(field, existingTicket[field]);
    if (prev === undefined) continue;
    if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue;
    changes[field] = { from: prev, to: next };
  }
  return changes;
}

export function deriveTicketLifecycleEvents(existingTicket, upsertedTicket, { isTerminal = isTerminalStatus, includeFieldDiff = false } = {}) {
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
    if (isTerminal(upsertedTicket.status)) {
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

  if (!isTerminal(existingTicket.status) && isTerminal(upsertedTicket.status)) {
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

  // FS-side field changes (TU-10, opt-in per trigger node via
  // includeFreshserviceChanges): raw diff here; emitTicketLifecycleNotifications
  // applies the echo guards + actor lookup and renders the payload.
  if (includeFieldDiff) {
    const changes = diffTrackedFields(existingTicket, upsertedTicket);
    const changedFields = Object.keys(changes);
    if (changedFields.length) {
      const stampAt = dateIso(upsertedTicket.freshserviceUpdatedAt) || dateIso(upsertedTicket.updatedAt) || 'live';
      const stamp = `fields:${stableTicketId(upsertedTicket)}:fs:${stampAt}:${changedFields.join(',')}`;
      events.push({
        type: 'ticket.fields_updated',
        occurredAt: dateIso(upsertedTicket.freshserviceUpdatedAt) || new Date().toISOString(),
        dedupeStamp: stamp,
        notificationFingerprint: `${asNumber(upsertedTicket.workspaceId) || asNumber(existingTicket?.workspaceId) || 'workspace'}:ticket.fields_updated:${stamp}`,
        extra: { changes, changedFields, actorKind: 'freshservice', source: 'freshservice_sync' },
      });
    }
  }

  return events;
}

const FS_ECHO_WINDOW_MS = 10 * 60 * 1000;
const TP_OWNED_FS_FIELDS = new Set(['category', 'subCategory', 'ticketCategory', 'tpSkill', 'tpSubskill']);
// A write-back that touched any of these covers the FS category family.
const WRITE_BACK_CATEGORY_KEYS = new Set(['category', 'subCategory', 'ticketCategory', 'internalCategoryId', 'internalSubcategoryId', 'tpSkill', 'tpSubskill']);

/**
 * Echo guard 1 (TU-10): a field set Ticket Pulse itself just wrote to
 * FreshService (fs_write_back audit row ≤10 min) comes back through the sync
 * as an FS-side "change" — it is our own echo, not an update.
 */
async function isFsWriteBackEcho(ticketId, changedFields) {
  try {
    const row = await prisma.ticketActivity.findFirst({
      where: { ticketId, activityType: 'fs_write_back', performedAt: { gte: new Date(Date.now() - FS_ECHO_WINDOW_MS) } },
      orderBy: { performedAt: 'desc' },
      select: { details: true },
    });
    const written = row?.details?.changes && typeof row.details.changes === 'object' ? Object.keys(row.details.changes) : null;
    if (!written || !written.length) return false;
    const writtenSet = new Set(written);
    const categoryWritten = written.some((k) => WRITE_BACK_CATEGORY_KEYS.has(k));
    return changedFields.every((f) => writtenSet.has(f) || (categoryWritten && WRITE_BACK_CATEGORY_KEYS.has(f)));
  } catch {
    return false; // attribution is best-effort — never suppress on a lookup error
  }
}

/**
 * Who changed it in FreshService? Latest cached FS activity line around the
 * FS updated_at (±10 min). Mirrors syncService._resolveFsActor's fallback
 * lane without importing the sync (this module must stay sync-free).
 */
async function resolveFsFieldActor(ticketId, upsertedTicket) {
  try {
    const at = upsertedTicket?.freshserviceUpdatedAt ? new Date(upsertedTicket.freshserviceUpdatedAt).getTime() : Date.now();
    const rows = await prisma.ticketThreadEntry.findMany({
      where: {
        ticketId,
        source: 'freshservice_activity',
        occurredAt: { gte: new Date(at - FS_ECHO_WINDOW_MS), lte: new Date(at + FS_ECHO_WINDOW_MS) },
      },
      orderBy: { occurredAt: 'desc' },
      take: 5,
      select: { actorName: true, content: true },
    });
    const hit = rows.find((r) => r.actorName);
    return hit?.actorName || null;
  } catch {
    return null;
  }
}

/**
 * Turn the raw FS diff event into the full fields_updated payload, or null
 * when the echo guards say it was Ticket Pulse's own write coming back.
 */
async function finalizeFsFieldsUpdatedEvent(event, ticket, upsertedTicket) {
  const raw = event.extra?.changes || {};
  const changedFields = Object.keys(raw);
  if (!changedFields.length) return null;
  if (await isFsWriteBackEcho(ticket.id, changedFields)) return null;
  const actorName = await resolveFsFieldActor(ticket.id, upsertedTicket);
  let changes = raw;
  // Echo guard 2: "Ticket Pulse" acting in FreshService is our AI write-back
  // of the TP category fields — drop those and keep only genuine FS edits.
  if (String(actorName || '').trim().toLowerCase() === 'ticket pulse') {
    changes = Object.fromEntries(Object.entries(raw).filter(([field]) => !TP_OWNED_FS_FIELDS.has(field)));
    if (!Object.keys(changes).length) return null;
  }
  return buildFieldsUpdatedExtra({
    ticket,
    changes,
    actorKind: 'freshservice',
    actorName: actorName || 'FreshService',
    actorEmail: null,
    source: 'freshservice_sync',
    reopened: false,
  });
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


// Compact webhook payload from an event context (gap plan 2 P3) — enough for
// integrations to react without a follow-up read; full detail via /api/v1.
// Carries the internal taxonomy NAMES + customFields (FR 08-05 Phase 1b) so
// API senders can see their intake enrichment round-trip.
export function webhookPayloadFromContext(eventContext) {
  const t = eventContext.ticket || {};
  return {
    ticket: {
      id: t.id,
      ref: t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `TP-${t.id}`,
      subject: t.subject,
      status: t.status,
      statusBase: t.statusBase ?? null,
      priority: t.priority,
      origin: t.origin,
      tags: t.tags || [],
      category: t.internalCategory?.name || null,
      subcategory: t.internalSubcategory?.name || null,
      customFields: t.customFields || {},
    },
    requester: eventContext.requester ? { name: eventContext.requester.name, email: eventContext.requester.email } : null,
    assignedAgent: eventContext.assignedAgent ? { name: eventContext.assignedAgent.name } : null,
    extra: eventContext.event?.extra || null,
  };
}

async function dispatchLifecycleWebhook(eventContext) {
  try {
    const { dispatchWebhookEvent } = await import('./webhookDispatchService.js');
    dispatchWebhookEvent(eventContext.workspace?.id, eventContext.event?.type, webhookPayloadFromContext(eventContext));
  } catch { /* integrations never break the pipeline */ }
}

// A new requester reply may shift their tone — re-classify sentiment
// (debounced; gap plan 2 P5.1). Fire-and-forget like the webhook dispatch.
async function maybeRefreshSentiment(eventContext) {
  if (eventContext.event?.type !== 'ticket.reply_received') return;
  try {
    const { default: ticketSentimentService } = await import('./ticketSentimentService.js');
    ticketSentimentService.scheduleRefresh(eventContext.ticket?.id, eventContext.workspace?.id);
  } catch { /* sentiment is an annotation, never a pipeline step */ }
}

/**
 * How a ticket came to exist (Phase RL, RL-6) — a workflow condition field
 * (`ticket.createdVia`) so "Ticket arrived" acks can tell an app-created
 * ticket from an email one, a hold-queue resolution (`held_reply`), an
 * agent's Cc intake (`agent_cc`), a forwarded mail (`forward`) or an FS
 * sync-in. Explicit value from the create path wins; otherwise derived from
 * the dispatch source + arrival channel.
 *   app | email | api | freshservice_sync | held_reply | agent_cc | forward
 */
export const TICKET_CREATED_VIA = Object.freeze(['app', 'email', 'api', 'freshservice_sync', 'held_reply', 'agent_cc', 'forward']);

export function deriveCreatedVia(ticket, { source = null, createdVia = null } = {}) {
  const explicit = String(createdVia || ticket?.createdVia || '').trim();
  if (TICKET_CREATED_VIA.includes(explicit)) return explicit;
  if (String(source || '') === 'freshservice_sync' || (ticket?.origin && ticket.origin !== 'ticketpulse')) return 'freshservice_sync';
  const channel = Number(ticket?.source);
  if (channel === 1) return 'email';
  if (channel === 100 || channel === 101) return 'api';
  return 'app';
}

export function buildEventContext({ event, ticket, previousAgent, source, statusBase = null, createdVia = null }) {
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
      // Human-facing reference (QA 08-06 #4): "TP-1070" for TP-born tickets,
      // "#225001" for FS-born — the number templates should print.
      displayRef: ticketDisplayRef(ticket),
      nativeNumber: ticket.nativeNumber ?? null,
      subject: ticket.subject,
      descriptionText: ticket.descriptionText,
      status: ticket.status,
      // Base status (Phase 8c): the label's canonical base per the workspace
      // registry, so conditions can match "any Pending-base status" without
      // enumerating custom labels.
      statusBase,
      priority: ticket.priority,
      priorityLabel: priorityLabel(ticket),
      impact: ticket.impact ?? null,
      urgency: ticket.urgency ?? null,
      // Requester sentiment (P5.1) — requester state only, team-safe.
      sentiment: ticket.sentiment || null,
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
      // FS group id (string — BigInt) so `watchers` recipients can resolve
      // group-scoped watch subscriptions (TU-8).
      groupId: ticket.groupId === null || ticket.groupId === undefined ? null : String(ticket.groupId),
      isNoise: ticket.isNoise === true,
      origin: ticket.origin || 'freshservice',
      // Phase RL (RL-6): app | email | api | freshservice_sync | held_reply | agent_cc | forward
      createdVia: deriveCreatedVia(ticket, { source, createdVia }),
      // Arrival channel (QA 07-07 #1): numeric code + friendly label
      // ("Email", "Portal", "Phone", "API", "Agent"…) for conditions.
      source: ticket.source ?? null,
      sourceLabel: ticketSourceLabel(ticket.source),
      // Per-workspace ticket type ("Incident", "Case", …) for conditions.
      ticketType: ticket.ticketType || null,
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
  createdVia = null, // Phase RL (RL-6): in-memory pass-through from createTicket
  // Mail-in agent-Cc intake: ticket.created still fires, but the engine drops
  // the requester recipient (the agent already replied to them).
  suppressRequesterAck = false,
  // Event-level actor kind for the status/assignment events (TU-10): native
  // callers pass the writer's kind; sync sources are 'freshservice'.
  actorKind = null,
} = {}) {
  if (!allowNotificationWorkflows) {
    return { status: 'skipped', reason: 'Notification workflows disabled for this ingest path' };
  }

  // Terminal detection is per-workspace since 8c: a custom "Done" (Resolved
  // base) fires resolved_closed; a custom "Needs Rework" (Pending base) never
  // does. Unknown labels keep the FS-int/substring heuristics.
  const workspaceId = asNumber(upsertedTicket?.workspaceId) || asNumber(existingTicket?.workspaceId);
  const isTerminal = await workspaceTerminalResolver(workspaceId);
  // FS-side field diff only for sync-observed writes (TU-10); TP-native
  // paths emit ticket.fields_updated themselves through ticketService.
  const fromFreshservice = source !== 'ticketpulse_native' && source !== 'preview';
  const events = deriveTicketLifecycleEvents(existingTicket, upsertedTicket, { isTerminal, includeFieldDiff: fromFreshservice });
  if (events.length === 0) return { status: 'skipped', reason: 'No lifecycle notification events' };
  const eventActorKind = actorKind || (fromFreshservice ? 'freshservice' : 'human');
  suppressRequesterAck = suppressRequesterAck === true || upsertedTicket?.suppressRequesterAck === true;

  const ticket = await hydrateTicket(upsertedTicket.id);
  if (!ticket) return { status: 'skipped', reason: 'Ticket not found after upsert' };
  // createdVia is not a column: createTicket stamps it on the in-memory row
  // it hands us (and on the created audit row); re-hydration drops it, so
  // carry it over here before the context is built.
  createdVia = createdVia || upsertedTicket?.createdVia || null;
  const previousAgent = await hydratePreviousAgent(existingTicket);
  const statusBase = await statusService.resolveBaseStatus(ticket.workspaceId, ticket.status).catch(() => null);

  const results = [];
  const emitted = [];
  for (const event of events) {
    // status_changed conditions get the transition's BASES alongside the
    // names ("left an Open-base status", "entered any Pending-base status").
    if (event.type === 'ticket.status_changed' && event.extra) {
      event.extra = {
        ...event.extra,
        fromBase: await statusService.resolveBaseStatus(ticket.workspaceId, event.extra.from).catch(() => null),
        toBase: await statusService.resolveBaseStatus(ticket.workspaceId, event.extra.to).catch(() => null),
      };
    }
    if (event.type === 'ticket.fields_updated') {
      const extra = await finalizeFsFieldsUpdatedEvent(event, ticket, upsertedTicket);
      if (!extra) continue; // our own write-back echo — not an update
      event.extra = extra;
    } else {
      // Provenance on every lifecycle event (TU-10): lets admins filter the
      // Closed→Open→Closed sync echoes from human/API changes.
      event.extra = { ...(event.extra || {}), actorKind: eventActorKind, source };
      if (event.type === 'ticket.created' && suppressRequesterAck) event.extra.suppressRequesterAck = true;
    }
    emitted.push(event.type);
    const eventContext = buildEventContext({ event, ticket, previousAgent, source, statusBase, createdVia });
    dispatchLifecycleWebhook(eventContext);
    maybeRefreshSentiment(eventContext);
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

  if (emitted.length === 0) return { status: 'skipped', reason: 'FreshService write-back echo' };
  return {
    status: 'completed',
    events: emitted,
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
  const statusBase = await statusService.resolveBaseStatus(ticket.workspaceId, ticket.status).catch(() => null);
  const eventContext = buildEventContext({ event, ticket, previousAgent: null, source, statusBase });
  if (extra) eventContext.event.extra = extra;
  dispatchLifecycleWebhook(eventContext);
  maybeRefreshSentiment(eventContext);

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
  diffTrackedFields,
  deriveCreatedVia,
  emitTicketLifecycleNotifications,
  emitTicketEvent,
  lifecycleNotificationFingerprint,
};
