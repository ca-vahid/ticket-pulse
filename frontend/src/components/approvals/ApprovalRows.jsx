import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, Ban, CheckCircle2, ChevronDown, Clock, Forward, Loader2, MessageCircleQuestion, XCircle,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';
import { useTheme } from '../../contexts/ThemeContext';
import { PersonAvatar, formatDayTime } from '../tickets/ticketUi';
import ApprovalThread from '../tickets/ApprovalThread';
import ApprovalTicketBrief from './ApprovalTicketBrief';

/**
 * Approvals page rows (27 Oct 2026, Vahid picked 1B · 2A · 3B from the
 * redesign canvas): one table per list instead of a stack of cards. A row is
 * two lines at most — the subject over "TP-10518 · category" — and the
 * columns say who it is for, who asked, what happened last and how long it
 * has been open. Opening a row shows the whole conversation (questions,
 * answers, hand-offs) beside the decision.
 *
 * Phones get the same rows stacked: subject, then one line of who / latest.
 */

export const STATUS_LOOK = {
  pending: { label: 'Pending', Icon: Clock, text: 'text-amber-700 dark:text-amber-300' },
  info_requested: { label: 'Needs info', Icon: MessageCircleQuestion, text: 'text-violet-700 dark:text-violet-300' },
  approved: { label: 'Approved', Icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300' },
  rejected: { label: 'Not approved', Icon: XCircle, text: 'text-red-700 dark:text-red-300' },
  cancelled: { label: 'Cancelled', Icon: Ban, text: 'text-muted-foreground' },
  escalated: { label: 'Escalated', Icon: ArrowUpRight, text: 'text-amber-700 dark:text-amber-300' },
  forwarded: { label: 'Forwarded', Icon: Forward, text: 'text-blue-700 dark:text-blue-300' },
};

const lower = (v) => String(v || '').trim().toLowerCase();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const prettyName = (email) => (email ? String(email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');

/** "4 h 44 m", "51 m", "3 d 2 h" — how long something took or has been open. */
export function spanText(fromValue, toValue = Date.now()) {
  const from = new Date(fromValue).getTime();
  const to = new Date(toValue).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '—';
  const minutes = Math.round((to - from) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} m` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** Same, rounded to one unit for a column that only needs the size of it: "21 h", "4 d". */
export function ageText(value) {
  const from = new Date(value).getTime();
  if (!Number.isFinite(from)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - from) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * What happened last on a request, from the row's `latest` (who wrote last,
 * never the text). tone: 'new' = someone else answered (blue), 'waiting' =
 * my question is out (violet), 'quiet' = anything else.
 */
export function latestOf(a, viewerEmail) {
  const conds = a.conditions && Array.isArray(a.conditions.items) ? a.conditions : null;
  if (a.status === 'info_requested' && conds && !conds.submittedAt) {
    const who = firstName(a.requestedByName) || 'The technician';
    return { text: `Waiting on ${who}’s answers`, sub: `${conds.items.length === 1 ? '1 condition' : `${conds.items.length} conditions`}`, tone: 'waiting', at: null };
  }
  const l = a.latest;
  if (!l) return { text: 'Requested', sub: null, tone: 'quiet', at: a.createdAt };
  const mine = lower(viewerEmail) && lower(l.authorEmail) === lower(viewerEmail);
  const who = mine ? 'You' : firstName(l.authorName) || prettyName(l.authorEmail) || 'Someone';
  if (l.kind === 'question') {
    const open = a.status === 'info_requested';
    return { text: `${who} asked`, sub: open ? 'no answer yet' : null, tone: open ? 'waiting' : 'quiet', at: l.at };
  }
  if (l.kind === 'answer') return { text: `${who} answered`, sub: null, tone: mine ? 'quiet' : 'new', at: l.at };
  return { text: `${who} wrote`, sub: null, tone: 'quiet', at: l.at };
}

const TONE = {
  new: 'font-semibold text-primary',
  waiting: 'text-violet-700 dark:text-violet-300',
  quiet: 'text-foreground/85',
};

function Person({ name, email, muted = false }) {
  const photo = useRequesterPhoto(email);
  const shown = name || prettyName(email);
  if (!shown) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={email || undefined}>
      <PersonAvatar name={shown} photoUrl={photo} size="h-5 w-5" textSize="text-[8px]" />
      <span className={`min-w-0 truncate ${muted ? 'text-muted-foreground' : 'text-foreground/90'}`}>{shown}</span>
    </span>
  );
}

export function StatusIcon({ status, withLabel = false }) {
  const s = STATUS_LOOK[status] || STATUS_LOOK.cancelled;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-semibold ${s.text}`} data-testid="approval-status">
      <s.Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      {withLabel ? <span className="text-[12.5px]">{s.label}</span> : <span className="sr-only">{s.label}</span>}
    </span>
  );
}

/** The ticket number as a quiet link; opens the ticket on its Approvals tab. */
export const TicketRef = ({ a, state }) => (
  <Link
    to={`/tickets/${a.ticketId}?tab=approvals`}
    state={state}
    title={`Open ${a.displayRef}`}
    aria-label={`Open ticket ${a.displayRef}`}
    className="tp-focus-ring rounded font-mono text-[11.5px] text-primary hover:underline"
  >
    {a.displayRef}
  </Link>
);

/** Whole-row click / Enter / Space opens a row — but not from its own links and buttons. */
export const rowToggleProps = (isOpen, toggle, label) => ({
  role: 'button',
  tabIndex: 0,
  'aria-expanded': isOpen,
  'aria-label': label,
  onClick: (e) => {
    if (e.target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;
    if (window.getSelection?.()?.toString()) return; // selecting text is not a click
    toggle();
  },
  onKeyDown: (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  },
});

// Column tracks, shared by the header and every row so they line up.
export const FOR_YOU_COLS = 'md:grid-cols-[1.25rem_minmax(0,2.3fr)_minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,1.35fr)_4.5rem_8.25rem]';
export const ALL_COLS = 'md:grid-cols-[7.25rem_minmax(0,2.3fr)_minmax(0,1.1fr)_minmax(0,1.25fr)_7.75rem_7.75rem_5.5rem_1.25rem]';

export function TableHead({ cols, labels }) {
  return (
    <div className={`hidden ${cols} items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid`} aria-hidden="true">
      {labels.map((l, i) => <span key={i} className={l.right ? 'text-right' : ''}>{l.text || l}</span>)}
    </div>
  );
}

export function GroupRow({ title, count, hint = null, testId }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 border-t border-border bg-muted/60 px-4 py-1.5 first:border-t-0" data-testid={testId}>
      <h2 className="text-[12px] font-bold text-foreground">{title}</h2>
      <span className="text-[12px] text-muted-foreground">{count}{hint ? ` · ${hint}` : ''}</span>
    </div>
  );
}

function RequestCell({ a, backState }) {
  return (
    <div className="min-w-0">
      <span className="block text-[14px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="approval-subject">{a.subject || '(no subject)'}</span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-muted-foreground">
        <TicketRef a={a} state={backState} />
        {a.categoryName && <><span aria-hidden="true">·</span><span className="min-w-0 [overflow-wrap:anywhere]" data-testid="approval-category">{a.categoryName}</span></>}
        {a.amountLabel && <><span aria-hidden="true">·</span><span className="font-medium text-foreground/85">{a.amountLabel}</span></>}
        {a.tierCount > 1 && <><span aria-hidden="true">·</span><span>{a.tierName}</span></>}
      </span>
    </div>
  );
}

function LatestCell({ latest }) {
  return (
    <div className="min-w-0 text-[12.5px] leading-snug" data-testid="approval-latest">
      <span className={`block truncate ${TONE[latest.tone]}`}>{latest.text}{latest.sub && latest.tone === 'waiting' ? <span className="font-normal"> · {latest.sub}</span> : null}</span>
      {latest.at && <span className="block truncate text-[12px] text-muted-foreground" title={new Date(latest.at).toLocaleString()}>{formatDayTime(latest.at)}</span>}
      {latest.sub && latest.tone !== 'waiting' && <span className="block truncate text-[12px] text-muted-foreground">{latest.sub}</span>}
    </div>
  );
}

/**
 * One For-you row (1B): status · request · requester · agent · latest · open
 * for · actions. `actions` is the right-hand cell (Quick approve, Resubmit…).
 */
export function ForYouRow({ a, viewerEmail, isOpen, onToggle, actions = null, backState, children = null }) {
  const latest = latestOf(a, viewerEmail);
  const self = lower(a.requestedBy) && lower(a.requestedBy) === lower(a.requesterEmail);
  return (
    <li className={`border-t border-border/70 first:border-t-0 ${isOpen ? 'bg-muted/30' : ''}`} data-testid="inbox-row">
      <div
        {...rowToggleProps(isOpen, onToggle, `${isOpen ? 'Close' : 'Open'} ${a.subject || 'approval'}`)}
        className={`tp-focus-ring grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 ${FOR_YOU_COLS} md:items-center`}
      >
        <span className="pt-0.5 md:pt-0"><StatusIcon status={a.status === 'info_requested' ? 'info_requested' : 'pending'} /></span>
        <RequestCell a={a} backState={backState} />
        {/* phones: the age sits top right, the people and latest on a line under the subject */}
        <span className="text-right text-[12px] tabular-nums text-muted-foreground md:hidden">{ageText(a.createdAt)}</span>
        <div className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground md:hidden">
          <span className="truncate">{a.requesterName || prettyName(a.requesterEmail) || a.requestedByName}</span>
          <span aria-hidden="true">·</span>
          <span className={TONE[latest.tone]}>{latest.text}{latest.at ? ` ${formatDayTime(latest.at)}` : ''}</span>
        </div>
        <span className="hidden min-w-0 text-[13px] md:block"><Person name={a.requesterName} email={a.requesterEmail} /></span>
        <span className="hidden min-w-0 text-[13px] md:block">{self ? <span className="text-muted-foreground">same person</span> : <Person name={a.requestedByName} email={a.requestedBy} muted />}</span>
        <span className="hidden md:block"><LatestCell latest={latest} /></span>
        <span className="hidden text-[12.5px] tabular-nums text-muted-foreground md:block" title={`Asked ${formatDayTime(a.createdAt)}`}>{ageText(a.createdAt)}</span>
        {/* phones show this cell only when there is something to press */}
        <div className={`col-start-2 col-end-4 items-center justify-end gap-1.5 md:col-auto md:flex ${actions ? 'flex' : 'hidden'}`}>
          {actions}
          <ChevronDown className={`hidden h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform md:block ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </div>
      </div>
      {children}
    </li>
  );
}

/** Who decided, or who it waits on, for the All-approvals Approver column. */
function approverOf(g) {
  const a = g.primary;
  const open = g.members.filter((m) => ['pending', 'info_requested'].includes(m.status));
  if (open.length) {
    const seen = new Set();
    return open.filter((m) => { const k = lower(m.approverEmail); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  return [a];
}

/** One All-approvals row (3B): status · request · requester · approver · asked · decided · took. */
export function AllRow({ g, viewerEmail, isOpen, onToggle, backState, children = null }) {
  const a = g.primary;
  const approvers = approverOf(g);
  const decided = Boolean(a.decidedAt) && !['pending', 'info_requested'].includes(a.status);
  const latest = latestOf(a, viewerEmail);
  const showLatest = ['pending', 'info_requested'].includes(a.status) && latest.tone !== 'quiet';
  return (
    <li className={`border-t border-border/70 first:border-t-0 ${isOpen ? 'bg-muted/30' : ''}`} data-testid="approval-row">
      <div
        {...rowToggleProps(isOpen, onToggle, `${isOpen ? 'Close' : 'Open'} ${a.subject || 'approval'}`)}
        className={`tp-focus-ring grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 ${ALL_COLS} md:items-center`}
      >
        <span className="order-1 col-span-2 md:order-none md:col-span-1"><StatusIcon status={a.status} withLabel /></span>
        <div className="order-2 md:order-none"><RequestCell a={a} backState={backState} /></div>
        <span className="hidden min-w-0 text-[13px] md:block">
          <Person name={a.requesterName} email={a.requesterEmail} />
          {showLatest && <span className={`mt-0.5 block truncate text-[12px] ${TONE[latest.tone]}`}>{latest.text.replace(/^\S+ /, '')}{latest.at ? ` ${formatDayTime(latest.at)}` : ''}</span>}
        </span>
        <span className="hidden min-w-0 text-[13px] md:block">
          {approvers.map((m, i) => (
            <span key={m.id || i} className="flex min-w-0 items-center gap-1">{i > 0 && <span className="text-[11px] text-muted-foreground">or</span>}<Person name={m.approverName} email={m.approverEmail} /></span>
          ))}
          {a.tierCount > 1 && <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{a.tierName} of {a.tierCount}</span>}
        </span>
        <span className="hidden text-[12.5px] tabular-nums text-foreground/85 md:block" title={new Date(a.createdAt).toLocaleString()}>{formatDayTime(a.createdAt)}</span>
        <span className="hidden text-[12.5px] tabular-nums text-foreground/85 md:block">{decided ? formatDayTime(a.decidedAt) : <span className="text-muted-foreground/60">—</span>}</span>
        <span className="hidden text-[12.5px] tabular-nums md:block">{decided ? spanText(a.createdAt, a.decidedAt) : <span className="text-muted-foreground">{ageText(a.createdAt)} so far</span>}</span>
        <ChevronDown className={`order-2 h-4 w-4 flex-shrink-0 self-center text-muted-foreground transition-transform md:order-none ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        <div className="order-3 col-span-2 flex min-w-0 flex-wrap gap-x-1.5 text-[12.5px] text-muted-foreground md:hidden">
          <span className="truncate">{a.requesterName || prettyName(a.requesterEmail)}</span>
          <span aria-hidden="true">·</span>
          <span>{decided ? `${STATUS_LOOK[a.status]?.label || a.status} after ${spanText(a.createdAt, a.decidedAt)}` : `open ${ageText(a.createdAt)}`}</span>
        </div>
      </div>
      {children}
    </li>
  );
}

/**
 * The conversation on one request (2A): the agent's request, every question,
 * answer and hand-off in order, newest last and marked — then the ticket
 * itself. Messages are read when the row opens.
 */
export function RequestConversation({ a, viewerEmail, backState, refreshKey = 0 }) {
  const { resolvedTheme } = useTheme();
  const [messages, setMessages] = useState(null);
  const groupKey = a.requestGroupId || `single-${a.id}`;
  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.approvalMessages(a.ticketId);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setMessages(list.filter((m) => (m.requestGroupId || `single-${m.approvalId}`) === groupKey));
    } catch {
      setMessages([]);
    }
  }, [a.ticketId, groupKey]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const participants = useMemo(() => ({
    requester: a.requesterEmail ? { email: lower(a.requesterEmail), name: a.requesterName || null } : null,
    agent: a.requestedBy ? { email: lower(a.requestedBy), name: a.requestedByName || null } : null,
    approvers: [{ email: lower(a.approverEmail), tier: a.tier || 1 }],
    tierCount: a.tierCount || 1,
  }), [a]);
  const people = useMemo(() => [
    { email: lower(a.requesterEmail), name: a.requesterName },
    { email: lower(a.requestedBy), name: a.requestedByName },
    { email: lower(a.approverEmail), name: a.approverName },
  ].filter((p) => p.email && p.name), [a]);
  return (
    <div className="min-w-0 space-y-5" data-testid="request-conversation">
      {messages === null ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the conversation…</p>
      ) : (
        <ApprovalThread
          lookupPhotos
          approval={a}
          messages={messages}
          people={people}
          participants={participants}
          viewerEmail={viewerEmail}
          viewerRole="approver"
          isDark={resolvedTheme === 'dark'}
          compact
          showOpenState
        />
      )}
      <div className="border-t border-border/70 pt-4">
        {/* The request itself is the first message above, so the brief skips it. */}
        <ApprovalTicketBrief approval={a} note="" backState={backState} />
      </div>
    </div>
  );
}
