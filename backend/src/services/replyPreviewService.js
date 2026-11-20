/**
 * "Try it on a past reply" (MEGA 11-14, A4 / contract §4): run a
 * "Requester replied" workflow in preview against one of a ticket's real past
 * replies, as if the ticket were in a chosen status, and say in one sentence
 * what would happen. Writes nothing to the ticket (the preview run itself is
 * the usual audit row). The AI reading runs only when the caller asks
 * (executeLlm); otherwise the reply reads from the out-of-office and keyword
 * checks, or not at all.
 */
import prisma from './prisma.js';
import statusService from './statusService.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { computeReplyFacts } from './replyFacts.js';
import { REPLY_STAYS_CLOSED_VERDICTS, REPLY_VERDICT_OPTIONS } from './conditionRuleShared.js';

const TERMINAL_BASES = Object.freeze(['Resolved', 'Closed']);
const CANDIDATE_LIMIT = 10;
const PREVIEW_CHARS = 160;
const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);

const plain = (entry) => String(entry?.bodyText || entry?.content || String(entry?.bodyHtml || '').replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ').trim();

/** A requester's reply (both shapes: mail intake 'reply' + requester, FreshService 'customer_reply'). */
const REPLY_WHERE = {
  incoming: true,
  OR: [{ isPrivate: false }, { isPrivate: null }],
  AND: [{ OR: [{ eventType: 'customer_reply' }, { eventType: 'reply', authorType: 'requester' }] }],
};

/** The ticket's last 10 incoming requester replies, newest first. */
export async function replyCandidates(workspaceId, ticketId) {
  const ticket = await prisma.ticket.findFirst({ where: { id: Number(ticketId), workspaceId: Number(workspaceId) }, select: { id: true } });
  if (!ticket) throw new NotFoundError('Ticket not found in this workspace');
  const rows = await prisma.ticketThreadEntry.findMany({
    where: { ticketId: ticket.id, ...REPLY_WHERE },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: CANDIDATE_LIMIT,
    select: { id: true, occurredAt: true, actorEmail: true, actorName: true, bodyText: true, content: true, bodyHtml: true },
  });
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt ? new Date(r.occurredAt).toISOString() : null,
    fromEmail: r.actorEmail || null,
    fromName: r.actorName || null,
    preview: plain(r).slice(0, PREVIEW_CHARS),
  }));
}

function verdictWords(verdict) {
  if (verdict === 'thanks') return 'a thank-you';
  if (verdict === 'auto_reply') return 'an out-of-office';
  const option = REPLY_VERDICT_OPTIONS.find((o) => o.value === verdict);
  return option ? `"${option.label}"` : null;
}

/** What the preview steps say would happen. Pure. */
export function previewOutcome({ steps = [], state = {}, asTerminal = true, replyVerdict = null } = {}) {
  const ran = (type) => (steps || []).filter((s) => s?.nodeType === type && s?.status !== 'failed');
  if (ran('create_ticket_from_reply').some((s) => s.output?.wouldCreate || s.output?.created)) {
    return { outcome: 'new_ticket', why: 'Would open a new ticket from this reply; this one stays closed.' };
  }
  // "Resolve when the requester confirms it's done (waiting tickets)".
  const confirmedDone = state?.replyConfirmedDone?.mode || null;
  if (confirmedDone === 'live') {
    return { outcome: 'resolve', why: 'Would resolve the ticket: the requester confirmed it\'s done. No e-mail to the requester.' };
  }
  const shadowNote = confirmedDone === 'shadow' ? ' Shadow: would have resolved, the requester confirmed it\'s done.' : '';
  const reopenStep = ran('update_ticket').find((s) => {
    const status = String(s.output?.wouldSet?.status || '').trim().toLowerCase();
    return status && status !== 'resolved' && status !== 'closed';
  });
  if (reopenStep) {
    return asTerminal
      ? { outcome: 'reopen', why: `Would reopen the ticket.${shadowNote}` }
      : { outcome: 'reopen', why: `Would set the status to ${reopenStep.output.wouldSet.status}.${shadowNote}` };
  }
  const last = state?.lastCondition;
  let reason = null;
  if (last && last.passed === false) {
    if (last.source === 'reply_thanks') reason = `reads as ${verdictWords(last.verdict) || 'a thank-you'}`;
    else if (last.source === 'reply_loop') reason = 'it would be the 4th reopen by replies in a day';
    else reason = String(last.summary || '').trim() || 'a condition did not pass';
  } else if (REPLY_STAYS_CLOSED_VERDICTS.includes(replyVerdict)) {
    reason = `reads as ${verdictWords(replyVerdict)}`;
  }
  if (!asTerminal) return { outcome: 'nothing', why: reason ? `Nothing would change: ${reason}.` : 'Nothing would change.' };
  return { outcome: 'stays_closed', why: reason ? `Would stay closed: ${reason}.` : 'Would stay closed: the workflow does not reopen it.' };
}

