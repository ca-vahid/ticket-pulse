import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, MoreHorizontal, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { SafeHtml } from './ticketUi';

/**
 * Inline answers (20 Nov 2026). A requester answered the agent's questions by
 * typing under each one inside the quoted e-mail, and wrote only "Please see
 * below" on top. Ingest compares the quote with our message and stores the
 * pairs on the entry (`rawPayload.inlineAnswers = [{ context, answer, highlighted }]`).
 *
 * Shown below the reply's own text, only when there is at least one pair: a
 * small muted label, then each context line (our question) in semibold with
 * the answer beneath it. No box, no pill, no extra border.
 */
export function InlineAnswers({ answers }) {
  const pairs = (Array.isArray(answers) ? answers : [])
    .filter((p) => p && typeof p.context === 'string' && typeof p.answer === 'string' && p.context.trim() && p.answer.trim());
  if (!pairs.length) return null;
  return (
    // Rendered INSIDE the reply's e-mail well (SafeHtml `after`): the well's text
    // colour and its muted grey (`.tp-well-text` / `.tp-well-muted`, index.css),
    // so in dark mode the pairs sit on the same paper as the reply.
    <section className="mt-3" aria-label="Answered inline" data-testid="inline-answers">
      <div className="text-xs tp-well-muted">Answered inline</div>
      <dl className="mt-1.5 space-y-2.5">
        {pairs.map((p, i) => (
          <div key={`${i}:${p.context}`}>
            <dt className="text-sm font-semibold tp-well-text break-words">{p.context}</dt>
            <dd className="mt-0.5 text-sm tp-well-text whitespace-pre-line break-words">{p.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The entry's "…" menu. Items: [{ key, label, onSelect }]. Renders nothing
 * without items. Opens on click, closes on Escape, outside click or a choice.
 */
export function EntryMenu({ items = [], label = 'More actions for this message' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Shown on hover AND on keyboard focus (the entry's own focus or the button's).
        className={`tp-focus-ring p-1 rounded text-muted-foreground/50 hover:text-muted-foreground transition-opacity ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'}`}
        data-testid="entry-menu-button"
      >
        <MoreHorizontal className="w-3 h-3" aria-hidden="true" />
      </button>
      {open && (
        <span id={menuId} role="menu" className="absolute right-0 top-full z-30 mt-1 w-56 tp-card rounded-lg shadow-soft p-1 flex flex-col animate-popIn">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); buttonRef.current?.focus(); item.onSelect?.(); }}
              className="tp-focus-ring rounded-md px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted"
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * "View the original e-mail": the whole mail as it arrived (with the earlier
 * messages it quoted), fetched on demand and rendered in the white e-mail
 * well through the same sanitiser as every e-mail body (SafeHtml).
 */
export function OriginalEmailDialog({ open, onClose, ticketId, entryId, from = null }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const dialogRef = useRef(null);
  const titleId = useId();
  // The parent re-renders often (SSE ticks); a new onClose must not refetch the mail.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setState({ loading: true, error: null, data: null });
    Promise.resolve()
      .then(() => ticketsAPI.entryOriginal(ticketId, entryId))
      .then((res) => { if (alive) setState({ loading: false, error: null, data: res?.data?.data ?? res?.data ?? null }); })
      .catch((err) => { if (alive) setState({ loading: false, error: err?.response?.data?.message || err?.message || 'Could not load the e-mail', data: null }); });
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current?.(); };
    document.addEventListener('keydown', onKey);
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      alive = false;
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    };
  }, [open, ticketId, entryId]);
  if (!open) return null;
  const { loading, error, data } = state;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => onClose?.()} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative flex max-h-[min(86vh,52rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-soft outline-none"
        data-testid="original-email-dialog"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold text-foreground">The original e-mail</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              As it arrived{from ? ` from ${from}` : ''}, with the earlier messages it quoted.
            </p>
          </div>
          <button type="button" onClick={() => onClose?.()} className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto settings-scrollbar p-5">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the e-mail…
            </p>
          ) : error ? (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          ) : data?.html ? (
            <SafeHtml html={data.html} className="rounded-lg border border-border p-4" />
          ) : (
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border p-4 text-sm text-foreground/85">{data?.text || ''}</p>
          )}
          {data?.truncated && (
            <p className="mt-2 text-xs text-muted-foreground">This e-mail was very long; the end was not kept.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default InlineAnswers;
