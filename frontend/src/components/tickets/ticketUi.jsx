import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';
import { ExternalLink, Ticket as TicketIcon, Ban, ClipboardList, Cloud, CloudOff, CloudUpload, Globe, Sparkles, UserCog, UserPlus, UserRound, Zap } from 'lucide-react';
import { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from '../tech-detail/constants';
import { useTicketTypes } from '../../hooks/useTicketTypes';

export { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS };

/**
 * A thread entry that is an actual MESSAGE (reply/note/email), not the FS
 * activity feed — FS caches system lines ("executed workflow…") as entries
 * with bodies, and those belong on the History tab, never in Conversation.
 */
export function isConversationEntry(e) {
  if (!e || e.source === 'freshservice_activity') return false;
  return Boolean(e.bodyText || e.content || e.bodyHtml);
}

/**
 * Category labels with the CORRECT precedence: the Ticket Pulse taxonomy is
 * the primary system — canonical internal categories first, then the raw
 * TP-category custom fields from FS (tp_skill/tp_subskill), and only then
 * the legacy single-box FS category ("security" era) as a last resort.
 */
export function ticketCategoryLabels(t) {
  return {
    category: t?.internalCategory?.name || t?.tpSkill || t?.ticketCategory || null,
    subcategory: t?.internalSubcategory?.name || t?.tpSubskill || null,
  };
}

/** Human labels for AI pipeline runs (shared by detail sidebar + peek). */
export function pipelineRunLabel(run) {
  if (!run) return null;
  if (run.status === 'queued') return 'Queued';
  const raw = run.decision || run.status || '';
  if (raw === 'priority_only') return 'Priority & category assessed';
  return String(raw).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function pipelineTriggerLabel(source) {
  const map = {
    poll: 'business-hours queue',
    priority_assessment_after_hours: 'after-hours assessment',
    manual: 'manual trigger',
    app_native: 'created in Ticket Pulse',
  };
  return map[source] || String(source || '').replace(/_/g, ' ');
}

// Ticket arrival channel (QA 07-10 #6/#7). Mirrors the backend's
// TICKET_SOURCE_LABELS numeric space: 1–10 = FreshService codes, 100+ = TP
// extensions. SOURCE_OPTIONS = the channels an agent can pick when logging
// or editing a TP-born ticket.
export const TICKET_SOURCE_LABELS = {
  1: 'Email', 2: 'Portal', 3: 'Phone', 4: 'Chat', 5: 'Feedback widget',
  6: 'Yammer', 7: 'AWS CloudWatch', 8: 'PagerDuty', 9: 'Walk-up', 10: 'Slack',
  // 11–19 and 1000+ are this FS instance's custom source choices (QA 07-14 #5).
  13: 'Employee Onboarding', 14: 'Alerts', 15: 'MS Teams (FS)',
  18: 'Employee Offboarding', 19: 'Journey',
  100: 'API', 101: 'Webhook', 102: 'MS Teams', 103: 'Agent',
  1001: 'API (FreshService)', 1002: 'Company Portal',
};
export function ticketSourceLabel(source) {
  if (source === null || source === undefined) return null;
  return TICKET_SOURCE_LABELS[Number(source)] || `Source ${source}`;
}
export const SOURCE_OPTIONS = [
  { value: 103, label: 'Agent (logged in app)' },
  { value: 1, label: 'Email' },
  { value: 3, label: 'Phone' },
  { value: 9, label: 'Walk-up' },
  { value: 102, label: 'MS Teams' },
  { value: 2, label: 'Portal' },
];

// Email bodies reference inline images by `cid:` (Content-ID) — those can
// never resolve in a browser and render as broken-image icons. Drop them; the
// actual bytes surface via the attachment strip/rail instead (QA 07-06 #9).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && /^cid:/i.test(node.getAttribute('src') || '')) node.remove();
});

