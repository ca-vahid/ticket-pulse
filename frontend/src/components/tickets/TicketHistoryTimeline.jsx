import { useId, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDown, ArrowLeftRight, ArrowRight, ArrowUp, BadgeCheck, BookOpen, Bot, Building2,
  CalendarClock, Check, CheckSquare, ChevronDown, EyeOff, Forward, GitMerge, Hand, History, Inbox, Lock, Mail,
  MessageSquare, Pencil, Play, Plug, Plus, RefreshCw, RotateCcw, Siren, SkipForward, Sparkles, Tag, VolumeX, Wand2, Workflow,
} from 'lucide-react';
import { ACTOR_KIND_META, spanLabel } from './activityKind.jsx';
import { PersonAvatar, STATUS_COLORS } from './ticketUi.jsx';
import { integrationIdentity } from '../../utils/integrationIdentity';
import { IntegrationAvatar } from './IntegrationAvatar';
import { groupByActor } from '../../utils/ticketHistory';

/**
 * Activity tab — one line per event (QA 11-05 #9).
 *
 *   2:14 PM  (JL) Jordan Lee   ⇄  reassigned (JL) Jordan → (SO) Sam · Competency mismatch   ⌄
 *   9:12 AM  (✦) Ticket Pulse AI ⇄ assigned → (JL) Jordan · auto-assign                    ⌄
 *
 * Time, the actor's picture (a person's photo or initials, a machine's mark)
 * and name, the event's icon (with a text label for screen readers — colour
 * is never the only cue), then what changed: from → to, and a short reason.
 * Every row is a button: click or Enter / Space opens the details (the full
 * note, what a workflow did step by step, where it happened, the exact time).
 * Consecutive rows by the same actor show the picture and name once and hang
 * on a thin rail. Day headings stay. No pills: status and priority are
 * coloured words with a dot.
 *
 * All times are Pacific time ("Thu 22 Oct, 2:14 PM").
 */

const TZ = 'America/Vancouver';

const TONE = {
  emerald: 'text-emerald-600 dark:text-emerald-300',
  amber: 'text-amber-600 dark:text-amber-300',
  orange: 'text-orange-600 dark:text-orange-300',
  red: 'text-red-600 dark:text-red-300',
  blue: 'text-blue-600 dark:text-blue-300',
  sky: 'text-sky-600 dark:text-sky-300',
  violet: 'text-violet-600 dark:text-violet-300',
  indigo: 'text-indigo-600 dark:text-indigo-300',
  muted: 'text-muted-foreground',
};

const EVENT_STYLE = {
  created: { icon: Plus, tone: TONE.emerald, label: 'Created' },
  status: { icon: RefreshCw, tone: TONE.amber, label: 'Status change' },
  close: { icon: Lock, tone: TONE.muted, label: 'Ticket closed' },
  resolve: { icon: Check, tone: TONE.emerald, label: 'Ticket resolved' },
  reopen: { icon: RotateCcw, tone: TONE.orange, label: 'Ticket reopened' },
  assignment: { icon: ArrowLeftRight, tone: TONE.blue, label: 'Assignment' },
  ownership: { icon: Hand, tone: TONE.blue, label: 'Ownership' },
  priorityUp: { icon: ArrowUp, tone: TONE.red, label: 'Priority raised' },
  priorityDown: { icon: ArrowDown, tone: TONE.sky, label: 'Priority lowered' },
  priority: { icon: ArrowUp, tone: TONE.red, label: 'Priority' },
  group: { icon: Building2, tone: TONE.sky, label: 'Group' },
  note: { icon: MessageSquare, tone: TONE.violet, label: 'Note' },
  noteEdit: { icon: Pencil, tone: TONE.violet, label: 'Note edited' },
  reply: { icon: Mail, tone: TONE.sky, label: 'Reply' },
  category: { icon: Tag, tone: TONE.violet, label: 'Category' },
  accepted: { icon: Check, tone: TONE.emerald, label: 'Accepted' },
  field: { icon: Pencil, tone: TONE.muted, label: 'Fields' },
  due: { icon: CalendarClock, tone: TONE.amber, label: 'Due date' },
  task: { icon: CheckSquare, tone: TONE.amber, label: 'Task' },
  forward: { icon: Forward, tone: TONE.violet, label: 'Forward' },
  merge: { icon: GitMerge, tone: TONE.violet, label: 'Merge' },
  solution: { icon: BadgeCheck, tone: TONE.emerald, label: 'Verified solution' },
  noise: { icon: VolumeX, tone: TONE.violet, label: 'Noise' },
  ai: { icon: Sparkles, tone: TONE.indigo, label: 'AI' },
  autohelp: { icon: BookOpen, tone: TONE.blue, label: 'Auto-help' },
  urgent: { icon: Siren, tone: TONE.red, label: 'Urgent response' },
  intake: { icon: Inbox, tone: TONE.violet, label: 'Intake' },
  // The workflow mark is the actor's picture; the event column says what it did.
  workflow: { icon: Pencil, tone: TONE.amber, label: 'Workflow change' },
  macro: { icon: Wand2, tone: TONE.violet, label: 'Macro' },
  wfrun: { icon: Play, tone: TONE.amber, label: 'Workflow run' },
  wfFailed: { icon: AlertTriangle, tone: TONE.red, label: 'Workflow failed' },
  wfShadow: { icon: EyeOff, tone: TONE.muted, label: 'Shadow run' },
  wfSkipped: { icon: SkipForward, tone: TONE.muted, label: 'Workflow skipped' },
  system: { icon: Bot, tone: TONE.muted, label: 'System' },
};

