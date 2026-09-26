/**
 * Auto-help delivery (P1, plans/AUTO_HELP_P1_PLAN.md §1–2): everything that
 * turns a drafted run into something a requester reads.
 *
 *   stageRun          approve mode: a drafted, fully-gated categorized run
 *                     becomes a TicketProposedReply (source 'auto_help') the
 *                     agent sees as "Auto-help suggests". Never overwrites a
 *                     human draft (one open proposal per ticket — theirs wins).
 *   proposalContext   what the ticket's card shows: playbook, confidence,
 *                     cited sources, the disclosure line and the follow-up
 *                     promise with real dates (business calendar).
 *   sendProposal      Send / Edit & send: the agent is the author; the reply
 *                     goes through ticketService.addReply (TP-born mail lane
 *                     or the FreshService reply lane for FS-born tickets) with
 *                     the disclosure line and the follow-up footer. Records
 *                     agent_sent / agent_edited_sent (+ normalized edit
 *                     distance), then parks the ticket (kind 'auto_help')
 *                     until the check-in date.
 *   dismissProposal   Dismiss with a one-tap reason (agent_dismissed).
 *
 * Auto mode would send from here as Ticket Pulse, but only when the playbook
 * service says the effective mode is 'auto' — which it never does in this
 * build (AUTO_MODE_BUILD_ENABLED = false).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import businessCalendarService from './businessCalendarService.js';
import statusService from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import ticketParkService, { AUTO_HELP_PARK_KIND } from './ticketParkService.js';
import autoHelpPlaybookService, { normalizeFollowUp } from './autoHelpPlaybookService.js';
import {
  AUTO_SEND_INELIGIBLE_GATES, GATE, buildPreview, disclosureLine, followUpFooter, sanitizeDraftHtml, urlsIn,
} from './autoHelpRunner.js';
import { htmlToText } from './knowledgeArticleService.js';
import { DECISIONS, DISMISS_REASON_VALUES, PRE_SEND_OUTCOMES, editDistance } from './autoHelpOutcomes.js';
import { emitAutoHelpEvent } from './autoHelpEvents.js';
import autoHelpAckMergeService, { mergeAckIntoMail } from './autoHelpAckMergeService.js';

export const AUTO_HELP_SOURCE = 'auto_help';
export const AUTO_HELP_ACTOR = Object.freeze({ name: 'Ticket Pulse (Auto-help)', email: null, role: 'automation' });
const FALLBACK_TIMEZONE = 'America/Los_Angeles';
const STAGEABLE_GATES = Object.freeze([GATE.SHADOW_RECORDED, GATE.PLAYBOOK_ONLY]);
const MAX_EDITED_HTML = 60000;

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function actorLabel(actor) {
  return actor?.name || actor?.email || 'Ticket Pulse';
}

/** The proposal's confidence column is a word (low | medium | high). */
export function confidenceWord(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  if (n >= 0.85) return 'high';
  if (n >= 0.7) return 'medium';
  return 'low';
}

function refusal(message, code) {
  const err = new ValidationError(message);
  err.code = code;
  return err;
}

/**
 * The start of a message as plain, normalized words — how Auto-help
 * recognises its own sends (and FreshService's synced copy of them, which
 * the API-key owner "authors") in the thread.
 */
export function ownEntrySnippet(text, max = 120) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** The idempotency key of a run's answer (attempt 2+ get ":<n>"). */
export function answerKey(runId) {
  return `auto-help:${runId}:answer`;
}

/**
 * Whether ticketService.addReply actually reached the requester. The
 * FreshService API lane counts once FreshService took the reply (it mails the
 * requester itself); the Ticket Pulse lanes (TP-born, FS-born via TP) need
 * email.sent. A deduped twin is not a delivery.
 */
export function replyDelivered(reply) {
  const email = reply?.email;
  if (!email) return false;
  if (email.via === 'freshservice') return true;
  return email.sent === true && email.deduped !== true;
}

export function undeliveredWhy(reply) {
  const e = reply?.email || {};
  if (e.skipped === 'unattended_requester') return 'the requester is an unattended mailbox';
  if (e.deduped) return 'the same message was sent moments ago';
  if (e.error) return `mail error: ${String(e.error).slice(0, 120)}`;
  return 'no e-mail address or mail lane';
}

function failedSendIds(run) {
  const list = run?.outcomeDetail?.failedSends;
  return Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : [];
}

/** Thread entries carrying `keyBase` (any attempt, any age), newest first. */
export async function keyedEntries(ticketId, keyBase) {
  const rows = await Promise.resolve()
    .then(() => prisma.ticketThreadEntry.findMany({
      where: { ticketId: Number(ticketId), source: 'ticketpulse_user', eventType: 'reply' },
      orderBy: { id: 'desc' },
      take: 200,
    }))
    .catch(() => []);
  return (rows || []).filter((e) => {
    const k = e?.rawPayload && typeof e.rawPayload === 'object' ? e.rawPayload.idempotencyKey : null;
    return typeof k === 'string' && (k === keyBase || k.startsWith(`${keyBase}:`));
  });
}

