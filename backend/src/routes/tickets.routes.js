import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { AuthenticationError, ValidationError } from '../utils/errors.js';
import ticketService from '../services/ticketService.js';
import workspaceRepository from '../services/workspaceRepository.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

/**
 * Native ticketing API.
 *
 * Mounted BEFORE the global requireWorkspaceAccess chain (see routes/index.js)
 * because agents — who have no workspace_access rows — are first-class users
 * here: an active technician profile in the workspace grants access.
 */
const router = express.Router();

router.use(requireWorkspace);

async function resolveTicketActor(req, _res, next) {
  try {
    const user = req.session?.user;
    const email = user?.email?.toLowerCase();
    if (!email) throw new AuthenticationError('Authentication required');

    const [workspaceRole, technician] = await Promise.all([
      user.role === 'admin'
        ? Promise.resolve('admin')
        : workspaceRepository.getAccessRole(email, req.workspaceId),
      prisma.technician.findFirst({
        where: {
          workspaceId: req.workspaceId,
          isActive: true,
          email: { equals: email, mode: 'insensitive' },
        },
        select: { id: true, name: true },
      }),
    ]);

    if (!workspaceRole && !technician) {
      logger.warn(`Ticketing access denied for ${email} in workspace ${req.workspaceId}`);
      throw new AuthenticationError('You do not have access to tickets in this workspace');
    }

    req.ticketActor = {
      email,
      name: user.name || technician?.name || email,
      role: user.role,
      workspaceRole: workspaceRole || null,
      technicianId: technician?.id || null,
      kind: user.role === 'admin' ? 'admin' : (workspaceRole ? 'member' : 'agent'),
    };
    next();
  } catch (err) {
    next(err);
  }
}

router.use(resolveTicketActor);

/** Gate for mutations: the workspace must have native ticketing switched on. */
const requireNativeTicketing = asyncHandler(async (req, _res, next) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    select: { nativeTicketingEnabled: true },
  });
  if (!workspace?.nativeTicketingEnabled) {
    throw new ValidationError('Native ticketing is not enabled for this workspace');
  }
  next();
});

function parseTicketId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid ticket id');
  return id;
}

// ------------------------------------------------------------------- reads

router.get('/', asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(req.workspaceId, req.query);
  res.json({ success: true, data: result });
}));

router.get('/meta', asyncHandler(async (req, res) => {
  const meta = await ticketService.getMeta(req.workspaceId);
  res.json({ success: true, data: { ...meta, actor: req.ticketActor } });
}));

// ------------------------------------------------- mailbox connections (admin)

function requireTicketingAdmin(req, _res, next) {
  const actor = req.ticketActor;
  if (actor.role !== 'admin' && actor.workspaceRole !== 'admin') {
    return next(new AuthenticationError('Admin access required'));
  }
  next();
}

router.get('/mailboxes', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const mailboxes = await prisma.mailboxConnection.findMany({
    where: { workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
  });
  res.json({ success: true, data: mailboxes });
}));

router.post('/mailboxes', requireTicketingAdmin, requireNativeTicketing, asyncHandler(async (req, res) => {
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new ValidationError('A valid mailbox address is required');
  const mode = ['ingest', 'send', 'both'].includes(req.body?.mode) ? req.body.mode : 'both';
  const mailbox = await prisma.mailboxConnection.create({
    data: {
      workspaceId: req.workspaceId,
      address,
      displayName: req.body?.displayName?.trim() || null,
      mode,
      pollIntervalSec: Math.max(15, Math.min(3600, Number(req.body?.pollIntervalSec) || 60)),
      createdBy: req.ticketActor.email,
    },
  }).catch((err) => {
    if (err.code === 'P2002') throw new ValidationError('That mailbox is already connected to this workspace');
    throw err;
  });
  res.status(201).json({ success: true, data: mailbox });
}));

