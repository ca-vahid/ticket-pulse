import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import notificationWorkflowRepository from '../services/notificationWorkflowRepository.js';
import notificationWorkflowEngine, {
  finalizeWorkflowSendEmail,
} from '../services/notificationWorkflowEngine.js';
import { processDelivery } from '../services/notificationDeliveryService.js';
import settingsRepository from '../services/settingsRepository.js';
import prisma from '../services/prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import {
  notificationVariableCatalog,
} from '../services/notificationWorkflowDefinition.js';
import {
  createWorkspaceEmailBlock,
  deleteWorkspaceEmailBlock,
  getWorkspaceSignature,
  listWorkspaceEmailBlocks,
  setDefaultWorkspaceEmailBlock,
  updateWorkspaceEmailBlock,
  upsertWorkspaceSignature,
} from '../services/notificationWorkflowSignatureService.js';
import {
  enrichEventContextWithNotificationPolicy,
  getNotificationWorkflowSchedulePreview,
  getNotificationWorkflowPolicy,
  isOffHoursWorkflow,
  selectWorkflowsForNotificationTiming,
  updateNotificationWorkflowPolicy,
} from '../services/notificationWorkflowPolicyService.js';
import {
  selectWorkflowVariants,
} from '../services/notificationWorkflowRoutingService.js';
import {
  buildNotificationLlmContext,
  summarizeNotificationLlmContext,
} from '../services/notificationContextEnrichmentService.js';
import {
  getNotificationLlmToolPolicy,
  notificationLlmToolCatalog,
  normalizeNotificationLlmToolPolicy,
  updateNotificationLlmToolPolicy,
} from '../services/notificationLlmToolPolicyService.js';
import {
  REQUESTER_PROFILE_SELECT,
  enrichEventContextWithRequesterProfile,
  requesterContextFromSource,
} from '../services/requesterProfileService.js';

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

function parseOptionalId(value, label = 'id') {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return parseId(value, label);
}

function parseFreshserviceTicketId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new ValidationError('Invalid FreshService ticket number');
  try {
    const id = BigInt(text);
    if (id <= 0n) throw new ValidationError('Invalid FreshService ticket number');
    return id;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Invalid FreshService ticket number');
  }
}