const PRIORITY_TONE = { urgent: TONE.red, high: TONE.orange, medium: TONE.amber, low: TONE.muted };
const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };
const TERMINAL = new Set(['resolved', 'closed']);
const key = (s) => String(s || '').trim().toLowerCase();
const has = (v) => v !== null && v !== undefined && v !== '';

// ── Pacific-time labels ──────────────────────────────────────────────────
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
const timeLabel = (ts) => new Date(ts).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
function dayName(ts, withYear) {
  return new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).replace(',', '');
}
/** "Thu 22 Oct, 2:14 PM" — the format the QA pack uses everywhere. */
export function fullTime(ts) {
  const y = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date(t));
  return `${dayName(ts, y(ts) !== y(Date.now()))}, ${timeLabel(ts)}`;
}
export function dayHeading(ts, nowTs = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(nowTs)) return 'Today';
  if (k === dayKey(nowTs - 86400000)) return 'Yesterday';
  const y = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date(t));
  return dayName(ts, y(ts) !== y(nowTs));
}

// ── What a row says ─────────────────────────────────────────────────────
function styleFor(item) {
  if (item.event === 'wfrun') {
    if (item.outcome === 'failed') return EVENT_STYLE.wfFailed;
    if (item.shadow) return EVENT_STYLE.wfShadow;
    if (item.outcome === 'stopped') return EVENT_STYLE.wfSkipped;
    return EVENT_STYLE.wfrun;
  }
  if (item.event === 'status' && key(item.to) === 'closed') return EVENT_STYLE.close;
  if (item.event === 'status' && key(item.to) === 'resolved') return EVENT_STYLE.resolve;
  if (item.event === 'note' && /edited|updated/i.test(item.verb || '')) return EVENT_STYLE.noteEdit;
  if (item.event === 'priority') {
    const a = PRIORITY_RANK[key(item.from)]; const b = PRIORITY_RANK[key(item.to)];
    if (a && b && a !== b) return b > a ? EVENT_STYLE.priorityUp : EVENT_STYLE.priorityDown;
  }
  return EVENT_STYLE[item.event] || EVENT_STYLE.system;
}

/** The short words before the from → to. The actor is printed once per run. */
function verbFor(item) {
  if (item.event === 'wfrun') return item.verb;
  if (item.event === 'status' && TERMINAL.has(key(item.to)) && item.from) return key(item.to) === 'closed' ? 'closed' : 'resolved';
  if (item.event === 'status') return 'status';
  if (item.event === 'reopen') return 'reopened';
  if (item.event === 'assignment') {
    if (item.machine && item.kind !== 'ai' && item.actorType !== 'ai') return 'synced the assignee';
    if (item.verb === 'reassigned') return 'reassigned';
    if (item.verb && !/^(assigned|unassigned)$/.test(item.verb) && !has(item.to) && !has(item.from)) return item.verb;
    return has(item.to) ? 'assigned' : 'unassigned';
  }
  if (item.event === 'priority') return 'priority';
  if (item.event === 'group') return has(item.to) ? 'group' : 'cleared the group';
  if (item.event === 'category') return 'category';
  if (item.event === 'created') return 'created the ticket';
  return item.verb || item.event;
}

