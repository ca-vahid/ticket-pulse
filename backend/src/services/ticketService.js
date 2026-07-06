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
import attachmentService from './attachmentService.js';
import watcherNotificationService from './watcherNotificationService.js';
import { sseManager } from '../routes/sse.routes.js';

export const NATIVE_TICKET_STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const TERMINAL_STATUSES = ['Resolved', 'Closed'];

// FreshService's numeric source channels; org-custom codes (1001+) fall back to "Source N".
const FS_SOURCE_LABELS = {
  1: 'Email', 2: 'Portal', 3: 'Phone', 4: 'Chat', 5: 'Feedback widget',
  6: 'Yammer', 7: 'AWS CloudWatch', 8: 'PagerDuty', 9: 'Walk-up', 10: 'Slack',
};

// Accepts an array or a comma/semicolon-separated string of addresses.
const emailListSchema = z.preprocess(
  (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean),
  z.array(z.string().email({ message: 'Cc contains an invalid email address' })).max(10),
);

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(500),
  description: z.string().max(100000).optional().nullable(),
  priority: z.number().int().min(1).max(4).default(2),
  ticketType: z.enum(['Incident', 'Service Request']).default('Incident'),
  status: z.enum(['Open', 'Pending']).default('Open'),
  requesterId: z.number().int().positive().optional().nullable(),
  requesterEmail: z.string().trim().email().optional().nullable(),
  requesterName: z.string().trim().min(1).max(255).optional().nullable(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
  internalGroupId: z.number().int().positive().optional().nullable(),
  assignedTechId: z.number().int().positive().optional().nullable(),
  // runAiTriage = run the FULL pipeline (classify + priority + type + recommend
  // an assignee). aiClassifyOnly = run AI ASSESSMENT ONLY (classify + priority +
  // type), never touching the assignee — for tickets that are hand-assigned or
  // left unassigned but should still be AI-classified. The two are independent:
  // the create UI lets you assess without assigning.
  runAiTriage: z.boolean().default(true),
  aiClassifyOnly: z.boolean().default(false),
  // Suppresses ticket-created notification workflows (silent/imported tickets).
  notifyRequester: z.boolean().default(true),
  // Recorded on the created audit + seeded into the first reply's Cc.
  ccEmails: emailListSchema.default([]),
}).refine((v) => v.requesterId || v.requesterEmail, {
  message: 'A requester is required (requesterId or requesterEmail)',
});

