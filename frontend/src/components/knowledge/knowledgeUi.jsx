import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, BookMarked, Check, ChevronRight, CircleSlash, FileCheck2, FileText, SkipForward, Ticket,
} from 'lucide-react';
import { PersonAvatar, SafeHtml } from '../tickets/ticketUi';

/**
 * Shared pieces for the Knowledge section (Auto-help P0). Status and
 * confidence are words + a small glyph — never pills (Vahid's taste, Sep 2026).
 */

export function Loading({ label = 'Loading…', className = '' }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground ${className}`} role="status">
      <Activity className="h-5 w-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon: Icon = FileText, title, children, action = null }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SectionTitle({ children, hint = null, icon: Icon = null }) {
  return (
    <div className="mb-2">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
        {children}
      </h3>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

const RUN_STATUS = {
  drafted: { label: 'Drafted', Icon: FileCheck2, tone: 'text-emerald-700 dark:text-emerald-300' },
  not_answerable: { label: 'Not answerable', Icon: CircleSlash, tone: 'text-muted-foreground' },
  failed: { label: 'Failed', Icon: AlertTriangle, tone: 'text-red-700 dark:text-red-300' },
  running: { label: 'Running', Icon: Activity, tone: 'text-primary', spin: true },
  no_match: { label: 'No match', Icon: CircleSlash, tone: 'text-muted-foreground' },
  skipped: { label: 'Skipped', Icon: SkipForward, tone: 'text-muted-foreground' },
  staged: { label: 'Staged', Icon: FileCheck2, tone: 'text-primary' },
  sent: { label: 'Sent', Icon: Check, tone: 'text-emerald-700 dark:text-emerald-300' },
};

export function RunStatus({ status, className = '' }) {
  const m = RUN_STATUS[status] || { label: status || '—', Icon: CircleSlash, tone: 'text-muted-foreground' };
  const { Icon } = m;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${m.tone} ${className}`}>
      <Icon className={`h-3.5 w-3.5 ${m.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {m.label}
    </span>
  );
}

/** Confidence as a percentage with a hairline meter; amber under the playbook's bar. */
export function Confidence({ value, min = null, className = '' }) {
  if (value === null || value === undefined) return <span className={`text-xs text-muted-foreground/75 ${className}`}>—</span>;
  const pct = Math.round(Number(value) * 100);
  const below = min !== null && min !== undefined && Number(value) < Number(min);
  const tone = below ? 'text-amber-700 dark:text-amber-300' : 'text-foreground/85';
  const bar = below ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs tabular-nums ${tone} ${className}`}
      title={below ? `Below this playbook's bar (${Math.round(Number(min) * 100)}%)` : 'Model confidence'}
    >
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: `${Math.max(4, Math.min(100, pct))}%` }} />
      </span>
      {pct}%
    </span>
  );
}

/**
 * The answer as the requester would receive it. The mail body sits in a
 * WHITE e-mail well in both themes (`.tp-light` re-pins the light tokens and
 * SafeHtml neutralises as light) - the same convention as the signature and
 * composer previews: requesters read it in a light mail client.
 */
export function DraftPreview({ subject, html, to = null, className = '' }) {
  return (
    <div className={`overflow-hidden rounded-lg border border-border ${className}`} data-testid="draft-preview">
      <div className="border-b border-border/70 bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
        {to && <p className="truncate"><span className="text-muted-foreground/75">To</span> {to}</p>}
        <p className="truncate font-medium text-foreground/85">{subject || '(no subject)'}</p>
      </div>
      <div className="tp-light bg-card px-3.5 py-3 text-card-foreground" data-testid="email-well">
        <SafeHtml html={html || ''} isDark={false} />
      </div>
    </div>
  );
}

