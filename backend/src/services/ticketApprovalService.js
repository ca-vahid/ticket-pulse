import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import mirrorService from './mirrorService.js';
import { ticketDisplayRef, TICKET_ORIGIN } from '../utils/ticketOrigin.js';
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
        requestedBy: true, requestNote: true, decisionNote: true,
        decidedAt: true, decidedVia: true, expiresAt: true, createdAt: true,
      },
    });
  }

  async request(ticketId, workspaceId, { approverEmail, note = null }, actor) {
    const email = String(approverEmail || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ValidationError('A valid approver email is required');
    }
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { requester: { select: { name: true, email: true } } },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

    const open = await prisma.ticketApproval.findFirst({
      where: { ticketId, workspaceId, status: 'pending', approverEmail: email },
      select: { id: true },
    });
    if (open) throw new ValidationError('There is already a pending approval for that approver on this ticket');

    const token = newToken();
    const approval = await prisma.ticketApproval.create({
      data: {
        workspaceId,
        ticketId,
        approverEmail: email,
        requestedBy: actor?.email || 'unknown',
        requestNote: note?.trim() || null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_requested',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { approvalId: approval.id, approverEmail: email, note: note || null },
    }).catch(() => {});

    const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
    const emailResult = await this._emailApprover(ticket, approval, decisionUrl);
    await emitApprovalEvent('approval.requested', ticketId, {
      approvalId: approval.id, approverEmail: email, requestedBy: approval.requestedBy,
    });
    this._broadcast(ticket, 'approval');

    logger.info(`Approval requested on ${ticketDisplayRef(ticket)} → ${email}`);
    // decisionUrl is returned so the requester can hand the link over directly
    // (e.g. chat) if the email doesn't land.
    return { approval, email: emailResult, decisionUrl };
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

  async decideByToken(token, decision, note = null) {
    const approval = await this._findByToken(token);
    return this._decide(approval, decision, note, {
      via: 'link',
      actorLabel: approval.approverName || approval.approverEmail,
    });
  }

  async decideInApp(ticketId, workspaceId, approvalId, decision, note, actor) {
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
    });
  }

  async cancel(ticketId, workspaceId, approvalId, actor) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId, status: 'pending' },
    });
    if (!approval) throw new NotFoundError('Pending approval not found');
    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: { status: 'cancelled', decidedAt: new Date(), decidedVia: 'app', decisionNote: `Cancelled by ${actor?.email || 'unknown'}` },
    });
    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_cancelled',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: { approvalId: approval.id },
    }).catch(() => {});
    return updated;
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

  async _decide(approval, decision, note, { via, actorLabel }) {
    const normalized = String(decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(normalized)) {
      throw new ValidationError('Decision must be "approved" or "rejected"');
    }
    if (approval.status !== 'pending') {
      throw new ValidationError(`This approval was already ${approval.status}`);
    }

    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: normalized,
        decidedAt: new Date(),
        decidedVia: via,
        decisionNote: note?.trim() || null,
        approverName: approval.approverName || actorLabel,
      },
    });

    const ticket = await prisma.ticket.findUnique({
      where: { id: approval.ticketId },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true },
    });

    await ticketActivityRepository.create({
      ticketId: approval.ticketId,
      activityType: `approval_${normalized}`,
      performedBy: actorLabel,
      performedAt: new Date(),
      details: { approvalId: approval.id, via, note: note || null },
    }).catch(() => {});

    // Audit trail on the conversation + FS fallback copy (mirrors as a private note).
    if (ticket) {
      const verdict = normalized === 'approved' ? 'APPROVED ✔' : 'REJECTED ✘';
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
          bodyText: `Approval ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`,
          content: `Approval ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`,
          occurredAt: new Date(),
          mirrorState: ticket.origin === TICKET_ORIGIN.TICKETPULSE ? 'pending' : null,
        },
      }).then(async (entry) => {
        if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
          await mirrorService.enqueueThreadEntry(ticket.workspaceId, ticket.id, entry.id);
        }
      }).catch((err) => logger.warn(`Approval note write failed (non-fatal): ${err.message}`));

      await emitApprovalEvent('approval.decided', ticket.id, {
        approvalId: approval.id, status: normalized, approverEmail: approval.approverEmail,
      });
      this._broadcast(ticket, 'approval');
    }

    logger.info(`Approval ${normalized} (${via}) on ticket ${approval.ticketId} by ${actorLabel}`);
    return updated;
  }

  async _emailApprover(ticket, approval, decisionUrl) {
    const ref = ticketDisplayRef(ticket);
    const subject = `Approval requested: ${ticket.subject || 'ticket'} [${ref}]`;
    const html = [
      `<p>Your approval was requested on ticket <b>${ref}</b>${ticket.requester?.name ? ` (requested for ${ticket.requester.name})` : ''}.</p>`,
      `<p><b>${(ticket.subject || '').replace(/</g, '&lt;')}</b></p>`,
      approval.requestNote ? `<p>Note from ${approval.requestedBy}: ${approval.requestNote.replace(/</g, '&lt;')}</p>` : '',
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
