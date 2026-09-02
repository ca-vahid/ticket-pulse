import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail, normalizeNoteHtmlForEmail } from './approvalEmailTemplate.js';
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

// Allowlist for approval notes (gap plan P2.4) — inline text formatting +
// lists + links, and since Phase C (08-15) the table set too, so a pasted
// Excel range survives in an approval request description. Mirrors the
// composer's widened vocabulary (RichTextEditor.jsx / EMAIL_SANITIZE_OPTIONS).
// Phase AP (09-02): the ONLY class that survives is `tp-data-table` (the
// composer stamps it on pasted spreadsheet ranges so the public approval page
// can style them) — every other class is dropped, so no arbitrary hooks.
const TABLE_CLASS_ALLOW = ['tp-data-table'];
const NOTE_SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'span', 'div',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'caption',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'style', 'align'],
    td: ['width', 'height', 'colspan', 'rowspan', 'style', 'align', 'valign'],
    th: ['width', 'height', 'colspan', 'rowspan', 'style', 'align', 'valign'],
    col: ['width', 'span'],
  },
  allowedClasses: {
    table: TABLE_CLASS_ALLOW, thead: TABLE_CLASS_ALLOW, tbody: TABLE_CLASS_ALLOW,
    tr: TABLE_CLASS_ALLOW, td: TABLE_CLASS_ALLOW, th: TABLE_CLASS_ALLOW,
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noreferrer' }) },
};

export function sanitizeNoteHtml(html) {
  const clean = sanitizeHtml(String(html || ''), NOTE_SANITIZE_OPTIONS).trim();
  return clean || null;
}

/**
 * Ticket description for the public approval page: the note allow-list plus
 * headings/blockquote/pre/code/hr and <img> — but ONLY https images. Inline
 * `cid:` (mail attachments the page can't resolve) and `data:` images are
 * removed outright rather than left as broken boxes.
 */
