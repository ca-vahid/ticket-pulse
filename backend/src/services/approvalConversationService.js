import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sanitizeNoteHtml } from './ticketApprovalService.js';
import { resolvePersonName } from './personDirectoryService.js';
import { renderApprovalMessageEmail } from './approvalEmailTemplate.js';
import { pickIngestMailbox } from './mailboxPicker.js';
import { stripQuotedHtml, stripQuotedText } from '../utils/replyQuoteStripper.js';

import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
/**
 * Approvals v3 — the conversation on a request (16 Sep 2026, Vahid).
 *
 * Every question, comment, answer, decision and hand-off is an
 * approval_messages row with an AUDIENCE:
 *   - 'requester'  everyone on the request may see it (requester, agent, approvers)
 *   - 'internal'   approvers + the agent only — the requester's e-mails and
 *                  pages never include it
 *
 * Recipients of a question/comment get an e-mail with a personal reply token:
 * the same token is the magic link (/approval-reply/<token>) AND the plus-
 * address key (<ingest>+ap<plusKey>@…) a mailbox reply comes back on.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const OPEN_STATUSES = ['pending', 'info_requested'];
const REPLY_TOKEN_DAYS = 45;
export const AUDIENCES = ['requester', 'internal'];
export const MESSAGE_KINDS = ['question', 'answer', 'comment', 'decision', 'handoff'];

const lc = (v) => String(v || '').trim().toLowerCase();
const looksLikeEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const plusKeyFor = (token) => hashToken(token).slice(0, 12); // 12 hex chars — fits `+ap<key>` and is unguessable enough with the token hash behind it
export const PLUS_KEY_RE = /^([^@\s<>+]+)\+ap([a-f0-9]{8,24})@([^@\s<>]+)$/i;

function publicBaseUrl() {
  return resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
}

function textFromHtml(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}

/** Key of the plus-address on the recipient side of an inbound mail, or null. */
export function plusAddressApprovalKey(email, mailboxAddress = null) {
  const base = lc(mailboxAddress);
  const raw = [email?.to, email?.cc, email?.deliveredTo, email?.xOriginalTo].flatMap((v) => (Array.isArray(v) ? v : String(v || '').split(',')));
  for (const part of raw) {
    const s = String(part || '').trim();
    if (!s) continue;
    const angle = s.match(/<([^<>]+)>/);
    const address = (angle ? angle[1] : s).trim().toLowerCase();
    const m = address.match(PLUS_KEY_RE);
    if (!m) continue;
    if (base && `${m[1]}@${m[3]}` !== base) continue;
    return m[2].toLowerCase();
  }
  return null;
}

