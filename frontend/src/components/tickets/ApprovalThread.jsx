import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Clock, Forward, Hourglass, Lock, MessageCircleQuestion, PenLine, Reply, Send, XCircle } from 'lucide-react';
import { PersonAvatar, SafeHtml, formatDayTime } from './ticketUi';
import { handoffSentence } from './ApprovalHandoff';

/**
 * Approvals v3 — the conversation on a request, mail-client style: the
 * agent's request, hand-offs between approvers, questions / answers / notes
 * (internal ones carry a lock badge and are never shown to the requester),
 * and the decision. One component for the magic-link page, the ticket's
 * Approvals tab and the requester's reply page.
 *
 *  items come from three sources and are merged by time:
 *   - the request note (approval.requestNote / requestNoteHtml, requestedByName, createdAt)
 *   - approval.escalationLog entries (kind escalated | forwarded | auto | auto_start)
 *   - approval_messages rows ({ id, kind, audience, author, bodyText, bodyHtml, to, cc, createdAt, inReplyToId })
 *  Legacy clarificationLog Q&A is shown only when no messages exist for it.
 */

export function WaitingOnApproverChip({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-100 ${className}`} data-testid="waiting-on-approver">
      <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
      Waiting on approver
    </span>
  );
}

const KIND_META = {
  request: { label: 'asks for approval', Icon: PenLine, rail: 'border-primary/60' },
  question: { label: 'asked', Icon: MessageCircleQuestion, rail: 'border-violet-500' },
  answer: { label: 'answered', Icon: Reply, rail: 'border-emerald-500' },
  comment: { label: 'wrote', Icon: PenLine, rail: 'border-border' },
  decision: { label: 'decided', Icon: CheckCircle2, rail: 'border-emerald-500' },
  handoff: { label: '', Icon: ArrowUpRight, rail: 'border-amber-500' },
};

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/** Build the ordered list of thread items from the pieces the caller has. */
export function buildThreadItems({ approval, messages = [], people = [] } = {}) {
  const items = [];
  const nameOf = (email) => people.find((p) => p.email === String(email || '').toLowerCase())?.name || null;
  if (approval && (approval.requestNoteHtml || approval.requestNote)) {
    items.push({
      key: 'request', kind: 'request', at: approval.createdAt || null,
      author: { name: approval.requestedByName || approval.requestedBy || 'The agent', email: approval.requestedByEmail || approval.requestedBy || null, role: 'agent', photoUrl: approval.requestedByPhotoUrl || null },
      bodyHtml: approval.requestNoteHtml || null, bodyText: approval.requestNote || null, audience: 'requester',
    });
  }
  // Every tier's row carries the hand-offs before it: show each one once.
  const seenHandoffs = new Set();
  for (const [i, h] of (Array.isArray(approval?.escalationLog) ? approval.escalationLog : []).entries()) {
    if (!h) continue;
    const handoffKey = [h.kind, h.at, String(h.byEmail || '').toLowerCase(), h.toTier, (h.toEmails || []).join(',')].join('|');
    if (seenHandoffs.has(handoffKey)) continue;
    seenHandoffs.add(handoffKey);
    const entry = { ...h, byName: h.byName || nameOf(h.byEmail) || h.byEmail || null, toNames: h.toNames?.length ? h.toNames : (h.toEmails || []).map((e) => nameOf(e) || e) };
    items.push({ key: `handoff-${i}`, kind: 'handoff', at: h.at || null, entry, author: { name: entry.byName, email: h.byEmail || null, role: 'approver' }, bodyText: h.note || null, audience: 'requester' });
  }
  const seenQuestions = new Set();
  for (const m of messages) {
    if (!m) continue;
    if (m.kind === 'question') seenQuestions.add(String(m.bodyText || '').trim());
    items.push({ key: `m-${m.id}`, kind: m.kind, at: m.createdAt || null, author: { ...(m.author || {}), name: m.author?.name || nameOf(m.author?.email) || m.author?.email || null }, bodyHtml: m.bodyHtml || null, bodyText: m.bodyText || null, audience: m.audience || 'requester', to: m.to || [], cc: m.cc || [], message: m });
  }
  // Legacy clarifications (pre-v3) — only the ones the message table does not already carry.
  for (const [i, c] of (Array.isArray(approval?.clarificationLog) ? approval.clarificationLog : []).entries()) {
    if (!c?.question || seenQuestions.has(String(c.question).trim())) continue;
    items.push({ key: `legacy-q-${i}`, kind: 'question', at: c.askedAt || null, author: { name: c.askedBy || approval.approverName || 'The approver', role: 'approver' }, bodyText: c.question, audience: 'requester', legacy: true });
    if (c.answer) items.push({ key: `legacy-a-${i}`, kind: 'answer', at: c.answeredAt || null, author: { name: c.answeredBy || approval.requestedByName || 'The agent', role: 'agent' }, bodyText: c.answer, audience: 'requester', legacy: true });
  }
  const t = (v) => (v ? new Date(v).getTime() || 0 : 0);
  // Stable: the request always first, then by time, ties keep insertion order.
  return items
    .map((it, idx) => ({ ...it, idx }))
    .sort((a, b) => (a.kind === 'request' ? -1 : b.kind === 'request' ? 1 : (t(a.at) - t(b.at)) || (a.idx - b.idx)));
}

/**
 * A recipient with their part in the request (27 Oct 2026, ticket 65030: "To
 * Seifeddine Reguige, Vahid Haeri" did not say who that was, or that the
 * requester was left out).
 */
export function roleLabel(email, participants) {
  if (!participants) return null;
  const e = String(email || '').toLowerCase();
  if (participants.requester?.email === e) return 'requester';
  if (participants.agent?.email === e) return 'agent';
  const ap = (participants.approvers || []).find((a) => a.email === e);
  if (ap) return participants.tierCount > 1 ? `Tier ${ap.tier || 1} approver` : 'approver';
  return null;
}

function ThreadItem({ item, viewerEmail, viewerRole, isDark, onAnswer, onAskRequester, participants, answeredIds, compact, nameOf = (e) => e }) {
  const [confirmAsk, setConfirmAsk] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const meta = KIND_META[item.kind] || KIND_META.comment;
  const Icon = meta.Icon;
  const internal = item.audience === 'internal';
  const when = item.at ? formatDayTime(item.at) : null;
  const isMine = viewerEmail && item.author?.email && String(item.author.email).toLowerCase() === String(viewerEmail).toLowerCase();
  const who = isMine ? 'You' : (item.author?.name || item.author?.email || 'Someone');
  const decided = item.kind === 'decision';
  // 'Not approved' since 18 Sep 2026; 'Rejected' on messages written before.
  const rejected = decided && /^(rejected|not approved)/i.test(item.bodyText || '');
  const railClass = decided ? (rejected ? 'border-red-500' : 'border-emerald-500') : meta.rail;
  const bg = decided
    ? (rejected ? 'bg-red-50/60 dark:bg-red-500/10' : 'bg-emerald-50/60 dark:bg-emerald-500/10')
    : item.kind === 'handoff' ? 'bg-amber-50/60 dark:bg-amber-500/10'
      : internal ? 'bg-muted/50' : item.kind === 'question' ? 'bg-violet-50/50 dark:bg-violet-500/10' : 'bg-card';
  const addressedToMe = item.kind === 'question' && !item.legacy && viewerEmail && [...(item.to || []), ...(item.cc || [])].map((e) => String(e).toLowerCase()).includes(String(viewerEmail).toLowerCase());
  const open = item.kind === 'question' && !item.legacy && item.message && !answeredIds.has(item.message.id);
  const canAnswer = open && typeof onAnswer === 'function' && (addressedToMe || viewerRole === 'admin');
  const named = (e) => { const r = roleLabel(e, participants); return r ? `${nameOf(e)} (${r})` : nameOf(e); };
  const requester = participants?.requester || null;
  const requesterName = requester ? (requester.name || nameOf(requester.email)) : null;
  const requesterLeftOut = internal && requester && ![...(item.to || []), ...(item.cc || [])].map((e) => String(e).toLowerCase()).includes(requester.email);
  const toLine = item.kind === 'question' && (item.to?.length || item.cc?.length)
    ? `To ${item.to.map(named).join(', ')}${item.cc?.length ? ` · Cc ${item.cc.map(named).join(', ')}` : ''}`
    : null;
  // Anyone on the request (or an admin) can send an open internal question to the requester instead.
  const viewer = String(viewerEmail || '').toLowerCase();
  const onRequest = viewerRole === 'admin' || Boolean(roleLabel(viewer, participants)) || [item.author?.email, ...(item.to || []), ...(item.cc || [])].some((e) => String(e || '').toLowerCase() === viewer);
  const canAskRequester = open && internal && requesterLeftOut && typeof onAskRequester === 'function' && Boolean(viewer) && onRequest;
  const askerFirst = isMine ? 'your' : (firstNameOf(item.author?.name) ? `${firstNameOf(item.author?.name)}'s` : 'the');
  // Everyone it was addressed to, the asker and whoever sends it on are on Cc ("you" last).
  const copiedEmails = [...new Set([...(item.to || []), ...(item.cc || []), item.author?.email].map((e) => String(e || '').toLowerCase()).filter((e) => e && e !== viewer))];
  const copied = [...copiedEmails.map((e) => firstNameOf(nameOf(e))), ...(viewer ? ['you'] : [])];
  const copiedText = copied.length > 1 ? `${copied.slice(0, -1).join(', ')} and ${copied[copied.length - 1]}` : copied[0] || '';

  let sentence;
  if (item.kind === 'handoff') sentence = handoffSentence(item.entry, { withNote: false }).replace(/^An approver /, `${item.author?.name || 'An approver'} `);
  else if (item.kind === 'request') sentence = `${who} ${meta.label}`;
  else if (decided) sentence = `${who} ${rejected ? 'did not approve' : 'approved'}${/with condition/i.test(item.bodyText || '') ? ' with a condition' : ''}`;
  else sentence = `${who} ${meta.label}`;

  return (
    <li className={`relative rounded-r-xl border-l-[3px] ${railClass} ${bg} ${compact ? 'px-3 py-2' : 'px-3.5 py-3'}`} data-kind={item.kind} data-audience={item.audience}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        {item.kind !== 'handoff' && <PersonAvatar name={item.author?.name || item.author?.email} photoUrl={item.author?.photoUrl || null} size="h-6 w-6" textSize="text-[9px]" />}
        {item.kind === 'handoff' && <span className="grid h-6 w-6 place-items-center rounded-full bg-amber-200/70 text-amber-800 dark:bg-amber-500/25 dark:text-amber-100"><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span>}
        <span className="font-semibold text-foreground">{sentence}</span>
        {item.author?.role && item.kind !== 'handoff' && <span className="rounded border border-border bg-muted/60 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{item.author.role}</span>}
        {internal && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-1.5 py-px text-[10px] font-semibold text-muted-foreground" title="Internal — the requester does not see this">
            <Lock className="h-2.5 w-2.5" aria-hidden="true" /> Internal
          </span>
        )}
        {when && <span className="ml-auto text-[11px] text-muted-foreground" title={item.at ? new Date(item.at).toLocaleString() : undefined}>{when}</span>}
      </div>
      {toLine && (
        <p className="mt-0.5 pl-8 text-[11px] text-muted-foreground" title={toLine}>
          {toLine}
          {requesterLeftOut && <span className="font-semibold text-foreground/85"> · {requesterName} (requester) not asked</span>}
        </p>
      )}
      {(item.bodyHtml || item.bodyText) && (
        <div className={`mt-1.5 pl-8 text-[13.5px] leading-relaxed text-foreground/90 ${item.kind === 'handoff' ? 'italic text-muted-foreground' : ''}`}>
          {item.bodyHtml
            ? <SafeHtml html={item.bodyHtml} className="text-[13.5px] leading-relaxed" isDark={isDark} preferThemed />
            : <p className="whitespace-pre-wrap">{item.kind === 'handoff' ? `“${item.bodyText}”` : item.bodyText}</p>}
        </div>
      )}
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
          {canAnswer ? (
            <button type="button" onClick={() => onAnswer(item.message)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-violet-700">
              <Reply className="h-3.5 w-3.5" aria-hidden="true" /> Answer
            </button>
          ) : !canAskRequester && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Waiting for {item.audience === 'internal' ? 'an answer from the approvers / agent' : `a reply from ${firstNameOf(nameOf(item.to?.[0])) || 'the requester'}`}
            </span>
          )}
          {canAskRequester && !confirmAsk && (
            <button type="button" onClick={() => setConfirmAsk(true)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-violet-300 px-2.5 py-1 text-[12px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-200 dark:hover:bg-violet-500/15">
              <Send className="h-3.5 w-3.5" aria-hidden="true" /> Ask {firstNameOf(requesterName) || 'the requester'} instead
            </button>
          )}
        </div>
      )}
      {canAskRequester && confirmAsk && (
        <div className="mt-2 ml-8 rounded-lg border border-violet-200 bg-card px-3 py-2 text-[12px] text-foreground/85 dark:border-violet-500/30" role="group" aria-label="Send this question to the requester">
          <p>
            {requesterName} gets {askerFirst} question by e-mail, as a reply on the ticket.{copiedText ? ` ${copiedText[0].toUpperCase()}${copiedText.slice(1)} ${copied.length === 1 && copied[0] !== 'you' ? 'is' : 'are'} on Cc.` : ''}
            {' '}Their answer comes back here and goes to {isMine ? 'you' : firstNameOf(item.author?.name) || 'the asker'} with a link to decide. The request waits until then.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={askBusy}
              onClick={async () => { setAskBusy(true); try { await onAskRequester(item.message); setConfirmAsk(false); } finally { setAskBusy(false); } }}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" /> {askBusy ? 'Sending…' : `Send to ${firstNameOf(requesterName) || 'the requester'}`}
            </button>
            <button type="button" onClick={() => setConfirmAsk(false)} className="tp-focus-ring rounded-lg px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function ApprovalThread({
  approval, messages = [], people = [], viewerEmail = null, viewerRole = null, isDark = false, onAnswer = null, awaitingApprover = false, compact = false, title = 'Conversation', showTitle = true, emptyText = null,
  participants = null, onAskRequester = null,
}) {
  const items = buildThreadItems({ approval, messages, people });
  const nameOf = (email) => people.find((p) => p?.email === String(email || '').toLowerCase())?.name || email;
  const answeredIds = new Set((messages || []).filter((m) => m?.kind === 'answer' && m.inReplyToId).map((m) => m.inReplyToId));
  const showWaiting = awaitingApprover && viewerRole !== 'approver';
  if (!items.length && !showWaiting) return emptyText ? <p className="text-[13px] text-muted-foreground">{emptyText}</p> : null;
  return (
    <section aria-label={title} className={compact ? '' : 'mt-1'} data-testid="approval-thread">
      {(showTitle || showWaiting) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {showTitle && <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>}
          {showWaiting && <WaitingOnApproverChip className="ml-auto" />}
        </div>
      )}
      <ol className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-2.5'}`}>
        {items.map((item) => (
          <ThreadItem key={item.key} item={item} viewerEmail={viewerEmail} viewerRole={viewerRole} isDark={isDark} onAnswer={onAnswer} onAskRequester={onAskRequester} participants={participants} answeredIds={answeredIds} compact={compact} nameOf={nameOf} />
        ))}
      </ol>
    </section>
  );
}

export { XCircle as ThreadRejectIcon, Forward as ThreadForwardIcon };