/** "vahid.pelarak@x.com" -> "Vahid Pelarak" (fallback when no person record exists). */
export function prettyEmailName(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return '';
  return local.split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Avatar + name for a person - never a bare e-mail. */
export function PersonLine({ person = null, email = null, className = '' }) {
  const addr = person?.email || email || '';
  const name = person?.name || prettyEmailName(addr) || 'Someone';
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 align-middle ${className}`} title={addr || undefined} data-testid="person-line">
      <PersonAvatar name={name} photoUrl={person?.photoUrl || null} size="h-5 w-5" textSize="text-[9px]" />
      <span className="truncate text-foreground/85">{name}</span>
    </span>
  );
}

/**
 * In-app confirm (never window.confirm): an alertdialog with focus on the
 * safe choice, Escape to cancel and Tab kept inside.
 */
export function ConfirmDialog({
  open, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, onConfirm, onCancel,
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef(null);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    cancelRef.current?.focus();
    return () => { if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); };
  }, [open]);
  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); return; }
    if (e.key === 'Tab') {
      const items = boxRef.current?.querySelectorAll('button') || [];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  // Portalled to <body>: a card with a backdrop-filter (tp-card / tp-surface)
  // is a containing block for position:fixed, which clipped the dim layer to
  // the editor card instead of the whole window.
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground/30 p-4 animate-fadeIn" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-soft animate-scaleIn"
      >
        <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
        {children && <div id={bodyId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-foreground/85 hover:bg-muted">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`tp-focus-ring inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-semibold ${destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Unsaved-changes guard shared by the Knowledge editors. Knowledge.jsx
 * provides it: editors report `dirty`, and every in-section navigation
 * (tabs, back links, Cancel) goes through `leave(to)`, which asks first.
 */
export const KnowledgeGuardContext = createContext({ setDirty: () => {}, leave: null });

export function useUnsavedGuard(dirty) {
  const ctx = useContext(KnowledgeGuardContext);
  const { setDirty } = ctx;
  useEffect(() => { setDirty(Boolean(dirty)); }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  return ctx.leave;
}

/** A Link that goes through the unsaved-changes guard. */
export function GuardedLink({ to, onClick, children, ...rest }) {
  const { leave } = useContext(KnowledgeGuardContext);
  return (
    <Link
      to={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !leave || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        leave(to);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}

const SOURCE_ICON = { article: FileText, ticket: Ticket, playbook: BookMarked };

export function SourcesList({ sources = [], onlyCited = false }) {
  const list = onlyCited ? sources.filter((s) => s.cited) : sources;
  if (!list.length) return <p className="text-xs text-muted-foreground/75">No sources.</p>;
  return (
    <ul className="space-y-1.5">
      {list.map((s) => {
        const Icon = SOURCE_ICON[s.type] || FileText;
        const base = s.ref ? `${s.ref} · ${s.title || ''}` : (s.title || s.sourceId);
        // R2: which section of the article the run actually read.
        const label = s.section ? `${base} › ${s.section}` : base;
        return (
          <li key={s.sourceId} className="flex items-start gap-2 text-xs">
            <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${s.cited ? 'text-primary' : 'text-muted-foreground/60'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {s.url ? (
                <Link to={s.url} className={`tp-focus-ring rounded hover:underline ${s.cited ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</Link>
              ) : (
                <span className={s.cited ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
              )}
              {s.cited ? <span className="ml-1.5 text-[11px] text-primary">cited</span> : <span className="ml-1.5 text-[11px] text-muted-foreground/60">seen</span>}
              {s.stale && <span className="ml-1.5 text-[11px] text-muted-foreground">· review due</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StepRow({ step, index }) {
  const [open, setOpen] = useState(false);
  const failed = step.status === 'failed';
  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tp-focus-ring flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs hover:bg-muted/50"
      >
        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <span className="w-5 tabular-nums text-muted-foreground/75">{index + 1}</span>
        <span className={`font-mono ${failed ? 'text-red-700 dark:text-red-300' : 'text-foreground/85'}`}>{step.tool}</span>
        <span className="ml-auto tabular-nums text-muted-foreground/75">turn {step.turn}{step.durationMs ? ` · ${step.durationMs} ms` : ''}</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-7 pb-2 animate-fadeIn">
          <pre className="settings-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] text-foreground/85">{JSON.stringify(step.input, null, 2)}</pre>
          {step.output !== undefined && (
            <pre className="settings-scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">{JSON.stringify(step.output, null, 2)}</pre>
          )}
        </div>
      )}
    </li>
  );
}

/** Tool calls, collapsed; plus the model and the reason when it declined. */
export function TranscriptSteps({ transcript }) {
  if (!transcript) return <p className="text-xs text-muted-foreground/75">No transcript.</p>;
  const steps = transcript.steps || [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {transcript.model?.model ? `${transcript.model.model}` : 'No model call'}
        {transcript.turns ? ` · ${transcript.turns} turn${transcript.turns === 1 ? '' : 's'}` : ''}
        {transcript.toolCalls ? ` · ${transcript.toolCalls} tool call${transcript.toolCalls === 1 ? '' : 's'}` : ''}
        {transcript.playbookVersion ? ` · playbook v${transcript.playbookVersion}` : ''}
      </p>
      {transcript.reason && <p className="text-xs text-foreground/85">{transcript.reason}</p>}
      {steps.length > 0 && (
        <ol className="rounded-lg border border-border/70 px-1">
          {steps.map((s, i) => <StepRow key={`${s.turn}-${i}`} step={s} index={i} />)}
        </ol>
      )}
    </div>
  );
}

export const inputClass = 'tp-focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/75';
export const textareaClass = 'tp-focus-ring w-full rounded-lg border border-input bg-card px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/75';
export const labelClass = 'mb-1 block text-xs font-medium text-foreground/85';
