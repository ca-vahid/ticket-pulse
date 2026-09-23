import { useMemo, useState } from 'react';
import { BadgeCheck,
  ArrowRight, Bot, Building2, CalendarClock, Check, CheckSquare, ChevronDown, ChevronRight, Forward,
  Hand, History, Inbox, Lock, Mail, MessageSquare, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Tag, UserRound, VolumeX, Zap,
} from 'lucide-react';
import { ActorKindChip } from './activityKind.jsx';
import { PersonAvatar, StatusPill, formatDayTime, timeAgo } from './ticketUi.jsx';
import { integrationIdentity } from '../../utils/integrationIdentity';
import { IntegrationAvatar } from './IntegrationAvatar';
import { spanLabel } from './activityKind.jsx';
import { groupByActor } from '../../utils/ticketHistory';

/**
 * Activity tab — the "actor rail" (14 Sep 2026, option A).
 *
 * One vertical rail. Each run of consecutive actions by the same person is
 * one block: avatar + bold name once, then every action hangs off an inner
 * rail with its own coloured icon node (the node colour says what kind of
 * change it was before you read a word), the from → to chips say where it
 * went, and the time sits right-aligned in tabular figures. Machine chatter
 * (workflows, sync echoes, AI runs) is a dashed node; consecutive machine
 * rows are folded into one expandable "N automation events" line. Important
 * moves (close/resolve, reopen, assignment, urgent, created) sit on a tinted
 * plate. Two columns collapse to one on a phone.
 */

