import crypto from 'node:crypto';
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../services/prisma.js';
import ticketService from '../services/ticketService.js';
import logger from '../utils/logger.js';

/**
 * Public integration API (/api/v1) — key-authenticated, workspace-scoped.
 *
 *   Authorization: Bearer tpk_<key>
 *
 * Scopes: tickets:read (list/get), tickets:write (create/reply).
 * Rate limit: 120 requests/minute per key (in-memory sliding window).
 */
const router = express.Router();

// Individually grantable per key (gap plan P3.1). tickets:write covers
// create + public replies; notes/attachments/approvals/tags are separate
// grants so integrations get exactly what they need.
export const API_KEY_SCOPES = [
  'tickets:read', 'tickets:write', 'tickets:notes', 'tickets:attachments',
  'approvals:read', 'approvals:write', 'tags:read', 'tags:write',
];
const RATE_LIMIT_PER_MINUTE = Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE || 120);
const rateBuckets = new Map(); // keyId → number[] request timestamps

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

export function generateApiKey() {
  const raw = `tpk_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

function rateLimited(keyId) {
  const now = Date.now();
  const windowStart = now - 60 * 1000;
  const bucket = (rateBuckets.get(keyId) || []).filter((t) => t > windowStart);
  if (bucket.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(keyId, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(keyId, bucket);
  return false;
}

const requireApiKey = (scope) => asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!raw || !raw.startsWith('tpk_')) {
    return res.status(401).json({ success: false, error: 'api_key_required', message: 'Provide an API key: Authorization: Bearer tpk_…' });
  }

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
  if (!key || !key.isEnabled) {
    return res.status(401).json({ success: false, error: 'invalid_api_key', message: 'Unknown or disabled API key' });
  }
  if (scope && !key.scopes.includes(scope)) {
    return res.status(403).json({ success: false, error: 'insufficient_scope', message: `This key is missing the ${scope} scope` });
  }
  if (rateLimited(key.id)) {
    res.set('Retry-After', '30');
    return res.status(429).json({ success: false, error: 'rate_limited', message: `Limit is ${RATE_LIMIT_PER_MINUTE} requests/minute per key` });
  }

  req.apiKey = key;
  req.workspaceId = key.workspaceId;
  prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
  }).catch(() => {});
  next();
});

function publicTicketShape(t) {
  return {
    id: t.id,
    ref: t.displayRef,
    origin: t.origin,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    requester: t.requester ? { name: t.requester.name, email: t.requester.email } : null,
    assignee: t.assignedTech ? { id: t.assignedTech.id, name: t.assignedTech.name } : null,
    category: t.internalCategory?.name || null,
    subcategory: t.internalSubcategory?.name || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt || null,
  };
}

router.get('/tickets', requireApiKey('tickets:read'), asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(req.workspaceId, req.query);
  res.json({
    success: true,
    data: {
      items: result.items.map(publicTicketShape),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    },
  });
}));

router.get('/tickets/:id', requireApiKey('tickets:read'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket(Number(req.params.id), req.workspaceId);
  res.json({
    success: true,
    data: {
      ...publicTicketShape(ticket),
      description: ticket.descriptionText || null,
      thread: (ticket.thread || [])
        .filter((e) => e.bodyText || e.content)
        .map((e) => ({
          id: e.id,
          type: e.eventType,
          author: e.actorName,
          authorType: e.authorType || null,
          isPrivate: e.isPrivate === true,
          body: e.bodyText || e.content,
          at: e.occurredAt,
        })),
    },
  });
}));

router.post('/tickets', requireApiKey('tickets:write'), asyncHandler(async (req, res) => {
  const ticket = await ticketService.createTicket(req.workspaceId, {
    subject: req.body?.subject,
    description: req.body?.description || null,
    priority: req.body?.priority || 2,
    requesterEmail: req.body?.requesterEmail,
    requesterName: req.body?.requesterName || null,
    runAiTriage: req.body?.runAiTriage !== false,
  }, {
    email: `apikey:${req.apiKey.keyPrefix}`,
    name: req.apiKey.name,
    role: 'api',
    technicianId: null,
  });
  logger.info(`API v1: ticket ${ticket.displayRef} created via key "${req.apiKey.name}"`);
  res.status(201).json({ success: true, data: publicTicketShape(ticket) });
}));

router.post('/tickets/:id/replies', requireApiKey('tickets:write'), asyncHandler(async (req, res) => {
  const result = await ticketService.addReply(Number(req.params.id), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, {
    email: `apikey:${req.apiKey.keyPrefix}`,
    name: req.apiKey.name,
    role: 'api',
    technicianId: null,
  });
  res.status(201).json({ success: true, data: { entryId: result.entry.id, emailed: result.email?.sent === true } });
}));

const apiActor = (req) => ({
  email: `apikey:${req.apiKey.keyPrefix}`,
  name: req.apiKey.name,
  role: 'api',
  technicianId: null,
});

// ------------------------------------------------- notes (tickets:notes)

router.post('/tickets/:id/notes', requireApiKey('tickets:notes'), asyncHandler(async (req, res) => {
  const result = await ticketService.addPrivateNote(Number(req.params.id), req.workspaceId, {
    bodyText: req.body?.body || req.body?.bodyText,
    bodyHtml: req.body?.bodyHtml || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: { entryId: result.entry.id } });
}));

// -------------------------------------- attachments (tickets:attachments)

router.get('/tickets/:id/attachments', requireApiKey('tickets:attachments'), asyncHandler(async (req, res) => {
  const rows = await prisma.ticketAttachment.findMany({
    where: { ticketId: Number(req.params.id), workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
  });
  res.json({ success: true, data: rows });
}));

router.get('/tickets/:id/attachments/:attachmentId', requireApiKey('tickets:attachments'), asyncHandler(async (req, res) => {
  const { default: attachmentService } = await import('../services/attachmentService.js');
  const { attachment, stream } = await attachmentService.openDownload(
    Number(req.params.attachmentId), Number(req.params.id), req.workspaceId,
  );
  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
  stream.pipe(res);
}));

// ------------------------------------------------ approvals (approvals:*)

router.get('/tickets/:id/approvals', requireApiKey('approvals:read'), asyncHandler(async (req, res) => {
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

router.post('/tickets/:id/approvals', requireApiKey('approvals:write'), asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const result = await ticketApprovalService.request(Number(req.params.id), req.workspaceId, {
    approvalCategoryId: req.body?.approvalCategoryId,
    note: req.body?.note || null,
  }, apiActor(req));
  res.status(201).json({ success: true, data: result });
}));

// ------------------------------------------------------- tags (tags:*)

router.get('/tags', requireApiKey('tags:read'), asyncHandler(async (req, res) => {
  const tags = await prisma.ticketTag.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, color: true },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: tags });
}));

router.put('/tickets/:id/tags', requireApiKey('tags:write'), asyncHandler(async (req, res) => {
  const result = await ticketService.setTags(
    Number(req.params.id), req.workspaceId, req.body?.tagIds, apiActor(req),
  );
  res.json({ success: true, data: result });
}));

// -------------------------------------------------- OpenAPI spec + docs
// Public-safe: describes the surface, carries no data. Self-contained (CSP-
// friendly) — the docs page renders the spec without external assets.

function buildOpenApiSpec(baseUrl) {
  const bearer = [{ apiKey: [] }];
  const okRef = (desc) => ({ 200: { description: desc } });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Ticket Pulse Integration API',
      version: '1.0.0',
      description: 'Key-authenticated, workspace-scoped integration API. Authenticate with `Authorization: Bearer tpk_…`. Each key carries explicit scopes.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key (tpk_…) issued in Settings → API Keys' } },
    },
    paths: {
      '/tickets': {
        get: { summary: 'List tickets (filters mirror the app queue: status, priority, q, tagId, …)', security: bearer, responses: okRef('Paged ticket list'), tags: ['tickets'], 'x-scope': 'tickets:read' },
        post: { summary: 'Create a TP-born ticket', security: bearer, responses: { 201: { description: 'Created ticket' } }, tags: ['tickets'], 'x-scope': 'tickets:write' },
      },
      '/tickets/{id}': { get: { summary: 'Get a ticket with its public thread', security: bearer, responses: okRef('Ticket detail'), tags: ['tickets'], 'x-scope': 'tickets:read' } },
      '/tickets/{id}/replies': { post: { summary: 'Add a public reply (emails the requester via the normal path)', security: bearer, responses: { 201: { description: 'Entry created' } }, tags: ['tickets'], 'x-scope': 'tickets:write' } },
      '/tickets/{id}/notes': { post: { summary: 'Add a private internal note', security: bearer, responses: { 201: { description: 'Entry created' } }, tags: ['tickets'], 'x-scope': 'tickets:notes' } },
      '/tickets/{id}/attachments': { get: { summary: 'List attachments', security: bearer, responses: okRef('Attachment list'), tags: ['attachments'], 'x-scope': 'tickets:attachments' } },
      '/tickets/{id}/attachments/{attachmentId}': { get: { summary: 'Download an attachment', security: bearer, responses: okRef('File stream'), tags: ['attachments'], 'x-scope': 'tickets:attachments' } },
      '/tickets/{id}/approvals': {
        get: { summary: 'List approvals on a ticket', security: bearer, responses: okRef('Approval list'), tags: ['approvals'], 'x-scope': 'approvals:read' },
        post: { summary: 'Request approval against a category', security: bearer, responses: { 201: { description: 'Approval fan-out created' } }, tags: ['approvals'], 'x-scope': 'approvals:write' },
      },
      '/tags': { get: { summary: 'List the workspace tag palette', security: bearer, responses: okRef('Tag list'), tags: ['tags'], 'x-scope': 'tags:read' } },
      '/tickets/{id}/tags': { put: { summary: 'Replace a ticket’s tag set', security: bearer, responses: okRef('Updated tag list'), tags: ['tags'], 'x-scope': 'tags:write' } },
    },
  };
}

router.get('/openapi.json', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(buildOpenApiSpec(baseUrl));
});

router.get('/docs', (req, res) => {
  const spec = buildOpenApiSpec(`${req.protocol}://${req.get('host')}`);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = Object.entries(spec.paths).flatMap(([path, methods]) => (
    Object.entries(methods).map(([method, op]) => (
      `<tr><td class="m ${method}">${method.toUpperCase()}</td><td class="p">${esc(path)}</td><td>${esc(op.summary)}</td><td class="s">${esc(op['x-scope'] || '')}</td></tr>`
    ))
  )).join('');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ticket Pulse API</title>
