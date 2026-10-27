import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ApprovalLaptop from './ApprovalLaptop';
import {
  Activity, ArrowUpRight, Ban, CheckCircle2, ChevronDown, ChevronRight, Clock, Forward, Hourglass, MessageCircleQuestion, Minimize2, RefreshCw, Reply, Trash2, XCircle,
} from 'lucide-react';
import { PersonAvatar, SafeHtml, formatDayTime, timeAgo } from './ticketUi';
import { AmountChip, TierChip } from './ApprovalHandoff';
import ApprovalComposer from './ApprovalComposer';
import { ConditionsAnswerForm, ConditionsReview, conditionsWaitingOn, readConditions } from './ApprovalConditions';
import ApprovalThread, { andList, buildThreadItems, threadState } from './ApprovalThread';
import RichTextEditor, { isRichContent } from './RichTextEditor';
import { ticketsAPI } from '../../services/api';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';
import { cleanNoteText } from '../../utils/noteText';
import { StatusIcon, ageText, rowToggleProps, spanText } from '../approvals/ApprovalRows';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const orList = (names) => {
  const list = (names || []).filter(Boolean);
  return list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
};

/**
 * The one place to write on an open request (26 Oct 2026, ticket 65030): its
 * heading says what is being written and who gets it. Here: an answer to an
 * open question. Folded to one line when the viewer was only copied.
 */
function AnswerComposer({ message, heading, recipients, folded: startFolded = false, foldedText = null, busy, onSend, secondary = null }) {
  const [text, setText] = useState('');
  const [html, setHtml] = useState('');
  const [folded, setFolded] = useState(startFolded);
  const ref = useRef(null);
  // Full screen (27 Oct 2026): an answer is often a whole e-mail, so it gets
  // the same large dialog as the decision note.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);
  const toggleExpanded = () => {
    setExpanded((v) => !v);
    setTimeout(() => ref.current?.focus?.(), 0);
  };
  // Focus follows a click only — focusing on arrival scrolls the ticket page (23 Sep 2026).
  const [focusNext, setFocusNext] = useState(false);
  useEffect(() => { if (focusNext && !folded) { ref.current?.focus(); setFocusNext(false); } }, [focusNext, folded]);
  if (folded) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="answer-box" data-folded="true">
        <p className="text-[13px] text-muted-foreground">{foldedText}</p>
        <button type="button" onClick={() => { setFolded(false); setFocusNext(true); }} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-1 text-[12px] font-semibold text-foreground hover:bg-muted">
          <Reply className="h-3.5 w-3.5" aria-hidden="true" /> Answer it yourself
        </button>
        {secondary}
      </div>
    );
  }
  const body = (
    <div
      data-testid="answer-box"
      data-message-id={message?.id}
      className={expanded ? 'tp-card fixed inset-0 z-50 flex flex-col overflow-y-auto settings-scrollbar p-4 shadow-soft sm:inset-4 sm:rounded-xl sm:p-5 lg:inset-x-[max(1.5rem,calc(50vw_-_40rem))]' : undefined}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? heading : undefined}
      onKeyDown={expanded ? (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setExpanded(false); } } : undefined}
    >
      <div className={expanded ? 'mb-3 flex items-start gap-3 border-b border-border/70 pb-3' : ''}>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">{heading}</p>
          {recipients && <p className="mt-0.5 mb-2 text-[12.5px] text-muted-foreground">{recipients}</p>}
        </div>
        {expanded && (
          <button type="button" onClick={toggleExpanded} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> Exit full screen
          </button>
        )}
      </div>
      <RichTextEditor
        ref={ref}
        value={html}
        onChange={({ html: h, text: t }) => { setHtml(h); setText(t); }}
        placeholder="Your answer…"
        ariaLabel="Your answer"
        minHeight={expanded ? 360 : 120}
        className={`border-input bg-card ${expanded ? 'min-h-[45vh]' : ''}`}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={async () => { const t = text.trim(); if (!t) return; await onSend({ bodyText: t, bodyHtml: isRichContent(html) ? html : null }); setExpanded(false); }}
          disabled={busy || !text.trim()}
          className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Reply className="h-3.5 w-3.5" aria-hidden="true" />} Send answer
        </button>
        {secondary}
      </div>
    </div>
  );
  // Full screen moves it into a portal on <body>, so no transformed ancestor traps the fixed panel.
  if (!expanded || typeof document === 'undefined') return body;
  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/45" aria-hidden="true" onClick={() => setExpanded(false)} />
      {body}
    </>,
    document.body,
  );
}

// Approvals v2: the category's tier chain as the request modal sees it.
const chainOf = (cat) => (Array.isArray(cat?.tiers) && cat.tiers.length
  ? cat.tiers
  : [{ name: 'Tier 1', managerEmails: cat?.managerEmails || [], limit: null }]);