const ACTOR_LABEL = { workflow: 'Workflow', fs_workflow: 'FreshService workflow', freshservice: 'FreshService' };
const actorLabel = (item) => ACTOR_LABEL[item.actorType] || item.actor || 'System';

/** The short reason after "·": an explicit reason, else a one-line detail. */
function reasonFor(item) {
  if (has(item.reason)) return String(item.reason);
  const d = item.detail ? String(item.detail) : '';
  if (d && d.length <= 100 && !/\n/.test(d)) {
    // "Ticket reassigned — Competency mismatch" → "Competency mismatch"
    const m = /^ticket (?:re)?assigned\s*[—–-]\s*(.+)$/i.exec(d);
    return m ? m[1] : d;
  }
  return null;
}

// ── Pictures ────────────────────────────────────────────────────────────
const MARK = {
  ai: { icon: Sparkles, tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200', title: 'Ticket Pulse AI' },
  workflow: { icon: Workflow, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200', title: 'Ticket Pulse workflow' },
  fs_workflow: { icon: Workflow, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200', title: 'FreshService workflow' },
  freshservice: { icon: RefreshCw, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200', title: 'FreshService' },
  ticketpulse: { icon: Activity, tone: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200', title: 'Ticket Pulse' },
  autohelp: { icon: BookOpen, tone: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200', title: 'Auto-help' },
  api: { icon: Plug, tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200', title: 'Public API' },
  system: { icon: Bot, tone: 'bg-muted text-muted-foreground', title: 'System' },
};

export function ActorPicture({ name, actorType, photoForName, size = 'h-5 w-5', iconSize = 'w-3 h-3', textSize = 'text-[8px]' }) {
  const mark = actorType && actorType !== 'person' ? MARK[actorType] || MARK.system : null;
  if (mark) {
    const Icon = mark.icon;
    return (
      <span className={`${size} rounded-full inline-flex items-center justify-center flex-shrink-0 ${mark.tone}`} title={mark.title} aria-hidden="true">
        <Icon className={iconSize} />
      </span>
    );
  }
  const integration = integrationIdentity({ actorName: name });
  if (integration) return <IntegrationAvatar identity={integration} size={size} />;
  return (
    <span className="inline-flex flex-shrink-0" aria-hidden="true" title={name || undefined}>
      <PersonAvatar name={name} photoUrl={photoForName?.(name) || null} size={size} textSize={textSize} />
    </span>
  );
}

/** The one arrow of the tab: lucide ArrowRight, also inside summaries and notes. */
function Arrow() {
  return <ArrowRight className="inline-block w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0 align-[-2px]" aria-label="to" />;
}

/** Text whose " → " is drawn as the ArrowRight icon ("set status Pending → Open"). */
export function ArrowText({ text }) {
  const parts = String(text ?? '').split(/\s+→\s+/);
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => (
    <span key={`${i}-${p}`}>{i > 0 && <>{' '}<Arrow />{' '}</>}{p}</span>
  ));
}

// `oneLine`: the desktop row (sm and up, not the peek) truncates long values;
// the two-line phone / peek row wraps them and never cuts them.
function StatusWord({ value, statusTone, oneLine }) {
  const tone = statusTone?.(String(value)) || STATUS_COLORS[value] || '';
  const text = tone.split(/\s+/).filter((c) => /(^|:)text-/.test(c)).join(' ') || 'text-foreground/85';
  return (
    <span className={`inline-flex items-center gap-1 min-w-0 max-w-full font-semibold ${text}`} title={String(value)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current flex-shrink-0" aria-hidden="true" />
      <span className={`break-words ${oneLine ? 'sm:truncate' : ''}`}>{value}</span>
    </span>
  );
}

function Value({ item, value, statusTone, photoForName, oneLine }) {
  if (!has(value)) return <span className="text-muted-foreground">Unassigned</span>;
  if (item.event === 'status' || item.event === 'reopen') return <StatusWord value={value} statusTone={statusTone} oneLine={oneLine} />;
  if (item.event === 'priority') return <span className={`font-semibold ${PRIORITY_TONE[key(value)] || TONE.muted}`}>{value}</span>;
  if (item.event === 'assignment' || item.event === 'ownership') {
    return (
      <span className="inline-flex items-center gap-1 min-w-0 max-w-full" title={String(value)}>
        <ActorPicture name={String(value)} actorType="person" photoForName={photoForName} size="h-4 w-4" textSize="text-[7px]" />
        <span className={`font-semibold text-foreground break-words ${oneLine ? 'sm:truncate sm:max-w-[11rem]' : ''}`}>{value}</span>
      </span>
    );
  }
  return <span className={`font-medium text-foreground break-words max-w-full ${oneLine ? 'sm:truncate sm:max-w-[16rem]' : ''}`} title={String(value)}>{value}</span>;
}

function Transition({ item, statusTone, photoForName, oneLine }) {
  const hasFrom = has(item.from);
  const hasTo = has(item.to);
  if (!hasFrom && !hasTo) return null;
  // "Jordan picked this up" needs no "→ Jordan".
  if (item.event === 'ownership' && !hasFrom && key(item.to) === key(item.actor)) return null;
  return (
    // Two-line layout: `contents` lets from, arrow and to wrap one by one with the verb.
    <span className={`contents ${oneLine ? 'sm:inline-flex sm:items-center sm:gap-1 sm:min-w-0 sm:flex-shrink' : ''}`} data-testid="history-transition">
      {hasFrom && <Value item={item} value={item.from} statusTone={statusTone} photoForName={photoForName} oneLine={oneLine} />}
      {(hasFrom || item.event === 'assignment' || item.event === 'ownership') && <Arrow />}
      <Value item={item} value={hasTo ? item.to : null} statusTone={statusTone} photoForName={photoForName} oneLine={oneLine} />
    </span>
  );
}

/** Plain words a screen reader (and the title tooltip) can read for the whole line. */
function lineText(item) {
  const parts = [actorLabel(item), styleFor(item).label + ':', item.workflowName ? `"${item.workflowName}"` : null, verbFor(item)];
  if (has(item.from)) parts.push(`${item.from} →`);
  if (has(item.to)) parts.push(item.from ? item.to : `→ ${item.to}`);
  const reason = reasonFor(item);
  if (reason) parts.push(`· ${reason}`);
  return parts.filter(Boolean).join(' ');
}

const STEP_LABEL = {
  trigger: 'Started', condition: 'Checked a condition', delay: 'Waited', recipient_resolver: 'Found the recipients',
  llm_generate: 'AI wrote the e-mail', llm_tool: 'AI checked its draft', template_render: 'Filled the template',
  send_email: 'E-mail', update_ticket: 'Updated the ticket', add_note: 'Added a note', park_ticket: 'Parked the ticket',
  call_webhook: 'Called a webhook', send_teams_message: 'Teams message', create_child_ticket: 'Created a child ticket',
  request_approval: 'Asked for approval', propose_reply: 'Staged a reply', stop: 'Stopped', branch: 'Branched',
};

function Details({ item, id }) {
  const reason = reasonFor(item);
  const kindMeta = ACTOR_KIND_META[item.kind];
  const where = item.event === 'wfrun' && item.actorType === 'workflow'
    ? (item.shadow ? 'Ticket Pulse workflow in Shadow — nothing was sent or changed' : 'Ticket Pulse workflow')
    : item.source === 'freshservice' ? (item.actorType === 'person' ? 'Done in FreshService' : 'Observed in FreshService') : kindMeta?.title || null;
  const steps = (item.steps || []).filter((s) => s.nodeType !== 'trigger');
  return (
    <div id={id} className="mt-0.5 mb-1.5 ml-[68px] sm:ml-[88px] border-l border-border pl-3 text-xs text-muted-foreground space-y-1 animate-fadeIn" data-testid="history-details">
      {item.workflowName && <p className="text-foreground/85 font-medium break-words">{item.actorType === 'fs_workflow' ? 'FreshService workflow' : 'Workflow'} “{item.workflowName}”{item.eventType ? <span className="font-normal text-muted-foreground"> · on {item.eventType.replace(/^ticket\./, '').replace(/_/g, ' ')}</span> : null}</p>}
      {item.detail && item.detail !== reason && <p className="whitespace-pre-wrap break-words text-foreground/85"><ArrowText text={item.detail} /></p>}
      {reason && reason.length > 60 && <p className="break-words"><ArrowText text={reason} /></p>}
      {(item.extra || []).map((x) => <p key={x} className="break-words"><ArrowText text={x} /></p>)}
      {steps.length > 0 && (
        <ol className="space-y-0.5" aria-label="Workflow steps">
          {steps.map((s, idx) => (
            <li key={`${s.nodeId}-${idx}`} className="flex items-baseline gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 translate-y-[-1px] ${s.status === 'failed' ? 'bg-red-500' : s.nodeType === 'stop' ? 'bg-muted-foreground/50' : 'bg-emerald-500'}`} aria-hidden="true" />
              <span className="text-foreground/85">{STEP_LABEL[s.nodeType] || s.nodeType.replace(/_/g, ' ')}</span>
              {s.note && <span className="min-w-0 break-words">{' '}· <ArrowText text={s.note} /></span>}
              {s.status === 'failed' && <span className="text-red-600 dark:text-red-300">{' '}· failed{s.error ? `: ${s.error}` : ''}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="text-[11px] text-muted-foreground/80 tabular-nums">
        {fullTime(item.at)}
        {item.count > 1 && <span data-testid="collapsed-span"> · ×{item.count}, {spanLabel(item.from_at, item.to_at)}</span>}
        {item.duration && <span> · took {item.duration}</span>}
        {where && <span data-testid="actor-kind" data-kind={item.kind}> · {where}</span>}
      </p>
    </div>
  );
}

/**
 * One event per row.
 *
 * From sm up (not in the peek): ONE line — time · picture + name · event
 * icon · the change · chevron; long values truncate (with a title).
 * Below sm, and always in the peek (`compact`): TWO lines — line 1 is time ·
 * picture · name · chevron; line 2, indented under the name, is the change,
 * wrapping and never cut. The event icon is dropped there (the verb says
 * it). A 2nd+ row of a run (`showActor` false) puts its change on line 1.
 */
export function HistoryRow({ item, showActor = true, statusTone, photoForName, isNew = false, compact = false }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const S = styleFor(item);
  const Icon = S.icon;
  const reason = reasonFor(item);
  const full = lineText(item);
  const actor = actorLabel(item);
  const oneLine = !compact;
  const sm = (cls) => (oneLine ? cls : '');
  const hasMove = has(item.from) || has(item.to) || item.workflowName;
  return (
    <div className={`relative ${isNew ? 'tp-history-new' : ''}`} data-testid="history-row" data-event={item.event} data-kind={item.kind} data-machine={item.machine ? 'true' : 'false'} data-layout={compact ? 'two-line' : 'responsive'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={full}
        className={`tp-focus-ring group w-full grid items-start gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left text-[13px] leading-5 hover:bg-muted/60 grid-cols-[44px_20px_minmax(0,1fr)_14px] ${sm('sm:grid-cols-[64px_168px_16px_minmax(0,1fr)_14px] sm:items-center')} ${item.machine ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {/* The peek has no day headings: an older row shows its day instead. */}
        <span className={`col-start-1 row-start-1 text-[11px] tabular-nums text-muted-foreground/80 whitespace-nowrap ${sm('sm:col-start-1')}`} title={fullTime(item.at)}>
          {compact && dayKey(item.at) !== dayKey(Date.now())
            ? new Date(item.at).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' })
            : timeLabel(item.at)}
        </span>
        <span className={`row-start-1 col-start-2 ${showActor ? 'col-span-2' : 'col-span-1'} ${sm('sm:col-span-1')} flex items-center gap-1.5 min-w-0`}>
          {showActor ? <ActorPicture name={item.actor} actorType={item.actorType} photoForName={photoForName} /> : <span className="h-5 w-5 flex-shrink-0" aria-hidden="true" />}
          {showActor
            ? <span className={`truncate font-semibold ${item.machine ? 'text-muted-foreground' : 'text-foreground'}`}>{actor}</span>
            : <span className="sr-only">{actor}</span>}
        </span>
        <span className={`hidden ${sm(`sm:inline-flex sm:col-start-3 sm:row-start-1 ${S.tone}`)}`}>
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="sr-only">{S.label}</span>
        </span>
        <span
          data-testid="history-change"
          className={`col-start-2 pl-[26px] flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 whitespace-normal ${showActor ? 'row-start-2 col-span-3' : 'row-start-1 col-span-2'} ${sm('sm:col-start-4 sm:col-span-1 sm:row-start-1 sm:pl-0 sm:flex-nowrap sm:overflow-hidden sm:whitespace-nowrap')}`}
        >
          {item.workflowName && <span className={`font-semibold text-foreground break-words max-w-full ${sm('sm:truncate sm:max-w-[18rem] sm:flex-shrink')}`} title={item.workflowName}>“{item.workflowName}”</span>}
          <span className={`max-w-full ${hasMove ? sm('sm:flex-shrink-0') : sm('sm:min-w-0 sm:truncate')} ${item.event === 'urgent' || item.event === 'reopen' || (item.event === 'status' && TERMINAL.has(key(item.to))) ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{verbFor(item)}</span>
          <Transition item={item} statusTone={statusTone} photoForName={photoForName} oneLine={oneLine} />
          {reason && <span className={`min-w-0 max-w-full break-words text-muted-foreground ${sm('sm:truncate')}`} title={reason}>· <ArrowText text={reason} /></span>}
          {item.count > 1 && <span className="flex-shrink-0 text-[11px] text-muted-foreground/80">×{item.count}</span>}
          {item.duration && !reason && <span className="flex-shrink-0 text-[11px] text-muted-foreground/80">· {item.duration}</span>}
        </span>
        <ChevronDown className={`col-start-4 row-start-1 mt-[3px] ${sm('sm:col-start-5 sm:mt-0')} w-3.5 h-3.5 text-muted-foreground/60 group-hover:text-muted-foreground ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && <Details item={item} id={id} />}
    </div>
  );
}

/** A run: one actor's consecutive rows, the picture and name on the first. */
function Run({ run, statusTone, photoForName, now, newSinceMs }) {
  return (
    <li className="relative" data-testid="history-run" data-actor={run.actor}>
      {run.items.length > 1 && <span className="absolute left-[68px] sm:left-[88px] top-[26px] bottom-[10px] w-px bg-border" aria-hidden="true" />}
      {run.items.map((item, idx) => (
        <HistoryRow key={item.key} item={item} showActor={idx === 0} statusTone={statusTone} photoForName={photoForName} isNew={now - item.at < newSinceMs} />
      ))}
    </li>
  );
}

export default function TicketHistoryTimeline({
  items, hideMachine, onToggleMachine, hiddenMachineCount, statusTone, photoForName, newSinceMs = 2 * 60 * 1000,
}) {
  const visible = useMemo(() => (hideMachine ? items.filter((i) => !i.machine) : items), [items, hideMachine]);
  const days = useMemo(() => {
    const out = [];
    for (const item of visible) {
      const label = dayHeading(item.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item); else out.push({ label, items: [item] });
    }
    return out.map((d) => ({ ...d, runs: groupByActor(d.items) }));
  }, [visible]);
  const now = Date.now();
  return (
    <section className="tp-card rounded-xl p-4 sm:p-5" aria-label="Ticket history">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
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
          <div key={d.label} className="mb-1.5 last:mb-0">
            <h3 className="sticky top-0 z-10 -mx-1 px-1 pt-1.5 pb-0.5 bg-card/95 backdrop-blur text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">{d.label}</h3>
            <ol>
              {d.runs.map((run) => (
                <Run key={run.key} run={run} statusTone={statusTone} photoForName={photoForName} now={now} newSinceMs={newSinceMs} />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}
