/**
 * What a requester reply does to a closed ticket — the pieces that are not
 * policy (MEGA 11-14, Part A: one reopen path).
 *
 * Workflows are the only thing that reopens a ticket on a reply (Mail
 * Workflows → "Reopen on requester reply"). The Ticket Ops page's own reopen,
 * its status ticks, its retire / restore of the workflow and its retries are
 * gone. What stays here:
 *
 *  - readReply: how one reply reads (event.extra.replyVerdict), asked for by
 *    replyFacts.js only when an enabled reply workflow has the "Don't reopen
 *    on a thank-you or out-of-office reply" switch on or uses "Reply reads as".
 *    Out-of-office first (mail headers or text, any status, no AI), then the
 *    keyword thank-you, then ONE model call (operation 'requester_reply_check',
 *    its own monthly limit — never Auto-help's cap). Six answers: thanks,
 *    auto_reply, still_broken, new_request, question, reply. A thank-you only
 *    counts on a Resolved / Closed ticket; any failure, timeout or spent limit
 *    is 'reply', so the ticket reopens.
 *  - budgetState: this month's reading spend against the workspace's limit.
 *  - afterWorkflows: a reply on a ticket that was closed and still is after
 *    the workflows gets ONE private line saying why ("why it didn't reopen"):
 *    a Ticket Pulse note written straight to the thread (no e-mail, no Teams,
 *    no watcher, no workflow event, never mirrored) plus the
 *    requester_reply_stays_closed history row with details.note.
 *  - reopenCheck: the reopen workflows of a workspace and the two warnings the
 *    editor shows (two at once / none).
 *
 * Never throws into the reply path: a reply is always recorded.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { isFsSystemConversation } from '../utils/fsSystemConversation.js';
import { isOutOfOfficeReply, monthStartUtc } from './autoHelpOutcomes.js';
import { getRequesterReplyRules, REPLY_CHECK_CAP_CHOICES } from './requesterReplyRulesService.js';
import { REPLY_LOOP_LIMIT, SENT_BY_OPTIONS } from './conditionRuleShared.js';

export const REPLY_CHECK_OPERATION = 'requester_reply_check';
/** The reading is awaited before the workflows run: short, and a timeout reopens. */
export const REPLY_CHECK_TIMEOUT_MS = 8000;
export const REPLY_VERDICTS = Object.freeze({
  THANKS: 'thanks',
  AUTO_REPLY: 'auto_reply',
  STILL_BROKEN: 'still_broken',
  NEW_REQUEST: 'new_request',
  QUESTION: 'question',
  REPLY: 'reply',
});
const STAYS_CLOSED = Object.freeze([REPLY_VERDICTS.THANKS, REPLY_VERDICTS.AUTO_REPLY]);
const TERMINAL_BASES = Object.freeze(['Resolved', 'Closed']);
export const QUIET_LINES = Object.freeze({
  thanks: 'Reply read as a thank-you; the ticket stays closed.',
  auto_reply: 'Reply read as an out-of-office; the ticket stays closed.',
});
/** The "why it didn't reopen" lines (plan A6). */
export const WHY_LINES = Object.freeze({
  thanks: () => QUIET_LINES.thanks,
  auto_reply: () => QUIET_LINES.auto_reply,
  condition: ({ who, sentence, workflow }) => `Reply from ${who}; not reopened: ${sentence} (${workflow}).`,
  loop: () => `Reopened ${REPLY_LOOP_LIMIT} times by replies today; not reopened again. Please take a look.`,
  no_workflow: () => 'Reply received; no workflow reopens replies in this workspace.',
  reopen_failed: ({ reason }) => `Reply received; the reopen failed: ${reason}.`,
  mail_review: ({ person }) => `Added without reopening by ${person}.`,
  new_ticket: ({ ref }) => `Reply opened a new ticket, ${ref}; this one stays closed.`,
});
export const STAYS_CLOSED_ACTIVITY = 'requester_reply_stays_closed';
/** Model answers (reader 'person') → replyVerdict. Anything else is 'reply'. */
const MODEL_ANSWERS = Object.freeze({
  thanks: REPLY_VERDICTS.THANKS,
  auto_reply: REPLY_VERDICTS.AUTO_REPLY,
  still_broken: REPLY_VERDICTS.STILL_BROKEN,
  new_request: REPLY_VERDICTS.NEW_REQUEST,
  question: REPLY_VERDICTS.QUESTION,
});
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