const updateTicketSchema = z.object({
  subject: z.string().trim().min(3).max(500).optional(),
  description: z.string().max(100000).optional().nullable(),
  priority: z.number().int().min(1).max(4).optional(),
  ticketType: z.enum(['Incident', 'Service Request']).optional().nullable(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
  internalGroupId: z.number().int().positive().optional().nullable(),
}).strict();

const threadBodySchema = z.object({
  bodyHtml: z.string().max(200000).optional().nullable(),
  bodyText: z.string().max(200000).optional().nullable(),
  cc: emailListSchema.default([]),
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

/**
 * Derived at-a-glance state for queue rows / detail header.
 * Priority order: overdue > response_due > requester_responded > new.
 */
export function deriveStateChip(ticket, awaitingReply = false) {
  if (['Resolved', 'Closed', 'Deleted', 'Spam'].includes(ticket.status)) return null;
  const now = Date.now();
  const fr = ticket.frDueBy ? new Date(ticket.frDueBy).getTime() : null;
  const due = ticket.dueBy ? new Date(ticket.dueBy).getTime() : null;
  const noFirstReply = !ticket.firstPublicAgentReplyAt;
  if ((due && due < now) || (fr && fr < now && noFirstReply)) return 'overdue';
  if (fr && fr >= now && noFirstReply) return 'response_due';
  if (awaitingReply) return 'requester_responded';
  if (!ticket.assignedTechId && noFirstReply) return 'new';
  return null;
}

function zodMessage(error) {
  return error.issues?.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    || 'Invalid input';
}

/** Ranked candidate list from a pipeline run's recommendation JSON (shape varies by prompt era). */
function recommendationList(recommendation) {
  return Array.isArray(recommendation?.recommendations)
    ? recommendation.recommendations
    : Array.isArray(recommendation) ? recommendation : [];
}

const TICKET_INCLUDE = {
  assignedTech: { select: { id: true, name: true, email: true, photoUrl: true, isActive: true, origin: true } },
  requester: {
    select: {
      id: true, name: true, email: true, phone: true, mobile: true,
      department: true, jobTitle: true, entraJobTitle: true, entraDepartment: true,
      entraCity: true, entraOfficeLocation: true, entraState: true,
    },
  },
  internalCategory: { select: { id: true, name: true } },
  internalSubcategory: { select: { id: true, name: true } },
  internalGroup: { select: { id: true, name: true, origin: true } },
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
      const now = new Date();
      await ticketActivityRepository.create({
        ticketId,
        activityType,
        performedBy: actor?.name || actor?.email || 'Ticket Pulse',
        performedAt: now,
        details: { source: 'ticketpulse_native', actorEmail: actor?.email || null, ...details },
      });
      // Every audited action is real activity — keep the honest timestamp fresh.
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { lastRealActivityAt: now },
      }).catch(() => {});
    } catch (err) {
      logger.warn(`Ticket audit write failed for ticket ${ticketId} (non-fatal): ${err.message}`);
    }
  }

  /**
   * Soft-delete a TP-born ticket (status → 'Deleted'). TP-owned only — FS-born
   * tickets are managed in FreshService. Keeps the row (audit/analytics/history)
   * but drops it from active views. Cancels any queued AI runs.
   */
  async deleteTicket(ticketId, workspaceId, actor) {
    const ticket = await this._requireNativeTicket(ticketId, workspaceId);
    if (String(ticket.status) === 'Deleted') {
      return { ...ticket, displayRef: ticketDisplayRef(ticket), deleted: true, alreadyDeleted: true };
    }

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'Deleted', updatedAt: new Date() },
      include: TICKET_INCLUDE,
    });

    // Cancel queued assignment work — a deleted ticket must not still get picked up.
    await prisma.assignmentPipelineRun.updateMany({
      where: { ticketId: ticket.id, status: 'queued' },
      data: { status: 'skipped_stale' },
    }).catch(() => {});

    await this._audit(ticket.id, 'status_changed', actor, {
      oldStatus: ticket.status,
      newStatus: 'Deleted',
      note: `Ticket deleted by ${actor?.name || actor?.email || 'a user'}`,
    });
    // Clean up the FreshService fallback mirror copy (best-effort, async) so a
    // ticket deleted in Ticket Pulse doesn't linger open in FreshService.
    if (ticket.freshserviceTicketId) {
      mirrorService.enqueueDelete(workspaceId, ticket.id).catch((err) => {
        logger.warn(`Failed to enqueue FS mirror delete for ticket ${ticket.id}: ${err.message}`);
      });
    }
    this._broadcast(workspaceId, 'deleted', updated);
    logger.info(`TP ticket ${ticketDisplayRef(updated)} (id ${ticket.id}) deleted by ${actor?.email || 'unknown'}`);
    return { ...updated, displayRef: ticketDisplayRef(updated), deleted: true };
  }

  async _notifyLifecycle(existingTicket, upsertedTicket, { allow = true } = {}) {
    await ticketLifecycleNotificationService.emitTicketLifecycleNotifications({
      existingTicket,
      upsertedTicket,
      source: 'ticketpulse_native',
      allowNotificationWorkflows: allow,
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

  /**
   * Validate an internal (TP-native) group reference. Returns the group's Int id
   * (or null). Internal groups are TP-owned and never mirrored to FreshService.
   */
  async _validateInternalGroup(workspaceId, internalGroupId) {
    if (internalGroupId === null || internalGroupId === undefined) return null;
    const group = await prisma.group.findFirst({
      where: { id: internalGroupId, workspaceId, origin: 'local' },
      select: { id: true, isActive: true },
    });
    if (!group) throw new ValidationError('Unknown internal group for this workspace');
    return group.id;
  }

  async _validateTechnician(workspaceId, technicianId) {
    const tech = await prisma.technician.findFirst({
      where: { id: technicianId, workspaceId, isActive: true },
      select: { id: true, name: true, freshserviceId: true, origin: true },
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

  async listTickets(workspaceId, query = {}, { maxPageSize = 100 } = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize) || 25));

    const where = { workspaceId };

    const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (query.status) where.status = { in: asList(query.status) };
    if (query.priority) where.priority = { in: asList(query.priority).map(Number).filter(Number.isFinite) };
    if (query.origin) where.origin = String(query.origin);
    if (query.requesterId) {
      const rid = Number(query.requesterId);
      if (Number.isFinite(rid) && rid > 0) where.requesterId = rid;
    }
    if (query.type) where.ticketType = { in: asList(query.type) };
    if (query.internalCategoryId) {
      const ids = asList(query.internalCategoryId).map(Number).filter(Number.isFinite);
      if (ids.length) where.internalCategoryId = { in: ids };
    }
    if (query.internalSubcategoryId) {
      const ids = asList(query.internalSubcategoryId).map(Number).filter(Number.isFinite);
      if (ids.length) where.internalSubcategoryId = { in: ids };
    }
    if (query.groupId) {
      const ids = asList(query.groupId).filter((s) => /^\d+$/.test(s)).map(BigInt);
      if (ids.length) where.groupId = { in: ids };
    }
    if (query.source) {
      const codes = asList(query.source).map(Number).filter(Number.isFinite);
      if (codes.length) where.source = { in: codes };
    }
    if (query.assignedTechId) {
      // Multi-select: technician ids and/or the literal 'unassigned'.
      const values = asList(query.assignedTechId);
      const ids = values.filter((v) => /^\d+$/.test(v)).map(Number);
      const wantsUnassigned = values.includes('unassigned');
      if (wantsUnassigned && ids.length) {
        where.AND = [...(where.AND || []), { OR: [{ assignedTechId: null }, { assignedTechId: { in: ids } }] }];
      } else if (wantsUnassigned) {
        where.assignedTechId = null;
      } else if (ids.length) {
        where.assignedTechId = ids.length === 1 ? ids[0] : { in: ids };
      }
    }
    if (query.createdFrom || query.createdTo) {
      const range = {};
      const from = query.createdFrom ? new Date(query.createdFrom) : null;
      const to = query.createdTo ? new Date(query.createdTo) : null;
      if (from && !Number.isNaN(from.getTime())) range.gte = from;
      if (to && !Number.isNaN(to.getTime())) {
        // Date-only upper bounds are inclusive of that whole day.
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.createdTo))) to.setHours(23, 59, 59, 999);
        range.lte = to;
      }
      if (Object.keys(range).length) where.createdAt = range;
    }
    if (query.due) {
      const dueNow = new Date();
      const dueEndOfDay = new Date(dueNow); dueEndOfDay.setHours(23, 59, 59, 999);
      const dueWeekOut = new Date(dueNow.getTime() + 7 * 24 * 3600 * 1000);
      const buckets = asList(query.due);
      const or = [];
      if (buckets.includes('overdue')) or.push({ dueBy: { lt: dueNow } });
      if (buckets.includes('today')) or.push({ dueBy: { gte: dueNow, lte: dueEndOfDay } });
      if (buckets.includes('week')) or.push({ dueBy: { gte: dueNow, lte: dueWeekOut } });
      if (buckets.includes('none')) or.push({ dueBy: null });
      if (or.length) where.AND = [...(where.AND || []), { OR: or }];
    }
    if (query.noise === 'only') where.isNoise = true;
    else if (query.excludeNoise !== 'false') where.isNoise = false;

    // Stat-card segments (single-select quick filters layered on top)
    const now = new Date();
    if (query.segment === 'open') where.status = { in: ['Open', 'Pending'] };
    else if (query.segment === 'unassigned') {
      where.status = { in: ['Open', 'Pending'] };
      where.assignedTechId = null;
    } else if (query.segment === 'due_today') {
      where.status = { in: ['Open', 'Pending'] };
      const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
      where.AND = [...(where.AND || []), {
        OR: [
          { dueBy: { gte: now, lte: endOfDay } },
          { frDueBy: { gte: now, lte: endOfDay }, firstPublicAgentReplyAt: null },
        ],
      }];
    } else if (query.segment === 'overdue') {
      where.status = { in: ['Open', 'Pending'] };
      where.AND = [...(where.AND || []), {
        OR: [
          { dueBy: { lt: now } },
          { frDueBy: { lt: now }, firstPublicAgentReplyAt: null },
        ],
      }];
    } else if (query.segment === 'resolved') {
      where.status = { in: ['Resolved', 'Closed'] };
    } else if (query.segment === 'awaiting') {
      where.status = { in: ['Open', 'Pending'] };
      const awaitingIds = await this._awaitingReplyTicketIds(workspaceId);
      where.id = { in: awaitingIds.length ? awaitingIds : [-1] };
    } else if (query.segment === 'deleted') {
      where.status = { in: ['Deleted', 'Spam'] };
    }

    // Deleted/Spam tickets are hidden everywhere except the explicit 'deleted'
    // view — they must not pad the main list or its counts.
    if (query.segment !== 'deleted' && where.status === undefined) {
      where.status = { notIn: ['Deleted', 'Spam'] };
    }

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
      // AND-composed so it can't collide with segment OR clauses
      where.AND = [...(where.AND || []), { OR: or }];
    }

    const sortField = ['createdAt', 'updatedAt', 'priority', 'status', 'subject', 'requester'].includes(query.sort) ? query.sort : 'createdAt';
    const sortDir = query.dir === 'asc' ? 'asc' : 'desc';

    // "updatedAt" means LAST REAL ACTIVITY: last_real_activity_at is derived
    // only from messages/assignments/status changes (backfilled + maintained
    // on write paths). Neither our @updatedAt (sync bookkeeping) nor FS's
    // updated_at (FS-side automations touch idle tickets) can be trusted.
    let orderBy;
    if (sortField === 'updatedAt') {
      orderBy = [{ lastRealActivityAt: { sort: sortDir, nulls: 'last' } }, { id: 'desc' }];
    } else if (sortField === 'requester') {
      orderBy = [{ requester: { name: sortDir } }, { id: 'desc' }];
    } else {
      orderBy = [{ [sortField]: sortDir }, { id: 'desc' }];
    }

    const [total, items] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        include: TICKET_INCLUDE,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const [incomingByTicket, aiByTicket, bypassByTicket] = await Promise.all([
      this._lastPublicEntryIncoming(items.map((t) => t.id)),
      this._aiRunStateByTicket(items.map((t) => t.id)),
      this._aiBypassByTicket(items),
    ]);

    return {
      items: items.map((t) => ({
        ...t,
        displayRef: ticketDisplayRef(t),
        // truthful "last activity" for display: FS's timestamp for FS-born rows
        lastActivityAt: t.lastRealActivityAt || t.freshserviceUpdatedAt || t.updatedAt,
        stateChip: deriveStateChip(t, incomingByTicket.get(t.id) === true),
        ai: aiByTicket.get(t.id) || null,
        aiBypass: bypassByTicket.get(t.id) || null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Per-ticket AI pipeline state for queue rows. Actionable suggestions
   * (completed + pending_review) win over in-flight runs; the recommendation
   * is slimmed to the top candidate so list payloads stay light.
   */
  async _aiRunStateByTicket(ticketIds) {
    const map = new Map();
    if (!ticketIds.length) return map;
    try {
      const runs = await prisma.assignmentPipelineRun.findMany({
        where: {
          ticketId: { in: ticketIds },
          OR: [
            { status: { in: ['queued', 'running'] } },
            { status: 'completed', decision: 'pending_review' },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, ticketId: true, status: true, decision: true, recommendation: true, createdAt: true },
      });
      for (const r of runs) {
        const actionable = r.status === 'completed' && r.decision === 'pending_review';
        const existing = map.get(r.ticketId);
        // Newest-first scan: keep the first actionable run per ticket, letting
        // it displace an in-flight placeholder (the queued-shell-after-decided
        // case), but never the other way around.
        if (existing && (existing.state === 'suggested' || !actionable)) continue;
        const list = recommendationList(r.recommendation);
        const top = list[0] || null;
        if (actionable && !top) continue; // pending review but nothing to suggest (noise-ish)
        map.set(r.ticketId, actionable
          ? {
            runId: r.id,
            state: 'suggested',
            techId: top.techId ?? null,
            techName: top.techName || null,
            score: typeof top.score === 'number' ? top.score : null,
            count: list.length,
            // Top few ranked candidates so the queue's quick-assign can offer the
            // runners-up (2nd/3rd), matching the Assignment Review card.
            candidates: list.slice(0, 3).map((c) => ({
              techId: c.techId ?? null,
              techName: c.techName || null,
              score: typeof c.score === 'number' ? c.score : null,
            })),
            createdAt: r.createdAt,
          }
          : { runId: r.id, state: r.status === 'running' ? 'analyzing' : 'queued', createdAt: r.createdAt });
      }
    } catch (err) {
      logger.warn(`ai-run lookup failed (non-fatal): ${err.message}`);
    }
    return map;
  }

  /**
   * "AI bypassed" per ticket: the assignment was made in FreshService, not by
   * our AI, so the queue can flag it. Two shapes:
   *   - reassigned:   our AI auto-assigned a tech (and synced it), then a human
   *                   reassigned the ticket in FS to someone else.
   *   - handled_in_fs: the ticket was already assigned in FS (self-picked or by
   *                   a coordinator) before our AI run could act — the pipeline
   *                   aborts with preflightAbort.code === 'superseded_assignee'.
   * The current assignee is whoever picked it up (often an agent deactivated in
   * Ticket Pulse — an external group we triage for). Display-only — no pipeline
   * state is changed.
   */
  async _aiBypassByTicket(items) {
    const map = new Map();
    const assigned = items.filter((t) => t.assignedTechId !== null && t.assignedTechId !== undefined);
    if (!assigned.length) return map;
    try {
      const runs = await prisma.assignmentPipelineRun.findMany({
        where: { ticketId: { in: assigned.map((t) => t.id) }, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, ticketId: true, decision: true, assignedTechId: true, syncPayload: true, recommendation: true },
      });
      // Newest completed run per ticket — its outcome is what's relevant.
      const latestRun = new Map();
      for (const r of runs) if (!latestRun.has(r.ticketId)) latestRun.set(r.ticketId, r);

      const byId = new Map(assigned.map((t) => [t.id, t]));
      const flagged = [];
      for (const [ticketId, r] of latestRun) {
        const t = byId.get(ticketId);
        const supersededInFs = r.syncPayload?.preflightAbort?.code === 'superseded_assignee';
        const reassigned = r.decision === 'auto_assigned' && r.assignedTechId !== null && r.assignedTechId !== t.assignedTechId;
        if (!supersededInFs && !reassigned) continue;
        const top = recommendationList(r.recommendation)[0] || null;
        flagged.push({ t, runId: r.id, aiTechName: top?.techName || null, kind: reassigned ? 'reassigned' : 'handled_in_fs' });
      }
      if (!flagged.length) return map;

      // Who assigned it in FS: the current (still-active) episode. self_picked
      // means the assignee grabbed it themselves.
      const episodes = await prisma.ticketAssignmentEpisode.findMany({
        where: { ticketId: { in: flagged.map((f) => f.t.id) }, endMethod: 'still_active' },
        select: { ticketId: true, startMethod: true, startAssignedByName: true },
      });
      const epByTicket = new Map(episodes.map((e) => [e.ticketId, e]));

      for (const f of flagged) {
        const ep = epByTicket.get(f.t.id);
        const selfPicked = ep?.startMethod === 'self_picked';
        const byActorName = selfPicked ? (f.t.assignedTech?.name || null) : (ep?.startAssignedByName || null);
        map.set(f.t.id, { runId: f.runId, kind: f.kind, aiTechName: f.aiTechName, byActorName, selfPicked });
      }
    } catch (err) {
      logger.warn(`ai-bypass lookup failed (non-fatal): ${err.message}`);
    }
    return map;
  }

  /** Last public conversation entry per ticket → was it inbound (requester)? */
  async _lastPublicEntryIncoming(ticketIds) {
    const map = new Map();
    if (!ticketIds.length) return map;
    try {
      const rows = await prisma.$queryRaw`
        SELECT DISTINCT ON (ticket_id) ticket_id, incoming, author_type
        FROM ticket_thread_entries
        WHERE ticket_id = ANY(${ticketIds})
          AND (is_private = false OR is_private IS NULL)
          AND (body_text IS NOT NULL OR content IS NOT NULL)
        ORDER BY ticket_id, occurred_at DESC, id DESC`;
      for (const r of rows) {
        map.set(Number(r.ticket_id), r.incoming === true || r.author_type === 'requester');
      }
    } catch (err) {
      logger.warn(`last-entry lookup failed (non-fatal): ${err.message}`);
    }
    return map;
  }

  /** Open tickets whose latest public conversation entry came from the requester. */
  async _awaitingReplyTicketIds(workspaceId) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT ticket_id FROM (
          SELECT DISTINCT ON (te.ticket_id) te.ticket_id, te.incoming, te.author_type
          FROM ticket_thread_entries te
          JOIN tickets t ON t.id = te.ticket_id
          WHERE t.workspace_id = ${workspaceId}
            AND t.status IN ('Open','Pending')
            AND t.is_noise = false
            AND (te.is_private = false OR te.is_private IS NULL)
            AND (te.body_text IS NOT NULL OR te.content IS NOT NULL)
          ORDER BY te.ticket_id, te.occurred_at DESC, te.id DESC
        ) latest
        WHERE latest.incoming = true OR latest.author_type = 'requester'
        LIMIT 5000`;
      return rows.map((r) => Number(r.ticket_id));
    } catch (err) {
      logger.warn(`awaiting-reply lookup failed (non-fatal): ${err.message}`);
      return [];
    }
  }

  /** Segment counts for the stat-card row. */
  async getQueueStats(workspaceId) {
    const now = new Date();
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const open = { workspaceId, isNoise: false, status: { in: ['Open', 'Pending'] } };

    const [all, openCount, unassigned, dueToday, overdue, resolved, deleted, noise, awaitingIds, technicianOpen] = await Promise.all([
      prisma.ticket.count({ where: { workspaceId, isNoise: false, status: { notIn: ['Deleted', 'Spam'] } } }),
      prisma.ticket.count({ where: open }),
      prisma.ticket.count({ where: { ...open, assignedTechId: null } }),
      prisma.ticket.count({
        where: {
          ...open,
          OR: [
            { dueBy: { gte: now, lte: endOfDay } },
            { frDueBy: { gte: now, lte: endOfDay }, firstPublicAgentReplyAt: null },
          ],
        },
      }),
      prisma.ticket.count({
        where: {
          ...open,
          OR: [
            { dueBy: { lt: now } },
            { frDueBy: { lt: now }, firstPublicAgentReplyAt: null },
          ],
        },
      }),
      prisma.ticket.count({ where: { workspaceId, isNoise: false, status: { in: ['Resolved', 'Closed'] } } }),
      prisma.ticket.count({ where: { workspaceId, status: { in: ['Deleted', 'Spam'] } } }),
      prisma.ticket.count({ where: { workspaceId, isNoise: true } }),
      this._awaitingReplyTicketIds(workspaceId),
      // Per-technician OPEN workload (Open/Pending, non-noise). Returned as a
      // {techId: count} map — NOT sorted/ranked; the UI keeps its own order so
      // this reads as a workload signal, not a leaderboard (team-safe rule).
      prisma.ticket.groupBy({
        by: ['assignedTechId'],
        where: { ...open, assignedTechId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const byTechnician = {};
    for (const row of technicianOpen) {
      if (row.assignedTechId !== null) byTechnician[row.assignedTechId] = row._count._all;
    }

    return {
      all,
      open: openCount,
      unassigned,
      awaiting: awaitingIds.length,
      dueToday,
      overdue,
      resolved,
      deleted,
      noise,
      byTechnician,
    };
  }

  /** Clone a ticket into a new TP-born ticket (fields, not conversation). */
  async cloneTicket(ticketId, workspaceId, actor) {
    const source = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { requester: { select: { id: true, email: true, name: true } } },
    });
    if (!source) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    if (!source.requester?.email && !source.requesterId) {
      throw new ValidationError('The source ticket has no requester to clone with');
    }
    return this.createTicket(workspaceId, {
      subject: `Copy of: ${source.subject || '(no subject)'}`.slice(0, 500),
      description: source.description || source.descriptionText || null,
      priority: source.priority || 2,
      requesterId: source.requesterId || undefined,
      requesterEmail: source.requester?.email || undefined,
      requesterName: source.requester?.name || undefined,
      internalCategoryId: source.internalCategoryId || null,
      internalSubcategoryId: source.internalSubcategoryId || null,
      groupId: source.groupId ? Number(source.groupId) : null,
      runAiTriage: false,
    }, actor);
  }

  async getTicket(ticketId, workspaceId, { reconcile: withReconcile = true } = {}) {
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
          take: 10,
          select: {
            id: true, status: true, decision: true, triggerSource: true,
            assignedTechId: true, createdAt: true, decidedAt: true, syncStatus: true,
            recommendation: true, errorMessage: true, queuedReason: true, decidedByEmail: true,
          },
        },
      },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    // Deleted/spam FreshService tickets vanish from the list API, so a ticket
    // trashed in FS after sync lingers as "Open" here. When a user opens an
    // FS-born, non-terminal ticket, verify it against FS in parallel and flip it
    // to Deleted/Spam immediately (best-effort — never blocks or fails the load).
    // Covers FS-born tickets (deleted/spam detection) AND TP-born mirrored
    // tickets (pull a FreshService-side closure back) — reconcileSingleTicket
    // branches by origin.
    const NON_TERMINAL = !['Closed', 'Resolved', 'closed', 'resolved', 'Deleted', 'Spam', '4', '5'].includes(String(ticket.status));
    const shouldReconcile = withReconcile && Boolean(ticket.freshserviceTicketId) && NON_TERMINAL;

    // The FreshService reconcile runs in the BACKGROUND (not awaited) so the page
    // never waits on a FS round-trip. If it flips the status (deleted/closed in
    // FS), reconcileSingleTicket broadcasts a ticket-change and the open page
    // picks it up via its (debounced) SSE refetch. This keeps the load fast.
    if (shouldReconcile) {
      import('./syncService.js')
        .then(({ default: syncService }) => syncService.reconcileSingleTicket(ticket.id, workspaceId))
        .catch(() => null);
    }
    const [thread, activities, approvals, attachments] = await Promise.all([
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
          requestGroupId: true,
          approvalCategory: { select: { id: true, name: true } },
        },
      }),
      prisma.ticketAttachment.findMany({
        where: { ticketId: ticket.id },
        orderBy: { id: 'asc' },
        select: {
          id: true, fileName: true, contentType: true, sizeBytes: true,
          threadEntryId: true, source: true, uploadedBy: true, createdAt: true,
        },
      }),
    ]);

    const incomingByTicket = await this._lastPublicEntryIncoming([ticket.id]);
    const resolvedThread = await this._resolveThreadActors(thread, workspaceId, ticket.requester);

    return {
      ...ticket,
      displayRef: ticketDisplayRef(ticket),
      thread: resolvedThread,
      activities,
      approvals,
      attachments,
      latestPipelineRun: ticket.pipelineRuns?.[0] || null,
      stateChip: deriveStateChip(ticket, incomingByTicket.get(ticket.id) === true),
      lastActivityAt: ticket.lastRealActivityAt || ticket.freshserviceUpdatedAt || ticket.updatedAt,
    };
  }

  /**
   * FreshService conversation entries often carry only the author's FS user id
   * (no name/email), so agent notes synced from FS render as "Unknown". Resolve
   * those against our synced technicians (by FS id, then email) so the author
   * matches one-to-one; incoming/requester entries fall back to the requester's
   * name. Read-time enrichment — fixes historical rows without a re-sync.
   */
  async _resolveThreadActors(thread, workspaceId, requester) {
    if (!Array.isArray(thread) || thread.length === 0) return thread;
    const needsName = (e) => {
      const n = String(e.actorName || '').trim();
      return !n || n.toLowerCase() === 'unknown';
    };
    const toResolve = thread.filter(needsName);
    if (toResolve.length === 0) return thread;

    const fsIds = [...new Set(toResolve.map((e) => e.actorFreshserviceId).filter((v) => v !== null).map((v) => BigInt(v)))];
    const emails = [...new Set(toResolve.map((e) => String(e.actorEmail || '').toLowerCase()).filter(Boolean))];
    if (fsIds.length === 0 && emails.length === 0) {
      // Nothing to match on except requester fallback for incoming entries.
      const reqNameOnly = requester?.name || null;
      if (!reqNameOnly) return thread;
      return thread.map((e) => (needsName(e) && (e.incoming === true || e.authorType === 'requester')
        ? { ...e, actorName: reqNameOnly } : e));
    }

    const orClauses = [];
    if (fsIds.length) orClauses.push({ freshserviceId: { in: fsIds } });
    if (emails.length) orClauses.push({ email: { in: emails } });
    const techs = await prisma.technician.findMany({
      where: { workspaceId, OR: orClauses },
      select: { freshserviceId: true, email: true, name: true },
    });
    const byFsId = new Map();
    const byEmail = new Map();
    for (const t of techs) {
      if (t.freshserviceId !== null) byFsId.set(String(t.freshserviceId), t);
      if (t.email) byEmail.set(t.email.toLowerCase(), t);
    }
    const reqName = requester?.name || null;

    return thread.map((e) => {
      if (!needsName(e)) return e;
      let match = null;
      if (e.actorFreshserviceId !== null) match = byFsId.get(String(e.actorFreshserviceId));
      if (!match && e.actorEmail) match = byEmail.get(String(e.actorEmail).toLowerCase());
      if (match) return { ...e, actorName: match.name, actorEmail: e.actorEmail || match.email || null };
      if ((e.incoming === true || e.authorType === 'requester') && reqName) return { ...e, actorName: reqName };
      // TP-authored notes mirrored into FS carry the "[Ticket Pulse]" marker but
      // sync back under the FS service account (not a technician) — label them.
      if (/^\s*\[ticket pulse\]/i.test(String(e.bodyText || e.content || ''))) {
        return { ...e, actorName: 'Ticket Pulse' };
      }
      return e;
    });
  }

  /** Reference data for the ticket composer / filters. */
  async getMeta(workspaceId) {
    const [workspace, groups, technicians, categories, sourceRows, approvalCategories] = await Promise.all([
      this._getWorkspace(workspaceId),
      prisma.group.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, freshserviceId: true, name: true, origin: true },
        orderBy: { name: 'asc' },
      }),
      prisma.technician.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, email: true, photoUrl: true, origin: true },
        orderBy: { name: 'asc' },
      }),
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, parentId: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.ticket.groupBy({
        by: ['source'],
        where: { workspaceId, source: { not: null } },
        _count: { _all: true },
      }),
      prisma.approvalCategory.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, description: true, managerEmails: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const tops = categories.filter((c) => c.parentId === null);
    const categoryTree = tops.map((top) => ({
      id: top.id,
      name: top.name,
      subcategories: categories.filter((c) => c.parentId === top.id).map((s) => ({ id: s.id, name: s.name })),
    }));

    // Only the source channels that actually occur in this workspace.
    const sources = sourceRows
      .map((row) => ({
        value: row.source,
        label: FS_SOURCE_LABELS[row.source] || `Source ${row.source}`,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count);

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
      sources,
      // Active approval categories for the ticket Approvals tab request picker.
      // managerEmails lets the request modal preview who will be notified
      // (resolved to member avatars/names client-side via `technicians`).
      approvalCategories: approvalCategories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description || null,
        managerEmails: c.managerEmails || [],
        managerCount: (c.managerEmails || []).length,
      })),
    };
  }

  /**
   * Compact requester history for the peek/detail requester cards: how much
   * they use the helpdesk and how it usually ends. Cheap indexed counts only.
   */
  async requesterStats(requesterId, workspaceId) {
    const id = Number(requesterId);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid requester id');
    const base = { workspaceId, requesterId: id, isNoise: false };
    const [total, open, resolved, last] = await Promise.all([
      prisma.ticket.count({ where: base }),
      prisma.ticket.count({ where: { ...base, status: { in: ['Open', 'Pending'] } } }),
      prisma.ticket.count({ where: { ...base, status: { in: ['Resolved', 'Closed'] } } }),
      prisma.ticket.findFirst({ where: base, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    return { total, open, resolved, lastTicketAt: last?.createdAt || null };
  }

  /**
   * Manual AI-triage request from the ticket surfaces (any origin — the
   * pipeline is the same one FS tickets run through). Fire-and-forget.
   */
  async requestTriage(ticketId, workspaceId, actor) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, origin: true, status: true, assignedTechId: true, nativeNumber: true, freshserviceTicketId: true },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    await this._audit(ticket.id, 'ai_triage', actor, { manual: true });
    const result = await this._startAiTriage(ticket.id, workspaceId);
    this._broadcast(workspaceId, 'triage', ticket, { queued: result.queued });
    return result;
  }

  /**
   * Related tickets, accuracy-first (T3.5): only provably-true relations are
   * asserted ("other tickets from this requester"); same-normalized-subject
   * matches within ±7 days come back separately as clearly-labeled suggestions.
   */
  async relatedTickets(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, requesterId: true, subject: true, createdAt: true },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const select = {
      id: true, nativeNumber: true, freshserviceTicketId: true, origin: true,
      subject: true, status: true, createdAt: true,
      assignedTech: { select: { id: true, name: true } },
    };
    const toItem = (t) => ({ ...t, displayRef: ticketDisplayRef(t) });

    // Match the tickets list's base scope (no Deleted/Spam, no noise) so the
    // header "N other tickets" count lines up with what the filtered list shows.
    const sameRequesterWhere = {
      workspaceId, requesterId: ticket.requesterId, id: { not: ticket.id },
      isNoise: false, status: { notIn: ['Deleted', 'Spam'] },
    };
    const sameRequester = ticket.requesterId
      ? (await prisma.ticket.findMany({
        where: sameRequesterWhere,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select,
      })).map(toItem)
      : [];
    // Accurate total (the list above is capped at 5 for display).
    const sameRequesterCount = ticket.requesterId
      ? await prisma.ticket.count({ where: sameRequesterWhere })
      : 0;

    // Suggestion tier: identical normalized subject in a ±7 day window.
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .replace(/^(\s*(re|fw|fwd)\s*[:\]]\s*)+/i, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    const core = normalize(ticket.subject);
    let nearDuplicates = [];
    if (core.length >= 8) {
      const windowStart = new Date(new Date(ticket.createdAt).getTime() - 7 * 864e5);
      const windowEnd = new Date(new Date(ticket.createdAt).getTime() + 7 * 864e5);
      const candidates = await prisma.ticket.findMany({
        where: {
          workspaceId,
          id: { not: ticket.id },
          isNoise: false,
          createdAt: { gte: windowStart, lte: windowEnd },
          // Cheap SQL prefilter; the exact normalized comparison happens below.
          subject: { contains: core.split(' ').slice(0, 3).join(' '), mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select,
      });
      nearDuplicates = candidates
        .filter((c) => normalize(c.subject) === core)
        .filter((c) => !sameRequester.some((s) => s.id === c.id))
        .slice(0, 3)
        .map(toItem);
    }

    return { sameRequester, sameRequesterCount, nearDuplicates };
  }

  /**
   * Requester typeahead for the create flow: known requesters first, then
   * Entra directory people not yet in the requester table. Entra being
   * unconfigured/unreachable degrades to requester-only results.
   */
  async searchRequesters(q) {
    const query = String(q || '').trim();
    if (query.length < 2) return { requesters: [], directory: [] };

    const requesters = await prisma.requester.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true, name: true, email: true, department: true,
        entraOfficeLocation: true, entraCity: true, jobTitle: true,
      },
      orderBy: { name: 'asc' },
      take: 8,
    });

    const knownEmails = new Set(requesters.map((r) => (r.email || '').toLowerCase()).filter(Boolean));
    let directory = [];
    try {
      const { default: azureAdService } = await import('./azureAdService.js');
      const users = await azureAdService.searchUsers(query, 8);
      directory = (users || [])
        .filter((u) => u.mail && !knownEmails.has(u.mail))
        .map((u) => ({
          name: u.displayName,
          email: u.mail,
          jobTitle: u.jobTitle || null,
          department: u.department || null,
        }));
    } catch (err) {
      logger.warn(`Entra requester search unavailable (requesters still returned): ${err.message}`);
    }

    return { requesters, directory };
  }

  /**
   * Validates a createTicket input without creating anything — used by
   * scheduled tickets so activation can't fail on input that was bad all along.
   */
  async validateCreateInput(workspaceId, input) {
    const parsed = createTicketSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
    const data = parsed.data;
    await this._validateTaxonomy(workspaceId, data.internalCategoryId, data.internalSubcategoryId);
    await this._validateGroup(workspaceId, data.groupId ?? null);
    if (data.assignedTechId) await this._validateTechnician(workspaceId, data.assignedTechId);
    return data;
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
    const internalGroupId = await this._validateInternalGroup(workspaceId, data.internalGroupId ?? null);
    const assignee = data.assignedTechId
      ? await this._validateTechnician(workspaceId, data.assignedTechId)
      : null;

    const requester = await this.resolveRequester(workspaceId, data);

    const { isNoise, ruleId } = await noiseRuleService.evaluate(data.subject, new Date(), workspaceId);
    const nativeNumber = await this._nextNativeNumber();
    const now = new Date();
    const isSelfPicked = Boolean(assignee && actor?.technicianId && actor.technicianId === assignee.id);

    // TP-born tickets get Ticket Pulse's own SLA clocks (per-priority policy,
    // if the workspace configured one). FS-born tickets keep FS's SLA fields.
    let slaDueDates = { frDueBy: null, dueBy: null };
    try {
      const { default: slaPolicyService } = await import('./slaPolicyService.js');
      slaDueDates = await slaPolicyService.dueDatesFor(workspaceId, data.priority, now);
    } catch { /* no policy — no clocks */ }

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
        ticketType: data.ticketType,
        workspaceId,
        workspaceName: workspace.name,
        requesterId: requester.id,
        requesterFreshserviceId: requester.freshserviceId ?? null,
        department: requester.department || null,
        internalCategoryId: data.internalCategoryId ?? null,
        internalSubcategoryId: data.internalSubcategoryId ?? null,
        groupId,
        internalGroupId,
        createdAt: now,
        lastRealActivityAt: now,
        isNoise,
        noiseRuleMatched: ruleId,
        lastIngestSource: 'ticketpulse_native',
        lastIngestedAt: now,
        ...(slaDueDates.frDueBy ? { frDueBy: slaDueDates.frDueBy } : {}),
        ...(slaDueDates.dueBy ? { dueBy: slaDueDates.dueBy } : {}),
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
      ...(data.ccEmails.length ? { ccEmails: data.ccEmails } : {}),
      ...(data.notifyRequester === false ? { requesterEmailSuppressed: true } : {}),
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

    await this._notifyLifecycle(null, ticket, { allow: data.notifyRequester });
    // Category/group watchers (fire-and-forget; creation never blocks on it).
    watcherNotificationService.notify('created', ticket.id).catch(() => {});
    this._broadcast(workspaceId, 'created', ticket);
    await mirrorService.enqueueTicketCreate(ticket);

    // AI on create, decoupled from assignment:
    //  • unassigned + runAiTriage  → FULL pipeline (classify + priority + type + recommend)
    //  • aiClassifyOnly (assigned OR unassigned) → assessment-only run (no assignee change)
    // Noise never triages.
    let triage = { queued: false };
    if (!isNoise) {
      if (!assignee && data.runAiTriage) {
        triage = await this._startAiTriage(ticket.id, workspaceId, APP_NATIVE_TRIGGER_SOURCE);
      } else if (data.aiClassifyOnly) {
        triage = await this._startAiTriage(ticket.id, workspaceId, 'classification_only');
      }
    }

    logger.info(`Native ticket created: ${ticketDisplayRef(ticket)} (id ${ticket.id}, ws ${workspaceId}) by ${actor?.email || 'unknown'}`);
    return { ...ticket, displayRef: ticketDisplayRef(ticket), triage };
  }

  async _startAiTriage(ticketId, workspaceId, triggerSource = APP_NATIVE_TRIGGER_SOURCE) {
    try {
      const { default: assignmentPipelineService } = await import('./assignmentPipelineService.js');
      // Fire-and-forget: the pipeline handles business-hours queueing itself.
      const runPromise = assignmentPipelineService
        .runPipeline(ticketId, workspaceId, triggerSource)
        .catch((err) => {
          logger.warn(`AI triage failed for native ticket ${ticketId} (non-fatal): ${err.message}`);
        });
      // Detach without awaiting completion — creation must not block on the LLM.
      runPromise.then(() => {});
      const mode = triggerSource === 'classification_only' ? 'classify' : 'triage';
      return { queued: true, mode };
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
    if (data.ticketType !== undefined && data.ticketType !== ticket.ticketType) {
      patch.ticketType = data.ticketType;
      changes.ticketType = { from: ticket.ticketType, to: data.ticketType };
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
    if (data.internalGroupId !== undefined) {
      const internalGroupId = await this._validateInternalGroup(workspaceId, data.internalGroupId);
      if (internalGroupId !== ticket.internalGroupId) {
        patch.internalGroupId = internalGroupId;
        changes.internalGroupId = { from: ticket.internalGroupId ?? null, to: internalGroupId ?? null };
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

  /**
   * FS-born field write-back (assignee / status / priority / TP categories).
   * FreshService stays the source of truth: we PUT to FS FIRST, verify its
   * echoed ticket actually carries the requested values, and only then update
   * our row — an FS failure (or silent non-acceptance) changes NOTHING
   * locally, so the two systems can never diverge through this path.
   */
  async updateFsTicket(ticketId, workspaceId, input, actor) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE || !ticket.freshserviceTicketId) {
      throw new ValidationError('This ticket is Ticket Pulse-owned — edit it directly, no FreshService sync needed');
    }

    const workspace = await this._getWorkspace(workspaceId);
    const client = await mirrorService.getClient(workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');

    const { getStatusId, getStatusString } = await import('../integrations/freshserviceTransformer.js');

    const fsPayload = {};
    const localPatch = {};
    const changes = {};

    if (input.status !== undefined) {
      if (!NATIVE_TICKET_STATUSES.includes(input.status)) {
        throw new ValidationError(`Status must be one of: ${NATIVE_TICKET_STATUSES.join(', ')}`);
      }
      fsPayload.status = getStatusId(input.status);
      localPatch.status = input.status;
      changes.status = { from: ticket.status, to: input.status };
    }

    if (input.priority !== undefined) {
      const p = Number(input.priority);
      if (![1, 2, 3, 4].includes(p)) throw new ValidationError('Priority must be 1–4');
      fsPayload.priority = p;
      localPatch.priority = p;
      changes.priority = { from: ticket.priority, to: p };
    }

    let assignee = null;
    if (input.assignedTechId !== undefined) {
      if (input.assignedTechId === null) {
        fsPayload.responder_id = null;
        localPatch.assignedTechId = null;
      } else {
        assignee = await this._validateTechnician(workspaceId, Number(input.assignedTechId));
        if (!assignee.freshserviceId || assignee.origin === 'local') {
          throw new ValidationError(`${assignee.name} is a local member (no FreshService license) and can only be assigned Ticket Pulse tickets, not FreshService tickets.`);
        }
        fsPayload.responder_id = Number(assignee.freshserviceId);
        localPatch.assignedTechId = assignee.id;
      }
      changes.assignee = { from: ticket.assignedTech?.name || null, to: assignee?.name || null };
    }

    if (input.internalCategoryId !== undefined || input.internalSubcategoryId !== undefined) {
      const catId = input.internalCategoryId !== undefined ? input.internalCategoryId : ticket.internalCategoryId;
      const subId = input.internalSubcategoryId !== undefined ? input.internalSubcategoryId : null;
      await this._validateTaxonomy(workspaceId, catId, subId);
      const cat = catId ? await prisma.competencyCategory.findUnique({ where: { id: catId }, select: { name: true } }) : null;
      const sub = subId ? await prisma.competencyCategory.findUnique({ where: { id: subId }, select: { name: true } }) : null;
      // The TP taxonomy lives in FS as custom_lookup fields backed by custom
      // objects — FS silently drops plain strings, so resolve names to the
      // lookup records' display ids (same machinery the AI pipeline uses).
      const { default: settingsRepository } = await import('./settingsRepository.js');
      const { default: freshServiceActionService } = await import('./freshServiceActionService.js');
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      fsPayload.custom_fields = await freshServiceActionService._resolveTicketPulseLookupFields(client, {
        localFields: { tpSkill: cat?.name || null, tpSubskill: sub?.name || null },
        customFields: {
          [fsConfig.tpSkillCustomField]: cat?.name || null,
          [fsConfig.tpSubskillCustomField]: sub?.name || null,
        },
      }, fsConfig);
      Object.assign(localPatch, {
        internalCategoryId: catId ?? null,
        internalSubcategoryId: subId ?? null,
        tpSkill: cat?.name || null,
        tpSubskill: sub?.name || null,
      });
      changes.category = {
        from: [ticket.internalCategory?.name || ticket.tpSkill, ticket.internalSubcategory?.name || ticket.tpSubskill].filter(Boolean).join(' / ') || null,
        to: [cat?.name, sub?.name].filter(Boolean).join(' / ') || null,
      };
    }

    if (Object.keys(fsPayload).length === 0) throw new ValidationError('Nothing to sync');

    // 1) Write to FreshService — any failure aborts before local changes.
    const fsTicket = await client.updateTicketFields(Number(ticket.freshserviceTicketId), fsPayload);

    // 2) Verify FS actually accepted each value (a 200 with silently-dropped
    //    fields must NOT desync us).
    const rejected = [];
    if (fsPayload.status !== undefined && fsTicket.status !== fsPayload.status) {
      rejected.push(`status (FS kept ${getStatusString(fsTicket.status)})`);
    }
    if (fsPayload.priority !== undefined && fsTicket.priority !== fsPayload.priority) rejected.push('priority');
    if (fsPayload.responder_id !== undefined && String(fsTicket.responder_id ?? '') !== String(fsPayload.responder_id ?? '')) rejected.push('assignee');
    if (fsPayload.custom_fields) {
      const cf = fsTicket.custom_fields || {};
      if (String(cf[workspace.tpSkillCustomField] ?? '') !== String(fsPayload.custom_fields[workspace.tpSkillCustomField] ?? '')) rejected.push('category');
      if (String(cf[workspace.tpSubskillCustomField] ?? '') !== String(fsPayload.custom_fields[workspace.tpSubskillCustomField] ?? '')) rejected.push('subcategory');
    }
    if (rejected.length > 0) {
      throw new ValidationError(`FreshService did not accept: ${rejected.join(', ')} — nothing was changed in Ticket Pulse`);
    }

    // 3) FS confirmed — now mirror the same values locally.
    const now = new Date();
    if (localPatch.status && ['Resolved', 'Closed'].includes(localPatch.status) && !TERMINAL_STATUSES.includes(ticket.status)) {
      localPatch.resolvedAt = ticket.resolvedAt || now;
      if (localPatch.status === 'Closed') localPatch.closedAt = ticket.closedAt || now;
    }
    if (localPatch.assignedTechId) {
      localPatch.assignedAt = now;
      if (!ticket.firstAssignedAt) localPatch.firstAssignedAt = now;
      localPatch.assignedBy = actor?.name || actor?.email || 'Ticket Pulse';
    }
    localPatch.lastRealActivityAt = now;
    if (fsTicket.updated_at) localPatch.freshserviceUpdatedAt = new Date(fsTicket.updated_at);

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: localPatch,
      include: TICKET_INCLUDE,
    });

    await this._audit(ticket.id, 'fs_write_back', actor, { changes, fsTicketId: Number(ticket.freshserviceTicketId) });
    this._broadcast(workspaceId, 'fs_update', updated, { changes: Object.keys(changes) });
    logger.info(`FS write-back OK for #${ticket.freshserviceTicketId} (ticket ${ticket.id}): ${Object.keys(changes).join(', ')} by ${actor?.email || 'unknown'}`);
    return { ...updated, displayRef: ticketDisplayRef(updated), synced: Object.keys(changes) };
  }

  /**
   * Manual noise/spam flag. The flag is Ticket Pulse's own classification, so
   * it works for any origin; the optional auto-resolve is TP-born only
   * (FS-born status belongs to FreshService).
   */
  /**
   * Log time against a ticket (TP's own tracking layer — both origins, never
   * written to FreshService). Adds to the running totals with an audit entry.
   */
  async logTime(ticketId, workspaceId, { minutes, billable = false, note = null } = {}, actor) {
    const amount = Number(minutes);
    if (!Number.isInteger(amount) || amount < 1 || amount > 24 * 60) {
      throw new ValidationError('Time entry must be between 1 minute and 24 hours');
    }
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId } });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        timeSpentMinutes: (ticket.timeSpentMinutes || 0) + amount,
        ...(billable
          ? { billableMinutes: (ticket.billableMinutes || 0) + amount }
          : { nonBillableMinutes: (ticket.nonBillableMinutes || 0) + amount }),
      },
      select: { id: true, timeSpentMinutes: true, billableMinutes: true, nonBillableMinutes: true },
    });
    await this._audit(ticket.id, 'time_logged', actor, {
      minutes: amount,
      billable: billable === true,
      ...(note ? { note: String(note).slice(0, 500) } : {}),
    });
    return updated;
  }

  async setNoise(ticketId, workspaceId, { noise = true, resolve = false } = {}, actor) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId } });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    const flag = noise !== false && noise !== 'false';

    let updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { isNoise: flag, ...(flag ? {} : { noiseRuleMatched: null }) },
      include: TICKET_INCLUDE,
    });
    await this._audit(ticket.id, flag ? 'noise_flagged' : 'noise_cleared', actor, { manual: true });

    let resolved = false;
    if (flag && resolve && ticket.origin === TICKET_ORIGIN.TICKETPULSE && !TERMINAL_STATUSES.includes(ticket.status)) {
      updated = await this.changeStatus(ticket.id, workspaceId, 'Resolved', actor);
      resolved = true;
    } else {
      this._broadcast(workspaceId, 'noise', updated, { isNoise: flag });
    }
    return { ...updated, displayRef: ticketDisplayRef(updated), isNoise: flag, resolved };
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
    // ticket.status_changed (with from/to extra) is derived inside
    // _notifyLifecycle now — single emit path shared with the FS sync, with a
    // stable dedupe stamp instead of the old Date.now() one.
    await this._notifyLifecycle(ticket, updated);
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

  async addReply(ticketId, workspaceId, input, actor, files = []) {
    return this._addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate: false, files });
  }

  async addPrivateNote(ticketId, workspaceId, input, actor, files = []) {
    return this._addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate: true, files });
  }

  async _addThreadEntry(ticketId, workspaceId, input, actor, { isPrivate, files = [] }) {
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
    const cc = isPrivate ? [] : parsed.data.cc;

    // Validate attachments up front so a bad file can't leave an orphan entry.
    if (files.length > 0 && !attachmentService.isConfigured()) {
      throw new ValidationError('Attachment storage is not configured for this environment');
    }
    for (const file of files) {
      attachmentService.validateUpload({ fileName: file.originalname, sizeBytes: file.size });
    }

    const bodyHtml = parsed.data.bodyHtml?.trim() || null;
    const bodyText = parsed.data.bodyText?.trim() || stripHtml(bodyHtml);
    const now = new Date();

    // FS-born tickets: FS owns requester communication — send through the FS
    // API first (FS emails the requester itself), then cache the entry locally.
    // Files ride along to FreshService as real attachments (multipart) so the
    // FS ticket/thread shows them too — for FS-born (direct) and, later, TP-born
    // (via the mirror). multer memory buffers are already in hand here.
    const fsAttachments = files.map((f) => ({
      filename: f.originalname,
      buffer: f.buffer,
      contentType: f.mimetype,
    }));

    let externalEntryId = null;
    if (!isNative) {
      const client = await mirrorService.getClient(workspaceId);
      if (!client) throw new ValidationError('FreshService is not configured for this workspace');
      const fsId = Number(ticket.freshserviceTicketId);
      const html = bodyHtml || `<p>${(bodyText || '').replace(/\n/g, '<br/>')}</p>`;
      const result = isPrivate
        ? await client.addNote(fsId, html, { isPrivate: true, attachments: fsAttachments })
        : await client.createReply(fsId, html, { ccEmails: cc, attachments: fsAttachments });
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

    // Store attachments before the outbound email so they can ride along.
    const storedAttachments = [];
    for (const file of files) {
      try {
        const attachment = await attachmentService.upload({
          workspaceId,
          ticketId: ticket.id,
          threadEntryId: entry.id,
          fileName: file.originalname,
          contentType: file.mimetype,
          buffer: file.buffer,
          uploadedBy: actor?.email || null,
          source: 'upload',
        });
        storedAttachments.push({ attachment, buffer: file.buffer });
      } catch (err) {
        logger.warn(`Reply attachment "${file.originalname}" failed to store (entry ${entry.id}): ${err.message}`);
      }
    }

    const ticketPatch = { updatedAt: now, lastRealActivityAt: now };
    if (!isPrivate && !ticket.firstPublicAgentReplyAt) {
      ticketPatch.firstPublicAgentReplyAt = now;
    }
    await prisma.ticket.update({ where: { id: ticket.id }, data: ticketPatch });

    let email = { sent: false };
    if (isNative) {
      if (!isPrivate && ticket.requester?.email) {
        email = await this._emailRequesterReply(ticket, entry, { cc, attachments: storedAttachments });
      }
      await mirrorService.enqueueThreadEntry(workspaceId, ticket.id, entry.id);
    } else if (!isPrivate) {
      email = { sent: true, via: 'freshservice' };
    }

    // Workflow events fire for BOTH origins — the entry exists locally either
    // way, and workflows keying on notes/replies must not care where the
    // ticket was born. Stable per-entry stamps keep retries idempotent.
    ticketLifecycleNotificationService.emitTicketEvent?.(
      isPrivate ? 'ticket.note_added' : 'ticket.public_reply_added',
      ticket.id,
      {
        dedupeStamp: `${isPrivate ? 'note' : 'reply'}:${entry.id}`,
        extra: { entryId: entry.id, byEmail: actor?.email || null },
      },
    ).catch?.(() => {});

    this._broadcast(workspaceId, isPrivate ? 'note' : 'reply', ticket, { entryId: entry.id });
    return { entry, email, attachments: storedAttachments.map((s) => s.attachment) };
  }

  /**
   * Admin-only deletion of an internal note. Scoped tightly on purpose:
   *  - native (TP-owned) tickets only — FS-sourced notes would just re-sync;
   *  - `eventType === 'note'` — replies/forwards/requester messages are the
   *    real conversation and stay put;
   *  - non-system notes — approval/audit events are preserved.
   * Removes the note's attachments (blobs + rows) then the entry itself. The
   * FreshService fallback copy (if the note was mirrored) is intentionally left
   * alone, matching how attachment deletion behaves today.
   */
  async deleteNote(ticketId, workspaceId, entryId, actor) {
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isAdmin) throw new ValidationError('Only an admin can delete notes');

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    if (ticket.origin !== TICKET_ORIGIN.TICKETPULSE) {
      throw new ValidationError('Notes can only be deleted on Ticket Pulse tickets');
    }

    const entry = await prisma.ticketThreadEntry.findFirst({
      where: { id: Number(entryId), ticketId, workspaceId },
    });
    if (!entry) throw new NotFoundError('Note not found on this ticket');
    if (entry.eventType !== 'note') {
      throw new ValidationError('Only internal notes can be deleted');
    }
    if (entry.authorType === 'system') {
      throw new ValidationError('System and approval notes cannot be deleted');
    }

    // If this note was mirrored to the FreshService fallback copy, capture its
    // FS conversation id BEFORE deleting the local row, then queue the FS-side
    // delete so the mirror stays in step (best-effort; FS gone = job no-ops).
    const fsConversationId = typeof entry.externalEntryId === 'string' && entry.externalEntryId.startsWith('mirror-')
      ? entry.externalEntryId.slice('mirror-'.length)
      : null;

    await attachmentService.removeForThreadEntry(entry.id, workspaceId);
    await prisma.ticketThreadEntry.delete({ where: { id: entry.id } });
    if (fsConversationId) {
      await mirrorService.enqueueThreadEntryDelete(workspaceId, ticket.id, fsConversationId);
    }
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
    });
    await this._audit(ticket.id, 'note.deleted', actor, {
      entryId: entry.id,
      preview: (entry.bodyText || entry.content || '').slice(0, 140),
    });

    logger.info(`Note ${entry.id} on ticket ${ticket.id} deleted by ${actor?.email || 'unknown'}`);
    this._broadcast(workspaceId, 'note', ticket, { entryId: entry.id, deleted: true });
    return { deleted: true, entryId: entry.id };
  }

  /**
   * Forward the ticket's public thread to any email address (T3.8). Sent from
   * the workspace's send-capable Graph mailbox; recorded as a PRIVATE thread
   * entry (the requester isn't part of a forward).
   */
  async forwardTicket(ticketId, workspaceId, { to, note }, actor) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const parsedTo = emailListSchema.safeParse(to);
    if (!parsedTo.success || parsedTo.data.length === 0) {
      throw new ValidationError('Forwarding needs at least one valid destination email');
    }
    const recipients = parsedTo.data;

    const connection = await prisma.mailboxConnection.findFirst({
      where: { workspaceId, isEnabled: true, mode: { in: ['send', 'both'] } },
      orderBy: { id: 'asc' },
    });
    const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
    if (!connection || !graphMailClient.isConfigured()) {
      throw new ValidationError('Forwarding needs a send-capable workspace mailbox (Settings → Ticket Mailboxes)');
    }

    const entries = await ticketThreadRepository.listForTicket(ticket.id, { limit: 300 });
    const publicEntries = entries
      .filter((e) => (e.bodyText || e.content || e.bodyHtml) && !e.isPrivate)
      .slice(-5);
    const ref = ticketDisplayRef(ticket);
    const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const noteText = String(note || '').trim();
    const html = [
      noteText ? `<p>${esc(noteText).replace(/\n/g, '<br/>')}</p><hr/>` : '',
      `<p><b>${esc(ticket.subject || '(no subject)')}</b> (${ref}) — forwarded from Ticket Pulse by ${esc(actor?.name || actor?.email || '')}</p>`,
      ticket.requester?.name ? `<p>Requester: ${esc(ticket.requester.name)}${ticket.requester.email ? ` &lt;${esc(ticket.requester.email)}&gt;` : ''}</p>` : '',
      ticket.descriptionText ? `<blockquote>${esc(ticket.descriptionText.slice(0, 4000)).replace(/\n/g, '<br/>')}</blockquote>` : '',
      ...publicEntries.map((e) => `<hr/><p><b>${esc(e.actorName || 'Unknown')}</b> · ${new Date(e.occurredAt).toLocaleString()}<br/>${esc(String(e.bodyText || e.content || '').slice(0, 4000)).replace(/\n/g, '<br/>')}</p>`),
    ].join('');

    const sent = await graphMailClient.sendMailAsMailbox(connection.address, {
      to: recipients,
      subject: `FW: ${ticket.subject || 'Ticket'} [${ref}]`,
      html,
    });

    const now = new Date();
    const summary = `Forwarded to ${recipients.join(', ')}${noteText ? ` — ${noteText}` : ''}`;
    const entry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId,
        source: 'ticketpulse_user',
        eventType: 'forward',
        actorName: actor?.name || actor?.email || 'Ticket Pulse',
        actorEmail: actor?.email || null,
        authorType: 'agent',
        incoming: false,
        isPrivate: true,
        visibility: 'private',
        content: summary,
        bodyText: summary,
        emailMessageId: sent?.internetMessageId || null,
        occurredAt: now,
        mirrorState: ticket.origin === TICKET_ORIGIN.TICKETPULSE ? 'pending' : null,
      },
    });
    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
      await mirrorService.enqueueThreadEntry(workspaceId, ticket.id, entry.id);
    }
    await this._audit(ticket.id, 'forwarded', actor, { to: recipients, via: connection.address });
    this._broadcast(workspaceId, 'forward', ticket, { entryId: entry.id });
    return { entry, to: recipients, from: connection.address };
  }

  /**
   * Outbound reply email. Prefers a send-capable workspace mailbox via
   * Microsoft Graph (real mailbox, proper threading — the stored Message-ID
   * lets inbound replies match back to the ticket); falls back to the
   * SendGrid/SMTP path. The subject carries the TP-<n> reference as a second
   * threading signal. Non-fatal by design.
   */
  async _emailRequesterReply(ticket, entry, { cc = [], attachments = [] } = {}) {
    const ref = ticketDisplayRef(ticket);
    const subject = `Re: ${ticket.subject || 'Your ticket'} [${ref}]`;
    const html = entry.bodyHtml || `<p>${(entry.bodyText || '').replace(/\n/g, '<br/>')}</p>`;
    const text = entry.bodyText || stripHtml(entry.bodyHtml) || '';
    const dedupeKey = `native-reply:${entry.id}`;
    // Graph simple attach tops out at ~3 MB per file; bigger ones stay
    // download-only in Ticket Pulse (the thread still lists them).
    const mailableAttachments = attachments
      .filter((a) => a.buffer && a.buffer.length <= 3 * 1024 * 1024)
      .map((a) => ({
        name: a.attachment.fileName,
        contentType: a.attachment.contentType,
        contentBytes: a.buffer.toString('base64'),
      }));

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
            cc,
            subject,
            html,
            attachments: mailableAttachments,
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
              ccRecipients: cc,
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
