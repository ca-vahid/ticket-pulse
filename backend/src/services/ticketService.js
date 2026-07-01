import { z } from 'zod';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { TICKET_ORIGIN, APP_NATIVE_TRIGGER_SOURCE, ticketDisplayRef } from '../utils/ticketOrigin.js';
import noiseRuleService from './noiseRuleService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import ticketThreadRepository from './ticketThreadRepository.js';
import ticketLifecycleNotificationService from './ticketLifecycleNotificationService.js';
import requesterRepository from './requesterRepository.js';
import sendgridNotificationService from './sendgridNotificationService.js';
import mirrorService from './mirrorService.js';
import { sseManager } from '../routes/sse.routes.js';

export const NATIVE_TICKET_STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const TERMINAL_STATUSES = ['Resolved', 'Closed'];

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(500),
  description: z.string().max(100000).optional().nullable(),
  priority: z.number().int().min(1).max(4).default(2),
  status: z.enum(['Open', 'Pending']).default('Open'),
  requesterId: z.number().int().positive().optional().nullable(),
  requesterEmail: z.string().trim().email().optional().nullable(),
  requesterName: z.string().trim().min(1).max(255).optional().nullable(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
  assignedTechId: z.number().int().positive().optional().nullable(),
  runAiTriage: z.boolean().default(true),
}).refine((v) => v.requesterId || v.requesterEmail, {
  message: 'A requester is required (requesterId or requesterEmail)',
});