/**
 * Prepare the preview run for one past reply. Returns { eventContext,
 * replyPreviewBase } — the caller runs executePreview with the context and
 * finishes the answer with previewOutcome().
 *   eventContext  the preview context built for the ticket (buildPreviewEventContext)
 */
export async function prepareReplyPreview({ workspaceId, ticket, eventContext, replyEntryId, asStatus = 'Closed', executeLlm = false, definition = null }) {
  const entryId = Number(replyEntryId);
  if (!Number.isInteger(entryId) || entryId <= 0) throw new ValidationError('replyEntryId must be a reply on this ticket');
  const entry = await prisma.ticketThreadEntry.findFirst({
    where: { id: entryId, ticketId: Number(ticket.id), ...REPLY_WHERE },
    select: { id: true, actorEmail: true, actorName: true, externalEntryId: true, rawPayload: true, occurredAt: true },
  });
  if (!entry) throw new ValidationError('That reply is not one of this ticket\'s incoming requester replies');
  const status = String(asStatus || 'Closed').trim().slice(0, 60) || 'Closed';
  const statusBase = await soft(() => statusService.resolveBaseStatus(workspaceId, status));
  const asTerminal = TERMINAL_BASES.includes(statusBase);
  // "Reply answers a workflow e-mail": the mail intake records it on the reply's history row.
  const activity = await soft(() => prisma.ticketActivity.findFirst({
    where: { ticketId: Number(ticket.id), activityType: 'requester_reply', details: { path: ['entryId'], equals: entry.id } },
    select: { details: true },
  }));
  const replyToWorkflowEmail = activity?.details?.replyToWorkflowEmail === true || activity?.details?.via === 'workflow_mail_ref';
  const onBehalfOf = entry.rawPayload?.onBehalfOf?.email || null;
  const forwardedBy = entry.rawPayload?.forwarded?.byEmail || null;
  const from = entry.rawPayload?.forwarded?.originalFrom || entry.actorEmail || null;
  // As if the ticket were in that status: closedMinutes from its real end
  // time, or 0 when it never ended.
  const asTicket = { ...ticket, status, ...(asTerminal && !ticket.closedAt && !ticket.resolvedAt ? { closedAt: new Date() } : {}) };
  const extra = {
    entryId: entry.id,
    from,
    fromName: entry.actorName || null,
    replyToWorkflowEmail,
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(forwardedBy ? { forwardedBy } : {}),
  };
  // What THIS workflow (its draft or the definition on screen) asks for decides the reading.
  const facts = await computeReplyFacts({
    ticket: asTicket,
    statusBase,
    extra,
    autoHelpVerdict: null,
    workflows: definition ? [{ id: null, triggerType: 'ticket.reply_received', publishedDefinition: definition }] : null,
    readOptions: { useAi: executeLlm === true },
  });
  // Without "Use AI" a reply the out-of-office and keyword checks cannot place has no reading.
  const replyVerdict = facts.verdictVia === 'no_ai' ? null : facts.replyVerdict;
  const factExtra = { ...facts.extra };
  if (!replyVerdict) delete factExtra.replyVerdict;
  const context = {
    ...eventContext,
    event: { ...(eventContext?.event || {}), extra: { ...(eventContext?.event?.extra || {}), ...extra, ...factExtra } },
    ticket: { ...(eventContext?.ticket || {}), status, statusBase, closedMinutes: facts.closedMinutes },
  };
  return {
    eventContext: context,
    asTerminal,
    replyPreviewBase: {
      sentBy: facts.sentBy,
      replyVerdict,
      closedMinutes: facts.closedMinutes,
      replyToWorkflowEmail,
    },
  };
}

export default { replyCandidates, prepareReplyPreview, previewOutcome };