/** Sanitized HTML rendering for email/description bodies. */
export function SafeHtml({ html, className = '' }) {
  const clean = DOMPurify.sanitize(String(html || ''), {
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload'],
    ADD_ATTR: ['target'],
  });
  return (
    <div
      className={`tp-rich-body text-sm text-slate-700 break-words [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full [&_blockquote]:border-l-2 [&_blockquote]:border-slate-200 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ${className}`}
      // Sanitized above with DOMPurify — the only way to render email HTML faithfully.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

const STATE_CHIP_STYLES = {
  new: { label: 'New', dot: 'bg-blue-500' },
  response_due: { label: 'Response due', dot: 'bg-amber-500' },
  requester_responded: { label: 'Requester replied', dot: 'bg-sky-500' },
  overdue: { label: 'Overdue', dot: 'bg-red-500' },
};

/**
 * Derived at-a-glance state (computed server-side as `stateChip`). Rendered as a
 * small colored dot with a tooltip — the verbose "RESPONSE DUE" pill was noise
 * on the subject line; the color carries the signal, the title carries the word.
 */
export function StateChip({ state, className = '' }) {
  const def = STATE_CHIP_STYLES[state];
  if (!def) return null;
  return (
    <span
      title={def.label}
      aria-label={def.label}
      role="img"
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${def.dot} ${className}`}
    />
  );
}

// Registry color tokens → tile/text tones. Keep keys in sync with the backend
// ticketTypeService COLORS whitelist.
export const TYPE_COLOR_TONES = {
  slate: { tile: 'bg-slate-100 text-slate-600', text: 'text-slate-600' },
  orange: { tile: 'bg-orange-100 text-orange-600', text: 'text-orange-600' },
  violet: { tile: 'bg-violet-100 text-violet-600', text: 'text-violet-600' },
  red: { tile: 'bg-red-100 text-red-600', text: 'text-red-600' },
  blue: { tile: 'bg-blue-100 text-blue-600', text: 'text-blue-600' },
  emerald: { tile: 'bg-emerald-100 text-emerald-600', text: 'text-emerald-600' },
  amber: { tile: 'bg-amber-100 text-amber-700', text: 'text-amber-700' },
  cyan: { tile: 'bg-cyan-100 text-cyan-600', text: 'text-cyan-600' },
  pink: { tile: 'bg-pink-100 text-pink-600', text: 'text-pink-600' },
};

/**
 * Ticket type as a Linear-style glyph tile + plain text — no pill (pills wrap
 * and read as noise at row density; a small colored glyph scans faster).
 * Styling (color + abbreviation) comes from the workspace's ticket-type
 * registry; unknown/legacy values fall back to the old INC/REQ heuristic so
 * historical strings still render.
 */
export function TypePill({ type, full = false }) {
  const { typeByName } = useTicketTypes();
  if (!type) return null;
  const def = typeByName(type);
  const isIncident = /incident/i.test(type);
  const tone = TYPE_COLOR_TONES[def?.color]
    || (isIncident ? TYPE_COLOR_TONES.orange : TYPE_COLOR_TONES.violet);
  const Icon = (def ? def.color === 'orange' || def.color === 'red' : isIncident) ? Zap : ClipboardList;
  // Rows use short codes (INC/CASE/REQ…) so the column stays tiny; the glyph
  // and tooltip carry the meaning. `full` spells it out where space allows.
  const abbrev = def?.abbreviation || (isIncident ? 'INC' : 'REQ');
  const label = full ? type : abbrev;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 whitespace-nowrap" title={type}>
      <span
        aria-hidden="true"
        className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] flex-shrink-0 ${tone.tile}`}
      >
        <Icon className="w-3 h-3" strokeWidth={2.4} />
      </span>
      <span className={full
        ? 'truncate text-[11px] font-medium text-slate-600'
        : `text-[10px] font-bold tracking-widest ${tone.text}`}
      >
        {label}
      </span>
    </span>
  );
}

// Tag palette (gap plan P1) — named keys map to soft chip tones. Keep in sync
// with the backend TAG_COLORS whitelist.
export const TAG_CHIP_TONES = {
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  sky: 'bg-sky-50 text-sky-700 border-sky-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  pink: 'bg-pink-50 text-pink-700 border-pink-200',
};

export function TagChip({ tag, size = 'sm', onRemove = null, className = '' }) {
  if (!tag) return null;
  const tone = TAG_CHIP_TONES[tag.color] || TAG_CHIP_TONES.slate;
  const pad = size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap ${pad} ${tone} ${className}`}>
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(tag); }}
          aria-label={`Remove tag ${tag.name}`}
          className="tp-focus-ring rounded-full leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Countdown label + tone for an SLA deadline. */
export function dueIn(value) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  const diffMin = Math.round((target - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  const span = abs < 60 ? `${abs}m` : abs < 48 * 60 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (diffMin < 0) return { label: `Overdue ${span}`, state: 'over' };
  if (diffMin < 4 * 60) return { label: `${span} left`, state: 'warn' };
  return { label: `${span} left`, state: 'ok' };
}

export function SlaChip({ value, paused = false, className = '' }) {
  // Pending tickets pause the SLA clock: neutral "Paused" chip, no countdown,
  // no overdue red — the requester (or a third party) holds the ball.
  if (paused) {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap bg-slate-100 text-slate-500 ${className}`} title="SLA paused while the ticket is pending">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" aria-hidden="true" />
        Paused
      </span>
    );
  }
  const info = dueIn(value);
  if (!info) return null;
  // Softer, borderless urgency pills with a leading colored dot (mockup style):
  // red overdue, amber due-soon, green plenty-of-time.
  const tone = info.state === 'over'
    ? 'bg-red-50 text-red-600'
    : info.state === 'warn'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-emerald-50 text-emerald-700';
  const dot = info.state === 'over' ? 'bg-red-500' : info.state === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {info.label}
    </span>
  );
}

