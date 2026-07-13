import { z } from 'zod';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError, ServiceBusyError } from '../utils/errors.js';
import { TICKET_ORIGIN, TICKET_SOURCE, TICKET_SOURCE_LABELS, APP_NATIVE_TRIGGER_SOURCE, AGENT_SELECTABLE_SOURCES, ticketDisplayRef } from '../utils/ticketOrigin.js';
import noiseRuleService from './noiseRuleService.js';
import ticketTypeService from './ticketTypeService.js';
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

// FreshService 400s carry a structured errors[] the generic message hides —
// "Validation failed" told the user nothing about the missing department
// (QA 07-10, #231072). Translate field errors into actionable English.
const FS_FIELD_LABELS = {
  department_id: 'Department',
  category: 'Category',
  sub_category: 'Subcategory',
  item_category: 'Item',
  group_id: 'Group',
  responder_id: 'Assignee',
  custom_fields: 'a custom field',
};
function fsValidationError(err) {
  const fieldErrors = Array.isArray(err.freshserviceDetail?.errors) ? err.freshserviceDetail.errors : [];
  if (!fieldErrors.length) return err;
  const parts = fieldErrors.map((fe) => {
    const label = FS_FIELD_LABELS[fe.field] || fe.field || 'a field';
    const missing = /type Null/i.test(String(fe.message || '')) || fe.code === 'missing_field';
    return missing ? `${label} is required but not set` : `${label}: ${fe.message || fe.code || 'rejected'}`;
  });
  return new ValidationError(`FreshService rejected the change — ${parts.join('; ')}. Nothing was changed in Ticket Pulse.`);
}

// The FS client wraps limiter rejections in plain Errors, so match on the
// preserved code OR message. A queue timeout means the request never launched
// — nothing reached FreshService, so "try again" is always safe advice.
const FS_BUSY_MESSAGE = 'FreshService is busy with background sync right now — nothing was changed. Please try again in a few seconds.';
function isFsQueueTimeout(err) {
  return err?.code === 'FS_QUEUE_TIMEOUT' || /rate-limit queue/.test(err?.message || '');
}

// Arrival-channel labels live in utils/ticketOrigin.js (TICKET_SOURCE_LABELS):
// FS's numeric codes 1–10 plus the TP extension range (API/Webhook/Agent).

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
  // Arrival channel override (QA 07-10 #7): staff logging a phone/walk-up/
  // Teams request record how it actually reached them.
  source: z.number().int().refine((v) => AGENT_SELECTABLE_SOURCES.includes(v), {
    message: 'Source must be one of the selectable arrival channels',
  }).optional().nullable(),
  // Validated against the workspace's ticket-type registry in createTicket
  // (per-workspace vocabulary — 'Case' for Accounting, 'Incident'/'Service
  // Request'/'Major Incident' for IT…). Omitted -> workspace default type.
  ticketType: z.string().trim().min(1).max(40).optional().nullable(),
  status: z.enum(['Open', 'Pending']).default('Open'),
  requesterId: z.number().int().positive().optional().nullable(),
  requesterEmail: z.string().trim().email().optional().nullable(),
  requesterName: z.string().trim().min(1).max(255).optional().nullable(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
  internalGroupId: z.number().int().positive().optional().nullable(),
  assignedTechId: z.number().int().positive().optional().nullable(),
  impact: z.number().int().min(1).max(3).optional().nullable(),
  urgency: z.number().int().min(1).max(3).optional().nullable(),
  // Tags applied at creation (gap plan 2 P1.3); validated in setTags semantics.
  tagIds: z.array(z.number().int().positive()).max(10).default([]),
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
  source: z.number().int().refine((v) => AGENT_SELECTABLE_SOURCES.includes(v), {
    message: 'Source must be one of the selectable arrival channels',
  }).optional(),
  ticketType: z.string().trim().min(1).max(40).optional().nullable(),
  internalCategoryId: z.number().int().positive().optional().nullable(),
  internalSubcategoryId: z.number().int().positive().optional().nullable(),
  groupId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable(),
  internalGroupId: z.number().int().positive().optional().nullable(),
  impact: z.number().int().min(1).max(3).optional().nullable(),
  urgency: z.number().int().min(1).max(3).optional().nullable(),
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
  // Pending = the clock is stopped (waiting on the requester/a third party):
  // no overdue or response-due nags. A requester reply flips it back to Open
  // via the normal status flow, so the SLA chips resume naturally.
  const slaPaused = ticket.status === 'Pending';
  if (!slaPaused && ((due && due < now) || (fr && fr < now && noFirstReply))) return 'overdue';
  if (!slaPaused && fr && fr >= now && noFirstReply) return 'response_due';
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
  tagLinks: { select: { tag: { select: { id: true, name: true, color: true } } } },
};

