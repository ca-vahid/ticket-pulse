import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Ban, CheckCircle2, Clock, XCircle,
  Loader2, Check, X, MessageCircleQuestion, Inbox, RotateCcw, ClipboardList, Tags, ArrowUpRight, Forward,
  Search, Download, UserRound, Ticket, Flag, ChevronDown, ChevronUp, Tag,
} from 'lucide-react';
import { AmountChip, TierChip } from '../components/tickets/ApprovalHandoff';
import ApprovalComposer, { ConfirmSheet } from '../components/tickets/ApprovalComposer';
import ApprovalTicketBrief from '../components/approvals/ApprovalTicketBrief';
import { groupApprovals, splitImageRefs } from '../utils/approvalBrief';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import ApprovalCategoriesPanel from '../components/settings/ApprovalCategoriesPanel';
import FancySelect from '../components/common/FancySelect';
import WhenFilter, { resolveWhen } from '../components/common/WhenFilter';
import { ticketsAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { useRequesterPhoto } from '../hooks/useRequesterPhoto';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { BrandArt, PersonAvatar, formatDayTime, timeAgo } from '../components/tickets/ticketUi';
import { motionReduced } from '../utils/motionPreference';
import { cleanNoteText } from '../utils/noteText';

/**
 * Approvals (QA 09-16 #4 redesign; density pass 20 Sep 2026, "A1 + B1"): an
 * illustrated inbox that matches the rest of the app — status art per row,
 * people with photos in their own column, one Decide button (ask / escalate /
 * forward live inside it), the ticket as an icon after the title. Reviewers
 * get a real filter bar: text, a status menu (several at once), category,
 * approver, requester, one When control (presets + calendar), sort, CSV.
 *
 * Every tab has its own URL (/approvals, /approvals/all, /approvals/categories)
 * and the All-approvals filters live in the query string, so F5 and shared
 * links land where you were.
 */
const STATUS_META = {
  pending: { label: 'Pending', art: 'approval-waiting', dot: 'bg-amber-500' },
  info_requested: { label: 'Needs info', art: 'approval-question', dot: 'bg-violet-500' },
  approved: { label: 'Approved', art: 'approval-stamp', dot: 'bg-emerald-500' },
  rejected: { label: 'Not approved', art: 'approval-rejected', dot: 'bg-red-500' },
  cancelled: { label: 'Cancelled', art: 'approval-cancelled', dot: 'bg-muted-foreground/50' },
  escalated: { label: 'Escalated', art: 'approval-escalate', dot: 'bg-amber-500' },
  forwarded: { label: 'Forwarded', art: 'approval-forward', dot: 'bg-blue-500' },
};
// Status as a glyph and coloured words — no pills, no stamp clip-art (Vahid, 18 Sep 2026).
const STATUS_ICON = {
  pending: { Icon: Clock, text: 'text-amber-700 dark:text-amber-300', soft: 'bg-amber-50 dark:bg-amber-500/15' },
  info_requested: { Icon: MessageCircleQuestion, text: 'text-violet-700 dark:text-violet-300', soft: 'bg-violet-50 dark:bg-violet-500/15' },
  approved: { Icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300', soft: 'bg-emerald-50 dark:bg-emerald-500/15' },
  rejected: { Icon: XCircle, text: 'text-red-700 dark:text-red-300', soft: 'bg-red-50 dark:bg-red-500/15' },
  cancelled: { Icon: Ban, text: 'text-muted-foreground', soft: 'bg-muted' },
  escalated: { Icon: ArrowUpRight, text: 'text-amber-700 dark:text-amber-300', soft: 'bg-amber-50 dark:bg-amber-500/15' },
  forwarded: { Icon: Forward, text: 'text-blue-700 dark:text-blue-300', soft: 'bg-blue-50 dark:bg-blue-500/15' },
};
function StatusGlyph({ status, size = 'h-9 w-9', icon = 'h-[18px] w-[18px]' }) {
  // The layered-glass set (Vahid's pick, 18 Sep 2026), kept small. Statuses without
  // artwork (cancelled) fall back to a quiet glyph in a soft circle.
  const art = STATUS_META[status]?.art;
  if (art) return <BrandArt name={art} className={`${size} flex-shrink-0`} />;
  const m = STATUS_ICON[status] || STATUS_ICON.cancelled;
  return <span className={`inline-flex ${size} flex-shrink-0 items-center justify-center rounded-full ${m.soft}`} aria-hidden="true"><m.Icon className={`${icon} ${m.text}`} /></span>;
}

/** "snasiri@…" → "Snasiri" — only ever a fallback; the server fills real names. */
const prettyName = (email) => (email ? String(email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—');
const lower = (v) => String(v || '').trim().toLowerCase();

/** Inline mention: small avatar + name, for "Neville asks …" in a sentence. */
function InlinePerson({ name, email }) {
  const photo = useRequesterPhoto(email);
  const shown = name || prettyName(email);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap align-middle" title={email || undefined}>
      <PersonAvatar name={shown} photoUrl={photo} size="h-4 w-4" textSize="text-[7px]" />
      <span className="font-medium text-foreground/85">{shown}</span>
    </span>
  );
}

function PersonOption({ person, active, onPick }) {
  const photo = useRequesterPhoto(person.photoUrl ? null : person.email);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(person)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${active ? 'bg-blue-50 dark:bg-blue-500/15' : 'hover:bg-muted'}`}
    >
      <PersonAvatar name={person.name} photoUrl={person.photoUrl || photo} size="h-7 w-7" textSize="text-[9px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{person.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{person.email}</span>
      </span>
    </button>
  );
}

/**
 * Filter-by-person: type a name to narrow, pick from the list, or leave free
 * text (the server matches it against names and addresses). A picked person
 * shows as avatar + name with one click to clear.
 */
function PersonFilter({ id, label, value, onChange, people, placeholder = 'Anyone' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const key = lower(value);
  const selected = key ? people.find((p) => p.email === key) || null : null;
  const selectedPhoto = useRequesterPhoto(selected && !selected.photoUrl ? selected.email : null);
  const matches = useMemo(() => {
    const q = key;
    return people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.includes(q)).slice(0, 8);
  }, [people, key]);
  useEffect(() => { setActive(0); }, [key]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (p) => { onChange(p.email); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(matches.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); pick(matches[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };
  const listId = `${id}-list`;

  return (
    <div ref={rootRef} className="relative min-w-0">
      {selected ? (
        <div className="flex h-9 items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 pl-1.5 pr-1 text-sm dark:border-blue-500/40 dark:bg-blue-500/15">
          <span className="sr-only">{label}:</span>
          <PersonAvatar name={selected.name} photoUrl={selected.photoUrl || selectedPhoto} size="h-6 w-6" textSize="text-[8px]" />
          <span className="min-w-0 flex-1 truncate font-medium text-blue-900 dark:text-blue-100" title={selected.email}>{selected.name}</span>
          <button type="button" onClick={() => onChange('')} aria-label={`Clear ${label.toLowerCase()} filter`} className="tp-focus-ring rounded-md p-1 text-blue-700 hover:bg-blue-100 dark:text-blue-200 dark:hover:bg-blue-500/20">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <>
          <label htmlFor={id} className="sr-only">{label}</label>
          <UserRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            value={value}
            onChange={(e) => { onChange(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card pl-8 pr-2.5 text-sm text-foreground placeholder:text-muted-foreground/75"
          />
        </>
      )}
      {open && !selected && matches.length > 0 && (
        <div id={listId} role="listbox" aria-label={`${label} suggestions`} className="tp-card absolute left-0 top-full z-30 mt-1 w-64 rounded-xl p-1 shadow-soft animate-popIn">
          {matches.map((p, i) => <PersonOption key={p.email} person={p} active={i === active} onPick={pick} />)}
        </div>
      )}
    </div>
  );
}

const STAT_TILES = [
  { key: 'pending', label: 'Pending', color: 'text-amber-600 dark:text-amber-300' },
  { key: 'info_requested', label: 'Needs info', color: 'text-violet-600 dark:text-violet-300' },
  { key: 'approved', label: 'Approved', color: 'text-emerald-600 dark:text-emerald-300' },
  { key: 'rejected', label: 'Not approved', color: 'text-red-600 dark:text-red-300' },
  { key: 'cancelled', label: 'Cancelled', color: 'text-muted-foreground' },
];
const splitStatuses = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Status menu: several at once ("Approved and Not approved"), counts beside each. */
function StatusFilter({ value, onChange, stats }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const chosen = splitStatuses(value);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const toggle = (k) => onChange((chosen.includes(k) ? chosen.filter((x) => x !== k) : [...chosen, k]).join(','));
  const label = chosen.length === 0 ? 'Any status' : chosen.length === 1 ? STATUS_META[chosen[0]]?.label || chosen[0] : `${chosen.length} statuses`;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Status: ${label}`}
        className={`tp-focus-ring inline-flex h-9 w-full items-center gap-1.5 rounded-lg border px-2.5 text-sm ${chosen.length ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200' : 'border-input bg-card text-foreground'}`}
      >
        <Flag className={`h-3.5 w-3.5 flex-shrink-0 ${chosen.length ? '' : 'text-muted-foreground/75'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" aria-hidden="true" />
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" aria-label="Status" className="tp-card absolute left-0 top-full z-30 mt-1 w-52 rounded-xl p-1.5 shadow-soft animate-popIn">
          {STAT_TILES.map(({ key, label: l }) => {
            const on = chosen.includes(key);
            return (
              <button key={key} type="button" role="option" aria-selected={on} onClick={() => toggle(key)} className={`tp-focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] ${on ? 'text-foreground' : 'text-foreground/85 hover:bg-muted'}`}>
                <span className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${on ? 'border-blue-600 bg-blue-600 text-white' : 'border-input bg-card'}`} aria-hidden="true">{on && <Check className="h-3 w-3" />}</span>
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_META[key].dot}`} aria-hidden="true" />
                <span className="flex-1">{l}</span>
                <span className="text-xs tabular-nums text-muted-foreground/75">{stats?.[key] ?? 0}</span>
              </button>
            );
          })}
          <button type="button" onClick={() => { onChange(''); setOpen(false); }} disabled={!chosen.length} className="tp-focus-ring mt-1 flex w-full items-center rounded-lg border-t border-border/60 px-2 pb-1 pt-2 text-xs font-semibold text-blue-700 hover:underline disabled:text-muted-foreground/60 disabled:no-underline dark:text-blue-200">Clear</button>
        </div>
      )}
    </div>
  );
}

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'By status' },
];
const EMPTY_FILTERS = { q: '', status: '', categoryId: '', approver: '', requestedBy: '', when: '', sort: 'newest' };
const FILTER_KEYS = Object.keys(EMPTY_FILTERS);

const TABS = ['mine', 'all', 'categories'];
const tabPath = (k) => (k === 'mine' ? '/approvals' : `/approvals/${k}`);
/** /approvals/all → 'all'; the pre-URL ?tab= deep link is still honoured (and redirected). */
function tabFromLocation(location) {
  const seg = location.pathname.replace(/^\/approvals\/?/, '').split('/')[0];
  if (TABS.includes(seg)) return seg;
  const legacy = new URLSearchParams(location.search).get('tab');
  return TABS.includes(legacy) ? legacy : 'mine';
}
function filtersFromParams(sp) {
  const f = { ...EMPTY_FILTERS };
  for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) f[k] = v; }
  // Links from before the When control carried from / to.
  if (!f.when && (sp.get('from') || sp.get('to'))) f.when = `${sp.get('from') || sp.get('to')}..${sp.get('to') || sp.get('from')}`;
  if (!SORT_OPTIONS.some((o) => o.value === f.sort)) f.sort = 'newest';
  return f;
}
function paramsFromFilters(f) {
  const sp = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = String(f[k] || '').trim();
    if (v && !(k === 'sort' && v === 'newest')) sp.set(k, v);
  }
  return sp;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ticket as an icon after the title: opens /tickets/:id on its Approvals tab. */
const TicketIcon = ({ a, state }) => (
  <Link
    to={`/tickets/${a.ticketId}?tab=approvals`}
    state={state}
    title={`Open ${a.displayRef}`}
    aria-label={`Open ticket ${a.displayRef}`}
    className="tp-focus-ring inline-flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25"
  >
    <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>
);
const Dot = () => <span className="text-muted-foreground/40" aria-hidden="true">·</span>;

/*
 * Option A rows (Vahid, 7 Oct 2026): the request reads at full size, the
 * people collapse into one quiet sentence, and opening a row shows the ticket
 * beside the decision — no more clicking through to the ticket for context.
 */

/** The ticket number as a quiet link after the subject. */
const TicketRef = ({ a, state }) => (
  <Link
    to={`/tickets/${a.ticketId}?tab=approvals`}
    state={state}
    title={`Open ${a.displayRef}`}
    aria-label={`Open ticket ${a.displayRef}`}
    className="tp-focus-ring flex-shrink-0 rounded font-mono text-[12px] text-primary hover:underline"
  >
    {a.displayRef}
  </Link>
);

/** "Marcus Blackstock asks for Seifeddine Reguige · approver Vahid Haeri" */
function PeopleLine({ a, withApprover = false, approvers = null, approverLabel = null, className = '' }) {
  const shownApprovers = approvers || (a.approverName || a.approverEmail ? [{ name: a.approverName, email: a.approverEmail }] : []);
  const byEmail = lower(a.requestedBy);
  const forEmail = lower(a.requesterEmail);
  const self = byEmail && forEmail && byEmail === forEmail;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground ${className}`} data-testid="approval-people">
      <InlinePerson name={a.requestedByName} email={a.requestedBy} />
      {self || !(a.requesterName || a.requesterEmail)
        ? <span>asks</span>
        : <><span>asks for</span><InlinePerson name={a.requesterName} email={a.requesterEmail} /></>}
      {withApprover && shownApprovers.length > 0 && (
        <>
          <Dot />
          <span>{approverLabel || (shownApprovers.length > 1 ? 'approvers' : 'approver')}</span>
          {shownApprovers.map((p, i) => (
            <span key={p.email || i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground/60">or</span>}
              <InlinePerson name={p.name} email={p.email} />
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The approval category is what the approver is deciding about (Vahid, 7 Oct
 * 2026: "one of the most important things") — its own line above the title,
 * in the accent colour, not a grey suffix.
 */
function CategoryLine({ name, className = '' }) {
  if (!name) return null;
  return (
    <div className={`mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-primary ${className}`} data-testid="approval-category">
      <Tag className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="[overflow-wrap:anywhere]">{name}</span>
    </div>
  );
}

/**
 * Opening and closing a row glides (grid-rows 0fr ↔ 1fr) instead of snapping;
 * the content stays mounted until it has closed. Off under the motion setting.
 */
function Collapse({ open, children }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    }
    setShown(false);
    if (motionReduced()) { setMounted(false); return undefined; }
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-off:transition-none ${shown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Who the people line names as approver(s) for a grouped row. */
function groupApprovers(g) {
  const a = g.primary;
  if (a.status === 'approved') return { label: 'approved by', list: [{ name: a.approverName, email: a.approverEmail }] };
  if (a.status === 'rejected') return { label: 'not approved by', list: [{ name: a.approverName, email: a.approverEmail }] };
  const open = g.members.filter((m) => ['pending', 'info_requested'].includes(m.status));
  const list = (open.length ? open : g.members).map((m) => ({ name: m.approverName, email: m.approverEmail }));
  const seen = new Set();
  return { label: null, list: list.filter((p) => { const k = lower(p.email); if (seen.has(k)) return false; seen.add(k); return true; }) };
}

/**
 * The status as its own column beside the row (Vahid, 7 Oct 2026): the plain
 * icon with the word under it, in the status colour — not squeezed into the
 * title line.
 */
function StatusBlock({ status }) {
  const meta = STATUS_META[status] || {};
  const ic = STATUS_ICON[status] || STATUS_ICON.cancelled;
  return (
    <div className="flex w-[4.5rem] flex-shrink-0 flex-col items-center gap-1 pt-0.5 text-center" data-testid="approval-status">
      <StatusGlyph status={status} size="h-8 w-8" />
      <span className={`text-[11.5px] font-semibold leading-tight ${ic.text}`}>{meta.label || status}</span>
    </div>
  );
}

/** Whole-card click / Enter / Space opens a row — but not from its own links and buttons. */
const rowToggleProps = (isOpen, toggle, label) => ({
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

/** The request at reading size, two lines, pictures counted rather than named. */
function RequestLine({ note, muted = false, className = 'mt-2.5' }) {
  const { text, names } = splitImageRefs(cleanNoteText(note || ''));
  if (!text && !names.length) return null;
  return (
    <p className={`${className} line-clamp-2 text-[14px] leading-relaxed [overflow-wrap:anywhere] ${muted ? 'text-foreground/70' : 'text-foreground/90'}`} data-testid="approval-request">
      {text && <>&ldquo;{text}&rdquo;</>}
      {names.length > 0 && <span className="text-muted-foreground">{text ? ' · ' : ''}{names.length === 1 ? '1 picture' : `${names.length} pictures`}</span>}
    </p>
  );
}

/** What happened to a decided approval, for the opened All-approvals row. */
function DecisionRecord({ a, members = null }) {
  const others = (members || []).filter((m) => m.id !== a.id);
  const m = STATUS_ICON[a.status] || STATUS_ICON.cancelled;
  const label = STATUS_META[a.status]?.label || a.status;
  const note = cleanNoteText(a.decisionNote || '');
  const condition = cleanNoteText(a.conditionNote || '');
  return (
    <div className="min-w-0 space-y-2" data-testid="approval-decision-record">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Decision</div>
      <p className={`text-[14px] font-semibold ${m.text}`}>{label}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {a.status === 'pending' || a.status === 'info_requested' ? 'Waiting on' : 'Decided by'}
        <InlinePerson name={a.approverName} email={a.approverEmail} />
        {(a.status === 'pending' || a.status === 'info_requested') && others.filter((m) => m.status === a.status).map((m) => (
          <span key={m.id} className="inline-flex items-center gap-1.5"><span className="text-muted-foreground/60">or</span><InlinePerson name={m.approverName} email={m.approverEmail} /></span>
        ))}
      </p>
      <p className="text-[12px] text-muted-foreground">
        {a.decidedAt ? `${formatDayTime(a.decidedAt)} · ${timeAgo(a.decidedAt)}` : `Asked ${formatDayTime(a.createdAt)} · waiting`}
        {a.decidedVia ? ` · by ${a.decidedVia === 'email' ? 'e-mail' : a.decidedVia}` : ''}
      </p>
      {condition && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
          <span className="font-semibold">Condition: </span>{condition}
        </div>
      )}
      {note && <p className="whitespace-pre-line text-[13px] leading-relaxed text-foreground/85 [overflow-wrap:anywhere]">&ldquo;{note}&rdquo;</p>}
      {(a.amount != null || a.tierCount > 1) && (
        <div className="flex flex-wrap items-center gap-2">
          <AmountChip amount={a.amount} currency={a.amountCurrency} className="!text-xs" />
          {a.tierCount > 1 && <TierChip tier={a.tier} tierName={a.tierName} tierCount={a.tierCount} className="!text-[11px]" />}
        </div>
      )}
    </div>
  );
}
/**
 * The note on a row: one truncated line at rest, the whole text on click
 * (Vahid, 21 Sep 2026: an approver had no way to read the full request in
 * the UI). Short notes are plain text; anything that could be cut gets the
 * More / Less control.
 */
function RowNote({ note: rawNote, open, onToggle, muted = false }) {
  // Stored notes could carry "&nbsp;" and friends (23 Sep 2026) — read as text.
  const note = cleanNoteText(rawNote);
  if (!note) return null;
  const long = note.length > 60;
  if (!long) return <span className={`min-w-0 truncate ${muted ? 'text-muted-foreground/60' : ''}`}>“{note}”</span>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Show less' : 'Show the whole note'}
      className={`tp-focus-ring group/note flex min-w-0 items-start gap-1 rounded text-left hover:text-foreground/85 ${open ? '' : 'items-center'}`}
    >
      <span className={`min-w-0 ${open ? 'whitespace-pre-line' : 'truncate'}`}>“{note}”</span>
      <span className="inline-flex flex-shrink-0 items-center gap-0.5 text-[11px] font-medium text-blue-700 group-hover/note:underline dark:text-blue-200">
        {open ? <>Less <ChevronUp className="h-3 w-3" aria-hidden="true" /></> : <>More <ChevronDown className="h-3 w-3" aria-hidden="true" /></>}
      </span>
    </button>
  );
}
const When = ({ at, className = '' }) => (
  <span className={`whitespace-nowrap text-[11px] text-muted-foreground/75 ${className}`} title={new Date(at).toLocaleString()}>
    <span className="hidden sm:inline">{`${formatDayTime(at)} · ${timeAgo(at)}`}</span>
    <span className="sm:hidden">{timeAgo(at)}</span>
  </span>
);

export default function ApprovalsInbox() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Return address so /tickets/:id's Back control comes back to this inbox.
  const backState = { from: `${location.pathname}${location.search}` };
  const { currentWorkspace, isWorkspaceSelected } = useWorkspace();
  const { width: layoutWidth } = useLayoutWidth();
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  // mine | all | categories — from the URL. `categories` (v3.7.02, QA 08-24 #3)
  // is the reviewer's home for approval-category management now that Settings
  // is admin-only — same <ApprovalCategoriesPanel/> the admin sees in Settings.
  const view = tabFromLocation(location);
  const legacyTab = searchParams.get('tab');
  const [pending, setPending] = useState([]);
  const [needsInfo, setNeedsInfo] = useState([]);
  const [overview, setOverview] = useState(null); // { stats, items }
  const [filters, setFilters] = useState(() => filtersFromParams(searchParams));
  const [debouncedQ, setDebouncedQ] = useState(filters.q.trim());
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  // Filter changes refetch SILENTLY (a spinner replacing the filter bar while
  // you type lost focus and flashed) — a small inline indicator instead.
  const [refreshing, setRefreshing] = useState(false);
  const firstLoadDone = useRef(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  // Approvals v3: which row has the composer open; people load lazily for the forward picker.
  const [openId, setOpenId] = useState(null);
  // Quick approve (7 Oct 2026): the row's button approves without a note, after the usual confirm.
  const [quickId, setQuickId] = useState(null);
  const [people, setPeople] = useState(null);
  // Everyone seen on any approval so far (names + addresses) — feeds the
  // approver / requester pickers even when the current filter hides them.
  const seenPeople = useRef(new Map());

  // ?tab=all (the old deep link) → /approvals/all, other params kept.
  useEffect(() => {
    if (!TABS.includes(legacyTab)) return;
    const rest = new URLSearchParams(location.search);
    rest.delete('tab');
    const qs = rest.toString();
    navigate(`${tabPath(legacyTab)}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [legacyTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filters live in the URL while on All approvals, so F5 keeps them.
  useEffect(() => {
    if (view !== 'all' || legacyTab) return;
    const next = paramsFromFilters(filters);
    if (next.toString() !== new URLSearchParams(location.search).toString()) setSearchParams(next, { replace: true });
  }, [filters, view, legacyTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTab = (k) => {
    const qs = k === 'all' ? paramsFromFilters(filters).toString() : '';
    navigate(tabPath(k) + (qs ? `?${qs}` : ''));
  };

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 300); return () => clearTimeout(t); }, [filters.q]);

  const loadMeta = useCallback(async () => {
    if (meta) return meta;
    try {
      const res = await ticketsAPI.meta();
      const m = res?.data || res || null;
      setMeta(m);
      return m;
    } catch { return null; }
  }, [meta]);

  const openComposer = async (a) => {
    setOpenId(a.id);
    if (people === null) {
      const m = await loadMeta();
      const map = new Map();
      for (const t of [...(m?.technicians || []), ...(m?.members || [])]) {
        if (!t?.email) continue;
        const key = String(t.email).toLowerCase();
        if (!map.has(key)) map.set(key, { name: t.name || t.email, email: key, photoUrl: t.photoUrl || null, role: t.role || null });
      }
      setPeople([...map.values()].sort((x, y) => x.name.localeCompare(y.name)));
    }
  };

  const overviewParams = useMemo(() => {
    const p = {};
    if (filters.status) p.status = splitStatuses(filters.status).join(',');
    if (filters.categoryId) p.categoryId = filters.categoryId;
    if (debouncedQ) p.q = debouncedQ;
    if (filters.approver.trim()) p.approver = filters.approver.trim();
    if (filters.requestedBy.trim()) p.requestedBy = filters.requestedBy.trim();
    const when = resolveWhen(filters.when);
    if (when.from) p.from = when.from;
    if (when.to) p.to = when.to;
    if (filters.sort && filters.sort !== 'newest') p.sort = filters.sort;
    return p;
  }, [filters.status, filters.categoryId, debouncedQ, filters.approver, filters.requestedBy, filters.when, filters.sort]);
  const activeFilterCount = ['status', 'categoryId', 'q', 'approver', 'requestedBy', 'from'].filter((k) => overviewParams[k]).length;

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const tasks = [ticketsAPI.approvalInbox(), ticketsAPI.approvalsNeedingMyInfo()];
      if (canReview) tasks.push(ticketsAPI.approvalsOverview(overviewParams));
      const [inbox, mine, ov] = await Promise.all(tasks);
      setPending(inbox || []);
      setNeedsInfo(mine || []);
      if (canReview) setOverview(ov || null);
      setError(null);
      firstLoadDone.current = true;
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load approvals');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canReview, overviewParams]);

  useEffect(() => { if (isWorkspaceSelected) load({ silent: firstLoadDone.current }); }, [load, isWorkspaceSelected, currentWorkspace?.id]);
  useEffect(() => { if (canReview && view === 'all') loadMeta(); }, [canReview, view, loadMeta]);

  const onTicketChange = useCallback((data) => { if (data?.action === 'approval') load({ silent: true }); }, [load]);
  // reconnectKey: deterministic stream re-key on workspace switch (realtime
  // plan Phase 1) — the context-subscribed id, not a render-time module read.
  useSSE({ onTicketChange, enabled: Boolean(isWorkspaceSelected), reconnectKey: currentWorkspace?.id });

  const act = async (fn, id) => {
    setBusyId(id); setError(null);
    try { await fn(); await load({ silent: true }); }
    catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setBusyId(null); }
  };

  const resubmit = (a) => act(() => ticketsAPI.resubmitApproval(a.ticketId, a.id), a.id);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleStatus = (k) => { const cur = splitStatuses(filters.status); setFilter({ status: (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]).join(',') }); };
  const toggleExpanded = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const exportCsv = () => {
    const rows = overview?.items || [];
    const header = ['Status', 'Category', 'Ticket', 'Subject', 'Approver', 'Approver e-mail', 'Requested by', 'Amount', 'Tier', 'Requested at', 'Decided at', 'Decision note', 'Condition'];
    const lines = [header.join(',')].concat(rows.map((a) => [
      STATUS_META[a.status]?.label || a.status, a.categoryName, a.displayRef, a.subject, a.approverName, a.approverEmail, a.requestedBy,
      a.amountLabel || '', a.tierName, a.createdAt ? new Date(a.createdAt).toISOString() : '', a.decidedAt ? new Date(a.decidedAt).toISOString() : '',
      a.decisionNote, a.conditionNote,
    ].map(csvEscape).join(',')));
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `approvals-${currentWorkspace?.name || 'workspace'}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const categoryOptions = useMemo(() => [
    { value: '', label: 'All categories' },
    ...((meta?.approvalCategories || []).map((c) => ({ value: c.id, label: c.name }))),
  ], [meta]);

  // Workspace members + everyone who has appeared on an approval, by address.
  const personOptions = useMemo(() => {
    const map = seenPeople.current;
    const add = (name, email, photoUrl = null) => {
      const key = lower(email);
      if (!key || !key.includes('@')) return;
      const cur = map.get(key);
      if (!cur) map.set(key, { name: name || prettyName(key), email: key, photoUrl });
      else { if (!cur.photoUrl && photoUrl) cur.photoUrl = photoUrl; if (name && cur.name === prettyName(key)) cur.name = name; }
    };
    for (const t of [...(meta?.technicians || []), ...(meta?.members || [])]) add(t.name, t.email, t.photoUrl);
    for (const a of [...(overview?.items || []), ...pending, ...needsInfo]) { add(a.approverName, a.approverEmail); add(a.requestedByName, a.requestedBy); add(a.requesterName, a.requesterEmail); }
    return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [meta, overview, pending, needsInfo]);

  const chosenStatuses = splitStatuses(filters.status);

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[58px]">
      <AppHeader activePage="approvals" />
      <main className={applyWidth('max-w-5xl mx-auto px-4 sm:px-6 py-5 pb-24 lg:pb-6 animate-fadeIn', layoutWidth)}>
        {/* Hero — small, one line */}
        <div className="tp-card tp-ticket-header relative mb-4 flex items-center gap-3 rounded-2xl px-4 py-3">
          <span className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 shadow-subtle ring-1 ring-blue-100 dark:bg-blue-500/15 dark:ring-blue-500/20">
            <BrandArt name="approval-inbox" className="h-8 w-8" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-6 text-foreground">Approvals</h1>
            <p className="truncate text-[13px] text-muted-foreground">Requests awaiting your decision, and your requests that need more info. A Ticket Pulse feature — not synced to FreshService.</p>
          </div>
          {canReview && overview?.stats && (
            <div className="ml-auto hidden items-center gap-4 pl-4 text-xs font-semibold text-foreground/85 sm:flex">
              {[['pending', 'waiting'], ['info_requested', 'need info']].map(([k, word]) => (
                <span key={k} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_META[k].dot}`} />
                  {overview.stats[k] ?? 0} {word}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Reviewer/admin tabs: my inbox vs. everything in the workspace vs. categories — each its own URL */}
        {canReview && (
          <div role="tablist" className="mb-4 flex items-end gap-1 border-b border-border">
            {[
              { k: 'mine', label: 'For you', Icon: Inbox },
              { k: 'all', label: 'All approvals', Icon: ClipboardList },
              { k: 'categories', label: 'Categories', Icon: Tags },
            ].map(({ k, label, Icon }) => (
              <Link
                key={k}
                role="tab"
                to={tabPath(k)}
                aria-selected={view === k}
                onClick={(e) => { e.preventDefault(); goTab(k); }}
                className={`tp-focus-ring relative -mb-px inline-flex items-center gap-1.5 rounded-t-lg border px-3.5 py-2 text-sm font-semibold transition-colors ${
                  view === k ? 'border-border border-b-card bg-card text-emerald-700 dark:text-emerald-200' : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground/85'
                }`}
              >
                {view === k && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-emerald-600" aria-hidden="true" />}
                <Icon className="h-4 w-4" aria-hidden="true" /> {label}
              </Link>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200">
            <X className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
          </div>
        )}

        {view === 'categories' && canReview ? (
          <section aria-label="Approval categories" className="animate-fadeIn">
            <ApprovalCategoriesPanel />
          </section>
        ) : loading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground/75"><Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /></div>
        ) : view === 'all' && canReview ? (
          <div className="space-y-3" data-testid="approvals-all">
            {/* Status strip = counts at a glance and one-click toggles (several may be on). */}
            <div role="group" aria-label="Approvals by status" className="tp-card flex divide-x divide-border/70 overflow-hidden rounded-xl">
              {STAT_TILES.map(({ key, label, color }) => {
                const active = chosenStatuses.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleStatus(key)}
                    aria-pressed={active}
                    className={`tp-focus-ring relative flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors ${active ? 'bg-muted/70' : 'hover:bg-muted/40'}`}
                  >
                    <StatusGlyph status={key} size="h-7 w-7" icon="h-3.5 w-3.5" />
                    <span className={`text-lg font-bold leading-none tabular-nums ${color}`}>{overview?.stats?.[key] ?? 0}</span>
                    <span className="hidden truncate text-xs font-medium text-muted-foreground sm:inline">{label}</span>
                    {active && <span className={`absolute inset-x-0 bottom-0 h-0.5 ${STATUS_META[key].dot}`} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>

            {/* Filter bar — everything in one row, nothing behind "More filters" */}
            <div className="tp-card rounded-xl p-2.5" data-testid="approvals-filters">
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
                  <input
                    type="text"
                    value={filters.q}
                    onChange={(e) => setFilter({ q: e.target.value })}
                    placeholder="Search subject, note, TP-1234 or #242054…"
                    aria-label="Search approvals"
                    className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground/75"
                  />
                </label>
                <div className="w-36">
                  <StatusFilter value={filters.status} onChange={(v) => setFilter({ status: v })} stats={overview?.stats} />
                </div>
                <div className="w-44">
                  <FancySelect value={filters.categoryId} onChange={(v) => setFilter({ categoryId: v })} options={categoryOptions} aria-label="Approval category" />
                </div>
                <div className="w-40">
                  <PersonFilter id="ap-f-approver" label="Approver" placeholder="Any approver" value={filters.approver} onChange={(v) => setFilter({ approver: v })} people={personOptions} />
                </div>
                <div className="w-40">
                  <PersonFilter id="ap-f-requested-by" label="Requested by" placeholder="Any requester" value={filters.requestedBy} onChange={(v) => setFilter({ requestedBy: v })} people={personOptions} />
                </div>
                <WhenFilter className="w-40" value={filters.when} onChange={(v) => setFilter({ when: v })} />
                <div className="w-36">
                  <FancySelect value={filters.sort} onChange={(v) => setFilter({ sort: v })} options={SORT_OPTIONS} aria-label="Sort approvals" />
                </div>
                {refreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" aria-label="Updating" />}
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={!(overview?.items?.length)}
                  title="Download the rows below as CSV"
                  className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-muted-foreground hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:hover:border-blue-500/40 dark:hover:text-blue-200"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export CSV
                </button>
              </div>
              {activeFilterCount > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{groupApprovals(overview?.items || []).length} request{groupApprovals(overview?.items || []).length === 1 ? '' : 's'} match</span>
                  <button onClick={() => setFilters(EMPTY_FILTERS)} className="tp-focus-ring inline-flex items-center gap-1 rounded text-blue-700 hover:underline dark:text-blue-200">
                    <X className="h-3 w-3" aria-hidden="true" /> Clear filters
                  </button>
                </div>
              )}
            </div>

            {/* All approvals list / history — two lines per row */}
            {(overview?.items?.length || 0) === 0 ? (
              <div className="tp-card rounded-xl p-10 text-center">
                <BrandArt name="approval-inbox" className="mx-auto mb-3 h-12 w-12 opacity-80" />
                <p className="text-sm font-medium text-foreground/85">No approvals{chosenStatuses.length === 1 ? ` with status “${STATUS_META[chosenStatuses[0]]?.label}”` : ''}{activeFilterCount ? ' match these filters' : ' yet'}.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {groupApprovals(overview.items).map((g) => {
                  const a = g.primary;
                  const who = groupApprovers(g);
                  const isOpen = expanded.has(a.id);
                  const decided = cleanNoteText(a.decisionNote || a.conditionNote || '');
                  return (
                    <li key={g.key} className="tp-card overflow-hidden rounded-xl transition-shadow hover:shadow-subtle" data-testid="approval-row">
                      <div {...rowToggleProps(isOpen, () => toggleExpanded(a.id), `${isOpen ? 'Close' : 'Open'} ${a.subject || 'approval'}`)} className="tp-focus-ring flex cursor-pointer gap-4 px-4 py-4 hover:bg-muted/25">
                        <StatusBlock status={a.status} />
                        <div className="min-w-0 flex-1">
                          <CategoryLine name={a.categoryName} />
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                            <span className="min-w-0 text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">{a.subject || '(no subject)'}</span>
                            <TicketRef a={a} state={backState} />
                          </div>
                          <PeopleLine a={a} withApprover approvers={who.list} approverLabel={who.label} className="mt-2" />
                          {!isOpen && <RequestLine note={a.requestNote} muted={!['pending', 'info_requested'].includes(a.status)} />}
                          {!isOpen && decided && (
                            <p className="mt-1.5 truncate text-[12.5px] text-muted-foreground">
                              <span className="font-medium text-foreground/75">{(a.approverName || prettyName(a.approverEmail)).split(' ')[0]}:</span> &ldquo;{decided}&rdquo;
                            </p>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 flex-col items-end gap-2">
                          <When at={a.decidedAt || a.createdAt} />
                          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </div>
                      </div>
                      <Collapse open={isOpen}>
                        <div className="grid gap-5 border-t border-border/70 px-4 py-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                          <ApprovalTicketBrief approval={a} backState={backState} />
                          <div className="min-w-0 lg:border-l lg:border-border/70 lg:pl-5">
                            <DecisionRecord a={a} members={g.members} />
                          </div>
                        </div>
                      </Collapse>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Pending for me — A1: what · who · when + Decide */}
            <section>
              <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Pending for you ({pending.length})</h2>
              {pending.length === 0 ? (
                <div className="tp-card rounded-xl p-8 text-center text-sm text-muted-foreground/75">
                  <BrandArt name="approval-stamp" className="mx-auto mb-2 h-10 w-10 opacity-80" /> Nothing awaiting your decision. 🎉
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {pending.map((a) => {
                    const isOpen = openId === a.id;
                    return (
                      <li key={a.id} className="tp-card overflow-hidden rounded-xl" data-testid="inbox-row">
                        <div {...rowToggleProps(isOpen, () => (isOpen ? setOpenId(null) : openComposer(a)), `${isOpen ? 'Close' : 'Open'} ${a.subject || 'approval'}`)} className="tp-focus-ring flex cursor-pointer gap-4 px-4 py-4 hover:bg-muted/25">
                          <StatusBlock status="pending" />
                          <div className="min-w-0 flex-1">
                            <CategoryLine name={a.categoryName} />
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                              <span className="min-w-0 text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">{a.subject || '(no subject)'}</span>
                              <TicketRef a={a} state={backState} />
                              {isOpen && <span className="text-muted-foreground">· {a.isFinal ? 'final approval' : a.tierCount > 1 ? `${a.tierName}, not the final approval` : 'not the final approval'}</span>}
                              <AmountChip amount={a.amount} currency={a.amountCurrency} className="!text-xs" />
                            </div>
                            <PeopleLine a={a} className="mt-2" />
                            {!isOpen && <RequestLine note={a.requestNote} />}
                          </div>
                          <div className="flex flex-shrink-0 flex-col items-end gap-2">
                            <When at={a.createdAt} />
                            {!isOpen && (
                              <button
                                type="button"
                                onClick={() => setQuickId(a.id)}
                                disabled={busyId === a.id}
                                title="Approve without a note — you confirm first"
                                className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:hover:bg-emerald-500/25"
                              >
                                {busyId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Quick approve
                              </button>
                            )}
                            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                          </div>
                        </div>
                        {quickId === a.id && (
                          <ConfirmSheet
                            pending={{ decision: 'approved', note: null, conditionNote: null, amountLabel: a.amountLabel || null, notifyRequester: false }}
                            approval={{ ...a, ticketRef: a.displayRef }}
                            busy={busyId === a.id}
                            onConfirm={() => act(() => ticketsAPI.decideApproval(a.ticketId, a.id, 'approved', null, { noteHtml: null, conditionNote: null, notifyRequester: false }), a.id).finally(() => setQuickId(null))}
                            onCancel={() => setQuickId(null)}
                          />
                        )}
                        <Collapse open={isOpen}>
                          <div className="grid border-t border-border/70 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                            <div className="min-w-0 px-4 py-4 lg:border-r lg:border-border/70">
                              <ApprovalTicketBrief approval={a} backState={backState} />
                            </div>
                            <div className="min-w-0 px-4 py-4">
                              <ApprovalComposer
                                layout="choices"
                                compact
                                showShortcuts={false}
                                minHeight={110}
                                approval={{ ...a, ticketRef: a.displayRef, nextTier: a.nextTierName ? { name: a.nextTierName, approverNames: [] } : null, amountLabel: null }}
                                participants={null}
                                selfEmail={a.approverEmail}
                                forwardCandidates={(people || []).filter((p) => p.email !== String(a.approverEmail || '').toLowerCase() && p.email !== String(a.requestedBy || '').toLowerCase())}
                                onDecide={(decision, note, noteHtml, extra) => act(() => ticketsAPI.decideApproval(a.ticketId, a.id, decision, note, { noteHtml, ...extra }), a.id)}
                                onAsk={(payload) => act(() => ticketsAPI.askApproval(a.ticketId, a.id, payload), a.id)}
                                onHandoff={({ mode, note, toEmail }) => act(async () => {
                                  if (mode === 'forward') await ticketsAPI.forwardApproval(a.ticketId, a.id, { toEmail, note });
                                  else await ticketsAPI.escalateApproval(a.ticketId, a.id, { note });
                                }, a.id)}
                                disabled={busyId === a.id}
                                footer={<>You confirm before anything is sent.</>}
                              />
                            </div>
                          </div>
                        </Collapse>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Needs my info */}
            {needsInfo.length > 0 && (
              <section>
                <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Needs your info ({needsInfo.length})</h2>
                <ul className="space-y-1.5">
                  {needsInfo.map((a) => (
                    <li key={a.id} className="tp-card rounded-xl px-3.5 py-2.5">
                      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:gap-4">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <StatusBlock status="info_requested" />
                          <div className="min-w-0 flex-1">
                            <CategoryLine name={a.categoryName} />
                            <div className="flex items-center gap-2 text-[12px]">
                              <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={a.subject || undefined}>{a.subject || '(no subject)'}</span>
                              <TicketIcon a={a} state={backState} />
                              {a.categoryName && <><span className="hidden lg:inline"><Dot /></span><span className="hidden truncate text-muted-foreground lg:inline">{a.categoryName}</span></>}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
                              <InlinePerson name={a.approverName} email={a.approverEmail} />
                              <span className="text-muted-foreground/75">asks</span>
                              {a.decisionNote && <RowNote note={a.decisionNote} open={expanded.has(a.id)} onToggle={() => toggleExpanded(a.id)} />}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border/70 pt-2 xl:flex-col xl:items-end xl:gap-1 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
                          <When at={a.createdAt} />
                          <span className="flex items-center gap-1">
                            <Link to={`/tickets/${a.ticketId}?tab=conversation`} state={backState} className="tp-focus-ring inline-flex h-8 items-center rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Add info →</Link>
                            <button onClick={() => resubmit(a)} disabled={busyId === a.id} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                              {busyId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Resubmit
                            </button>
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
