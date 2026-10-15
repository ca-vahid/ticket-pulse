/**
 * "When a requester replies": the reopen and the thank-you reading
 * (14 Oct 2026, plans/REQUESTER_REPLY_SETTINGS_PLAN.md — Vahid: "YES!").
 *
 * Settings → Ticket Ops → When a requester replies holds, per workspace
 * (requesterReplyRulesService):
 *
 *  - Which statuses reopen. A requester reply to a ticket in a ticked status
 *    puts it back to Open HERE, in code, before the workflows run — through
 *    the same write the "Reopen on requester reply" workflow used
 *    (notificationWorkflowEngine.executeUpdateTicketNode: origin-aware,
 *    ticket.reopened, the reopen counter, mirror, live update), recorded as
 *    Ticket Pulse. Saving it on archives that workflow (never deletes it) and
 *    the page names what it replaced.
 *  - A thank-you or out-of-office reply does not reopen. A reply to a
 *    Resolved / Closed ticket is read first: an out-of-office
 *    (isOutOfOfficeReply), the keyword fast path, then ONE model call
 *    (operation 'requester_reply_check', its own monthly limit — never
 *    Auto-help's cap). Only an explicit thank-you or out-of-office leaves the
 *    ticket closed; unclear, empty, failed, timed out or over the limit all
 *    reopen. When it stays closed the conversation gets one quiet line
 *    (a private Ticket Pulse note written straight to the thread: no e-mail,
 *    no Teams, no watcher, no workflow event, never mirrored).
 *
 * The reading rides on the event as event.extra.replyVerdict ('thanks',
 * 'auto_reply' or 'reply'); Auto-help's own verdict (autoHelpReplyVerdict,
 * set before this for a ticket Auto-help closed) is kept as it is and is
 * reused here instead of reading the reply twice. Where the workspace still
 * reopens through a workflow, that workflow's "Ignore a thank-you" step
 * switch honours replyVerdict too (conditionRuleShared.conditionSwitchStop).
 *
 * Never throws into the reply path: a reply is always recorded, and on any
 * doubt the ticket reopens as it did before.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { isFsSystemConversation } from '../utils/fsSystemConversation.js';
import { isOutOfOfficeReply, monthStartUtc } from './autoHelpOutcomes.js';
import {
  getRequesterReplyRules, recordRetiredWorkflows, forgetRetiredWorkflows,
  SUGGESTED_REOPEN_STATUSES, REPLY_CHECK_CAP_CHOICES,
} from './requesterReplyRulesService.js';

export const REPLY_CHECK_OPERATION = 'requester_reply_check';
/** The reading is awaited before the workflows run: short, and a timeout reopens. */
export const REPLY_CHECK_TIMEOUT_MS = 8000;
export const REPLY_VERDICTS = Object.freeze({ THANKS: 'thanks', AUTO_REPLY: 'auto_reply', REPLY: 'reply' });
const STAYS_CLOSED = Object.freeze([REPLY_VERDICTS.THANKS, REPLY_VERDICTS.AUTO_REPLY]);
const TERMINAL_BASES = Object.freeze(['Resolved', 'Closed']);
export const REOPEN_ACTOR = Object.freeze({ name: 'Ticket Pulse', kind: 'system', source: 'requester_reply' });
export const REOPEN_NOTE = 'Reopened automatically — the requester replied.';
export const QUIET_LINES = Object.freeze({
  thanks: 'Reply read as a thank-you; the ticket stays closed.',
  auto_reply: 'Reply read as an out-of-office; the ticket stays closed.',
});
export const STAYS_CLOSED_ACTIVITY = 'requester_reply_stays_closed';
/** FreshService-born reopen that failed: tried again this often, this many times in all. */
export const REOPEN_RETRY_MS = 2 * 60 * 1000;
export const REOPEN_MAX_ATTEMPTS = 3;
/** Nodes a reopen-only workflow may have besides its update_ticket step. */
const QUIET_NODE_TYPES = Object.freeze(['trigger', 'condition', 'branch', 'stop', 'delay']);

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Auto-help's reading of the same reply, in this page's words. */
export function autoHelpVerdictAsReply(verdict) {
  if (verdict === 'confirmed') return REPLY_VERDICTS.THANKS;
  if (verdict === 'auto_reply') return REPLY_VERDICTS.AUTO_REPLY;
  if (verdict === 'help') return REPLY_VERDICTS.REPLY;
  return null;
}

