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

export const API_KEY_SCOPES = ['tickets:read', 'tickets:write'];
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

export default router;