<style>body{font-family:system-ui,sans-serif;color:#1e293b;max-width:900px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}p{color:#475569}code{background:#f1f5f9;border-radius:4px;padding:0 4px}
table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{padding:.5rem .6rem;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
.m{font-weight:700;text-transform:uppercase;font-size:.7rem}.get{color:#0369a1}.post{color:#047857}.put{color:#b45309}
.p{font-family:ui-monospace,monospace;font-size:.8rem;white-space:nowrap}.s{font-family:ui-monospace,monospace;font-size:.75rem;color:#64748b}</style></head>
<body><h1>Ticket Pulse Integration API</h1>
<p>Authenticate every call with <code>Authorization: Bearer tpk_…</code>. Keys are issued per workspace in <b>Settings → API Keys</b>, each with explicit scopes. Rate limit: ${RATE_LIMIT_PER_MINUTE} requests/minute per key. Machine-readable spec: <a href="openapi.json">openapi.json</a>.</p>
<h2 style="font-size:1.1rem">Outbound webhooks</h2>
<p>Subscribe in <b>Settings → API Keys → Outbound webhooks</b>. Events: <code>ticket.created</code>, <code>ticket.status_changed</code>, <code>ticket.assigned</code>, <code>ticket.reply_received</code>, <code>ticket.public_reply_added</code>, <code>ticket.tags_changed</code>, <code>approval.requested</code>, <code>approval.decided</code>.
Each delivery is a JSON POST carrying <code>{event, occurredAt, workspaceId, data}</code> with headers <code>X-TicketPulse-Event</code> and <code>X-TicketPulse-Signature: sha256=&lt;HMAC-SHA256(secret, raw body)&gt;</code> — verify the signature before trusting a delivery. Failed deliveries retry twice (30s, 2m); 20 consecutive failures auto-disable the subscription.</p>
<table><thead><tr><th></th><th>Path</th><th>Summary</th><th>Scope</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
});

export default router;
