import prisma from './prisma.js';
import {
  DEFAULT_WORKFLOW_SPECS,
  NOTIFICATION_EVENT_TYPES,
  assertValidWorkflowDefinition,
  buildDefaultWorkflowDefinition,
  defaultWorkflowMetadataForSpec,
  sampleEventContext,
  validateWorkflowDefinition,
} from './notificationWorkflowDefinition.js';
import {
  normalizeRoutingMode,
  normalizeRoutingPriority,
  normalizeRoutingRule,
} from './notificationWorkflowRoutingService.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

function actorEmail(actor = null) {
  return String(actor?.email || actor || '').trim() || null;
}

function normalizeId(value, label = 'workflow id') {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ValidationError(`Invalid ${label}`);
  }
  return id;
}

function parseLimit(value, fallback = 50, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function assertKnownEventType(triggerType) {
  const normalized = String(triggerType || '').trim();
  if (!NOTIFICATION_EVENT_TYPES.includes(normalized)) {
    throw new ValidationError('Unsupported workflow event type');
  }
  return normalized;
}

function slugPart(value) {
  const text = String(value || '').trim();
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36) || 'custom';
}

async function uniqueWorkflowKey(workspaceId, triggerType, name) {
  const base = `${triggerType.replace('ticket.', 'ticket_').replace(/\./g, '_')}_${slugPart(name)}`.slice(0, 72);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const key = attempt === 0 ? base : `${base.slice(0, 72 - String(attempt).length - 1)}_${attempt}`;
    const existing = await prisma.notificationWorkflow.findFirst({
      where: { workspaceId, key },
      select: { id: true },
    });
    if (!existing) return key;
  }
  throw new ValidationError('Unable to create a unique workflow key');
}

function defaultRoutingPriorityForSpec(spec) {
  return spec.scheduleMode === 'after_hours' ? 20 : 100;
}

function defaultRoutingPriorityForVariant(source = null) {
  if (!source || source.isDefaultVariant) return 1;
  return Math.min(999, normalizeRoutingPriority(source.routingPriority, 1) + 1);
}

function routingDataFromInput(data = {}, fallback = {}) {
  return {
    routingMode: normalizeRoutingMode(data.routingMode ?? fallback.routingMode),
    routingPriority: normalizeRoutingPriority(data.routingPriority ?? fallback.routingPriority),
    routingRule: normalizeRoutingRule(data.routingRule ?? fallback.routingRule ?? null),
  };
}

// Event labels the audit list shows, so "ticket assigned" or "requester
// replied" finds runs by their event, not only by the raw "ticket.assigned".
const AUDIT_EVENT_SEARCH_LABELS = Object.freeze({
  // The list says "during business hours" or "after-hours / holiday".
  'ticket.created': 'Ticket arrived during business hours / after-hours / holiday',
  'ticket.assigned': 'Ticket assigned',
  'ticket.reassigned': 'Ticket reassigned',
  'ticket.resolved_closed': 'Resolved or closed',
  'ticket.reply_received': 'Requester replied',
  'ticket.note_added': 'Internal note added',
  'ticket.status_changed': 'Status changed',
  'ticket.reopened': 'Ticket reopened',
  'ticket.priority_changed': 'Priority changed',
  'ticket.parked': 'Ticket parked',
  'ticket.woke': 'Parked ticket woke',
  'ticket.park_due_soon': 'Parked ticket wakes within a day',
  'ticket.categorized': 'Ticket categorized',
  'ticket.intake_settled': 'Ticket intake settled',
  'ticket.ready': 'Ticket ready',
  'auto_help.staged': 'Auto-help suggested an answer',
  'auto_help.answered': 'Auto-help answer sent',
  'auto_help.nudged': 'Auto-help checked in',
  'auto_help.help_requested': 'Requester still needs help',
  'auto_help.resolved': 'Auto-help closed the ticket',
  'ticket.fields_updated': 'Ticket updated (fields)',
  'ticket.public_reply_added': 'Agent replied to requester',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'approval.clarification_requested': 'Approval clarification requested',
  'ticket.aging': 'Ticket unresolved for N hours',
  'ticket.unassigned_for': 'Ticket unassigned for N hours',
  'ticket.requester_silent_for': 'Requester silent for N hours',
  'ticket.sla_pre_breach': 'SLA about to breach',
  'ticket.sla_breach': 'SLA breached',
  'schedule.time': 'On a schedule (digest)',
  manual: 'Manual / sub-workflow only',
});