router.patch('/mailboxes/:mailboxId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  const data = {};
  if (req.body?.mode && ['ingest', 'send', 'both'].includes(req.body.mode)) data.mode = req.body.mode;
  if (req.body?.isEnabled !== undefined) data.isEnabled = req.body.isEnabled === true;
  if (req.body?.displayName !== undefined) data.displayName = req.body.displayName?.trim() || null;
  if (req.body?.pollIntervalSec !== undefined) data.pollIntervalSec = Math.max(15, Math.min(3600, Number(req.body.pollIntervalSec) || 60));
  const mailbox = await prisma.mailboxConnection.update({ where: { id }, data });
  res.json({ success: true, data: mailbox });
}));

router.delete('/mailboxes/:mailboxId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  await prisma.mailboxConnection.delete({ where: { id } });
  res.json({ success: true });
}));

router.post('/mailboxes/:mailboxId/test', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
  if (!graphMailClient.isConfigured()) {
    return res.json({ success: true, data: { success: false, message: 'Azure Graph credentials are not configured on the server' } });
  }
  const result = await graphMailClient.testConnection(existing.address);
  res.json({ success: true, data: result });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicket(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: ticket });
}));

// --------------------------------------------------------------- mutations

router.post('/', requireNativeTicketing, asyncHandler(async (req, res) => {
  const ticket = await ticketService.createTicket(req.workspaceId, req.body || {}, req.ticketActor);
  res.status(201).json({ success: true, data: ticket });
}));

router.patch('/:id', requireNativeTicketing, asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateTicketFields(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

router.post('/:id/status', requireNativeTicketing, asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').trim();
  const ticket = await ticketService.changeStatus(
    parseTicketId(req), req.workspaceId, status, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

router.post('/:id/assign', requireNativeTicketing, asyncHandler(async (req, res) => {
  const technicianId = req.body?.technicianId ?? null;
  const ticket = await ticketService.assignTicket(
    parseTicketId(req), req.workspaceId, technicianId, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

router.post('/:id/replies', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await ticketService.addReply(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.status(201).json({ success: true, data: result });
}));

router.post('/:id/notes', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await ticketService.addPrivateNote(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.status(201).json({ success: true, data: result });
}));

// ---------------------------------------------------------------- approvals

router.post('/:id/approvals', requireNativeTicketing, asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const result = await ticketApprovalService.request(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.status(201).json({ success: true, data: result });
}));

router.post('/:id/approvals/:approvalId/decide', requireNativeTicketing, asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.decideInApp(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId),
    req.body?.decision, req.body?.note || null, req.ticketActor,
  );
  res.json({ success: true, data: approval });
}));

router.post('/:id/approvals/:approvalId/cancel', requireNativeTicketing, asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.cancel(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId), req.ticketActor,
  );
  res.json({ success: true, data: approval });
}));

/**
 * Public magic-link router (no app auth — the token IS the credential).
 * Mounted pre-auth in routes/index.js at /api/ticket-approvals/public.
 */
export const ticketApprovalPublicRouter = express.Router();

ticketApprovalPublicRouter.get('/:token', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const data = await ticketApprovalService.getByToken(req.params.token);
  res.json({ success: true, data });
}));

ticketApprovalPublicRouter.post('/:token/decide', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.decideByToken(
    req.params.token, req.body?.decision, req.body?.note || null,
  );
  res.json({ success: true, data: { status: approval.status, decidedAt: approval.decidedAt } });
}));

/**
 * Post-outage recovery: import FS-side deltas on TP-born mirrored tickets and
 * surface conflicts. Admin-only (global or workspace admin).
 */
router.post('/mirror/reconcile', asyncHandler(async (req, res) => {
  const actor = req.ticketActor;
  if (actor.role !== 'admin' && actor.workspaceRole !== 'admin') {
    throw new AuthenticationError('Admin access required for mirror reconciliation');
  }
  const { default: mirrorService } = await import('../services/mirrorService.js');
  const result = await mirrorService.reconcile(req.workspaceId, req.body || {});
  res.json({ success: true, data: result });
}));

export default router;