export function sanitizeDescriptionHtml(html) {
  const clean = sanitizeHtml(String(html || ''), {
    ...NOTE_SANITIZE_OPTIONS,
    allowedTags: [...NOTE_SANITIZE_OPTIONS.allowedTags, 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'hr', 'img'],
    allowedAttributes: { ...NOTE_SANITIZE_OPTIONS.allowedAttributes, img: ['src', 'alt', 'width', 'height'] },
    allowedSchemesByTag: { img: ['https'] },
    // sanitize-html drops a disallowed-scheme src but keeps the tag — drop the tag too.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs?.src,
  }).trim();
  return clean || null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const looksLikeEmail = (s) => EMAIL_RE.test(String(s || '').trim());

/** "jane.doe" / "jane_doe" / "jdoe2" → "Jane Doe" / "Jdoe2" — a readable stand-in when no directory name exists. */
export function prettifyLocalPart(email) {
  const local = String(email || '').split('@')[0].trim();
  if (!local) return null;
  return local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

const SUPERSEDED_RE = /^Superseded\s+[—–-]\s+(approved|rejected)\s+by\s+(.+)$/i;

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
      include: {
        requester: { select: { name: true, email: true, jobTitle: true, entraJobTitle: true, department: true, entraDepartment: true, entraOfficeLocation: true, entraCity: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
        workspace: { select: { name: true } },
      },
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

  /**
   * Public magic-link read: everything the redesigned /approval/:token page
   * needs, no auth (Phase AP, 09-02). People are resolved to display names;
   * sibling approvers are listed WITHOUT their emails or tokens; requester
   * contact fields follow the workspace's public-status visibility settings.
   */
  async getByToken(token) {
    const approval = await this._findByToken(token);
    const [ticket, category, siblings] = await Promise.all([
      prisma.ticket.findUnique({
        where: { id: approval.ticketId },
        select: {
          id: true, workspaceId: true, subject: true, status: true, priority: true, origin: true,
          nativeNumber: true, freshserviceTicketId: true, createdAt: true, dueBy: true,
          ticketType: true, category: true, subCategory: true,
          description: true, descriptionText: true,
          internalCategory: { select: { name: true } },
          internalSubcategory: { select: { name: true } },
          requester: {
            select: {
              name: true, email: true, jobTitle: true, entraJobTitle: true,
              department: true, entraDepartment: true, entraOfficeLocation: true, entraCity: true,
            },
          },
          workspace: { select: { name: true, slug: true } },
        },
      }),
      approval.approvalCategoryId
        ? prisma.approvalCategory.findUnique({
          where: { id: approval.approvalCategoryId }, select: { name: true, description: true },
        }).catch(() => null)
        : Promise.resolve(null),
      approval.requestGroupId
        ? prisma.ticketApproval.findMany({
          where: { requestGroupId: approval.requestGroupId, workspaceId: approval.workspaceId },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, approverEmail: true, approverName: true, decidedAt: true, decisionNote: true },
        }).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (!ticket) throw new NotFoundError('The ticket behind this approval no longer exists');

    // Visibility gates for requester contact detail — reuse the public-status
    // settings so one Settings card governs every unauthenticated surface.
    let visibility = { showRequesterEmail: false, enabled: false };
    try {
      const { getPublicTicketStatusSettings } = await import('./publicTicketStatusService.js');
      visibility = await getPublicTicketStatusSettings(ticket.workspaceId);
    } catch (err) {
      logger.warn(`Approval page: public-status settings unavailable, defaulting to closed (${err.message})`);
    }

    let publicStatusUrl = null;
    if (visibility.enabled) {
      try {
        const { ensurePublicTicketStatusLink } = await import('./publicTicketStatusService.js');
        const link = await ensurePublicTicketStatusLink({ workspaceId: ticket.workspaceId, ticketId: ticket.id });
        publicStatusUrl = link?.url || null;
      } catch (err) {
        logger.warn(`Approval page: public status link unavailable (${err.message})`);
      }
    }

    let photosAvailable = false;
    try {
      const { default: azureAdService } = await import('./azureAdService.js');
      photosAvailable = typeof azureAdService?.isConfigured === 'function' && azureAdService.isConfigured();
    } catch { /* Entra module unavailable → initials */ }
    const photoUrl = (who) => (photosAvailable
      ? `/api/ticket-approvals/public/${encodeURIComponent(token)}/photo?who=${who}`
      : null);

    const names = new Map();
    const nameFor = async (email) => {
      const key = String(email || '').trim().toLowerCase();
      if (!key) return null;
      if (!names.has(key)) names.set(key, await this._resolvePersonName(key));
      return names.get(key);
    };

    const rows = siblings.length > 0 ? siblings : [{
      id: approval.id, status: approval.status, approverEmail: approval.approverEmail,
      approverName: approval.approverName, decidedAt: approval.decidedAt, decisionNote: approval.decisionNote,
    }];
    const approvers = [];
    for (const row of rows) {
      approvers.push({
        name: row.approverName || await nameFor(row.approverEmail) || prettifyLocalPart(row.approverEmail),
        status: row.status,
        isYou: row.approverEmail === approval.approverEmail,
        decidedAt: row.decidedAt || null,
      });
    }

    // Superseded: this row was auto-cancelled because a sibling decided first.
    // Prefer the decisionNote convention ("Superseded — approved by X"), fall
    // back to the decided sibling in the same group.
    let supersededBy = null;
    let cancelledReason = null;
    if (approval.status === 'cancelled') {
      const m = SUPERSEDED_RE.exec(String(approval.decisionNote || '').trim());
      const decidedSibling = siblings.find((s) => s.id !== approval.id && ['approved', 'rejected'].includes(s.status));
      if (m) {
        supersededBy = {
          name: looksLikeEmail(m[2]) ? (await nameFor(m[2]) || prettifyLocalPart(m[2])) : m[2].trim(),
          decision: m[1].toLowerCase(),
          decidedAt: decidedSibling?.decidedAt || approval.decidedAt || null,
        };
      } else if (decidedSibling) {
        supersededBy = {
          name: decidedSibling.approverName || await nameFor(decidedSibling.approverEmail) || prettifyLocalPart(decidedSibling.approverEmail),
          decision: decidedSibling.status,
          decidedAt: decidedSibling.decidedAt || null,
        };
      } else {
        cancelledReason = approval.decisionNote || 'Cancelled by the requester';
      }
    }

    // Q&A trail: the JSONB log ({question, askedBy, askedAt, answer, answeredBy,
    // answeredAt}); while info_requested the live question also sits in
    // decisionNote — legacy rows asked before the log existed only have that.
    const rawLog = Array.isArray(approval.clarificationLog) ? approval.clarificationLog : [];
    const clarificationLog = [];
    for (const entry of rawLog) {
      if (!entry || typeof entry !== 'object') continue;
      clarificationLog.push({
        question: entry.question || null,
        askedBy: entry.askedBy || null,
        askedByName: entry.askedBy ? (await nameFor(entry.askedBy) || prettifyLocalPart(entry.askedBy)) : null,
        askedAt: entry.askedAt || null,
        answer: entry.answer || null,
        answeredBy: entry.answeredBy || null,
        answeredByName: entry.answeredBy ? (await nameFor(entry.answeredBy) || prettifyLocalPart(entry.answeredBy)) : null,
        answeredAt: entry.answeredAt || null,
      });
    }
    if (approval.status === 'info_requested' && approval.decisionNote
      && !clarificationLog.some((c) => c.question === approval.decisionNote && !c.answer)) {
      clarificationLog.push({
        question: approval.decisionNote, askedBy: approval.approverEmail,
        askedByName: approval.approverName || await nameFor(approval.approverEmail) || prettifyLocalPart(approval.approverEmail),
        askedAt: approval.updatedAt || null, answer: null, answeredBy: null, answeredByName: null, answeredAt: null,
      });
    }

    const requestedByName = (await nameFor(approval.requestedBy)) || prettifyLocalPart(approval.requestedBy) || approval.requestedBy;
    const requester = ticket.requester;
    const showEmail = visibility.showRequesterEmail === true;
    const topCat = ticket.internalCategory?.name || ticket.category || null;
    const subCat = ticket.internalSubcategory?.name || ticket.subCategory || null;
    const categoryPath = topCat ? (subCat ? `${topCat} › ${subCat}` : topCat) : null;
    const viewedAt = new Date();

    // View telemetry (non-fatal — the columns arrive with 20260902030000).
    prisma.ticketApproval.update({
      where: { id: approval.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: viewedAt },
      select: { id: true },
    }).catch((err) => logger.debug?.(`Approval view counter skipped: ${err.message}`));

    return {
      approval: {
        id: approval.id,
        status: approval.status,
        approverEmail: approval.approverEmail,
        approverName: approval.approverName || null,
        requestedBy: approval.requestedBy,
        requestedByEmail: approval.requestedBy,
        requestedByName,
        requestedByPhotoUrl: looksLikeEmail(approval.requestedBy) ? photoUrl('requestedBy') : null,
        requestNote: approval.requestNote,
        requestNoteHtml: approval.requestNoteHtml || null,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
        decidedAt: approval.decidedAt,
        decidedVia: approval.decidedVia || null,
        // While info_requested this holds the open question (also in clarificationLog).
        decisionNote: approval.decisionNote || null,
        decisionNoteHtml: approval.decisionNoteHtml || null,
        category: category ? { name: category.name, description: category.description || null } : null,
        clarificationLog,
        supersededBy,
        cancelledReason,
      },
      ticket: {
        id: ticket.id,
        displayRef: ticketDisplayRef(ticket),
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        priorityLabel: PRIORITY_LABELS[ticket.priority] || null,
        ticketType: ticket.ticketType || null,
        categoryPath,
        createdAt: ticket.createdAt,
        dueBy: ticket.dueBy || null,
        descriptionHtml: ticket.description ? sanitizeDescriptionHtml(ticket.description) : null,
        descriptionText: ticket.descriptionText || null,
        requester: requester ? {
          name: requester.name || null,
          email: showEmail ? (requester.email || null) : null,
          title: requester.jobTitle || requester.entraJobTitle || null,
          department: requester.department || requester.entraDepartment || null,
          location: requester.entraOfficeLocation || requester.entraCity || null,
          photoUrl: requester.email ? photoUrl('requester') : null,
        } : null,
        workspace: { name: ticket.workspace?.name || null, slug: ticket.workspace?.slug || null },
        appTicketUrl: `${publicBaseUrl()}/tickets/${ticket.id}`,
        publicStatusUrl,
      },
      approvers,
      meta: { viewedAt: viewedAt.toISOString() },
    };
  }

  /**
   * Which directory address a public photo request refers to — resolved from
   * the approval row, NEVER from the caller. `who` is 'requester' (the ticket's
   * requester) or 'requestedBy' (the member who asked for approval).
   */
  async photoSubjectEmail(token, who) {
    const approval = await this._findByToken(token);
    if (who === 'requestedBy') {
      return looksLikeEmail(approval.requestedBy) ? approval.requestedBy.trim().toLowerCase() : null;
    }
    if (who === 'requester') {
      const ticket = await prisma.ticket.findUnique({
        where: { id: approval.ticketId },
        select: { requester: { select: { email: true } } },
      });
      const email = ticket?.requester?.email;
      return looksLikeEmail(email) ? email.trim().toLowerCase() : null;
    }
    throw new ValidationError('who must be "requester" or "requestedBy"');
  }

  async decideByToken(token, decision, note = null, noteHtml = null) {
    const approval = await this._findByToken(token);
    // The approver can also bounce it back for more info from the magic link.
    if (String(decision || '').toLowerCase() === 'clarify') {
      return this.requestClarification(approval.ticketId, approval.workspaceId, approval.id, note, {
        email: approval.approverEmail, name: approval.approverName, via: 'link',
      });
    }
    // Phase AP: a rejection from the link must say why — the requester reads
    // it in the verdict email and on the ticket.
    if (String(decision || '').toLowerCase() === 'rejected' && !String(note || '').trim()) {
      throw new ValidationError('Add a reason for rejecting');
    }
    return this._decide(approval, decision, note, {
      via: 'link',
      actorLabel: approval.approverName || approval.approverEmail,
      actorEmail: approval.approverEmail,
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
      actorEmail: actor?.email || null,
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
          // Structured discriminator so the frontend can dispatch approval
          // event cards without regexing the body (body kept for legacy).
          rawPayload: { kind: 'approval_event', v: 1, event: 'clarification' },
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
      include: {
        requester: { select: { name: true, email: true, jobTitle: true, entraJobTitle: true, department: true, entraDepartment: true, entraOfficeLocation: true, entraCity: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
        workspace: { select: { name: true } },
      },
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
            // Resubmit puts the request back in front of the approver —
            // classified as a (re-)request for the frontend card dispatch.
            rawPayload: { kind: 'approval_event', v: 1, event: 'requested' },
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
      actorEmail: actor?.email || approval.approverEmail,
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

  /**
   * Directory name for an email: active Technician first, then Requester.
   * Null when nobody matches (callers fall back to the prettified local part).
   * Never throws — a name lookup must not break a decision.
   */
  async _resolvePersonName(email) {
    const key = String(email || '').trim().toLowerCase();
    if (!looksLikeEmail(key)) return null;
    try {
      const tech = await prisma.technician.findFirst({
        where: { email: { equals: key, mode: 'insensitive' } },
        orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
        select: { name: true },
      });
      if (tech?.name?.trim()) return tech.name.trim();
      const requester = await prisma.requester.findFirst({
        where: { email: { equals: key, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
        select: { name: true },
      });
      if (requester?.name?.trim() && !looksLikeEmail(requester.name)) return requester.name.trim();
    } catch (err) {
      logger.debug?.(`Person name lookup skipped for ${key}: ${err.message}`);
    }
    return null;
  }

  async _decide(approval, decision, note, { via, actorLabel, actorEmail = null, changedFrom = null, noteHtml = null }) {
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

    // Phase AP: a magic-link approver has no session name — resolve one from
    // the directory so the decision reads as a person, not an address.
    if (!approval.approverName && (!actorLabel || looksLikeEmail(actorLabel))) {
      const resolved = await this._resolvePersonName(actorEmail || approval.approverEmail);
      if (resolved) actorLabel = resolved;
    }
    if (!actorLabel) actorLabel = approval.approverEmail;

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
          // 'changed' = an already-decided approval was flipped; otherwise the
          // fresh decision itself ('approved' | 'rejected').
          rawPayload: { kind: 'approval_event', v: 1, event: changedFrom ? 'changed' : normalized },
        },
      }).catch((err) => logger.warn(`Approval note write failed (non-fatal): ${err.message}`));

      await emitApprovalEvent('approval.decided', ticket.id, {
        // requestedBy lets workflows target the requester (approval_requester token).
        approvalId: approval.id, status: normalized, approverEmail: approval.approverEmail,
        requestedBy: approval.requestedBy,
      });
      this._broadcast(ticket, 'approval');

      // QA 08-11 #5: the requester hears about the verdict by email too.
      // Non-fatal — the decision is already persisted.
      try {
        await this._emailRequesterDecision(ticket, approval, { decision: normalized, note, actorLabel, actorEmail, changedFrom });
      } catch (err) {
        logger.warn(`Approval decision email failed (non-fatal): ${err.message}`);
      }
    }

    logger.info(`Approval ${normalized} (${via}) on ticket ${approval.ticketId} by ${actorLabel}`);
    return updated;
  }

  /** Workspace display name for e-mail chrome — from the loaded relation, else a cheap lookup. */
  async _workspaceName(ticket) {
    if (ticket?.workspace?.name) return ticket.workspace.name;
    try {
      const ws = await prisma.workspace.findUnique({ where: { id: ticket.workspaceId }, select: { name: true } });
      return ws?.name || null;
    } catch { return null; }
  }

  /** Ticket facts shared by the approval e-mails (mirrors what the public page shows). */
  _emailTicketFacts(ticket) {
    const topCat = ticket.internalCategory?.name || ticket.category || null;
    const subCat = ticket.internalSubcategory?.name || ticket.subCategory || null;
    return {
      ref: ticketDisplayRef(ticket),
      subject: ticket.subject || null,
      createdAt: ticket.createdAt || null,
      dueBy: ticket.dueBy || null,
      priorityLabel: PRIORITY_LABELS[ticket.priority] || null,
      typeLabel: ticket.ticketType || null,
      categoryPath: topCat ? (subCat ? `${topCat} › ${subCat}` : topCat) : null,
      statusLabel: ticket.status || null,
      description: ticket.description || ticket.descriptionText || null,
      appUrl: `${publicBaseUrl()}/tickets/${ticket.id}`,
    };
  }

  async _emailApprover(ticket, approval, decisionUrl, categoryName = null, clarification = null) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.approverEmail}`);
      return { sent: false, reason: 'suppressed' };
    }
    const ref = ticketDisplayRef(ticket);
    const requesterName = ticket.requester?.name || null;
    // Subject: what is asked, for whom, and the ref last (threading + inbox filters). Identical on a
    // re-request so it lands in the same conversation.
    const subject = `Approval needed: ${categoryName || 'request'}${requesterName ? ` for ${requesterName}` : ''} — ${ticket.subject || 'ticket'} [${ref}]`;

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
    // Mail-client normalization: pasted spreadsheet tables lose fixed widths/empty columns and gain borders.
    noteHtml = noteHtml ? (normalizeNoteHtmlForEmail(noteHtml) || '') : '';

    // Phase AP: the requester of the approval shows as a person, not an address.
    const requestedByName = (await this._resolvePersonName(approval.requestedBy)) || prettifyLocalPart(approval.requestedBy) || approval.requestedBy;
    const requester = ticket.requester || {};

    // Sibling approvers (multi-manager categories) — "also asked", first decision wins.
    let otherApprovers = [];
    if (approval.requestGroupId) {
      try {
        const rows = await prisma.ticketApproval.findMany({
          where: { requestGroupId: approval.requestGroupId, workspaceId: ticket.workspaceId, NOT: { id: approval.id } },
          orderBy: { id: 'asc' },
          select: { approverEmail: true, approverName: true, status: true },
        });
        for (const row of rows || []) {
          otherApprovers.push({
            name: row.approverName || (await this._resolvePersonName(row.approverEmail)) || prettifyLocalPart(row.approverEmail),
            status: row.status,
          });
        }
      } catch (err) {
        logger.warn(`Approval e-mail: sibling approvers unavailable (${err.message})`);
        otherApprovers = [];
      }
    }

    const html = renderApproverRequestEmail({
      workspaceName: await this._workspaceName(ticket),
      categoryName,
      ticket: this._emailTicketFacts(ticket),
      requester: {
        name: requester.name || null,
        title: requester.jobTitle || requester.entraJobTitle || null,
        department: requester.department || requester.entraDepartment || null,
        location: requester.entraOfficeLocation || requester.entraCity || null,
      },
      requestedByName,
      approverName: approval.approverName || null,
      noteHtml,
      clarification: clarification?.answer ? clarification : null,
      otherApprovers,
      decisionUrl,
      expiresAt: approval.expiresAt || null,
      reRequest: !!clarification?.answer,
    });

    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to: approval.approverEmail, subject, html, label: 'approval' });
  }

  /**
   * Notify the requester that their approval request was decided (QA 08-11 #5).
   * Mirrors _emailRequesterClarification's guards: kill-switch + email-shape
   * check. QA 08-17 #2: the requester ALWAYS gets the verdict email — even
   * when they decided their own request (the body says so instead of skipping;
   * Susan's self-approval test read as "decision emails never arrive").
   * `actorEmail` is the DECIDING actor, not approval.approverEmail — an admin
   * deciding on the approver's behalf must not read as a self-decision.
   */
  async _emailRequesterDecision(ticket, approval, { decision, note = null, actorLabel = null, actorEmail = null, changedFrom = null } = {}) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] decision email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.requestedBy}`);
      return { sent: false, reason: 'suppressed' };
    }
    const to = String(approval.requestedBy || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { sent: false, reason: 'no_requester_email' };
    const isSelf = to.toLowerCase() === String(actorEmail || '').trim().toLowerCase();
    const approved = decision === 'approved';
    const verdictLabel = approved ? 'Approved' : 'Rejected';
    const ref = ticketDisplayRef(ticket);
    const ticketUrl = `${publicBaseUrl()}/tickets/${ticket.id}`;
    // Subject prefix stays identical for the self variant — inbox filters and
    // threading keep working; only the body wording changes.
    const subject = `${verdictLabel}: your approval request on ${ticket.subject || 'ticket'} [${ref}]`;
    const html = renderRequesterDecisionEmail({
      workspaceName: await this._workspaceName(ticket),
      ticket: { ref, subject: ticket.subject || null, appUrl: ticketUrl },
      approved,
      approverName: actorLabel || approval.approverName || approval.approverEmail,
      isSelf,
      changedFrom: changedFrom || null,
      note: note?.trim() || null,
      requester: { name: ticket.requester?.name || null },
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to, subject, html, label: 'approval decision' });
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
    const html = renderRequesterClarificationEmail({
      workspaceName: await this._workspaceName(ticket),
      ticket: { ref, subject: ticket.subject || null, appUrl: ticketUrl },
      approverName: approval.approverName || approval.approverEmail,
      question,
      requester: { name: ticket.requester?.name || null },
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to, subject, html, label: 'approval clarification' });
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