/**
 * PROOF that a stored reply entry reached the requester — the entry alone
 * is not (ticketService writes it before the ticket update, the sender
 * name lookup and the mail send, any of which can throw):
 *   Ticket Pulse mail lanes: the outbound Message-ID stored on the entry, or
 *     the notification_deliveries row 'native-reply:<entryId>' with status sent;
 *   FreshService API lane: FreshService's conversation id on the entry
 *     (externalEntryId), unless a failed delivery row says the mail did not go.
 */
export async function entryDelivered(entry) {
  if (!entry?.id) return false;
  if (entry.emailMessageId) return true;
  const delivery = await Promise.resolve()
    .then(() => prisma.notificationDelivery.findFirst({ where: { dedupeKey: `native-reply:${entry.id}` }, select: { id: true, status: true } }))
    .catch(() => null);
  if (delivery?.status === 'sent') return true;
  if (delivery && delivery.status !== 'sent') return false;
  return Boolean(entry.externalEntryId) && isFsApiLaneEntry(entry);
}

/**
 * The FreshService API lane stamps its entry in one write: FreshService's
 * conversation id, mirrorState 'mirrored' and mirroredAt === occurredAt.
 * The FS-born-via-Ticket-Pulse lane gets its FreshService id later (the
 * record-on-FreshService step runs whether or not the mail went out), so its
 * id is never proof of delivery.
 */
export function isFsApiLaneEntry(entry) {
  if (!entry?.externalEntryId || entry.mirrorState !== 'mirrored' || !entry.mirroredAt || !entry.occurredAt) return false;
  return new Date(entry.mirroredAt).getTime() === new Date(entry.occurredAt).getTime();
}

/** A keyed entry, not a recorded failed attempt, WITH proof of delivery. */
export async function findKeyedEntry(ticketId, keyBase, failedIds = []) {
  for (const e of await keyedEntries(ticketId, keyBase)) {
    if (failedIds.includes(Number(e.id))) continue;
    if (await entryDelivered(e)) return e;
  }
  return null;
}

/** Appends one step to run.outcomeDetail.history (kept small). */
export function withHistory(detail, step, extra = {}, at = new Date()) {
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? { ...detail } : {};
  const history = Array.isArray(d.history) ? d.history.slice(-40) : [];
  history.push({ at: at.toISOString(), step, ...extra });
  return { ...d, history };
}

/** Mon–Fri 08:00–17:00 in the workspace zone, for workspaces without business hours. */
async function fallbackCalendar(workspaceId) {
  const ws = await Promise.resolve()
    .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { defaultTimezone: true } }))
    .catch(() => null);
  return {
    timezone: ws?.defaultTimezone || FALLBACK_TIMEZONE,
    byDay: new Map([1, 2, 3, 4, 5].map((d) => [d, { dayOfWeek: d, startTime: '08:00', endTime: '17:00' }])),
    isHolidayDate: () => false,
    fallback: true,
  };
}

class AutoHelpDeliveryService {
  // ---------- business-day dates ----------

  async calendarFor(workspaceId) {
    const cal = await Promise.resolve().then(() => businessCalendarService.loadCalendar(Number(workspaceId))).catch(() => null);
    return cal || fallbackCalendar(workspaceId);
  }

  /**
   * `from` + N working days (holidays and closed days skipped whole), moved to
   * the next business-hours instant so a check-in never lands at 23:00.
   */
  async addBusinessDays(workspaceId, from, days, calendar = undefined) {
    const cal = calendar !== undefined ? calendar : await this.calendarFor(workspaceId);
    const at = await businessCalendarService.addBusinessDayMinutes(new Date(from), Math.max(0, Number(days) || 0) * 1440, { workspaceId, calendar: cal });
    return businessCalendarService.nextBusinessInstant(at, { workspaceId, calendar: cal });
  }

  /** When the check-in and the close would happen for an answer sent at `from`. */
  async followUpDates(workspaceId, from, followUp) {
    const fu = normalizeFollowUp(followUp);
    const cal = await this.calendarFor(workspaceId);
    const nudgeAt = await this.addBusinessDays(workspaceId, from, fu.nudgeAfterBusinessDays, cal);
    const closeAt = await this.addBusinessDays(workspaceId, nudgeAt, fu.closeAfterBusinessDays, cal);
    return { nudgeAt, closeAt, onSilence: fu.onSilence, timezone: cal.timezone };
  }

  // ---------- staging (approve mode) ----------

