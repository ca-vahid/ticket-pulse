import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import notificationWorkflowRepository from '../services/notificationWorkflowRepository.js';
import notificationWorkflowEngine from '../services/notificationWorkflowEngine.js';
import { processDelivery } from '../services/notificationDeliveryService.js';
import settingsRepository from '../services/settingsRepository.js';
import prisma from '../services/prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import {
  notificationVariableCatalog,
} from '../services/notificationWorkflowDefinition.js';
import {
  getWorkspaceSignature,
  upsertWorkspaceSignature,
} from '../services/notificationWorkflowSignatureService.js';
import {
  enrichEventContextWithNotificationPolicy,
  getNotificationWorkflowSchedulePreview,
  getNotificationWorkflowPolicy,
  updateNotificationWorkflowPolicy,
} from '../services/notificationWorkflowPolicyService.js';

const router = express.Router();

router.use(requireAdmin);

function requestActor(req) {
  return req.session?.user || req.user || null;
}

function requestActorEmail(req) {
  const email = requestActor(req)?.email;
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null;
}

function parseId(value, label = 'id') {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError(`Invalid ${label}`);
  return id;
}

function formatAuditId(runId) {
  return `TP-NWF-${runId}`;
}

function parseAuditRunId(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:TP-)?NWF-(\d+)$/i) || text.match(/^(\d+)$/);
  if (!match) throw new ValidationError('Invalid workflow audit id');
  return parseId(match[1], 'workflow audit id');
}

function parsePage(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePageSize(value, fallback = 10) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 25);
}

function dateIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function parsePriorityFilter(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all') return null;
  const map = {
    1: { id: 1, label: 'Low' },
    low: { id: 1, label: 'Low' },
    2: { id: 2, label: 'Medium' },
    medium: { id: 2, label: 'Medium' },
    3: { id: 3, label: 'High' },
    high: { id: 3, label: 'High' },
    4: { id: 4, label: 'Urgent' },
    urgent: { id: 4, label: 'Urgent' },
  };
  return map[raw] || null;
}

function parseStatusFilter(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'all') return null;
  return raw;
}

function ticketEventTimestamp(ticket, triggerType) {
  if (triggerType === 'ticket.created') return dateIso(ticket.createdAt) || dateIso(ticket.freshserviceUpdatedAt);
  if (triggerType === 'ticket.assigned' || triggerType === 'ticket.reassigned') {
    return dateIso(ticket.assignedAt) || dateIso(ticket.firstAssignedAt) || dateIso(ticket.freshserviceUpdatedAt);
  }
  if (triggerType === 'ticket.resolved_closed') {
    return dateIso(ticket.resolvedAt) || dateIso(ticket.closedAt) || dateIso(ticket.freshserviceUpdatedAt);
  }
  return dateIso(ticket.freshserviceUpdatedAt);
}

function serializePreviewTicket(ticket) {
  return {
    id: ticket.id,
    freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
    subject: ticket.subject || '',
    status: ticket.status,
    priority: ticket.priority,
    priorityLabel: priorityLabel(ticket),
    isNoise: ticket.isNoise === true,
    toEmails: emailList(ticket.toEmails),
    ccEmails: emailList(ticket.ccEmails),
    replyCcEmails: emailList(ticket.replyCcEmails),
    fwdEmails: emailList(ticket.fwdEmails),
    category: ticket.ticketCategory || ticket.category || null,
    subCategory: ticket.subCategory || null,
    tpSkill: ticket.tpSkill || null,
    tpSubskill: ticket.tpSubskill || null,
    internalCategory: ticket.internalCategory ? { name: ticket.internalCategory.name } : null,
    internalSubcategory: ticket.internalSubcategory ? { name: ticket.internalSubcategory.name } : null,
    createdAt: dateIso(ticket.createdAt),
    updatedAt: dateIso(ticket.freshserviceUpdatedAt || ticket.updatedAt),
    requester: ticket.requester ? {
      name: ticket.requester.name,
      email: ticket.requester.email,
    } : null,
    assignedAgent: ticket.assignedTech ? {
      name: ticket.assignedTech.name,
      email: ticket.assignedTech.email,
    } : null,
  };
}

