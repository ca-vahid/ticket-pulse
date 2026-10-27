import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Clock, CornerDownRight, Forward, Hourglass, Lock, MessageCircleQuestion, PenLine, Reply, Send, XCircle } from 'lucide-react';
import { PersonAvatar, SafeHtml, formatDayTime } from './ticketUi';
import { handoffSentence } from './ApprovalHandoff';

/**
 * Approvals v3 — the conversation on a request, oldest first, newest last:
 * the agent's request, hand-offs between approvers, questions / answers /
 * notes (internal ones carry a lock and are never shown to the requester),
 * and the decision. One component for the magic-link page, the ticket's
 * Approvals tab and the requester's reply page.
 *
 *  items come from three sources and are merged by time:
 *   - the request note (approval.requestNote / requestNoteHtml, requestedByName, createdAt)
 *   - approval.escalationLog entries (kind escalated | forwarded | auto | auto_start)
 *   - approval_messages rows ({ id, kind, audience, author, bodyText, bodyHtml, to, cc, createdAt, inReplyToId })
 *  Legacy clarificationLog Q&A is shown only when no messages exist for it.
 *
 * 26 Oct 2026 (ticket 65030): "Ask the requester instead" stores a second
 * copy of the question (to the requester) plus an internal "Sent to … to
 * answer" answer row on the first. Both fold into the original question as a
 * hand-off line — the question shows once.
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
  request: { label: 'asks for approval', Icon: PenLine, rule: 'border-primary/50' },
  question: { label: 'asked', Icon: MessageCircleQuestion, rule: 'border-violet-400 dark:border-violet-400/70' },
  answer: { label: 'answered', Icon: Reply, rule: 'border-emerald-400 dark:border-emerald-400/70' },
  comment: { label: 'wrote', Icon: PenLine, rule: 'border-border' },
  decision: { label: 'decided', Icon: CheckCircle2, rule: 'border-emerald-400' },
  handoff: { label: '', Icon: ArrowUpRight, rule: 'border-amber-400' },
};

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

const lc = (v) => String(v || '').toLowerCase();
const ms = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * The shape of the conversation behind the messages: which questions were
 * answered, which were sent on to the requester ("Ask … instead") and which
 * rows are only the bookkeeping of that hand-off.
 *   relays:  original question id → { copy, marker } (copy = the requester-audience question)
 *   hidden:  ids folded into another item (the copy and the marker)
 *   answered: ids with a real answer
 *   open:    the questions still waiting, newest last — each as the message an
 *            answer should be sent to (the copy for a relayed question)
 */
export function threadState(messages = []) {
  const list = (messages || []).filter(Boolean);
  const byId = new Map(list.map((m) => [m.id, m]));
  const relays = new Map();
  const hidden = new Set();
  for (const m of list) {
    if (m.kind !== 'answer' || m.audience !== 'internal' || !m.inReplyToId) continue;
    const q = byId.get(m.inReplyToId);
    if (!q || q.kind !== 'question' || q.audience !== 'internal') continue;
    const copy = list.find((r) => r.kind === 'question' && r.audience === 'requester' && r.id !== q.id && !hidden.has(r.id)
      && lc(r.author?.email) === lc(q.author?.email)
      && String(r.bodyText || '').trim() === String(q.bodyText || '').trim()
      && Math.abs(ms(r.createdAt) - ms(m.createdAt)) < 10 * 60 * 1000);
    if (!copy) continue;
    relays.set(q.id, { copy, marker: m });
    hidden.add(copy.id);
    hidden.add(m.id);
  }
  const answered = new Set(list.filter((m) => m.kind === 'answer' && m.inReplyToId && !hidden.has(m.id)).map((m) => m.inReplyToId));
  const open = list
    .filter((m) => m.kind === 'question' && !hidden.has(m.id))
    .map((m) => relays.get(m.id)?.copy || m)
    .filter((m) => !answered.has(m.id));
  return { relays, hidden, answered, open, byId };
}