/**
 * Terminal-aware state for one SLA target row (first response / resolution).
 *
 * States:
 *  - 'met'     → fulfilled at/before the target (fulfillment time known)
 *  - 'late'    → fulfilled after the target — a historical fact, not an alarm
 *  - 'unknown' → ticket already resolved/closed but we never learned when (or
 *                whether) the target was met (sparse FS data) — never "Overdue"
 *  - 'live'    → ticket still open; the countdown/overdue chip applies
 */
export function slaTargetState({ target, metAt = null, isTerminal = false }) {
  if (!target) return null;
  const targetMs = new Date(target).getTime();
  if (Number.isNaN(targetMs)) return null;
  if (metAt) {
    const metMs = new Date(metAt).getTime();
    if (!Number.isNaN(metMs)) {
      return { state: metMs <= targetMs ? 'met' : 'late', deltaMs: metMs - targetMs };
    }
  }
  return { state: isTerminal ? 'unknown' : 'live' };
}

/** Compact duration label for tooltip deltas ("45m", "7h", "3d"). */
function slaSpan(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

const SLA_TARGET_DATETIME = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };

/**
 * SLA chip for a target row that knows about terminal tickets. Live tickets
 * defer to SlaChip (countdown / overdue / paused); once the target is met or
 * the ticket is closed, the chip freezes into a historical outcome — a closed
 * ticket must never show a running "Overdue Nd".
 *
 * kind: 'response' (first response) | 'resolution'.
 */
