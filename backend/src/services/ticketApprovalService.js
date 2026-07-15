import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sseManager } from '../routes/sse.routes.js';

const APPROVAL_EXPIRY_DAYS = 30;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicBaseUrl() {
  const configured = process.env.PUBLIC_APP_URL
    || process.env.FRONTEND_PUBLIC_URL
    || process.env.FRONTEND_URL
    || process.env.APP_URL
    || process.env.CORS_ORIGIN?.split(',')?.[0]
    || 'http://localhost:5173';
  return String(configured).trim().replace(/\/+$/, '');
}

// Conservative allowlist for approval notes (gap plan P2.4) — inline text
// formatting + lists + links only; matches what the composer can produce.
function sanitizeNoteHtml(html) {
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'span', 'div'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noreferrer' }) },
  }).trim();
  return clean || null;
}

async function emitApprovalEvent(eventType, ticketId, extra) {
  try {
    const { default: lifecycle } = await import('./ticketLifecycleNotificationService.js');
    await lifecycle.emitTicketEvent(eventType, ticketId, {
      source: 'ticketpulse_native',
      dedupeStamp: `${eventType}:${extra.approvalId}:${extra.status || 'requested'}`,
      extra,
    });
  } catch (err) {
    logger.warn(`Approval workflow event dispatch failed (non-fatal): ${err.message}`);
  }
}

/**
 * Single-step ticket approvals. The approver decides in-app or via a magic
 * link (hash-validated, expiring). Decisions land in the audit trail, mirror
 * to the FS fallback copy as a private note, and fire workflow events.
 */
class TicketApprovalService {
  async listForTicket(ticketId, workspaceId) {
    return prisma.ticketApproval.findMany({
      where: { ticketId, workspaceId },
      orderBy: { id: 'desc' },
      select: {
        id: true, status: true, approverEmail: true, approverName: true,
        requestedBy: true, requestNote: true, requestNoteHtml: true, decisionNote: true, decisionNoteHtml: true,
        decidedAt: true, decidedVia: true, expiresAt: true, createdAt: true,
      },
    });
  }

