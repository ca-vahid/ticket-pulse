import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../services/prisma.js';
import ticketService from '../services/ticketService.js';
import technicianRepository from '../services/technicianRepository.js';
import groupRepository from '../services/groupRepository.js';
import { TICKET_SOURCE } from '../utils/ticketOrigin.js';
import logger from '../utils/logger.js';
import {
  API_KEY_SCOPES, generateApiKey, hashApiKey,
} from '../services/apiKeyService.js';
import { requireApiKey, apiRequestContext } from '../middleware/apiKeyAuth.js';
import { withIdempotency } from '../middleware/apiIdempotency.js';
import { apiProblemHandler, problems } from '../utils/apiProblem.js';
import { buildOpenApiSpec, renderDocsPage } from './apiV1.openapi.js';

/**
 * Public integration API (/api/v1) — key-authenticated, workspace-scoped,
 * FreshService-replacement grade. Auth: `Authorization: Bearer tp_live_…`.
 * Errors are RFC 9457 problem+json; every response carries X-Request-Id and
 * X-RateLimit-* headers; writes accept an Idempotency-Key.
 *
 * Re-exports the key helpers so existing importers keep working; the canonical
 * home is services/apiKeyService.js.
 */
export { API_KEY_SCOPES, generateApiKey, hashApiKey };

const router = express.Router();
router.use(apiRequestContext);

const S = requireApiKey;
const apiActor = (req) => ({
  email: `apikey:${req.apiKey.keyPrefix}`,
  name: req.apiKey.name,
  role: 'api',
  technicianId: null,
});

// ---------------------------------------------------------------- shapers

function ticketShape(t) {
  return {
    id: t.id,
    ref: t.displayRef,
    origin: t.origin,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    type: t.ticketType || null,
    requester: t.requester ? { id: t.requester.id, name: t.requester.name, email: t.requester.email } : null,
    assignee: t.assignedTech ? { id: t.assignedTech.id, name: t.assignedTech.name } : null,
    group: t.group ? { id: t.group.id, name: t.group.name } : null,
    category: t.internalCategory?.name || null,
    subcategory: t.internalSubcategory?.name || null,
    tags: Array.isArray(t.tags) ? t.tags.map((tag) => (typeof tag === 'string' ? tag : tag.name)) : [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt || null,
  };
}

function threadEntryShape(e) {
  return {
    id: e.id,
    type: e.eventType,
    author: e.actorName,
    authorType: e.authorType || null,
    isPrivate: e.isPrivate === true,
    body: e.bodyText || e.content,
    at: e.occurredAt,
  };
}

function contactShape(r) {
  return {
    id: r.id, name: r.name, email: r.email || null, phone: r.phone || null,
    department: r.department || null, location: r.entraOfficeLocation || null,
  };
}

// ------------------------------------------------------- discovery: me/meta

router.get('/me', S(), asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.workspaceId }, select: { id: true, name: true, slug: true } });
  res.json({
    success: true,
    data: {
      key: { name: req.apiKey.name, prefix: req.apiKey.keyPrefix, mode: req.apiKey.mode, scopes: req.apiKey.scopes },
      workspace: ws,
      rateLimit: { perMinute: req.apiKey.rateLimitPerMin || Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE || 120) },
    },
  });
}));

router.get('/meta', S(), asyncHandler(async (req, res) => {
  const types = await prisma.ticketTypeDefinition.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { name: true, description: true, isDefault: true }, orderBy: { name: 'asc' },
  }).catch(() => []);
  res.json({
    success: true,
    data: {
      priorities: [
        { value: 1, label: 'Low' }, { value: 2, label: 'Medium' },
        { value: 3, label: 'High' }, { value: 4, label: 'Urgent' },
      ],
      statuses: ['Open', 'Pending', 'Resolved', 'Closed'],
      ticketTypes: types,
    },
  });
}));

// ------------------------------------------------------------------ tickets

router.get('/tickets', S('tickets:read'), asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(req.workspaceId, req.query);
  const pagination = result.nextCursor !== undefined
    ? { next_cursor: result.nextCursor, limit: result.pageSize }
    : { page: result.page, page_size: result.pageSize, total: result.total };
  if (pagination.next_cursor) res.set('Link', `<${req.baseUrl}/tickets?cursor=${pagination.next_cursor}>; rel="next"`);
  res.json({ success: true, data: { items: result.items.map(ticketShape), pagination } });
}));