export function SlaTargetChip({ target, metAt = null, status, kind = 'response', className = '' }) {
  const isTerminal = ['Resolved', 'Closed'].includes(status);
  const info = slaTargetState({ target, metAt, isTerminal });
  if (!info) return null;
  if (info.state === 'live') {
    return <SlaChip value={target} paused={status === 'Pending'} className={className} />;
  }
  const base = `inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap border ${className}`;
  const targetLabel = new Date(target).toLocaleString(undefined, SLA_TARGET_DATETIME);
  const noun = kind === 'resolution' ? 'Resolution' : 'First response';
  if (info.state === 'unknown') {
    const title = `${noun} target was ${targetLabel}. The ticket is ${String(status).toLowerCase()} and this timestamp wasn't tracked, so it can't be marked met or missed.`;
    return (
      <span className={`${base} bg-slate-50 text-slate-400 border-slate-200`} title={title} aria-label={title}>
        —
      </span>
    );
  }
  const metLabel = new Date(metAt).toLocaleString(undefined, SLA_TARGET_DATETIME);
  const verb = kind === 'resolution' ? 'Resolved' : 'Responded';
  if (info.state === 'met') {
    return (
      <span
        className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}
        title={`${verb} ${metLabel} — ${slaSpan(info.deltaMs)} before the ${targetLabel} target`}
      >
        {kind === 'resolution' ? 'Done' : 'Met'}
      </span>
    );
  }
  return (
    <span
      className={`${base} bg-amber-50 text-amber-700 border-amber-200`}
      title={`${verb} ${metLabel} — ${slaSpan(info.deltaMs)} after the ${targetLabel} target`}
    >
      {kind === 'resolution' ? 'Resolved late' : 'Met late'}
    </span>
  );
}

export function timeAgo(value) {
  if (!value) return '—';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/**
 * "Jul 27, 3:42 PM" — with the year spelled out ("Jul 27, 2025, 3:42 PM")
 * whenever the date isn't in the current year (QA 08-04 #17a: a year-less
 * "Jul 27" on an old ticket read as this year). Same rule timeAgo uses.
 */
export function formatDayTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleString(undefined, opts);
}

/** Date-only sibling of formatDayTime: "Jul 27", or "Jul 27, 2025" off-year. */
export function formatDay(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
}