const updateTicketSchema = z.object({
  subject: z.string().trim().min(3).max(500).optional(),
  description: z.string().max(100000).optional().nullable(),
  priority: z.number().int().min(1).max(4).optional(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
}).strict();

const threadBodySchema = z.object({
  bodyHtml: z.string().max(200000).optional().nullable(),
  bodyText: z.string().max(200000).optional().nullable(),
}).refine((v) => (v.bodyHtml && v.bodyHtml.trim()) || (v.bodyText && v.bodyText.trim()), {
  message: 'Reply body is required',
});

function stripHtml(html) {
  if (!html) return null;
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

function zodMessage(error) {
  return error.issues?.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    || 'Invalid input';
}

const TICKET_INCLUDE = {
  assignedTech: { select: { id: true, name: true, email: true, photoUrl: true } },
  requester: { select: { id: true, name: true, email: true, department: true, jobTitle: true, entraCity: true, entraOfficeLocation: true } },
  internalCategory: { select: { id: true, name: true } },
  internalSubcategory: { select: { id: true, name: true } },
};

/**
 * Native ticketing engine — tickets born inside Ticket Pulse.
 *
 * Ownership rule: everything here operates on origin='ticketpulse' tickets
 * (Ticket Pulse is their source of truth; the Phase 3 mirror pushes copies to
 * FreshService). FS-born tickets stay read-only through this service until the
 * mirror phase adds deliberate write-back for them.
 */
class TicketService {
  // ---------------------------------------------------------------- helpers

  async _getWorkspace(workspaceId) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace || !workspace.isActive) {
      throw new NotFoundError(`Workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  async _requireNativeTicket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    if (ticket.origin !== TICKET_ORIGIN.TICKETPULSE) {
      throw new ValidationError(
        'This ticket is owned by FreshService. Editing FreshService tickets from Ticket Pulse arrives with the mirror phase — for now, open it in FreshService.',
      );
    }
    return ticket;
  }

  async _nextNativeNumber() {
    const rows = await prisma.$queryRaw`SELECT nextval('ticket_native_number_seq')::int AS "nextval"`;
    return rows[0].nextval;
  }

  _broadcast(workspaceId, action, ticket, extra = {}) {
    try {
      sseManager.broadcast('ticket-change', {
        action,
        workspaceId,
        ticketId: ticket.id,
        origin: ticket.origin,
        displayRef: ticketDisplayRef(ticket),
        status: ticket.status,
        assignedTechId: ticket.assignedTechId ?? null,
        ...extra,
      }, workspaceId);
    } catch (err) {
      logger.warn(`SSE broadcast failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
    }
  }

  async _audit(ticketId, activityType, actor, details = {}) {
    try {
      await ticketActivityRepository.create({
        ticketId,
        activityType,
        performedBy: actor?.name || actor?.email || 'Ticket Pulse',
        performedAt: new Date(),
        details: { source: 'ticketpulse_native', actorEmail: actor?.email || null, ...details },
      });
    } catch (err) {
      logger.warn(`Ticket audit write failed for ticket ${ticketId} (non-fatal): ${err.message}`);
    }
  }

  async _notifyLifecycle(existingTicket, upsertedTicket) {
    await ticketLifecycleNotificationService.emitTicketLifecycleNotifications({
      existingTicket,
      upsertedTicket,
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    }).catch((err) => {
      logger.warn('Native ticket lifecycle notification dispatch failed (non-fatal)', {
        ticketId: upsertedTicket.id,
        error: err.message,
      });
    });
  }

  async _validateTaxonomy(workspaceId, internalCategoryId, internalSubcategoryId) {
    if (!internalCategoryId && internalSubcategoryId) {
      throw new ValidationError('A subcategory requires its parent category');
    }
    if (!internalCategoryId) return;
    const category = await prisma.competencyCategory.findFirst({
      where: { id: internalCategoryId, workspaceId, parentId: null, isActive: true },
    });
    if (!category) throw new ValidationError('Unknown category for this workspace');
    if (internalSubcategoryId) {
      const sub = await prisma.competencyCategory.findFirst({
        where: { id: internalSubcategoryId, workspaceId, parentId: internalCategoryId, isActive: true },
      });
      if (!sub) throw new ValidationError('Subcategory does not belong to the selected category');
    }
  }

  async _validateGroup(workspaceId, groupId) {
    if (groupId === null || groupId === undefined) return null;
    const fsGroupId = BigInt(groupId);
    const group = await prisma.group.findFirst({
      where: { workspaceId, freshserviceId: fsGroupId },
      select: { id: true, name: true, isActive: true },
    });
    if (!group) throw new ValidationError('Unknown group for this workspace');
    return fsGroupId;
  }

  async _validateTechnician(workspaceId, technicianId) {
    const tech = await prisma.technician.findFirst({
      where: { id: technicianId, workspaceId, isActive: true },
      select: { id: true, name: true },
    });
    if (!tech) throw new ValidationError('Technician not found in this workspace');
    return tech;
  }

  /**
   * Resolve (or create) the requester for a native ticket. TP-native requesters
   * have freshserviceId = null; the mirror backfills it once FS knows them.
   * Entra enrichment is best-effort and never blocks creation.
   */
  async resolveRequester(workspaceId, { requesterId, requesterEmail, requesterName }) {
    if (requesterId) {
      const existing = await prisma.requester.findUnique({ where: { id: requesterId } });
      if (!existing) throw new ValidationError('Unknown requester');
      return existing;
    }

    const email = requesterEmail.trim().toLowerCase();
    const byEmail = await requesterRepository.findByEmail(email);
    if (byEmail) return byEmail;

    let entra = null;
    try {
      const { default: azureAdService } = await import('./azureAdService.js');
      entra = await azureAdService.getUserProfile(email);
    } catch (err) {
      logger.debug(`Entra enrichment unavailable for ${email}: ${err.message}`);
    }

    return requesterRepository.createNative({
      email,
      name: requesterName?.trim() || entra?.displayName || email.split('@')[0],
      department: entra?.department || null,
      jobTitle: entra?.jobTitle || null,
      entraProfile: entra,
    });
  }

  // ------------------------------------------------------------------ reads

  async listTickets(workspaceId, query = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));

    const where = { workspaceId };

    const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (query.status) where.status = { in: asList(query.status) };
    if (query.priority) where.priority = { in: asList(query.priority).map(Number).filter(Number.isFinite) };
    if (query.origin) where.origin = String(query.origin);
    if (query.internalCategoryId) where.internalCategoryId = Number(query.internalCategoryId);
    if (query.groupId) where.groupId = BigInt(query.groupId);
    if (query.assignedTechId === 'unassigned') where.assignedTechId = null;
    else if (query.assignedTechId) where.assignedTechId = Number(query.assignedTechId);
    if (query.excludeNoise !== 'false') where.isNoise = false;

    const q = String(query.q || '').trim();
    if (q) {
      const or = [
        { subject: { contains: q, mode: 'insensitive' } },
        { requester: { is: { name: { contains: q, mode: 'insensitive' } } } },
      ];
      const tpMatch = q.match(/^tp-?(\d+)$/i);
      if (tpMatch) or.push({ nativeNumber: Number(tpMatch[1]) });
      else if (/^\d+$/.test(q)) {
        or.push({ nativeNumber: Number(q) });
        or.push({ freshserviceTicketId: BigInt(q) });
      }
      where.OR = or;
    }

    const sortField = ['createdAt', 'updatedAt', 'priority', 'status'].includes(query.sort) ? query.sort : 'createdAt';
    const sortDir = query.dir === 'asc' ? 'asc' : 'desc';

    const [total, items] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        include: TICKET_INCLUDE,
        orderBy: [{ [sortField]: sortDir }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map((t) => ({ ...t, displayRef: ticketDisplayRef(t) })),
      total,
      page,
      pageSize,
    };
  }

  async getTicket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: {
        ...TICKET_INCLUDE,
        assignmentEpisodes: {
          orderBy: { startedAt: 'asc' },
          include: { technician: { select: { id: true, name: true, photoUrl: true } } },
        },
        pipelineRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true, status: true, decision: true, triggerSource: true,
            assignedTechId: true, createdAt: true, decidedAt: true, syncStatus: true,
          },
        },
      },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const [thread, activities, approvals] = await Promise.all([
      ticketThreadRepository.listForTicket(ticket.id, { limit: 300 }),
      prisma.ticketActivity.findMany({
        where: { ticketId: ticket.id },
        orderBy: { performedAt: 'desc' },
        take: 50,
      }),
      prisma.ticketApproval.findMany({
        where: { ticketId: ticket.id },
        orderBy: { id: 'desc' },
        select: {
          id: true, status: true, approverEmail: true, approverName: true,
          requestedBy: true, requestNote: true, decisionNote: true,
          decidedAt: true, decidedVia: true, createdAt: true,
        },
      }),
    ]);

    return {
      ...ticket,
      displayRef: ticketDisplayRef(ticket),
      thread,
      activities,
      approvals,
      latestPipelineRun: ticket.pipelineRuns?.[0] || null,
    };
  }

  /** Reference data for the ticket composer / filters. */
  async getMeta(workspaceId) {
    const [workspace, groups, technicians, categories] = await Promise.all([
      this._getWorkspace(workspaceId),
      prisma.group.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, freshserviceId: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.technician.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, email: true, photoUrl: true },
        orderBy: { name: 'asc' },
      }),
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, parentId: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const tops = categories.filter((c) => c.parentId === null);
    const categoryTree = tops.map((top) => ({
      id: top.id,
      name: top.name,
      subcategories: categories.filter((c) => c.parentId === top.id).map((s) => ({ id: s.id, name: s.name })),
    }));

    return {
      nativeTicketingEnabled: workspace.nativeTicketingEnabled === true,
      statuses: NATIVE_TICKET_STATUSES,
      priorities: [
        { value: 1, label: 'Low' },
        { value: 2, label: 'Medium' },
        { value: 3, label: 'High' },
        { value: 4, label: 'Urgent' },
      ],
      groups,
      technicians,
      categoryTree,
    };
  }

  // ------------------------------------------------------------------ create

  async createTicket(workspaceId, input, actor) {
    const workspace = await this._getWorkspace(workspaceId);
    if (!workspace.nativeTicketingEnabled) {
      throw new ValidationError('Native ticketing is not enabled for this workspace');
    }

    const parsed = createTicketSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
    const data = parsed.data;

    await this._validateTaxonomy(workspaceId, data.internalCategoryId, data.internalSubcategoryId);
    const groupId = await this._validateGroup(workspaceId, data.groupId ?? null);
    const assignee = data.assignedTechId
      ? await this._validateTechnician(workspaceId, data.assignedTechId)
      : null;

    const requester = await this.resolveRequester(workspaceId, data);

    const { isNoise, ruleId } = await noiseRuleService.evaluate(data.subject, new Date(), workspaceId);
    const nativeNumber = await this._nextNativeNumber();
    const now = new Date();
    const isSelfPicked = Boolean(assignee && actor?.technicianId && actor.technicianId === assignee.id);

    const ticket = await prisma.ticket.create({
      data: {
        origin: TICKET_ORIGIN.TICKETPULSE,
        nativeNumber,
        freshserviceTicketId: null,
        mirrorState: 'pending',
        subject: data.subject,
        description: data.description || null,
        descriptionText: stripHtml(data.description),
        status: data.status,
        priority: data.priority,
        workspaceId,
        workspaceName: workspace.name,
        requesterId: requester.id,
        requesterFreshserviceId: requester.freshserviceId ?? null,
        department: requester.department || null,
        internalCategoryId: data.internalCategoryId ?? null,
        internalSubcategoryId: data.internalSubcategoryId ?? null,
        groupId,
        createdAt: now,
        isNoise,
        noiseRuleMatched: ruleId,
        lastIngestSource: 'ticketpulse_native',
        lastIngestedAt: now,
        ...(assignee ? {
          assignedTechId: assignee.id,
          assignedAt: now,
          firstAssignedAt: now,
          isSelfPicked,
          assignedBy: actor?.name || actor?.email || 'Ticket Pulse',
        } : {}),
      },
      include: TICKET_INCLUDE,
    });

    await this._audit(ticket.id, 'created', actor, {
      nativeNumber,
      requesterId: requester.id,
      via: 'ticketpulse_app',
    });

    if (assignee) {
      await prisma.ticketAssignmentEpisode.create({
        data: {
          ticketId: ticket.id,
          technicianId: assignee.id,
          workspaceId,
          startedAt: now,
          startMethod: isSelfPicked ? 'self_picked' : 'coordinator_assigned',
          startAssignedByName: actor?.name || actor?.email || null,
        },
      });
      await this._audit(ticket.id, 'assigned', actor, { toTechId: assignee.id, note: 'Assigned at creation' });
    }

    await this._notifyLifecycle(null, ticket);
    this._broadcast(workspaceId, 'created', ticket);
    await mirrorService.enqueueTicketCreate(ticket);

    let triage = { queued: false };
    if (!assignee && !isNoise && data.runAiTriage) {
      triage = await this._startAiTriage(ticket.id, workspaceId);
    }

    logger.info(`Native ticket created: ${ticketDisplayRef(ticket)} (id ${ticket.id}, ws ${workspaceId}) by ${actor?.email || 'unknown'}`);
    return { ...ticket, displayRef: ticketDisplayRef(ticket), triage };
  }

  async _startAiTriage(ticketId, workspaceId) {
    try {
      const { default: assignmentPipelineService } = await import('./assignmentPipelineService.js');
      // Fire-and-forget: the pipeline handles business-hours queueing itself.
      const runPromise = assignmentPipelineService
        .runPipeline(ticketId, workspaceId, APP_NATIVE_TRIGGER_SOURCE)
        .catch((err) => {
          logger.warn(`AI triage failed for native ticket ${ticketId} (non-fatal): ${err.message}`);
        });
      // Detach without awaiting completion — creation must not block on the LLM.
      runPromise.then(() => {});
      return { queued: true };
    } catch (err) {
      logger.warn(`AI triage could not start for native ticket ${ticketId}: ${err.message}`);
      return { queued: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------- updates

  async updateTicketFields(ticketId, workspaceId, input, actor) {
    const ticket = await this._requireNativeTicket(ticketId, workspaceId);
    const parsed = updateTicketSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
    const data = parsed.data;
    if (Object.keys(data).length === 0) throw new ValidationError('Nothing to update');

    if (data.internalCategoryId !== undefined || data.internalSubcategoryId !== undefined) {
      const catId = data.internalCategoryId !== undefined ? data.internalCategoryId : ticket.internalCategoryId;
      const subId = data.internalSubcategoryId !== undefined ? data.internalSubcategoryId : ticket.internalSubcategoryId;
      await this._validateTaxonomy(workspaceId, catId, subId);
    }

    const patch = {};
    const changes = {};
    if (data.subject !== undefined && data.subject !== ticket.subject) {
      patch.subject = data.subject;
      changes.subject = { from: ticket.subject, to: data.subject };
    }
    if (data.description !== undefined) {
      patch.description = data.description || null;
      patch.descriptionText = stripHtml(data.description);
      changes.description = { changed: true };
    }
    if (data.priority !== undefined && data.priority !== ticket.priority) {
      patch.priority = data.priority;
      changes.priority = { from: ticket.priority, to: data.priority };
    }
    if (data.internalCategoryId !== undefined && data.internalCategoryId !== ticket.internalCategoryId) {
      patch.internalCategoryId = data.internalCategoryId;
      changes.internalCategoryId = { from: ticket.internalCategoryId, to: data.internalCategoryId };
      if (data.internalSubcategoryId === undefined) {
        patch.internalSubcategoryId = null;
      }
    }
    if (data.internalSubcategoryId !== undefined && data.internalSubcategoryId !== ticket.internalSubcategoryId) {
      patch.internalSubcategoryId = data.internalSubcategoryId;
      changes.internalSubcategoryId = { from: ticket.internalSubcategoryId, to: data.internalSubcategoryId };
    }
    if (data.groupId !== undefined) {
      const fsGroupId = await this._validateGroup(workspaceId, data.groupId);
      if (fsGroupId !== ticket.groupId) {
        patch.groupId = fsGroupId;
        changes.groupId = { from: ticket.groupId?.toString() || null, to: fsGroupId?.toString() || null };
      }
    }

    if (Object.keys(patch).length === 0) {
      return { ...ticket, displayRef: ticketDisplayRef(ticket), changed: false };
    }
    patch.mirrorState = 'pending';

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: patch,
      include: TICKET_INCLUDE,
    });

    await this._audit(ticket.id, 'fields_updated', actor, { changes });
    this._broadcast(workspaceId, 'updated', updated, { changes: Object.keys(changes) });
    await mirrorService.enqueueFieldSync(workspaceId, ticket.id);
    return { ...updated, displayRef: ticketDisplayRef(updated), changed: true };
  }

  async changeStatus(ticketId, workspaceId, status, actor) {
    if (!NATIVE_TICKET_STATUSES.includes(status)) {
      throw new ValidationError(`Status must be one of: ${NATIVE_TICKET_STATUSES.join(', ')}`);
    }
    const ticket = await this._requireNativeTicket(ticketId, workspaceId);
    if (ticket.status === status) {
      return { ...ticket, displayRef: ticketDisplayRef(ticket), changed: false };
    }

    const now = new Date();
    const patch = { status, mirrorState: 'pending' };
    const wasTerminal = TERMINAL_STATUSES.includes(ticket.status);
    const isTerminal = TERMINAL_STATUSES.includes(status);

    if (status === 'Resolved') {
      patch.resolvedAt = now;
      patch.resolutionTimeSeconds = ticket.resolutionTimeSeconds
        ?? Math.max(0, Math.round((now.getTime() - new Date(ticket.createdAt).getTime()) / 1000));
    } else if (status === 'Closed') {
      patch.closedAt = now;
      if (!ticket.resolvedAt) {
        patch.resolvedAt = now;
        patch.resolutionTimeSeconds = ticket.resolutionTimeSeconds
          ?? Math.max(0, Math.round((now.getTime() - new Date(ticket.createdAt).getTime()) / 1000));
      }
    } else if (wasTerminal && !isTerminal) {
      // Reopening: the ticket is no longer resolved.
      patch.resolvedAt = null;
      patch.closedAt = null;
      patch.resolutionTimeSeconds = null;
    }

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: patch,
      include: TICKET_INCLUDE,
    });

    if (isTerminal && ticket.assignedTechId) {
      await prisma.ticketAssignmentEpisode.updateMany({
        where: { ticketId: ticket.id, technicianId: ticket.assignedTechId, endedAt: null },
        data: { endedAt: now, endMethod: 'closed', endActorName: actor?.name || null },
      });
    } else if (wasTerminal && !isTerminal && updated.assignedTechId) {
      await prisma.ticketAssignmentEpisode.create({
        data: {
          ticketId: ticket.id,
          technicianId: updated.assignedTechId,
          workspaceId,
          startedAt: now,
          startMethod: 'unknown',
          startAssignedByName: actor?.name || null,
        },
      }).catch(() => { /* duplicate startedAt guard — harmless */ });
    }

    await this._audit(ticket.id, 'status_changed', actor, { oldStatus: ticket.status, newStatus: status });
    await this._notifyLifecycle(ticket, updated);
    ticketLifecycleNotificationService.emitTicketEvent?.('ticket.status_changed', ticket.id, {
      dedupeStamp: `status:${ticket.id}:${ticket.status}->${status}:${Date.now()}`,
      extra: { from: ticket.status, to: status, byEmail: actor?.email || null },
    }).catch?.(() => {});
    this._broadcast(workspaceId, 'status', updated, { oldStatus: ticket.status });
    await mirrorService.enqueueFieldSync(workspaceId, ticket.id);
    return { ...updated, displayRef: ticketDisplayRef(updated), changed: true };
  }

  async assignTicket(ticketId, workspaceId, technicianId, actor) {
    const ticket = await this._requireNativeTicket(ticketId, workspaceId);
    const targetId = technicianId === null || technicianId === undefined ? null : Number(technicianId);
    if (targetId !== null) await this._validateTechnician(workspaceId, targetId);
    if (ticket.assignedTechId === targetId) {
      return { ...ticket, displayRef: ticketDisplayRef(ticket), changed: false };
    }

    const now = new Date();
    const isSelfPicked = Boolean(targetId && actor?.technicianId && actor.technicianId === targetId);

    if (ticket.assignedTechId) {
      await prisma.ticketAssignmentEpisode.updateMany({
        where: { ticketId: ticket.id, technicianId: ticket.assignedTechId, endedAt: null },
        data: { endedAt: now, endMethod: 'reassigned', endActorName: actor?.name || null },
      });
    }

    const patch = targetId === null
      ? { assignedTechId: null, mirrorState: 'pending' }
      : {
        assignedTechId: targetId,
        assignedAt: now,
        firstAssignedAt: ticket.firstAssignedAt || now,
        isSelfPicked,
        assignedBy: actor?.name || actor?.email || 'Ticket Pulse',
        mirrorState: 'pending',
      };

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: patch,
      include: TICKET_INCLUDE,
    });

    if (targetId !== null) {
      await prisma.ticketAssignmentEpisode.create({
        data: {
          ticketId: ticket.id,
          technicianId: targetId,
          workspaceId,
          startedAt: now,
          startMethod: isSelfPicked ? 'self_picked' : 'coordinator_assigned',
          startAssignedByName: actor?.name || actor?.email || null,
        },
      }).catch(() => { /* duplicate startedAt guard — harmless */ });
    }

    await this._audit(ticket.id, 'assigned', actor, {
      fromTechId: ticket.assignedTechId,
      toTechId: targetId,
      note: targetId === null ? 'Unassigned' : 'Ticket reassigned',
    });
    await this._notifyLifecycle(ticket, updated);
    this._broadcast(workspaceId, 'assignment', updated, { fromTechId: ticket.assignedTechId });
    await mirrorService.enqueueFieldSync(workspaceId, ticket.id);
    return { ...updated, displayRef: ticketDisplayRef(updated), changed: true };
  }

  // ------------------------------------------------------------ conversation

  async addReply(ticketId, workspaceId, input, actor) {
    return this._addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate: false });
  }

  async addPrivateNote(ticketId, workspaceId, input, actor) {
    return this._addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate: true });
  }

  async _addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate }) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    const isNative = ticket.origin === TICKET_ORIGIN.TICKETPULSE;
    if (!isNative && !ticket.freshserviceTicketId) {
      throw new ValidationError('This FreshService ticket has no FS id to reply through');
    }

    const parsed = threadBodySchema.safeParse(input || {});
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));

    const bodyHtml = parsed.data.bodyHtml?.trim() || null;
    const bodyText = parsed.data.bodyText?.trim() || stripHtml(bodyHtml);
    const now = new Date();

    // FS-born tickets: FS owns requester communication — send through the FS
    // API first (FS emails the requester itself), then cache the entry locally.
    let externalEntryId = null;
    if (!isNative) {
      const client = await mirrorService.getClient(workspaceId);
      if (!client) throw new ValidationError('FreshService is not configured for this workspace');
      const fsId = Number(ticket.freshserviceTicketId);
      const html = bodyHtml || `<p>${(bodyText || '').replace(/\n/g, '<br/>')}</p>`;
      const result = isPrivate
        ? await client.addNote(fsId, html, { isPrivate: true })
        : await client.createReply(fsId, html);
      const fsEntryId = result?.conversation?.id || result?.id || null;
      externalEntryId = fsEntryId ? `fs-conv-${fsEntryId}` : null;
    }

    const entry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId,
        externalEntryId,
        source: 'ticketpulse_user',
        eventType: isPrivate ? 'note' : 'reply',
        actorName: actor?.name || actor?.email || 'Ticket Pulse',
        actorEmail: actor?.email || null,
        authorType: 'agent',
        incoming: false,
        isPrivate,
        visibility: isPrivate ? 'private' : 'public',
        content: bodyText,
        bodyHtml,
        bodyText,
        occurredAt: now,
        // Native entries queue for the mirror; FS-born entries are already there.
        mirrorState: isNative ? 'pending' : 'mirrored',
        mirroredAt: isNative ? null : now,
      },
    });

    const ticketPatch = { updatedAt: now };
    if (!isPrivate && !ticket.firstPublicAgentReplyAt) {
      ticketPatch.firstPublicAgentReplyAt = now;
    }
    await prisma.ticket.update({ where: { id: ticket.id }, data: ticketPatch });

    let email = { sent: false };
    if (isNative) {
      if (!isPrivate && ticket.requester?.email) {
        email = await this._emailRequesterReply(ticket, entry);
      }
      await mirrorService.enqueueThreadEntry(workspaceId, ticket.id, entry.id);
      if (isPrivate) {
        ticketLifecycleNotificationService.emitTicketEvent?.('ticket.note_added', ticket.id, {
          dedupeStamp: `note:${entry.id}`,
          extra: { entryId: entry.id, byEmail: actor?.email || null },
        }).catch?.(() => {});
      }
    } else if (!isPrivate) {
      email = { sent: true, via: 'freshservice' };
    }

    this._broadcast(workspaceId, isPrivate ? 'note' : 'reply', ticket, { entryId: entry.id });
    return { entry, email };
  }

  /**
   * Outbound reply email. Prefers a send-capable workspace mailbox via
   * Microsoft Graph (real mailbox, proper threading — the stored Message-ID
   * lets inbound replies match back to the ticket); falls back to the
   * SendGrid/SMTP path. The subject carries the TP-<n> reference as a second
   * threading signal. Non-fatal by design.
   */
  async _emailRequesterReply(ticket, entry) {
    const ref = ticketDisplayRef(ticket);
    const subject = `Re: ${ticket.subject || 'Your ticket'} [${ref}]`;
    const html = entry.bodyHtml || `<p>${(entry.bodyText || '').replace(/\n/g, '<br/>')}</p>`;
    const text = entry.bodyText || stripHtml(entry.bodyHtml) || '';
    const dedupeKey = `native-reply:${entry.id}`;

    // Graph path: send from the workspace's connected mailbox when available.
    try {
      const connection = await prisma.mailboxConnection.findFirst({
        where: { workspaceId: ticket.workspaceId, isEnabled: true, mode: { in: ['send', 'both'] } },
        orderBy: { id: 'asc' },
      });
      if (connection) {
        const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
        if (graphMailClient.isConfigured()) {
          const sent = await graphMailClient.sendMailAsMailbox(connection.address, {
            to: [ticket.requester.email],
            subject,
            html,
          });
          if (sent?.internetMessageId) {
            await prisma.ticketThreadEntry.update({
              where: { id: entry.id },
              data: { emailMessageId: sent.internetMessageId },
            }).catch(() => {});
          }
          await prisma.notificationDelivery.create({
            data: {
              workspaceId: ticket.workspaceId,
              ticketId: ticket.id,
              channel: 'email',
              status: 'sent',
              eventType: 'ticket.reply_posted',
              notificationType: 'native_reply_to_requester',
              recipient: ticket.requester.email,
              toRecipients: [ticket.requester.email],
              subject,
              htmlBody: html.slice(0, 20000),
              textBody: text.slice(0, 20000),
              fromAddress: connection.address,
              provider: 'msgraph',
              providerMessageId: sent?.internetMessageId || null,
              dedupeKey,
              sentAt: new Date(),
            },
          }).catch((err) => logger.warn(`Reply delivery audit write failed (non-fatal): ${err.message}`));
          return { sent: true, to: ticket.requester.email, via: 'msgraph', from: connection.address };
        }
      }
    } catch (err) {
      logger.warn(`Graph reply send failed for ticket ${ticket.id}, falling back to SendGrid: ${err.message}`);
    }

    try {
      const result = await sendgridNotificationService.sendEmail({
        to: [ticket.requester.email],
        subject,
        html,
        text: `${text}\n\n— ${entry.actorName || 'Ticket Pulse'} · ${ref}`,
      });
      await prisma.notificationDelivery.create({
        data: {
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          channel: 'email',
          status: 'sent',
          eventType: 'ticket.reply_posted',
          notificationType: 'native_reply_to_requester',
          recipient: ticket.requester.email,
          toRecipients: [ticket.requester.email],
          subject,
          htmlBody: html.slice(0, 20000),
          textBody: text.slice(0, 20000),
          provider: result?.provider || 'sendgrid',
          providerMessageId: result?.providerMessageId || null,
          dedupeKey,
          sentAt: new Date(),
        },
      }).catch((err) => logger.warn(`Reply delivery audit write failed (non-fatal): ${err.message}`));
      return { sent: true, to: ticket.requester.email };
    } catch (err) {
      logger.warn(`Requester reply email failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
      await prisma.notificationDelivery.create({
        data: {
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          channel: 'email',
          status: 'failed_permanent',
          eventType: 'ticket.reply_posted',
          notificationType: 'native_reply_to_requester',
          recipient: ticket.requester.email,
          toRecipients: [ticket.requester.email],
          subject,
          error: String(err.message || err).slice(0, 2000),
          dedupeKey,
        },
      }).catch(() => {});
      return { sent: false, error: err.message };
    }
  }
}

export default new TicketService();
