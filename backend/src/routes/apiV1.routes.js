import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../services/prisma.js';
import ticketService from '../services/ticketService.js';
import technicianRepository from '../services/technicianRepository.js';
import groupRepository from '../services/groupRepository.js';
import { TICKET_SOURCE } from '../utils/ticketOrigin.js';
import logger from '../utils/logger.js';
import {
  API_KEY_SCOPES, generateApiKey, hashApiKey, scopeSatisfies,
} from '../services/apiKeyService.js';
import { requireApiKey, apiRequestContext, clientIp } from '../middleware/apiKeyAuth.js';
import { verifyClientCredentials, issueAccessToken } from '../services/oauthClientService.js';
import rateLimiter from '../services/apiRateLimitService.js';
import { withIdempotency } from '../middleware/apiIdempotency.js';
import { apiProblemHandler, problems, ApiProblem } from '../utils/apiProblem.js';
import { resolveCategoryNames } from '../services/categoryNameResolver.js';
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

// Resolve a /tickets/:id path segment to an internal id. A plain positive
// integer is the internal id (unchanged); a visible ref (TP-1048, #233976)
// resolves via the ref resolver → a clean 404 instead of a 500 on a non-numeric
// param (QA 07-21 #7). Cached on the request so repeated reads are free.
async function tid(req) {
  if (req._resolvedTicketId !== undefined) return req._resolvedTicketId;
  const raw = String(req.params.id ?? '');
  let id;
  if (/^\d+$/.test(raw)) {
    id = Number(raw);
  } else {
    const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
    id = (await resolveTicketRefOrThrow(raw, req.workspaceId)).id;
  }
  req._resolvedTicketId = id;
  return id;
}

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
    // Operational review signals (read-only): how many times the ticket
    // bounced back from an assignee, whether the AI flagged its category as a
    // weak fit, and whether it was classified as noise/spam. Surfaced for
    // reporting/audit consumers (e.g. the daily-brief routine).
    rejections: Number(t.rejectionCount) || 0,
    categoryReviewNeeded: t.taxonomyReviewNeeded === true,
    isNoise: t.isNoise === true,
    assignedBy: t.assignedBy || null,
    // Structured intake metadata (FR 08-05 #1) — the workspace's custom-field
    // values keyed by definition key. {} when none are set.
    customFields: t.customFields || {},
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

// ---------------------------------------------- OAuth2 token (client_credentials)
// RFC 6749 shapes (error/error_description). Accepts client_id/secret in the
// form body or via HTTP Basic. Rate-limited per IP to blunt secret guessing.

router.post('/oauth/token', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const ip = clientIp(req);
  if (ip) {
    const r = await rateLimiter.hit(`oauthtoken:${ip}`, 30);
    if (!r.allowed) {
      return res.status(429).set('Retry-After', String(Math.max(1, r.reset - Math.floor(Date.now() / 1000))))
        .json({ error: 'temporarily_unavailable', error_description: 'Too many token requests' });
    }
  }
  if (req.body?.grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only client_credentials is supported' });
  }
  let clientId = req.body?.client_id;
  let clientSecret = req.body?.client_secret;
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Basic ')) {
    const [u, p] = Buffer.from(authz.slice(6), 'base64').toString('utf8').split(':');
    clientId = clientId || u; clientSecret = clientSecret || p;
  }
  const client = await verifyClientCredentials(clientId, clientSecret);
  if (!client) return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
  return res.json(issueAccessToken(client));
}));

// ------------------------------------------------------- discovery: me/meta

router.get('/me', S(), asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.workspaceId }, select: { id: true, name: true, slug: true } });
  res.json({
    success: true,
    data: {
      authType: req.apiKey.oauthClientId ? 'oauth' : 'api_key',
      key: { name: req.apiKey.name, prefix: req.apiKey.keyPrefix, mode: req.apiKey.mode, scopes: req.apiKey.scopes },
      workspace: ws,
      rateLimit: { perMinute: Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE || 120) },
    },
  });
}));