export function StatusPill({ status, className = '', size = 'md' }) {
  const tone = STATUS_COLORS[status] || 'bg-slate-100 text-slate-500';
  // Deleted/Spam are terminal removals — solid red/orange + icon so they read as
  // "removed", not a quiet grey chip. `size='sm'` (dense queue rows) keeps it
  // compact so it fits its column; `md` (headers) is more prominent.
  const isRemoved = status === 'Deleted' || status === 'Spam';
  if (isRemoved) {
    const sm = size === 'sm';
    return (
      <span className={`inline-flex items-center ${sm ? 'gap-0.5 px-1.5 text-[10px]' : 'gap-1 px-2.5 text-xs tracking-wide shadow-sm'} py-0.5 rounded-full font-bold uppercase whitespace-nowrap ${tone} ${className}`}>
        <Ban className={sm ? 'w-3 h-3' : 'w-3.5 h-3.5'} aria-hidden="true" />
        {status}
      </span>
    );
  }
  // Custom FS statuses can be long ("Waiting on Customer") — clamp to the
  // pill's container instead of bleeding into the neighbouring column.
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`}
      title={status}
    >
      <span className="truncate">{status}</span>
    </span>
  );
}

export function PriorityDot({ priority, withLabel = false }) {
  const color = PRIORITY_STRIP_COLORS[priority] || 'bg-slate-300';
  const label = PRIORITY_LABELS[priority] || `P${priority}`;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Priority: ${label}`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${color}`} />
      {withLabel && <span className="text-xs font-medium text-slate-600">{label}</span>}
      {!withLabel && <span className="sr-only">{label} priority</span>}
    </span>
  );
}

/** Where a ticket was born: Ticket Pulse or FreshService. */
// Requester email domain is outside the workspace's trusted list — flag it so
// agents treat links/attachments with more care (QA 07-27 #4). Amber, not red:
// external ≠ malicious, it just deserves a second look.
export function ExternalChip() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-300"
      title="The requester's email domain is outside this workspace's trusted domains (Settings → Ticket Ops → Trusted domains)"
    >
      <Globe className="w-3 h-3" aria-hidden="true" />
      External
    </span>
  );
}

export function OriginChip({ origin }) {
  if (origin === 'ticketpulse') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-50 text-sky-700 border border-sky-200">
        <TicketIcon className="w-3 h-3" aria-hidden="true" />
        Ticket Pulse
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
      FreshService
    </span>
  );
}

// How the current assignee got there: self-pickup, AI auto-assign, a manual
// assignment in FreshService, or a manual assignment by a coordinator in TP.
// Best-effort from assignedBy/isSelfPicked/origin (mirrors analyticsService's
// assignmentSource classification). Renders nothing when unassigned.
export function assignmentProvenance(ticket) {
  if (!ticket?.assignedTechId) return null;
  const by = String(ticket.assignedBy || '').trim();
  const name = ticket.assignedTech?.name || '';
  if (ticket.isSelfPicked || (by && name && by === name)) {
    return { key: 'self', label: 'Self-assigned', Icon: UserRound, cls: 'bg-slate-100 text-slate-600 border-slate-200', title: `${name || 'The assignee'} picked this ticket up` };
  }
  if (by === 'Ticket Pulse') {
    return { key: 'ai', label: 'AI-assigned', Icon: Sparkles, cls: 'bg-indigo-50 text-indigo-700 border-indigo-200', title: 'Auto-assigned by the Ticket Pulse AI pipeline' };
  }
  if (ticket.origin !== 'ticketpulse' && !by) {
    return { key: 'fs', label: 'Assigned in FreshService', Icon: Cloud, cls: 'bg-sky-50 text-sky-700 border-sky-200', title: 'This assignment came from FreshService' };
  }
  if (by) {
    return { key: 'manual', label: `Assigned by ${by}`, Icon: UserCog, cls: 'bg-blue-50 text-blue-700 border-blue-200', title: `Manually assigned by ${by}` };
  }
  return null;
}

export function ProvenanceChip({ ticket, iconOnly = false }) {
  const p = assignmentProvenance(ticket);
  if (!p) return null;
  const { label, Icon, cls, title } = p;
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cls}`}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {!iconOnly && label}
    </span>
  );
}

/** Fallback-mirror state for TP-born tickets. */
export function MirrorChip({ ticket }) {
  if (ticket?.origin !== 'ticketpulse') return null;
  const state = ticket.mirrorState;
  if (state === 'mirrored') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200" title="A fallback copy exists in FreshService">
        <Cloud className="w-3 h-3" aria-hidden="true" /> Mirrored
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-700 border border-red-200" title={ticket.mirrorError || 'Mirroring to FreshService failed'}>
        <CloudOff className="w-3 h-3" aria-hidden="true" /> Mirror error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-50 text-slate-500 border border-slate-200" title="Queued for the FreshService fallback mirror (arrives with the mirror phase)">
      <CloudUpload className="w-3 h-3" aria-hidden="true" /> Mirror pending
    </span>
  );
}

/**
 * "Empty seat" marker: unassigned should pull the eye, not read as body text.
 * Amber dashed ring + UserPlus glyph, optional label.
 */
