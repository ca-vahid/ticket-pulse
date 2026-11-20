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
 *  - afterConfirmedDone (19 Nov 2026): a reply on a WAITING ticket that
 *    confirms the request is done (verdict confirmed_done, reader
 *    'confirm_done', high confidence only) — resolved quietly in Live, recorded
 *    only in Shadow ("Resolve when the requester confirms it's done", the
 *    condition step's resolveConfirmedDone). listConfirmedDone lists them.
 *
 * Never throws into the reply path: a reply is always recorded.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { isFsSystemConversation } from '../utils/fsSystemConversation.js';
import { isOutOfOfficeReply, monthStartUtc } from './autoHelpOutcomes.js';
import { getRequesterReplyRules, REPLY_CHECK_CAP_CHOICES } from './requesterReplyRulesService.js';
import { REPLY_LOOP_LIMIT, SENT_BY_OPTIONS, confirmedDoneMode } from './conditionRuleShared.js';

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
  // 19 Nov 2026: on a waiting (Pending-base) ticket, the requester confirmed
  // the request is done and nothing more is needed (high confidence only).
  CONFIRMED_DONE: 'confirmed_done',
});
const STAYS_CLOSED = Object.freeze([REPLY_VERDICTS.THANKS, REPLY_VERDICTS.AUTO_REPLY]);
/** How much of the reply the confirmed-done note and history row quote. */
export const CONFIRMED_DONE_SNIPPET_CHARS = 160;
/**
 * The reason codes (details.cause on the requester_reply_stays_closed history
 * row) for "Resolve when the requester confirms it's done (waiting tickets)".
 */