const EVENT_STYLE = {
  created: { icon: Plus, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200' },
  status: { icon: RefreshCw, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  close: { icon: Lock, tone: 'bg-secondary text-muted-foreground' },
  resolve: { icon: Check, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200' },
  reopen: { icon: RotateCcw, tone: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-200' },
  assignment: { icon: UserRound, tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' },
  ownership: { icon: Hand, tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' },
  priority: { icon: Zap, tone: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200' },
  group: { icon: Building2, tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-200' },
  note: { icon: MessageSquare, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  noteEdit: { icon: Pencil, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  reply: { icon: Mail, tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-200' },
  category: { icon: Tag, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  accepted: { icon: Check, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200' },
  field: { icon: Pencil, tone: 'bg-secondary text-muted-foreground' },
  due: { icon: CalendarClock, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  task: { icon: CheckSquare, tone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200' },
  forward: { icon: Forward, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  solution: { icon: BadgeCheck, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' },
  noise: { icon: VolumeX, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  ai: { icon: Sparkles, tone: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200' },
  intake: { icon: Inbox, tone: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-200' },
  workflow: { icon: Bot, tone: 'bg-muted text-muted-foreground border border-dashed border-input' },
  system: { icon: Bot, tone: 'bg-muted text-muted-foreground border border-dashed border-input' },
  burst: { icon: Bot, tone: 'bg-muted text-muted-foreground border border-dashed border-input' },
};

const PRIORITY_TONE = {
  urgent: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-200 dark:border-red-500/30',
  high: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/20 dark:text-orange-200 dark:border-orange-500/30',
  medium: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:border-amber-500/30',
  low: 'bg-muted text-muted-foreground border-border',
};
const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

const TERMINAL = new Set(['resolved', 'closed']);
const key = (s) => String(s || '').trim().toLowerCase();

function styleFor(item) {
  if (item.machine) return EVENT_STYLE[item.event] || EVENT_STYLE.system;
  if (item.event === 'status' && key(item.to) === 'closed') return EVENT_STYLE.close;
  if (item.event === 'status' && key(item.to) === 'resolved') return EVENT_STYLE.resolve;
  if (item.event === 'note' && /edited|updated/i.test(item.verb || '')) return EVENT_STYLE.noteEdit;
  return EVENT_STYLE[item.event] || EVENT_STYLE.system;
}

function Chip({ children, className = '', title }) {
  return (
    <span title={title} className={`inline-flex max-w-full min-w-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap align-middle ${className}`}>
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
      <span className="inline-flex items-center gap-1 min-w-0 align-middle">
        <PersonAvatar name={String(value)} photoUrl={photoForName?.(String(value)) || tech?.photoUrl || null} size="h-[18px] w-[18px]" textSize="text-[8px]" />
        <span className="text-[12.5px] font-semibold text-foreground truncate">{value}</span>
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

/** Verb for a row: "closed the ticket", "assigned", "raised priority". The actor is printed once per run, above. */
function verbFor(item) {
  if (item.event === 'status' && !item.from) return 'set status';
  if (item.event === 'status') return TERMINAL.has(key(item.to)) ? `${key(item.to) === 'closed' ? 'closed' : 'resolved'} the ticket` : 'set status';
  if (item.event === 'reopen') return 'reopened the ticket';
  if (item.event === 'assignment') {
    if (item.machine) return 'reconciled the assignee';
    return item.to ? 'assigned' : 'unassigned the ticket';
  }
  if (item.event === 'priority') {
    const a = PRIORITY_RANK[key(item.from)]; const b = PRIORITY_RANK[key(item.to)];
    if (a && b && a !== b) return b > a ? 'raised priority' : 'lowered priority';
    return 'set priority';
  }
  if (item.event === 'group') return item.to ? 'moved to group' : 'cleared the group';
  if (item.event === 'category') return 'categorised as';
  if (item.event === 'created') return 'created the ticket';
  return item.verb || item.event;
}

function isImportant(item) {
  if (item.machine) return false;
  if (item.event === 'reopen' || item.event === 'created' || item.event === 'assignment') return true;
  if (item.event === 'status' && TERMINAL.has(key(item.to))) return true;
  if (item.event === 'priority' && key(item.to) === 'urgent') return true;
  return false;
}

function RunAvatar({ run, photoForName }) {
  if (run.machine) {
    return (
      <span className="h-9 w-9 rounded-full flex items-center justify-center bg-muted text-muted-foreground border border-dashed border-input ring-[3px] ring-card">
        <Bot className="w-4 h-4" aria-hidden="true" />
      </span>
    );
  }
  const integration = integrationIdentity({ actorName: run.actor });
  if (integration) return <IntegrationAvatar identity={integration} size="h-9 w-9" className="ring-[3px] ring-card" />;
  return (
    <span className="inline-flex rounded-full ring-[3px] ring-card">
      <PersonAvatar name={run.actor} photoUrl={photoForName?.(run.actor) || null} size="h-9 w-9" textSize="text-[11px]" />
    </span>
  );
}

function Node({ item, className = '' }) {
  const S = styleFor(item);
  const Icon = S.icon;
  return (
    <span className={`h-[22px] w-[22px] rounded-full flex items-center justify-center flex-shrink-0 ring-[3px] ring-card ${S.tone} ${className}`} aria-hidden="true">
      <Icon className="w-3 h-3" />
    </span>
  );
}

function TimeCell({ item, className = '' }) {
  return (
    <span className={`text-[11px] tabular-nums text-muted-foreground/70 whitespace-nowrap ${className}`} title={new Date(item.at).toLocaleString()}>
      {formatDayTime(item.at)}
      <span className="text-muted-foreground/50"> · {timeAgo(item.at)}</span>
    </span>
  );
}

/** One action inside a run (or the single action of a standalone machine run). */
function EventRow({ item, statusTone, photoForName, technicians, isNew }) {
  const important = isImportant(item);
  return (
    <li
      className={`relative grid grid-cols-[22px_1fr] sm:grid-cols-[22px_1fr_auto] gap-x-2.5 items-start animate-fadeIn ${isNew ? 'tp-history-new' : ''}`}
      data-testid="history-row"
      data-event={item.event}
    >
      <Node item={item} className="mt-0.5" />
      <div className={`min-w-0 text-[13px] leading-6 ${important ? 'rounded-lg bg-muted/60 px-2.5 py-1 -ml-2.5' : ''}`}>
        <span className={important ? 'font-semibold text-foreground' : 'text-foreground/90'}>{verbFor(item)}</span>
        {' '}<Transition item={item} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />
        {item.actorBy && <span className="text-muted-foreground"> by {item.actorBy}</span>}
        {item.count > 1 && (
          <span className="text-muted-foreground text-xs" data-testid="collapsed-span"> · ×{item.count}, {spanLabel(item.from_at, item.to_at)}</span>
        )}
        {item.detail && <p className="text-xs text-muted-foreground/80 mt-0.5 break-words leading-5">{item.detail}</p>}
      </div>
      <TimeCell item={item} className="col-start-2 sm:col-start-auto sm:pt-1 sm:text-right" />
    </li>
  );
}

/** A folded burst of machine events, either inside a run or standalone on the rail. */
function BurstRow({ item, inRun }) {
  const [open, setOpen] = useState(false);
  const actors = useMemo(() => {
    const m = new Map();
    for (const i of item.items) m.set(i.actor, (m.get(i.actor) || 0) + (i.count || 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [item.items]);
  return (
    <li className={`relative grid ${inRun ? 'grid-cols-[22px_1fr] gap-x-2.5' : 'grid-cols-[36px_1fr] gap-x-3.5 py-1.5'} items-start`} data-testid="history-burst">
      <Node item={item} className={inRun ? 'mt-0.5' : 'ml-[7px] mt-0.5'} />
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="tp-focus-ring inline-flex flex-wrap items-center gap-x-1.5 rounded text-[12px] leading-6 text-muted-foreground hover:text-foreground text-left"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
          <span className="font-semibold">{item.count} automation {item.count === 1 ? 'event' : 'events'}</span>
          <span className="text-muted-foreground/70 tabular-nums">· {spanLabel(item.from_at, item.to_at)}</span>
          <span className="text-muted-foreground/70">· {actors.slice(0, 3).map(([a, n]) => `${a}${n > 1 ? ` ×${n}` : ''}`).join(', ')}</span>
        </button>
        {open && (
          <ol className="mt-1 mb-1 space-y-1 border-l border-dashed border-border pl-3">
            {item.items.map((sub) => (
              <li key={sub.key} className="text-[12px] text-muted-foreground animate-fadeIn">
                <span className="font-medium text-foreground/80">{sub.actor}</span>
                {' '}{sub.verb}
                {sub.to && <> <span className="font-medium text-foreground/80">{sub.to}</span></>}
                {sub.count > 1 && <span data-testid="collapsed-span"> · ×{sub.count}, {spanLabel(sub.from_at, sub.to_at)}</span>}
                <ActorKindChip kind={sub.kind} className="ml-1 align-middle" />
                {sub.detail && <span className="block text-[11px] text-muted-foreground/75 break-words">{sub.detail}</span>}
                <span className="block text-[10px] tabular-nums text-muted-foreground/60">{formatDayTime(sub.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

/** A lone machine event on the rail: one compact line, no avatar block. */
function MachineRow({ item, statusTone, photoForName, technicians }) {
  return (
    <li className="relative grid grid-cols-[36px_1fr] sm:grid-cols-[36px_1fr_auto] gap-x-3.5 items-start py-1.5" data-testid="history-row" data-event={item.event}>
      <Node item={item} className="ml-[7px] mt-0.5" />
      <div className="min-w-0 text-[12px] leading-6 text-muted-foreground">
        <span className="font-semibold">{item.actor}</span>
        {' '}{verbFor(item)}
        {' '}<Transition item={item} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />
        <ActorKindChip kind={item.kind} className="ml-1.5 align-middle" />
        {item.count > 1 && <span className="text-xs" data-testid="collapsed-span"> · ×{item.count}, {spanLabel(item.from_at, item.to_at)}</span>}
        {item.detail && <p className="text-[11px] text-muted-foreground/75 mt-0 break-words leading-5">{item.detail}</p>}
      </div>
      <TimeCell item={item} className="col-start-2 sm:col-start-auto sm:pt-1.5 sm:text-right" />
    </li>
  );
}

/** A run: one person, one avatar, one name, then their actions. Machine runs render compact. */
function Run({ run, statusTone, photoForName, technicians, now, newSinceMs }) {
  const only = run.items.length === 1 ? run.items[0] : null;
  if (run.machine && only && only.event === 'burst') return <BurstRow item={only} inRun={false} />;
  if (run.machine && only) return <MachineRow item={only} statusTone={statusTone} photoForName={photoForName} technicians={technicians} />;
  const showSpan = run.from_at !== run.to_at;
  return (
    <li className="relative grid grid-cols-[36px_1fr] gap-x-3.5 py-2.5" data-testid="history-run" data-actor={run.actor}>
      <RunAvatar run={run} photoForName={photoForName} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-h-[36px]">
        <span className={`text-sm font-bold ${run.machine ? 'text-muted-foreground' : 'text-foreground'}`}>{run.actor}</span>
        <ActorKindChip kind={run.kind} />
        {showSpan && <span className="text-[11px] tabular-nums text-muted-foreground/60">{spanLabel(run.from_at, run.to_at)}</span>}
      </div>
      <ol className="col-start-2 mt-1.5 space-y-2">
        {run.items.map((item) => (
          item.event === 'burst'
            ? <BurstRow key={item.key} item={item} inRun />
            : <EventRow key={item.key} item={item} statusTone={statusTone} photoForName={photoForName} technicians={technicians} isNew={now - item.at < newSinceMs} />
        ))}
      </ol>
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
  const days = useMemo(() => {
    const out = [];
    for (const item of visible) {
      const label = dayLabel(item.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item); else out.push({ label, items: [item] });
    }
    return out.map((d) => ({ ...d, runs: groupByActor(d.items) }));
  }, [visible]);
  const now = Date.now();
  return (
    <section className="tp-card rounded-xl p-4 sm:p-5" aria-label="Ticket history">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-3">
        <History className="w-4 h-4 text-primary" aria-hidden="true" />
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
        days.map((d) => (
          <div key={d.label} className="mb-2 last:mb-0">
            <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-card/95 backdrop-blur text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{d.label}</div>
            <ol className="relative">
              <span className="absolute left-[17px] top-2 bottom-2 w-0.5 rounded bg-border" aria-hidden="true" />
              {d.runs.map((run) => (
                <Run key={run.key} run={run} statusTone={statusTone} photoForName={photoForName} technicians={technicians} now={now} newSinceMs={newSinceMs} />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}