router.get('/meta', S(), asyncHandler(async (req, res) => {
  const types = await prisma.ticketTypeDefinition.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { name: true, description: true, isDefault: true }, orderBy: { name: 'asc' },
  }).catch(() => []);
  // Per-workspace status registry (Phase 8c). `statuses` keeps its original
  // string[] shape (names, display order) for existing consumers;
  // `statusDetails` adds each label's canonical base for automation that
  // needs lifecycle semantics ("is this open-like?").
  const { default: statusService } = await import('../services/statusService.js');
  const statusDefs = await statusService.listStatuses(req.workspaceId);
  res.json({
    success: true,
    data: {
      priorities: [
        { value: 1, label: 'Low' }, { value: 2, label: 'Medium' },
        { value: 3, label: 'High' }, { value: 4, label: 'Urgent' },
      ],
      statuses: statusDefs.map((s) => s.name),
      statusDetails: statusDefs.map((s) => ({ name: s.name, baseStatus: s.baseStatus })),
      ticketTypes: types,
    },
  });
}));

// ------------------------------------------------------------------ tickets

router.get('/tickets', S('tickets:read'), asyncHandler(async (req, res) => {
  // Default the public API to cursor (keyset) pagination so `next_cursor` is
  // always present for forward paging; honour an explicit ?page= for offset
  // paging (QA 07-21 #8 — the default response had no cursor to follow).
  const q = { ...req.query };
  if (q.page === undefined && q.cursor === undefined) q.useCursor = true;
  const result = await ticketService.listTickets(req.workspaceId, q);
  const pagination = result.nextCursor !== undefined
    ? { next_cursor: result.nextCursor, limit: result.pageSize, total: result.total }
    : { page: result.page, page_size: result.pageSize, total: result.total };
  if (pagination.next_cursor) {
    // Preserve the active filters on the next-page link — otherwise a client
    // following it gets page 2 of the *unfiltered* list.
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      if (k !== 'cursor' && k !== 'page' && v !== undefined && v !== null) qs.set(k, String(v));
    }
    qs.set('cursor', pagination.next_cursor);
    res.set('Link', `<${req.baseUrl}/tickets?${qs.toString()}>; rel="next"`);
  }
  res.json({ success: true, data: { items: result.items.map(ticketShape), pagination } });
}));

// Body keys the create endpoint consumes (FR 08-05 #1). Anything else stays
// tolerated-but-dropped — and is now REPORTED back via meta.ignoredFields so
// senders can see what didn't land (extra intake data belongs inside
// `customFields`, where it is stored and auto-provisioned).
const CREATE_BODY_KEYS = new Set([
  'subject', 'description', 'priority', 'requesterEmail', 'requesterName',
  'runAiTriage', 'category', 'subcategory', 'customFields', 'ccEmails',
  'source', 'ticketType', 'type', 'groupId', 'internalGroupId',
]);

// customfields:write is demanded ONLY when the payload actually carries
// custom fields — plain ticket writes keep working with tickets:write alone.
function assertCustomFieldsWriteScope(req) {
  if (!scopeSatisfies(req.apiKey.scopes, 'customfields:write')) {
    throw problems.forbidden(
      "This credential is missing the 'customfields:write' scope (required because the payload contains customFields)",
      'insufficient_scope',
    );
  }
}