/** Build the ordered list of thread items from the pieces the caller has. */
export function buildThreadItems({ approval, messages = [], people = [] } = {}) {
  const items = [];
  const nameOf = (email) => people.find((p) => p?.email === lc(email))?.name || null;
  const state = threadState(messages);
  if (approval && (approval.requestNoteHtml || approval.requestNote)) {
    items.push({
      key: 'request', kind: 'request', at: approval.createdAt || null,
      author: { name: approval.requestedByName || nameOf(approval.requestedBy) || approval.requestedBy || 'The agent', email: approval.requestedByEmail || approval.requestedBy || null, role: 'agent', photoUrl: approval.requestedByPhotoUrl || null },
      bodyHtml: approval.requestNoteHtml || null, bodyText: approval.requestNote || null, audience: 'requester',
    });
  }
  // Every tier's row carries the hand-offs before it: show each one once.
  const seenHandoffs = new Set();
  for (const [i, h] of (Array.isArray(approval?.escalationLog) ? approval.escalationLog : []).entries()) {
    if (!h) continue;
    const handoffKey = [h.kind, h.at, lc(h.byEmail), h.toTier, (h.toEmails || []).join(',')].join('|');
    if (seenHandoffs.has(handoffKey)) continue;
    seenHandoffs.add(handoffKey);
    const entry = { ...h, byName: h.byName || nameOf(h.byEmail) || h.byEmail || null, toNames: h.toNames?.length ? h.toNames : (h.toEmails || []).map((e) => nameOf(e) || e) };
    items.push({ key: `handoff-${i}`, kind: 'handoff', at: h.at || null, entry, author: { name: entry.byName, email: h.byEmail || null, role: 'approver' }, bodyText: h.note || null, audience: 'requester' });
  }
  const seenQuestions = new Set();
  const seenMessageIds = new Set();
  for (const m of messages) {
    if (!m) continue;
    seenMessageIds.add(m.id);
    if (m.kind === 'question') seenQuestions.add(String(m.bodyText || '').trim());
    if (state.hidden.has(m.id)) continue;
    const relay = state.relays.get(m.id) || null;
    items.push({
      key: `m-${m.id}`, kind: m.kind, at: m.createdAt || null,
      author: { ...(m.author || {}), name: m.author?.name || nameOf(m.author?.email) || m.author?.email || null },
      bodyHtml: m.bodyHtml || null, bodyText: m.bodyText || null, audience: m.audience || 'requester', to: m.to || [], cc: m.cc || [], message: m,
      // Sent on to the requester: the hand-off, and the copy answers go to.
      relay: relay ? {
        at: relay.marker.createdAt || relay.copy.createdAt || null,
        by: { email: relay.marker.author?.email || null, name: relay.marker.author?.name || nameOf(relay.marker.author?.email) || relay.marker.author?.email || null },
        to: relay.copy.to || [], cc: relay.copy.cc || [],
      } : null,
      target: relay ? relay.copy : m,
    });
  }
  // Legacy clarifications (pre-v3) — only the ones the message table does not already carry.
  for (const [i, c] of (Array.isArray(approval?.clarificationLog) ? approval.clarificationLog : []).entries()) {
    if (!c?.question) continue;
    if ((c.messageId && seenMessageIds.has(c.messageId)) || seenQuestions.has(String(c.question).trim())) continue;
    items.push({ key: `legacy-q-${i}`, kind: 'question', at: c.askedAt || null, author: { name: nameOf(c.askedBy) || c.askedBy || approval.approverName || 'The approver', email: c.askedBy || null, role: 'approver' }, bodyText: c.question, audience: 'requester', legacy: true });
    if (c.answer) items.push({ key: `legacy-a-${i}`, kind: 'answer', at: c.answeredAt || null, author: { name: nameOf(c.answeredBy) || c.answeredBy || approval.requestedByName || 'The agent', email: c.answeredBy || null, role: 'agent' }, bodyText: c.answer, audience: 'requester', legacy: true });
  }
  // Stable: the request always first, then by time, ties keep insertion order.
  return items
    .map((it, idx) => ({ ...it, idx }))
    .sort((a, b) => (a.kind === 'request' ? -1 : b.kind === 'request' ? 1 : (ms(a.at) - ms(b.at)) || (a.idx - b.idx)));
}

/**
 * A recipient with their part in the request (27 Oct 2026, ticket 65030: "To
 * Seifeddine Reguige, Vahid Haeri" did not say who that was, or that the
 * requester was left out).
 */
export function roleLabel(email, participants) {
  if (!participants) return null;
  const e = lc(email);
  if (participants.requester?.email === e) return 'requester';
  if (participants.agent?.email === e) return 'agent';
  const ap = (participants.approvers || []).find((a) => a.email === e);
  if (ap) return participants.tierCount > 1 ? `Tier ${ap.tier || 1} approver` : 'approver';
  return null;
}

