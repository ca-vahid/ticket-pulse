/**
 * Facts about a requester reply, worked out ONCE per reply (MEGA 11-14, Part A,
 * A2 / A3). emitTicketEvent('ticket.reply_received') calls computeReplyFacts
 * before the workflows run; all three reply roads arrive there — mail intake
 * (extra.from), the FreshService conversation sync and the copy sync
 * (extra.fromEmail; both names are read).
 *
 *   event.extra.sentBy          'requester' | 'cc' | 'workflow_recipient' | 'other'
 *   ticket.closedMinutes        minutes since the ticket closed (close time, else
 *                               resolve time, else its last activity); null when
 *                               the ticket is not Resolved / Closed
 *   event.extra.replyReopens24h reopens of this ticket by a reply workflow in the
 *                               last 24 hours
 *   event.extra.replyVerdict    how the reply reads (requesterReplyReopenService
 *                               .readReply), only when an enabled reply workflow
 *                               has the thank-you switch on or uses it
 *   event.extra.replyConfirmedDone  true when, on a waiting (Pending-base)
 *                               ticket, the reply confirmed the request is done
 *                               (only asked when a reply workflow's condition
 *                               step has resolveConfirmedDone Shadow or Live)
 *
 * Cheap facts are always worked out; the costly two only when a workflow in
 * the workspace uses them: the Entra alias lookup (event.sentBy named in a
 * workflow) and the reading. Never throws: a fact that cannot be worked out
 * is left out, and the reply goes on.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketEndedAt } from '../utils/ticketEndedAt.js';
import { confirmedDoneMode, ignoresThanks } from './conditionRuleShared.js';

export const SENT_BY = Object.freeze({ REQUESTER: 'requester', CC: 'cc', WORKFLOW_RECIPIENT: 'workflow_recipient', OTHER: 'other' });
export const ALIAS_TIMEOUT_MS = 3000;
const ALIAS_CACHE_MS = 6 * 60 * 60 * 1000;
const ALIAS_CACHE_MAX = 2000;
const TERMINAL_BASES = Object.freeze(['Resolved', 'Closed']);
const DAY_MS = 24 * 60 * 60 * 1000;

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);
/** No capitals, no spaces, no <angle brackets>. */
export const normAddress = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '').replace(/^<|>$/g, '');

function definitionText(workflow) {
  try {
    return JSON.stringify(workflow?.publishedDefinition || {}) + JSON.stringify(workflow?.routingRule || null);
  } catch {
    return '';
  }
}

/**
 * What the enabled reply workflows of a workspace ask for. Pure.
 *   alias    a workflow names "Reply sent by" (the Entra alias lookup is worth it)
 *   reading  a condition step has the thank-you switch on, or a workflow uses "Reply reads as"
 *   rich     a workflow uses "Reply reads as" (the full six answers, any status)
 */
export function replyWorkflowNeeds(workflows = []) {
  const needs = { alias: false, reading: false, rich: false };
  for (const workflow of workflows || []) {
    const text = definitionText(workflow);
    if (text.includes('event.sentBy') || text.includes('event.extra.sentBy')) needs.alias = true;
    if (text.includes('event.replyVerdict') || text.includes('event.extra.replyVerdict')) {
      needs.reading = true;
      needs.rich = true;
    }
    const nodes = Array.isArray(workflow?.publishedDefinition?.nodes) ? workflow.publishedDefinition.nodes : [];
    if (nodes.some((n) => n?.type === 'condition' && ignoresThanks(n.data))) needs.reading = true;
  }
  return needs;
}

/**
 * "Resolve when the requester confirms it's done (waiting tickets)": the
 * strongest mode any enabled reply workflow's condition step sets — 'live',
 * 'shadow' or 'off'. Pure. (Kept out of replyWorkflowNeeds so its shape stays.)
 */
export function confirmDoneNeed(workflows = []) {
  let need = 'off';
  for (const workflow of workflows || []) {
    const nodes = Array.isArray(workflow?.publishedDefinition?.nodes) ? workflow.publishedDefinition.nodes : [];
    for (const n of nodes) {
      if (n?.type !== 'condition') continue;
      const mode = confirmedDoneMode(n.data);
      if (mode === 'live') return 'live';
      if (mode === 'shadow') need = 'shadow';
    }
  }
  return need;
}

// ---------------------------------------------------------------- aliases

const aliasCache = new Map(); // address -> { owner, at }

export function resetReplyFactsCaches() {
  aliasCache.clear();
}

/** The Entra account an address delivers to (UPN), null when none. Throws when Entra cannot answer. */
async function entraOwner(address) {
  const hit = aliasCache.get(address);
  if (hit && Date.now() - hit.at < ALIAS_CACHE_MS) return hit.owner;
  const { default: azureAdService } = await import('./azureAdService.js');
  const res = await azureAdService.resolveAddress(address);
  if (res?.status === 'unavailable' || !res?.status) throw new Error('Entra unavailable');
  const owner = res.status === 'found' || res.status === 'alias' ? normAddress(res.owner) || null : null;
  aliasCache.set(address, { owner, at: Date.now() });
  if (aliasCache.size > ALIAS_CACHE_MAX) aliasCache.delete(aliasCache.keys().next().value);
  return owner;
}

