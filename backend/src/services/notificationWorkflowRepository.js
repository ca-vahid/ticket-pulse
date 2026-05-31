import prisma from './prisma.js';
import {
  DEFAULT_WORKFLOW_SPECS,
  assertValidWorkflowDefinition,
  buildDefaultWorkflowDefinition,
  defaultWorkflowMetadataForSpec,
  sampleEventContext,
  validateWorkflowDefinition,
} from './notificationWorkflowDefinition.js';
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
    try {
      or.push({ ticket: { is: { freshserviceTicketId: BigInt(trimmed) } } });
    } catch {
      // Ignore invalid bigint values even if they are numeric-looking.
    }
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
        draftDefinition,
        lastChangedBy: changedBy,
      },
      update: {},
    });
    results.push(workflow);
  }

  return results;
}

export async function listWorkflows(workspaceId) {
  await ensureDefaultWorkflows(workspaceId);
  return prisma.notificationWorkflow.findMany({
    where: { workspaceId },
    orderBy: [{ triggerType: 'asc' }, { name: 'asc' }],
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
  const definition = assertValidWorkflowDefinition(workflow.draftDefinition, {
    triggerType: workflow.triggerType,
  });
  const validationResult = validateWorkflowDefinition(definition, { triggerType: workflow.triggerType });
  const nextVersion = workflow.publishedVersion + 1;
  const changedBy = actorEmail(actor);

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
        isEnabled: true,
        enabledAt: version.publishedAt,
        lastChangedBy: changedBy,
      },
    });

    return { workflow: updated, version };
  });
}

export async function setWorkflowEnabled(workspaceId, id, enabled, actor = null) {
  const workflow = await getWorkflowOrThrow(workspaceId, id);
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
  const isEnabled = enabled === true || enabled === 'true';
  if (isEnabled && !workflow.publishedDefinition) {
    throw new ValidationError('Publish the workflow before enabling mock mode');
  }
  if (isEnabled && workflow.isEnabled !== true) {
    throw new ValidationError('Enable the workflow before enabling mock mode');
  }

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
  if (!DEFAULT_WORKFLOW_SPECS.some((spec) => spec.triggerType === eventType)) return [];
  return prisma.notificationWorkflow.findMany({
    where: {
      workspaceId,
      triggerType: eventType,
      isEnabled: true,
      publishedVersion: { gt: 0 },
    },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });
}

export async function listAuditRuns(workspaceId, {
  executionMode = 'mock',
  workflowId = null,
  from = null,
  to = null,
  status = null,
  search = null,
  limit = 50,
} = {}) {
  const where = { workspaceId };
  const mode = String(executionMode || '').trim().toLowerCase();
  if (mode && mode !== 'all') where.executionMode = mode;
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
  const searchFilter = runSearchFilter(search);
  if (searchFilter) where.AND = [searchFilter];

  return prisma.notificationWorkflowRun.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    take: parseLimit(limit),
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
  listAuditRuns,
  listRuns,
  getSampleContext,
};