  /**
   * Request approval against a category. Fans out one approval row per manager
   * (sharing requestGroupId) — any one can approve. Each manager gets a personal
   * magic link. TP-only (no FreshService involvement).
   */
  async request(ticketId, workspaceId, { approvalCategoryId, note = null, noteHtml = null, notifyApprover = true }, actor) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { requester: { select: { name: true, email: true } } },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const category = await prisma.approvalCategory.findFirst({
      where: { id: Number(approvalCategoryId), workspaceId, isActive: true },
    });
    if (!category) throw new ValidationError('Pick an active approval category');
    const managers = [...new Set((category.managerEmails || [])
      .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
    if (managers.length === 0) {
      throw new ValidationError(`"${category.name}" has no approval managers configured — add them in Settings`);
    }

    // Don't stack a second open request for the same category on this ticket.
    const open = await prisma.ticketApproval.findFirst({
      where: { ticketId, workspaceId, approvalCategoryId: category.id, status: { in: ['pending', 'info_requested'] } },
      select: { id: true },
    });
    if (open) throw new ValidationError(`There is already an open "${category.name}" approval on this ticket`);

    const requestGroupId = crypto.randomUUID();
    const created = [];
    for (const email of managers) {
      const token = newToken();
      const approval = await prisma.ticketApproval.create({
        data: {
          workspaceId,
          ticketId,
          approvalCategoryId: category.id,
          requestGroupId,
          approverEmail: email,
          requestedBy: actor?.email || 'unknown',
          requestNote: note?.trim() || null,
          requestNoteHtml: noteHtml ? sanitizeNoteHtml(noteHtml) : null,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      if (notifyApprover !== false) {
        const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
        await this._emailApprover(ticket, approval, decisionUrl, category.name);
      }
      created.push({ id: approval.id, approverEmail: email });
    }

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_requested',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { requestGroupId, category: category.name, approvers: managers, note: note || null, notified: notifyApprover !== false },
    }).catch(() => {});

    await emitApprovalEvent('approval.requested', ticketId, {
      approvalId: requestGroupId, approverEmail: managers.join(', '), requestedBy: actor?.email || 'unknown',
    });
    this._broadcast(ticket, 'approval');

    logger.info(`Approval requested on ${ticketDisplayRef(ticket)} · ${category.name} → ${managers.join(', ')}`);
    return {
      requestGroupId,
      category: { id: category.id, name: category.name },
      approvals: created,
      count: created.length,
    };
  }

  /** Public magic-link read: enough context for the decision page, no auth. */
  async getByToken(token) {
    const approval = await this._findByToken(token);
    const ticket = await prisma.ticket.findUnique({
      where: { id: approval.ticketId },
      select: {
        id: true, subject: true, status: true, priority: true, origin: true,
        nativeNumber: true, freshserviceTicketId: true, createdAt: true,
        descriptionText: true,
        requester: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    return {
      approval: {
        id: approval.id,
        status: approval.status,
        approverEmail: approval.approverEmail,
        requestedBy: approval.requestedBy,
        requestNote: approval.requestNote,
        requestNoteHtml: approval.requestNoteHtml || null,
        decidedAt: approval.decidedAt,
        expiresAt: approval.expiresAt,
      },
      ticket: ticket ? {
        displayRef: ticketDisplayRef(ticket),
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt,
        requesterName: ticket.requester?.name || null,
        workspaceName: ticket.workspace?.name || null,
        summary: (ticket.descriptionText || '').slice(0, 500) || null,
      } : null,
    };
  }

  async decideByToken(token, decision, note = null, noteHtml = null) {
    const approval = await this._findByToken(token);
    // The approver can also bounce it back for more info from the magic link.
    if (String(decision || '').toLowerCase() === 'clarify') {
      return this.requestClarification(approval.ticketId, approval.workspaceId, approval.id, note, {
        email: approval.approverEmail, name: approval.approverName, via: 'link',
      });
    }
    return this._decide(approval, decision, note, {
      via: 'link',
      actorLabel: approval.approverName || approval.approverEmail,
      noteHtml,
    });
  }

  async decideInApp(ticketId, workspaceId, approvalId, decision, note, actor, noteHtml = null) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    const isApprover = actor?.email && approval.approverEmail === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isApprover && !isAdmin) {
      throw new ValidationError('Only the requested approver (or an admin) can decide this approval');
    }
    return this._decide(approval, decision, note, {
      via: 'app',
      actorLabel: actor?.name || actor?.email || 'Ticket Pulse user',
      noteHtml,
    });
  }

  /**
   * Approver bounces the request back to the requester for more info. Non-terminal
   * (status → info_requested); does NOT cancel sibling approvals — another manager
   * can still approve. Notifies the requester (the member who asked).
   */
  async requestClarification(ticketId, workspaceId, approvalId, note, actor) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    const isApprover = actor?.email && approval.approverEmail === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isApprover && !isAdmin) {
      throw new ValidationError('Only the requested approver (or an admin) can request clarification');
    }
    if (approval.status !== 'pending') {
      throw new ValidationError(`This approval is ${approval.status}, not pending`);
    }
    const question = String(note || '').trim();
    if (!question) throw new ValidationError('Add a note describing what clarification is needed');

    const actorLabel = actor?.name || actor?.email || approval.approverName || approval.approverEmail;
    const priorLog = Array.isArray(approval.clarificationLog) ? approval.clarificationLog : [];
    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: 'info_requested',
        decisionNote: question,
        approverName: approval.approverName || actorLabel,
        clarificationLog: [...priorLog, { question, askedBy: approval.approverEmail, askedAt: new Date().toISOString() }],
      },
    });

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { requester: { select: { name: true } } },
    });

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_clarification_requested',
      performedBy: actorLabel,
      performedAt: new Date(),
      details: { approvalId: approval.id, requestedBy: approval.requestedBy, note: question },
    }).catch(() => {});

    if (ticket) {
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: ticket.workspaceId,
          source: 'ticketpulse_user',
          eventType: 'note',
          actorName: actorLabel,
          actorEmail: approval.approverEmail,
          authorType: 'system',
          incoming: false,
          isPrivate: true,
          visibility: 'private',
          bodyText: `Clarification requested by ${actorLabel} — "${question}"`,
          content: `Clarification requested by ${actorLabel} — "${question}"`,
          occurredAt: new Date(),
          mirrorState: null,
        },
      }).catch((err) => logger.warn(`Clarification note write failed (non-fatal): ${err.message}`));

      await this._emailRequesterClarification(ticket, approval, question);
      await emitApprovalEvent('approval.clarification_requested', ticket.id, {
        approvalId: approval.id, approverEmail: approval.approverEmail, requestedBy: approval.requestedBy,
      });
      this._broadcast(ticket, 'approval');
    }

    logger.info(`Approval clarification requested on ticket ${ticketId} by ${actorLabel} → ${approval.requestedBy}`);
    return updated;
  }

  /**
   * Requester provides more info and re-submits — flips info_requested back to
   * pending with a fresh magic link and re-notifies the approver. The reply
   * (QA 07-14 #1) is kept on the approval's clarificationLog so the Q&A
   * survives the resubmit, and travels in the approver's email.
   */
  async resubmit(ticketId, workspaceId, approvalId, actor, { note = null } = {}) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    const isRequester = actor?.email && approval.requestedBy === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isRequester && !isAdmin) {
      throw new ValidationError('Only the requester (or an admin) can resubmit this approval');
    }
    if (approval.status !== 'info_requested') {
      throw new ValidationError('This approval is not awaiting more info');
    }

    const answer = String(note || '').trim().slice(0, 4000) || null;
    const question = approval.decisionNote || null;
    const log = Array.isArray(approval.clarificationLog) ? [...approval.clarificationLog] : [];
    if (answer) {
      const answeredAt = new Date().toISOString();
      const answeredBy = actor?.email || approval.requestedBy;
      const last = log.length > 0 ? log[log.length - 1] : null;
      if (last && !last.answer) {
        log[log.length - 1] = { ...last, answer, answeredAt, answeredBy };
      } else {
        // Legacy rows asked before the log existed — reconstruct from decisionNote.
        log.push({ question, askedBy: approval.approverEmail, answer, answeredAt, answeredBy });
      }
    }

    const token = newToken();
    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: 'pending',
        decisionNote: null,
        clarificationLog: log,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { requester: { select: { name: true, email: true } } },
    });
    let categoryName = null;
    if (approval.approvalCategoryId) {
      const cat = await prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId }, select: { name: true } });
      categoryName = cat?.name || null;
    }

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_resubmitted',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { approvalId: approval.id, approverEmail: approval.approverEmail, note: answer },
    }).catch(() => {});

    if (ticket) {
      if (answer) {
        const actorLabel = actor?.name || actor?.email || approval.requestedBy;
        await prisma.ticketThreadEntry.create({
          data: {
            ticketId: ticket.id,
            workspaceId: ticket.workspaceId,
            source: 'ticketpulse_user',
            eventType: 'note',
            actorName: actorLabel,
            actorEmail: actor?.email || approval.requestedBy,
            authorType: 'system',
            incoming: false,
            isPrivate: true,
            visibility: 'private',
            bodyText: `Clarification reply from ${actorLabel}${question ? ` (asked: "${question}")` : ''} — "${answer}"`,
            content: `Clarification reply from ${actorLabel}${question ? ` (asked: "${question}")` : ''} — "${answer}"`,
            occurredAt: new Date(),
            mirrorState: null,
          },
        }).catch((err) => logger.warn(`Clarification reply note write failed (non-fatal): ${err.message}`));
      }
      const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
      // approval has the unchanged email fields (approverEmail/requestNote/requestedBy).
      await this._emailApprover(ticket, approval, decisionUrl, categoryName, { question, answer });
      await emitApprovalEvent('approval.requested', ticket.id, {
        approvalId: approval.id, approverEmail: approval.approverEmail, requestedBy: approval.requestedBy,
      });
      this._broadcast(ticket, 'approval');
    }

    logger.info(`Approval resubmitted on ticket ${ticketId} → ${approval.approverEmail}`);
    return updated;
  }

  // ---------------------------------------------------------------- inbox
  // Cross-ticket lists for the Approvals page. Scoped to the actor's email.

  async inboxFor(workspaceId, actor) {
    const email = String(actor?.email || '').toLowerCase();
    if (!email) return [];
    const rows = await prisma.ticketApproval.findMany({
      where: { workspaceId, status: 'pending', approverEmail: email },
      orderBy: { createdAt: 'asc' },
      include: {
        approvalCategory: { select: { name: true } },
        ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true } } } },
      },
    });
    return rows.map((a) => this._inboxRow(a));
  }

  async inboxCountFor(workspaceId, actor) {
    const email = String(actor?.email || '').toLowerCase();
    if (!email) return 0;
    return prisma.ticketApproval.count({ where: { workspaceId, status: 'pending', approverEmail: email } });
  }

  async needsMyInfo(workspaceId, actor) {
    const email = String(actor?.email || '').toLowerCase();
    if (!email) return [];
    const rows = await prisma.ticketApproval.findMany({
      where: { workspaceId, status: 'info_requested', requestedBy: email },
      orderBy: { updatedAt: 'desc' },
      include: {
        approvalCategory: { select: { name: true } },
        ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true } } } },
      },
    });
    return rows.map((a) => this._inboxRow(a));
  }

  _inboxRow(a) {
    return {
      id: a.id,
      status: a.status,
      ticketId: a.ticketId,
      displayRef: ticketDisplayRef(a.ticket),
      subject: a.ticket?.subject || null,
      requesterName: a.ticket?.requester?.name || null,
      categoryName: a.approvalCategory?.name || null,
      approverEmail: a.approverEmail,
      approverName: a.approverName,
      requestedBy: a.requestedBy,
      requestNote: a.requestNote,
      decisionNote: a.decisionNote,
      decidedAt: a.decidedAt,
      decidedVia: a.decidedVia,
      createdAt: a.createdAt,
    };
  }

  /**
   * Admin/reviewer overview of ALL approvals in the workspace: status stats +
   * a filterable list/history. Read-only reporting.
   */
  async overview(workspaceId, { status = null, categoryId = null, limit = 200 } = {}) {
    const where = { workspaceId };
    if (status) where.status = status;
    if (categoryId) where.approvalCategoryId = Number(categoryId);
    const [items, grouped] = await Promise.all([
      prisma.ticketApproval.findMany({
        where,
        orderBy: { id: 'desc' },
        take: Math.min(Number(limit) || 200, 500),
        include: {
          approvalCategory: { select: { name: true } },
          ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true } } } },
        },
      }),
      prisma.ticketApproval.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
    ]);
    const stats = { pending: 0, info_requested: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const g of grouped) stats[g.status] = g._count._all;
    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
    return { stats, items: items.map((a) => this._inboxRow(a)) };
  }

  /**
   * Requester (or admin) cancels an open request they made by mistake. Cancels
   * the WHOLE group (every open sibling) and keeps the rows as an audit record
   * (status → cancelled). Use `deleteRequest` to remove it entirely instead.
   */
  async cancel(ticketId, workspaceId, approvalId, actor) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    if (!['pending', 'info_requested'].includes(approval.status)) {
      throw new ValidationError(`This approval is ${approval.status} and can no longer be cancelled`);
    }
    const isRequester = actor?.email && approval.requestedBy === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isRequester && !isAdmin) {
      throw new ValidationError('Only the requester (or an admin) can cancel this approval');
    }

    const cancelWhere = approval.requestGroupId
      ? { requestGroupId: approval.requestGroupId, workspaceId, status: { in: ['pending', 'info_requested'] } }
      : { id: approval.id };
    await prisma.ticketApproval.updateMany({
      where: cancelWhere,
      data: { status: 'cancelled', decidedAt: new Date(), decidedVia: 'app', decisionNote: `Cancelled by ${actor?.email || 'unknown'}` },
    });

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_cancelled',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { approvalId: approval.id, requestGroupId: approval.requestGroupId || null },
    }).catch(() => {});

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
    });
    if (ticket) this._broadcast(ticket, 'approval');
    return { cancelled: true, requestGroupId: approval.requestGroupId || null };
  }

  /**
   * Requester (or admin) DELETES a request entirely — removes every row in the
   * group. Unlike cancel, no audit record of the approval remains (the caller
   * is warned in the UI that the approval status will be lost).
   */
  async deleteRequest(ticketId, workspaceId, approvalId, actor) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    const isRequester = actor?.email && approval.requestedBy === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isRequester && !isAdmin) {
      throw new ValidationError('Only the requester (or an admin) can delete this approval request');
    }

    const deleteWhere = approval.requestGroupId
      ? { requestGroupId: approval.requestGroupId, workspaceId }
      : { id: approval.id };
    const { count } = await prisma.ticketApproval.deleteMany({ where: deleteWhere });

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_deleted',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { approvalId: approval.id, requestGroupId: approval.requestGroupId || null, removed: count },
    }).catch(() => {});

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
    });
    if (ticket) this._broadcast(ticket, 'approval');
    logger.info(`Approval request deleted on ticket ${ticketId} by ${actor?.email || 'unknown'} (${count} row${count === 1 ? '' : 's'})`);
    return { deleted: true, count, requestGroupId: approval.requestGroupId || null };
  }

  /**
   * Approver (or admin) flips an already-decided approval (approved ↔ rejected)
   * — e.g. they clicked the wrong button or reconsidered. Reuses the decide
   * path with re-decide allowed.
   */
  async changeDecision(ticketId, workspaceId, approvalId, decision, note, actor) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    if (!['approved', 'rejected'].includes(approval.status)) {
      throw new ValidationError('Only a decided approval (approved or rejected) can be changed');
    }
    const isApprover = actor?.email && approval.approverEmail === actor.email.toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isApprover && !isAdmin) {
      throw new ValidationError('Only the deciding approver (or an admin) can change this decision');
    }
    return this._decide(approval, decision, note, {
      via: 'app',
      actorLabel: actor?.name || actor?.email || approval.approverName || approval.approverEmail,
      changedFrom: approval.status,
    });
  }

  // ------------------------------------------------------------- internals

  async _findByToken(token) {
    if (!token || String(token).length < 20) throw new ValidationError('Invalid approval link');
    const approval = await prisma.ticketApproval.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!approval) throw new NotFoundError('This approval link is not valid');
    if (approval.expiresAt && approval.expiresAt < new Date() && approval.status === 'pending') {
      throw new ValidationError('This approval link has expired — ask for a new request');
    }
    return approval;
  }

  async _decide(approval, decision, note, { via, actorLabel, changedFrom = null, noteHtml = null }) {
    const normalized = String(decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(normalized)) {
      throw new ValidationError('Decision must be "approved" or "rejected"');
    }
    // A fresh decision must be on an open row; a change flips an already-decided
    // one (changedFrom carries the prior status so guarding happened upstream).
    if (!changedFrom && !['pending', 'info_requested'].includes(approval.status)) {
      throw new ValidationError(`This approval was already ${approval.status}`);
    }
    if (changedFrom && changedFrom === normalized) {
      throw new ValidationError(`This approval is already ${normalized}`);
    }

    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: normalized,
        decidedAt: new Date(),
        decidedVia: via,
        decisionNote: note?.trim() || null,
        decisionNoteHtml: noteHtml ? sanitizeNoteHtml(noteHtml) : null,
        approverName: approval.approverName || actorLabel,
      },
    });

    // Any-one-approves: the first decision supersedes the sibling requests
    // created from the same request (same category, one row per manager).
    if (approval.requestGroupId) {
      await prisma.ticketApproval.updateMany({
        where: {
          requestGroupId: approval.requestGroupId,
          status: { in: ['pending', 'info_requested'] },
          id: { not: approval.id },
        },
        data: {
          status: 'cancelled',
          decidedAt: new Date(),
          decidedVia: via,
          decisionNote: `Superseded — ${normalized} by ${actorLabel}`,
        },
      });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: approval.ticketId },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true },
    });

    await ticketActivityRepository.create({
      ticketId: approval.ticketId,
      activityType: changedFrom ? 'approval_decision_changed' : `approval_${normalized}`,
      performedBy: actorLabel,
      performedAt: new Date(),
      details: { approvalId: approval.id, via, note: note || null, ...(changedFrom ? { changedFrom, to: normalized } : {}) },
    }).catch(() => {});

    // Audit trail on the conversation only. Approvals are TP-only, so the note
    // is NEVER mirrored to the FreshService fallback copy (mirrorState: null).
    if (ticket) {
      const verdict = normalized === 'approved' ? 'APPROVED ✔' : 'REJECTED ✘';
      const noteBody = changedFrom
        ? `Approval CHANGED to ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`
        : `Approval ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`;
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: ticket.workspaceId,
          source: 'ticketpulse_user',
          eventType: 'note',
          actorName: actorLabel,
          actorEmail: approval.approverEmail,
          authorType: 'system',
          incoming: false,
          isPrivate: true,
          visibility: 'private',
          bodyText: noteBody,
          content: noteBody,
          occurredAt: new Date(),
          mirrorState: null,
        },
      }).catch((err) => logger.warn(`Approval note write failed (non-fatal): ${err.message}`));

      await emitApprovalEvent('approval.decided', ticket.id, {
        approvalId: approval.id, status: normalized, approverEmail: approval.approverEmail,
      });
      this._broadcast(ticket, 'approval');
    }

    logger.info(`Approval ${normalized} (${via}) on ticket ${approval.ticketId} by ${actorLabel}`);
    return updated;
  }

  async _emailApprover(ticket, approval, decisionUrl, categoryName = null, clarification = null) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.approverEmail}`);
      return { sent: false, reason: 'suppressed' };
    }
    const ref = ticketDisplayRef(ticket);
    const subject = `${categoryName ? `${categoryName} approval` : 'Approval'} requested: ${ticket.subject || 'ticket'} [${ref}]`;

    // T3.9: the request note supports placeholders. Plain values substitute
    // before escaping; {{decision.url}} becomes a real link after escaping.
    // Rich notes (P2.4) arrive pre-sanitized — substitute placeholders directly.
    let noteHtml = '';
    const substitutePlain = (s) => String(s)
      .replace(/\{\{\s*approver\.name\s*\}\}/gi, approval.approverName || approval.approverEmail.split('@')[0])
      .replace(/\{\{\s*ticket\.subject\s*\}\}/gi, ticket.subject || '')
      .replace(/\{\{\s*ticket\.ref\s*\}\}/gi, ref)
      .replace(/\{\{\s*requester\.name\s*\}\}/gi, ticket.requester?.name || 'the requester');
    if (approval.requestNoteHtml) {
      noteHtml = substitutePlain(approval.requestNoteHtml)
        .replace(/\{\{\s*decision\.url\s*\}\}/gi, `<a href="${decisionUrl}">review &amp; decide</a>`);
    } else if (approval.requestNote) {
      noteHtml = substitutePlain(approval.requestNote)
        .replace(/</g, '&lt;')
        .replace(/\{\{\s*decision\.url\s*\}\}/gi, `<a href="${decisionUrl}">review &amp; decide</a>`)
        .replace(/\n/g, '<br/>');
    }

    const escHtml = (s) => String(s || '').replace(/</g, '&lt;');
    const clarificationHtml = clarification?.answer
      ? `<div style="border-left:3px solid #8b5cf6;padding:6px 10px;margin:8px 0;background:#f5f3ff">${
        clarification.question ? `<p style="margin:0 0 4px">You asked: “${escHtml(clarification.question)}”</p>` : ''
      }<p style="margin:0">Reply from ${escHtml(approval.requestedBy)}: “${escHtml(clarification.answer)}”</p></div>`
      : '';
    const html = [
      clarification?.answer
        ? `<p>Your approval was re-requested on ticket <b>${ref}</b> with the clarification you asked for.</p>`
        : `<p>Your approval was requested on ticket <b>${ref}</b>${ticket.requester?.name ? ` (requested for ${ticket.requester.name})` : ''}.</p>`,
      `<p><b>${(ticket.subject || '').replace(/</g, '&lt;')}</b></p>`,
      clarificationHtml,
      noteHtml ? `<p>Note from ${approval.requestedBy}: ${noteHtml}</p>` : '',
      `<p><a href="${decisionUrl}">Review and decide</a> (approve or reject with an optional note).</p>`,
      '<p style="color:#64748b;font-size:12px">This link is personal to you and expires in 30 days.</p>',
    ].join('');

    try {
      const connection = await prisma.mailboxConnection.findFirst({
        where: { workspaceId: ticket.workspaceId, isEnabled: true, mode: { in: ['send', 'both'] } },
        orderBy: { id: 'asc' },
      });
      if (connection) {
        const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
        if (graphMailClient.isConfigured()) {
          await graphMailClient.sendMailAsMailbox(connection.address, {
            to: [approval.approverEmail], subject, html,
          });
          return { sent: true, via: 'msgraph' };
        }
      }
      const { default: sendgrid } = await import('./sendgridNotificationService.js');
      await sendgrid.sendEmail({ to: [approval.approverEmail], subject, html });
      return { sent: true, via: 'sendgrid' };
    } catch (err) {
      logger.warn(`Approval email failed for approval ${approval.id} (non-fatal): ${err.message}`);
      return { sent: false, error: err.message };
    }
  }

  /** Notify the requester that an approver needs more info before deciding. */
  async _emailRequesterClarification(ticket, approval, question) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] clarification email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.requestedBy}`);
      return { sent: false, reason: 'suppressed' };
    }
    const to = String(approval.requestedBy || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { sent: false, reason: 'no_requester_email' };
    const ref = ticketDisplayRef(ticket);
    const ticketUrl = `${publicBaseUrl()}/tickets/${ticket.id}`;
    const subject = `More info needed on your approval request [${ref}]`;
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const html = [
      `<p>${esc(approval.approverName || approval.approverEmail)} needs more information before deciding your approval request on ticket <b>${ref}</b>.</p>`,
      `<p><b>${esc(ticket.subject || '')}</b></p>`,
      `<p>Their question: “${esc(question)}”</p>`,
      `<p>Add the requested details on the ticket, then <a href="${ticketUrl}">open it</a> and hit <b>Resubmit</b> to send it back for approval.</p>`,
    ].join('');
    try {
      const connection = await prisma.mailboxConnection.findFirst({
        where: { workspaceId: ticket.workspaceId, isEnabled: true, mode: { in: ['send', 'both'] } },
        orderBy: { id: 'asc' },
      });
      if (connection) {
        const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
        if (graphMailClient.isConfigured()) {
          await graphMailClient.sendMailAsMailbox(connection.address, { to: [to], subject, html });
          return { sent: true, via: 'msgraph' };
        }
      }
      const { default: sendgrid } = await import('./sendgridNotificationService.js');
      await sendgrid.sendEmail({ to: [to], subject, html });
      return { sent: true, via: 'sendgrid' };
    } catch (err) {
      logger.warn(`Clarification email failed for approval ${approval.id} (non-fatal): ${err.message}`);
      return { sent: false, error: err.message };
    }
  }

  _broadcast(ticket, action) {
    try {
      sseManager.broadcast('ticket-change', {
        action,
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        origin: ticket.origin,
        displayRef: ticketDisplayRef(ticket),
      }, ticket.workspaceId);
    } catch { /* non-fatal */ }
  }
}

export default new TicketApprovalService();