export const CONFIRMED_DONE_CAUSES = Object.freeze({
  LIVE: 'confirmed_done', // resolved, with one private note
  SHADOW: 'confirmed_done_shadow', // would have resolved; reopened as before
  FAILED: 'confirmed_done_failed', // resolving failed; reopened instead
});
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
  joined_ticket: ({ ref }) => `Reply added to ${ref}, which an earlier reply to this ticket started; this one stays closed.`,
  confirmed_done: ({ snippet }) => `Requester confirmed it's done: "${snippet}"`,
  confirmed_done_shadow: () => 'Would have resolved: requester confirmed it\'s done.',
  confirmed_done_failed: ({ reason }) => `Requester confirmed it's done, but resolving failed (${reason}); reopened instead.`,
  confirmed_done_stuck: ({ reason }) => `Requester confirmed it's done, but Ticket Pulse couldn't resolve or reopen it: ${reason}; left Pending for the normal reopen.`,
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
   *   confirmDone  the ticket is waiting (Pending base) and a reply workflow
   *                has "Resolve when the requester confirms it's done" in
   *                Shadow or Live: ask the stricter question instead (see
   *                _readConfirmDone)
   */
  async readReply(ticket, extra = {}, {
    rules = null, timeoutMs = REPLY_CHECK_TIMEOUT_MS, allowThanks = true, rich = false, useAi = true, confirmDone = false,
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
      if (!allowThanks && !rich && !confirmDone) return { verdict: REPLY_VERDICTS.REPLY, via: extra?.forwardedBy ? 'forward' : 'not_closed', entryId: entry.id };
      const text = entry.bodyText || entry.content || String(entry.bodyHtml || '').replace(/<[^>]*>/g, ' ');
      if (confirmDone) return await this._readConfirmDone(ticket, entry, text, { rules, timeoutMs, useAi, rich });
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
   * The waiting-ticket question (19 Nov 2026): "Did the requester confirm the
   * request is done and no further action is needed?" One model call (reader
   * 'confirm_done', the same operation, limit and timeout as the reading
   * above). No keyword shortcut: a bare "thanks" on a waiting ticket is
   * ambiguous. Only "confirmed_done" at high confidence is CONFIRMED_DONE; a
   * lower confidence, a next step, a question, a timeout, the spend limit or a
   * model error is 'reply' (the ticket reopens as before). With `rich` (a
   * workflow uses "Reply reads as") the other answers map as the six-answer
   * reading does, a thank-you never counting here; without it they are
   * 'reply', as a waiting ticket's reply was before (so Shadow changes nothing).
   * Returns { verdict, via, entryId, confirmDone: { confidence, modelVerdict, snippet, reason } }.
   */
  async _readConfirmDone(ticket, entry, text, { rules = null, timeoutMs = REPLY_CHECK_TIMEOUT_MS, useAi = true, rich = false } = {}) {
    const { ownWords } = await import('./autoHelpOutcomes.js');
    const own = ownWords(text) || String(text || '').replace(/\s+/g, ' ').trim();
    const snippet = own.slice(0, CONFIRMED_DONE_SNIPPET_CHARS);
    const asked = (more = {}) => ({ confidence: null, modelVerdict: null, snippet, ...more });
    if (!useAi) return { verdict: REPLY_VERDICTS.REPLY, via: 'no_ai', entryId: entry.id, confirmDone: asked() };
    const { default: autoHelpFollowUp } = await import('./autoHelpFollowUpService.js');
    const read = await withTimeout(autoHelpFollowUp.classifyReply(ticket.workspaceId, text, {
      subject: ticket.subject || null,
      reader: 'confirm_done',
      operation: REPLY_CHECK_OPERATION,
      budgetState: (ws) => this.budgetState(ws, rules),
      timeoutMs,
    }), timeoutMs + 1000);
    if (read?.timedOut) return { verdict: REPLY_VERDICTS.REPLY, via: 'timeout', entryId: entry.id, confirmDone: asked() };
    let verdict = REPLY_VERDICTS.REPLY;
    if (read?.via === 'model') {
      if (read.modelVerdict === REPLY_VERDICTS.CONFIRMED_DONE) {
        verdict = read.confidence === 'high' ? REPLY_VERDICTS.CONFIRMED_DONE : REPLY_VERDICTS.REPLY;
      } else if (rich) {
        verdict = verdictFromModel(read.modelVerdict, { allowThanks: false });
      }
    }
    return {
      verdict,
      via: read?.via || 'unknown',
      entryId: entry.id,
      confirmDone: asked({
        confidence: read?.confidence ?? null,
        modelVerdict: read?.modelVerdict ?? null,
        ...(read?.reason ? { reason: read.reason } : {}),
      }),
    };
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
    if (created?.joined) {
      return done('joined_ticket', WHY_LINES.joined_ticket({ ref: created.displayRef || `#${created.id}` }), { newTicketId: created.id });
    }
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
    // A waiting ticket whose requester confirmed it's done (19 Nov 2026).
    if (statusBase === 'Pending' && facts?.confirmedDone) {
      const done = await soft(() => this.afterConfirmedDone({ ticket, facts, result, extra, stamp }));
      if (done) out.confirmedDone = done;
    }
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
   *   thread   false = the history row only, no note in the conversation (Shadow)
   *   details  more fields for the history row (the confirmed-done record)
   */
  async writeQuietLine(ticket, {
    text = null, cause = null, verdict = null, via = null, replyEntryId = null, stamp = null, thread = true, details = null,
  } = {}) {
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
    const entry = thread === false ? null : await prisma.ticketThreadEntry.create({
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
      details: {
        ...(details && typeof details === 'object' ? details : {}),
        note: line, cause, verdict, via, replyEntryId, actorKind: 'system', ...(stamp ? { replyStamp: String(stamp) } : {}),
      },
    }));
    import('../routes/sse.routes.js')
      .then(({ sseManager }) => sseManager?.broadcast?.('ticket-change', { action: 'update', workspaceId: ticket.workspaceId, ticketId: ticket.id }, ticket.workspaceId))
      .catch(() => {});
    logger.info(`Requester reply: ${ticketDisplayRef(ticket)} ${String(cause || '').startsWith('confirmed_done') ? cause : `stays closed (${cause || verdict || 'line'})`}`);
    return entry || { historyOnly: true };
  }

  // ---------- "Resolve when the requester confirms it's done" ----------

  /**
   * After the workflows, on a waiting ticket whose reply read as
   * confirmed_done (19 Nov 2026). The condition step that would have reopened
   * left a mark in its run state (state.replyConfirmedDone, the engine):
   *   Live    (TP-born only, the run's first pass, the run completed) the
   *           step stopped the run; resolve the ticket through the quiet
   *           update path (no status_changed, so no "resolved" e-mail) and
   *           write ONE private note quoting the reply. If resolving fails,
   *           reopen if it is still waiting, and say truthfully what happened.
   *   Shadow  the step passed and the ticket reopened as before; only the
   *           history row records what Live would have done. A FreshService-
   *           born ticket under Live is recorded this way too (fsBorn: true).
   * A Live workflow whose run did not finish in that pass (parked or failed)
   * falls back to the normal reopen. Preview / mock runs never act.
   * Returns { mode, outcome } or null.
   */
  async afterConfirmedDone({ ticket, facts = {}, result = null, extra = {}, stamp = null } = {}) {
    const results = Array.isArray(result?.results) ? result.results : [];
    const marks = results
      .filter((r) => r?.status === 'completed' && r?.state?.replyConfirmedDone && r.state.replyConfirmedDone.dryRun !== true)
      .map((r) => ({ workflowId: r.workflowId ?? null, ...r.state.replyConfirmedDone }));
    // Live workflows whose run did not complete in this pass: their condition
    // step may have stopped the run, or may not have run yet.
    const liveIds = new Set((facts.workflows || [])
      .filter((w) => (w?.publishedDefinition?.nodes || []).some((n) => n?.type === 'condition' && confirmedDoneMode(n.data) === 'live'))
      .map((w) => Number(w.id)));
    const unfinished = results.find((r) => liveIds.has(Number(r?.workflowId)) && ['waiting', 'failed'].includes(r?.status));
    if (!marks.length && !unfinished) return null;
    const cd = facts.confirmedDone || {};
    const snippet = String(cd.snippet || '').slice(0, CONFIRMED_DONE_SNIPPET_CHARS);
    const replyEntryId = facts.entryId ?? extra?.entryId ?? null;
    const record = (mark, more = {}) => ({
      mode: mark.mode,
      ...(mark.configured && mark.configured !== mark.mode ? { configured: mark.configured } : {}),
      ...(mark.fsBorn ? { fsBorn: true } : {}),
      ...(mark.resumed ? { resumed: true } : {}),
      workflowId: mark.workflowId ?? null,
      workspaceId: Number(ticket.workspaceId),
      snippet,
      confidence: cd.confidence ?? null,
      ...(cd.reason ? { reason: cd.reason } : {}),
      ...more,
    });
    const write = (mark, cause, text, thread, more = {}) => this.writeQuietLine(ticket, {
      text, cause, verdict: REPLY_VERDICTS.CONFIRMED_DONE, via: facts.verdictVia || null, replyEntryId, stamp, thread, details: record(mark, more),
    });
    const reopenIfWaiting = async (note) => {
      const now = await this._baseNow(ticket);
      if (now !== null && now !== 'Pending') return { ok: false, skipped: true, base: now };
      return this._quietStatus(ticket, 'Open', note);
    };

    const live = marks.find((m) => m.mode === 'live');
    if (!live) {
      if (unfinished) {
        // The Live step's run parked or failed before it could hand over:
        // the normal reopen, recorded like Shadow.
        const reopened = await reopenIfWaiting('Reopened automatically — the requester replied.');
        const mark = { mode: 'shadow', configured: 'live', workflowId: unfinished.workflowId ?? null };
        await write(mark, CONFIRMED_DONE_CAUSES.SHADOW, WHY_LINES.confirmed_done_shadow(), false, { fallback: unfinished.status, reopened: reopened.ok === true });
        return { mode: 'shadow', outcome: reopened.ok ? 'reopened' : 'recorded', fallback: unfinished.status };
      }
      await write(marks[0], CONFIRMED_DONE_CAUSES.SHADOW, WHY_LINES.confirmed_done_shadow(), false);
      return { mode: 'shadow', outcome: 'recorded', ...(marks[0].fsBorn ? { fsBorn: true } : {}) };
    }
    // Still waiting? The step already stopped the run, so an unknown status
    // reopens (the reply must not be lost); another status is left as it is.
    const base = await this._baseNow(ticket);
    if (base === null) {
      const reopened = await this._quietStatus(ticket, 'Open', 'Reopened automatically — the requester replied.');
      const reason = 'its status could not be read';
      await write(live, CONFIRMED_DONE_CAUSES.FAILED, reopened.ok
        ? WHY_LINES.confirmed_done_failed({ reason })
        : WHY_LINES.confirmed_done_stuck({ reason: `${reason}; ${reopened.reason || 'the reopen failed'}` }), true, { reopened: reopened.ok === true });
      return { mode: 'live', outcome: reopened.ok ? 'reopened' : 'failed', reason };
    }
    if (base !== 'Pending') {
      logger.info(`Requester reply: ${ticketDisplayRef(ticket)} confirmed done but is no longer waiting (${base}); left as it is`);
      return { mode: 'live', outcome: 'not_waiting' };
    }
    const resolved = await this._quietStatus(ticket, 'Resolved', 'Requester confirmed it\'s done');
    if (resolved.ok) {
      await write(live, CONFIRMED_DONE_CAUSES.LIVE, WHY_LINES.confirmed_done({ snippet }), true);
      return { mode: 'live', outcome: 'resolved' };
    }
    // Resolving failed: the reply must not sit unseen on a waiting ticket.
    const why = String(resolved.reason || 'unknown error').slice(0, 200);
    const reopened = await reopenIfWaiting('Reopened: resolving after the requester confirmed it\'s done failed');
    if (reopened.skipped) {
      logger.info(`Requester reply: ${ticketDisplayRef(ticket)} not resolved (${why}) and no longer waiting (${reopened.base}); left as it is`);
      return { mode: 'live', outcome: 'not_waiting', reason: why };
    }
    await write(live, CONFIRMED_DONE_CAUSES.FAILED, reopened.ok
      ? WHY_LINES.confirmed_done_failed({ reason: why })
      : WHY_LINES.confirmed_done_stuck({ reason: `${why}; ${String(reopened.reason || 'the reopen failed').slice(0, 200)}` }), true, { reopened: reopened.ok === true });
    return { mode: 'live', outcome: reopened.ok ? 'reopened' : 'failed', reason: why };
  }

  /** The ticket's status base now; null when it cannot be read. */
  async _baseNow(ticket) {
    const row = await soft(() => prisma.ticket.findUnique({ where: { id: Number(ticket.id) }, select: { id: true, status: true } }));
    if (!row?.status) return null;
    const { default: statusService } = await import('./statusService.js');
    return (await soft(() => statusService.resolveBaseStatus(ticket.workspaceId, row.status))) || null;
  }

  /**
   * A status write through the workflow engine's update path with Ticket
   * Pulse as the actor: straight to the row (no status_changed event — the
   * engine's standing rule for its own writes — so no workflow sends a
   * "resolved" e-mail). Checked by reading the status back: the ticket already
   * in the target base (a duplicate reply event) counts as done; still
   * elsewhere (a parent with open children, a failed write) does not.
   * Returns { ok, reason }.
   */
  async _quietStatus(ticket, setStatus, note) {
    let res = null;
    let error = null;
    try {
      const { executeUpdateTicketNode } = await import('./notificationWorkflowEngine.js');
      res = await executeUpdateTicketNode(
        { id: 'reply-confirmed-done', type: 'update_ticket', data: { setStatus, note } },
        {
          event: { type: 'ticket.reply_received' },
          ticket: { id: Number(ticket.id), workspaceId: Number(ticket.workspaceId) },
          workspace: { id: Number(ticket.workspaceId) },
        },
        { actor: { name: 'Ticket Pulse', kind: 'system', source: 'requester_confirmed_done' } },
      );
    } catch (err) {
      error = err.message;
    }
    const targets = setStatus === 'Resolved' ? TERMINAL_BASES : ['Open'];
    const reason = () => {
      if (error) return error;
      if (res?.rollUpSkip?.reason) return res.rollUpSkip.reason;
      if (/No effective changes/.test(String(res?.reason || ''))) return 'the status did not change (a child ticket may still be open)';
      return res?.reason || res?.error || 'the status did not change';
    };
    const now = await this._baseNow(ticket);
    if (now !== null) return targets.includes(now) ? { ok: true } : { ok: false, reason: reason() };
    // The status cannot be read back: trust the write's own answer.
    return !error && Boolean(res?.updated?.status) ? { ok: true } : { ok: false, reason: reason() };
  }


  /**
   * Shadow review (read-only): the confirmed-done records, newest first —
   * requester_reply_stays_closed history rows whose details.cause is one of
   * CONFIRMED_DONE_CAUSES. `cause` 'shadow' (default) | 'live' | 'failed' | 'all'.
   * Returns [{ ticketId, ref, workspaceId, at, cause, mode, snippet, verdict,
   * confidence, reason, workflowId, statusNow }].
   */
  async listConfirmedDone({ workspaceId = null, cause = 'shadow', since = null, limit = 200 } = {}) {
    const byKey = { shadow: [CONFIRMED_DONE_CAUSES.SHADOW], live: [CONFIRMED_DONE_CAUSES.LIVE], failed: [CONFIRMED_DONE_CAUSES.FAILED] };
    const causes = byKey[cause] || Object.values(CONFIRMED_DONE_CAUSES);
    const from = since ? new Date(since) : new Date(Date.now() - 30 * 86400e3);
    const rows = await prisma.ticketActivity.findMany({
      where: {
        activityType: STAYS_CLOSED_ACTIVITY,
        performedAt: { gte: from },
        OR: causes.map((c) => ({ details: { path: ['cause'], equals: c } })),
        ...(workspaceId ? { AND: [{ details: { path: ['workspaceId'], equals: Number(workspaceId) } }] } : {}),
      },
      orderBy: { performedAt: 'desc' },
      take: Math.max(1, Math.min(1000, Number(limit) || 200)),
      select: { ticketId: true, performedAt: true, details: true },
    });
    const ids = [...new Set((rows || []).map((r) => r.ticketId))];
    const tickets = ids.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: ids } },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, status: true },
    }), []) : [];
    const byId = new Map((tickets || []).map((t) => [t.id, t]));
    return (rows || []).map((r) => {
      const d = r.details || {};
      const t = byId.get(r.ticketId) || null;
      return {
        ticketId: r.ticketId,
        ref: t ? ticketDisplayRef(t) : `#${r.ticketId}`,
        workspaceId: d.workspaceId ?? t?.workspaceId ?? null,
        at: r.performedAt,
        cause: d.cause || null,
        mode: d.mode || null,
        snippet: d.snippet || null,
        verdict: d.verdict || null,
        confidence: d.confidence ?? null,
        reason: d.reason || null,
        workflowId: d.workflowId ?? null,
        statusNow: t?.status || null,
      };
    });
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
const requesterReplyReopenService = new RequesterReplyReopenService();
/** The Shadow review list as a plain function (read-only probes). */
export const listConfirmedDone = (options) => requesterReplyReopenService.listConfirmedDone(options);
export default requesterReplyReopenService;