/** "A, B and C" */
export function andList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function ThreadItem({ item, viewerEmail, viewerRole, isDark, onAnswer, onAskRequester, participants, answeredIds, compact, nameOf = (e) => e, latest = false, last = false, showOpenState = true }) {
  const [confirmAsk, setConfirmAsk] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const meta = KIND_META[item.kind] || KIND_META.comment;
  const Icon = meta.Icon;
  const internal = item.audience === 'internal';
  const when = item.at ? formatDayTime(item.at) : null;
  const viewer = lc(viewerEmail);
  const isMine = viewer && item.author?.email && lc(item.author.email) === viewer;
  const who = isMine ? 'You' : (item.author?.name || item.author?.email || 'Someone');
  const decided = item.kind === 'decision';
  // 'Not approved' since 18 Sep 2026; 'Rejected' on messages written before.
  const rejected = decided && /^(rejected|not approved)/i.test(item.bodyText || '');
  const rule = decided ? (rejected ? 'border-red-400' : 'border-emerald-400') : meta.rule;
  const target = item.target || item.message || null;
  const relay = item.relay || null;
  const addressees = [...(target?.to || []), ...(target?.cc || [])].map(lc);
  const addressedToMe = item.kind === 'question' && !item.legacy && viewer && addressees.includes(viewer);
  const open = item.kind === 'question' && !item.legacy && target && !answeredIds.has(target.id);
  // Never your own question (an admin approver saw "Answer" under what they asked).
  const canAnswer = open && !isMine && typeof onAnswer === 'function' && (addressedToMe || viewerRole === 'admin');
  const named = (e) => { const r = roleLabel(e, participants); return r ? `${nameOf(e)} (${r})` : nameOf(e); };
  const requester = participants?.requester || null;
  const requesterName = requester ? (requester.name || nameOf(requester.email)) : null;
  const requesterLeftOut = internal && !relay && requester && ![...(item.to || []), ...(item.cc || [])].map(lc).includes(requester.email);
  const toLine = item.kind === 'question' && (item.to?.length || item.cc?.length)
    ? `To ${item.to.map(named).join(', ')}${item.cc?.length ? ` · Cc ${item.cc.map(named).join(', ')}` : ''}`
    : null;
  // Anyone on the request (or an admin) can send an open internal question to the requester instead.
  const onRequest = viewerRole === 'admin' || Boolean(roleLabel(viewer, participants)) || [item.author?.email, ...(item.to || []), ...(item.cc || [])].some((e) => lc(e) === viewer);
  const canAskRequester = open && internal && !relay && requesterLeftOut && typeof onAskRequester === 'function' && Boolean(viewer) && onRequest;
  const askerFirst = isMine ? 'your' : (firstNameOf(item.author?.name) ? `${firstNameOf(item.author?.name)}'s` : 'the');
  // Everyone it was addressed to, the asker and whoever sends it on are on Cc ("you" last).
  const copiedEmails = [...new Set([...(item.to || []), ...(item.cc || []), item.author?.email].map(lc).filter((e) => e && e !== viewer))];
  const copied = [...copiedEmails.map((e) => firstNameOf(nameOf(e))), ...(viewer ? ['you'] : [])];
  const copiedText = andList(copied);
  const authorRole = item.kind === 'handoff' ? null : (roleLabel(item.author?.email, participants) || item.author?.role || null);

  let sentence;
  if (item.kind === 'handoff') sentence = handoffSentence(item.entry, { withNote: false }).replace(/^An approver /, `${item.author?.name || 'An approver'} `);
  else if (decided) sentence = `${who} ${rejected ? 'did not approve' : 'approved'}${/with condition/i.test(item.bodyText || '') ? ' with a condition' : ''}`;
  else if (item.kind === 'request' && isMine) sentence = 'You asked for approval';
  else sentence = `${who} ${meta.label}`;
  // A question sent on later: "Latest" belongs to that hand-off line, not the question's own time.
  const latestOnRelay = latest && Boolean(relay);

  // The hand-off of a question to the requester, read as a sentence.
  const relayLine = relay ? (() => {
    const byMine = viewer && lc(relay.by.email) === viewer;
    const toNames = relay.to.map((e) => named(e));
    const ccNames = relay.cc.map(lc).filter((e) => e !== lc(relay.by.email)).map((e) => (e === viewer ? 'you' : firstNameOf(nameOf(e))));
    return `${byMine ? 'You' : relay.by.name || 'Someone'} sent this question to ${andList(toNames)}${ccNames.length ? `, with ${andList(ccNames)} on Cc` : ''}`;
  })() : null;

  return (
    <li className="relative flex gap-3" data-kind={item.kind} data-audience={item.audience} data-latest={latest ? 'true' : undefined}>
      {/* rail: avatar (or the hand-off arrow) + the line down to the next message */}
      <div className="relative flex flex-col items-center">
        {item.kind === 'handoff' ? (
          <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100 ${latest ? 'ring-2 ring-primary/50 ring-offset-2 ring-offset-card' : ''}`}><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span>
        ) : (
          <span className={`shrink-0 rounded-full ${latest ? 'ring-2 ring-primary/50 ring-offset-2 ring-offset-card' : ''}`}>
            <PersonAvatar name={item.author?.name || item.author?.email} photoUrl={item.author?.photoUrl || null} size="h-7 w-7" textSize="text-[10px]" />
          </span>
        )}
        {!last && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className={`min-w-0 flex-1 ${last ? '' : compact ? 'pb-4' : 'pb-5'}`}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pt-1 text-[13px]">
          <span className="font-semibold text-foreground">{sentence}</span>
          {authorRole && <span className="text-[12px] text-muted-foreground">{authorRole}</span>}
          {internal && (
            <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground" title="Internal — the requester does not see this">
              <Lock className="h-3 w-3 self-center" aria-hidden="true" /><span>Internal</span>
            </span>
          )}
          {when && (
            <span className={`ml-auto whitespace-nowrap text-[12px] ${latest && !latestOnRelay ? 'font-semibold text-primary' : 'text-muted-foreground'}`} title={item.at ? new Date(item.at).toLocaleString() : undefined}>
              {latest && !latestOnRelay ? `Latest · ${when}` : when}
            </span>
          )}
        </div>
        {toLine && (
          <p className="mt-0.5 text-[12px] text-muted-foreground" title={toLine}>
            {toLine}
            {requesterLeftOut && <span className="font-semibold text-foreground/85"> · {requesterName} (requester) not asked</span>}
          </p>
        )}
        {(item.bodyHtml || item.bodyText) && (
          <div className={`mt-1.5 text-[14px] leading-relaxed text-foreground/90 ${item.kind === 'handoff' ? 'text-muted-foreground' : `border-l-2 ${rule} pl-3`}`}>
            {item.bodyHtml
              ? <SafeHtml html={item.bodyHtml} className="text-[14px] leading-relaxed" isDark={isDark} preferThemed />
              : <p className="whitespace-pre-wrap">{item.kind === 'handoff' ? `“${item.bodyText}”` : item.bodyText}</p>}
          </div>
        )}
        {relayLine && (
          <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-foreground/85" data-testid="question-relayed">
            <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-300" aria-hidden="true" />
            <span>
              {relayLine}
              {relay.at && <span className={latestOnRelay ? 'font-semibold text-primary' : 'text-muted-foreground'} title={new Date(relay.at).toLocaleString()}> · {latestOnRelay ? 'Latest · ' : ''}{formatDayTime(relay.at)}</span>}
            </span>
          </p>
        )}
        {open && (showOpenState || canAskRequester || canAnswer) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canAnswer ? (
              <button type="button" onClick={() => onAnswer(target)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-violet-700">
                <Reply className="h-3.5 w-3.5" aria-hidden="true" /> Answer
              </button>
            ) : !canAskRequester && showOpenState && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Waiting for {target?.audience === 'internal' ? 'an answer from the approvers / agent' : `a reply from ${firstNameOf(nameOf(target?.to?.[0])) || 'the requester'}`}
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
          <div className="mt-2 rounded-lg border border-violet-200 bg-card px-3 py-2 text-[12px] text-foreground/85 dark:border-violet-500/30" role="group" aria-label="Send this question to the requester">
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
      </div>
    </li>
  );
}

export default function ApprovalThread({
  approval, messages = [], people = [], viewerEmail = null, viewerRole = null, isDark = false, onAnswer = null, awaitingApprover = false, compact = false, title = 'Conversation', showTitle = true, emptyText = null,
  participants = null, onAskRequester = null,
  // false = the caller shows who the request waits on (the ticket's status line), so items skip "Waiting for …".
  showOpenState = true,
}) {
  const items = buildThreadItems({ approval, messages, people });
  const nameOf = (email) => people.find((p) => p?.email === lc(email))?.name || email;
  const { answered: answeredIds } = threadState(messages);
  const showWaiting = awaitingApprover && viewerRole !== 'approver';
  if (!items.length && !showWaiting) return emptyText ? <p className="text-[13px] text-muted-foreground">{emptyText}</p> : null;
  return (
    <section aria-label={title} className={compact ? '' : 'mt-1'} data-testid="approval-thread">
      {(showTitle || showWaiting) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {showTitle && <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>}
          {showWaiting && <WaitingOnApproverChip className="ml-auto" />}
        </div>
      )}
      <ol className="flex flex-col">
        {items.map((item, i) => (
          <ThreadItem
            key={item.key}
            item={item}
            viewerEmail={viewerEmail}
            viewerRole={viewerRole}
            isDark={isDark}
            onAnswer={onAnswer}
            onAskRequester={onAskRequester}
            participants={participants}
            answeredIds={answeredIds}
            compact={compact}
            nameOf={nameOf}
            latest={items.length > 1 && i === items.length - 1}
            last={i === items.length - 1}
            showOpenState={showOpenState}
          />
        ))}
      </ol>
    </section>
  );
}

export { XCircle as ThreadRejectIcon, Forward as ThreadForwardIcon };