class ApprovalConversationService {
  // ------------------------------------------------------------ participants
  /**
   * Everyone on a request: the ticket requester, the agent who asked, and every
   * approver row in the group (any tier, any status). Names resolved.
   */
  async participants(approval) {
    const [ticket, rows] = await Promise.all([
      prisma.ticket.findUnique({ where: { id: approval.ticketId }, select: { id: true, subject: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true, email: true } } } }),
      approval.requestGroupId
        ? prisma.ticketApproval.findMany({ where: { requestGroupId: approval.requestGroupId, workspaceId: approval.workspaceId }, orderBy: { id: 'asc' }, select: { id: true, approverEmail: true, approverName: true, tier: true, status: true } })
        : Promise.resolve([{ id: approval.id, approverEmail: approval.approverEmail, approverName: approval.approverName, tier: approval.tier || 1, status: approval.status }]),
    ]);
    const nameOf = async (email, fallback = null) => fallback || (await resolvePersonName(email)) || String(email || '').split('@')[0];
    const requesterEmail = lc(ticket?.requester?.email);
    const agentEmail = lc(approval.requestedBy);
    const requester = looksLikeEmail(requesterEmail) ? { role: 'requester', email: requesterEmail, name: ticket?.requester?.name || await nameOf(requesterEmail) } : null;
    const agent = looksLikeEmail(agentEmail) ? { role: 'agent', email: agentEmail, name: await nameOf(agentEmail) } : null;
    const seen = new Set();
    const approvers = [];
    for (const r of rows) {
      const email = lc(r.approverEmail);
      if (!looksLikeEmail(email) || seen.has(email)) continue;
      seen.add(email);
      approvers.push({ role: 'approver', email, name: await nameOf(email, r.approverName), tier: r.tier || 1, status: r.status, approvalId: r.id });
    }
    return { ticket, requester, agent, approvers };
  }

  roleOf(parts, email) {
    const e = lc(email);
    if (parts.requester && parts.requester.email === e) return 'requester';
    if (parts.agent && parts.agent.email === e) return 'agent';
    if (parts.approvers.some((a) => a.email === e)) return 'approver';
    return null;
  }

  /** Default To/Cc for a mode. `self` (the author) is never a recipient. */
  defaultRecipients(parts, mode, selfEmail) {
    const self = lc(selfEmail);
    const others = (list) => list.filter((p) => p && p.email !== self);
    const chainAndAgent = others([parts.agent, ...parts.approvers]).filter((p, i, arr) => arr.findIndex((x) => x.email === p.email) === i);
    if (mode === 'requester') {
      return { audience: 'requester', to: parts.requester ? [parts.requester] : [], cc: chainAndAgent };
    }
    return { audience: 'internal', to: chainAndAgent, cc: [] };
  }

  // ------------------------------------------------------------ messages
  async listForGroup(requestGroupId, { audience = null } = {}) {
    if (!requestGroupId) return [];
    const where = { requestGroupId };
    if (audience === 'requester') where.audience = 'requester';
    const rows = await prisma.approvalMessage.findMany({ where, orderBy: { id: 'asc' } });
    return rows.map((m) => this._shape(m));
  }

  async listForTicket(ticketId, workspaceId, { audience = null } = {}) {
    const where = { ticketId, workspaceId };
    if (audience === 'requester') where.audience = 'requester';
    const rows = await prisma.approvalMessage.findMany({ where, orderBy: { id: 'asc' } });
    return rows.map((m) => this._shape(m));
  }

  _shape(m) {
    return {
      id: m.id, kind: m.kind, audience: m.audience, requestGroupId: m.requestGroupId, approvalId: m.approvalId,
      author: { email: m.authorEmail, name: m.authorName || null, role: m.authorRole },
      bodyText: m.bodyText || null, bodyHtml: m.bodyHtml || null, via: m.via,
      to: m.toEmails || [], cc: m.ccEmails || [], inReplyToId: m.inReplyToId || null, createdAt: m.createdAt,
    };
  }

  /** Is there an unanswered INTERNAL question on this group? (→ "Waiting on approver" for the requester/agent view.) */
  async awaitingApprover(requestGroupId) {
    if (!requestGroupId) return false;
    const rows = await prisma.approvalMessage.findMany({ where: { requestGroupId, kind: { in: ['question', 'answer'] } }, orderBy: { id: 'asc' }, select: { id: true, kind: true, audience: true, inReplyToId: true } }).catch(() => []);
    const answered = new Set(rows.filter((r) => r.kind === 'answer' && r.inReplyToId).map((r) => r.inReplyToId));
    return rows.some((r) => r.kind === 'question' && r.audience === 'internal' && !answered.has(r.id));
  }

  /**
   * An approver (or admin acting for one) asks a question or leaves a comment.
   * `mode` picks the default audience; `to`/`cc` (e-mail arrays) narrow it —
   * they must be participants, and the requester can never be on an
   * 'internal' message.
   */
  async postMessage(approval, { kind = 'question', mode = 'requester', to = null, cc = null, bodyText = null, bodyHtml = null, via = 'app', author }) {
    if (!['question', 'comment'].includes(kind)) throw new ValidationError('kind must be "question" or "comment"');
    if (!OPEN_STATUSES.includes(approval.status)) throw new ValidationError(`This approval was already ${approval.status}`);
    const cleanHtml = bodyHtml ? sanitizeNoteHtml(bodyHtml) : null;
    const cleanText = String(bodyText || textFromHtml(cleanHtml) || '').trim();
    if (!cleanText) throw new ValidationError(kind === 'question' ? 'Type your question first' : 'Type your message first');

    const parts = await this.participants(approval);
    const authorEmail = lc(author?.email || approval.approverEmail);
    const authorName = author?.name || approval.approverName || (await resolvePersonName(authorEmail)) || authorEmail.split('@')[0];
    const authorRole = this.roleOf(parts, authorEmail) || 'approver';
    const defaults = this.defaultRecipients(parts, mode, authorEmail);
    const known = new Map([parts.requester, parts.agent, ...parts.approvers].filter(Boolean).map((p) => [p.email, p]));
    const pick = (list, fallback) => {
      if (!Array.isArray(list)) return fallback;
      return list.map(lc).filter((e) => known.has(e) && e !== authorEmail).map((e) => known.get(e));
    };
    let toList = pick(to, defaults.to);
    let ccList = pick(cc, defaults.cc).filter((p) => !toList.some((t) => t.email === p.email));
    const audience = defaults.audience;
    if (audience === 'internal') {
      const req = parts.requester?.email;
      toList = toList.filter((p) => p.email !== req);
      ccList = ccList.filter((p) => p.email !== req);
    }
    if (toList.length === 0 && ccList.length === 0) throw new ValidationError('Pick at least one person to send this to');
    if (audience === 'requester' && !toList.some((p) => p.role === 'requester')) {
      throw new ValidationError('"Ask the requester" needs the requester in To — use "Ask the approvers / agent only" otherwise');
    }

    const message = await prisma.approvalMessage.create({
      data: {
        workspaceId: approval.workspaceId, ticketId: approval.ticketId, approvalId: approval.id,
        requestGroupId: approval.requestGroupId || `single-${approval.id}`,
        kind, audience, authorEmail, authorName, authorRole,
        bodyText: cleanText, bodyHtml: cleanHtml, via,
        toEmails: toList.map((p) => p.email), ccEmails: ccList.map((p) => p.email),
      },
    });

    // A question to the requester parks the request (existing semantics);
    // an internal question leaves it with the approver.
    if (kind === 'question' && audience === 'requester') {
      const priorLog = Array.isArray(approval.clarificationLog) ? approval.clarificationLog : [];
      await prisma.ticketApproval.update({
        where: { id: approval.id },
        data: {
          status: 'info_requested', decisionNote: cleanText, approverName: approval.approverName || authorName,
          clarificationLog: [...priorLog, { question: cleanText, askedBy: authorEmail, askedAt: new Date().toISOString(), messageId: message.id }],
        },
      }).catch((err) => logger.warn(`Approval question: status update failed (non-fatal): ${err.message}`));
    }

    await this._ticketNote(approval, {
      actorName: authorName, actorEmail: authorEmail,
      body: `${kind === 'question' ? 'Question' : 'Comment'} ${audience === 'internal' ? '(approvers + agent only) ' : ''}from ${authorName} → ${[...toList, ...ccList].map((p) => p.name || p.email).join(', ')}: "${cleanText}"`,
      event: kind, messageId: message.id,
    });

    await this._emailRecipients(approval, parts, message, { toList, ccList, authorName, authorRole });
    this._broadcast(approval);
    logger.info(`Approval ${kind} (${audience}) on ticket ${approval.ticketId} by ${authorName} → ${[...toList, ...ccList].map((p) => p.email).join(', ')}`);
    return this._shape(message);
  }

  /**
   * An answer to a question/comment — from the magic link (token) or from a
   * mailbox reply (plusKey), or in-app (participant answering directly).
   */
  async answer({ token = null, plusKey = null, inReplyToId = null, approvalId = null, senderEmail = null, senderName = null, bodyText = null, bodyHtml = null, via = 'link', emailMessageId = null }) {
    let target = null; // the message being answered
    let tokenRow = null;
    if (token || plusKey) {
      tokenRow = await prisma.approvalReplyToken.findUnique({ where: token ? { tokenHash: hashToken(token) } : { plusKey: lc(plusKey) } });
      if (!tokenRow) throw new NotFoundError('This reply link is not valid');
      if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) throw new ValidationError('This reply link has expired — ask the approver to send the question again');
      target = await prisma.approvalMessage.findUnique({ where: { id: tokenRow.messageId } });
    } else if (inReplyToId) {
      target = await prisma.approvalMessage.findUnique({ where: { id: Number(inReplyToId) } });
    }
    if (!target) throw new NotFoundError('The message you are answering no longer exists');

    const approval = approvalId
      ? await prisma.ticketApproval.findFirst({ where: { id: Number(approvalId), requestGroupId: target.requestGroupId } })
      : (await prisma.ticketApproval.findFirst({ where: { requestGroupId: target.requestGroupId, status: { in: OPEN_STATUSES } }, orderBy: { id: 'desc' } }))
        || (await prisma.ticketApproval.findFirst({ where: { requestGroupId: target.requestGroupId }, orderBy: { id: 'desc' } }));
    if (!approval) throw new NotFoundError('The approval behind this message no longer exists');

    const parts = await this.participants(approval);
    // Who is answering: the token's recipient by default; a mailbox reply may
    // come from any participant (a colleague replying from the Cc line).
    let email = lc(tokenRow?.recipientEmail);
    if (senderEmail && looksLikeEmail(senderEmail)) {
      const s = lc(senderEmail);
      if (this.roleOf(parts, s)) email = s;
      else if (!email) throw new ValidationError(`${s} is not part of this approval`);
    }
    if (!email) throw new ValidationError('Could not tell who is answering');
    const role = this.roleOf(parts, email) || (tokenRow ? 'requester' : 'agent');
    const name = senderName || [parts.requester, parts.agent, ...parts.approvers].find((p) => p && p.email === email)?.name || (await resolvePersonName(email)) || email.split('@')[0];

    const cleanHtml = bodyHtml ? sanitizeNoteHtml(stripQuotedHtml(bodyHtml)) : null;
    const cleanText = String(stripQuotedText(bodyText || '') || textFromHtml(cleanHtml) || '').trim();
    if (!cleanText) throw new ValidationError('Type your answer first');

    // The answer inherits the question's audience; a requester's answer is
    // always requester-visible (they wrote it).
    const audience = role === 'requester' ? 'requester' : target.audience;
    const asker = [parts.requester, parts.agent, ...parts.approvers].find((p) => p && p.email === lc(target.authorEmail));
    const message = await prisma.approvalMessage.create({
      data: {
        workspaceId: approval.workspaceId, ticketId: approval.ticketId, approvalId: approval.id,
        requestGroupId: target.requestGroupId, kind: 'answer', audience,
        authorEmail: email, authorName: name, authorRole: role,
        bodyText: cleanText, bodyHtml: cleanHtml, via, emailMessageId: emailMessageId || null,
        toEmails: asker ? [asker.email] : [lc(target.authorEmail)], ccEmails: [],
        inReplyToId: target.id,
      },
    });
    if (tokenRow) {
      await prisma.approvalReplyToken.update({ where: { id: tokenRow.id }, data: { usedAt: new Date(), useCount: { increment: 1 } } }).catch(() => {});
    }

    // A requester-audience question that was parked → back to pending, with the
    // answer on the legacy clarification log too.
    if (target.kind === 'question' && target.audience === 'requester') {
      const openRows = await prisma.ticketApproval.findMany({ where: { requestGroupId: target.requestGroupId, status: 'info_requested' } });
      for (const row of openRows) {
        const log = Array.isArray(row.clarificationLog) ? [...row.clarificationLog] : [];
        const idx = log.findIndex((c) => c && c.messageId === target.id && !c.answer);
        const stamped = { answer: cleanText, answeredBy: email, answeredAt: new Date().toISOString() };
        if (idx >= 0) log[idx] = { ...log[idx], ...stamped };
        else log.push({ question: target.bodyText, askedBy: target.authorEmail, askedAt: target.createdAt?.toISOString?.() || null, messageId: target.id, ...stamped });
        await prisma.ticketApproval.update({ where: { id: row.id }, data: { status: 'pending', decisionNote: null, clarificationLog: log } }).catch(() => {});
      }
    }

    await this._ticketNote(approval, {
      actorName: name, actorEmail: email,
      body: `Answer ${audience === 'internal' ? '(approvers + agent only) ' : ''}from ${name}${via === 'email' ? ' by e-mail' : ''}: "${cleanText}"`,
      event: 'answer', messageId: message.id,
    });

    await this._notifyApproversOfAnswer(approval, parts, target, message, { name });
    this._broadcast(approval);
    logger.info(`Approval answer (${audience}, ${via}) on ticket ${approval.ticketId} by ${name}`);
    return { message: this._shape(message), approvalId: approval.id, requestGroupId: target.requestGroupId };
  }

  /** What a reply-link holder may see: the question, and the thread at their audience level. */
  async viewForReplyToken(token) {
    const tokenRow = await prisma.approvalReplyToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!tokenRow) throw new NotFoundError('This reply link is not valid');
    const target = await prisma.approvalMessage.findUnique({ where: { id: tokenRow.messageId } });
    if (!target) throw new NotFoundError('The message behind this link no longer exists');
    const approval = (await prisma.ticketApproval.findFirst({ where: { requestGroupId: target.requestGroupId, status: { in: OPEN_STATUSES } }, orderBy: { id: 'desc' } }))
      || (await prisma.ticketApproval.findFirst({ where: { requestGroupId: target.requestGroupId }, orderBy: { id: 'desc' } }));
    if (!approval) throw new NotFoundError('The approval behind this link no longer exists');
    const parts = await this.participants(approval);
    const recipient = lc(tokenRow.recipientEmail);
    const role = this.roleOf(parts, recipient) || 'requester';
    const audience = role === 'requester' ? 'requester' : null;
    const thread = await this.listForGroup(target.requestGroupId, { audience });
    const category = approval.approvalCategoryId ? await prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId }, select: { name: true } }).catch(() => null) : null;
    return {
      recipient: { email: recipient, name: [parts.requester, parts.agent, ...parts.approvers].find((p) => p && p.email === recipient)?.name || null, role },
      question: this._shape(target),
      thread,
      approval: { id: approval.id, status: approval.status, category: category?.name || null, requestGroupId: target.requestGroupId, expired: Boolean(tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) },
      ticket: { id: parts.ticket?.id, displayRef: parts.ticket ? ticketDisplayRef(parts.ticket) : null, subject: parts.ticket?.subject || null },
      participants: { requester: parts.requester, agent: parts.agent, approvers: parts.approvers },
    };
  }

  // ------------------------------------------------------------ signature
  /** The approver's signature for the decision e-mail: their saved one, else a generated Entra card. */
  async signatureFor(workspaceId, email) {
    const e = lc(email);
    if (!looksLikeEmail(e)) return null;
    try {
      const { getEnabledSignatureForSend } = await import('./userSignatureService.js');
      const saved = await getEnabledSignatureForSend(workspaceId, e);
      if (saved?.html) return { html: saved.html, source: 'saved' };
    } catch { /* fall through */ }
    let name = null; let title = null; let dept = null; let phone = null;
    try {
      const { default: azureAdService } = await import('./azureAdService.js');
      if (typeof azureAdService?.isConfigured === 'function' && azureAdService.isConfigured() && typeof azureAdService.resolveAddress === 'function') {
        const res = await azureAdService.resolveAddress(e);
        if (res?.status === 'found' || res?.status === 'alias') {
          name = res.displayName || null; title = res.jobTitle || null; dept = res.department || null; phone = res.businessPhone || res.mobilePhone || null;
        }
      }
    } catch { /* Entra unavailable */ }
    if (!name) name = (await resolvePersonName(e)) || e.split('@')[0];
    const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const line2 = [title, dept].filter(Boolean).join(' · ');
    const html = `<p style="margin:0"><b>${esc(name)}</b>${line2 ? `<br>${esc(line2)}` : ''}<br>BGC Engineering${phone ? ` · ${esc(phone)}` : ''}<br><a href="mailto:${esc(e)}">${esc(e)}</a></p>`;
    return { html, source: 'entra' };
  }

  // ------------------------------------------------------------ internals
  async _ticketNote(approval, { actorName, actorEmail, body, event, messageId }) {
    try {
      const entry = await prisma.ticketThreadEntry.create({
        data: {
          ticketId: approval.ticketId, workspaceId: approval.workspaceId, source: 'ticketpulse_user', eventType: 'note',
          actorName, actorEmail, authorType: 'system', incoming: false, isPrivate: true, visibility: 'private',
          bodyText: body, content: body, occurredAt: new Date(), mirrorState: null,
          rawPayload: { kind: 'approval_event', v: 1, event, messageId },
        },
      });
      if (messageId && entry?.id) await prisma.approvalMessage.update({ where: { id: messageId }, data: { threadEntryId: entry.id } }).catch(() => {});
    } catch (err) {
      logger.warn(`Approval conversation note write failed (non-fatal): ${err.message}`);
    }
  }

  async _emailRecipients(approval, parts, message, { toList, ccList, authorName, authorRole }) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') return;
    const ticket = parts.ticket;
    if (!ticket) return;
    const ingest = await pickIngestMailbox(approval.workspaceId).catch(() => null);
    const category = approval.approvalCategoryId ? await prisma.approvalCategory.findUnique({ where: { id: approval.approvalCategoryId }, select: { name: true } }).catch(() => null) : null;
    const threadForAudience = await this.listForGroup(message.requestGroupId, { audience: message.audience === 'internal' ? null : 'requester' });
    const prior = threadForAudience.filter((m) => m.id !== message.id);
    const { deliverTransactionalEmail } = await import('./transactionalEmailService.js');
    const ref = ticketDisplayRef(ticket);
    for (const person of [...toList, ...ccList]) {
      const token = newToken();
      const plusKey = plusKeyFor(token);
      await prisma.approvalReplyToken.create({
        data: {
          workspaceId: approval.workspaceId, messageId: message.id, requestGroupId: message.requestGroupId,
          recipientEmail: person.email, tokenHash: hashToken(token), plusKey,
          expiresAt: new Date(Date.now() + REPLY_TOKEN_DAYS * 24 * 60 * 60 * 1000),
        },
      }).catch((err) => logger.warn(`Approval reply token write failed for ${person.email}: ${err.message}`));
      const replyUrl = `${publicBaseUrl()}/approval-reply/${encodeURIComponent(token)}`;
      let replyTo = null;
      if (ingest?.address) {
        const [local, domain] = String(ingest.address).toLowerCase().split('@');
        if (local && domain) replyTo = `${local.replace(/\+.*$/, '')}+ap${plusKey}@${domain}`;
      }
      const isCc = ccList.includes(person);
      const subject = `${message.kind === 'question' ? 'Question' : 'Note'} on ${category?.name ? `${category.name} approval` : 'an approval'}: ${ticket.subject || 'ticket'} [${ref}]`;
      const html = renderApprovalMessageEmail({
        kind: message.kind, audience: message.audience, authorName, authorRole,
        recipient: person, isCc, categoryName: category?.name || null,
        ticket: { ref, subject: ticket.subject || null },
        bodyHtml: message.bodyHtml, bodyText: message.bodyText,
        thread: prior, replyUrl, canReplyByEmail: Boolean(replyTo),
        internalNote: message.audience === 'internal',
      });
      try {
        await deliverTransactionalEmail({ workspaceId: approval.workspaceId, to: [person.email], subject, html, label: 'approval question', replyTo, fromName: `${authorName} via Ticket Pulse` });
      } catch (err) {
        logger.warn(`Approval ${message.kind} e-mail to ${person.email} failed (non-fatal): ${err.message}`);
      }
    }
  }

  /** Every open approver in the group hears an answer (and the asker if they are closed out, e.g. Tier 1 after escalation). */
  async _notifyApproversOfAnswer(approval, parts, question, answer, { name }) {
    if (process.env.TP_SUPPRESS_APPROVAL_EMAIL === '1') return;
    const { default: ticketApprovalService } = await import('./ticketApprovalService.js');
    const openRows = await prisma.ticketApproval.findMany({ where: { requestGroupId: question.requestGroupId, status: { in: OPEN_STATUSES } } });
    const notified = new Set();
    for (const row of openRows) {
      if (lc(row.approverEmail) === lc(answer.authorEmail)) continue;
      notified.add(lc(row.approverEmail));
      try {
        await ticketApprovalService.reissueLinkWithAnswer(row, { question: question.bodyText, answer: answer.bodyText, answeredBy: name });
      } catch (err) {
        logger.warn(`Answer notification to ${row.approverEmail} failed (non-fatal): ${err.message}`);
      }
    }
    // The person who asked, when they no longer hold an open row (e.g. Tier 1 who escalated), still gets the answer.
    const asker = lc(question.authorEmail);
    if (asker && !notified.has(asker) && asker !== lc(answer.authorEmail) && looksLikeEmail(asker)) {
      try {
        const { deliverTransactionalEmail } = await import('./transactionalEmailService.js');
        const ticket = parts.ticket;
        const ref = ticket ? ticketDisplayRef(ticket) : '';
        const html = renderApprovalMessageEmail({
          kind: 'answer', audience: answer.audience, authorName: name, authorRole: answer.authorRole,
          recipient: { email: asker }, ticket: { ref, subject: ticket?.subject || null },
          bodyHtml: answer.bodyHtml, bodyText: answer.bodyText, thread: [this._shape(question)], replyUrl: null, canReplyByEmail: false,
          internalNote: answer.audience === 'internal',
        });
        await deliverTransactionalEmail({ workspaceId: approval.workspaceId, to: [asker], subject: `Answer on ${ticket?.subject || 'ticket'} [${ref}]`, html, label: 'approval answer' });
      } catch (err) {
        logger.warn(`Answer notification to asker ${asker} failed (non-fatal): ${err.message}`);
      }
    }
  }

  _broadcast(approval) {
    Promise.resolve().then(async () => {
      const { default: ticketApprovalService } = await import('./ticketApprovalService.js');
      const ticket = await prisma.ticket.findUnique({ where: { id: approval.ticketId }, select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true } });
      if (ticket) ticketApprovalService._broadcast(ticket, 'approval');
    }).catch(() => {});
  }
}

export default new ApprovalConversationService();
export { ApprovalConversationService };