function previewContextTicketWhere(workspaceId, body = {}) {
  const ticketId = parseOptionalId(body.ticketId, 'ticket id');
  const freshserviceTicketId = parseFreshserviceTicketId(body.freshserviceTicketId);

  if (!ticketId && !freshserviceTicketId) {
    throw new ValidationError('Select a ticket by Ticket Pulse ID or FreshService ticket number');
  }

  return {
    workspaceId,
    ...(ticketId ? { id: ticketId } : {}),
    ...(freshserviceTicketId ? { freshserviceTicketId } : {}),
  };
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

const ROUTING_FIELD_METADATA = Object.freeze([
  {
    value: 'requester.regionKey',
    label: 'Requester region',
    group: 'Requester routing',
    example: 'AU-BRISBANE',
    description: 'Normalized route key used for regional workflow variants.',
    normalization: 'Built from Entra office/city/state/country first, then FreshService department/location when Entra has no usable location. Brisbane normalizes to AU-BRISBANE.',
  },
  {
    value: 'requester.locationKey',
    label: 'Requester location',
    group: 'Requester routing',
    example: 'AU-BRISBANE',
    description: 'Normalized route key used for site-specific workflow variants.',
    normalization: 'Uses city first, then office location, then FreshService department/location. Country codes are prefixed when available. Brisbane normalizes to AU-BRISBANE.',
  },
  {
    value: 'requester.department',
    label: 'FreshService department/location',
    group: 'Requester profile',
    example: 'Brisbane',
    description: 'Requester department/location as stored in FreshService.',
    normalization: 'This is the raw FreshService department/location value; routing keys may derive a city from the first department token.',
  },
  {
    value: 'requester.officeLocation',
    label: 'Requester office location',
    group: 'Requester profile',
    example: 'Brisbane',
    description: 'Requester office location from Entra when available, otherwise derived from FreshService department/location.',
    normalization: 'Entra is preferred. FreshService department/location is used only as a fallback.',
  },
  {
    value: 'requester.city',
    label: 'Requester city',
    group: 'Requester profile',
    example: 'Brisbane',
    description: 'Requester city from Entra when available, otherwise derived from FreshService department/location.',
    normalization: 'Entra is preferred. FreshService department/location is used only as a fallback.',
  },
  {
    value: 'requester.country',
    label: 'Requester country',
    group: 'Requester profile',
    example: 'Australia',
    description: 'Requester country from Entra.',
    normalization: 'Country names are converted to country codes when creating normalized route keys.',
  },
  {
    value: 'requester.timeZoneIana',
    label: 'Requester timezone',
    group: 'Requester profile',
    example: 'Australia/Brisbane',
    description: 'IANA timezone derived from requester region, city, country, or FreshService timezone.',
    normalization: 'Known regions and cities are mapped to IANA timezones; FreshService timezone is used as fallback.',
  },
  {
    value: 'ticket.status',
    label: 'Ticket status',
    group: 'Ticket',
    example: 'Open',
    description: 'FreshService ticket status.',
    normalization: 'Compared as the stored ticket status text.',
  },
  {
    value: 'ticket.priorityLabel',
    label: 'Ticket priority',
    group: 'Ticket',
    example: 'High',
    description: 'FreshService priority label.',
    normalization: 'FreshService priority number is shown as Low, Medium, High, or Urgent.',
  },
  {
    value: 'ticket.assessedPriority',
    label: 'Assessed priority',
    group: 'Ticket',
    example: 'Urgent',
    description: 'Ticket Pulse assessed priority when available.',
    normalization: 'Compared as the saved assessed priority text.',
  },
  {
    value: 'ticket.ticketCategory',
    label: 'Ticket category',
    group: 'Ticket',
    example: 'IT',
    description: 'Ticket Pulse/FreshService ticket category.',
    normalization: 'Compared as the stored category text.',
  },
]);

const ROUTING_FIELD_LOOKUP = new Map(ROUTING_FIELD_METADATA.map((field) => [field.value, field]));

function getPathValue(source, path) {
  return String(path || '').split('.').reduce((value, key) => (
    value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
  ), source);
}

function routingSourceLabel(field, requester = {}) {
  if (!String(field || '').startsWith('requester.')) return 'Ticket data';
  if (field === 'requester.department') return 'FreshService';
  if (requester.locationSource === 'entra') return 'Entra';
  if (requester.locationSource === 'freshservice_department') return 'FreshService fallback';
  return 'Requester profile';
}

function routingValueLabel(field, value, context = {}) {
  if (field === 'requester.regionKey' || field === 'requester.locationKey') {
    return context.requester?.locationSummary || context.requester?.city || context.requester?.officeLocation || value;
  }
  return value;
}

function routingLookupContextFromTicket(ticket) {
  const requester = ticket.requester ? requesterContextFromSource(ticket.requester, ticket) : null;
  return {
    ticket: {
      id: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
      subject: ticket.subject || '',
      status: ticket.status,
      priorityLabel: priorityLabel(ticket),
      assessedPriority: ticket.assessedPriority || null,
      category: ticket.category,
      subCategory: ticket.subCategory,
      ticketCategory: ticket.ticketCategory,
      isNoise: ticket.isNoise === true,
    },
    requester,
    assignedAgent: ticket.assignedTech ? {
      name: ticket.assignedTech.name,
      email: ticket.assignedTech.email,
    } : null,
  };
}

function normalizedLookupValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function summarizeRoutingFieldValues(tickets = [], field, search = '') {
  const metadata = ROUTING_FIELD_LOOKUP.get(field);
  if (!metadata) throw new ValidationError('Unsupported routing lookup field');
  const query = String(search || '').trim().toLowerCase();
  const byValue = new Map();

  for (const ticket of tickets || []) {
    const context = routingLookupContextFromTicket(ticket);
    const value = normalizedLookupValue(getPathValue(context, field));
    if (!value) continue;
    const label = routingValueLabel(field, value, context);
    const source = routingSourceLabel(field, context.requester || {});
    if (query && !`${value} ${label} ${source}`.toLowerCase().includes(query)) continue;

    const current = byValue.get(value) || {
      value,
      label,
      count: 0,
      sources: new Set(),
      examples: [],
    };
    current.count += 1;
    current.sources.add(source);
    if (current.examples.length < 3) {
      current.examples.push({
        ticketId: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
        requesterName: context.requester?.name || null,
        requesterEmail: context.requester?.email || null,
        locationSummary: context.requester?.locationSummary || null,
      });
    }
    byValue.set(value, current);
  }

  return [...byValue.values()]
    .map((entry) => ({
      ...entry,
      sources: [...entry.sources],
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 50);
}

async function routingLookupTickets(workspaceId) {
  return prisma.ticket.findMany({
    where: { workspaceId },
    orderBy: [
      { createdAt: 'desc' },
      { freshserviceTicketId: 'desc' },
      { id: 'desc' },
    ],
    take: 500,
    include: {
      requester: { select: REQUESTER_PROFILE_SELECT },
      assignedTech: { select: { name: true, email: true } },
    },
  });
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
      ...requesterContextFromSource(ticket.requester, ticket),
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
  const policyContext = await enrichEventContextWithNotificationPolicy({
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
    requester: ticket.requester ? requesterContextFromSource(ticket.requester, ticket) : null,
    assignedAgent: ticket.assignedTech ? {
      id: ticket.assignedTech.id,
      name: ticket.assignedTech.name,
      email: ticket.assignedTech.email,
    } : null,
    previousAgent: null,
  });
  return enrichEventContextWithRequesterProfile(policyContext);
}

async function buildWorkflowRoutingPreview({ workspaceId, workflow, eventContext }) {
  if (!workflow?.triggerType || !eventContext) return null;
  const workflows = await notificationWorkflowRepository.listWorkflows(workspaceId);
  const selectedId = workflow.id;
  const candidates = workflows
    .filter((candidate) => candidate.triggerType === workflow.triggerType && !candidate.archivedAt)
    .map((candidate) => (
      candidate.id === selectedId
        ? {
          ...candidate,
          ...workflow,
          draftDefinition: workflow.draftDefinition || candidate.draftDefinition,
          publishedDefinition: workflow.publishedDefinition || workflow.draftDefinition || candidate.publishedDefinition || candidate.draftDefinition,
        }
        : {
          ...candidate,
          publishedDefinition: candidate.publishedDefinition || candidate.draftDefinition,
        }
    ));
  if (!candidates.some((candidate) => candidate.id === selectedId)) {
    candidates.push({
      ...workflow,
      publishedDefinition: workflow.publishedDefinition || workflow.draftDefinition,
    });
  }
  const timing = selectWorkflowsForNotificationTiming(candidates, eventContext);
  const variants = selectWorkflowVariants(timing.selected || [], eventContext, {
    baseSuppressed: timing.suppressed || [],
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const workflowSummary = (id) => {
    const candidate = candidateById.get(id);
    return candidate ? {
      id: candidate.id,
      name: candidate.name,
      key: candidate.key,
      triggerType: candidate.triggerType,
      routingMode: candidate.routingMode,
      routingPriority: candidate.routingPriority,
      isDefaultVariant: candidate.isDefaultVariant === true,
    } : { id };
  };
  return {
    selectedWorkflowId: selectedId,
    wouldRunSelectedWorkflow: (variants.selectedWorkflowIds || []).includes(selectedId),
    timingMode: timing.mode || null,
    timingReason: timing.reason || null,
    selectedWorkflowIds: variants.selectedWorkflowIds || [],
    selectedWorkflows: (variants.selectedWorkflowIds || []).map(workflowSummary),
    considered: variants.considered || [],
    matched: variants.matched || [],
    suppressed: variants.suppressed || [],
    fallbackWorkflowId: variants.fallbackWorkflowId || null,
    fallbackWorkflow: variants.fallbackWorkflowId ? workflowSummary(variants.fallbackWorkflowId) : null,
    reason: variants.reason || null,
  };
}

function truncateString(value, max = 2000) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}... [truncated]` : value;
}

// Rendered email bodies carry the appended action-link blocks at the END, so an 800-char
// cap silently drops them from the audit preview. Give email bodies a budget that fits a
// full rendered email (body + branding + action links); ticket descriptions stay small.
const AUDIT_EMAIL_MAX_CHARS = 20000;

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (!value || typeof value !== 'object') return truncateString(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['htmlBody', 'textBody'].includes(key)) {
      result[key] = truncateString(entry, AUDIT_EMAIL_MAX_CHARS);
    } else if (['description', 'descriptionText', 'body'].includes(key)) {
      result[key] = truncateString(entry, 800);
    } else {
      result[key] = redactPayload(entry);
    }
  }
  return result;
}

function workflowRunWarnings(run = {}) {
  const warnings = [];
  for (const step of run.steps || []) {
    const output = step.output || {};
    if (output.duplicateDelivery === true) {
      warnings.push({
        type: 'duplicate_delivery',
        nodeId: step.nodeId || null,
        message: output.reason || 'A duplicate workflow delivery was suppressed.',
      });
    }
    const llm = output.llm || (step.nodeType === 'llm_generate' ? output : null);
    if (!llm || (!llm.failed && !llm.warning && llm.guardRejected !== true)) continue;
    warnings.push({
      type: llm.guardRejected ? 'guard_rejected' : 'llm_failed',
      nodeId: step.nodeId || null,
      outputKey: output.outputKey || llm.outputKey || null,
      provider: llm.provider || null,
      model: llm.model || null,
      templateFallbackUsed: llm.templateFallbackUsed === true,
      message: llm.warning || llm.error || 'LLM generation did not produce a usable requester-facing email.',
    });
  }
  const duplicateDeliveries = (run.deliveries || []).filter((delivery) => (
    delivery?.payload?.duplicateDelivery === true
  ));
  for (const delivery of duplicateDeliveries) {
    warnings.push({
      type: 'duplicate_delivery',
      deliveryId: delivery.id,
      message: 'A duplicate workflow delivery was suppressed.',
    });
  }
  return warnings;
}

function redactRun(run) {
  return {
    ...run,
    auditId: formatAuditId(run.id),
    warnings: workflowRunWarnings(run),
    eventContext: redactPayload(run.eventContext),
    steps: (run.steps || []).map((step) => ({
      ...step,
      input: redactPayload(step.input),
      output: redactPayload(step.output),
    })),
    deliveries: (run.deliveries || []).map((delivery) => ({
      ...delivery,
      payload: redactPayload(delivery.payload),
      htmlBody: truncateString(delivery.htmlBody, AUDIT_EMAIL_MAX_CHARS),
      textBody: truncateString(delivery.textBody, AUDIT_EMAIL_MAX_CHARS),
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

function normalizeEmailPayload(value = {}) {
  const subject = String(value.subject || '').trim();
  const html = typeof value.html === 'string' ? value.html : (typeof value.htmlBody === 'string' ? value.htmlBody : null);
  const text = typeof value.text === 'string' ? value.text : (typeof value.textBody === 'string' ? value.textBody : null);
  if (!subject && !html && !text) return null;
  return {
    subject: subject || 'Ticket Pulse notification preview',
    html: html || null,
    text: text || null,
  };
}

function emailFromWorkflowStep(step) {
  const output = step?.output || {};
  return normalizeEmailPayload(output.email)
    || normalizeEmailPayload(output.llm?.email)
    || normalizeEmailPayload(output);
}

function workflowScheduleMode(workflow = {}) {
  return workflow?.publishedDefinition?.metadata?.scheduleMode
    || workflow?.draftDefinition?.metadata?.scheduleMode
    || null;
}

function sendNodeDataForStep(run, step) {
  const definition = run?.workflow?.publishedDefinition || run?.workflow?.draftDefinition || {};
  const node = (definition.nodes || []).find((candidate) => candidate.id === step?.nodeId)
    || (definition.nodes || []).find((candidate) => candidate.type === 'send_email')
    || null;
  return node?.data || {};
}

function emailBeforeStep(run, step) {
  const steps = run?.steps || [];
  const stepIndex = steps.findIndex((candidate) => candidate.id === step?.id);
  const priorSteps = stepIndex >= 0 ? steps.slice(0, stepIndex) : steps;
  return [...priorSteps].reverse()
    .map(emailFromWorkflowStep)
    .find(Boolean)
    || null;
}

async function finalEmailFromSendStep(run, step) {
  // Re-render the email body (captured before the send step) through the current engine so
  // the appended action-link blocks use the CURRENT template, matching the Preview function.
  // Fall back to the stored send-step email when a re-render isn't possible.
  const baseEmail = emailBeforeStep(run, step);
  if (baseEmail && run?.workflow && run?.eventContext) {
    const rerendered = normalizeEmailPayload(await finalizeWorkflowSendEmail({
      workflow: run.workflow,
      eventContext: run.eventContext,
      email: baseEmail,
      nodeData: sendNodeDataForStep(run, step),
      actionLinkRenderMode: 'live',
      workflowScheduleMode: workflowScheduleMode(run.workflow),
      allowSignatureFailure: true,
    }));
    if (rerendered) return rerendered;
  }
  return emailFromWorkflowStep(step);
}

async function emailFromAuditRun(run) {
  // Prefer re-rendering with the current engine so the audit "send test" / preview reflects
  // the current action-link template (consistent with the Preview function). The stored
  // delivery is the historical record and is used only as a fallback.
  const sendSteps = (run?.steps || []).filter((step) => step.nodeType === 'send_email').reverse();
  for (const step of sendSteps) {
    const email = await finalEmailFromSendStep(run, step);
    if (email) return email;
  }

  const delivery = (run?.deliveries || [])
    .find((item) => item.notificationType !== 'notification_workflow_test_email')
    || null;
  const deliveryEmail = normalizeEmailPayload({
    subject: delivery?.subject,
    htmlBody: delivery?.htmlBody,
    textBody: delivery?.textBody,
  });
  if (deliveryEmail) return deliveryEmail;

  const stepPriority = ['template_render', 'llm_generate'];
  for (const nodeType of stepPriority) {
    const steps = (run?.steps || []).filter((step) => step.nodeType === nodeType).reverse();
    for (const step of steps) {
      const email = emailFromWorkflowStep(step);
      if (email) return email;
    }
  }
  return null;
}

function recipientsFromAuditRun(run) {
  const delivery = (run?.deliveries || []).find((item) => item.notificationType !== 'notification_workflow_test_email')
    || run?.deliveries?.[0]
    || null;
  if (delivery) {
    return {
      to: delivery.toRecipients || [],
      cc: delivery.ccRecipients || [],
      bcc: delivery.bccRecipients || [],
    };
  }
  const recipientStep = (run?.steps || []).find((step) => step.nodeType === 'recipient_resolver');
  return recipientStep?.output?.recipients || { to: [], cc: [], bcc: [] };
}

async function createTestEmailDelivery({
  req,
  ticket,
  run = null,
  workflow = null,
  email,
  payload = {},
}) {
  const actorEmail = requestActorEmail(req);
  if (!actorEmail) {
    throw new ValidationError('Your session does not include an email address for test delivery');
  }
  if (!email?.html && !email?.text) {
    throw new ValidationError('Preview email body is required');
  }
  const auditId = run ? formatAuditId(run.id) : null;
  const sendStep = (run?.steps || []).find((step) => step.nodeType === 'send_email');
  const sourceStep = sendStep
    || [...(run?.steps || [])].reverse().find((step) => ['template_render', 'llm_generate'].includes(step.nodeType))
    || null;

  const delivery = await prisma.notificationDelivery.create({
    data: {
      workspaceId: req.workspaceId,
      ticketId: ticket.id,
      workflowRunId: run?.id || null,
      workflowStepRunId: sourceStep?.id || null,
      channel: 'email',
      status: 'queued',
      provider: 'sendgrid',
      eventType: run?.eventType || workflow?.triggerType || null,
      notificationType: 'notification_workflow_test_email',
      assessedPriority: ticket.assessedPriority || priorityLabel(ticket) || null,
      recipient: actorEmail,
      toRecipients: [actorEmail],
      subject: `[TEST] ${email.subject || 'Ticket Pulse notification preview'}`,
      htmlBody: email.html ? `${testEmailBanner(auditId)}${email.html}` : null,
      textBody: `${testEmailTextPrefix(auditId)}\n\n${email.text || ''}`.trim(),
      dedupeKey: [
        'notification-workflow-test',
        run?.id || workflow?.id || 'workflow',
        ticket.id,
        Date.now(),
        Math.random().toString(36).slice(2),
      ].join(':').slice(0, 255),
      payload: {
        preview: true,
        actorEmail,
        workflowId: workflow?.id || run?.workflowId || null,
        auditId,
        ...payload,
      },
    },
  });
  const result = await processDelivery(delivery);
  return { delivery, result, actorEmail, auditId };
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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [sendgridConfig, workflows, recentFailures, mockEnabledWorkflows, workflowAuditRuns7d, mockRuns7d, mockedDeliveries7d, mockDeliveryGroups7d] = await Promise.all([
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
      prisma.notificationWorkflow.count({
        where: {
          workspaceId: req.workspaceId,
          mockModeEnabled: true,
        },
      }),
      prisma.notificationWorkflowRun.count({
        where: {
          workspaceId: req.workspaceId,
          executionMode: { in: ['live', 'mock'] },
          startedAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.notificationWorkflowRun.count({
        where: {
          workspaceId: req.workspaceId,
          executionMode: 'mock',
          startedAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.notificationDelivery.count({
        where: {
          workspaceId: req.workspaceId,
          channel: 'email',
          status: 'mocked',
          queuedAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.notificationDelivery.groupBy({
        by: ['ticketId', 'eventType', 'notificationType'],
        where: {
          workspaceId: req.workspaceId,
          channel: 'email',
          status: 'mocked',
          queuedAt: { gte: sevenDaysAgo },
        },
        _count: { _all: true },
      }),
    ]);
    const duplicateMockDeliveryGroups7d = (mockDeliveryGroups7d || [])
      .filter((row) => (row._count?._all || 0) > 1)
      .map((row) => ({
        ticketId: row.ticketId,
        eventType: row.eventType,
        notificationType: row.notificationType,
        count: row._count?._all || 0,
      }));
    const warnings = [];
    if (duplicateMockDeliveryGroups7d.length > 0) {
      warnings.push({
        type: 'duplicate_mock_delivery_groups',
        message: 'Mock notification audit found duplicate ticket/event delivery groups.',
        count: duplicateMockDeliveryGroups7d.length,
      });
    }

    res.json({
      success: true,
      data: {
        provider: 'sendgrid',
        sendgridConfigured: Boolean(sendgridConfig.configured),
        sendgridMode: sendgridConfig.mode || 'missing',
        enabledWorkflows: workflows.find((row) => row.isEnabled)?._count?._all || 0,
        disabledWorkflows: workflows.find((row) => !row.isEnabled)?._count?._all || 0,
        mockEnabledWorkflows,
        workflowAuditRuns7d,
        mockRuns7d,
        mockedDeliveries7d,
        duplicateMockDeliveryGroups7d,
        warnings,
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
  '/routing/metadata',
  asyncHandler(async (req, res) => {
    const field = String(req.query.field || 'requester.regionKey').trim();
    const search = String(req.query.search || '').trim();
    const activeField = ROUTING_FIELD_LOOKUP.has(field) ? field : 'requester.regionKey';
    const tickets = await routingLookupTickets(req.workspaceId);
    const values = summarizeRoutingFieldValues(tickets, activeField, search);

    res.json({
      success: true,
      data: {
        fields: ROUTING_FIELD_METADATA,
        field: activeField,
        values,
        normalizationRules: [
          'Requester route keys prefer Entra office/city/state/country data.',
          'FreshService department/location is used when Entra does not provide a usable location.',
          'Known city and country values are converted to stable route keys such as AU-BRISBANE.',
          'Brisbane normalizes to AU-BRISBANE for both requester region and requester location.',
        ],
        sampleSize: tickets.length,
      },
    });
  }),
);

router.post(
  '/routing/preview',
  asyncHandler(async (req, res) => {
    const workflowId = parseId(req.body?.workflowId, 'workflow id');
    const workflow = await notificationWorkflowRepository.getWorkflow(req.workspaceId, workflowId);
    const ticket = await prisma.ticket.findFirst({
      where: previewContextTicketWhere(req.workspaceId, req.body || {}),
      include: {
        requester: { select: REQUESTER_PROFILE_SELECT },
        assignedTech: { select: { id: true, name: true, email: true } },
        workspace: { select: { id: true, name: true, defaultTimezone: true } },
        internalCategory: { select: { id: true, name: true } },
        internalSubcategory: { select: { id: true, name: true } },
      },
    });
    if (!ticket) throw new NotFoundError('Preview ticket not found in this workspace');

    const eventContext = await buildPreviewEventContext({
      ticket,
      triggerType: req.body?.triggerType || workflow.triggerType,
    });
    const routingWorkflow = {
      ...workflow,
      routingMode: req.body?.routingMode ?? workflow.routingMode,
      routingPriority: req.body?.routingPriority ?? workflow.routingPriority,
      routingRule: Object.prototype.hasOwnProperty.call(req.body || {}, 'routingRule')
        ? req.body.routingRule
        : workflow.routingRule,
      triggerType: req.body?.triggerType || workflow.triggerType,
    };
    const routingPreview = await buildWorkflowRoutingPreview({
      workspaceId: req.workspaceId,
      workflow: routingWorkflow,
      eventContext,
    });

    res.json({
      success: true,
      data: {
        ticket: serializePreviewTicket(ticket),
        requester: eventContext.requester || null,
        routingPreview,
      },
    });
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
  '/email-blocks',
  asyncHandler(async (req, res) => {
    const blocks = await listWorkspaceEmailBlocks(req.workspaceId);
    res.json({ success: true, data: blocks });
  }),
);

router.post(
  '/email-blocks',
  asyncHandler(async (req, res) => {
    const block = await createWorkspaceEmailBlock(req.workspaceId, req.body || {}, requestActor(req));
    const blocks = await listWorkspaceEmailBlocks(req.workspaceId);
    res.status(201).json({ success: true, data: { ...blocks, selectedId: block.id } });
  }),
);

router.put(
  '/email-blocks/:blockId',
  asyncHandler(async (req, res) => {
    const block = await updateWorkspaceEmailBlock(req.workspaceId, parseId(req.params.blockId, 'email block id'), req.body || {}, requestActor(req));
    const blocks = await listWorkspaceEmailBlocks(req.workspaceId);
    res.json({ success: true, data: { ...blocks, selectedId: block.id } });
  }),
);

router.delete(
  '/email-blocks/:blockId',
  asyncHandler(async (req, res) => {
    await deleteWorkspaceEmailBlock(req.workspaceId, parseId(req.params.blockId, 'email block id'));
    const blocks = await listWorkspaceEmailBlocks(req.workspaceId);
    res.json({ success: true, data: { ...blocks, selectedId: null } });
  }),
);

router.post(
  '/email-blocks/:blockId/default',
  asyncHandler(async (req, res) => {
    const block = await setDefaultWorkspaceEmailBlock(req.workspaceId, parseId(req.params.blockId, 'email block id'), requestActor(req));
    const blocks = await listWorkspaceEmailBlocks(req.workspaceId);
    res.json({ success: true, data: { ...blocks, selectedId: block.id } });
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
  '/llm-tools/catalog',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: notificationLlmToolCatalog() });
  }),
);

router.get(
  '/llm-tools/policy',
  asyncHandler(async (req, res) => {
    const policy = await getNotificationLlmToolPolicy(req.workspaceId);
    res.json({ success: true, data: policy });
  }),
);

router.put(
  '/llm-tools/policy',
  asyncHandler(async (req, res) => {
    const policy = await updateNotificationLlmToolPolicy(req.workspaceId, req.body || {}, requestActor(req));
    res.json({ success: true, data: policy });
  }),
);

router.post(
  '/llm-tools/context-preview',
  asyncHandler(async (req, res) => {
    const ticketWhere = previewContextTicketWhere(req.workspaceId, req.body || {});
    const workflowId = req.body?.workflowId ? parseId(req.body.workflowId, 'workflow id') : null;
    const workflow = workflowId
      ? await notificationWorkflowRepository.getWorkflow(req.workspaceId, workflowId)
      : {
        id: null,
        workspaceId: req.workspaceId,
        key: 'context_preview',
        name: 'Context preview',
        triggerType: 'ticket.created',
        publishedVersion: 0,
      };
    const ticket = await prisma.ticket.findFirst({
      where: ticketWhere,
      include: {
        workspace: true,
        requester: { select: REQUESTER_PROFILE_SELECT },
        assignedTech: { select: { id: true, name: true, email: true, location: true, timezone: true } },
        internalCategory: { select: { id: true, name: true } },
        internalSubcategory: { select: { id: true, name: true } },
      },
    });
    if (!ticket) throw new NotFoundError('Context preview ticket not found in this workspace');

    const eventContext = await buildPreviewEventContext({ ticket, triggerType: workflow.triggerType || 'ticket.created' });
    const currentPolicy = await getNotificationLlmToolPolicy(req.workspaceId);
    const policyOverride = req.body?.policy
      ? normalizeNotificationLlmToolPolicy({
        ...currentPolicy,
        ...req.body.policy,
        workspaceId: req.workspaceId,
        toolSettings: {
          ...(currentPolicy.toolSettings || {}),
          ...(req.body.policy.toolSettings || {}),
          context: {
            ...(currentPolicy.toolSettings?.context || {}),
            ...(req.body.policy.toolSettings?.context || {}),
          },
          outageSignals: {
            ...(currentPolicy.toolSettings?.outageSignals || {}),
            ...(req.body.policy.toolSettings?.outageSignals || {}),
          },
          safety: {
            ...(currentPolicy.toolSettings?.safety || {}),
            ...(req.body.policy.toolSettings?.safety || {}),
          },
        },
      })
      : currentPolicy;
    const bundle = await buildNotificationLlmContext({
      workspaceId: req.workspaceId,
      workflow,
      eventContext,
      state: eventContext.state || {},
      policyOverride,
    });
    res.json({
      success: true,
      data: {
        summary: summarizeNotificationLlmContext(bundle),
        bundle,
        policy: policyOverride,
      },
    });
  }),
);

router.post(
  '/llm-tools/test-run',
  asyncHandler(async (req, res) => {
    const workflowId = parseId(req.body.workflowId, 'workflow id');
    const workflow = await notificationWorkflowRepository.getWorkflow(req.workspaceId, workflowId);
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
    const eventContext = await buildPreviewEventContext({ ticket, triggerType: workflow.triggerType });
    const result = await notificationWorkflowEngine.executePreview({
      workflow,
      definition: req.body.definition || workflow.draftDefinition,
      eventContext,
      executeLlm: true,
      forceActionLinks: req.body.forceActionLinks !== false,
    });
    const toolSteps = (result.steps || []).filter((step) => step.nodeType === 'llm_tool');
    const inlineToolEvents = Array.isArray(result.state?.llm?.toolEvents)
      ? result.state.llm.toolEvents.map((event) => ({
        nodeId: `${event.name || 'tool'}:${event.toolUseId || event.turn || ''}`,
        nodeType: 'llm_tool',
        status: event.status,
        input: event.input,
        output: event.output,
        durationMs: event.durationMs,
        error: event.error || null,
      }))
      : [];
    res.json({
      success: true,
      data: {
        ...result,
        toolSteps: toolSteps.length > 0 ? toolSteps : inlineToolEvents,
      },
    });
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
          requester: { select: REQUESTER_PROFILE_SELECT },
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
  '/runs',
  asyncHandler(async (req, res) => {
    const runs = await notificationWorkflowRepository.listAuditRuns(req.workspaceId, {
      executionMode: req.query.executionMode,
      workflowId: req.query.workflowId,
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data: runs.map(redactRun) });
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
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!run) throw new NotFoundError('Workflow audit run not found in this workspace');
    res.json({ success: true, data: redactRun(run) });
  }),
);

// Returns the run's email re-rendered through the current engine (current template),
// so the audit detail "Rendered Email" preview matches the live/preview/send-test output.
router.get(
  '/audits/:auditId/rendered-email',
  asyncHandler(async (req, res) => {
    const runId = parseAuditRunId(req.params.auditId);
    const run = await prisma.notificationWorkflowRun.findFirst({
      where: { id: runId, workspaceId: req.workspaceId },
      include: {
        workflow: {
          select: {
            id: true,
            workspaceId: true,
            name: true,
            key: true,
            triggerType: true,
            publishedVersion: true,
            publishedDefinition: true,
            draftDefinition: true,
          },
        },
        ticket: { select: { id: true, assessedPriority: true, priority: true } },
        steps: { orderBy: { startedAt: 'asc' } },
        deliveries: { orderBy: { queuedAt: 'asc' } },
      },
    });
    if (!run) throw new NotFoundError('Workflow audit run not found in this workspace');
    const email = await emailFromAuditRun(run);
    res.json({ success: true, data: email || null });
  }),
);

router.post(
  '/audits/:auditId/send-test-email',
  asyncHandler(async (req, res) => {
    const actorEmail = requestActorEmail(req);
    if (!actorEmail) {
      throw new ValidationError('Your session does not include an email address for test delivery');
    }

    const runId = parseAuditRunId(req.params.auditId);
    const run = await prisma.notificationWorkflowRun.findFirst({
      where: { id: runId, workspaceId: req.workspaceId },
      include: {
        workflow: {
          select: {
            id: true,
            workspaceId: true,
            name: true,
            key: true,
            triggerType: true,
            publishedVersion: true,
            publishedDefinition: true,
            draftDefinition: true,
          },
        },
        ticket: {
          select: {
            id: true,
            assessedPriority: true,
            priority: true,
          },
        },
        steps: {
          orderBy: { startedAt: 'asc' },
        },
        deliveries: {
          orderBy: { queuedAt: 'asc' },
        },
      },
    });
    if (!run) throw new NotFoundError('Workflow audit run not found in this workspace');
    if (!run.ticket) throw new ValidationError('Audit run is not linked to a ticket');

    const email = await emailFromAuditRun(run);
    if (!email?.html && !email?.text) {
      throw new ValidationError('No rendered email content was captured for this audit run');
    }

    const originalRecipients = recipientsFromAuditRun(run);
    const { delivery, result, auditId } = await createTestEmailDelivery({
      req,
      ticket: run.ticket,
      run,
      workflow: run.workflow,
      email,
      payload: {
        mockAuditReplay: true,
        originalRecipients,
      },
    });

    res.json({
      success: true,
      data: {
        sentTo: actorEmail,
        deliveryId: delivery.id,
        auditId,
        originalRecipients,
        result,
      },
    });
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
    const routingPreview = await buildWorkflowRoutingPreview({
      workspaceId: req.workspaceId,
      workflow,
      eventContext,
    });
    res.json({ success: true, data: { ...result, routingPreview } });
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
          workflow: {
            select: {
              id: true,
              workspaceId: true,
              name: true,
              key: true,
              triggerType: true,
              publishedVersion: true,
              publishedDefinition: true,
              draftDefinition: true,
            },
          },
          steps: { orderBy: { startedAt: 'asc' } },
          deliveries: { orderBy: { queuedAt: 'asc' } },
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

    const auditedEmail = run ? await emailFromAuditRun(run) : null;
    const { delivery, result, auditId } = await createTestEmailDelivery({
      req,
      ticket,
      run,
      workflow: run?.workflow || workflow,
      email: auditedEmail || {
        subject,
        html,
        text,
      },
      payload: {
        previewRunTest: true,
      },
    });

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
    if (delivery.status === 'mocked') {
      throw new ValidationError('Mocked deliveries cannot be retried because no email was sent');
    }

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

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.createWorkflowVariant(
      req.workspaceId,
      req.body || {},
      requestActor(req),
    );
    res.status(201).json({ success: true, data: workflow });
  }),
);

router.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.duplicateWorkflowVariant(
      req.workspaceId,
      req.params.id,
      req.body || {},
      requestActor(req),
    );
    res.status(201).json({ success: true, data: workflow });
  }),
);

router.put(
  '/:id/routing',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.updateWorkflowRouting(
      req.workspaceId,
      req.params.id,
      req.body || {},
      requestActor(req),
    );
    res.json({ success: true, data: workflow });
  }),
);

router.put(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.setWorkflowArchived(
      req.workspaceId,
      req.params.id,
      req.body?.archived === true,
      requestActor(req),
    );
    res.json({ success: true, data: workflow });
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
    const policy = await getNotificationWorkflowPolicy(req.workspaceId);
    if (isOffHoursWorkflow(result.workflow, policy)) {
      await updateNotificationWorkflowPolicy(req.workspaceId, {
        ...policy,
        afterHoursEnabled: result.workflow.isEnabled === true,
      }, requestActor(req));
    }
    res.json({ success: true, data: result });
  }),
);

router.put(
  '/:id/mock-mode',
  asyncHandler(async (req, res) => {
    const workflow = await notificationWorkflowRepository.setWorkflowMockMode(
      req.workspaceId,
      req.params.id,
      req.body?.enabled === true,
      requestActor(req),
    );
    res.json({ success: true, data: workflow });
  }),
);

router.put(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    const nextEnabled = req.body?.enabled === true;
    const workflow = await notificationWorkflowRepository.setWorkflowEnabled(
      req.workspaceId,
      req.params.id,
      nextEnabled,
      requestActor(req),
    );
    const policy = await getNotificationWorkflowPolicy(req.workspaceId);
    if (isOffHoursWorkflow(workflow, policy)) {
      await updateNotificationWorkflowPolicy(req.workspaceId, {
        ...policy,
        afterHoursEnabled: workflow.isEnabled === true,
      }, requestActor(req));
    }
    res.json({ success: true, data: workflow });
  }),
);

export default router;