router.post('/tickets', S('tickets:write'), withIdempotency, asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body.customFields !== undefined) assertCustomFieldsWriteScope(req);
  const ignoredFields = Object.keys(body).filter((k) => !CREATE_BODY_KEYS.has(k));
  const ticketType = body.ticketType ?? body.type;
  const ticket = await ticketService.createTicket(req.workspaceId, {
    subject: body.subject,
    description: body.description || null,
    priority: body.priority || 2,
    requesterEmail: body.requesterEmail,
    requesterName: body.requesterName || null,
    runAiTriage: body.runAiTriage !== false,
    // Category/subcategory BY NAME (resolved against the workspace taxonomy;
    // unknown names 400 with the allowed values listed).
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.subcategory !== undefined ? { subcategory: body.subcategory } : {}),
    // Arbitrary structured metadata — stored on the ticket; unknown keys
    // auto-provision a definition (source:'api').
    ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
    ...(body.ccEmails !== undefined ? { ccEmails: body.ccEmails } : {}),
    // Arrival-channel override, validated against the agent-selectable list
    // by the schema. 100 (API) is this route's default — omit it so the
    // default applies rather than tripping the schema's allowlist.
    ...(body.source !== undefined && Number(body.source) !== TICKET_SOURCE.API ? { source: body.source } : {}),
    // `ticketType` (or its read-shape alias `type`) — validated against the
    // workspace type registry; omitted → workspace default.
    ...(ticketType !== undefined && ticketType !== null ? { ticketType } : {}),
    // Group placement (QA 08-06 #1): senders can pin a FreshService group or
    // an internal (TP-native) group; when BOTH are omitted the workspace's
    // default internal group applies automatically.
    ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
    ...(body.internalGroupId !== undefined ? { internalGroupId: body.internalGroupId } : {}),
  }, apiActor(req), { sourceChannel: TICKET_SOURCE.API });
  logger.info(`API v1: ticket ${ticket.displayRef} created via key "${req.apiKey.name}"`);
  res.status(201).json({
    success: true,
    data: ticketShape(ticket),
    // Intake transparency (FR 08-05 #1): what didn't land and what got
    // auto-provisioned. rejected entries are {key, reason}.
    meta: {
      ignoredFields,
      rejectedCustomFields: ticket.customFieldIntake?.rejected || [],
      provisionedCustomFields: ticket.customFieldIntake?.provisioned || [],
    },
  });
}));

router.get('/tickets/:id', S('tickets:read'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket((await tid(req)), req.workspaceId);
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
  const id = (await tid(req));
  const body = req.body || {};
  const actor = apiActor(req);
  if (body.customFields !== undefined) assertCustomFieldsWriteScope(req);
  if (body.status !== undefined) await ticketService.changeStatus(id, req.workspaceId, body.status, actor);
  if (body.assignedTechId !== undefined) {
    await ticketService.assignTicket(id, req.workspaceId, body.assignedTechId ? Number(body.assignedTechId) : null, actor);
  }
  const fieldKeys = ['subject', 'priority', 'internalCategoryId', 'internalSubcategoryId', 'groupId'];
  const fields = Object.fromEntries(fieldKeys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  // Category/subcategory BY NAME (FR 08-05 #1) — explicit IDs win when both
  // spellings are sent; `category: null` clears the pair.
  if ((body.category !== undefined || body.subcategory !== undefined) && body.internalCategoryId === undefined) {
    const resolved = await resolveCategoryNames(req.workspaceId, body.category, body.subcategory);
    fields.internalCategoryId = resolved.categoryId;
    fields.internalSubcategoryId = resolved.subcategoryId;
  }
  if (Object.keys(fields).length) await ticketService.updateTicketFields(id, req.workspaceId, fields, actor);
  if (body.customFields !== undefined) {
    // NO auto-provisioning on PATCH — creation is the intake path that
    // provisions definitions. Unknown keys are a 422 naming every offender
    // (setValues alone would stop at the first one).
    const { default: customFieldService } = await import('../services/customFieldService.js');
    const known = new Set((await customFieldService.listDefinitions(req.workspaceId)).map((d) => d.key));
    const unknown = Object.keys(body.customFields || {}).filter((k) => !known.has(k));
    if (unknown.length) {
      throw new ApiProblem({
        status: 422,
        code: 'unknown_custom_fields',
        title: 'Unknown custom fields',
        detail: `Unknown custom field key(s): ${unknown.join(', ')}. Definitions are created in Settings or auto-provisioned at ticket creation — see GET /api/v1/custom-fields for this workspace's fields.`,
        errors: unknown.map((k) => ({ field: `customFields.${k}`, code: 'unknown_field' })),
      });
    }
    await customFieldService.setValues(id, req.workspaceId, body.customFields, actor);
  }
  const ticket = await ticketService.getTicket(id, req.workspaceId);
  res.json({ success: true, data: ticketShape(ticket) });
}));

router.post('/tickets/:id/merge', S('tickets:write'), withIdempotency, asyncHandler(async (req, res) => {
  const { default: ticketMergeService } = await import('../services/ticketMergeService.js');
  const result = await ticketMergeService.merge((await tid(req)), req.workspaceId, {
    targetTicketId: Number(req.body?.targetTicketId),
    notifyRequester: req.body?.notifyRequester === true,
  }, apiActor(req));
  res.json({ success: true, data: result });
}));