router.post('/tickets', S('tickets:write'), withIdempotency, asyncHandler(async (req, res) => {
  const ticket = await ticketService.createTicket(req.workspaceId, {
    subject: req.body?.subject,
    description: req.body?.description || null,
    priority: req.body?.priority || 2,
    requesterEmail: req.body?.requesterEmail,
    requesterName: req.body?.requesterName || null,
    runAiTriage: req.body?.runAiTriage !== false,
  }, apiActor(req), { sourceChannel: TICKET_SOURCE.API });
  logger.info(`API v1: ticket ${ticket.displayRef} created via key "${req.apiKey.name}"`);
  res.status(201).json({ success: true, data: ticketShape(ticket) });
}));

router.get('/tickets/:id', S('tickets:read'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket(Number(req.params.id), req.workspaceId);
  res.json({
    success: true,
    data: {
      ...ticketShape(ticket),
      description: ticket.descriptionText || null,
      conversations: (ticket.thread || []).filter((e) => (e.bodyText || e.content) && e.isPrivate !== true).map(threadEntryShape),
    },
  });
}));

router.patch('/tickets/:id', S('tickets:write'), withIdempotency, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const actor = apiActor(req);
  if (body.status !== undefined) await ticketService.changeStatus(id, req.workspaceId, body.status, actor);
  if (body.assignedTechId !== undefined) {
    await ticketService.assignTicket(id, req.workspaceId, body.assignedTechId ? Number(body.assignedTechId) : null, actor);
  }
  const fieldKeys = ['subject', 'priority', 'internalCategoryId', 'internalSubcategoryId', 'groupId'];
  const fields = Object.fromEntries(fieldKeys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (Object.keys(fields).length) await ticketService.updateTicketFields(id, req.workspaceId, fields, actor);
  const ticket = await ticketService.getTicket(id, req.workspaceId);
  res.json({ success: true, data: ticketShape(ticket) });
}));

router.post('/tickets/:id/merge', S('tickets:write'), withIdempotency, asyncHandler(async (req, res) => {
  const { default: ticketMergeService } = await import('../services/ticketMergeService.js');
  const result = await ticketMergeService.merge(Number(req.params.id), req.workspaceId, {
    targetTicketId: Number(req.body?.targetTicketId),
    notifyRequester: req.body?.notifyRequester === true,
  }, apiActor(req));
  res.json({ success: true, data: result });
}));

router.get('/tickets/:id/family', S('tickets:read'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  res.json({ success: true, data: await ticketLinkService.family(Number(req.params.id), req.workspaceId) });
}));

router.put('/tickets/:id/parent', S('tickets:write'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const result = await ticketLinkService.setParent(Number(req.params.id), req.workspaceId, {
    parentTicketId: Number(req.body?.parentTicketId),
  }, apiActor(req));
  res.json({ success: true, data: result });
}));

router.delete('/tickets/:id/parent', S('tickets:write'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  res.json({ success: true, data: await ticketLinkService.removeParent(Number(req.params.id), req.workspaceId, apiActor(req)) });
}));

// -------------------------------------------------------- conversations

router.get('/tickets/:id/conversations', S('conversations:read'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket(Number(req.params.id), req.workspaceId);
  res.json({ success: true, data: (ticket.thread || []).filter((e) => e.bodyText || e.content).map(threadEntryShape) });
}));

router.post('/tickets/:id/replies', S(['tickets:write', 'conversations:write']), withIdempotency, asyncHandler(async (req, res) => {
  const result = await ticketService.addReply(Number(req.params.id), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: { entryId: result.entry.id, emailed: result.email?.sent === true } });
}));

router.post('/tickets/:id/notes', S('conversations:write'), withIdempotency, asyncHandler(async (req, res) => {
  const result = await ticketService.addPrivateNote(Number(req.params.id), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: { entryId: result.entry.id } });
}));

// ------------------------------------------------------------------ tasks

router.get('/tickets/:id/tasks', S('tasks:read'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  res.json({ success: true, data: await ticketTaskService.listForTicket(Number(req.params.id), req.workspaceId) });
}));

router.post('/tickets/:id/tasks', S('tasks:write'), withIdempotency, asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.create(Number(req.params.id), req.workspaceId, req.body || {}, apiActor(req));
  res.status(201).json({ success: true, data: task });
}));

router.patch('/tickets/:id/tasks/:taskId', S('tasks:write'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.update(Number(req.params.taskId), req.workspaceId, req.body || {}, apiActor(req));
  res.json({ success: true, data: task });
}));

router.delete('/tickets/:id/tasks/:taskId', S('tasks:write'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  res.json({ success: true, data: await ticketTaskService.remove(Number(req.params.taskId), req.workspaceId, apiActor(req)) });
}));