// Per-approver / verdict status → color-coded look (dot, chip, text, header tint).
const STATUS = {
  approved: { label: 'Approved', verb: 'Approved', Icon: CheckCircle2, dot: 'bg-emerald-500', chip: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30', text: 'text-emerald-700 dark:text-emerald-200', head: 'bg-emerald-50/70 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20' },
  rejected: { label: 'Not approved', verb: 'Not approved', Icon: XCircle, dot: 'bg-red-500', chip: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30', text: 'text-red-700 dark:text-red-200', head: 'bg-red-50/70 dark:bg-red-500/10 border-red-100 dark:border-red-500/20' },
  info_requested: { label: 'Needs info', verb: 'Clarification requested', Icon: MessageCircleQuestion, dot: 'bg-violet-500', chip: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30', text: 'text-violet-700 dark:text-violet-200', head: 'bg-violet-50/70 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20' },
  cancelled: { label: 'Cancelled', verb: 'Cancelled', Icon: Ban, dot: 'bg-muted-foreground/40', chip: 'bg-muted text-muted-foreground border-border', text: 'text-muted-foreground', head: 'bg-muted/50 border-border/60' },
  escalated: { label: 'Escalated', verb: 'Escalated', Icon: ArrowUpRight, dot: 'bg-amber-500', chip: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', text: 'text-amber-700 dark:text-amber-200', head: 'bg-amber-50/60 dark:bg-amber-500/10 border-amber-100 dark:border-amber-500/20' },
  forwarded: { label: 'Forwarded', verb: 'Forwarded', Icon: Forward, dot: 'bg-blue-500', chip: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', text: 'text-blue-700 dark:text-blue-200', head: 'bg-blue-50/60 dark:bg-blue-500/10 border-blue-100 dark:border-blue-500/20' },
  pending: { label: 'Pending', verb: 'Pending', Icon: Clock, dot: 'bg-amber-400', chip: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', text: 'text-amber-700 dark:text-amber-200', head: 'bg-amber-50/60 dark:bg-amber-500/10 border-amber-100 dark:border-amber-500/20' },
};
const statusMeta = (s) => STATUS[s] || STATUS.pending;

// Any-one-approves: the group verdict is the strongest outcome present.
const VERDICT_ORDER = ['approved', 'rejected', 'info_requested', 'pending', 'escalated', 'forwarded', 'cancelled'];
const groupVerdict = (rows) => VERDICT_ORDER.find((s) => rows.some((r) => r.status === s)) || 'pending';
// A decided group needs no interaction — collapse it to a one-line summary.
const TERMINAL = new Set(['approved', 'rejected', 'cancelled']);

// A cancelled row that was auto-cancelled by a sibling decision reads as
// "Superseded"; a requester-cancelled one stays "Cancelled".
const rowLabel = (ap) => {
  if (ap.status === 'cancelled' && /^superseded/i.test(ap.decisionNote || '')) return 'Superseded';
  if (ap.status === 'escalated') {
    const last = [...(ap.escalationLog || [])].reverse()[0];
    return last?.kind === 'auto' ? 'Approved · sent up' : 'Escalated';
  }
  return statusMeta(ap.status).label;
};

/**
 * The ticket's Approvals tab. Each request (one category fanned out to its
 * managers, tied by requestGroupId) is one row of a list: status, category and
 * who it waits on. Opening it shows the approvers, the whole conversation and
 * the one composer that fits the viewer.
 */
/** Approver avatar: roster photo when the workspace knows one, else the directory photo by e-mail (app-only members). */
function ApproverAvatar({ email, name, photoUrl, size = 'h-8 w-8', textSize = 'text-[10px]' }) {
  const fetched = useRequesterPhoto(photoUrl ? null : email);
  const url = photoUrl || (typeof fetched === 'string' ? fetched : fetched?.photo) || null;
  return <PersonAvatar name={name || email} photoUrl={url} size={size} textSize={textSize} />;
}

export default function ApprovalTimeline({
  approvals = [], meta, savingField,
  onDecide, onResubmit, onCancel, onChangeDecision, onDeleteRequest,
  onEscalate, onForward,
  // Approvals v3
  ticketId = null, requester = null, onAsk, onAnswer,
  // 27 Oct 2026: an internal question goes to the requester instead.
  onAskRequester = null,
  // 26 Oct 2026: IT answers an approver's conditions ({ answers, submit }).
  onAnswerConditions = null,
  // Assetron (24 Sep 2026)
  canChangeHardware = () => false, onChangeHardware = null,
}) {
  // Assetron laptop holds for this ticket's requests — one read for the whole
  // timeline, refreshed when the approvals change. Never breaks the timeline.
  const [holds, setHolds] = useState({});
  useEffect(() => {
    let alive = true;
    const hasGroups = (approvals || []).some((a) => a.requestGroupId);
    if (!ticketId || !hasGroups || typeof ticketsAPI.assetronHolds !== 'function') { setHolds({}); return undefined; }
    Promise.resolve()
      .then(() => ticketsAPI.assetronHolds(ticketId))
      .then((res) => { if (alive) setHolds(res?.data || {}); })
      .catch(() => { if (alive) setHolds({}); });
    return () => { alive = false; };
  }, [ticketId, approvals]);
  const actorEmail = String(meta?.actor?.email || '').toLowerCase();
  const actorIsAdmin = meta?.actor?.kind === 'admin' || meta?.actor?.workspaceRole === 'admin';
  // Rows an admin chose to hand on (the forward composer stays folded until asked for).
  const [forwardOpen, setForwardOpen] = useState(() => new Set());
  // Requests the viewer opened or folded against their default (open ones start open).
  const [flipped, setFlipped] = useState(() => new Set());
  // Requester replies to a needs-info question, keyed per approval row (QA 07-14 #1).
  const [resubmitNotes, setResubmitNotes] = useState({});
  // Approvals v3: the conversation on every request of this ticket, and which
  // question is being answered in-app.
  const [messages, setMessages] = useState([]);
  // An older open question picked from the conversation ("Answer" on it) —
  // otherwise the composer answers the newest open question.
  const [answering, setAnswering] = useState(null); // message
  const [answerBusy, setAnswerBusy] = useState(false);
  const loadMessages = useCallback(async () => {
    if (!ticketId) return;
    try {
      const res = await ticketsAPI.approvalMessages(ticketId);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setMessages(list);
    } catch { /* the thread is optional — the rows still render */ }
  }, [ticketId]);
  useEffect(() => { loadMessages(); }, [loadMessages, approvals]);
  const people = useMemo(() => {
    const map = new Map();
    for (const t of [...(meta?.technicians || []), ...(meta?.members || [])]) {
      if (!t?.email) continue;
      const key = String(t.email).toLowerCase();
      if (!map.has(key) || (!map.get(key).photoUrl && t.photoUrl)) map.set(key, { name: t.name || t.email, email: key, photoUrl: t.photoUrl || null, role: t.role || null });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [meta?.technicians, meta?.members]);
  const groups = useMemo(() => {
    const map = new Map();
    for (const ap of approvals) {
      const key = ap.requestGroupId || `single-${ap.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ap);
    }
    for (const rows of map.values()) rows.sort((a, b) => a.id - b.id);
    return [...map.values()].sort((a, b) => new Date(b[0].createdAt) - new Date(a[0].createdAt));
  }, [approvals]);

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-border bg-card" data-testid="ticket-approvals">
      <div className="hidden grid-cols-[7.5rem_minmax(0,1fr)_auto_1rem] items-center gap-3 border-b border-border px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid" aria-hidden="true">
        <span>Status</span><span>Request</span><span className="text-right">Asked</span><span />
      </div>
      <ul>
        {groups.map((rows) => {
          const head = rows[0];
          const verdict = groupVerdict(rows);
          const vMeta = statusMeta(verdict);
          const category = head.approvalCategory?.name;
          const decided = TERMINAL.has(verdict);
          // The approver whose decision set the verdict (for the decided summary).
          const decider = decided ? (rows.find((r) => r.status === verdict) || null) : null;
          const otherCount = decider ? rows.length - 1 : 0;
          const groupBusy = savingField === `approval-${head.id}`;
          const canRequesterManage = actorIsAdmin || (actorEmail && head.requestedBy === actorEmail);
          const canChangeVerdict = decider && (actorIsAdmin || actorEmail === String(decider.approverEmail || '').toLowerCase());
          const flipTo = verdict === 'approved' ? 'rejected' : 'approved';
          const tiers = chainOf(head.approvalCategory);
          const tierCount = tiers.length;
          const liveTier = Math.max(...rows.map((r) => r.tier || 1));
          // 26 Oct 2026 (ticket 65030): one status line says who the
          // request waits on and for what; the conversation is the main
          // thing, newest last; ONE composer at the bottom changes with
          // who is looking and what is pending.
          const groupId = head.requestGroupId || `single-${head.id}`;
          const groupMessages = messages.filter((m) => m.requestGroupId === groupId || (m.approvalId && rows.some((r) => r.id === m.approvalId)));
          const state = threadState(groupMessages);
          const nameOf = (email) => {
            const e = String(email || '').toLowerCase();
            if (!e) return null;
            if (requester?.email && String(requester.email).toLowerCase() === e && requester.name) return requester.name;
            const row = rows.find((r) => String(r.approverEmail || '').toLowerCase() === e && r.approverName);
            return people.find((p) => p.email === e)?.name || row?.approverName || (String(head.requestedBy || '').toLowerCase() === e ? head.requestedByName : null) || e;
          };
          const youOr = (email) => (actorEmail && String(email || '').toLowerCase() === actorEmail ? 'you' : nameOf(email));
          const agentEmail = String(head.requestedBy || '').toLowerCase();
          const agentName = head.requestedByName || nameOf(agentEmail);
          const viewerIsAgent = Boolean(actorEmail) && actorEmail === agentEmail;
          const viewerIsApprover = rows.some((r) => String(r.approverEmail).toLowerCase() === actorEmail);
          const openRows = rows.filter((r) => r.status === 'pending' || r.status === 'info_requested');
          const myRow = openRows.find((r) => String(r.approverEmail || '').toLowerCase() === actorEmail) || null;
          const condItRow = rows.find((r) => conditionsWaitingOn(r.conditions, r.status) === 'it') || null;
          const condApproverRow = rows.find((r) => conditionsWaitingOn(r.conditions, r.status) === 'approver') || null;
          const infoRow = rows.find((r) => r.status === 'info_requested' && conditionsWaitingOn(r.conditions, r.status) !== 'it') || null;
          const latestOpen = state.open[state.open.length - 1] || null;
          // When a relayed question was sent on, it is "asked" from then.
          const askedAt = (m) => {
            if (!m) return null;
            for (const [, r] of state.relays) if (r.copy.id === m.id) return r.marker.createdAt || m.createdAt;
            return m.createdAt;
          };
          const tierLabel = (ap) => (tierCount > 1 ? (tiers[(ap.tier || 1) - 1] || {}).name || `Tier ${ap.tier || 1}` : null);
          const approverLabelOf = (ap) => ap.approverName || nameOf(ap.approverEmail);

          // ---- who the request waits on
          let waiting = null; // { who, line, sub, at, mine }
          if (condItRow) {
            waiting = { mine: viewerIsAgent, line: `Waiting on ${viewerIsAgent ? 'you' : agentName} to answer ${firstName(approverLabelOf(condItRow))}'s conditions`, sub: `${approverLabelOf(condItRow)} approved on ${readConditions(condItRow.conditions).items.length === 1 ? 'a condition' : `${readConditions(condItRow.conditions).items.length} conditions`} — it is not approved until each one is answered.`, at: condItRow.decidedAt };
          } else if (condApproverRow) {
            const mine = String(condApproverRow.approverEmail || '').toLowerCase() === actorEmail;
            waiting = { mine, line: `Waiting on ${mine ? 'you' : approverLabelOf(condApproverRow)} to decide`, sub: 'The answers to the conditions are in.' };
          } else if (latestOpen) {
            const askerEmail = String(latestOpen.author?.email || '').toLowerCase();
            const asker = askerEmail === actorEmail ? 'your' : `${firstName(latestOpen.author?.name || nameOf(askerEmail))}'s`;
            const to = (latestOpen.to || []).map((e) => String(e).toLowerCase());
            const mine = to.includes(actorEmail);
            waiting = {
              mine,
              line: `Waiting on ${mine && to.length === 1 ? 'you' : orList(to.map(youOr))} to answer ${asker} question`,
              sub: latestOpen.audience === 'internal' ? `Internal — ${requester?.name || 'the requester'} does not see it.` : null,
              at: askedAt(latestOpen), atVerb: askedAt(latestOpen) !== latestOpen.createdAt ? `sent to ${to.length > 1 ? 'them' : (mine ? 'you' : firstName(nameOf(to[0])))}` : 'asked',
            };
          } else if (infoRow) {
            waiting = { mine: viewerIsAgent, line: `Waiting on ${viewerIsAgent ? 'you' : agentName} to send ${firstName(approverLabelOf(infoRow))} the information they asked for`, at: null };
          } else if (openRows.length) {
            const others = openRows.filter((r) => r !== myRow);
            const who = myRow ? (others.length ? `you or ${orList(others.map(approverLabelOf))}` : 'you') : orList(openRows.map(approverLabelOf));
            const tierName = openRows.length && tierCount > 1 ? ` (${tierLabel(openRows[0])})` : '';
            waiting = {
              mine: Boolean(myRow),
              line: `Waiting on ${who}${tierName} to decide`,
              sub: myRow && others.length
                ? `Also with ${orList(others.map(approverLabelOf))} — whichever of you decides first closes the request.`
                : !myRow ? (openRows.length > 1 ? 'Any one of them decides.' : 'Only they can decide.') : null,
            };
          }

          // ---- the last thing that happened
          const threadApproval = { ...head, requestedByName: agentName, clarificationLog: rows.flatMap((r) => r.clarificationLog || []), escalationLog: rows.flatMap((r) => r.escalationLog || []) };
          const items = buildThreadItems({ approval: threadApproval, messages: groupMessages, people });
          const lastEvent = items.reduce((acc, it) => {
            const at = it.relay?.at || it.at;
            const by = it.relay ? it.relay.by : it.author;
            const t = at ? new Date(at).getTime() : 0;
            return !acc || t >= acc.t ? { t, at, by } : acc;
          }, null);

          // ---- the one composer
          const target = (answering && state.open.some((m) => m.id === answering.id)) ? answering : latestOpen;
          const targetTo = (target?.to || []).map((e) => String(e).toLowerCase());
          const targetCc = (target?.cc || []).map((e) => String(e).toLowerCase());
          const canAnswerTarget = Boolean(target) && typeof onAnswer === 'function' && String(target.author?.email || '').toLowerCase() !== actorEmail && (targetTo.includes(actorEmail) || targetCc.includes(actorEmail) || actorIsAdmin);
          const isRequesterSide = actorIsAdmin || viewerIsAgent;
          let mode = null;
          if (answering && canAnswerTarget) mode = 'answer';
          else if (myRow) mode = 'approver';
          else if (condItRow && onAnswerConditions) mode = 'conditions';
          else if (canAnswerTarget) mode = 'answer';
          else if (infoRow && isRequesterSide && !latestOpen) mode = 'resubmit';
          const forwardRows = actorIsAdmin && !myRow && typeof onForward === 'function' ? rows.filter((r) => r.status === 'pending') : [];
          const participantsFor = (ap) => ({
            requester: requester?.email ? { email: String(requester.email).toLowerCase(), name: requester.name || null, role: 'requester' } : null,
            agent: ap.requestedBy ? { email: agentEmail, name: agentName || null, role: 'agent' } : null,
            approvers: rows.map((r) => ({ email: String(r.approverEmail).toLowerCase(), name: approverLabelOf(r) || null, role: 'approver' })),
          });
          const threadParticipants = {
            requester: requester?.email ? { email: String(requester.email).toLowerCase(), name: requester.name || null } : null,
            agent: head.requestedBy ? { email: agentEmail } : null,
            approvers: rows.map((r) => ({ email: String(r.approverEmail || '').toLowerCase(), tier: r.tier || 1 })),
            tierCount,
          };
          const threadPeople = [...people, ...(requester?.email && requester.name ? [{ email: String(requester.email).toLowerCase(), name: requester.name }] : [])];

          // 27 Oct 2026 (Vahid: "do the same redesign for the ticket's approvals
          // tab"): each request is a row of two lines — status, category, who it
          // waits on — that opens into the conversation and the composer. Open
          // requests start open; decided ones start folded.
          const isOpen = decided ? flipped.has(groupId) : !flipped.has(groupId);
          const toggle = () => setFlipped((prev) => { const next = new Set(prev); if (next.has(groupId)) next.delete(groupId); else next.add(groupId); return next; });
          const talkCount = groupMessages.filter((m) => ['question', 'answer', 'comment'].includes(m.kind)).length;
          const summary = decided
            ? (verdict === 'cancelled' || !decider
              ? `Cancelled · requested by ${agentName}`
              : `${vMeta.verb} by ${decider.approverName || decider.approverEmail}${decider.decidedAt ? ` ${formatDayTime(decider.decidedAt)}` : ''} · requested by ${agentName}`)
            : `${waiting ? waiting.line : 'Open'} · requested by ${agentName}`;
          return (
            <li key={groupId} className={`border-t border-border/70 first:border-t-0 ${isOpen ? 'bg-muted/30' : ''}`} data-testid="ticket-approval" data-status={verdict} data-open={isOpen ? 'true' : 'false'}>
              <div
                {...rowToggleProps(isOpen, toggle, `${isOpen ? 'Close' : 'Open'} the ${category || 'approval'} request`)}
                className="tp-focus-ring grid cursor-pointer grid-cols-[minmax(0,1fr)_auto_1rem] items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto_1rem] sm:items-center sm:px-5"
              >
                <span className="col-span-3 sm:col-span-1"><StatusIcon status={verdict} withLabel /></span>
                <div className="min-w-0">
                  <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 leading-snug">
                    <span className="text-[14px] font-semibold text-foreground [overflow-wrap:anywhere]" data-testid="ticket-approval-category">{category || 'Approval'}</span>
                    <AmountChip amount={head.amount} currency={head.amountCurrency || head.approvalCategory?.amountCurrency} />
                    {!decided && <TierChip tier={liveTier} tierName={(tiers[liveTier - 1] || {}).name} tierCount={tierCount} />}
                  </p>
                  {!isOpen && (
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground sm:truncate" data-testid="ticket-approval-summary">
                      <span className={!decided && waiting?.mine ? 'font-semibold text-primary' : ''}>{summary}</span>
                      {talkCount > 0 && <> · {talkCount} message{talkCount === 1 ? '' : 's'}</>}
                    </p>
                  )}
                </div>
                <span className="text-right text-[12px] leading-snug tabular-nums text-muted-foreground" title={new Date(head.createdAt).toLocaleString()}>
                  <span className="block text-foreground/85">{formatDayTime(head.createdAt)}</span>
                  <span className="block">{decided ? (decider?.decidedAt ? `took ${spanText(head.createdAt, decider.decidedAt)}` : '') : `open ${ageText(head.createdAt)}`}</span>
                </span>
                <ChevronDown className={`mt-0.5 h-4 w-4 text-muted-foreground transition-transform sm:mt-0 ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </div>

              {isOpen && (
                <div className="border-t border-border/60 px-4 pb-4 sm:px-5" data-testid="ticket-approval-body">
                  <div className="-mx-4 sm:-mx-5">
                    {(() => {
                      // Up to 5 devices per request since 29 Sep 2026 (older holds came as one object).
                      const raw = head.requestGroupId ? holds[head.requestGroupId] : null;
                      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                      return list.map((h, i) => (
                        <ApprovalLaptop key={`${h.reservationId || i}-${h.itemIndex ?? i}`} hold={h} decided={decided} label={list.length > 1 ? `Device ${i + 1}` : null}
                          canChange={!decided && Boolean(onChangeHardware) && canChangeHardware(head.requestedBy)}
                          onChange={(hardware) => onChangeHardware(head.id, { ...hardware, itemIndex: h.itemIndex ?? i })} requester={requester} />
                      ));
                    })()}
                  </div>
                  <div className="pt-4">
                    {decided ? (
                      <div className="flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                          {decider ? (
                            <div className="flex items-center gap-3.5">
                              <div className="relative flex-shrink-0">
                                <ApproverAvatar email={String(decider.approverEmail || '').toLowerCase()} name={decider.approverName || decider.approverEmail} size="h-11 w-11" textSize="text-xs" />
                                <span className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card ${vMeta.dot} flex items-center justify-center`}>
                                  <vMeta.Icon className="w-2.5 h-2.5 text-white" aria-hidden="true" />
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="text-[15px] text-foreground/85">
                                  <span className={`font-semibold ${vMeta.text}`}>{vMeta.verb}</span> by <span className="font-semibold text-foreground">{decider.approverName || decider.approverEmail}</span>
                                  {decider.decidedAt && <span className="text-muted-foreground/75" title={new Date(decider.decidedAt).toLocaleString()}> · {formatDayTime(decider.decidedAt)} · {timeAgo(decider.decidedAt)}</span>}
                                </p>
                                <p className="text-[13px] text-muted-foreground mt-0.5">
                          Requested by {head.requestedByName || people.find((p) => p.email === String(head.requestedBy || '').toLowerCase())?.name || head.requestedBy}
                                  {otherCount > 0 && <> · {otherCount} other approver{otherCount === 1 ? '' : 's'} auto-cancelled</>}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <p className="text-[15px] text-muted-foreground">Cancelled · requested by {head.requestedByName || people.find((p) => p.email === String(head.requestedBy || '').toLowerCase())?.name || head.requestedBy}</p>
                          )}
                          {/* What was asked for stays on the decided card (16 Sep 2026):
                      the verdict alone lost the agent's own words. */}
                          {items.length > 1 ? (
                            <div className="mt-4 border-t border-border/60 pt-4" data-testid="decided-conversation">
                              <ApprovalThread
                                compact
                                lookupPhotos
                                approval={threadApproval}
                                messages={groupMessages}
                                people={threadPeople}
                                viewerEmail={actorEmail}
                                viewerRole={actorIsAdmin ? 'admin' : viewerIsApprover ? 'approver' : 'agent'}
                                participants={threadParticipants}
                                showOpenState={false}
                                title="Conversation"
                              />
                            </div>
                          ) : head.requestNoteHtml ? (
                            <div className="mt-4 text-sm leading-relaxed text-muted-foreground border-l-2 border-border pl-3.5" data-testid="timeline-request-note">
                              <SafeHtml html={head.requestNoteHtml} className="text-sm text-muted-foreground" />
                            </div>
                          ) : head.requestNote && (
                            <p className="mt-4 text-sm leading-relaxed text-muted-foreground italic border-l-2 border-border pl-3.5" data-testid="timeline-request-note">“{cleanNoteText(head.requestNote)}”</p>
                          )}
                          {readConditions(decider?.conditions) && verdict === 'approved' ? (
                            <ConditionsReview conditions={decider.conditions} variant="agreed" className="mt-4" />
                          ) : decider?.conditionNote && verdict === 'approved' && (
                            <div className="mt-4 border-l-2 border-amber-400 dark:border-amber-500/60 pl-3.5" data-testid="timeline-condition">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Condition</p>
                              <p className="mt-1 text-[15px] leading-relaxed text-foreground/85">{decider.conditionNote}</p>
                            </div>
                          )}
                          {decider?.decisionNoteHtml && !/^superseded/i.test(decider.decisionNote || '') ? (
                            <div className="mt-4"><SafeHtml html={decider.decisionNoteHtml} className="text-sm leading-relaxed text-foreground/85" /></div>
                          ) : decider?.decisionNote && !/^superseded/i.test(decider.decisionNote) && (
                            <p className="text-sm leading-relaxed text-foreground/85 mt-4 italic">“{decider.decisionNote}”</p>
                          )}
                        </div>
                        {(canChangeVerdict || canRequesterManage) && (verdict === 'approved' || verdict === 'rejected') && (
                          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                            {canChangeVerdict && (
                              <button
                                onClick={() => onChangeDecision?.({ approvalId: decider.id, from: verdict, to: flipTo, categoryName: category, approverName: decider.approverName || decider.approverEmail })}
                                disabled={groupBusy || savingField === `approval-${decider.id}`}
                                title={`Change this decision to ${flipTo === 'rejected' ? 'not approved' : flipTo}`}
                                className={`tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border disabled:opacity-50 ${
                                  flipTo === 'approved'
                                    ? 'bg-card text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/15'
                                    : 'bg-card text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/15'
                                }`}
                              >
                                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Change to {flipTo === 'rejected' ? 'not approved' : flipTo}
                              </button>
                            )}
                            {canRequesterManage && (
                              <button
                                onClick={() => onDeleteRequest?.(head)}
                                disabled={groupBusy}
                                className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg text-muted-foreground/75 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300"
                              >
                                <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        {(() => {

                          return (
                            <>
                              {/* Who it waits on — the first thing to read. */}
                              {waiting && (
                                <div className="flex items-start gap-3" data-testid="approval-waiting-on" role="status">
                                  <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${waiting.mine ? 'bg-primary text-primary-foreground' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100'}`}>
                                    <Hourglass className="h-4 w-4" aria-hidden="true" />
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-[15px] font-semibold leading-snug text-foreground">
                                      {waiting.line}
                                      {waiting.at && <span className="font-normal text-muted-foreground" title={new Date(waiting.at).toLocaleString()}> · {waiting.atVerb || 'since'} {formatDayTime(waiting.at)}</span>}
                                    </p>
                                    {waiting.sub && <p className="mt-0.5 text-[13px] text-muted-foreground">{waiting.sub}</p>}
                                  </div>
                                </div>
                              )}
                              <p className={`${waiting ? 'mt-1.5 sm:pl-11' : ''} text-[12.5px] text-muted-foreground`} data-testid="approval-requested-by">
                        Requested by <span className="font-medium text-foreground/85">{agentName}</span>
                                {lastEvent?.by?.name && items.length > 1 && (
                                  <> · last update from <span className="font-medium text-foreground/85">{String(lastEvent.by.email || '').toLowerCase() === actorEmail ? 'you' : lastEvent.by.name}</span>{lastEvent.at ? `, ${formatDayTime(lastEvent.at)}` : ''}</>
                                )}
                              </p>

                              {/* The approvers, in tier order — one line each, no notes (the conversation has them). */}
                              <ol className={`${waiting ? 'mt-3 sm:pl-11' : 'mt-3'} flex flex-wrap items-center gap-x-2 gap-y-2 text-[12.5px]`} aria-label="Approvers">
                                {rows.map((ap, i) => {
                                  const sm = statusMeta(ap.status);
                                  const approverKey = String(ap.approverEmail || '').toLowerCase();
                                  const person = people.find((p) => p.email === approverKey) || null;
                                  const label = approverLabelOf(ap);
                                  const prev = rows[i - 1];
                                  const handoff = [...(ap.escalationLog || [])].reverse()[0];
                                  const ownQuestion = [...groupMessages].reverse().find((m) => m.kind === 'question' && String(m.author?.email || '').toLowerCase() === approverKey && !state.hidden.has(m.id));
                                  const cond = conditionsWaitingOn(ap.conditions, ap.status);
                                  let what = rowLabel(ap);
                                  let at = ap.decidedAt;
                                  if ((ap.status === 'escalated' || ap.status === 'forwarded') && handoff) {
                                    const to = (handoff.toNames?.length ? handoff.toNames : (handoff.toEmails || []).map(nameOf)).filter(Boolean);
                                    what = `${handoff.kind === 'auto' ? 'Approved · sent up' : handoff.kind === 'forwarded' ? 'Forwarded' : 'Escalated'}${to.length ? ` to ${andList(to)}` : ''}`;
                                    at = handoff.at || at;
                                  } else if (cond === 'it') {
                                    what = `Approved on ${readConditions(ap.conditions).items.length === 1 ? 'a condition' : `${readConditions(ap.conditions).items.length} conditions`}`;
                                  } else if (cond === 'approver') {
                                    what = 'Answers in · deciding';
                                  } else if (ap.status === 'info_requested') {
                                    what = 'Asked a question';
                                    at = ownQuestion?.createdAt || at;
                                  } else if (ap.status === 'pending') {
                                    what = 'Deciding';
                                  }
                                  return (
                                    <li key={ap.id} className="flex items-center gap-2" data-testid="approver-row" data-status={ap.status}>
                                      {prev && (prev.tier || 1) !== (ap.tier || 1)
                                        ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                                        : prev ? <span className="text-muted-foreground/75">or</span> : null}
                                      <span className="relative shrink-0">
                                        <ApproverAvatar email={approverKey} name={label} photoUrl={person?.photoUrl || null} size="h-6 w-6" textSize="text-[9px]" />
                                        <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${sm.dot}`} title={sm.label} />
                                      </span>
                                      <span className="min-w-0">
                                        <span className="font-medium text-foreground" title={ap.approverEmail}>{label}</span>
                                        {tierCount > 1 && <span className="text-muted-foreground"> · {tierLabel(ap)}</span>}
                                        {ap.isFinal && <span className="text-muted-foreground" title="Forwarded as the final approver"> · final</span>}
                                        <span className={` ${sm.text}`} data-testid="approver-status"> · {what}</span>
                                        {at && <span className="text-muted-foreground/75" title={new Date(at).toLocaleString()}> {formatDayTime(at)}</span>}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ol>

                              {/* The conversation — request, hand-offs, questions, answers; newest last. */}
                              {items.length > 0 && <div className="mt-4 border-t border-border/60 pt-4">
                                <ApprovalThread
                                  compact
                                  lookupPhotos
                                  approval={threadApproval}
                                  messages={groupMessages}
                                  people={threadPeople}
                                  viewerEmail={actorEmail}
                                  viewerRole={actorIsAdmin ? 'admin' : viewerIsApprover ? 'approver' : 'agent'}
                                  // The composer below answers the newest open question; "Answer" on an older one moves it there.
                                  onAnswer={onAnswer && state.open.length > (mode === 'answer' ? 1 : 0) ? (m) => setAnswering(m) : null}
                                  participants={threadParticipants}
                                  onAskRequester={onAskRequester ? async (m) => { await onAskRequester(m.id); await loadMessages(); } : null}
                                  showOpenState={false}
                                  title="Conversation"
                                />
                              </div>}

                              {/* 26 Oct 2026: the answers are in and back with the approver. */}
                              {condApproverRow && String(condApproverRow.approverEmail || '').toLowerCase() !== actorEmail && (
                                <ConditionsReview conditions={condApproverRow.conditions} className="mt-4" />
                              )}

                              {/* The one place to write — it changes with the viewer and what is pending. */}
                              {(mode || forwardRows.length > 0) && (
                                <div className="mt-4 border-t border-border/60 pt-4" data-testid="approval-composer-slot" data-mode={mode || 'forward'}>
                                  {mode === 'approver' && (() => {
                                    const ap = myRow;
                                    const nextTier = tiers[ap.tier || 1] || null;
                                    return (
                                      <>
                                        <p className="mb-2 text-[14px] font-semibold text-foreground">Your decision{tierCount > 1 ? ` · ${tierLabel(ap)}` : ''}</p>
                                        <ApprovalComposer
                                          compact
                                          showShortcuts={false}
                                          minHeight={160}
                                          approval={{
                                            ...ap,
                                            ticketRef: null,
                                            requesterName: requester?.name || null,
                                            canEscalate: Boolean(!ap.isFinal && nextTier && onEscalate),
                                            nextTier: nextTier ? { name: nextTier.name, approverNames: (nextTier.managerEmails || []).map((e) => people.find((p) => p.email === e)?.name || e) } : null,
                                            tierName: (tiers[(ap.tier || 1) - 1] || {}).name || null,
                                            amountLabel: null,
                                          }}
                                          participants={participantsFor(ap)}
                                          selfEmail={ap.approverEmail}
                                          forwardCandidates={people.filter((p) => p.email !== String(ap.approverEmail).toLowerCase() && p.email !== agentEmail)}
                                          onDecide={(decision, note, noteHtml, extra) => onDecide(ap.id, decision, note, { noteHtml, ...extra })}
                                          onAsk={onAsk ? async (payload) => { await onAsk(ap.id, payload); await loadMessages(); } : undefined}
                                          onHandoff={(onEscalate || onForward) ? async ({ mode: m, note, toEmail }) => {
                                            if (m === 'forward') await onForward?.(ap.id, toEmail, note);
                                            else await onEscalate?.(ap.id, note);
                                          } : undefined}
                                          disabled={savingField === `approval-${ap.id}`}
                                          footer={conditionsWaitingOn(ap.conditions, ap.status) === 'it'
                                            ? `Waiting for ${agentName || 'the technician'} to answer your conditions — you can still decide now.`
                                            : latestOpen ? 'A question is out — you can still decide, or wait for the answer.' : 'Decisions ask you to confirm first.'}
                                        />
                                      </>
                                    );
                                  })()}

                                  {mode === 'conditions' && (
                                    <ConditionsAnswerForm
                                      key={`${condItRow.id}-${readConditions(condItRow.conditions).round || 1}`}
                                      conditions={condItRow.conditions}
                                      approverName={approverLabelOf(condItRow)}
                                      requesterName={requester?.name || null}
                                      busy={savingField === `approval-${condItRow.id}`}
                                      onSave={(answers) => onAnswerConditions(condItRow.id, { answers, submit: false })}
                                      onSubmit={(answers) => onAnswerConditions(condItRow.id, { answers, submit: true })}
                                      onAskRequester={onAsk && requester?.email ? async (q) => {
                                        await onAsk(condItRow.id, { kind: 'question', mode: 'requester', to: [String(requester.email).toLowerCase()], cc: [], bodyText: q, bodyHtml: null });
                                        await loadMessages();
                                      } : null}
                                    />
                                  )}

                                  {mode === 'answer' && (() => {
                                    const askerName = target.author?.name || nameOf(target.author?.email) || 'the approver';
                                    const toRequester = target.audience !== 'internal';
                                    const direct = targetTo.includes(actorEmail);
                                    const reqName = requester?.name || 'the requester';
                                    const askerRow = rows.find((r) => String(r.approverEmail || '').toLowerCase() === String(target.author?.email || '').toLowerCase());
                                    const backTo = askerRow && askerRow.status === 'info_requested' ? ` The request goes back to ${firstName(askerName)} to decide.` : '';
                                    return (
                                      <AnswerComposer
                                        key={target.id}
                                        message={target}
                                        heading={`Answer ${firstName(askerName)}'s question${!direct && toRequester ? ` for ${firstName(reqName)}` : ''}`}
                                        recipients={toRequester
                                          ? `Goes to ${askerName} and everyone on the e-mail.${backTo}`
                                          : `Goes to ${askerName} — internal, ${reqName} does not see it.`}
                                        folded={!direct && !viewerIsAgent && !answering}
                                        foldedText={`${orList(targetTo.map(youOr))} ${targetTo.length > 1 ? 'were' : 'was'} asked. You are copied.`}
                                        busy={answerBusy || savingField === `approval-answer-${target.id}`}
                                        onSend={async (payload) => {
                                          setAnswerBusy(true);
                                          try { await onAnswer(target.id, payload); setAnswering(null); await loadMessages(); }
                                          finally { setAnswerBusy(false); }
                                        }}
                                        secondary={answering ? (
                                          <button type="button" onClick={() => setAnswering(null)} className="tp-focus-ring rounded-lg px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted">Cancel</button>
                                        ) : infoRow && isRequesterSide && typeof onResubmit === 'function' ? (
                                          <button
                                            type="button"
                                            onClick={() => onResubmit(infoRow.id, null)}
                                            disabled={savingField === `approval-${infoRow.id}`}
                                            className="tp-focus-ring rounded-lg px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                            title={`Puts the request back with ${approverLabelOf(infoRow)} to decide, without an answer`}
                                          >
                                    Send back to {firstName(approverLabelOf(infoRow))} without an answer
                                          </button>
                                        ) : null}
                                      />
                                    );
                                  })()}

                                  {mode === 'resubmit' && (
                                    <div className="space-y-2">
                                      <p className="text-[14px] font-semibold text-foreground">Send {firstName(approverLabelOf(infoRow))} the information they asked for</p>
                                      <textarea
                                        rows={3}
                                        value={resubmitNotes[infoRow.id] || ''}
                                        onChange={(e) => setResubmitNotes((m) => ({ ...m, [infoRow.id]: e.target.value }))}
                                        placeholder="Your reply…"
                                        aria-label={`Reply to ${approverLabelOf(infoRow)}`}
                                        className="tp-focus-ring w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-[13.5px] placeholder:text-muted-foreground/75"
                                      />
                                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                        <button
                                          onClick={() => onResubmit(infoRow.id, (resubmitNotes[infoRow.id] || '').trim() || null)}
                                          disabled={savingField === `approval-${infoRow.id}`}
                                          className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                        >
                                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> Resubmit for approval
                                        </button>
                                        <span className="text-[12px] text-muted-foreground">Your reply is kept on the request and e-mailed to {approverLabelOf(infoRow)}.</span>
                                      </div>
                                    </div>
                                  )}

                                  {/* Admins may hand a pending row on (forward-only composer, folded until asked for). */}
                                  {forwardRows.map((ap) => (
                                    <div key={`fwd-${ap.id}`} className={mode ? 'mt-3' : ''}>
                                      {!forwardOpen.has(ap.id) ? (
                                        <button
                                          type="button"
                                          onClick={() => setForwardOpen((prev) => new Set(prev).add(ap.id))}
                                          className="tp-focus-ring inline-flex items-center gap-1.5 rounded text-[12.5px] font-medium text-primary hover:underline"
                                        >
                                          <Forward className="h-3.5 w-3.5" aria-hidden="true" />
                                          {forwardRows.length > 1 ? `Forward ${firstName(approverLabelOf(ap))}'s part to someone else` : 'Forward to someone else'}
                                        </button>
                                      ) : (
                                        <ApprovalComposer
                                          compact
                                          canDecide={false}
                                          showShortcuts={false}
                                          minHeight={120}
                                          approval={{ ...ap, ticketRef: null, requesterName: requester?.name || null, canEscalate: false, nextTier: null, tierName: (tiers[(ap.tier || 1) - 1] || {}).name || null, amountLabel: null }}
                                          participants={participantsFor(ap)}
                                          selfEmail={ap.approverEmail}
                                          forwardCandidates={people.filter((p) => p.email !== String(ap.approverEmail || '').toLowerCase() && p.email !== agentEmail)}
                                          onDecide={() => {}}
                                          onHandoff={async ({ mode: m, note, toEmail }) => { if (m === 'forward') await onForward(ap.id, toEmail, note); }}
                                          disabled={savingField === `approval-${ap.id}`}
                                          footer={`Forwarding moves the request to the person you pick; ${approverLabelOf(ap)} is told.`}
                                        />
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          );
                        })()}

                        {/* Group-level requester actions: cancel keeps an audit record;
                    delete removes it entirely (parent shows a warning first). */}
                        {canRequesterManage && (
                          <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-border/60">
                            <button
                              onClick={() => onCancel(head.id)}
                              disabled={groupBusy}
                              className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-muted-foreground border border-border hover:bg-muted disabled:opacity-50"
                            >
                              <Ban className="w-3 h-3" aria-hidden="true" /> Cancel request
                            </button>
                            <button
                              onClick={() => onDeleteRequest?.(head)}
                              disabled={groupBusy}
                              className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-muted-foreground hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300"
                            >
                              <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