function previewTicketSearchWhere(workspaceId, search, filters = {}) {
  const trimmed = String(search || '').trim();
  const where = { workspaceId };
  const and = [];

  if (filters.status) {
    and.push({ status: { equals: filters.status, mode: 'insensitive' } });
  }

  if (filters.priority) {
    and.push({
      OR: [
        { assessedPriority: { equals: filters.priority.label, mode: 'insensitive' } },
        { priority: filters.priority.id },
      ],
    });
  }

  if (trimmed) {
    const or = [
      { subject: { contains: trimmed, mode: 'insensitive' } },
      { status: { contains: trimmed, mode: 'insensitive' } },
      { category: { contains: trimmed, mode: 'insensitive' } },
      { subCategory: { contains: trimmed, mode: 'insensitive' } },
      { ticketCategory: { contains: trimmed, mode: 'insensitive' } },
      { requester: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
      { requester: { is: { email: { contains: trimmed, mode: 'insensitive' } } } },
      { assignedTech: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
      { assignedTech: { is: { email: { contains: trimmed, mode: 'insensitive' } } } },
    ];

    if (/^\d+$/.test(trimmed)) {
      try {
        or.push({ freshserviceTicketId: BigInt(trimmed) });
      } catch { /* ignore invalid bigint search */ }
    }

    and.push({ OR: or });
  }

  return and.length > 0 ? { ...where, AND: and } : where;
}

async function buildPreviewEventContext({ ticket, triggerType }) {
  const occurredAt = ticketEventTimestamp(ticket, triggerType) || new Date().toISOString();
  return enrichEventContextWithNotificationPolicy({
    event: {
      type: triggerType,
      source: 'preview',
      occurredAt,
      dedupeStamp: `preview:${ticket.id}:${triggerType}:${occurredAt}`,
    },
    workspace: {
      id: ticket.workspaceId,
      name: ticket.workspace?.name || ticket.workspaceName || null,
      timezone: ticket.workspace?.defaultTimezone || 'America/Los_Angeles',
    },
    ticket: {
      id: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || ticket.freshserviceTicketId,
      subject: ticket.subject,
      descriptionText: ticket.descriptionText,
      status: ticket.status,
      priority: ticket.priority,
      priorityLabel: priorityLabel(ticket),
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
      isNoise: ticket.isNoise === true,
      createdAt: dateIso(ticket.createdAt),
      assignedAt: dateIso(ticket.assignedAt),
      resolvedAt: dateIso(ticket.resolvedAt),
      closedAt: dateIso(ticket.closedAt),
      freshserviceUpdatedAt: dateIso(ticket.freshserviceUpdatedAt),
    },
    requester: ticket.requester ? {
      id: ticket.requester.id,
      name: ticket.requester.name,
      email: ticket.requester.email,
      department: ticket.requester.department,
      jobTitle: ticket.requester.jobTitle,
    } : null,
    assignedAgent: ticket.assignedTech ? {
      id: ticket.assignedTech.id,
      name: ticket.assignedTech.name,
      email: ticket.assignedTech.email,
    } : null,
    previousAgent: null,
  });
}

function truncateString(value, max = 2000) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}... [truncated]` : value;
}

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (!value || typeof value !== 'object') return truncateString(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['description', 'descriptionText', 'body', 'htmlBody', 'textBody'].includes(key)) {
      result[key] = truncateString(entry, 800);
    } else {
      result[key] = redactPayload(entry);
    }
  }
  return result;
}

function redactRun(run) {
  return {
    ...run,
    auditId: formatAuditId(run.id),
    eventContext: redactPayload(run.eventContext),
    steps: (run.steps || []).map((step) => ({
      ...step,
      input: redactPayload(step.input),
      output: redactPayload(step.output),
    })),
    deliveries: (run.deliveries || []).map((delivery) => ({
      ...delivery,
      payload: redactPayload(delivery.payload),
      htmlBody: truncateString(delivery.htmlBody, 800),
      textBody: truncateString(delivery.textBody, 800),
    })),
  };
}

function testEmailBanner(auditId) {
  const auditText = auditId ? ` Audit ID: ${auditId}.` : '';
  return `<div style="border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;padding:12px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;">Ticket Pulse workflow preview. This test email was sent only to you.${auditText}</div>`;
}

function testEmailTextPrefix(auditId) {
  return `Ticket Pulse workflow preview. This test email was sent only to you.${auditId ? ` Audit ID: ${auditId}.` : ''}`;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const workflows = await notificationWorkflowRepository.listWorkflows(req.workspaceId);
    res.json({ success: true, data: workflows });
  }),
);

router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const [sendgridConfig, workflows, recentFailures] = await Promise.all([
      settingsRepository.getSendGridConfig(),
      prisma.notificationWorkflow.groupBy({
        by: ['isEnabled'],
        where: { workspaceId: req.workspaceId },
        _count: { _all: true },
      }),
      prisma.notificationDelivery.count({
        where: {
          workspaceId: req.workspaceId,
          channel: 'email',
          status: { in: ['failed', 'failed_permanent'] },
          queuedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        provider: 'sendgrid',
        sendgridConfigured: Boolean(sendgridConfig.configured),
        sendgridMode: sendgridConfig.mode || 'missing',
        enabledWorkflows: workflows.find((row) => row.isEnabled)?._count?._all || 0,
        disabledWorkflows: workflows.find((row) => !row.isEnabled)?._count?._all || 0,
        failedEmailDeliveries24h: recentFailures,
      },
    });
  }),
);

router.get(
  '/variables',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: notificationVariableCatalog() });
  }),
);

router.get(
  '/signature',
  asyncHandler(async (req, res) => {
    const signature = await getWorkspaceSignature(req.workspaceId);
    res.json({ success: true, data: signature });
  }),
);

router.put(
  '/signature',
  asyncHandler(async (req, res) => {
    const signature = await upsertWorkspaceSignature(req.workspaceId, req.body || {}, requestActor(req));
    res.json({
      success: true,
      data: await getWorkspaceSignature(signature.workspaceId),
    });
  }),
);

router.get(
  '/after-hours-policy',
  asyncHandler(async (req, res) => {
    const policy = await getNotificationWorkflowPolicy(req.workspaceId);
    res.json({ success: true, data: policy });
  }),
);

router.put(
  '/after-hours-policy',
  asyncHandler(async (req, res) => {
    await notificationWorkflowRepository.ensureDefaultWorkflows(req.workspaceId, requestActor(req));
    const policy = await updateNotificationWorkflowPolicy(req.workspaceId, req.body || {}, requestActor(req));
    res.json({ success: true, data: policy });
  }),
);

router.post(
  '/after-hours-policy/preview',
  asyncHandler(async (req, res) => {
    const preview = await getNotificationWorkflowSchedulePreview(req.workspaceId, req.body || {});
    res.json({ success: true, data: preview });
  }),
);

router.get(
  '/preview-tickets',
  asyncHandler(async (req, res) => {
    const page = parsePage(req.query.page);
    const pageSize = parsePageSize(req.query.pageSize);
    const search = String(req.query.search || '').trim();
    const status = parseStatusFilter(req.query.status);
    const priority = parsePriorityFilter(req.query.priority);
    const where = previewTicketSearchWhere(req.workspaceId, search, { status, priority });
    const [total, tickets] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: [
          { createdAt: 'desc' },
          { freshserviceTicketId: 'desc' },
          { id: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          requester: { select: { name: true, email: true, department: true, jobTitle: true } },
          assignedTech: { select: { name: true, email: true } },
          internalCategory: { select: { id: true, name: true } },
          internalSubcategory: { select: { id: true, name: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        items: tickets.map(serializePreviewTicket),
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        search,
        filters: {
          status,
          priority: priority?.label || null,
        },
      },
    });
  }),
);

router.get(
  '/audits/:auditId',
  asyncHandler(async (req, res) => {
    const runId = parseAuditRunId(req.params.auditId);
    const run = await prisma.notificationWorkflowRun.findFirst({
      where: { id: runId, workspaceId: req.workspaceId },
      include: {
        workflow: {
          select: {
            id: true,
            name: true,
            triggerType: true,
            isEnabled: true,
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
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!run) throw new NotFoundError('Workflow audit run not found in this workspace');
    res.json({ success: true, data: redactRun(run) });
  }),
);

router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const workflowId = parseId(req.body.workflowId, 'workflow id');
    const workflow = await notificationWorkflowRepository.getWorkflow(req.workspaceId, workflowId);
    let eventContext = req.body.eventContext || null;
    if (req.body.ticketId) {
      const ticketId = parseId(req.body.ticketId, 'ticket id');
      const ticket = await prisma.ticket.findFirst({
        where: { id: ticketId, workspaceId: req.workspaceId },
        include: {
          workspace: true,
          requester: true,
          assignedTech: true,
          internalCategory: true,
          internalSubcategory: true,
        },
      });
      if (!ticket) throw new NotFoundError('Preview ticket not found in this workspace');
      eventContext = await buildPreviewEventContext({ ticket, triggerType: workflow.triggerType });
    }
    const result = await notificationWorkflowEngine.executePreview({
      workflow,
      definition: req.body.definition || workflow.draftDefinition,
      eventContext,
      executeLlm: req.body.executeLlm === true,
      forceActionLinks: req.body.forceActionLinks === true,
    });
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/test-email',
  asyncHandler(async (req, res) => {
    const actorEmail = requestActorEmail(req);
    if (!actorEmail) {
      throw new ValidationError('Your session does not include an email address for test delivery');
    }

    const subject = String(req.body?.subject || '').trim() || 'Ticket Pulse notification preview';
    const html = typeof req.body?.html === 'string' ? req.body.html : null;
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    if (!html && !text) {
      throw new ValidationError('Preview email body is required');
    }

    const workflowId = req.body?.workflowId ? parseId(req.body.workflowId, 'workflow id') : null;
    const workflow = workflowId
      ? await notificationWorkflowRepository.getWorkflow(req.workspaceId, workflowId)
      : null;
    const runId = req.body?.auditId || req.body?.previewRunId || req.body?.runId
      ? parseAuditRunId(req.body.auditId || req.body.previewRunId || req.body.runId)
      : null;
    const run = runId
      ? await prisma.notificationWorkflowRun.findFirst({
        where: { id: runId, workspaceId: req.workspaceId },
        include: {
          steps: { where: { nodeType: 'send_email' }, orderBy: { startedAt: 'desc' }, take: 1 },
        },
      })
      : null;
    if (runId && !run) throw new NotFoundError('Preview audit run not found in this workspace');

    const ticketId = req.body?.ticketId
      ? parseId(req.body.ticketId, 'ticket id')
      : run?.ticketId;
    if (!ticketId) {
      throw new ValidationError('Preview ticket id is required for audited test delivery');
    }
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId: req.workspaceId },
      select: { id: true, assessedPriority: true, priority: true },
    });
    if (!ticket) throw new NotFoundError('Preview ticket not found in this workspace');

    const auditId = run ? formatAuditId(run.id) : null;
    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: req.workspaceId,
        ticketId: ticket.id,
        workflowRunId: run?.id || null,
        workflowStepRunId: run?.steps?.[0]?.id || null,
        channel: 'email',
        status: 'queued',
        provider: 'sendgrid',
        eventType: run?.eventType || workflow?.triggerType || null,
        notificationType: 'notification_workflow_test_email',
        assessedPriority: ticket.assessedPriority || priorityLabel(ticket) || null,
        recipient: actorEmail,
        toRecipients: [actorEmail],
        subject: `[TEST] ${subject}`,
        htmlBody: html ? `${testEmailBanner(auditId)}${html}` : null,
        textBody: `${testEmailTextPrefix(auditId)}\n\n${text || ''}`.trim(),
        dedupeKey: [
          'notification-workflow-test',
          run?.id || workflowId || 'workflow',
          ticket.id,
          Date.now(),
          Math.random().toString(36).slice(2),
        ].join(':').slice(0, 255),
        payload: {
          preview: true,
          actorEmail,
          workflowId,
          auditId,
        },
      },
    });
    const result = await processDelivery(delivery);

    res.json({
      success: true,
      data: {
        sentTo: actorEmail,
        deliveryId: delivery.id,
        auditId,
        result,
      },
    });
  }),
);

router.post(
  '/deliveries/:id/retry',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'delivery id');
    const delivery = await prisma.notificationDelivery.findFirst({
      where: { id, workspaceId: req.workspaceId },
    });
    if (!delivery) throw new NotFoundError('Notification delivery not found');

    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: 'queued',
        error: null,
      },
    });
    const updated = await prisma.notificationDelivery.findUnique({ where: { id } });
    const result = await processDelivery(updated);
    res.json({ success: true, data: result });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.getWorkflow(req.workspaceId, req.params.id);
    res.json({ success: true, data: workflow });
  }),
);

router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const runs = await notificationWorkflowRepository.listRuns(req.workspaceId, req.params.id, {
      limit: req.query.limit,
    });
    res.json({ success: true, data: runs.map(redactRun) });
  }),
);

router.put(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.saveDraft(
      req.workspaceId,
      req.params.id,
      req.body,
      requestActor(req),
    );
    res.json({ success: true, data: workflow });
  }),
);

router.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const result = await notificationWorkflowRepository.publishWorkflow(
      req.workspaceId,
      req.params.id,
      req.body,
      requestActor(req),
    );
    res.json({ success: true, data: result });
  }),
);

router.put(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.setWorkflowEnabled(
      req.workspaceId,
      req.params.id,
      req.body?.enabled === true,
      requestActor(req),
    );
    res.json({ success: true, data: workflow });
  }),
);

export default router;