/** Flatten the tagLinks relation into a plain tags array for API payloads. */
function ticketTags(t) {
  return (t?.tagLinks || []).map((l) => l.tag).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

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

  /**
   * Build the prisma `where` for a queue query. Shared by listTickets, the CSV
   * export, and bulk-by-query so "everything matching this filter" always
   * resolves to exactly what the list shows.
   */
  async buildListWhere(workspaceId, query = {}) {
    const where = { workspaceId };

    const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (query.status) where.status = { in: asList(query.status) };
    if (query.priority) where.priority = { in: asList(query.priority).map(Number).filter(Number.isFinite) };
    if (query.origin) where.origin = String(query.origin);
    if (query.requesterId) {
      const rid = Number(query.requesterId);
      if (Number.isFinite(rid) && rid > 0) where.requesterId = rid;
    }
    if (query.type) {
      // Multi-select over the workspace's type names, plus the literal 'none'
      // for type-less tickets (FS leaves type optional).
      const values = asList(query.type);
      const names = values.filter((v) => v.toLowerCase() !== 'none');
      const wantsNone = values.some((v) => v.toLowerCase() === 'none');
      if (wantsNone && names.length) {
        where.AND = [...(where.AND || []), { OR: [{ ticketType: null }, { ticketType: { in: names } }] }];
      } else if (wantsNone) {
        where.ticketType = null;
      } else {
        where.ticketType = { in: names };
      }
    }
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
      // Due buckets only apply to Open tickets — Pending pauses the SLA clock
      // (and Resolved/Closed obviously don't nag).
      if (buckets.includes('overdue')) or.push({ dueBy: { lt: dueNow }, status: 'Open' });
      if (buckets.includes('today')) or.push({ dueBy: { gte: dueNow, lte: dueEndOfDay }, status: 'Open' });
      if (buckets.includes('week')) or.push({ dueBy: { gte: dueNow, lte: dueWeekOut }, status: 'Open' });
      if (buckets.includes('none')) or.push({ dueBy: null });
      if (or.length) where.AND = [...(where.AND || []), { OR: or }];
    }
    if (query.impact) {
      const vals = asList(query.impact).map(Number).filter((n) => n >= 1 && n <= 3);
      if (vals.length) where.impact = { in: vals };
    }
    if (query.urgency) {
      const vals = asList(query.urgency).map(Number).filter((n) => n >= 1 && n <= 3);
      if (vals.length) where.urgency = { in: vals };
    }
    if (query.tagId) {
      // Multi-select tag facet: ids and/or the literal 'none' (untagged).
      // tagMode 'all' requires every selected tag; default 'any'.
      const values = asList(query.tagId);
      const ids = values.filter((v) => /^\d+$/.test(v)).map(Number);
      const wantsUntagged = values.includes('none');
      if (query.tagMode === 'all' && ids.length) {
        where.AND = [...(where.AND || []), ...ids.map((id) => ({ tagLinks: { some: { tagId: id } } }))];
      } else if (ids.length && wantsUntagged) {
        where.AND = [...(where.AND || []), { OR: [{ tagLinks: { some: { tagId: { in: ids } } } }, { tagLinks: { none: {} } }] }];
      } else if (ids.length) {
        where.tagLinks = { some: { tagId: { in: ids } } };
      } else if (wantsUntagged) {
        where.tagLinks = { none: {} };
      }
    }
    if (query.noise === 'only') where.isNoise = true;
    else if (query.excludeNoise !== 'false') where.isNoise = false;

    // "Awaiting AI approval" worklist: unassigned tickets whose pipeline produced
    // a recommendation no human has decided yet (decision=pending_review). Same
    // signal that renders the dashed "proposed" assignee slot in the queue, so
    // the filter and the slot always agree.
    if (query.aiState === 'suggested') {
      where.AND = [
        ...(where.AND || []),
        { assignedTechId: null },
        { pipelineRuns: { some: { status: 'completed', decision: 'pending_review' } } },
      ];
    }

    // Stat-card segments (single-select quick filters layered on top)
    const now = new Date();
    if (query.segment === 'open') where.status = { in: ['Open', 'Pending'] };
    else if (query.segment === 'unassigned') {
      where.status = { in: ['Open', 'Pending'] };
      where.assignedTechId = null;
    } else if (query.segment === 'due_today') {
      // SLA segments are Open-only: Pending pauses the clock (no nags).
      where.status = 'Open';
      const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
      where.AND = [...(where.AND || []), {
        OR: [
          { dueBy: { gte: now, lte: endOfDay } },
          { frDueBy: { gte: now, lte: endOfDay }, firstPublicAgentReplyAt: null },
        ],
      }];
    } else if (query.segment === 'overdue') {
      where.status = 'Open';
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
      // Ticket refs: "TP-1042", "1042", "#232558", "232558" — the leading '#'
      // people copy from FreshService must not defeat the numeric match.
      const tpMatch = q.match(/^tp-?(\d+)$/i);
      const numeric = q.replace(/^#/, '');
      if (tpMatch) or.push({ nativeNumber: Number(tpMatch[1]) });
      else if (/^\d+$/.test(numeric)) {
        or.push({ nativeNumber: Number(numeric) });
        or.push({ freshserviceTicketId: BigInt(numeric) });
      }
      // AND-composed so it can't collide with segment OR clauses
      where.AND = [...(where.AND || []), { OR: or }];
    }

    return where;
  }

  async listTickets(workspaceId, query = {}, { maxPageSize = 100 } = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize) || 25));
    const where = await this.buildListWhere(workspaceId, query);

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

    const [incomingByTicket, aiByTicket, bypassByTicket, proposedTicketIds] = await Promise.all([
      this._lastPublicEntryIncoming(items.map((t) => t.id)),
      this._aiRunStateByTicket(items.map((t) => t.id)),
      this._aiBypassByTicket(items),
      this._openProposalTicketIds(items.map((t) => t.id)),
    ]);

    return {
      items: items.map((t) => ({
        ...t,
        tagLinks: undefined,
        tags: ticketTags(t),
        displayRef: ticketDisplayRef(t),
        // truthful "last activity" for display: FS's timestamp for FS-born rows
        lastActivityAt: t.lastRealActivityAt || t.freshserviceUpdatedAt || t.updatedAt,
        stateChip: deriveStateChip(t, incomingByTicket.get(t.id) === true),
        ai: aiByTicket.get(t.id) || null,
        aiBypass: bypassByTicket.get(t.id) || null,
        // A workflow-drafted reply is waiting for a human (QA 07-07 #4:
        // drafts sat unseen unless someone opened the ticket).
        hasProposedReply: proposedTicketIds.has(t.id),
      })),
      total,
      page,
      pageSize,
    };
  }

  async _openProposalTicketIds(ticketIds) {
    if (!ticketIds.length) return new Set();
    try {
      const rows = await prisma.ticketProposedReply.findMany({
        where: { ticketId: { in: ticketIds }, status: 'proposed' },
        select: { ticketId: true },
      });
      return new Set(rows.map((r) => r.ticketId));
    } catch (err) {
      logger.warn(`proposed-reply lookup failed (non-fatal): ${err.message}`);
      return new Set();
    }
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

    const [all, openCount, unassigned, dueToday, overdue, resolved, deleted, noise, awaitingIds, awaitingApproval, technicianOpen] = await Promise.all([
      prisma.ticket.count({ where: { workspaceId, isNoise: false, status: { notIn: ['Deleted', 'Spam'] } } }),
      prisma.ticket.count({ where: open }),
      prisma.ticket.count({ where: { ...open, assignedTechId: null } }),
      // dueToday/overdue count Open tickets only: Pending pauses the SLA
      // clock, so a pending ticket is never "due" or "overdue".
      prisma.ticket.count({
        where: {
          ...open,
          status: 'Open',
          OR: [
            { dueBy: { gte: now, lte: endOfDay } },
            { frDueBy: { gte: now, lte: endOfDay }, firstPublicAgentReplyAt: null },
          ],
        },
      }),
      prisma.ticket.count({
        where: {
          ...open,
          status: 'Open',
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
      // "Awaiting AI approval": unassigned Open/Pending tickets with a pending
      // human decision on their AI recommendation (drives the rail view count).
      prisma.ticket.count({
        where: { ...open, assignedTechId: null, pipelineRuns: { some: { status: 'completed', decision: 'pending_review' } } },
      }),
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
      awaitingApproval,
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
      // Fresh FS-side conversation entries (requester replied in FreshService
      // — QA 07-06 #4). Background, like the status reconcile; new entries
      // broadcast a ticket-change so the open page refetches.
      if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
        mirrorService.reconcileTicket(ticket.id, workspaceId).catch(() => null);
      } else {
        this._refreshFsBornThread(ticket).catch(() => null);
      }
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
          requestedBy: true, requestNote: true, requestNoteHtml: true, decisionNote: true, decisionNoteHtml: true,
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
    // Merged-away tickets carry a pointer to their target for the banner.
    const mergedInto = await import('./ticketMergeService.js')
      .then(({ default: svc }) => svc.mergedInto(ticket.id, workspaceId))
      .catch(() => null);

    return {
      ...ticket,
      mergedInto,
      tagLinks: undefined,
      tags: ticketTags(ticket),
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
   * Replace a ticket's tag set (gap plan Phase 1). Tags are a TP-side layer:
   * valid for BOTH origins and never written back to FreshService. Only active
   * workspace tags may be linked; the diff is audited.
   */
  async setTags(ticketId, workspaceId, tagIds, actor = null) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, tagLinks: { select: { tagId: true } } },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const wanted = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const valid = wanted.length
      ? await prisma.ticketTag.findMany({ where: { id: { in: wanted }, workspaceId, isActive: true }, select: { id: true, name: true } })
      : [];
    if (valid.length !== wanted.length) throw new ValidationError('One or more tags do not exist in this workspace');

    const current = new Set(ticket.tagLinks.map((l) => l.tagId));
    const toAdd = valid.filter((t) => !current.has(t.id));
    const toRemove = [...current].filter((id) => !wanted.includes(id));
    if (!toAdd.length && !toRemove.length) return { changed: false, tags: await this._ticketTagList(ticketId) };

    await prisma.$transaction([
      ...(toRemove.length ? [prisma.ticketTagLink.deleteMany({ where: { ticketId, tagId: { in: toRemove } } })] : []),
      ...(toAdd.length ? [prisma.ticketTagLink.createMany({
        data: toAdd.map((t) => ({ ticketId, tagId: t.id, createdBy: actor?.email || null })),
        skipDuplicates: true,
      })] : []),
    ]);

    const removedNames = toRemove.length
      ? (await prisma.ticketTag.findMany({ where: { id: { in: toRemove } }, select: { name: true } })).map((t) => t.name)
      : [];
    await ticketActivityRepository.create({
      ticketId,
      activityType: 'tags_changed',
      performedBy: actor?.email || 'system',
      details: { added: toAdd.map((t) => t.name), removed: removedNames },
    }).catch(() => null);

    const fresh = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, origin: true, status: true, assignedTechId: true, nativeNumber: true, freshserviceTicketId: true, subject: true, priority: true },
    });
    if (fresh) this._broadcast(workspaceId, 'tags', fresh);
    const finalTags = await this._ticketTagList(ticketId);
    // Outbound webhooks (gap plan 2 P3): tags_changed doesn't ride the
    // lifecycle pipeline, so dispatch directly.
    if (fresh) {
      import('./webhookDispatchService.js').then(({ dispatchWebhookEvent }) => {
        dispatchWebhookEvent(workspaceId, 'ticket.tags_changed', {
          ticket: {
            id: fresh.id,
            ref: ticketDisplayRef(fresh),
            subject: fresh.subject,
            status: fresh.status,
            priority: fresh.priority,
            origin: fresh.origin,
            tags: finalTags.map((t) => t.name),
          },
          extra: { added: toAdd.map((t) => t.name), removed: removedNames },
        });
      }).catch(() => {});
    }
    return { changed: true, tags: finalTags };
  }

  async _ticketTagList(ticketId) {
    const links = await prisma.ticketTagLink.findMany({
      where: { ticketId },
      select: { tag: { select: { id: true, name: true, color: true } } },
    });
    return links.map((l) => l.tag).sort((a, b) => a.name.localeCompare(b.name));
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
    // Raw RFC-822 headers ('"Name" <addr>') stored as actor names by older
    // syncs count as unresolved too — they render as quoted junk with a
    // wrong avatar (QA 07-08).
    const isRawHeader = (v) => /<[^<>]*@[^<>]*>/.test(String(v || ''));
    // A bare email as the display name is just as unresolved as a raw header —
    // FS often reports third-party repliers (cc'd colleagues on a shared-mailbox
    // ticket) by address only, even when we know the person (QA 07-10, #34136).
    const isBareEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
    const needsName = (e) => {
      const n = String(e.actorName || '').trim();
      return !n || n.toLowerCase() === 'unknown' || isRawHeader(n) || isBareEmail(n);
    };
    // Entries carrying an FS user id get resolved against our technicians even
    // when a name is present — the id is authoritative, and matching it also
    // repairs actorEmail (shared-mailbox sends) so the avatar photo works.
    const toResolve = thread.filter((e) => needsName(e) || e.actorFreshserviceId !== null);
    if (toResolve.length === 0) return thread;

    const fsIds = [...new Set(toResolve.map((e) => e.actorFreshserviceId).filter((v) => v !== null).map((v) => BigInt(v)))];
    const emails = [...new Set(toResolve.filter(needsName).map((e) => String(e.actorEmail || '').toLowerCase()).filter(Boolean))];
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
    // Non-technician participants (cc'd colleagues, third-party repliers) live
    // in the requesters table — resolve them there so a known person never
    // renders as a bare email address.
    const reqByFsId = new Map();
    const reqByEmail = new Map();
    if (fsIds.length || emails.length) {
      const people = await prisma.requester.findMany({
        where: { OR: orClauses },
        select: { freshserviceId: true, email: true, name: true },
      });
      for (const r of people) {
        if (!r.name || isBareEmail(r.name)) continue; // a stored email-as-name helps nobody
        if (r.freshserviceId !== null) reqByFsId.set(String(r.freshserviceId), r);
        if (r.email) reqByEmail.set(r.email.toLowerCase(), r);
      }
    }
    const reqName = requester?.name || null;

    return thread.map((e) => {
      let match = null;
      if (e.actorFreshserviceId !== null) match = byFsId.get(String(e.actorFreshserviceId));
      if (!match && needsName(e) && e.actorEmail && !isRawHeader(e.actorEmail)) {
        match = byEmail.get(String(e.actorEmail).toLowerCase());
      }
      if (match) {
        // Channel ≠ identity: an agent who replies by EMAIL arrives as an
        // FS "incoming" conversation and used to render as the requester
        // (QA 07-08, #232092/Mehdi). The roster match is authoritative —
        // stamp authorType 'agent' so the UI sides the message correctly.
        // Exception: when the matched technician IS the ticket's requester
        // (agents file tickets too), their messages stay requester-side.
        const isTicketRequester = requester?.email && match.email
          && String(match.email).toLowerCase() === String(requester.email).toLowerCase();
        return {
          ...e,
          actorName: match.name,
          actorEmail: match.email || e.actorEmail || null,
          authorType: isTicketRequester ? (e.authorType || 'requester') : 'agent',
        };
      }
      if (!needsName(e)) return e;
      // No technician match, but a raw header still holds a usable display
      // name/address — show that instead of the quoted junk.
      if (isRawHeader(e.actorName)) {
        const raw = String(e.actorName);
        const headerMatch = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
        if (headerMatch) {
          const cleanName = headerMatch[1].trim().replace(/^['"]+|['"]+$/g, '');
          const cleanEmail = headerMatch[2].trim().toLowerCase();
          return {
            ...e,
            actorName: cleanName || cleanEmail,
            actorEmail: (e.actorEmail && !isRawHeader(e.actorEmail)) ? e.actorEmail : cleanEmail,
          };
        }
      }
      // Known non-technician person (requesters table) — by FS contact id,
      // then email. Covers third-party repliers on someone else's ticket.
      let person = null;
      if (e.actorFreshserviceId !== null) person = reqByFsId.get(String(e.actorFreshserviceId));
      if (!person && e.actorEmail && !isRawHeader(e.actorEmail)) {
        person = reqByEmail.get(String(e.actorEmail).toLowerCase());
      }
      if (person) return { ...e, actorName: person.name, actorEmail: e.actorEmail || person.email || null };
      // Ticket-requester fallback — ONLY when the entry isn't attributable to
      // someone else (no email, or the requester's own email). Previously this
      // could stamp the requester's name onto a third party's reply.
      if ((e.incoming === true || e.authorType === 'requester') && reqName
        && (!e.actorEmail || String(e.actorEmail).toLowerCase() === String(requester?.email || '').toLowerCase())) {
        return { ...e, actorName: reqName };
      }
      // TP-authored notes mirrored into FS carry the "[Ticket Pulse]" marker but
      // sync back under the FS service account (not a technician) — label them.
      if (/^\s*\[ticket pulse\]/i.test(String(e.bodyText || e.content || ''))) {
        return { ...e, actorName: 'Ticket Pulse' };
      }
      return e;
    });
  }

  /**
   * Bulk edit by QUERY (gap plan P2.2): apply one action to every ticket
   * matching the current filter — not just the visible page. Two-step:
   * `preview: true` returns the counts for the confirm dialog; the apply call
   * passes `expectedTotal` back so a changed queue can't be edited blind.
   * Capped hard; each ticket goes through the normal audited write paths.
   */
  async bulkByQuery(workspaceId, { query = {}, action, preview = false, expectedTotal = null }, actor) {
    const BULK_CAP = 500;
    const where = await this.buildListWhere(workspaceId, query);

    const matching = await prisma.ticket.findMany({
      where,
      select: { id: true, origin: true, status: true, nativeNumber: true, freshserviceTicketId: true },
      orderBy: { id: 'asc' },
      take: BULK_CAP + 1,
    });
    if (matching.length > BULK_CAP) {
      throw new ValidationError(`This filter matches more than ${BULK_CAP} tickets — narrow it down before bulk-editing`);
    }

    const type = action?.type;
    if (!['assign', 'status', 'add_tags', 'remove_tags', 'set_category'].includes(type)) {
      throw new ValidationError('Bulk action must be assign, status, add_tags, remove_tags, or set_category');
    }
    // Tags are TP-side (both origins); field mutations are TP-born only.
    const TAG_ACTIONS = new Set(['add_tags', 'remove_tags']);
    const editable = TAG_ACTIONS.has(type) ? matching : matching.filter((t) => t.origin === TICKET_ORIGIN.TICKETPULSE);
    const skippedFsBorn = matching.length - editable.length;

    if (preview) {
      return { preview: true, total: matching.length, editable: editable.length, skippedFsBorn };
    }
    if (expectedTotal !== null && Number(expectedTotal) !== matching.length) {
      throw new ValidationError(`The queue changed since you confirmed (${matching.length} now match, you confirmed ${expectedTotal}) — re-run the bulk edit`);
    }

    const failed = [];
    let applied = 0;
    for (const t of editable) {
      try {
        if (type === 'assign') {
          await this.assignTicket(t.id, workspaceId, action.value ? Number(action.value) : null, actor);
        } else if (type === 'status') {
          await this.changeStatus(t.id, workspaceId, String(action.value), actor);
        } else if (type === 'add_tags' || type === 'remove_tags') {
          const current = await prisma.ticketTagLink.findMany({ where: { ticketId: t.id }, select: { tagId: true } });
          const delta = new Set((action.value || []).map(Number));
          const wanted = type === 'add_tags'
            ? [...new Set([...current.map((l) => l.tagId), ...delta])]
            : current.map((l) => l.tagId).filter((id) => !delta.has(id));
          await this.setTags(t.id, workspaceId, wanted, actor);
        } else if (type === 'set_category') {
          await this.updateTicketFields(t.id, workspaceId, {
            internalCategoryId: action.value ? Number(action.value) : null,
          }, actor);
        }
        applied += 1;
      } catch (err) {
        failed.push({ ref: ticketDisplayRef(t), message: err.message });
      }
    }

    await ticketActivityRepository.create({
      ticketId: editable[0]?.id || matching[0]?.id || 0,
      activityType: 'bulk_edit',
      performedBy: actor?.email || 'system',
      details: { type, value: action.value ?? null, total: matching.length, applied, skippedFsBorn, failedCount: failed.length },
    }).catch(() => null);

    return { total: matching.length, applied, skippedFsBorn, failed };
  }

  /** Reference data for the ticket composer / filters. */
  async getMeta(workspaceId) {
    const [workspace, groups, technicians, categories, sourceRows, approvalCategories, tags, categoryGroupLinks, impactUsage] = await Promise.all([
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
      prisma.ticketTag.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, color: true },
        orderBy: { name: 'asc' },
      }),
      prisma.categoryGroupLink.findMany({
        where: { workspaceId },
        select: { categoryId: true, groupId: true },
      }),
      prisma.ticket.count({ where: { workspaceId, OR: [{ impact: { not: null } }, { urgency: { not: null } }] } }),
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
        label: TICKET_SOURCE_LABELS[row.source] || `Source ${row.source}`,
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
      tags,
      // Category↔group affinity (gap plan P2.3): pickers scope the category
      // tree by the ticket's group. Unmapped categories are visible to all.
      categoryGroupLinks: categoryGroupLinks.map((l) => ({ categoryId: l.categoryId, groupId: String(l.groupId) })),
      // Impact/urgency facet only shows once anyone uses the fields (P1.5).
      hasImpactUrgency: impactUsage > 0,
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

    // AI suggestion tier (gap plan 2 P5.2): similar by CONTENT via embeddings.
    // Clearly a suggestion (scored), quietly empty when embeddings are off.
    let similarByContent = [];
    try {
      const { default: ticketEmbeddingService } = await import('./ticketEmbeddingService.js');
      const scored = await ticketEmbeddingService.similarByContent(ticketId, workspaceId, { limit: 6 });
      if (scored.length) {
        const rows = await prisma.ticket.findMany({
          where: {
            id: { in: scored.map((s) => s.ticketId) },
            isNoise: false,
            status: { notIn: ['Deleted', 'Spam'] },
          },
          select,
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        similarByContent = scored
          .filter((s) => byId.has(s.ticketId))
          .slice(0, 4)
          .map((s) => ({ ...toItem(byId.get(s.ticketId)), similarity: Math.round(s.score * 100) / 100 }));
      }
    } catch { /* embeddings unavailable — related tickets still work */ }

    return { sameRequester, sameRequesterCount, nearDuplicates, similarByContent };
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

  async createTicket(workspaceId, input, actor, { sourceChannel = TICKET_SOURCE.AGENT } = {}) {
    const workspace = await this._getWorkspace(workspaceId);
    if (!workspace.nativeTicketingEnabled) {
      throw new ValidationError('Native ticketing is not enabled for this workspace');
    }

    const parsed = createTicketSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
    const data = parsed.data;

    // Resolve type against the workspace's registry: explicit value must be
    // a known (or aliased) type; omitted falls back to the workspace default.
    if (data.ticketType) {
      data.ticketType = await ticketTypeService.normalizeTypeName(workspaceId, data.ticketType);
    } else {
      data.ticketType = (await ticketTypeService.getDefaultType(workspaceId))?.name ?? null;
    }

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
      slaDueDates = await slaPolicyService.dueDatesFor(workspaceId, data.priority, now, { typeName: data.ticketType });
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
        impact: data.impact ?? null,
        urgency: data.urgency ?? null,
        groupId,
        internalGroupId,
        createdAt: now,
        lastRealActivityAt: now,
        isNoise,
        noiseRuleMatched: ruleId,
        // Arrival channel (QA 07-07 #1): Agent for the app UI; email ingest
        // and the public API pass their own channel. The create form can
        // override it (QA 07-10 #7: phone / walk-up / Teams requests logged
        // by staff should record how they actually arrived).
        source: data.source ?? sourceChannel,
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

    // Tags at creation (gap plan 2 P1.3) — validated + audited by setTags.
    if (Array.isArray(data.tagIds) && data.tagIds.length) {
      await this.setTags(ticket.id, workspaceId, data.tagIds, actor).catch((err) => {
        logger.warn(`Create-time tags failed (non-fatal): ${err.message}`);
      });
    }

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

    // Content embedding for similar-ticket suggestions (P5.2, fire-and-forget).
    this._refreshEmbedding(ticket.id, workspaceId);

    logger.info(`Native ticket created: ${ticketDisplayRef(ticket)} (id ${ticket.id}, ws ${workspaceId}) by ${actor?.email || 'unknown'}`);
    return { ...ticket, displayRef: ticketDisplayRef(ticket), triage };
  }

  _refreshEmbedding(ticketId, workspaceId) {
    import('./ticketEmbeddingService.js')
      .then(({ default: svc }) => svc.upsertForTicket(ticketId, workspaceId))
      .catch(() => {});
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

    // Per-workspace type vocabulary (registry): normalize aliases/case; null
    // clears the type (FS allows type-less tickets).
    if (data.ticketType) {
      data.ticketType = await ticketTypeService.normalizeTypeName(workspaceId, data.ticketType);
    }

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
    if (data.impact !== undefined && data.impact !== ticket.impact) {
      patch.impact = data.impact;
      changes.impact = { from: ticket.impact, to: data.impact };
    }
    if (data.urgency !== undefined && data.urgency !== ticket.urgency) {
      patch.urgency = data.urgency;
      changes.urgency = { from: ticket.urgency, to: data.urgency };
    }
    if (data.source !== undefined && data.source !== ticket.source) {
      patch.source = data.source;
      changes.source = { from: ticket.source, to: data.source };
    }
    if (data.internalCategoryId !== undefined && data.internalCategoryId !== ticket.internalCategoryId) {
      patch.internalCategoryId = data.internalCategoryId;
      changes.internalCategoryId = { from: ticket.internalCategoryId, to: data.internalCategoryId };
      if (data.internalSubcategoryId === undefined) {
        patch.internalSubcategoryId = null;
      }
      // Keep the legacy AI-assessment name fields in lockstep — otherwise a
      // cleared category "reappears" in the UI via the tpSkill fallback
      // (QA 07-06 #5: choosing Uncategorized after assessment did nothing).
      if (data.internalCategoryId === null) {
        patch.tpSkill = null;
        patch.tpSubskill = null;
      } else {
        const cat = await prisma.competencyCategory.findUnique({
          where: { id: data.internalCategoryId }, select: { name: true },
        });
        if (cat) patch.tpSkill = cat.name;
      }
    }
    if (data.internalSubcategoryId !== undefined && data.internalSubcategoryId !== ticket.internalSubcategoryId) {
      patch.internalSubcategoryId = data.internalSubcategoryId;
      changes.internalSubcategoryId = { from: ticket.internalSubcategoryId, to: data.internalSubcategoryId };
      if (data.internalSubcategoryId === null) {
        patch.tpSubskill = null;
      } else {
        const sub = await prisma.competencyCategory.findUnique({
          where: { id: data.internalSubcategoryId }, select: { name: true },
        });
        if (sub) patch.tpSubskill = sub.name;
      }
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
    // Subject/description changed → the content embedding is stale (P5.2).
    if (changes.subject || changes.description) this._refreshEmbedding(ticket.id, workspaceId);
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
    // Interactive client: high limiter priority + bounded queue wait. The
    // mirror's 'low'-priority client put user write-backs behind entire sync
    // sweeps — the multi-minute hangs QA saw as "network error" after 4 min.
    const client = await mirrorService.getInteractiveClient(workspaceId);
    if (!client) throw new ValidationError('FreshService is not configured for this workspace');

    const { getStatusId, getStatusString } = await import('../integrations/freshserviceTransformer.js');

    const fsPayload = {};
    const localPatch = {};
    const changes = {};

    if (input.status !== undefined) {
      if (!NATIVE_TICKET_STATUSES.includes(input.status)) {
        throw new ValidationError(`Status must be one of: ${NATIVE_TICKET_STATUSES.join(', ')}`);
      }
      // Idempotency: re-applying the current status is a no-op, not another FS
      // write. (QA 231648: a timed-out-then-retried resolve wrote to FS twice,
      // and each FS transition emailed the requester.)
      if (input.status !== ticket.status) {
        fsPayload.status = getStatusId(input.status);
        localPatch.status = input.status;
        changes.status = { from: ticket.status, to: input.status };
      }
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
      try {
        fsPayload.custom_fields = await freshServiceActionService._resolveTicketPulseLookupFields(client, {
          localFields: { tpSkill: cat?.name || null, tpSubskill: sub?.name || null },
          customFields: {
            [fsConfig.tpSkillCustomField]: cat?.name || null,
            [fsConfig.tpSubskillCustomField]: sub?.name || null,
          },
        }, fsConfig);
      } catch (err) {
        if (isFsQueueTimeout(err)) throw new ServiceBusyError(FS_BUSY_MESSAGE);
        throw err;
      }
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

    if (Object.keys(fsPayload).length === 0) {
      // Everything requested already matches (e.g. a retried status change) —
      // succeed as a no-op instead of erroring or re-writing FS.
      return { ...ticket, displayRef: ticketDisplayRef(ticket), synced: [], noChanges: true };
    }

    // 1) Write to FreshService — any failure aborts before local changes.
    //    Slow write-backs are logged: the custom-field lookup resolution can
    //    take multiple FS calls on the rate-limited client (QA 231648).
    const fsWriteStartedAt = Date.now();
    let fsTicket;
    try {
      fsTicket = await client.updateTicketFields(Number(ticket.freshserviceTicketId), fsPayload);
    } catch (err) {
      // Queue-wait timeout = the PUT never launched; nothing changed anywhere.
      if (isFsQueueTimeout(err)) throw new ServiceBusyError(FS_BUSY_MESSAGE);
      const fieldErrors = Array.isArray(err.freshserviceDetail?.errors) ? err.freshserviceDetail.errors : [];
      // FreshService closure rules can demand a department the ticket never
      // got (QA 07-10, #231072: closing failed with an opaque "Validation
      // failed"). Auto-fill it from the ticket/requester — what the FS UI
      // would default to — and retry once.
      if (fieldErrors.some((fe) => fe.field === 'department_id')) {
        let departmentId = null;
        try {
          const fsCurrent = await client.getTicket(Number(ticket.freshserviceTicketId));
          departmentId = fsCurrent?.department_id || null;
          if (!departmentId && fsCurrent?.requester_id) {
            const fsRequester = await client.fetchRequester(fsCurrent.requester_id);
            departmentId = fsRequester?.department_ids?.[0] || null;
          }
        } catch { /* fall through to the descriptive error below */ }
        if (departmentId) {
          try {
            fsTicket = await client.updateTicketFields(
              Number(ticket.freshserviceTicketId),
              { ...fsPayload, department_id: Number(departmentId) },
            );
            logger.info(`FS write-back: auto-filled required department ${departmentId} for #${ticket.freshserviceTicketId} (requester's department)`);
          } catch (retryErr) {
            throw fsValidationError(retryErr);
          }
        } else {
          throw new ValidationError('FreshService requires a Department before this change, and neither the ticket nor its requester has one on file — set the Department in FreshService first, then try again.');
        }
      } else {
        throw fsValidationError(err);
      }
    }
    const fsWriteMs = Date.now() - fsWriteStartedAt;
    if (fsWriteMs > 10000) {
      logger.warn(`Slow FS write-back for #${ticket.freshserviceTicketId}: ${Math.round(fsWriteMs / 1000)}s (${Object.keys(fsPayload).join(', ')})`, client.limiter?.getStats?.());
    }

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
   * On-open thread refresh for FS-born tickets: the preheat only covers
   * today's cohort, so requester replies on older FS tickets never reached
   * the cached thread (QA 07-06 #4). Reuses the preheat's idempotent
   * transform + bulkUpsert; broadcasts when anything new arrives.
   */
  async _refreshFsBornThread(ticket) {
    if (!ticket.freshserviceTicketId) return;
    // Interactive client: the reader is on the page waiting for the thread.
    // If the queue is congested the 15s budget makes this refresh a silent
    // skip (caller swallows the rejection) rather than minutes-late data.
    const client = await mirrorService.getInteractiveClient(ticket.workspaceId);
    if (!client) return;
    const fsTicketId = Number(ticket.freshserviceTicketId);
    // Ticket detail carries the ticket-level attachments (email files land on
    // the ticket, not a conversation) — the list sync never sees them (QA
    // 07-08: FS #232127 had a PDF while TP showed "Attachments (0)").
    const [conversations, detail] = await Promise.all([
      client.fetchTicketConversations(fsTicketId, { maxEntries: 60 }),
      client.getTicket(fsTicketId).catch(() => null),
    ]);
    let upserted = 0;
    if (conversations?.length) {
      const { transformTicketConversationEntries } = await import('../integrations/freshserviceTransformer.js');
      const entries = transformTicketConversationEntries(conversations, {
        ticketId: ticket.id,
        workspaceId: ticket.workspaceId,
      });
      if (entries.length) ({ upserted } = await ticketThreadRepository.bulkUpsert(entries));
    }
    let ingested = 0;
    try {
      const fsTicket = detail?.ticket || detail;
      ingested = await attachmentService.ingestForFsTicket(ticket, { fsTicket, conversations });
    } catch (err) {
      logger.warn(`FS attachment ingest on open failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
    }
    if (upserted > 0 || ingested > 0) {
      this._broadcast(ticket.workspaceId, 'reply', ticket, { refreshedFromFs: upserted, attachmentsIngested: ingested });
    }
  }

  // Time tracking was retired on request (QA 07-07 #7). The nullable
  // time_spent/billable columns stay in the schema — dropping them is a
  // destructive migration with no user-visible upside; old entries remain
  // readable in the audit trail.

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
      const client = await mirrorService.getInteractiveClient(workspaceId);
      if (!client) throw new ValidationError('FreshService is not configured for this workspace');
      const fsId = Number(ticket.freshserviceTicketId);
      const html = bodyHtml || `<p>${(bodyText || '').replace(/\n/g, '<br/>')}</p>`;
      let result;
      try {
        result = isPrivate
          ? await client.addNote(fsId, html, { isPrivate: true, attachments: fsAttachments })
          : await client.createReply(fsId, html, { ccEmails: cc, attachments: fsAttachments });
      } catch (err) {
        // Queue-wait timeout: the send never launched — safe to retry, and the
        // composer keeps the draft, so tell the user plainly.
        if (isFsQueueTimeout(err)) throw new ServiceBusyError(FS_BUSY_MESSAGE);
        throw err;
      }
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
