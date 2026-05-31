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

export async function listRuns(workspaceId, workflowId, { limit = 50 } = {}) {
  const id = normalizeId(workflowId);
  await getWorkflowOrThrow(workspaceId, id);
  return prisma.notificationWorkflowRun.findMany({
    where: { workspaceId, workflowId: id },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100),
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
  listEnabledForEvent,
  listRuns,
  getSampleContext,
};
