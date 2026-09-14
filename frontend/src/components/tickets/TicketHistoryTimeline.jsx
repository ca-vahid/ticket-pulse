import { useMemo, useState } from 'react';
import {
  ArrowRight, Bot, Building2, CalendarClock, Check, CheckSquare, ChevronDown, ChevronRight, Forward,
  Hand, History, Inbox, Mail, MessageSquare, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Tag, UserRound, VolumeX, Zap,
} from 'lucide-react';
import { ActorKindChip } from './activityKind.jsx';
import { PersonAvatar, StatusPill, formatDayTime, timeAgo } from './ticketUi.jsx';
import { integrationIdentity } from '../../utils/integrationIdentity';
import { IntegrationAvatar } from './IntegrationAvatar';
import { spanLabel } from './activityKind.jsx';

/**
 * Activity tab timeline (overhaul, 14 Sep 2026).
 *
 * Reads like a story: WHO (avatar + bold name) did WHAT (verb) and where it
 * went (from → to chips), one line per event, grouped by day, newest first.
 * Machine chatter (FreshService workflows, AI runs, sync echoes) folds into
 * one collapsed "N automation events" line per burst; the header toggle can
 * hide it entirely. Important moves — resolve/close, reopen, urgent priority,
 * assignment — carry a coloured accent so they stand out at a glance.
 */