/** Is the ticket's status one the workspace ticked? Case-insensitive. */
export function statusIsTicked(rules, status) {
  const key = String(status ?? '').trim().toLowerCase();
  return Boolean(key) && (rules?.reopenStatuses || []).some((s) => String(s).trim().toLowerCase() === key);
}

const SETS_MORE_THAN_STATUS = ['setPriority', 'setInternalCategoryId', 'setInternalSubcategoryId', 'setCategoryName', 'setSubcategoryName', 'setInternalGroupId'];

function onlySetsStatus(data = {}) {
  if (SETS_MORE_THAN_STATUS.some((k) => data[k])) return false;
  if (data.assignTo && data.assignTo.mode && data.assignTo.mode !== 'none') return false;
  if (data.setCustomFields && typeof data.setCustomFields === 'object' && Object.keys(data.setCustomFields).length) return false;
  if ((Array.isArray(data.addTags) && data.addTags.length) || (Array.isArray(data.removeTags) && data.removeTags.length)) return false;
  return true;
}

/**
 * Is this a "reopen on requester reply" workflow? By its trigger and what it
 * does, never by id or name: trigger "Requester replied" and an update step
 * that sets the status to Open, in the version that runs (published).
 *   'reopen_only'  it does nothing else (conditions and stops aside) — the
 *                  page replaces it and archives it;
 *   'reopen_plus'  it also sends, assigns, tags … — left alone (archiving it
 *                  would lose the rest) and named on the page;
 *   null           not a reopen workflow, or never published.
 */
export function reopenWorkflowShape(workflow) {
  if (workflow?.triggerType !== 'ticket.reply_received') return null;
  if (!(Number(workflow.publishedVersion) > 0)) return null;
  const nodes = Array.isArray(workflow.publishedDefinition?.nodes) ? workflow.publishedDefinition.nodes : [];
  const reopens = nodes.filter((n) => n?.type === 'update_ticket' && String(n.data?.setStatus || '').trim().toLowerCase() === 'open');
  if (!reopens.length) return null;
  const otherWork = nodes.some((n) => !reopens.includes(n) && !QUIET_NODE_TYPES.includes(n?.type));
  return !otherWork && reopens.every((n) => onlySetsStatus(n.data)) ? 'reopen_only' : 'reopen_plus';
}

class RequesterReplyReopenService {
  constructor() {
    this._retryTimers = new Set();
  }