// Unassigned indicator. Two moods, driven by whether assignment is actionable here:
//  - 'interactive' (default): reads as a call-to-action ("Assign"), neutral slate
//    that warms to blue on the parent's hover (the picker button carries `group`).
//  - 'muted': a quiet, passive "Unassigned" for read-only rows (e.g. FS-born in the
//    queue) where you can't assign inline — no hover, dimmer, clearly non-actionable.
// Deliberately not amber: in an all-unassigned view the old yellow pill on every row
// was noisy and repetitive.
export function UnassignedBadge({ size = 'h-6 w-6', withLabel = true, labelClass = 'text-xs', variant = 'interactive' }) {
  const muted = variant === 'muted';
  return (
    <span
      className="inline-flex items-center gap-1.5 min-w-0"
      title={muted ? 'Unassigned — managed in FreshService' : 'Unassigned — click to assign'}
    >
      <span
        aria-hidden="true"
        className={`${size} rounded-full border-[1.5px] border-dashed inline-flex items-center justify-center flex-shrink-0 transition-colors ${
          muted
            ? 'border-slate-300 text-slate-300'
            : 'border-slate-300 text-slate-400 group-hover:border-blue-400 group-hover:text-blue-500'
        }`}
      >
        <UserPlus className="w-3 h-3" strokeWidth={2.2} />
      </span>
      {withLabel
        ? (
          <span className={`${labelClass} font-medium truncate ${muted ? 'text-slate-400' : 'text-slate-500 group-hover:text-blue-600'}`}>
            {muted ? 'Unassigned' : 'Assign'}
          </span>
        )
        : <span className="sr-only">Unassigned</span>}
    </span>
  );
}

export function PersonAvatar({ name, photoUrl, size = 'h-6 w-6', textSize = 'text-[10px]' }) {
  if (photoUrl) {
    return <img src={photoUrl} alt="" className={`${size} rounded-full object-cover ring-1 ring-slate-200`} />;
  }
  if (!name) {
    return (
      <span className={`${size} rounded-full bg-slate-100 text-slate-400 inline-flex items-center justify-center`}>
        <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`${size} rounded-full bg-blue-50 text-blue-700 border border-blue-100 inline-flex items-center justify-center font-semibold ${textSize}`}>
      {initials(name)}
    </span>
  );
}

// ── Ticket reference link ─────────────────────────────────────────────────────
// The in-app /tickets/:id page is the PRIMARY destination (migration off
// FreshService); FS is kept one click away as a small external icon, and is the
// only target when there's no internal id. Ref label mirrors the server's
// ticketDisplayRef rule (TP-<n> for TP-born, #<fsId> otherwise).

export function ticketRefLabel(ticket) {
  if (!ticket) return '—';
  if (ticket.origin === 'ticketpulse' && ticket.nativeNumber !== null && ticket.nativeNumber !== undefined) {
    return `TP-${ticket.nativeNumber}`;
  }
  if (ticket.freshserviceTicketId) return `#${ticket.freshserviceTicketId}`;
  return ticket.id ? `TP-ID-${ticket.id}` : '—';
}

export function ticketFsUrl(ticket) {
  return ticket?.freshserviceTicketId
    ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;
}

export function TicketRefLink({
  ticket,
  label,
  className = 'text-[11px]',
  linkClassName = 'font-medium text-blue-600 hover:text-blue-800',
  showFsIcon = true,
  iconClassName = 'h-2.5 w-2.5',
  onNavigate,
  // Optional router location state passed to the internal link — lets origin
  // pages (e.g. the agent page) hand /tickets/:id a `{ from }` return address.
  state,
}) {
  const internalHref = ticket?.id ? `/tickets/${ticket.id}` : null;
  const fsUrl = ticketFsUrl(ticket);
  const text = label ?? ticketRefLabel(ticket);
  const stop = (e) => { e.stopPropagation(); onNavigate?.(); };
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {internalHref ? (
        <Link to={internalHref} state={state} title="Open in Ticket Pulse" className={`min-w-0 truncate ${linkClassName}`} onClick={stop}>
          {text}
        </Link>
      ) : (
        <a href={fsUrl || '#'} target="_blank" rel="noopener noreferrer" className={`min-w-0 truncate ${linkClassName}`} onClick={(e) => e.stopPropagation()}>
          {text}
        </a>
      )}
      {showFsIcon && fsUrl && internalHref && (
        <a
          href={fsUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in FreshService"
          className="flex-shrink-0 text-blue-300 hover:text-blue-600"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className={iconClassName} aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