const PG_INT_MAX = 2147483647;

function intOrNull(digits) {
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 && value <= PG_INT_MAX ? value : null;
}

function bigIntOrNull(digits) {
  try {
    const value = BigInt(digits);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Where-clause for the Workflow Audit search box (QA 10-15).
 *
 * Matches what people type when they look for a run:
 *  - "10029"      → TP-born ticket TP-10029, FreshService #10029, or run TP-NWF-10029
 *  - "TP-10029", "tp10029", "TP 10029" → Ticket Pulse native number
 *  - "#247279"    → FreshService ticket number
 *  - "TP-NWF-77", "NWF-77" → the audit (run) id
 *  - "TP-ID-501"  → internal ticket id
 *  - text         → subject, workflow name/key, event type or event label
 * The workspace scope stays on the outer where; this only adds an OR.
 */
export function runSearchFilter(search) {
  const trimmed = String(search || '').trim();
  if (!trimmed) return null;
  const or = [
    { workflow: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
    { workflow: { is: { key: { contains: trimmed, mode: 'insensitive' } } } },
    { ticket: { is: { subject: { contains: trimmed, mode: 'insensitive' } } } },
    { eventType: { contains: trimmed, mode: 'insensitive' } },
  ];

  const lower = trimmed.toLowerCase();
  const eventTypes = Object.entries(AUDIT_EVENT_SEARCH_LABELS)
    .filter(([type, label]) => (
      label.toLowerCase().includes(lower)
      || type.replace(/[._]/g, ' ').includes(lower)
    ))
    .map(([type]) => type);
  if (eventTypes.length > 0) or.push({ eventType: { in: eventTypes } });

  const auditIdMatch = trimmed.match(/^(?:TP[-\s]?)?NWF[-\s]?(\d+)$/i);
  const ticketIdMatch = trimmed.match(/^TP[-\s]?ID[-\s]?(\d+)$/i);
  const nativeMatch = trimmed.match(/^TP[-\s#]?(\d+)$/i);
  const freshserviceMatch = trimmed.match(/^#\s*(\d+)$/);
  const digitsMatch = trimmed.match(/^\d+$/);

  if (auditIdMatch) {
    const id = intOrNull(auditIdMatch[1]);
    if (id) or.push({ id });
  } else if (ticketIdMatch) {
    const id = intOrNull(ticketIdMatch[1]);
    if (id) or.push({ ticketId: id });
  } else if (nativeMatch) {
    const nativeNumber = intOrNull(nativeMatch[1]);
    if (nativeNumber) or.push({ ticket: { is: { nativeNumber } } });
  } else if (freshserviceMatch) {
    const freshserviceTicketId = bigIntOrNull(freshserviceMatch[1]);
    if (freshserviceTicketId) or.push({ ticket: { is: { freshserviceTicketId } } });
  } else if (digitsMatch) {
    const number = intOrNull(trimmed);
    if (number) {
      or.push({ id: number });
      or.push({ ticket: { is: { nativeNumber: number } } });
    }
    const freshserviceTicketId = bigIntOrNull(trimmed);
    if (freshserviceTicketId) or.push({ ticket: { is: { freshserviceTicketId } } });
  }
  return { OR: or };
}

async function getWorkflowOrThrow(workspaceId, id) {
  const workflow = await prisma.notificationWorkflow.findFirst({
    where: { id: normalizeId(id), workspaceId },
  });
  if (!workflow) throw new NotFoundError('Notification workflow not found');
  return workflow;
}

// The seven default-variant upserts used to run on EVERY list call —
// sequential round trips, each a write — and the Mail Workflows page waited
// on them before painting anything (QA 09-22 #10). The list now seeds a
// workspace at most once per ten minutes; create/install paths still call
// ensureDefaultWorkflows directly.
const DEFAULTS_SEEDED_TTL_MS = 10 * 60 * 1000;
const defaultsSeededAt = new Map();

export function resetDefaultWorkflowsMemo() {
  defaultsSeededAt.clear();
}

async function ensureDefaultWorkflowsMemo(workspaceId) {
  const last = defaultsSeededAt.get(workspaceId) || 0;
  if (Date.now() - last < DEFAULTS_SEEDED_TTL_MS) return;
  await ensureDefaultWorkflows(workspaceId);
  defaultsSeededAt.set(workspaceId, Date.now());
}

export async function ensureDefaultWorkflows(workspaceId, actor = null) {
  const changedBy = actorEmail(actor);
  const results = [];

  for (const spec of DEFAULT_WORKFLOW_SPECS) {
    const metadata = defaultWorkflowMetadataForSpec(spec);
    const draftDefinition = buildDefaultWorkflowDefinition(spec.triggerType, {
      scheduleMode: spec.scheduleMode,
    });
    const workflow = await prisma.notificationWorkflow.upsert({
      where: {
        workspaceId_key: {
          workspaceId,
          key: metadata.key,
        },
      },
      create: {
        workspaceId,
        key: metadata.key,
        name: metadata.name,
        description: metadata.description,
        triggerType: metadata.triggerType,
        routingMode: 'exclusive',
        routingPriority: defaultRoutingPriorityForSpec(spec),
        routingRule: null,
        isDefaultVariant: true,
        archivedAt: null,
        archivedBy: null,
        draftDefinition,
        lastChangedBy: changedBy,
      },
      update: {
        routingMode: 'exclusive',
        routingPriority: defaultRoutingPriorityForSpec(spec),
        isDefaultVariant: true,
        // A retirable default (the seeded reopen workflow) stays archived once
        // the "When a requester replies" page retired it; the others are
        // never archived and are put right here.
        ...(spec.retirable ? {} : { archivedAt: null, archivedBy: null }),
      },
    });
    results.push(workflow);
  }

  return results;
}

export async function listWorkflows(workspaceId) {
  await ensureDefaultWorkflowsMemo(workspaceId);
  return prisma.notificationWorkflow.findMany({
    where: { workspaceId },
    orderBy: [
      { triggerType: 'asc' },
      { isDefaultVariant: 'desc' },
      { archivedAt: 'asc' },
      { routingPriority: 'asc' },
      { name: 'asc' },
    ],
    include: {
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          eventType: true,
          startedAt: true,
          completedAt: true,
          error: true,
          dryRun: true,
          executionMode: true,
        },
      },
      _count: {
        select: {
          runs: true,
        },
      },
    },
  });
}

export async function getWorkflow(workspaceId, id) {
  await ensureDefaultWorkflowsMemo(workspaceId);
  const workflow = await prisma.notificationWorkflow.findFirst({
    where: { id: normalizeId(id), workspaceId },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 10,
      },
    },
  });
  if (!workflow) throw new NotFoundError('Notification workflow not found');
  return workflow;
}

export async function saveDraft(workspaceId, id, data = {}, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  if (workflow.archivedAt) throw new ValidationError('Restore the workflow variant before editing its draft');
  const draftDefinition = assertValidWorkflowDefinition(data.definition || data.draftDefinition, {
    triggerType: workflow.triggerType,
  });

  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      name: String(data.name || workflow.name).trim() || workflow.name,
      description: data.description === undefined ? workflow.description : String(data.description || '').trim() || null,
      draftDefinition,
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function publishWorkflow(workspaceId, id, data = {}, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  if (workflow.archivedAt) throw new ValidationError('Restore the workflow variant before publishing it');
  const definition = assertValidWorkflowDefinition(workflow.draftDefinition, {
    triggerType: workflow.triggerType,
  });
  if (
    workflow.publishedDefinition
    && JSON.stringify(definition) === JSON.stringify(workflow.publishedDefinition)
  ) {
    throw new ValidationError('No draft changes to publish');
  }
  const validationResult = validateWorkflowDefinition(definition, { triggerType: workflow.triggerType });
  const nextVersion = workflow.publishedVersion + 1;
  const changedBy = actorEmail(actor);
  const hasEnabledOverride = Object.prototype.hasOwnProperty.call(data || {}, 'enabled');
  const nextIsEnabled = hasEnabledOverride
    ? data.enabled === true || data.enabled === 'true'
    : true;

  return prisma.$transaction(async (tx) => {
    const version = await tx.notificationWorkflowVersion.create({
      data: {
        workspaceId,
        workflowId: workflow.id,
        version: nextVersion,
        definition,
        validationResult,
        changeNote: data.changeNote ? String(data.changeNote).trim() : null,
        publishedBy: changedBy,
      },
    });

    const updated = await tx.notificationWorkflow.update({
      where: { id: workflow.id },
      data: {
        publishedDefinition: definition,
        publishedVersion: nextVersion,
        lastPublishedAt: version.publishedAt,
        isEnabled: nextIsEnabled,
        enabledAt: nextIsEnabled ? version.publishedAt : workflow.enabledAt,
        lastChangedBy: changedBy,
      },
    });

    return { workflow: updated, version };
  });
}

export async function setWorkflowEnabled(workspaceId, id, enabled, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  if (workflow.archivedAt) throw new ValidationError('Restore the workflow variant before enabling it');
  const isEnabled = enabled === true || enabled === 'true';
  if (isEnabled && !workflow.publishedDefinition) {
    throw new ValidationError('Publish the workflow before enabling it');
  }

  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      isEnabled,
      enabledAt: isEnabled ? new Date() : workflow.enabledAt,
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function setWorkflowMockMode(workspaceId, id, enabled, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  if (workflow.archivedAt) throw new ValidationError('Restore the workflow variant before changing mock mode');
  const isEnabled = enabled === true || enabled === 'true';
  if (isEnabled && !workflow.publishedDefinition) {
    throw new ValidationError('Publish the workflow before enabling mock mode');
  }
  // Mock mode is independent of live-enable: you may arm mock on a disabled
  // (but published) workflow so it is already in safe test mode before going live.

  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      mockModeEnabled: isEnabled,
      mockModeEnabledAt: isEnabled ? new Date() : null,
      mockModeUpdatedBy: actorEmail(actor),
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function listEnabledForEvent(workspaceId, eventType) {
  // Any registered event can drive workflows — not just those with default specs.
  if (!NOTIFICATION_EVENT_TYPES.includes(eventType)) return [];
  return prisma.notificationWorkflow.findMany({
    where: {
      workspaceId,
      triggerType: eventType,
      isEnabled: true,
      publishedVersion: { gt: 0 },
      archivedAt: null,
    },
    orderBy: [{ routingPriority: 'asc' }, { id: 'asc' }],
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });
}

export async function createWorkflowVariant(workspaceId, data = {}, actor = null) {
  const sourceId = data.sourceWorkflowId ? normalizeId(data.sourceWorkflowId, 'source workflow id') : null;
  const source = sourceId ? await getWorkflowOrThrow(workspaceId, sourceId) : null;
  const triggerType = assertKnownEventType(source?.triggerType || data.triggerType);
  const sourceName = source ? `${source.name} variant` : `${triggerType.replace('ticket.', 'Ticket ')} variant`;
  const name = String(data.name || sourceName).trim().slice(0, 160) || sourceName;
  const description = data.description === undefined
    ? (source ? `Draft variant copied from ${source.name}` : null)
    : String(data.description || '').trim() || null;
  const routing = routingDataFromInput(data, {
    routingMode: source?.routingMode || 'exclusive',
    routingPriority: defaultRoutingPriorityForVariant(source),
    routingRule: source?.routingRule || null,
  });
  const draftDefinition = assertValidWorkflowDefinition(
    data.draftDefinition || data.definition || source?.draftDefinition || buildDefaultWorkflowDefinition(triggerType),
    { triggerType },
  );
  const key = await uniqueWorkflowKey(workspaceId, triggerType, name);

  return prisma.notificationWorkflow.create({
    data: {
      workspaceId,
      key,
      name,
      description,
      triggerType,
      routingMode: routing.routingMode,
      routingPriority: routing.routingPriority,
      routingRule: routing.routingRule,
      isDefaultVariant: false,
      archivedAt: null,
      archivedBy: null,
      draftDefinition,
      publishedDefinition: null,
      publishedVersion: 0,
      isEnabled: false,
      mockModeEnabled: false,
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function duplicateWorkflowVariant(workspaceId, id, data = {}, actor = null) {
  return createWorkflowVariant(workspaceId, {
    ...data,
    sourceWorkflowId: id,
    name: data.name || null,
  }, actor);
}

/**
 * Change a workflow's trigger event (QA 07-07 #3 — triggers were read-only).
 * Preserves the graph, retargets the trigger node (seeding slot defaults for
 * schedule.time), and re-validates against the new event. A live workflow is
 * disabled: its published definition still carries the old trigger, so it
 * must be reviewed and re-published before running again.
 */
export async function changeWorkflowTrigger(workspaceId, id, newTriggerType, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  const triggerType = assertKnownEventType(newTriggerType);
  if (triggerType === workflow.triggerType) return workflow;
  if (workflow.isDefaultVariant) {
    throw new ValidationError('Default variants anchor their trigger group — duplicate the workflow to move it to another trigger');
  }
  if (workflow.archivedAt) throw new ValidationError('Restore the workflow before changing its trigger');

  const definition = JSON.parse(JSON.stringify(workflow.draftDefinition || buildDefaultWorkflowDefinition(triggerType)));
  const triggerNode = (definition.nodes || []).find((node) => node.type === 'trigger');
  if (!triggerNode) throw new ValidationError('Workflow draft has no trigger node');
  triggerNode.data = { ...triggerNode.data, triggerType };
  if (triggerType === 'schedule.time') {
    // Scheduled triggers need slot config to validate before the admin tunes it.
    triggerNode.data.frequency = triggerNode.data.frequency || 'daily';
    triggerNode.data.time = triggerNode.data.time || '08:30';
  }
  const draftDefinition = assertValidWorkflowDefinition(definition, { triggerType });

  const wasLive = workflow.isEnabled && workflow.publishedVersion > 0;
  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      triggerType,
      draftDefinition,
      // The published definition still targets the old event — take it out
      // of live rotation until the admin re-publishes on the new trigger.
      ...(wasLive ? { isEnabled: false } : {}),
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function updateWorkflowRouting(workspaceId, id, data = {}, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  const routing = routingDataFromInput(data, workflow);
  const updateData = {
    routingMode: routing.routingMode,
    routingPriority: routing.routingPriority,
    routingRule: routing.routingRule,
    lastChangedBy: actorEmail(actor),
  };

  // QA 09-23 #8: "stop other workflows for this ticket change".
  if (Object.prototype.hasOwnProperty.call(data, 'stopFurtherWorkflows')) {
    updateData.stopFurtherWorkflows = data.stopFurtherWorkflows === true;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'isDefaultVariant')) {
    if (workflow.isDefaultVariant && data.isDefaultVariant !== true) {
      throw new ValidationError('Default workflow variants cannot be removed through routing settings');
    }
    updateData.isDefaultVariant = data.isDefaultVariant === true;
  }

  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: updateData,
  });
}

/**
 * `allowDefaultVariant`: only the "When a requester replies" page passes it,
 * to retire the seeded "Reopen on requester reply" default when it takes the
 * reopen over (14 Oct 2026). Every other caller keeps the rule that a default
 * variant is disabled, never archived. Restoring is always allowed.
 */
export async function setWorkflowArchived(workspaceId, id, archived, actor = null, { allowDefaultVariant = false } = {}) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  const nextArchived = archived === true || archived === 'true';
  if (workflow.isDefaultVariant && nextArchived && !allowDefaultVariant) {
    throw new ValidationError('Default workflow variants cannot be archived');
  }

  return prisma.notificationWorkflow.update({
    where: { id: workflow.id },
    data: {
      archivedAt: nextArchived ? new Date() : null,
      archivedBy: nextArchived ? actorEmail(actor) : null,
      isEnabled: nextArchived ? false : workflow.isEnabled,
      mockModeEnabled: nextArchived ? false : workflow.mockModeEnabled,
      mockModeEnabledAt: nextArchived ? null : workflow.mockModeEnabledAt,
      lastChangedBy: actorEmail(actor),
    },
  });
}

export async function deleteArchivedWorkflowVariant(workspaceId, id) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  if (workflow.isDefaultVariant) {
    throw new ValidationError('Default workflow variants cannot be deleted');
  }
  if (!workflow.archivedAt) {
    throw new ValidationError('Archive the workflow variant before deleting it');
  }

  return prisma.$transaction(async (tx) => {
    const runs = await tx.notificationWorkflowRun.findMany({
      where: { workspaceId, workflowId: workflow.id },
      select: { id: true },
    });
    const runIds = runs.map((run) => run.id);
    const steps = runIds.length
      ? await tx.notificationWorkflowStepRun.findMany({
        where: { workspaceId, runId: { in: runIds } },
        select: { id: true },
      })
      : [];
    const stepIds = steps.map((step) => step.id);

    if (runIds.length || stepIds.length) {
      await tx.notificationDelivery.deleteMany({
        where: {
          workspaceId,
          OR: [
            ...(runIds.length ? [{ workflowRunId: { in: runIds } }] : []),
            ...(stepIds.length ? [{ workflowStepRunId: { in: stepIds } }] : []),
          ],
        },
      });
    }

    await tx.notificationWorkflow.delete({ where: { id: workflow.id } });

    return {
      id: workflow.id,
      deleted: true,
      deletedRunCount: runIds.length,
    };
  });
}

// The audit LIST only needs what the run cards show plus what health and the
// list filters read (step outputs, delivery status/payload, provider
// attempts). It used to include every column of every step, delivery and
// attempt — step inputs, rendered e-mail bodies, the run's eventContext — for
// up to 500 runs, then sent it all to the browser (QA 10-15). The detail
// endpoint (/audits/:auditId) loads the heavy parts for the one run opened.
export const AUDIT_LIST_RUN_SELECT = Object.freeze({
  id: true,
  workspaceId: true,
  workflowId: true,
  workflowVersionId: true,
  ticketId: true,
  eventType: true,
  status: true,
  triggerSource: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  error: true,
  dryRun: true,
  executionMode: true,
  resumeAt: true,
  workflow: {
    select: {
      id: true,
      name: true,
      key: true,
      triggerType: true,
      isEnabled: true,
      mockModeEnabled: true,
      publishedVersion: true,
    },
  },
  ticket: {
    select: {
      id: true,
      freshserviceTicketId: true,
      nativeNumber: true,
      origin: true,
      subject: true,
      status: true,
      priority: true,
      assessedPriority: true,
      requester: {
        select: { department: true },
      },
    },
  },
  steps: {
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      nodeId: true,
      nodeType: true,
      status: true,
      output: true,
      error: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
    },
  },
  deliveries: {
    orderBy: { queuedAt: 'asc' },
    select: {
      id: true,
      status: true,
      notificationType: true,
      toRecipients: true,
      ccRecipients: true,
      bccRecipients: true,
      error: true,
      payload: true,
      queuedAt: true,
      sentAt: true,
    },
  },
  aiProviderAttempts: {
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      operation: true,
      provider: true,
      model: true,
      status: true,
      errorClass: true,
      errorMessage: true,
    },
  },
});

/**
 * scheduleMode ('after_hours' | 'standard' | null) per workflow, read from the
 * published definition's metadata (draft as a fallback) inside Postgres so the
 * list never pulls whole definitions. Cloned after-hours variants get a new
 * key, so the label cannot rely on the key alone (QA 10-15 #12).
 */
export async function workflowScheduleModes(workflowIds = []) {
  const ids = [...new Set((workflowIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const modes = new Map();
  if (ids.length === 0) return modes;
  try {
    const rows = await prisma.$queryRaw`
      SELECT id,
             COALESCE(
               published_definition->'metadata'->>'scheduleMode',
               draft_definition->'metadata'->>'scheduleMode'
             ) AS "scheduleMode"
        FROM notification_workflows
       WHERE id = ANY(${ids}::int[])`;
    for (const row of rows || []) {
      modes.set(Number(row.id), row.scheduleMode || null);
    }
  } catch {
    // Labels fall back to the workflow key; never fail the list over this.
  }
  return modes;
}

export async function attachWorkflowScheduleModes(runs = []) {
  const modes = await workflowScheduleModes((runs || []).map((run) => run?.workflow?.id ?? run?.workflowId));
  return (runs || []).map((run) => (
    run?.workflow
      ? { ...run, workflow: { ...run.workflow, scheduleMode: modes.get(Number(run.workflow.id)) ?? null } }
      : run
  ));
}

export async function listAuditRuns(workspaceId, {
  executionMode = 'live_mock',
  workflowId = null,
  from = null,
  to = null,
  status = null,
  department = null,
  eventType = null,
  triggerSource = null,
  search = null,
  limit = 50,
  offset = 0,
} = {}) {
  const where = { workspaceId };
  const mode = String(executionMode || '').trim().toLowerCase();
  if (mode && mode !== 'all') {
    where.executionMode = mode === 'live_mock' || mode === 'live+mock'
      ? { in: ['live', 'mock'] }
      : mode;
  }
  if (workflowId && String(workflowId) !== 'all') where.workflowId = normalizeId(workflowId);
  const parsedFrom = safeDate(from);
  const parsedTo = safeDate(to);
  if (parsedFrom || parsedTo) {
    where.startedAt = {};
    if (parsedFrom) where.startedAt.gte = parsedFrom;
    if (parsedTo) where.startedAt.lte = parsedTo;
  }
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus && normalizedStatus !== 'all') where.status = normalizedStatus;
  const normalizedEventType = String(eventType || '').trim();
  if (normalizedEventType && normalizedEventType !== 'all') where.eventType = normalizedEventType;
  const normalizedTriggerSource = String(triggerSource || '').trim();
  if (normalizedTriggerSource && normalizedTriggerSource !== 'all') where.triggerSource = normalizedTriggerSource;
  const normalizedDepartment = String(department || '').trim();
  if (normalizedDepartment && normalizedDepartment.toLowerCase() !== 'all') {
    // Department/location lives on the requester profile (Brisbane, Calgary, ...).
    where.ticket = {
      requester: { is: { department: { equals: normalizedDepartment, mode: 'insensitive' } } },
    };
  }
  const searchFilter = runSearchFilter(search);
  if (searchFilter) where.AND = [searchFilter];

  const runs = await prisma.notificationWorkflowRun.findMany({
    where,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    skip: Math.max(0, Number.parseInt(offset, 10) || 0),
    take: parseLimit(limit, 50, 500),
    select: AUDIT_LIST_RUN_SELECT,
  });
  return attachWorkflowScheduleModes(runs);
}

export async function listRuns(workspaceId, workflowId, { limit = 50 } = {}) {
  const id = normalizeId(workflowId);
  await getWorkflowOrThrow(workspaceId, id);
  return prisma.notificationWorkflowRun.findMany({
    where: { workspaceId, workflowId: id },
    orderBy: { startedAt: 'desc' },
    take: parseLimit(limit),
    include: {
      steps: {
        orderBy: { startedAt: 'asc' },
      },
      deliveries: {
        orderBy: { queuedAt: 'asc' },
      },
    },
  });
}

export async function getSampleContext(triggerType) {
  return sampleEventContext(triggerType);
}

/**
 * Persist the most recent routing-suppression decision per workflow (QA 08-06
 * #6). The engine computes `suppressed[].reason` on every event but used to
 * discard it — a suppressed workflow looked identical to one that never fired.
 * Chosen over deriving on read via the routing preview because this records
 * the REAL decision for the REAL event (a preview against a sample ticket can
 * disagree with what actually happened). Grouped updateMany per reason keeps
 * it to a couple of cheap writes per event.
 */
export async function recordSuppressionDecisions(suppressed = []) {
  const byReason = new Map();
  for (const decision of suppressed || []) {
    const id = Number(decision?.id);
    const reason = String(decision?.reason || '').trim();
    if (!Number.isFinite(id) || id <= 0 || !reason) continue;
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(id);
  }
  if (byReason.size === 0) return { updated: 0 };
  const now = new Date();
  let updated = 0;
  for (const [reason, ids] of byReason) {
    const result = await prisma.notificationWorkflow.updateMany({
      where: { id: { in: ids } },
      data: { lastSuppressedAt: now, lastSuppressedReason: reason.slice(0, 80) },
    });
    updated += result?.count || 0;
  }
  return { updated };
}

export default {
  ensureDefaultWorkflows,
  listWorkflows,
  getWorkflow,
  saveDraft,
  publishWorkflow,
  setWorkflowEnabled,
  setWorkflowMockMode,
  listEnabledForEvent,
  createWorkflowVariant,
  duplicateWorkflowVariant,
  changeWorkflowTrigger,
  updateWorkflowRouting,
  setWorkflowArchived,
  deleteArchivedWorkflowVariant,
  listAuditRuns,
  attachWorkflowScheduleModes,
  listRuns,
  getSampleContext,
  recordSuppressionDecisions,
};