  /** The requester message this reply event was about (newRequestSuggestionService's lookup). */
  async _replyEntry(ticketId, extra = {}) {
    const select = {
      id: true, externalEntryId: true, source: true, eventType: true, authorType: true, incoming: true, isPrivate: true,
      bodyText: true, bodyHtml: true, content: true, title: true, occurredAt: true, rawPayload: true, actorName: true,
    };
    if (extra?.entryId) {
      const row = await soft(() => prisma.ticketThreadEntry.findFirst({ where: { id: Number(extra.entryId), ticketId }, select }));
      if (row) return row;
    }
    if (extra?.externalEntryId) {
      const row = await soft(() => prisma.ticketThreadEntry.findFirst({ where: { ticketId, externalEntryId: String(extra.externalEntryId) }, select }));
      if (row) return row;
    }
    return soft(() => prisma.ticketThreadEntry.findFirst({
      where: {
        ticketId,
        occurredAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
        OR: [{ eventType: 'customer_reply' }, { authorType: 'requester', eventType: 'reply' }],
        AND: [{ OR: [{ isPrivate: false }, { isPrivate: null }] }],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select,
    }));
  }

  /**
   * This month's spend on reading replies, against the workspace's own limit
   * (its line in ai_provider_attempts, operation requester_reply_check — not
   * Auto-help's cap, which can read as exhausted where Auto-help is off).
   * Spend that cannot be read counts as over the limit: the reply reopens.
   */
  async budgetState(workspaceId, rules = null) {
    const r = rules || await getRequesterReplyRules(workspaceId);
    const capUsd = Number(r.replyCheckMonthlyCapUsd) || 0;
    let rows;
    try {
      rows = await prisma.aiProviderAttempt.findMany({
        where: { workspaceId: Number(workspaceId), operation: REPLY_CHECK_OPERATION, startedAt: { gte: monthStartUtc() } },
        select: { provider: true, model: true, inputTokens: true, outputTokens: true, cacheCreationInputTokens: true, cacheReadInputTokens: true },
        take: 50000,
      });
    } catch (err) {
      logger.warn(`Reply reading: spend for workspace ${workspaceId} unknown (${err.message}) — replies reopen`);
      return { capUsd, spentUsd: null, checks: null, exhausted: true, unknown: true };
    }
    const { costUsdFor } = await import('./tokenUsageService.js');
    const spent = (rows || []).reduce((sum, a) => sum + (Number(costUsdFor({
      provider: a.provider,
      model: a.model,
      inputTokens: Number(a.inputTokens) || 0,
      outputTokens: Number(a.outputTokens) || 0,
      cacheCreationInputTokens: Number(a.cacheCreationInputTokens) || 0,
      cacheReadInputTokens: Number(a.cacheReadInputTokens) || 0,
    })) || 0), 0);
    const spentUsd = Math.round(spent * 1e4) / 1e4;
    return { capUsd, spentUsd, checks: (rows || []).length, exhausted: spentUsd >= capUsd };
  }

  /**
   * Read one reply to a closed ticket. { verdict: 'thanks' | 'auto_reply' |
   * 'reply', via, entryId? }. Never throws; every doubt is 'reply'.
   */
  async readReply(ticket, extra = {}, { rules = null, timeoutMs = REPLY_CHECK_TIMEOUT_MS } = {}) {
    try {
      const entry = await this._replyEntry(Number(ticket.id), extra);
      if (!entry) return { verdict: REPLY_VERDICTS.REPLY, via: 'no_reply_text' };
      if (entry.isPrivate === true || entry.authorType === 'system' || entry.eventType === 'activity' || isFsSystemConversation(entry)) {
        return { verdict: REPLY_VERDICTS.REPLY, via: 'not_a_reply', entryId: entry.id };
      }
      // Out-of-office first: headers when the mail kept them, else the text
      // (a FreshService-synced entry has neither headers nor a subject).
      if (isOutOfOfficeReply(entry)) return { verdict: REPLY_VERDICTS.AUTO_REPLY, via: 'auto_reply', entryId: entry.id };
      const text = entry.bodyText || entry.content || String(entry.bodyHtml || '').replace(/<[^>]*>/g, ' ');
      const { default: autoHelpFollowUp } = await import('./autoHelpFollowUpService.js');
      const read = await withTimeout(autoHelpFollowUp.classifyReply(ticket.workspaceId, text, {
        subject: ticket.subject || null,
        reader: 'person',
        operation: REPLY_CHECK_OPERATION,
        budgetState: (ws) => this.budgetState(ws, rules),
        timeoutMs,
      }), timeoutMs + 1000);
      if (read?.timedOut) return { verdict: REPLY_VERDICTS.REPLY, via: 'timeout', entryId: entry.id };
      return {
        verdict: read?.verdict === 'confirmed' ? REPLY_VERDICTS.THANKS : REPLY_VERDICTS.REPLY,
        via: read?.via || 'unknown',
        entryId: entry.id,
        ...(read?.reason ? { reason: read.reason } : {}),
      };
    } catch (err) {
      logger.warn(`Reply reading failed for ticket ${ticket?.id} (it reopens): ${err.message}`);
      return { verdict: REPLY_VERDICTS.REPLY, via: 'error' };
    }
  }

  /**
   * Before the workflows run on a requester reply (emitTicketEvent). Returns
   * null when the page is off in this workspace (nothing changes), otherwise
   * { replyVerdict, via, entryId, ticked, staysClosed, reopened, reason }.
   * `ticket` and `statusBase` are the ticket as the reply found it.
   */
  async beforeWorkflows({ ticket, statusBase = null, extra = {}, autoHelpVerdict = null } = {}) {
    if (!ticket?.id || !ticket?.workspaceId) return null;
    try {
      const rules = await getRequesterReplyRules(ticket.workspaceId);
      if (!rules.reopenOnReply && !rules.ignoreThanks) return null;
      if (extra?.isSurveyResponse === true || extra?.senderIsAgent === true) return { replyVerdict: null, reason: 'not_a_requester_reply' };

      const ticked = rules.reopenOnReply && statusIsTicked(rules, ticket.status);
      const closed = TERMINAL_BASES.includes(statusBase);
      let read = null;
      if (closed) {
        // Auto-help read this reply already (a ticket it closed in the last
        // 7 days): its verdict stands, as it did for the workflow.
        const fromAutoHelp = autoHelpVerdictAsReply(autoHelpVerdict);
        if (fromAutoHelp) read = { verdict: fromAutoHelp, via: 'auto_help' };
        // An agent forwarding mail onto the ticket is new information, never a thank-you.
        else if (rules.ignoreThanks && !extra?.forwardedBy && (ticked || !rules.reopenOnReply)) {
          read = await this.readReply(ticket, extra, { rules });
        }
      }
      const out = {
        replyVerdict: read?.verdict || null,
        via: read?.via || null,
        entryId: read?.entryId ?? null,
        ticked,
        staysClosed: Boolean(read && STAYS_CLOSED.includes(read.verdict)),
        reopened: false,
        reason: null,
      };
      if (out.staysClosed) return { ...out, reason: 'reads_as_' + out.replyVerdict };
      if (!rules.reopenOnReply) return { ...out, reason: 'workflow_reopens' };
      if (!ticked) return { ...out, reason: 'status_not_ticked' };
      // Auto-help is waiting on this requester: its loop reads the reply itself.
      if (ticket.parkKind === 'auto_help') return { ...out, reason: 'auto_help_waiting' };
      const result = await this.reopen(ticket);
      return { ...out, reopened: result.reopened, reason: result.reason };
    } catch (err) {
      logger.warn(`When a requester replies: skipped for ticket ${ticket.id} (${err.message})`);
      return null;
    }
  }

  /**
   * Status → Open through the update_ticket write (both origins). A
   * FreshService write that fails is tried again in REOPEN_RETRY_MS, up to
   * REOPEN_MAX_ATTEMPTS in all, while the ticket is still in a ticked status.
   */
  async reopen(ticket, { attempt = 1 } = {}) {
    const node = { id: 'requester-reply-reopen', type: 'update_ticket', data: { setStatus: 'Open', note: REOPEN_NOTE } };
    const eventContext = {
      ticket: { id: ticket.id, workspaceId: ticket.workspaceId },
      workspace: { id: ticket.workspaceId },
      event: { type: 'ticket.reply_received' },
    };
    try {
      const { executeUpdateTicketNode } = await import('./notificationWorkflowEngine.js');
      const res = await executeUpdateTicketNode(node, eventContext, { actor: REOPEN_ACTOR });
      const reopened = Boolean(res?.updated?.status || res?.applied);
      if (reopened) logger.info(`When a requester replies: ${ticketDisplayRef(ticket)} reopened (${ticket.status} → Open)`);
      return { reopened, reason: reopened ? 'reopened' : (res?.reason || 'no_change') };
    } catch (err) {
      logger.warn(`When a requester replies: ${ticketDisplayRef(ticket)} not reopened, attempt ${attempt} of ${REOPEN_MAX_ATTEMPTS} (${err.message})`);
      if (attempt < REOPEN_MAX_ATTEMPTS) this._retryLater(ticket, attempt + 1);
      return { reopened: false, reason: attempt < REOPEN_MAX_ATTEMPTS ? 'retry_scheduled' : 'reopen_failed' };
    }
  }

  _retryLater(ticket, attempt) {
    const timer = setTimeout(async () => {
      this._retryTimers.delete(timer);
      try {
        const current = await prisma.ticket.findFirst({
          where: { id: Number(ticket.id), workspaceId: Number(ticket.workspaceId) },
          select: { id: true, workspaceId: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
        });
        const rules = await getRequesterReplyRules(ticket.workspaceId);
        if (!current || !rules.reopenOnReply || !statusIsTicked(rules, current.status)) return;
        await this.reopen(current, { attempt });
      } catch (err) {
        logger.warn(`When a requester replies: retry for ticket ${ticket.id} failed (${err.message})`);
      }
    }, REOPEN_RETRY_MS);
    timer.unref?.();
    this._retryTimers.add(timer);
  }

  /**
   * After the workflows: a reply read as a thank-you or out-of-office on a
   * ticket that is STILL closed (the page left it, or the workflow's switch
   * did) gets the quiet line. Returns { staysClosed }.
   */
  async afterWorkflows({ ticket, handling, stamp = null } = {}) {
    if (!ticket?.id || !handling || !STAYS_CLOSED.includes(handling.replyVerdict)) return { staysClosed: false };
    try {
      const row = await prisma.ticket.findFirst({ where: { id: Number(ticket.id) }, select: { id: true, status: true } });
      const { default: statusService } = await import('./statusService.js');
      const base = await soft(() => statusService.resolveBaseStatus(ticket.workspaceId, row?.status ?? ticket.status));
      if (!TERMINAL_BASES.includes(base)) return { staysClosed: false };
      await this.writeQuietLine(ticket, { verdict: handling.replyVerdict, via: handling.via, replyEntryId: handling.entryId, stamp });
      return { staysClosed: true };
    } catch (err) {
      logger.warn(`When a requester replies: quiet line not written for ticket ${ticket.id} (${err.message})`);
      return { staysClosed: false };
    }
  }

  /**
   * One quiet line in the conversation: a private Ticket Pulse note written
   * straight to the thread (the Assetron-note pattern) — no e-mail, no Teams,
   * no watcher, no note_added workflow event, never mirrored to FreshService —
   * plus the history row, and open ticket pages refresh.
   */
  async writeQuietLine(ticket, { verdict, via = null, replyEntryId = null, stamp = null } = {}) {
    const text = QUIET_LINES[verdict];
    if (!text) return null;
    const now = new Date();
    const entry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: Number(ticket.id),
        workspaceId: Number(ticket.workspaceId),
        source: 'ticketpulse_user',
        eventType: 'note',
        actorName: 'Ticket Pulse',
        actorEmail: null,
        authorType: 'system',
        incoming: false,
        isPrivate: true,
        visibility: 'private',
        bodyText: text,
        content: text,
        occurredAt: now,
        mirrorState: null,
        rawPayload: { kind: 'reply_stays_closed', verdict, via, replyEntryId, ...(stamp ? { replyStamp: String(stamp) } : {}) },
      },
    });
    const { default: ticketActivityRepository } = await import('./ticketActivityRepository.js');
    await soft(() => ticketActivityRepository.create({
      ticketId: Number(ticket.id),
      activityType: STAYS_CLOSED_ACTIVITY,
      performedBy: 'Ticket Pulse',
      performedAt: now,
      details: { note: text, verdict, via, replyEntryId, actorKind: 'system', ...(stamp ? { replyStamp: String(stamp) } : {}) },
    }));
    import('../routes/sse.routes.js')
      .then(({ sseManager }) => sseManager?.broadcast?.('ticket-change', { action: 'update', workspaceId: ticket.workspaceId, ticketId: ticket.id }, ticket.workspaceId))
      .catch(() => {});
    logger.info(`When a requester replies: ${ticketDisplayRef(ticket)} stays closed (${verdict}, via ${via || 'unknown'})`);
    return entry;
  }

  // ---------- the workflow it replaces ----------

  /** Live "reopen on requester reply" workflows in a workspace (not archived), with their shape. */
  async reopenWorkflows(workspaceId) {
    const rows = await prisma.notificationWorkflow.findMany({
      where: { workspaceId: Number(workspaceId), triggerType: 'ticket.reply_received', archivedAt: null },
      select: {
        id: true, name: true, key: true, triggerType: true, isEnabled: true, isDefaultVariant: true,
        publishedVersion: true, publishedDefinition: true,
      },
      orderBy: { id: 'asc' },
    });
    return (rows || [])
      .map((w) => ({ id: w.id, name: w.name, isEnabled: w.isEnabled === true, isDefaultVariant: w.isDefaultVariant === true, shape: reopenWorkflowShape(w) }))
      .filter((w) => w.shape);
  }

  /**
   * Archive (never delete) the reopen-only workflows once the page reopens
   * by itself, and remember them by name. Called when the page is SAVED
   * with the reopen on. A workflow that also does other things is left on.
   */
  async retireReopenWorkflows(workspaceId, actor = null) {
    const found = await this.reopenWorkflows(workspaceId);
    const { setWorkflowArchived } = await import('./notificationWorkflowRepository.js');
    const retired = [];
    const kept = [];
    const failed = [];
    for (const wf of found) {
      if (wf.shape !== 'reopen_only') { kept.push({ id: wf.id, name: wf.name, isEnabled: wf.isEnabled }); continue; }
      try {
        await setWorkflowArchived(Number(workspaceId), wf.id, true, actor, { allowDefaultVariant: true });
        retired.push({ id: wf.id, name: wf.name, wasEnabled: wf.isEnabled, at: new Date().toISOString(), by: actor?.email || null });
      } catch (err) {
        logger.warn(`When a requester replies: workflow ${wf.id} not archived in workspace ${workspaceId} (${err.message})`);
        failed.push({ id: wf.id, name: wf.name, error: err.message });
      }
    }
    if (retired.length) {
      await recordRetiredWorkflows(workspaceId, retired);
      logger.info(`When a requester replies: workspace ${workspaceId} archived ${retired.map((w) => `#${w.id} "${w.name}"`).join(', ')} by ${actor?.email || 'unknown'}`);
    }
    return { retired, kept, failed };
  }

  /** Bring one retired workflow back (archived → restored, switched on again if it was on). */
  async restoreRetiredWorkflow(workspaceId, workflowId, actor = null) {
    const rules = await getRequesterReplyRules(workspaceId);
    const record = rules.retiredWorkflows.find((w) => w.id === Number(workflowId));
    if (!record) {
      const err = new Error('That workflow was not retired by this page.');
      err.statusCode = 404;
      throw err;
    }
    const { setWorkflowArchived, setWorkflowEnabled } = await import('./notificationWorkflowRepository.js');
    await setWorkflowArchived(Number(workspaceId), record.id, false, actor);
    if (record.wasEnabled) {
      await setWorkflowEnabled(Number(workspaceId), record.id, true, actor).catch((err) => {
        logger.warn(`When a requester replies: workflow ${record.id} restored but not switched on (${err.message})`);
      });
    }
    await forgetRetiredWorkflows(workspaceId, [record.id]);
    logger.info(`When a requester replies: workspace ${workspaceId} restored workflow #${record.id} "${record.name}" by ${actor?.email || 'unknown'}`);
    return record;
  }

  /**
   * Everything the settings page shows: the rules, the workspace's statuses
   * that can reopen (all but the Open ones), the suggested ticks, the live
   * reopen workflows, the ones this page archived (still archived), and this
   * month's spend on reading replies.
   */
  async pageContext(workspaceId) {
    const ws = Number(workspaceId);
    const rules = await getRequesterReplyRules(ws);
    const { default: statusService } = await import('./statusService.js');
    const statuses = (await soft(() => statusService.listStatuses(ws), []) || [])
      .filter((s) => s && s.name && s.baseStatus !== 'Open')
      .map((s) => ({ name: s.name, baseStatus: s.baseStatus }));
    const names = new Set(statuses.map((s) => s.name.toLowerCase()));
    const live = await soft(() => this.reopenWorkflows(ws), []);
    const retiredIds = rules.retiredWorkflows.map((w) => w.id);
    const stillArchived = retiredIds.length
      ? new Set(((await soft(() => prisma.notificationWorkflow.findMany({
        where: { workspaceId: ws, id: { in: retiredIds } },
        select: { id: true, archivedAt: true },
      }), [])) || []).filter((w) => w.archivedAt).map((w) => w.id))
      : new Set();
    const budget = await soft(() => this.budgetState(ws, rules), { capUsd: rules.replyCheckMonthlyCapUsd, spentUsd: null, unknown: true });
    return {
      ...rules,
      retiredWorkflows: rules.retiredWorkflows.filter((w) => stillArchived.has(w.id)),
      statuses,
      suggestedReopenStatuses: SUGGESTED_REOPEN_STATUSES.filter((n) => names.has(n.toLowerCase())),
      reopenWorkflows: (live || []).map((w) => ({ id: w.id, name: w.name, isEnabled: w.isEnabled, shape: w.shape })),
      replyCheckCapChoices: [...REPLY_CHECK_CAP_CHOICES],
      replyCheckBudget: { capUsd: budget.capUsd, spentUsd: budget.spentUsd, checks: budget.checks ?? null },
    };
  }
}

export default new RequesterReplyReopenService();