  /**
   * A drafted categorized run of an approve/auto playbook. Returns the run
   * fields that changed (status / gateDecision / proposedReplyId / …) or null
   * when it stays a recorded draft for a reason already on the run.
   */
  async stageRun({ run, ticket, playbook, settings, mode, confidence, gateDecision, preview, body, autoSendEligible }) {
    if (!run?.id || !preview?.html) return null;
    const detail = withHistory(run.outcomeDetail, 'drafted', { mode });
    // Gates a staged answer must pass: grounded (not partial) and at the bar.
    if (!STAGEABLE_GATES.includes(gateDecision)) return null;
    const bar = Number(playbook.minConfidence ?? 0.8);
    if (confidence === null || confidence === undefined || Number(confidence) < bar) {
      const data = { gateDecision: GATE.BELOW_CONFIDENCE, outcomeDetail: safeJson({ ...detail, stage: { skipped: 'below_confidence', previousGate: gateDecision, bar } }) };
      await prisma.autoHelpRun.update({ where: { id: run.id }, data });
      return data;
    }

    // Auto mode (locked in this build): only a fully eligible answer, never
    // playbook-only / partial, and only while the build switch allows it and
    // the playbook is not sensitive (re-checked here, not only upstream).
    if (mode === 'auto' && autoSendEligible && !AUTO_SEND_INELIGIBLE_GATES.includes(gateDecision) && this._autoSendAllowed(playbook, settings)) {
      return this._autoSend({ run, ticket, playbook, settings, preview, body, detail });
    }

    const { default: ticketProposedReplyService } = await import('./ticketProposedReplyService.js');
    const proposal = await ticketProposedReplyService.create({
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      source: AUTO_HELP_SOURCE,
      autoHelpRunId: run.id,
      subject: preview.subject || null,
      bodyHtml: preview.html,
      bodyText: preview.text || null,
      confidence: confidenceWord(confidence),
      guardSummary: { autoHelp: true, playbookId: playbook.id, playbookVersion: playbook.version || 1 },
      supersede: false,
    });
    if (!proposal) {
      const data = { gateDecision: GATE.HUMAN_DRAFT_EXISTS, outcomeDetail: safeJson({ ...detail, stage: { skipped: 'human_draft_exists' } }) };
      await prisma.autoHelpRun.update({ where: { id: run.id }, data });
      return data;
    }
    const data = {
      status: 'staged',
      gateDecision: GATE.STAGED_FOR_AGENT,
      proposedReplyId: proposal.id,
      outcomeDetail: safeJson(withHistory(detail, 'staged', { proposalId: proposal.id })),
    };
    await prisma.autoHelpRun.update({ where: { id: run.id }, data });
    await this._activity(ticket.id, 'auto_help_staged', AUTO_HELP_ACTOR, {
      runId: run.id, playbookId: playbook.id, playbookName: playbook.name, confidence,
      note: `Auto-help suggested an answer (${playbook.name}) — waiting for an agent to send it`,
    });
    logger.info(`Auto-help staged run ${run.id} on ${ticketDisplayRef(ticket)} as proposal ${proposal.id}`);
    emitAutoHelpEvent('auto_help.staged', ticket.id, { runId: run.id, playbook: playbook.name, mode, confidence: confidence ?? null, proposalId: proposal.id });
    return data;
  }

  /** Auto sending right now: the build switch, a non-sensitive playbook, Auto-help on. */
  _autoSendAllowed(playbook, settings) {
    return autoHelpPlaybookService.autoModeAllowed() === true && playbook?.sensitive !== true && settings?.enabled === true;
  }

  /** Auto mode — unreachable in this build; kept honest and covered by tests with the switch stubbed on. */
  async _autoSend({ run, ticket, playbook, settings, preview, body, detail }) {
    if (!this._autoSendAllowed(playbook, settings)) {
      throw refusal('Auto sending is not allowed for this playbook', 'auto_help_auto_refused');
    }
    await this._assertSendable({ ticketId: ticket.id, workspaceId: ticket.workspaceId, playbook, settings, requireApprove: false });
    const sent = await this._deliver({
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      run: { ...run, outcomeDetail: detail },
      playbook,
      settings,
      answerHtml: body?.html || null,
      answerText: body?.text || null,
      subject: preview.subject,
      actor: AUTO_HELP_ACTOR,
      decision: DECISIONS.AUTO_SENT,
      distance: null,
    });
    return { status: 'sent', gateDecision: GATE.AUTO_SENT, decision: DECISIONS.AUTO_SENT, sentEntryId: sent.entryId };
  }

  // ---------- the card ----------