// ------------------------------------------------------------ attachments

router.get('/tickets/:id/attachments', S('attachments:read'), asyncHandler(async (req, res) => {
  const rows = await prisma.ticketAttachment.findMany({
    where: { ticketId: Number(req.params.id), workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
  });
  res.json({ success: true, data: rows });
}));

router.get('/tickets/:id/attachments/:attachmentId', S('attachments:read'), asyncHandler(async (req, res) => {
  const { default: attachmentService } = await import('../services/attachmentService.js');
  const { attachment, stream } = await attachmentService.openDownload(
    Number(req.params.attachmentId), Number(req.params.id), req.workspaceId,
  );
  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
  stream.pipe(res);
}));

// ------------------------------------------------------------- approvals

router.get('/tickets/:id/approvals', S('approvals:read'), asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approvals = await ticketApprovalService.listForTicket(Number(req.params.id), req.workspaceId);
  res.json({
    success: true,
    data: approvals.map((a) => ({
      id: a.id, status: a.status, approverEmail: a.approverEmail,
      requestedBy: a.requestedBy, requestNote: a.requestNote,
      decisionNote: a.decisionNote, decidedAt: a.decidedAt, createdAt: a.createdAt,
    })),
  });
}));

router.post('/tickets/:id/approvals', S('approvals:write'), withIdempotency, asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const result = await ticketApprovalService.request(Number(req.params.id), req.workspaceId, {
    approvalCategoryId: req.body?.approvalCategoryId,
    note: req.body?.note || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: result });
}));

// ------------------------------------------------------------------ tags

router.get('/tags', S('tags:read'), asyncHandler(async (req, res) => {
  const tags = await prisma.ticketTag.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, color: true }, orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: tags });
}));

router.put('/tickets/:id/tags', S('tags:write'), asyncHandler(async (req, res) => {
  const result = await ticketService.setTags(Number(req.params.id), req.workspaceId, req.body?.tagIds, apiActor(req));
  res.json({ success: true, data: result });
}));

// ------------------------------------------------- directory (read-only)

router.get('/contacts', S('contacts:read'), asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = { workspaceId: req.workspaceId, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {}) };
  const rows = await prisma.requester.findMany({ where, orderBy: { name: 'asc' }, take: 100 });
  res.json({ success: true, data: rows.map(contactShape) });
}));

router.get('/contacts/:id', S('contacts:read'), asyncHandler(async (req, res) => {
  const r = await prisma.requester.findFirst({ where: { id: Number(req.params.id), workspaceId: req.workspaceId } });
  if (!r) throw problems.notFound('Contact not found');
  res.json({ success: true, data: contactShape(r) });
}));

router.get('/agents', S('agents:read'), asyncHandler(async (req, res) => {
  const techs = await technicianRepository.getAll(req.workspaceId, { lite: true });
  res.json({ success: true, data: techs.map((t) => ({ id: t.id, name: t.name, email: t.email || null, isActive: t.isActive !== false })) });
}));

router.get('/groups', S('groups:read'), asyncHandler(async (req, res) => {
  const groups = await groupRepository.listForWorkspace(req.workspaceId);
  res.json({ success: true, data: groups.map((g) => ({ id: g.id, name: g.name, description: g.description || null })) });
}));

router.get('/categories', S('categories:read'), asyncHandler(async (req, res) => {
  const cats = await prisma.competencyCategory.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, parentId: true }, orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: cats });
}));

router.get('/types', S('types:read'), asyncHandler(async (req, res) => {
  const types = await prisma.ticketTypeDefinition.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, description: true, isDefault: true }, orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: types });
}));

// ------------------------------------------------------------------ search

router.get('/search/tickets', S('search:read'), asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(req.workspaceId, { ...req.query, q: req.query.query || req.query.q });
  const pagination = result.nextCursor !== undefined
    ? { next_cursor: result.nextCursor, limit: result.pageSize }
    : { page: result.page, page_size: result.pageSize, total: result.total };
  res.json({ success: true, data: { items: result.items.map(ticketShape), pagination } });
}));

// ------------------------------------------------ OpenAPI spec + docs (public)

router.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiSpec(`${req.protocol}://${req.get('host')}`));
});

router.get('/docs', (req, res) => {
  res.type('html').send(renderDocsPage(`${req.protocol}://${req.get('host')}`));
});

// problem+json for everything raised inside /api/v1
router.use(apiProblemHandler);

export default router;