router.get('/tickets/:id/family', S('tickets:read'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  res.json({ success: true, data: await ticketLinkService.family((await tid(req)), req.workspaceId) });
}));

router.put('/tickets/:id/parent', S('tickets:write'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const result = await ticketLinkService.setParent((await tid(req)), req.workspaceId, {
    parentTicketId: Number(req.body?.parentTicketId),
  }, apiActor(req));
  res.json({ success: true, data: result });
}));

router.delete('/tickets/:id/parent', S('tickets:write'), asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  res.json({ success: true, data: await ticketLinkService.removeParent((await tid(req)), req.workspaceId, apiActor(req)) });
}));

// -------------------------------------------------------- conversations

router.get('/tickets/:id/conversations', S('conversations:read'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket((await tid(req)), req.workspaceId);
  res.json({ success: true, data: (ticket.thread || []).filter((e) => e.bodyText || e.content).map(threadEntryShape) });
}));

router.post('/tickets/:id/replies', S(['tickets:write', 'conversations:write']), withIdempotency, asyncHandler(async (req, res) => {
  const result = await ticketService.addReply((await tid(req)), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: { entryId: result.entry.id, emailed: result.email?.sent === true } });
}));

router.post('/tickets/:id/notes', S('conversations:write'), withIdempotency, asyncHandler(async (req, res) => {
  const result = await ticketService.addPrivateNote((await tid(req)), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: { entryId: result.entry.id } });
}));

// ------------------------------------------------------------------ tasks

router.get('/tickets/:id/tasks', S('tasks:read'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  res.json({ success: true, data: await ticketTaskService.listForTicket((await tid(req)), req.workspaceId) });
}));

router.post('/tickets/:id/tasks', S('tasks:write'), withIdempotency, asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.create((await tid(req)), req.workspaceId, req.body || {}, apiActor(req));
  res.status(201).json({ success: true, data: task });
}));

router.patch('/tickets/:id/tasks/:taskId', S('tasks:write'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.update(Number(req.params.taskId), req.workspaceId, req.body || {}, apiActor(req), (await tid(req)));
  res.json({ success: true, data: task });
}));

router.delete('/tickets/:id/tasks/:taskId', S('tasks:write'), asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  res.json({ success: true, data: await ticketTaskService.remove(Number(req.params.taskId), req.workspaceId, apiActor(req), (await tid(req))) });
}));

// ------------------------------------------------------------ attachments

router.get('/tickets/:id/attachments', S('attachments:read'), asyncHandler(async (req, res) => {
  const rows = await prisma.ticketAttachment.findMany({
    where: { ticketId: (await tid(req)), workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
  });
  res.json({ success: true, data: rows });
}));

router.get('/tickets/:id/attachments/:attachmentId', S('attachments:read'), asyncHandler(async (req, res) => {
  const { default: attachmentService } = await import('../services/attachmentService.js');
  const { attachment, stream } = await attachmentService.openDownload(
    Number(req.params.attachmentId), (await tid(req)), req.workspaceId,
  );
  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
  stream.pipe(res);
}));

// ------------------------------------------------------------- approvals

router.get('/tickets/:id/approvals', S('approvals:read'), asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approvals = await ticketApprovalService.listForTicket((await tid(req)), req.workspaceId);
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
  const result = await ticketApprovalService.request((await tid(req)), req.workspaceId, {
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
  const result = await ticketService.setTags((await tid(req)), req.workspaceId, req.body?.tagIds, apiActor(req));
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

// Active custom-field definitions (FR 08-05 #1) — what keys/types this
// workspace's tickets can carry, incl. which were auto-provisioned by intake
// (source:'api') vs created by an admin (source:'manual').
router.get('/custom-fields', S('customfields:read'), asyncHandler(async (req, res) => {
  const { default: customFieldService } = await import('../services/customFieldService.js');
  const definitions = await customFieldService.listDefinitions(req.workspaceId);
  res.json({
    success: true,
    data: definitions.map((d) => ({
      key: d.key, label: d.label, type: d.type, options: d.options || [], source: d.source || 'manual',
    })),
  });
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
