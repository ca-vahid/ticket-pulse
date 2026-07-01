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

export default router;
