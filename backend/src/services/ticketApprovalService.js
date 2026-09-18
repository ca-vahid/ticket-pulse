import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail, renderRequesterHandoffEmail, normalizeNoteHtmlForEmail } from './approvalEmailTemplate.js';
import { categoryTiers } from '../utils/approvalTiers.js';
import { inlinePhotoAttachment } from './userPhotoService.js';
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

const SUPERSEDED_RE = /^Superseded\s+[—–-]\s+(approved|rejected|escalated|forwarded)\s+by\s+(.+)$/i;

// Open rows: the only ones a decision / hand-off can act on.
const OPEN_STATUSES = ['pending', 'info_requested'];

/** "CA$5,200.00" — the amount as people read it; null when there is none. */
export function formatAmount(amount, currency = 'CAD') {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'CAD' }).format(n);
  } catch {
    return `${currency || 'CAD'} ${n.toFixed(2)}`;
  }
}

/** Prisma Decimal | string | number → number | null. */
function amountNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    const rows = await prisma.ticketApproval.findMany({
      where: { ticketId, workspaceId },
      orderBy: { id: 'desc' },
      select: {
        id: true, status: true, approverEmail: true, approverName: true,
        requestedBy: true, requestNote: true, requestNoteHtml: true, decisionNote: true, decisionNoteHtml: true,
        decidedAt: true, decidedVia: true, expiresAt: true, createdAt: true,
        tier: true, amount: true, amountCurrency: true, isFinal: true, escalationLog: true,
        conditionNote: true, conditionNoteHtml: true,
      },
    });
    return this._fillApproverNames(rows);
  }

  /**
   * Request approval against a category. Fans out one approval row per manager
   * (sharing requestGroupId) — any one can approve. Each manager gets a personal
   * magic link. TP-only (no FreshService involvement).
   */
  async request(ticketId, workspaceId, { approvalCategoryId, note = null, noteHtml = null, notifyApprover = true, amount = null }, actor) {
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
    // Approvals v2: every request starts at tier 1 (today's manager list).
    const tiers = categoryTiers(category);
    const allManagers = [...new Set(tiers[0].managerEmails)];
    if (allManagers.length === 0) {
      throw new ValidationError(`"${category.name}" has no approval managers configured — add them in Settings`);
    }
    // Monetary categories carry an amount on every request; the tier limits
    // decide who can finalise it (see _decide → auto-escalation).
    let amountValue = null;
    if (category.hasAmount === true) {
      amountValue = amountNumber(amount);
      if (amountValue === null || amountValue < 0) {
        throw new ValidationError(`"${category.name}" approvals need an amount — enter the ${category.amountCurrency || 'CAD'} total`);
      }
      amountValue = Math.round(amountValue * 100) / 100;
    }
    // Self-approval is prohibited: the requester never receives their own
    // approval row. v3 (16 Sep 2026, Vahid): an approver MAY still request —
    // the request simply starts at the first tier that has someone other
    // than the requester on it (Vahid on Tier 1 asking Security → straight
    // to Neville on Tier 2), recorded as an automatic hand-off so everyone
    // can see why it skipped a tier.
    const requesterEmailLc = String(actor?.email || '').trim().toLowerCase();
    const startTierIdx = tiers.findIndex((t) => t.managerEmails.some((m) => m !== requesterEmailLc));
    if (startTierIdx === -1) {
      throw new ValidationError(tiers.length > 1
        ? `You are an approver on every tier of "${category.name}" and self-approval is prohibited — ask a colleague to request it, or add another approver in Settings.`
        : `You are the only approval manager on "${category.name}" and self-approval is prohibited — add another manager in Settings, or ask a colleague to request it.`);
    }
    const startTier = startTierIdx + 1;
    const managers = tiers[startTierIdx].managerEmails.filter((m) => m !== requesterEmailLc);
    const skippedTiers = tiers.slice(0, startTierIdx).map((t) => t.name);
    const autoStart = startTierIdx > 0 ? {
      kind: 'auto_start', fromTier: 1, toTier: startTier, byEmail: requesterEmailLc, byName: actor?.name || null,
      toEmails: managers, note: null, at: new Date().toISOString(),
      reason: `${actor?.name || requesterEmailLc} is an approver on ${skippedTiers.join(' and ')} and cannot approve their own request`,
    } : null;

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
          approverName: await this._resolvePersonName(email),
          requestedBy: actor?.email || 'unknown',
          requestNote: note?.trim() || null,
          requestNoteHtml: noteHtml ? sanitizeNoteHtml(noteHtml) : null,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
          tier: startTier,
          ...(autoStart ? { escalationLog: [autoStart] } : {}),
          ...(amountValue !== null ? { amount: amountValue, amountCurrency: category.amountCurrency || 'CAD' } : {}),
        },
      });
      if (notifyApprover !== false) {
        const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
        await this._emailApprover(ticket, approval, decisionUrl, category.name, null, autoStart ? {
          handoff: { kind: 'auto_start', byName: actor?.name || requesterEmailLc, note: autoStart.reason, fromTierName: skippedTiers.join(' / '), toTierName: tiers[startTierIdx].name },
        } : {});
      }
      created.push({ id: approval.id, approverEmail: email });
    }

    await ticketActivityRepository.create({
      ticketId,
      activityType: 'approval_requested',
      performedBy: actor?.name || actor?.email || 'Ticket Pulse',
      performedAt: new Date(),
      details: {
        requestGroupId, category: category.name, approvers: managers, note: note || null, notified: notifyApprover !== false,
        ...(amountValue !== null ? { amount: amountValue, amountCurrency: category.amountCurrency || 'CAD' } : {}),
        ...(autoStart ? { startedAtTier: startTier, skippedTiers } : {}),
      },
    }).catch(() => {});
    // The request itself lives in the ticket story from now on (16 Sep 2026):
    // once the verdict lands, the card used to read "Approved by X" with the
    // agent's own words nowhere on the page. Private, never mirrored.
    {
      const requesterLabel = actor?.name || actor?.email || 'Ticket Pulse';
      const cleanNote = String(note || '').trim();
      const amountLabel = amountValue !== null ? ` · ${category.amountCurrency || 'CAD'} ${amountValue}` : '';
      const body = `Approval requested · ${category.name} → ${managers.join(', ')} by ${requesterLabel}${amountLabel}${cleanNote ? ` — "${cleanNote}"` : ''}`;
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId, workspaceId, source: 'ticketpulse_user', eventType: 'note',
          actorName: requesterLabel, actorEmail: actor?.email || null, authorType: 'system',
          incoming: false, isPrivate: true, visibility: 'private', bodyText: body, content: body, occurredAt: new Date(), mirrorState: null,
          rawPayload: { kind: 'approval_event', v: 1, event: 'requested', requestGroupId, category: category.name, approvers: managers, note: cleanNote || null },
        },
      }).catch((err) => logger.warn(`Approval request note write failed (non-fatal): ${err.message}`));
    }
    if (autoStart) {
      const body = `Approval request started at ${tiers[startTierIdx].name} (${managers.join(', ')}) — ${autoStart.reason}`;
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId, workspaceId, source: 'ticketpulse_user', eventType: 'note',
          actorName: actor?.name || actor?.email || 'Ticket Pulse', actorEmail: actor?.email || null, authorType: 'system',
          incoming: false, isPrivate: true, visibility: 'private', bodyText: body, content: body, occurredAt: new Date(), mirrorState: null,
          rawPayload: { kind: 'approval_event', v: 1, event: 'auto_start' },
        },
      }).catch(() => {});
    }

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
      startedAtTier: startTier,
      startedAtTierName: tiers[startTierIdx].name,
      skippedTiers,
    };
  }

  /**
   * Approvals v3: after an answer arrives (link / mailbox / app) every open
   * approver gets a fresh link with the Q&A on it. Rotates the token like
   * resubmit; flips info_requested back to pending.
   */
  async reissueLinkWithAnswer(row, { question = null, answer = null, answeredBy = null } = {}) {
    const token = newToken();
    const updated = await prisma.ticketApproval.update({
      where: { id: row.id },
      data: {
        ...(row.status === 'info_requested' ? { status: 'pending', decisionNote: null } : {}),
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    const ticket = await prisma.ticket.findFirst({
      where: { id: row.ticketId },
      include: {
        requester: { select: { name: true, email: true, jobTitle: true, entraJobTitle: true, department: true, entraDepartment: true, entraOfficeLocation: true, entraCity: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    if (!ticket) return updated;
    let categoryName = null;
    if (row.approvalCategoryId) {
      const cat = await prisma.approvalCategory.findUnique({ where: { id: row.approvalCategoryId }, select: { name: true } }).catch(() => null);
      categoryName = cat?.name || null;
    }
    const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
    await this._emailApprover(ticket, row, decisionUrl, categoryName, { question, answer, answeredBy });
    this._broadcast(ticket, 'approval');
    return updated;
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
          where: { id: approval.approvalCategoryId },
          select: { name: true, description: true, managerEmails: true, tiers: true, hasAmount: true, amountCurrency: true },
        }).catch(() => null)
        : Promise.resolve(null),
      approval.requestGroupId
        ? prisma.ticketApproval.findMany({
          where: { requestGroupId: approval.requestGroupId, workspaceId: approval.workspaceId },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, approverEmail: true, approverName: true, decidedAt: true, decisionNote: true, tier: true },
        }).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (!ticket) throw new NotFoundError('The ticket behind this approval no longer exists');

    // Approvals v2: where this row sits in the category's tier chain.
    const tiers = categoryTiers(category || {});
    const tierIdx = Math.max(0, (approval.tier || 1) - 1);
    const thisTier = tiers[tierIdx] || tiers[0];
    const nextTier = !approval.isFinal ? (tiers[tierIdx + 1] || null) : null;
    const amountValue = amountNumber(approval.amount);
    const amountLimit = thisTier?.limit ?? null;
    const autoEscalates = Boolean(nextTier) && amountValue !== null && amountLimit !== null && amountValue > amountLimit;

    // Forward targets: everyone in the workspace (grants + technicians), never
    // the requester and never the viewer. Names only where we have them.
    const forwardCandidates = await Promise.resolve().then(async () => {
      const [grants, techs] = await Promise.all([
        prisma.workspaceAccess.findMany({ where: { workspaceId: approval.workspaceId }, select: { email: true, name: true } }).catch(() => []),
        prisma.technician.findMany({ where: { workspaceId: approval.workspaceId, isActive: true }, select: { email: true, name: true } }).catch(() => []),
      ]);
      const seen = new Map();
      for (const p of [...(grants || []), ...(techs || [])]) {
        const email = String(p?.email || '').trim().toLowerCase();
        if (!looksLikeEmail(email)) continue;
        if (email === String(approval.requestedBy || '').toLowerCase() || email === String(approval.approverEmail || '').toLowerCase()) continue;
        if (!seen.has(email) || (!seen.get(email).name && p.name)) seen.set(email, { email, name: p.name || null });
      }
      return [...seen.values()].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    }).catch(() => []);

    // Approvals v3: the conversation (an approver sees everything), who is on
    // the request, whether an internal question is still open, and the
    // signature this approver's decision e-mail will carry.
    let messages = []; let participants = null; let awaitingApprover = false; let signaturePreview = null;
    try {
      const { default: conversation } = await import('./approvalConversationService.js');
      const groupId = approval.requestGroupId || `single-${approval.id}`;
      [messages, awaitingApprover] = await Promise.all([conversation.listForGroup(groupId), conversation.awaitingApprover(groupId)]);
      const parts = await conversation.participants(approval);
      participants = { requester: parts.requester, agent: parts.agent, approvers: parts.approvers };
      signaturePreview = (await conversation.signatureFor(approval.workspaceId, approval.approverEmail))?.html || null;
    } catch (err) {
      logger.debug?.(`Approval conversation unavailable for token page: ${err.message}`);
    }

    // Files on the ticket (names + sizes) — the approver opens the ticket for the bytes.
    const attachments = await Promise.resolve().then(async () => {
      const { default: attachmentService } = await import('./attachmentService.js');
      const rows = await attachmentService.listForTicket(ticket.id, ticket.workspaceId);
      return (rows || []).map((a) => ({ id: a.id, name: a.fileName, sizeBytes: a.sizeBytes ?? null, contentType: a.contentType || null }));
    }).catch(() => []);

    // Visibility gates for requester contact detail — reuse the public-status
    // settings so one Settings card governs every unauthenticated surface.
    let visibility = { showRequesterEmail: false, enabled: false };
    try {
      const { getPublicTicketStatusSettings } = await import('./publicTicketStatusService.js');
      visibility = await getPublicTicketStatusSettings(ticket.workspaceId);
    } catch (err) {
      logger.warn(`Approval page: public-status settings unavailable, defaulting to closed (${err.message})`);
    }

    // The page links to the ticket itself (approvers have accounts), so no
    // public status token is minted here any more — the settings lookup above
    // still gates the requester's e-mail address.

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
      approverName: approval.approverName, decidedAt: approval.decidedAt, decisionNote: approval.decisionNote, tier: approval.tier || 1,
    }];
    const approvers = [];
    for (const row of rows) {
      approvers.push({
        name: row.approverName || await nameFor(row.approverEmail) || prettifyLocalPart(row.approverEmail),
        status: row.status,
        isYou: row.approverEmail === approval.approverEmail && row.id === approval.id,
        decidedAt: row.decidedAt || null,
        tier: row.tier || 1,
        tierName: (tiers[(row.tier || 1) - 1] || {}).name || `Tier ${row.tier || 1}`,
      });
    }

    // Hand-off trail with names (escalated / forwarded / auto over-limit).
    const escalationLog = [];
    for (const e of (Array.isArray(approval.escalationLog) ? approval.escalationLog : [])) {
      if (!e || typeof e !== 'object') continue;
      const toNames = [];
      for (const em of (Array.isArray(e.toEmails) ? e.toEmails : [])) toNames.push(await nameFor(em) || prettifyLocalPart(em));
      escalationLog.push({
        kind: e.kind || 'escalated',
        fromTier: e.fromTier || null,
        toTier: e.toTier || null,
        byName: e.byName || (e.byEmail ? (await nameFor(e.byEmail) || prettifyLocalPart(e.byEmail)) : null),
        toNames,
        // The note travels to the next approver only — never to the requester.
        note: e.note || null,
        at: e.at || null,
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
        // Approvals v2
        tier: approval.tier || 1,
        tierName: thisTier?.name || 'Tier 1',
        tierCount: tiers.length,
        nextTier: nextTier ? {
          name: nextTier.name,
          approverNames: await Promise.all(nextTier.managerEmails.map(async (em) => (await nameFor(em)) || prettifyLocalPart(em))),
        } : null,
        canEscalate: Boolean(nextTier) && OPEN_STATUSES.includes(approval.status),
        isFinal: approval.isFinal === true,
        amount: amountValue,
        amountCurrency: approval.amountCurrency || category?.amountCurrency || null,
        amountLabel: formatAmount(amountValue, approval.amountCurrency || category?.amountCurrency || 'CAD'),
        amountLimit,
        amountLimitLabel: formatAmount(amountLimit, approval.amountCurrency || category?.amountCurrency || 'CAD'),
        autoEscalates,
        escalationLog,
        // Approvals v3
        conditionNote: approval.conditionNote || null,
        conditionNoteHtml: approval.conditionNoteHtml || null,
        signatureHtml: approval.signatureHtml || null,
        signaturePreview,
        awaitingApprover,
        messages,
        participants,
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
        attachments,
      },
      approvers,
      forwardCandidates,
      meta: { viewedAt: viewedAt.toISOString() },
    };
  }

  /**
   * Approvals v2 — magic-link hand-off: the approver escalates to the next
   * tier (`mode: 'escalate'`) or forwards to one named person as the final
   * approver (`mode: 'forward'`, `toEmail`). Both need a note.
   */
  async handoffByToken(token, { mode, note = null, toEmail = null } = {}) {
    const approval = await this._findByToken(token);
    return this._handoff(approval, {
      mode: mode === 'forward' ? 'forward' : 'escalate',
      note, toEmail, via: 'link',
      actor: { email: approval.approverEmail, name: approval.approverName },
    });
  }

  /** In-app escalate to the next tier (current-tier approver or admin). */
  async escalate(ticketId, workspaceId, approvalId, { note = null } = {}, actor) {
    const approval = await this._findOpenForActor(ticketId, workspaceId, approvalId, actor, 'escalate');
    return this._handoff(approval, { mode: 'escalate', note, via: 'app', actor: { email: actor?.email || approval.approverEmail, name: actor?.name || null } });
  }

  /** In-app forward to anyone in the workspace as the final approver. */
  async forward(ticketId, workspaceId, approvalId, { toEmail, note = null } = {}, actor) {
    const approval = await this._findOpenForActor(ticketId, workspaceId, approvalId, actor, 'forward');
    return this._handoff(approval, { mode: 'forward', note, toEmail, via: 'app', actor: { email: actor?.email || approval.approverEmail, name: actor?.name || null } });
  }

  async _findOpenForActor(ticketId, workspaceId, approvalId, actor, verb) {
    const approval = await prisma.ticketApproval.findFirst({ where: { id: approvalId, ticketId, workspaceId } });
    if (!approval) throw new NotFoundError('Approval not found');
    const isApprover = actor?.email && approval.approverEmail === String(actor.email).toLowerCase();
    const isAdmin = actor?.role === 'admin' || actor?.workspaceRole === 'admin';
    if (!isApprover && !isAdmin) throw new ValidationError(`Only the requested approver (or an admin) can ${verb} this approval`);
    return approval;
  }

  /**
   * The hand-off engine behind escalate / forward / auto-escalation. Closes
   * the current row ('escalated' | 'forwarded'), supersedes its same-tier
   * siblings, creates the next rows in the same request group (fresh magic
   * links), e-mails the new approvers (with the note) and the requester
   * (without it), and records everything on the ticket.
   */
  async _handoff(approval, { mode, note = null, toEmail = null, actor = {}, via = 'app', auto = false }) {
    if (!OPEN_STATUSES.includes(approval.status)) {
      throw new ValidationError(`This approval was already ${approval.status}`);
    }
    const category = approval.approvalCategoryId
      ? await prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId } }).catch(() => null)
      : null;
    const tiers = categoryTiers(category || {});
    const fromTier = approval.tier || 1;
    const fromTierName = (tiers[fromTier - 1] || {}).name || `Tier ${fromTier}`;
    const requesterEmail = String(approval.requestedBy || '').trim().toLowerCase();
    const actorEmail = String(actor?.email || approval.approverEmail || '').trim().toLowerCase();
    let actorName = actor?.name || approval.approverName || null;
    if (!actorName || looksLikeEmail(actorName)) actorName = (await this._resolvePersonName(actorEmail)) || prettifyLocalPart(actorEmail) || actorEmail;
    const cleanNote = String(note || '').trim() || null;

    let targets; let toTier; let kind; let toTierName;
    if (mode === 'forward') {
      const target = String(toEmail || '').trim().toLowerCase();
      if (!looksLikeEmail(target)) throw new ValidationError('Pick who should decide this approval');
      if (target === requesterEmail) throw new ValidationError('The requester cannot decide their own request');
      if (target === actorEmail) throw new ValidationError('You already hold this approval');
      if (!cleanNote) throw new ValidationError('Add a note for the person you are forwarding this to');
      targets = [target]; toTier = fromTier; kind = 'forwarded'; toTierName = fromTierName;
    } else {
      if (approval.isFinal) throw new ValidationError('This request was forwarded to you as the final approver — it cannot be escalated further');
      const next = tiers[fromTier] || null;
      if (!next) throw new ValidationError(`"${category?.name || 'This category'}" has no tier above ${fromTierName}`);
      targets = next.managerEmails.filter((e) => e !== requesterEmail && e !== actorEmail);
      if (targets.length === 0) throw new ValidationError(`${next.name} has no approver who may decide this request`);
      if (!auto && !cleanNote) throw new ValidationError('Add a note explaining why this needs the next tier');
      toTier = fromTier + 1; kind = auto ? 'auto' : 'escalated'; toTierName = next.name;
    }

    const now = new Date();
    const currency = approval.amountCurrency || category?.amountCurrency || 'CAD';
    const amountValue = amountNumber(approval.amount);
    const limitLabel = formatAmount((tiers[fromTier - 1] || {}).limit ?? null, currency);
    const entry = {
      kind, fromTier, toTier, byEmail: actorEmail, byName: actorName, toEmails: targets, note: cleanNote, at: now.toISOString(),
      ...(kind === 'auto' ? { decision: 'approved', limit: (tiers[fromTier - 1] || {}).limit ?? null } : {}),
    };
    const priorLog = Array.isArray(approval.escalationLog) ? approval.escalationLog : [];
    const log = [...priorLog, entry];
    const targetLabel = kind === 'forwarded' ? ((await this._resolvePersonName(targets[0])) || prettifyLocalPart(targets[0])) : toTierName;
    const closedNote = kind === 'auto'
      ? `Approved — over the ${fromTierName} limit${limitLabel ? ` (${limitLabel})` : ''}, sent on to ${toTierName} automatically${cleanNote ? ` — "${cleanNote}"` : ''}`
      : kind === 'escalated'
        ? `Escalated to ${toTierName} — "${cleanNote}"`
        : `Forwarded to ${targetLabel} — "${cleanNote}"`;
    const requestGroupId = approval.requestGroupId || crypto.randomUUID();

    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: kind === 'forwarded' ? 'forwarded' : 'escalated',
        decidedAt: now,
        decidedVia: via,
        decisionNote: closedNote,
        approverName: approval.approverName || actorName,
        escalationLog: log,
        requestGroupId,
      },
    });
    // Same-tier siblings step aside — the request now lives with the next rows.
    await prisma.ticketApproval.updateMany({
      where: { requestGroupId, workspaceId: approval.workspaceId, status: { in: OPEN_STATUSES }, id: { not: approval.id }, tier: fromTier },
      data: {
        status: 'cancelled', decidedAt: now, decidedVia: via,
        decisionNote: `Superseded — ${kind === 'forwarded' ? 'forwarded' : 'escalated'} by ${actorName}`,
      },
    }).catch((err) => logger.warn(`Approval hand-off: sibling supersede failed (non-fatal): ${err.message}`));

    const ticket = await prisma.ticket.findFirst({
      where: { id: approval.ticketId },
      include: {
        requester: { select: { name: true, email: true, jobTitle: true, entraJobTitle: true, department: true, entraDepartment: true, entraOfficeLocation: true, entraCity: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });

    const created = [];
    for (const email of targets) {
      const token = newToken();
      const row = await prisma.ticketApproval.create({
        data: {
          workspaceId: approval.workspaceId,
          ticketId: approval.ticketId,
          approvalCategoryId: approval.approvalCategoryId,
          requestGroupId,
          approverEmail: email,
          approverName: await this._resolvePersonName(email),
          requestedBy: approval.requestedBy,
          requestNote: approval.requestNote,
          requestNoteHtml: approval.requestNoteHtml,
          clarificationLog: Array.isArray(approval.clarificationLog) ? approval.clarificationLog : undefined,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
          tier: toTier,
          isFinal: kind === 'forwarded',
          ...(amountValue !== null ? { amount: amountValue, amountCurrency: currency } : {}),
          escalationLog: log,
        },
      });
      if (ticket) {
        const decisionUrl = `${publicBaseUrl()}/approval/${encodeURIComponent(token)}`;
        try {
          await this._emailApprover(ticket, row, decisionUrl, category?.name || null, null, {
            handoff: { kind, byName: actorName, note: cleanNote, fromTierName, toTierName, limitLabel },
          });
        } catch (err) {
          logger.warn(`Approval hand-off e-mail failed (non-fatal): ${err.message}`);
        }
      }
      created.push({ id: row.id, approverEmail: email });
    }

    await ticketActivityRepository.create({
      ticketId: approval.ticketId,
      activityType: kind === 'forwarded' ? 'approval_forwarded' : 'approval_escalated',
      performedBy: actorName,
      performedAt: now,
      details: { approvalId: approval.id, requestGroupId, kind, fromTier, toTier, to: targets, note: cleanNote, auto: kind === 'auto' },
    }).catch(() => {});

    if (ticket) {
      const body = kind === 'auto'
        ? `Approval APPROVED at ${fromTierName} by ${actorName} — over the ${fromTierName} limit${limitLabel ? ` (${limitLabel})` : ''}, sent on to ${toTierName} (${targets.join(', ')}) automatically`
        : kind === 'escalated'
          ? `Approval ESCALATED to ${toTierName} (${targets.join(', ')}) by ${actorName} — "${cleanNote}"`
          : `Approval FORWARDED to ${targets[0]} by ${actorName} — "${cleanNote}"`;
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: ticket.workspaceId,
          source: 'ticketpulse_user',
          eventType: 'note',
          actorName,
          actorEmail: actorEmail,
          authorType: 'system',
          incoming: false,
          isPrivate: true,
          visibility: 'private',
          bodyText: body,
          content: body,
          occurredAt: now,
          mirrorState: null,
          rawPayload: { kind: 'approval_event', v: 1, event: kind === 'forwarded' ? 'forwarded' : 'escalated' },
        },
      }).catch((err) => logger.warn(`Approval hand-off note write failed (non-fatal): ${err.message}`));

      try {
        await this._emailRequesterHandoff(ticket, approval, { kind, byName: actorName, byEmail: actorEmail, targets, toTierName, fromTierName });
      } catch (err) {
        logger.warn(`Approval hand-off requester e-mail failed (non-fatal): ${err.message}`);
      }
      await emitApprovalEvent(kind === 'forwarded' ? 'approval.forwarded' : 'approval.escalated', ticket.id, {
        approvalId: requestGroupId, approverEmail: targets.join(', '), requestedBy: approval.requestedBy, status: kind,
      });
      this._broadcast(ticket, 'approval');
    }

    logger.info(`Approval ${kind} on ticket ${approval.ticketId} by ${actorName} → ${targets.join(', ')} (tier ${fromTier} → ${toTier})`);
    return { ...updated, handoff: { kind, fromTier, toTier, to: targets, created } };
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

  async decideByToken(token, decision, note = null, noteHtml = null, extra = {}) {
    const approval = await this._findByToken(token);
    const lc = String(decision || '').toLowerCase();
    if (lc === 'escalate' || lc === 'forward') {
      return this.handoffByToken(token, { mode: lc, note });
    }
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
      conditionNote: extra?.conditionNote || null,
      conditionNoteHtml: extra?.conditionNoteHtml || null,
    });
  }

  async decideInApp(ticketId, workspaceId, approvalId, decision, note, actor, noteHtml = null, extra = {}) {
    const approval = await prisma.ticketApproval.findFirst({
      where: { id: approvalId, ticketId, workspaceId },
    });
    if (!approval) throw new NotFoundError('Approval not found');
    // The decision belongs to the named approver alone (Vahid, 17 Sep 2026):
    // an admin who is not that person forwards the request instead.
    const isApprover = actor?.email && approval.approverEmail === actor.email.toLowerCase();
    if (!isApprover) {
      throw new ValidationError('Only the requested approver can decide this approval — forward it if they are away');
    }
    return this._decide(approval, decision, note, {
      via: 'app',
      actorLabel: actor?.name || actor?.email || 'Ticket Pulse user',
      actorEmail: actor?.email || null,
      noteHtml,
      conditionNote: extra?.conditionNote || null,
      conditionNoteHtml: extra?.conditionNoteHtml || null,
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
    if (!isApprover) {
      throw new ValidationError('Only the requested approver can ask the requester for clarification');
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
      include: { requester: { select: { name: true, email: true } } },
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
        approvalCategory: { select: { name: true, tiers: true, managerEmails: true, hasAmount: true, amountCurrency: true } },
        ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true, email: true } } } },
      },
    });
    return this._fillApproverNames(rows).then((list) => list.map((a) => this._inboxRow(a)));
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
        ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true, email: true } } } },
      },
    });
    return this._fillApproverNames(rows).then((list) => list.map((a) => this._inboxRow(a)));
  }

  _inboxRow(a) {
    const tiers = a.approvalCategory ? categoryTiers(a.approvalCategory) : [{ name: 'Tier 1', managerEmails: [], limit: null }];
    const tier = a.tier || 1;
    const amountValue = amountNumber(a.amount);
    const currency = a.amountCurrency || a.approvalCategory?.amountCurrency || 'CAD';
    return {
      id: a.id,
      status: a.status,
      // Approvals v2
      tier,
      tierName: (tiers[tier - 1] || {}).name || `Tier ${tier}`,
      tierCount: tiers.length,
      nextTierName: !a.isFinal ? ((tiers[tier] || {}).name || null) : null,
      canEscalate: !a.isFinal && Boolean(tiers[tier]),
      isFinal: a.isFinal === true,
      amount: amountValue,
      amountLabel: formatAmount(amountValue, currency),
      amountCurrency: amountValue !== null ? currency : null,
      ticketId: a.ticketId,
      displayRef: ticketDisplayRef(a.ticket),
      subject: a.ticket?.subject || null,
      requesterName: a.ticket?.requester?.name || null,
      requesterEmail: a.ticket?.requester?.email || null,
      requestedByName: a.requestedByName || null,
      categoryName: a.approvalCategory?.name || null,
      approverEmail: a.approverEmail,
      approverName: a.approverName,
      requestedBy: a.requestedBy,
      requestNote: a.requestNote,
      decisionNote: a.decisionNote,
      conditionNote: a.conditionNote || null,
      decidedAt: a.decidedAt,
      decidedVia: a.decidedVia,
      createdAt: a.createdAt,
    };
  }

  /**
   * Admin/reviewer overview of ALL approvals in the workspace: status stats +
   * a filterable list/history. Read-only reporting.
   */
  async overview(workspaceId, { status = null, categoryId = null, limit = 200, q = null, approver = null, requestedBy = null, from = null, to = null, sort = 'newest' } = {}) {
    const where = { workspaceId };
    if (status) where.status = status;
    if (categoryId) where.approvalCategoryId = Number(categoryId);
    // QA 09-16 #4: the redesigned Approvals page filters by people, dates and text.
    const text = (v) => String(v || '').trim();
    if (text(approver)) {
      where.OR = [
        { approverEmail: { contains: text(approver), mode: 'insensitive' } },
        { approverName: { contains: text(approver), mode: 'insensitive' } },
      ];
    }
    if (text(requestedBy)) where.requestedBy = { contains: text(requestedBy), mode: 'insensitive' };
    const fromAt = from ? new Date(from) : null;
    const toAt = to ? new Date(to) : null;
    if ((fromAt && !Number.isNaN(fromAt.getTime())) || (toAt && !Number.isNaN(toAt.getTime()))) {
      where.createdAt = {
        ...(fromAt && !Number.isNaN(fromAt.getTime()) ? { gte: fromAt } : {}),
        ...(toAt && !Number.isNaN(toAt.getTime()) ? { lte: new Date(toAt.getTime() + 24 * 60 * 60 * 1000 - 1) } : {}),
      };
    }
    if (text(q)) {
      const needle = text(q);
      const digits = needle.replace(/^(tp-|#)/i, '');
      const asNumber = /^\d+$/.test(digits) ? Number(digits) : null;
      const textClauses = [
        { ticket: { is: { subject: { contains: needle, mode: 'insensitive' } } } },
        { requestNote: { contains: needle, mode: 'insensitive' } },
        { decisionNote: { contains: needle, mode: 'insensitive' } },
        ...(asNumber ? [{ ticket: { is: { nativeNumber: asNumber } } }, { ticket: { is: { freshserviceTicketId: BigInt(asNumber) } } }] : []),
      ];
      where.AND = [...(where.AND || []), { OR: textClauses }];
    }
    const orderBy = sort === 'oldest' ? { id: 'asc' } : sort === 'status' ? [{ status: 'asc' }, { id: 'desc' }] : { id: 'desc' };
    const [items, grouped] = await Promise.all([
      prisma.ticketApproval.findMany({
        where,
        orderBy,
        take: Math.min(Number(limit) || 200, 500),
        include: {
          approvalCategory: { select: { name: true } },
          ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true, email: true } } } },
        },
      }),
      prisma.ticketApproval.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
    ]);
    const stats = { pending: 0, info_requested: 0, approved: 0, rejected: 0, cancelled: 0, escalated: 0, forwarded: 0 };
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
    if (!isApprover) {
      throw new ValidationError('Only the deciding approver can change this decision');
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
      // App-only members (a CIO added by e-mail, 17 Sep 2026) have neither row:
      // ask the Entra directory, cached for an hour.
      const { resolvePersonName } = await import('./personDirectoryService.js');
      const name = await resolvePersonName(key);
      if (name && !looksLikeEmail(name)) return String(name).trim();
    } catch (err) {
      logger.debug?.(`Person name lookup skipped for ${key}: ${err.message}`);
    }
    return null;
  }

  /**
   * Rows created before names were stored (or for people only the directory
   * knows) get their approver's display name at read time. Mutates and returns.
   */
  async _fillApproverNames(rows) {
    const seen = new Map();
    for (const r of rows || []) {
      if (!r) continue;
      if (!r.approverName && r.approverEmail) {
        const key = String(r.approverEmail).toLowerCase();
        if (!seen.has(key)) seen.set(key, await this._resolvePersonName(key));
        r.approverName = seen.get(key) || null;
      }
      // Display-only (never persisted): who asked, as a person rather than an address.
      if (!r.requestedByName && looksLikeEmail(r.requestedBy)) {
        const key = String(r.requestedBy).toLowerCase();
        if (!seen.has(key)) seen.set(key, await this._resolvePersonName(key));
        r.requestedByName = seen.get(key) || prettifyLocalPart(key) || null;
      }
    }
    return rows;
  }

  async _decide(approval, decision, note, { via, actorLabel, actorEmail = null, changedFrom = null, noteHtml = null, conditionNote = null, conditionNoteHtml = null }) {
    const normalized = String(decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(normalized)) {
      throw new ValidationError('Decision must be "approved" or "rejected"');
    }
    // Self-approval is prohibited (Sep 2026): the person who filed the request
    // never decides it — even when they are one of the category's approvers,
    // and even as an admin. Any-of semantics mean another manager can still
    // decide; the row stays pending, no new status value is introduced (the
    // external verdict mapping is untouched).
    const requesterEmail = String(approval.requestedBy || '').trim().toLowerCase();
    const deciderEmail = String(actorEmail || approval.approverEmail || '').trim().toLowerCase();
    if (requesterEmail && deciderEmail && requesterEmail === deciderEmail) {
      throw new ValidationError('You requested this approval — a different approver has to decide it');
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

    // Approvals v2: approving an amount above this tier's limit does not end
    // the request — it moves on to the next tier automatically (the approval
    // is recorded on this row as 'escalated' with the note). Rejections end it.
    if (normalized === 'approved' && !changedFrom && !approval.isFinal && approval.amount !== null && approval.amount !== undefined) {
      const category = approval.approvalCategoryId
        ? await Promise.resolve().then(() => prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId } })).catch(() => null)
        : null;
      const tiers = categoryTiers(category || {});
      const here = tiers[(approval.tier || 1) - 1] || null;
      const next = tiers[approval.tier || 1] || null;
      const amountValue = amountNumber(approval.amount);
      if (here && next && here.limit !== null && here.limit !== undefined && amountValue !== null && amountValue > here.limit) {
        return this._handoff(approval, { mode: 'escalate', auto: true, note, via, actor: { email: actorEmail || approval.approverEmail, name: actorLabel } });
      }
    }

    // Approvals v3: "approve with condition" + the approver's signature as it
    // will appear in the decision e-mail (saved signature, else Entra card).
    const cleanCondition = normalized === 'approved' ? String(conditionNote || '').trim() || null : null;
    const cleanConditionHtml = cleanCondition && conditionNoteHtml ? sanitizeNoteHtml(conditionNoteHtml) : null;
    let signatureHtml = null;
    try {
      const { default: conversation } = await import('./approvalConversationService.js');
      signatureHtml = (await conversation.signatureFor(approval.workspaceId, actorEmail || approval.approverEmail))?.html || null;
    } catch { signatureHtml = null; }

    const updated = await prisma.ticketApproval.update({
      where: { id: approval.id },
      data: {
        status: normalized,
        decidedAt: new Date(),
        decidedVia: via,
        decisionNote: note?.trim() || null,
        decisionNoteHtml: noteHtml ? sanitizeNoteHtml(noteHtml) : null,
        approverName: approval.approverName || actorLabel,
        conditionNote: cleanCondition,
        conditionNoteHtml: cleanConditionHtml,
        signatureHtml,
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
      const verdict = normalized === 'approved' ? (cleanCondition ? 'APPROVED WITH CONDITION ✔' : 'APPROVED ✔') : 'REJECTED ✘';
      // The verdict card quotes what was asked for, so "Approved by X" is never
      // read without the requester's own words (long notes are trimmed).
      const askedFor = String(approval.requestNote || '').trim();
      const askedForLabel = askedFor
        ? ` · Requested by ${approval.requestedBy || 'the agent'}: "${askedFor.length > 400 ? `${askedFor.slice(0, 400).trimEnd()}…` : askedFor}"`
        : '';
      const noteBody = (changedFrom
        ? `Approval CHANGED to ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`
        : `Approval ${verdict} by ${actorLabel}${note ? ` — "${note.trim()}"` : ''}`) + (cleanCondition ? ` · Condition: "${cleanCondition}"` : '') + askedForLabel;
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
          // `parts` (18 Sep 2026): the same facts the sentence above carries, as
          // fields — the ticket page lays the verdict out as a card (avatar,
          // condition, what was asked) instead of one dense paragraph. The
          // sentence stays the source of truth for search, exports and old clients.
          rawPayload: {
            kind: 'approval_event', v: 2, event: changedFrom ? 'changed' : normalized,
            parts: {
              verdict: normalized,
              changed: Boolean(changedFrom),
              actorName: actorLabel,
              note: note ? note.trim() : null,
              condition: cleanCondition || null,
              requestedBy: approval.requestedBy || null,
              requestedByName: looksLikeEmail(approval.requestedBy)
                ? ((await this._resolvePersonName(approval.requestedBy).catch(() => null)) || prettifyLocalPart(approval.requestedBy))
                : null,
              requestNote: askedFor ? (askedFor.length > 400 ? `${askedFor.slice(0, 400).trimEnd()}…` : askedFor) : null,
            },
          },
        },
      }).catch((err) => logger.warn(`Approval note write failed (non-fatal): ${err.message}`));

      await emitApprovalEvent('approval.decided', ticket.id, {
        // requestedBy lets workflows target the requester (approval_requester token).
        approvalId: approval.id, status: normalized, approverEmail: approval.approverEmail,
        requestedBy: approval.requestedBy,
      });
      this._broadcast(ticket, 'approval');

      // QA 08-11 #5: the agent who asked hears about the verdict by email.
      // Non-fatal — the decision is already persisted.
      try {
        await this._emailRequesterDecision(ticket, approval, { decision: normalized, note, actorLabel, actorEmail, changedFrom, conditionNote: cleanCondition, signatureHtml });
      } catch (err) {
        logger.warn(`Approval decision email failed (non-fatal): ${err.message}`);
      }
      // Approvals v3: the decision is a message on the conversation, and the
      // ticket requester + every other approver on the chain hear it too —
      // reply-style, with the condition, the signature and the history each
      // of them is allowed to see.
      try {
        await this._emailDecisionToParties(ticket, { ...approval, ...updated }, { decision: normalized, note, actorLabel, actorEmail, changedFrom, conditionNote: cleanCondition, signatureHtml });
      } catch (err) {
        logger.warn(`Approval decision thread e-mails failed (non-fatal): ${err.message}`);
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

  async _emailApprover(ticket, approval, decisionUrl, categoryName = null, clarification = null, { handoff = null } = {}) {
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

    // People photos travel INSIDE the message as inline (cid:) attachments — never a URL the
    // client has to fetch (blocked by default in Outlook, and a public link would leak).
    const [requesterPhoto, requestedByPhoto] = await Promise.all([
      inlinePhotoAttachment(requester.email, 'requester-photo'),
      inlinePhotoAttachment(approval.requestedBy, 'requested-by-photo'),
    ]);
    const attachments = [requesterPhoto, requestedByPhoto].filter(Boolean);

    const html = renderApproverRequestEmail({
      workspaceName: await this._workspaceName(ticket),
      categoryName,
      ticket: this._emailTicketFacts(ticket),
      // Approvals v2: amount + tier context + the hand-off block.
      amountLabel: formatAmount(amountNumber(approval.amount), approval.amountCurrency || 'CAD'),
      tierLabel: approval.tier && approval.tier > 1 ? `Tier ${approval.tier}` : null,
      handoff,
      requester: {
        name: requester.name || null,
        title: requester.jobTitle || requester.entraJobTitle || null,
        department: requester.department || requester.entraDepartment || null,
        location: requester.entraOfficeLocation || requester.entraCity || null,
        photoCid: requesterPhoto?.contentId || null,
      },
      requestedByName,
      requestedByPhotoCid: requestedByPhoto?.contentId || null,
      approverName: approval.approverName || null,
      noteHtml,
      clarification: clarification?.answer ? clarification : null,
      otherApprovers,
      decisionUrl,
      expiresAt: approval.expiresAt || null,
      reRequest: !!clarification?.answer,
    });

    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to: approval.approverEmail, subject, html, attachments, label: 'approval' });
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
  async _emailRequesterDecision(ticket, approval, { decision, note = null, actorLabel = null, actorEmail = null, changedFrom = null, conditionNote = null, signatureHtml = null } = {}) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] decision email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.requestedBy}`);
      return { sent: false, reason: 'suppressed' };
    }
    const to = String(approval.requestedBy || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { sent: false, reason: 'no_requester_email' };
    const isSelf = to.toLowerCase() === String(actorEmail || '').trim().toLowerCase();
    const approved = decision === 'approved';
    const verdictLabel = approved ? (conditionNote ? 'Approved with condition' : 'Approved') : 'Rejected';
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
      conditionNote: conditionNote || null,
      signatureHtml: signatureHtml || null,
      requester: { name: ticket.requester?.name || null },
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to, subject, html, label: 'approval decision' });
  }

  /**
   * Approvals v3 — the decision goes to everyone else on the request: the
   * ticket requester (requester-visible history only) and every other
   * approver in the chain (full history). The agent already got theirs.
   */
  async _emailDecisionToParties(ticket, approval, { decision, note = null, actorLabel = null, actorEmail = null, changedFrom = null, conditionNote = null, signatureHtml = null } = {}) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') return { sent: false, reason: 'suppressed' };
    const { default: conversation } = await import('./approvalConversationService.js');
    const { renderDecisionThreadEmail } = await import('./approvalEmailTemplate.js');
    const parts = await conversation.participants(approval);
    const groupId = approval.requestGroupId || `single-${approval.id}`;
    // Record the decision on the conversation (requester-visible).
    await prisma.approvalMessage.create({
      data: {
        workspaceId: approval.workspaceId, ticketId: approval.ticketId, approvalId: approval.id, requestGroupId: groupId,
        kind: 'decision', audience: 'requester', authorEmail: String(actorEmail || approval.approverEmail || '').toLowerCase(),
        authorName: actorLabel || approval.approverName || null, authorRole: 'approver',
        bodyText: [decision === 'approved' ? (conditionNote ? 'Approved with condition' : 'Approved') : 'Rejected', conditionNote ? `Condition: ${conditionNote}` : null, note?.trim() || null].filter(Boolean).join('\n'),
        bodyHtml: null, via: 'app', toEmails: [parts.requester?.email, parts.agent?.email, ...parts.approvers.map((a) => a.email)].filter(Boolean),
      },
    }).catch((err) => logger.warn(`Decision message write failed (non-fatal): ${err.message}`));

    const agentEmail = String(approval.requestedBy || '').toLowerCase();
    const deciderEmail = String(actorEmail || approval.approverEmail || '').toLowerCase();
    const recipients = [];
    if (parts.requester && parts.requester.email !== agentEmail && parts.requester.email !== deciderEmail) recipients.push({ ...parts.requester, audience: 'requester' });
    for (const a of parts.approvers) {
      if (a.email === agentEmail || a.email === deciderEmail || recipients.some((r) => r.email === a.email)) continue;
      recipients.push({ ...a, audience: null });
    }
    if (recipients.length === 0) return { sent: false, reason: 'nobody_else' };
    const ref = ticketDisplayRef(ticket);
    const ticketUrl = `${publicBaseUrl()}/tickets/${ticket.id}`;
    const workspaceName = await this._workspaceName(ticket);
    const category = approval.approvalCategoryId ? await prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId }, select: { name: true } }).catch(() => null) : null;
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    const verdictLabel = decision === 'approved' ? (conditionNote ? 'Approved with condition' : 'Approved') : 'Rejected';
    let sent = 0;
    for (const r of recipients) {
      const thread = await conversation.listForGroup(groupId, { audience: r.audience });
      const html = renderDecisionThreadEmail({
        workspaceName, categoryName: category?.name || null,
        ticket: { ref, subject: ticket.subject || null, appUrl: r.role === 'requester' ? null : ticketUrl },
        approved: decision === 'approved', changedFrom: changedFrom || null,
        approverName: actorLabel || approval.approverName || approval.approverEmail,
        note: note?.trim() || null, conditionNote: conditionNote || null, signatureHtml: signatureHtml || null,
        recipient: r, requester: { name: parts.requester?.name || ticket.requester?.name || null },
        requestNoteHtml: approval.requestNoteHtml || null, requestNote: approval.requestNote || null, requestedByName: parts.agent?.name || null,
        thread: thread.filter((m) => m.kind !== 'decision'),
      });
      const res = await sendTransactionalEmail({ workspaceId: ticket.workspaceId, to: r.email, subject: `${verdictLabel}: ${ticket.subject || 'ticket'} [${ref}]`, html, label: 'approval decision' });
      if (res?.sent !== false) sent += 1;
    }
    return { sent: sent > 0, count: sent };
  }

  /**
   * Requester: the request moved on (escalated / forwarded / auto over-limit).
   * Deliberately carries NO note — the approver's reasoning stays between
   * approvers (Vahid, 15 Sep 2026).
   */
  async _emailRequesterHandoff(ticket, approval, { kind, byName, byEmail = null, targets = [], toTierName = null, fromTierName = null } = {}) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') {
      logger.info(`[approval] hand-off email suppressed (TP_SUPPRESS_APPROVAL_EMAIL) → ${approval.requestedBy}`);
      return { sent: false, reason: 'suppressed' };
    }
    const to = String(approval.requestedBy || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { sent: false, reason: 'no_requester_email' };
    const ref = ticketDisplayRef(ticket);
    const ticketUrl = `${publicBaseUrl()}/tickets/${ticket.id}`;
    const toNames = [];
    for (const em of targets) toNames.push((await this._resolvePersonName(em)) || prettifyLocalPart(em) || em);
    const subject = `${kind === 'forwarded' ? 'Forwarded' : 'Escalated'}: your approval request on ${ticket.subject || 'ticket'} [${ref}]`;
    const html = renderRequesterHandoffEmail({
      workspaceName: await this._workspaceName(ticket),
      ticket: { ref, subject: ticket.subject || null, appUrl: ticketUrl },
      kind, byName: byName || byEmail || 'The approver', toNames, toTierName, fromTierName,
      requester: { name: ticket.requester?.name || null },
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to, subject, html, label: 'approval hand-off' });
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