  async _run(workspaceId, runId) {
    if (!runId) return null;
    return Promise.resolve()
      .then(() => prisma.autoHelpRun.findFirst({ where: { id: Number(runId), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
  }

  async _playbook(workspaceId, playbookId) {
    if (!playbookId) return null;
    return Promise.resolve()
      .then(() => prisma.autoHelpPlaybook.findFirst({ where: { id: Number(playbookId), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
  }

  async _workspaceName(workspaceId) {
    const ws = await Promise.resolve()
      .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }))
      .catch(() => null);
    return ws?.name || null;
  }

  /**
   * The Auto-help half of a proposal as the ticket card needs it. Returns
   * null when the run is gone (the card then falls back to the plain view).
   */
  async proposalContext(workspaceId, proposal) {
    const run = await this._run(workspaceId, proposal?.autoHelpRunId);
    if (!run) return null;
    const [playbook, settings, workspaceName] = await Promise.all([
      this._playbook(workspaceId, run.playbookId),
      autoHelpPlaybookService.getSettings(workspaceId),
      this._workspaceName(workspaceId),
    ]);
    const followUp = normalizeFollowUp(playbook?.followUp);
    const dates = await this.followUpDates(workspaceId, new Date(), followUp).catch(() => null);
    const body = run.transcript?.body || {};
    const sources = (Array.isArray(run.sources) ? run.sources : []).filter((s) => s?.cited);
    return safeJson({
      runId: run.id,
      playbookId: run.playbookId,
      playbookName: playbook?.name || null,
      playbookVersion: run.playbookVersion,
      sensitive: playbook?.sensitive === true,
      confidence: run.confidence,
      minConfidence: playbook?.minConfidence ?? null,
      gateDecision: run.gateDecision,
      sources: sources.map((s) => ({
        sourceId: s.sourceId, type: s.type, id: s.id, title: s.title, section: s.section || null, ref: s.ref || null,
        url: s.url || null, stale: s.stale === true,
      })),
      subject: run.draftSubject || proposal.subject || null,
      answerHtml: body.html || null,
      answerText: body.text || null,
      disclosure: disclosureLine(settings, workspaceName),
      footer: followUpFooter(followUp),
      followUp: {
        ...followUp,
        nudgeAt: dates?.nudgeAt || null,
        closeAt: dates?.closeAt || null,
        timezone: dates?.timezone || null,
      },
      dismissReasons: DISMISS_REASON_VALUES,
    });
  }

  // ---------- send / dismiss ----------

  /**
   * Claim a proposal for sending (double-click / two agents): only one caller
   * moves it from 'proposed' to 'sending'.
   */
  async _claim(proposal, { confirmResend = false } = {}) {
    const res = await prisma.ticketProposedReply.updateMany({
      where: { id: proposal.id, status: confirmResend ? { in: ['proposed', 'needs_check'] } : 'proposed' },
      data: { status: 'sending', decidedAt: new Date() },
    });
    if (!res.count) {
      if (proposal.status === 'needs_check') throw refusal('We couldn\'t confirm the answer went out — check the ticket in FreshService, then confirm to send again.', 'auto_help_needs_check');
      throw new ValidationError('This suggestion was already sent or dismissed');
    }
  }

  /**
   * Whether an Auto-help answer may go to this requester right now. Refuses
   * (with words an agent can act on) a resolved / closed / deleted / spam /
   * noise / merged ticket, Auto-help switched off, approve mode off (for the
   * approve path), and a playbook that was deleted or switched off.
   */
  async _assertSendable({ ticketId, workspaceId, playbook, settings, requireApprove = true }) {
    const ticket = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({
        where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
        select: { id: true, status: true, isNoise: true, origin: true, requester: { select: { email: true, unattended: true } } },
      }))
      .catch(() => null);
    if (!ticket) throw new NotFoundError('Ticket not found');
    // An answer nobody receives must never start a loop that closes the ticket on "silence".
    if (ticket.requester?.unattended === true) throw refusal('The requester is an unattended mailbox — replies to it are not e-mailed, so Auto-help does not answer it', 'auto_help_requester_unattended');
    if (!String(ticket.requester?.email || '').trim()) throw refusal('The requester has no e-mail address — Auto-help cannot answer this ticket', 'auto_help_requester_no_email');
    if (['Deleted', 'Spam'].includes(ticket.status)) throw refusal('This ticket was deleted or marked as spam — the Auto-help answer was not sent', 'auto_help_ticket_closed');
    if (ticket.isNoise === true) throw refusal('This ticket is marked as noise — the Auto-help answer was not sent', 'auto_help_ticket_noise');
    const base = await Promise.resolve().then(() => statusService.resolveBaseStatus(Number(workspaceId), ticket.status)).catch(() => null);
    if (base === 'Resolved' || base === 'Closed') throw refusal('This ticket is already resolved — the Auto-help answer was not sent. Reopen it first if the requester still needs it.', 'auto_help_ticket_closed');
    const merged = await Promise.resolve()
      .then(() => prisma.ticketLink.findFirst({ where: { ticketId: Number(ticketId), kind: 'merged_into' }, select: { id: true } }))
      .catch(() => null);
    if (merged) throw refusal('This ticket was merged into another one — the Auto-help answer was not sent', 'auto_help_ticket_merged');
    if (!settings?.enabled) throw refusal('Auto-help is switched off for this workspace — the answer was not sent', 'auto_help_off');
    if (requireApprove && !settings?.approveModeEnabled) throw refusal('Approve mode is switched off for this workspace — the answer was not sent', 'auto_help_approve_off');
    if (!playbook) throw refusal('The playbook behind this suggestion was deleted — the answer was not sent', 'auto_help_playbook_missing');
    if (playbook.enabled !== true) throw refusal(`The playbook "${playbook.name}" is switched off — the answer was not sent`, 'auto_help_playbook_off');
    return ticket;
  }

  /**
   * Send / Edit & send. `bodyHtml` (optional) is the agent's edit of the
   * ANSWER only — the disclosure line and the follow-up footer are added here,
   * so an edit can never drop them.
   */
  async sendProposal({ ticketId, workspaceId, proposal, bodyHtml = null, bodyText = null, actor, confirmResend = false }) {
    const run = await this._run(workspaceId, proposal.autoHelpRunId);
    if (!run) throw new NotFoundError('The Auto-help run behind this suggestion is gone');
    if (run.decision) throw new ValidationError('This suggestion was already decided');
    // W1/W2: withdrawn by the morning settle, or set aside for an agent's own reply.
    if (Object.values(PRE_SEND_OUTCOMES).includes(run.outcome)) {
      throw refusal(run.outcome === PRE_SEND_OUTCOMES.WITHDRAWN
        ? 'Auto-help withdrew this suggestion (the ticket was recategorized) — it was not sent'
        : 'This suggestion was set aside because someone already replied — it was not sent', 'auto_help_withdrawn');
    }
    const playbook = await this._playbook(workspaceId, run.playbookId);
    const settings = await autoHelpPlaybookService.getSettings(workspaceId);
    await this._assertSendable({ ticketId, workspaceId, playbook, settings, requireApprove: true });
    const original = run.transcript?.body || {};
    const originalText = original.text || htmlToText(original.html || '') || '';

    let answerHtml = original.html || null;
    let answerText = originalText;
    let distance = 0;
    const edited = String(bodyHtml || '').trim() || String(bodyText || '').trim();
    if (edited) {
      if (String(bodyHtml || '').length > MAX_EDITED_HTML) throw new ValidationError('The edited answer is too long');
      const rawHtml = String(bodyHtml || '').trim() || String(bodyText).trim().split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('');
      // Same sanitizer as the drafts (no scripts, handlers, images or odd
      // schemes); the agent's own http(s) links and the draft's stay.
      answerHtml = sanitizeDraftHtml(rawHtml, new Set([...urlsIn(rawHtml), ...urlsIn(original.html || '')]));
      answerText = htmlToText(answerHtml) || '';
      if (!answerHtml || !answerText.trim()) throw new ValidationError('The answer is empty');
      distance = editDistance(originalText, answerText);
    }
    if (!answerHtml) throw new ValidationError('Nothing to send');
    const decision = distance > 0 ? DECISIONS.EDITED_SENT : DECISIONS.SENT;

    await this._claim(proposal, { confirmResend });
    // A confirmed resend after "couldn't confirm": FreshService is checked
    // again from the first attempt's time before anything is mailed.
    const firstAttemptAt = confirmResend && proposal.status === 'needs_check'
      ? (((run.outcomeDetail?.history || []).find((h) => ['send_threw', 'send_not_delivered'].includes(h.step))?.at) || proposal.createdAt || null)
      : null;
    let sent;
    try {
      sent = await this._send({
        ticketId, workspaceId, run, playbook, settings, answerHtml, answerText,
        subject: run.draftSubject || proposal.subject, actor, checkFreshServiceSince: firstAttemptAt,
      });
    } catch (err) {
      // addReply itself failed: nothing went out, so the suggestion comes
      // back — or, when we cannot tell (FreshService lane, thread not
      // readable), it waits for a person to check first ('needs_check').
      const status = err?.code === 'auto_help_needs_check' ? 'needs_check' : 'proposed';
      await prisma.ticketProposedReply.updateMany({ where: { id: proposal.id, status: 'sending' }, data: { status, decidedAt: null } }).catch(() => {});
      throw err;
    }
    // It went out. From here nothing may give the suggestion back (a retry
    // would mail the requester twice): record-keeping failures are logged
    // and recovered by the sweep, never rethrown.
    const recorded = await this._recordSent({ ticketId, workspaceId, run, playbook, sent, actor, decision, distance });
    const updated = await Promise.resolve().then(() => prisma.ticketProposedReply.update({
      where: { id: proposal.id },
      data: {
        status: 'sent',
        decidedBy: actor?.email || actor?.name || 'agent',
        decidedAt: new Date(),
        sentThreadEntryId: sent.entryId,
        bodyHtml: sent.html,
        bodyText: sent.text,
      },
    })).catch((err) => {
      logger.error(`Auto-help: proposal ${proposal.id} was sent but not marked sent (${err.message}) — the sweep will mark it`);
      return { ...proposal, status: 'sending' };
    });
    return { proposal: updated, reply: sent.reply, decision, editDistance: decision === DECISIONS.EDITED_SENT ? distance : 0, park: recorded.park };
  }

  /**
   * The one send path (approve Send, and auto when ever allowed): the send
   * (_send, which may throw — nothing went out) then the record-keeping
   * (_recordSent, which never throws — it went out).
   */
  async _deliver({ ticketId, workspaceId, run, playbook, settings, answerHtml, answerText, subject, actor, decision, distance }) {
    const sent = await this._send({ ticketId, workspaceId, run, playbook, settings, answerHtml, answerText, subject, actor });
    const recorded = await this._recordSent({ ticketId, workspaceId, run, playbook, sent, actor, decision, distance });
    return { ...sent, park: recorded.park };
  }

  /**
   * Reply with disclosure + answer + footer as `actor`. The idempotency key is
   * per run, so a retried request inside the reply path's window hands back
   * the entry that already went out instead of mailing again.
   */
  async _send({ ticketId, workspaceId, run, playbook, settings, answerHtml, answerText, subject, actor, checkFreshServiceSince = null }) {
    const workspaceName = await this._workspaceName(workspaceId);
    const followUp = normalizeFollowUp(playbook?.followUp);
    const mail = buildPreview({ subject, html: answerHtml, text: answerText, settings, workspaceName, followUp });
    // "I checked — send again" on a FreshService ticket: look at FreshService
    // once more first; if the earlier attempt did land, record it, mail nothing.
    if (checkFreshServiceSince) {
      const landed = await this._landedOnFreshService(ticketId, workspaceId, answerText, checkFreshServiceSince);
      if (landed?.id) {
        logger.warn(`Auto-help run ${run.id}: confirmed resend, but FreshService already has the answer (entry ${landed.id}) — recorded, not re-sent`);
        return { entryId: landed.id, entry: landed, reply: { entry: landed, email: { sent: true, via: 'freshservice', recovered: true } }, html: mail.html, text: mail.text, answerText, followUp, recovered: true };
      }
    }
    const keyBase = answerKey(run.id);
    const fresh = await Promise.resolve().then(() => prisma.autoHelpRun.findFirst({ where: { id: run.id } })).catch(() => null);
    const failed = failedSendIds(fresh ?? run);

    // Idempotency beyond the reply path's 60 s window: an entry carrying this
    // run's key that is not a recorded failed attempt means the answer
    // already went out (a save / record step failed after it) — never mail again.
    const prior = await findKeyedEntry(ticketId, keyBase, failed);
    if (prior) {
      logger.warn(`Auto-help run ${run.id}: answer already on the thread (entry ${prior.id}) — recorded, not re-sent`);
      return { entryId: prior.id, entry: prior, reply: { entry: prior, email: { sent: true, recovered: true } }, html: prior.bodyHtml || mail.html, text: prior.bodyText || mail.text, answerText, followUp, recovered: true };
    }
    // Keyed entries WITHOUT proof of delivery are earlier attempts that died
    // between the entry and the mail: failed, so this attempt really sends.
    const unproven = (await keyedEntries(ticketId, keyBase)).map((e) => Number(e.id)).filter((id) => !failed.includes(id));
    if (unproven.length) failed.push(...unproven);
    const key = `${keyBase}:${failed.length + 1}`;
    const startedAt = new Date();
    // Ack merge (W3): a "Ticket arrived" ack held back for this answer rides
    // on top of it — one e-mail. Taken now, confirmed only once the answer
    // went out, given back to its workflow if the send fails.
    const heldAck = await Promise.resolve().then(() => autoHelpAckMergeService.takeForAnswer(ticketId, { runId: run.id })).catch(() => null);
    const outgoing = heldAck ? mergeAckIntoMail(mail, heldAck.ackText) : mail;
    const automated = actor?.role === 'automation';
    const replyOptions = {
      // W2: the first reply is Auto-help's grounded answer (even when an agent clicks Send).
      replyOwner: { kind: 'auto_help', ref: `run:${run.id}` },
      // W4: an auto-sent answer never stops the first-response clock unless the workspace says so.
      ...(automated ? { automatedReply: { kind: 'answer', countsAsFirstResponse: settings?.countsAsFirstResponse === true } } : {}),
    };
    const { default: ticketService } = await import('./ticketService.js');
    let reply;
    try {
      reply = await ticketService.addReply(Number(ticketId), Number(workspaceId), { bodyHtml: outgoing.html, bodyText: outgoing.text, idempotencyKey: failed.length ? key : keyBase }, actor, [], replyOptions);
    } catch (err) {
      if (heldAck) await autoHelpAckMergeService.giveBack(heldAck.id);
      // FreshService API lane: FreshService may have taken the reply (and
      // mailed the requester) before the local save failed — then it is sent.
      const landed = await this._landedOnFreshService(ticketId, workspaceId, answerText, startedAt);
      if (landed && landed.id) {
        logger.warn(`Auto-help run ${run.id}: local save failed (${err.message}) but FreshService has the answer (entry ${landed.id}) — recorded as sent`);
        return { entryId: landed.id, entry: landed, reply: { entry: landed, email: { sent: true, via: 'freshservice', recovered: true } }, html: mail.html, text: mail.text, answerText, followUp, recovered: true };
      }
      // An entry of THIS attempt may exist (the throw came after it): it is a failed attempt.
      const mine = (await keyedEntries(ticketId, keyBase)).filter((e) => !failed.includes(Number(e.id)));
      const stillUnproven = [];
      for (const e of mine) if (!(await entryDelivered(e))) stillUnproven.push(Number(e.id));
      await this._recordFailedSends(run, fresh, [...failed, ...stillUnproven], 'send_threw', String(err.message).slice(0, 200));
      if (landed?.pullFailed && !mine.length) {
        // FreshService lane: the call failed (e.g. timed out) and we cannot
        // see FreshService's thread — it may have gone out. Never resend blind.
        throw refusal('We couldn\'t confirm the answer went out — check the ticket in FreshService before sending again.', 'auto_help_needs_check');
      }
      throw err;
    }
    const entry = reply?.entry ?? null;
    if (heldAck) {
      if (replyDelivered(reply)) await autoHelpAckMergeService.confirmMerged(heldAck.id, run.id);
      else await autoHelpAckMergeService.giveBack(heldAck.id);
    }
    if (!replyDelivered(reply)) {
      // The entry is on the thread but the requester got nothing (mail lane
      // failed, unattended, no address): a FAILURE — no 'sent', no park, no
      // loop that would close the ticket on a silence nobody could break.
      if (entry?.id) await this._recordFailedSends(run, fresh, [...failed, entry.id], 'send_not_delivered', undeliveredWhy(reply));
      throw refusal(`The answer was added to the ticket but the e-mail to the requester did not go out (${undeliveredWhy(reply)}). Nothing was scheduled — try again, or reply yourself.`, 'auto_help_not_delivered');
    }
    return { entryId: entry?.id ?? reply?.id ?? null, entry, reply, html: outgoing.html, text: outgoing.text, answerText, followUp, ...(heldAck ? { ackMerged: heldAck.id } : {}) };
  }

  async _recordFailedSends(run, fresh, ids, step, why) {
    const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
    await Promise.resolve().then(() => prisma.autoHelpRun.update({
      where: { id: run.id },
      data: { outcomeDetail: safeJson(withHistory({ ...((fresh ?? run).outcomeDetail || {}), failedSends: unique }, step, { why })) },
    })).catch((e) => logger.warn(`Auto-help run ${run.id}: failed attempt not recorded (${e.message})`));
  }

  /**
   * FS-born: after a failed send, does FreshService already hold this answer?
   * Returns the entry, null (pulled, not there), or { pullFailed: true }.
   */
  async _landedOnFreshService(ticketId, workspaceId, answerText, since) {
    const ticket = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({ where: { id: Number(ticketId) }, select: { id: true, origin: true } }))
      .catch(() => null);
    if (!ticket || ticket.origin === 'ticketpulse') return null;
    try {
      const { default: fsThreadPullService } = await import('./fsThreadPullService.js');
      await Promise.race([
        Promise.resolve().then(() => fsThreadPullService.pull(ticket.id)),
        new Promise((_r, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 20000); t.unref?.(); }),
      ]);
    } catch {
      return { pullFailed: true };
    }
    const snippet = ownEntrySnippet(answerText);
    if (!snippet || snippet.length < 20) return null;
    const rows = await Promise.resolve()
      .then(() => prisma.ticketThreadEntry.findMany({
        where: { ticketId: ticket.id, occurredAt: { gte: new Date(new Date(since).getTime() - 60e3) }, OR: [{ eventType: 'public_reply' }, { eventType: 'reply' }] },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      }))
      .catch(() => []);
    return (rows || []).find((e) => ownEntrySnippet(e.bodyText || e.content || '', 100000).includes(snippet)) || null;
  }

  /**
   * After the answer went out: the decision on the run (claimed — only once),
   * the follow-up plan frozen as promised (nudge/close days, texts, what
   * silence and a "still broken" reply do, the dates, the assignee), the
   * ticket history line and the park. Never throws.
   */
  async _recordSent({ ticketId, workspaceId, run, playbook, sent, actor, decision, distance }) {
    const now = new Date();
    const followUp = sent.followUp || normalizeFollowUp(playbook?.followUp);
    let dates = null;
    try {
      dates = await this.followUpDates(workspaceId, now, followUp);
    } catch (err) {
      logger.warn(`Auto-help: follow-up dates for ticket ${ticketId} not computed (${err.message})`);
    }
    const assignee = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({ where: { id: Number(ticketId) }, select: { assignedTechId: true } }))
      .catch(() => null);
    const plan = {
      ...followUp,
      onHelp: playbook?.onHelp || 'assign_normally',
      nudgeAt: dates?.nudgeAt ? dates.nudgeAt.toISOString() : null,
      closeAt: dates?.closeAt ? dates.closeAt.toISOString() : null,
      assignedTechId: assignee?.assignedTechId ?? null,
      playbookVersion: playbook?.version ?? run.playbookVersion ?? null,
      frozenAt: now.toISOString(),
    };
    let detail = withHistory(run.outcomeDetail, 'sent', { by: actorLabel(actor), decision, ...(distance !== null ? { editDistance: distance } : {}) }, now);
    detail = {
      ...detail,
      ownEntries: [{ entryId: sent.entryId ?? null, externalEntryId: sent.entry?.externalEntryId ?? null, snippet: ownEntrySnippet(sent.answerText) }],
    };
    try {
      const res = await prisma.autoHelpRun.updateMany({
        where: { id: run.id, decision: null },
        data: {
          status: 'sent',
          decision,
          decidedAt: now,
          decidedBy: actor?.email || actor?.name || null,
          editDistance: distance,
          sentEntryId: sent.entryId,
          followUpPlan: safeJson(plan),
          outcomeDetail: safeJson(detail),
        },
      });
      if (!res.count) logger.warn(`Auto-help: run ${run.id} already had a decision when its send was recorded`);
    } catch (err) {
      logger.error(`Auto-help: run ${run.id} was sent but its decision was not recorded (${err.message})`);
    }
    await this._activity(ticketId, 'auto_help_sent', actor, {
      runId: run.id, playbookName: playbook?.name || null, decision,
      note: decision === DECISIONS.EDITED_SENT ? 'Sent the Auto-help answer, edited first' : decision === DECISIONS.AUTO_SENT ? 'Auto-help sent its answer' : 'Sent the Auto-help answer',
    });
    emitAutoHelpEvent('auto_help.answered', Number(ticketId), {
      runId: run.id, playbook: playbook?.name || null, decision, by: actorLabel(actor), ackMerged: Boolean(sent.ackMerged),
    });

    // The follow-up loop: wait for the requester until the check-in date.
    let park = null;
    try {
      if (!dates) throw new Error('no follow-up dates');
      park = await ticketParkService.park(Number(ticketId), Number(workspaceId), {
        kind: AUTO_HELP_PARK_KIND,
        until: dates.nudgeAt,
        reason: `Auto-help answered — checking in with the requester ${dates.nudgeAt.toISOString().slice(0, 10)} if there is no reply`,
      }, AUTO_HELP_ACTOR, { source: 'auto_help' });
      detail = withHistory(detail, 'parked', { until: dates.nudgeAt.toISOString(), parkId: park?.park?.id ?? null });
      await prisma.autoHelpRun.update({ where: { id: run.id }, data: { outcomeDetail: safeJson({ ...detail, parkId: park?.park?.id ?? null }) } })
        .catch((err) => logger.warn(`Auto-help: park of run ${run.id} not recorded (${err.message})`));
    } catch (err) {
      // The answer went out; without the park a person follows up as usual.
      logger.warn(`Auto-help: ticket ${ticketId} was answered but not parked (${err.message})`);
      detail = withHistory(detail, 'park_failed', { error: String(err.message).slice(0, 300) });
      await prisma.autoHelpRun.update({ where: { id: run.id }, data: { outcomeDetail: safeJson(detail) } }).catch(() => {});
    }
    return { park, plan };
  }

  async dismissProposal({ ticketId, workspaceId, proposal, reason, actor }) {
    const r = String(reason || '').trim();
    if (!DISMISS_REASON_VALUES.includes(r)) throw new ValidationError(`Say why: ${DISMISS_REASON_VALUES.join(', ')}`);
    const res = await prisma.ticketProposedReply.updateMany({
      where: { id: proposal.id, status: { in: ['proposed', 'needs_check'] } },
      data: { status: 'dismissed', decidedBy: actor?.email || actor?.name || 'agent', decidedAt: new Date() },
    });
    if (!res.count) throw new ValidationError('This suggestion was already sent or dismissed');
    const run = await this._run(workspaceId, proposal.autoHelpRunId);
    if (run && !run.decision) {
      await prisma.autoHelpRun.update({
        where: { id: run.id },
        data: {
          decision: DECISIONS.DISMISSED,
          decidedAt: new Date(),
          decidedBy: actor?.email || actor?.name || null,
          dismissReason: r,
          outcomeDetail: safeJson(withHistory(run.outcomeDetail, 'dismissed', { by: actorLabel(actor), reason: r })),
        },
      }).catch((err) => logger.warn(`Auto-help: dismissal of run ${run.id} not recorded (${err.message})`));
    }
    await this._activity(ticketId, 'auto_help_dismissed', actor, {
      runId: run?.id ?? null, reason: r, note: `Dismissed the Auto-help suggestion (${r.replace(/_/g, ' ')})`,
    });
    return prisma.ticketProposedReply.findFirst({ where: { id: proposal.id } });
  }

  async _activity(ticketId, activityType, actor, details) {
    await Promise.resolve()
      .then(() => ticketActivityRepository.create({
        ticketId: Number(ticketId),
        activityType,
        performedBy: actorLabel(actor),
        performedAt: new Date(),
        details: safeJson(details),
      }))
      .catch((err) => logger.warn(`Auto-help activity ${activityType} not written for ticket ${ticketId}: ${err.message}`));
  }
}

const autoHelpDeliveryService = new AutoHelpDeliveryService();
export default autoHelpDeliveryService;
export { AutoHelpDeliveryService };