/** Is `sender` the same Entra person as `requester`? true / false; throws when it cannot be told. */
export async function sameEntraPerson(requester, sender) {
  const [a, b] = await Promise.all([entraOwner(requester), entraOwner(sender)]);
  return Boolean(a && b && a === b);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('alias lookup timed out')), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- facts

/**
 * Who sent the reply, in this order: the requester (or the mail was sent on
 * their behalf) → the requester under another address (Entra, only when
 * `alias`; 3 s) → someone on the ticket's Cc list → someone a workflow
 * e-mailed on this ticket → someone else. Returns { sentBy, via, aliasCheck }
 * (aliasCheck: 'skipped' | 'ok' | 'failed').
 */
export async function replySentBy({
  ticket, from = null, onBehalfOf = null, alias = false, aliasLookup = sameEntraPerson, aliasTimeoutMs = ALIAS_TIMEOUT_MS,
} = {}) {
  const sender = normAddress(from);
  const requester = normAddress(ticket?.requester?.email);
  const behalf = normAddress(onBehalfOf);
  let aliasCheck = 'skipped';
  if (requester && ((sender && sender === requester) || (behalf && behalf === requester))) {
    return { sentBy: SENT_BY.REQUESTER, via: sender === requester ? 'address' : 'on_behalf_of', aliasCheck };
  }
  if (!sender) return { sentBy: SENT_BY.OTHER, via: 'no_sender', aliasCheck };
  if (alias && requester) {
    try {
      const same = await withTimeout(Promise.resolve().then(() => aliasLookup(requester, sender)), aliasTimeoutMs);
      aliasCheck = 'ok';
      if (same === true) return { sentBy: SENT_BY.REQUESTER, via: 'alias', aliasCheck };
    } catch (err) {
      aliasCheck = 'failed';
      logger.info(`Reply facts: could not check aliases for ticket ${ticket?.id} (${err.message})`);
    }
  }
  const cc = [...(Array.isArray(ticket?.ccEmails) ? ticket.ccEmails : []), ...(Array.isArray(ticket?.replyCcEmails) ? ticket.replyCcEmails : [])]
    .map(normAddress);
  if (cc.includes(sender)) return { sentBy: SENT_BY.CC, via: 'cc', aliasCheck };
  if (ticket?.id) {
    const sent = await soft(() => prisma.notificationDelivery.findMany({
      where: { ticketId: Number(ticket.id), workflowRunId: { not: null } },
      select: { recipient: true, toRecipients: true, ccRecipients: true, bccRecipients: true },
      orderBy: { id: 'desc' },
      take: 200,
    }), []);
    const mailed = new Set((sent || []).flatMap((d) => [d.recipient, ...(d.toRecipients || []), ...(d.ccRecipients || []), ...(d.bccRecipients || [])]).map(normAddress).filter(Boolean));
    if (mailed.has(sender)) return { sentBy: SENT_BY.WORKFLOW_RECIPIENT, via: 'workflow_delivery', aliasCheck };
  }
  return { sentBy: SENT_BY.OTHER, via: 'none', aliasCheck };
}

/** Minutes since a Resolved / Closed ticket ended; null otherwise. Pure. */
export function closedMinutesFor(ticket, statusBase, now = Date.now()) {
  if (!TERMINAL_BASES.includes(statusBase)) return null;
  const ended = ticketEndedAt(ticket);
  const at = ended ? new Date(ended).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
}

/**
 * Reopens of this ticket by a reply workflow in the last 24 hours: the
 * workflow_updated_ticket rows the update step writes (both origins) for
 * event ticket.reply_received with a status change out of Resolved / Closed.
 */
export async function replyReopensLast24h(ticket, { now = Date.now() } = {}) {
  if (!ticket?.id) return 0;
  const rows = await soft(() => prisma.ticketActivity.findMany({
    where: { ticketId: Number(ticket.id), activityType: 'workflow_updated_ticket', performedAt: { gte: new Date(now - DAY_MS) } },
    select: { details: true },
    take: 200,
  }), []);
  const { default: statusService } = await import('./statusService.js');
  const bases = new Map();
  const baseOf = async (name) => {
    const key = String(name || '');
    if (!bases.has(key)) bases.set(key, await soft(() => statusService.resolveBaseStatus(ticket.workspaceId, key)));
    return bases.get(key);
  };
  let count = 0;
  for (const row of rows || []) {
    const d = row?.details;
    if (d?.eventType !== 'ticket.reply_received' || !d?.changes?.status) continue;
    const fromBase = await baseOf(d.changes.status.from);
    const toBase = await baseOf(d.changes.status.to);
    const reopened = toBase ? !TERMINAL_BASES.includes(toBase) : /^open$/i.test(String(d.changes.status.to || ''));
    if (reopened && (fromBase === null || fromBase === undefined || TERMINAL_BASES.includes(fromBase))) count += 1;
  }
  return count;
}

