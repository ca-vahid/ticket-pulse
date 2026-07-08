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

function runSearchFilter(search) {
  const trimmed = String(search || '').trim();
  if (!trimmed) return null;
  const or = [
    { workflow: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
    { workflow: { is: { key: { contains: trimmed, mode: 'insensitive' } } } },
    { ticket: { is: { subject: { contains: trimmed, mode: 'insensitive' } } } },
    { eventType: { contains: trimmed, mode: 'insensitive' } },
  ];
  if (/^\d+$/.test(trimmed)) {
    or.push({ id: Number.parseInt(trimmed, 10) });
    try {
      or.push({ ticket: { is: { freshserviceTicketId: BigInt(trimmed) } } });
    } catch {
      // Ignore invalid bigint values even if they are numeric-looking.
    }
  }
  // Audit IDs are shown as "TP-NWF-<runId>" (or "NWF-<runId>"); match on the run id.
  const auditIdMatch = trimmed.match(/^(?:TP-)?NWF-(\d+)$/i);
  if (auditIdMatch) {
    or.push({ id: Number.parseInt(auditIdMatch[1], 10) });
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
        archivedAt: null,
        archivedBy: null,
      },
    });
    results.push(workflow);
  }

  return results;
}

export async function listWorkflows(workspaceId) {
  await ensureDefaultWorkflows(workspaceId);
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
  await ensureDefaultWorkflows(workspaceId);
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

export async function setWorkflowArchived(workspaceId, id, archived, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
  const nextArchived = archived === true || archived === 'true';
  if (workflow.isDefaultVariant && nextArchived) {
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

export async function listAuditRuns(workspaceId, {
  executionMode = 'live_mock',
  workflowId = null,
  from = null,
  to = null,
  status = null,
  department = null,
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
  const normalizedDepartment = String(department || '').trim();
  if (normalizedDepartment && normalizedDepartment.toLowerCase() !== 'all') {
    // Department/location lives on the requester profile (Brisbane, Calgary, ...).
    where.ticket = {
      requester: { is: { department: { equals: normalizedDepartment, mode: 'insensitive' } } },
    };
  }
  const searchFilter = runSearchFilter(search);
  if (searchFilter) where.AND = [searchFilter];

  return prisma.notificationWorkflowRun.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    skip: Math.max(0, Number.parseInt(offset, 10) || 0),
    take: parseLimit(limit, 50, 500),
    include: {
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
      },
      deliveries: {
        orderBy: { queuedAt: 'asc' },
      },
      aiProviderAttempts: {
        orderBy: { startedAt: 'asc' },
      },
    },
  });
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
  listRuns,
  getSampleContext,
};