const EVENT_STYLE = {
  created: { icon: Plus, tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' },
  status: { icon: RefreshCw, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  reopen: { icon: RotateCcw, tone: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-200' },
  assignment: { icon: UserRound, tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' },
  ownership: { icon: Hand, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200' },
  priority: { icon: Zap, tone: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200' },
  group: { icon: Building2, tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-200' },
  note: { icon: MessageSquare, tone: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200' },
  reply: { icon: Mail, tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-200' },
  category: { icon: Tag, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  accepted: { icon: Check, tone: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' },
  field: { icon: Pencil, tone: 'bg-muted text-muted-foreground' },
  due: { icon: CalendarClock, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  task: { icon: CheckSquare, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  forward: { icon: Forward, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  noise: { icon: VolumeX, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  ai: { icon: Sparkles, tone: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200' },
  workflow: { icon: Bot, tone: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-200' },
  system: { icon: Bot, tone: 'bg-muted text-muted-foreground' },
  burst: { icon: Bot, tone: 'bg-muted text-muted-foreground' },
  intake: { icon: Inbox, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
};

const PRIORITY_TONE = {
  urgent: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-200 dark:border-red-500/30',
  high: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/20 dark:text-orange-200 dark:border-orange-500/30',
  medium: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:border-amber-500/30',
  low: 'bg-muted text-muted-foreground border-border',
};

const TERMINAL = new Set(['resolved', 'closed']);
const key = (s) => String(s || '').trim().toLowerCase();

/** Left accent for the rows that matter most. */
function accentFor(item) {
  if (item.event === 'reopen') return 'border-l-orange-400';
  if (item.event === 'status' && TERMINAL.has(key(item.to))) return 'border-l-emerald-400';
  if (item.event === 'status') return 'border-l-amber-300';
  if (item.event === 'priority' && key(item.to) === 'urgent') return 'border-l-red-400';
  if (item.event === 'assignment' || item.event === 'ownership') return 'border-l-blue-300';
  if (item.event === 'created') return 'border-l-blue-400';
  return 'border-l-transparent';
}

function Chip({ children, className = '', title }) {
  return (
    <span title={title} className={`inline-flex max-w-full min-w-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${className}`}>
      <span className="truncate">{children}</span>
    </span>
  );
}

function ValueChip({ item, value, statusTone, photoForName, technicians }) {
  if (value === null || value === undefined || value === '') return <Chip className="bg-muted text-muted-foreground border-border">Unassigned</Chip>;
  if (item.event === 'status' || item.event === 'reopen') return <StatusPill status={String(value)} tone={statusTone?.(String(value)) || null} size="sm" />;
  if (item.event === 'priority') return <Chip className={PRIORITY_TONE[key(value)] || PRIORITY_TONE.low}>{value}</Chip>;
  if (item.event === 'assignment' || item.event === 'ownership') {
    const tech = (technicians || []).find((t) => key(t.name) === key(value));
    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        <PersonAvatar name={String(value)} photoUrl={photoForName?.(String(value)) || tech?.photoUrl || null} size="h-4 w-4" textSize="text-[8px]" />
        <span className="text-[12px] font-semibold text-foreground truncate">{value}</span>
      </span>
    );
  }
  return <Chip className="bg-secondary text-foreground/85 border-border">{value}</Chip>;
}

function Transition({ item, statusTone, photoForName, technicians }) {
  const hasFrom = item.from !== null && item.from !== undefined && item.from !== '';
  const hasTo = item.to !== null && item.to !== undefined && item.to !== '';
  if (!hasFrom && !hasTo) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle" data-testid="history-transition">
      {hasFrom && <ValueChip item={item} value={item.from} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />}
      {hasFrom && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />}
      {hasFrom && !hasTo ? <ValueChip item={item} value={null} statusTone={statusTone} /> : null}
      {hasTo && <ValueChip item={item} value={item.to} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />}
    </span>
  );
}

/** Sentence for a row: "<b>Anton</b> closed the ticket", "<b>Andrew</b> assigned Anton". */
function verbFor(item) {
  if (item.event === 'status' && !item.from) return 'set status';
  if (item.event === 'status') return TERMINAL.has(key(item.to)) ? `${key(item.to) === 'closed' ? 'closed' : 'resolved'} the ticket` : 'moved the ticket';
  if (item.event === 'reopen') return 'reopened the ticket';
  if (item.event === 'assignment') return item.to ? 'assigned' : 'unassigned the ticket';
  if (item.event === 'priority') return 'set priority';
  if (item.event === 'group') return item.to ? 'moved to group' : 'cleared the group';
  if (item.event === 'category') return 'categorised as';
  if (item.event === 'created') return 'created the ticket';
  return item.verb || item.event;
}

function ActorAvatar({ item, photoForName }) {
  if (item.machine) {
    const S = EVENT_STYLE[item.event] || EVENT_STYLE.system;
    const Icon = S.icon;
    return (
      <span className={`h-8 w-8 rounded-full flex items-center justify-center ring-1 ring-border/60 ${S.tone}`}>
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
    );
  }
  const integration = integrationIdentity({ actorName: item.actor });
  if (integration) return <IntegrationAvatar identity={integration} size="h-8 w-8" />;
  return <PersonAvatar name={item.actor} photoUrl={photoForName?.(item.actor) || null} size="h-8 w-8" textSize="text-[10px]" />;
}

function BurstRow({ item, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const actors = useMemo(() => {
    const m = new Map();
    for (const i of item.items) m.set(i.actor, (m.get(i.actor) || 0) + (i.count || 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [item.items]);
  return (
    <li className="relative flex gap-3 py-1.5 pl-3 border-l-2 border-l-transparent" data-testid="history-burst">
      <span className="h-8 w-8 rounded-full flex items-center justify-center bg-muted text-muted-foreground ring-1 ring-border/60 flex-shrink-0">
        <Bot className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="tp-focus-ring inline-flex items-center gap-1.5 rounded text-[12px] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
          <span className="font-semibold">{item.count} automation {item.count === 1 ? 'event' : 'events'}</span>
          <span className="text-muted-foreground/70">· {spanLabel(item.from_at, item.to_at)}</span>
          <span className="hidden sm:inline text-muted-foreground/70">· {actors.slice(0, 3).map(([a, n]) => `${a}${n > 1 ? ` ×${n}` : ''}`).join(', ')}</span>
        </button>
        {open && (
          <ol className="mt-1.5 space-y-1 border-l border-border/60 pl-3">
            {item.items.map((sub) => (
              <li key={sub.key} className="text-[12px] text-muted-foreground animate-fadeIn">
                <span className="font-medium text-foreground/80">{sub.actor}</span>
                {' '}{sub.verb}
                {sub.to && <> <span className="font-medium text-foreground/80">{sub.to}</span></>}
                {sub.count > 1 && <span data-testid="collapsed-span"> · ×{sub.count}, {spanLabel(sub.from_at, sub.to_at)}</span>}
                {sub.detail && <span className="block text-[11px] text-muted-foreground/75 break-words">{sub.detail}</span>}
                <span className="block text-[10px] text-muted-foreground/60">{formatDayTime(sub.at)}</span>
                <ActorKindChip kind={sub.kind} className="ml-1 align-middle" />
              </li>
            ))}
          </ol>
        )}
      </div>
      <span className="hidden sm:block text-[11px] text-muted-foreground/70 whitespace-nowrap pt-1" title={new Date(item.at).toLocaleString()}>{timeAgo(item.at)}</span>
    </li>
  );
}

function EventRow({ item, statusTone, photoForName, technicians, isNew }) {
  const S = EVENT_STYLE[item.event] || EVENT_STYLE.system;
  const Icon = S.icon;
  const important = item.importance >= 3;
  return (
    <li
      className={`relative flex gap-3 py-2 pl-3 border-l-2 ${accentFor(item)} animate-fadeIn ${isNew ? 'tp-history-new' : ''}`}
      data-testid="history-row"
      data-event={item.event}
    >
      <span className="relative flex-shrink-0">
        <ActorAvatar item={item} photoForName={photoForName} />
        <span className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full flex items-center justify-center ring-2 ring-card ${S.tone}`} aria-hidden="true">
          <Icon className="w-2.5 h-2.5" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm leading-6 ${important ? 'text-foreground' : 'text-foreground/85'}`}>
          <span className="font-bold">{item.actor}</span>
          {' '}<span className={important ? 'font-medium' : ''}>{verbFor(item)}</span>
          {' '}<Transition item={item} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />
          {item.actorBy && <span className="text-muted-foreground"> by {item.actorBy}</span>}
          <ActorKindChip kind={item.kind} className="ml-1.5 align-middle" />
          {item.count > 1 && (
            <span className="text-muted-foreground text-xs" data-testid="collapsed-span"> · ×{item.count}, {spanLabel(item.from_at, item.to_at)}</span>
          )}
        </p>
        {item.detail && <p className="text-xs text-muted-foreground/80 mt-0.5 break-words">{item.detail}</p>}
        <p className="sm:hidden text-[11px] text-muted-foreground/70 mt-0.5" title={new Date(item.at).toLocaleString()}>{formatDayTime(item.at)} · {timeAgo(item.at)}</p>
      </div>
      <span className="hidden sm:block text-[11px] text-muted-foreground/70 whitespace-nowrap pt-1.5 text-right" title={new Date(item.at).toLocaleString()}>
        {formatDayTime(item.at)}
        <span className="block text-[10px] text-muted-foreground/55">{timeAgo(item.at)}</span>
      </span>
    </li>
  );
}

function dayLabel(ts) {
  const d = new Date(ts); const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export default function TicketHistoryTimeline({
  items, hideMachine, onToggleMachine, hiddenMachineCount, statusTone, photoForName, technicians = [], newSinceMs = 2 * 60 * 1000,
}) {
  const visible = useMemo(() => (hideMachine ? items.filter((i) => !i.machine) : items), [items, hideMachine]);
  const groups = useMemo(() => {
    const out = [];
    for (const item of visible) {
      const label = dayLabel(item.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item); else out.push({ label, items: [item] });
    }
    return out;
  }, [visible]);
  const now = Date.now();
  return (
    <section className="tp-card rounded-xl p-4 sm:p-5" aria-label="Ticket history">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-3">
        <History className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground">Everything that happened on this ticket</h2>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={hideMachine} onChange={onToggleMachine} className="tp-focus-ring h-3.5 w-3.5 rounded border-input accent-primary" />
          Hide machine activity
        </label>
        {hideMachine && hiddenMachineCount > 0 && (
          <span className="text-[11px] text-muted-foreground/75" data-testid="machine-hidden-count">
            {hiddenMachineCount} machine {hiddenMachineCount === 1 ? 'event' : 'events'} hidden
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground/75">
          {items.length === 0 ? 'No recorded events yet.' : 'Only machine activity on this ticket — untick “Hide machine activity” to see it.'}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.label} className="mb-3 last:mb-0">
            <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-card/95 backdrop-blur text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{g.label}</div>
            <ol className="divide-y divide-border/40">
              {g.items.map((item) => (
                item.event === 'burst'
                  ? <BurstRow key={item.key} item={item} />
                  : <EventRow key={item.key} item={item} statusTone={statusTone} photoForName={photoForName} technicians={technicians} isNew={now - item.at < newSinceMs} />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}