async function enabledReplyWorkflows(workspaceId) {
  const { listEnabledForEvent } = await import('./notificationWorkflowRepository.js');
  return soft(() => listEnabledForEvent(Number(workspaceId), 'ticket.reply_received'), []);
}

/**
 * Everything above for one reply. Returns
 *   { extra: { sentBy, replyReopens24h, closedMinutes, replyVerdict? },
 *     closedMinutes, sentBy, sentByVia, aliasCheck, replyReopens24h,
 *     replyVerdict, verdictVia, entryId, needs, workflows }
 *   ticket, statusBase  the ticket as the reply found it
 *   extra               the event's extra (from / fromEmail, onBehalfOf, forwardedBy …)
 *   autoHelpVerdict     Auto-help's own reading of this reply, when it has one
 *   cheapOnly           no alias lookup, no reading (a manual one-workflow replay)
 *   workflows           the enabled reply workflows (looked up when not given)
 *   readOptions         passed to readReply (useAi for the editor's "try it")
 */
export async function computeReplyFacts({
  ticket, statusBase = null, extra = {}, autoHelpVerdict = null, cheapOnly = false, workflows = null,
  readOptions = {}, aliasLookup = sameEntraPerson, now = Date.now(),
} = {}) {
  const list = Array.isArray(workflows) ? workflows : await enabledReplyWorkflows(ticket?.workspaceId);
  const needs = cheapOnly ? { alias: false, reading: false, rich: false } : replyWorkflowNeeds(list);
  const from = extra?.from || extra?.fromEmail || null;
  const sender = await soft(() => replySentBy({ ticket, from, onBehalfOf: extra?.onBehalfOf || null, alias: needs.alias, aliasLookup }), null)
    || { sentBy: SENT_BY.OTHER, via: 'error', aliasCheck: 'skipped' };
  const closedMinutes = closedMinutesFor(ticket, statusBase, now);
  const replyReopens24h = await soft(() => replyReopensLast24h(ticket, { now }), 0);

  let read = null;
  const requesterReply = extra?.isSurveyResponse !== true && extra?.senderIsAgent !== true;
  // A waiting ticket and a workflow that resolves on "the requester confirmed
  // it's done" (Shadow or Live): the stricter question, never on an agent's forward.
  const confirmDone = !cheapOnly && statusBase === 'Pending' && !extra?.forwardedBy && confirmDoneNeed(list) !== 'off';
  if ((needs.reading || confirmDone) && requesterReply) {
    const { default: replyReopen, autoHelpVerdictAsReply } = await import('./requesterReplyReopenService.js');
    const fromAutoHelp = autoHelpVerdictAsReply(autoHelpVerdict);
    if (fromAutoHelp) read = { verdict: fromAutoHelp, via: 'auto_help' };
    else {
      const closed = TERMINAL_BASES.includes(statusBase);
      // A thank-you only counts on a Resolved / Closed ticket, and an agent's
      // forward is new information, never a thank-you.
      read = await replyReopen.readReply(ticket, extra || {}, {
        allowThanks: closed && !extra?.forwardedBy,
        rich: needs.rich,
        confirmDone,
        ...readOptions,
      });
    }
  }
  // confirmed_done rides on the event as replyConfirmedDone; "Reply reads as"
  // sees it as "Other reply" (what it was before), so a Shadow run reopens
  // exactly as it did.
  const confirmedDone = read?.verdict === 'confirmed_done'
    ? { verdict: 'confirmed_done', via: read.via || null, ...(read.confirmDone || {}) }
    : null;
  const eventVerdict = confirmedDone ? 'reply' : read?.verdict || null;

  const facts = {
    sentBy: sender.sentBy,
    sentByVia: sender.via,
    aliasCheck: sender.aliasCheck,
    closedMinutes,
    replyReopens24h,
    replyVerdict: eventVerdict,
    verdictVia: read?.via || null,
    entryId: read?.entryId ?? extra?.entryId ?? null,
    // { verdict: 'confirmed_done', via, confidence, modelVerdict, snippet, reason } or null
    confirmedDone,
    // What the waiting-ticket question answered, whatever it was (or null when not asked).
    confirmDoneRead: read?.confirmDone ? { verdict: read.verdict, via: read.via || null, ...read.confirmDone } : null,
    needs,
    workflows: list || [],
  };
  facts.extra = {
    sentBy: facts.sentBy,
    replyReopens24h,
    closedMinutes,
    ...(facts.aliasCheck === 'failed' ? { aliasCheckFailed: true } : {}),
    ...(facts.replyVerdict ? { replyVerdict: facts.replyVerdict } : {}),
    ...(confirmedDone ? { replyConfirmedDone: true } : {}),
  };
  return facts;
}

export default {
  SENT_BY,
  replyWorkflowNeeds,
  confirmDoneNeed,
  replySentBy,
  closedMinutesFor,
  replyReopensLast24h,
  computeReplyFacts,
  sameEntraPerson,
  resetReplyFactsCaches,
};