/** Auto-help's reading of the same reply, in these words. */
export function autoHelpVerdictAsReply(verdict) {
  if (verdict === 'confirmed') return REPLY_VERDICTS.THANKS;
  if (verdict === 'auto_reply') return REPLY_VERDICTS.AUTO_REPLY;
  if (verdict === 'help') return REPLY_VERDICTS.REPLY;
  return null;
}

/** A model answer as a replyVerdict; a thank-you only where it may count. */
export function verdictFromModel(answer, { allowThanks = true } = {}) {
  const verdict = MODEL_ANSWERS[answer] || REPLY_VERDICTS.REPLY;
  return verdict === REPLY_VERDICTS.THANKS && !allowThanks ? REPLY_VERDICTS.REPLY : verdict;
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
 *   'reopen_only'  it does nothing else (conditions and stops aside);
 *   'reopen_plus'  it also sends, assigns, tags …;
 *   null           not a reopen workflow, or never published.
 * `definition` reads another version (the draft, for the upgrade offer).
 */
export function reopenWorkflowShape(workflow, definition = null) {
  if (workflow?.triggerType !== 'ticket.reply_received') return null;
  const def = definition || (Number(workflow.publishedVersion) > 0 ? workflow.publishedDefinition : null);
  const nodes = Array.isArray(def?.nodes) ? def.nodes : [];
  const reopens = nodes.filter((n) => n?.type === 'update_ticket' && String(n.data?.setStatus || '').trim().toLowerCase() === 'open');
  if (!reopens.length) return null;
  const otherWork = nodes.some((n) => !reopens.includes(n) && !QUIET_NODE_TYPES.includes(n?.type));
  return !otherWork && reopens.every((n) => onlySetsStatus(n.data)) ? 'reopen_only' : 'reopen_plus';
}

/** Does this reply workflow decide what a reply does (reopen, or a new ticket from it)? */
export function handlesReplies(workflow, definition = null) {
  if (workflow?.triggerType !== 'ticket.reply_received') return false;
  if (reopenWorkflowShape(workflow, definition)) return true;
  const def = definition || (Number(workflow.publishedVersion) > 0 ? workflow.publishedDefinition : null);
  return (def?.nodes || []).some((n) => n?.type === 'create_ticket_from_reply');
}

/** "the requester" / "alex@example.com (someone Cc'd)" for the why line. */
function whoReplied(facts = {}, extra = {}) {
  const address = String(extra.from || extra.fromEmail || '').trim();
  const label = SENT_BY_OPTIONS.find((o) => o.value === facts.sentBy)?.label || null;
  if (facts.sentBy === 'requester' || (!address && !label)) return 'the requester';
  if (!address) return label.charAt(0).toLowerCase() + label.slice(1);
  return label && facts.sentBy !== 'other' ? `${address} (${label.charAt(0).toLowerCase() + label.slice(1)})` : address;
}

class RequesterReplyReopenService {
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
   * Read one reply. { verdict, via, entryId? }. Never throws; every doubt is 'reply'.
   *   allowThanks  a thank-you may count (the ticket is Resolved / Closed and
   *                the reply is not an agent's forward); otherwise a thank-you
   *                reads as 'reply'
   *   rich         a workflow uses "Reply reads as": the model call runs for
   *                the full answer even where a thank-you cannot count
   *   useAi        false = no model call (the editor's "try it" without "Use AI")
   */
  async readReply(ticket, extra = {}, {
    rules = null, timeoutMs = REPLY_CHECK_TIMEOUT_MS, allowThanks = true, rich = false, useAi = true,
  } = {}) {
    try {
      const entry = await this._replyEntry(Number(ticket.id), extra);
      if (!entry) return { verdict: REPLY_VERDICTS.REPLY, via: 'no_reply_text' };
      if (entry.isPrivate === true || entry.authorType === 'system' || entry.eventType === 'activity' || isFsSystemConversation(entry)) {
        return { verdict: REPLY_VERDICTS.REPLY, via: 'not_a_reply', entryId: entry.id };
      }
      // Out-of-office first, whatever the status (G5): headers when the mail
      // kept them, else the text (a FreshService-synced entry has neither
      // headers nor a subject). No AI.
      if (isOutOfOfficeReply(entry)) return { verdict: REPLY_VERDICTS.AUTO_REPLY, via: 'auto_reply', entryId: entry.id };
      // Nothing more to learn: a thank-you cannot count here and nobody asks for the full reading.
      if (!allowThanks && !rich) return { verdict: REPLY_VERDICTS.REPLY, via: extra?.forwardedBy ? 'forward' : 'not_closed', entryId: entry.id };
      const text = entry.bodyText || entry.content || String(entry.bodyHtml || '').replace(/<[^>]*>/g, ' ');
      const { classifyThanksFast } = await import('./autoHelpOutcomes.js');
      if (!useAi) {
        const fast = classifyThanksFast(text);
        return { verdict: fast === 'confirmed' && allowThanks ? REPLY_VERDICTS.THANKS : REPLY_VERDICTS.REPLY, via: fast ? 'keywords' : 'no_ai', entryId: entry.id };
      }
      const { default: autoHelpFollowUp } = await import('./autoHelpFollowUpService.js');
      const read = await withTimeout(autoHelpFollowUp.classifyReply(ticket.workspaceId, text, {
        subject: ticket.subject || null,
        reader: 'person',
        operation: REPLY_CHECK_OPERATION,
        budgetState: (ws) => this.budgetState(ws, rules),
        timeoutMs,
      }), timeoutMs + 1000);
      if (read?.timedOut) return { verdict: REPLY_VERDICTS.REPLY, via: 'timeout', entryId: entry.id };
      let verdict = REPLY_VERDICTS.REPLY;
      if (read?.via === 'keywords') verdict = read.verdict === 'confirmed' && allowThanks ? REPLY_VERDICTS.THANKS : REPLY_VERDICTS.REPLY;
      else if (read?.via === 'model') verdict = verdictFromModel(read.modelVerdict, { allowThanks });
      return {
        verdict,
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
   * The "why it didn't reopen" line for a reply on a ticket that was closed
   * when it arrived, from what the workflows did. Pure. Returns
   * { cause, text } or null (nothing to say: a replay of the same reply).
   *   facts    replyFacts' result (sentBy, replyVerdict, aliasCheck, workflows)
   *   result   executeForEvent's result
   */
  whyLine({ facts = {}, result = null, extra = {} } = {}) {
    const results = Array.isArray(result?.results) ? result.results : [];
    if (results.length && results.every((r) => r?.status === 'skipped' && r?.reason === 'Duplicate workflow event')) return null;
    const aliasNote = facts.aliasCheck === 'failed' ? ' (Could not check aliases.)' : '';
    const done = (cause, text, more = {}) => ({ cause, text: `${text}${aliasNote}`, ...more });

    const created = results.map((r) => r?.state?.replyNewTicket).find((t) => t?.id);
    if (created) {
      const note = String(created.note || '').trim();
      return done('new_ticket', `${WHY_LINES.new_ticket({ ref: created.displayRef || `#${created.id}` })}${note ? ` ${note}` : ''}`, { newTicketId: created.id });
    }
    const workflows = (facts.workflows || []).filter((w) => handlesReplies(w));
    if (!workflows.length) return done('no_workflow', WHY_LINES.no_workflow());
    const names = new Map(workflows.map((w) => [Number(w.id), w.name || `#${w.id}`]));
    const ours = results.filter((r) => names.has(Number(r?.workflowId)));
    const failed = ours.find((r) => r?.status === 'failed');
    if (failed) return done('reopen_failed', WHY_LINES.reopen_failed({ reason: String(failed.error || 'unknown error').slice(0, 200) }));
    const stepSkip = ours
      .flatMap((r) => (Array.isArray(r?.steps) ? r.steps : []))
      .find((s) => s?.nodeType === 'update_ticket' && (s.output?.skipped || s.output?.failed) && !/No effective changes/.test(String(s.output?.reason || '')));
    if (stepSkip) return done('reopen_failed', WHY_LINES.reopen_failed({ reason: String(stepSkip.output.reason || stepSkip.output.error || 'the update was skipped').slice(0, 200) }));
    const who = whoReplied(facts, extra);
    for (const r of ours) {
      const last = r?.state?.lastCondition;
      if (!last || last.passed !== false) continue;
      if (last.source === 'reply_loop') return done('loop', WHY_LINES.loop());
      if (last.source === 'reply_thanks') {
        const verdict = last.verdict === 'auto_reply' || facts.replyVerdict === 'auto_reply' ? 'auto_reply' : 'thanks';
        return done(verdict, WHY_LINES[verdict]());
      }
      return done('condition', WHY_LINES.condition({ who, sentence: String(last.summary || 'a condition did not pass').slice(0, 300), workflow: names.get(Number(r.workflowId)) }));
    }
    const skipped = ours.find((r) => r?.status === 'skipped' && r?.reason);
    if (skipped) return done('condition', WHY_LINES.condition({ who, sentence: String(skipped.reason).slice(0, 200), workflow: names.get(Number(skipped.workflowId)) }));
    if (!ours.length) {
      // The reopen workflows exist but none ran for this reply (routing chose another variant).
      return done('condition', WHY_LINES.condition({ who, sentence: 'no reopen workflow was chosen for this ticket', workflow: workflows.map((w) => w.name || `#${w.id}`).join(', ') }));
    }
    return done('condition', WHY_LINES.condition({ who, sentence: 'the workflow did not reach its reopen step', workflow: names.get(Number(ours[0].workflowId)) }));
  }

  /**
   * After the workflows ran on a reply: is the ticket open now, and if it was
   * closed and still is, the one private "why" line. Returns
   * { openNow, wasClosed, stillClosed, line }. Never throws.
   */
  async afterWorkflows({ ticket, statusBase = null, facts = {}, result = null, extra = {}, stamp = null } = {}) {
    const out = { openNow: null, wasClosed: TERMINAL_BASES.includes(statusBase), stillClosed: false, line: null };
    if (!ticket?.id) return out;
    try {
      const row = await prisma.ticket.findUnique({ where: { id: Number(ticket.id) }, select: { id: true, status: true } });
      const { default: statusService } = await import('./statusService.js');
      const base = await soft(() => statusService.resolveBaseStatus(ticket.workspaceId, row?.status ?? ticket.status));
      out.openNow = base ? !TERMINAL_BASES.includes(base) : null;
      out.stillClosed = out.wasClosed && TERMINAL_BASES.includes(base);
      if (!out.stillClosed) return out;
      const why = this.whyLine({ facts, result, extra });
      if (!why) return out;
      out.line = why;
      await this.writeQuietLine(ticket, {
        text: why.text, cause: why.cause, verdict: facts.replyVerdict || null, via: facts.verdictVia || null,
        replyEntryId: facts.entryId ?? extra?.entryId ?? null, stamp,
      });
      return out;
    } catch (err) {
      logger.warn(`Requester reply: why line not written for ticket ${ticket.id} (${err.message})`);
      return out;
    }
  }

  /**
   * One quiet line in the conversation: a private Ticket Pulse note written
   * straight to the thread (the Assetron-note pattern) — no e-mail, no Teams,
   * no watcher, no note_added workflow event, never mirrored to FreshService —
   * plus the history row (details.note = the line), and open ticket pages
   * refresh. One per reply: a second call with the same stamp writes nothing.
   */
  async writeQuietLine(ticket, { text = null, cause = null, verdict = null, via = null, replyEntryId = null, stamp = null } = {}) {
    const line = text || QUIET_LINES[verdict];
    if (!line) return null;
    if (stamp) {
      const recent = await soft(() => prisma.ticketActivity.findMany({
        where: { ticketId: Number(ticket.id), activityType: STAYS_CLOSED_ACTIVITY, performedAt: { gte: new Date(Date.now() - 7 * 86400e3) } },
        select: { details: true },
        take: 50,
      }), []);
      if ((recent || []).some((a) => a?.details?.replyStamp === String(stamp))) return null;
    }
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
        bodyText: line,
        content: line,
        occurredAt: now,
        mirrorState: null,
        rawPayload: { kind: 'reply_stays_closed', cause, verdict, via, replyEntryId, ...(stamp ? { replyStamp: String(stamp) } : {}) },
      },
    });
    const { default: ticketActivityRepository } = await import('./ticketActivityRepository.js');
    await soft(() => ticketActivityRepository.create({
      ticketId: Number(ticket.id),
      activityType: STAYS_CLOSED_ACTIVITY,
      performedBy: 'Ticket Pulse',
      performedAt: now,
      details: { note: line, cause, verdict, via, replyEntryId, actorKind: 'system', ...(stamp ? { replyStamp: String(stamp) } : {}) },
    }));
    import('../routes/sse.routes.js')
      .then(({ sseManager }) => sseManager?.broadcast?.('ticket-change', { action: 'update', workspaceId: ticket.workspaceId, ticketId: ticket.id }, ticket.workspaceId))
      .catch(() => {});
    logger.info(`Requester reply: ${ticketDisplayRef(ticket)} stays closed (${cause || verdict || 'line'})`);
    return entry;
  }

  // ---------- the reopen workflows ----------

  /** Live reply workflows that reopen (or open a new ticket), not archived, with their shape. */
  async reopenWorkflows(workspaceId) {
    const rows = await prisma.notificationWorkflow.findMany({
      where: { workspaceId: Number(workspaceId), triggerType: 'ticket.reply_received', archivedAt: null },
      select: {
        id: true, name: true, key: true, triggerType: true, isEnabled: true, isDefaultVariant: true,
        routingMode: true, publishedVersion: true, publishedDefinition: true,
      },
      orderBy: { id: 'asc' },
    });
    return (rows || [])
      .filter((w) => handlesReplies(w))
      .map((w) => ({
        id: w.id, name: w.name, isEnabled: w.isEnabled === true, isDefaultVariant: w.isDefaultVariant === true,
        routingMode: w.routingMode || 'exclusive', shape: reopenWorkflowShape(w) || 'new_ticket',
      }));
  }

  /**
   * The editor's reopen check (contract §4): the workspace's reopen
   * workflows and two warnings — two enabled ones that would both run for
   * the same reply (an additive one beside any other), or none enabled.
   */
  async reopenCheck(workspaceId) {
    const found = await soft(() => this.reopenWorkflows(workspaceId), []) || [];
    const enabled = found.filter((w) => w.isEnabled);
    const additive = enabled.filter((w) => w.routingMode === 'additive');
    const warnings = [];
    if (additive.length >= 2 || (additive.length >= 1 && enabled.length > additive.length)) {
      warnings.push({
        code: 'two_reopen_workflows',
        message: `${enabled.map((w) => `"${w.name}"`).join(' and ')} both act on the same replies. Keep one, or make them variants of each other.`,
      });
    }
    if (!enabled.length) {
      warnings.push({ code: 'no_reopen_workflow', message: 'No switched-on workflow reopens a ticket when the requester replies. Replies to closed tickets stay closed.' });
    }
    return { reopenWorkflows: found.map((w) => ({ id: w.id, name: w.name, isEnabled: w.isEnabled })), warnings };
  }

  /**
   * Settings → Ticket Ops → When a requester replies (contract §5): the two
   * remaining switches, the reading limit, its choices and this month's spend.
   */
  async pageContext(workspaceId) {
    const ws = Number(workspaceId);
    const rules = await getRequesterReplyRules(ws);
    const budget = await soft(() => this.budgetState(ws, rules), { capUsd: rules.replyCheckMonthlyCapUsd, spentUsd: null, unknown: true });
    return {
      rerouteWhenOwnerAway: rules.rerouteWhenOwnerAway,
      suggestNewRequest: rules.suggestNewRequest,
      replyCheckMonthlyCapUsd: rules.replyCheckMonthlyCapUsd,
      replyCheckCapChoices: [...REPLY_CHECK_CAP_CHOICES],
      replyCheckBudget: { capUsd: budget.capUsd, spentUsd: budget.spentUsd, checks: budget.checks ?? null },
    };
  }
}

export { STAYS_CLOSED };
export default new RequesterReplyReopenService();
