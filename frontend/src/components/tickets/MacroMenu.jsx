import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Check, ChevronDown, Info, Loader2, Mail, MinusCircle, StickyNote, Wand2, X,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { SafeHtml } from './ticketUi';

/**
 * The ticket header's Macros button (QA 11-05 #2). Picking a macro opens a
 * confirm that lists what it will do on THIS ticket — the reply and note
 * rendered for this requester, and any step that will be skipped with the
 * reason (FreshService owns the field, unattended requester…) — before
 * anything runs. Lives outside TicketDetail.jsx on purpose (lane rule): the
 * page only mounts <MacroMenu ticketId onApplied />.
 */

const unwrap = (res) => res?.data?.data ?? res?.data ?? res;

export function MacroPreviewDialog({ ticketId, macro, onClose, onApplied }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const applyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.previewMacro(ticketId, macro.id))
      .then((res) => { if (!cancelled) setPreview(unwrap(res)); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.message || e.message || 'The preview could not load'); });
    return () => { cancelled = true; };
  }, [ticketId, macro.id]);
  useEffect(() => { if (preview) applyRef.current?.focus(); }, [preview]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !applying) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, applying]);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await ticketsAPI.applyMacro(ticketId, macro.id);
      onApplied?.(unwrap(res));
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'The macro could not be applied');
      setApplying(false);
    }
  };

  const steps = preview?.steps || [];
  const runCount = steps.filter((s) => s.run).length;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="macro-preview-title"
      data-testid="macro-preview"
      onClick={(e) => { if (e.target === e.currentTarget && !applying) onClose?.(); }}
    >
      <div className="tp-card flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl shadow-soft animate-scaleIn">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="macro-preview-title" className="flex items-center gap-2 text-base font-bold text-foreground">
              <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" /> Apply “{macro.name}”{preview?.ticket?.ref ? ` to ${preview.ticket.ref}` : ''}?
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {preview ? `${runCount} of ${steps.length} action${steps.length === 1 ? '' : 's'} will run, in this order. A status change runs last.` : 'Checking what it will do on this ticket…'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={applying} aria-label="Close dialog" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto settings-scrollbar px-5 py-3">
          {!preview && !error && (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
          )}
          {preview && (
            <ol className="space-y-2.5" data-testid="macro-preview-steps">
              {steps.map((s) => (
                <li key={s.index} className="flex gap-2.5" data-testid={`macro-preview-${s.type}`}>
                  <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center ${s.run ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true">
                    {s.run ? (s.type === 'reply' ? <Mail className="h-4 w-4" /> : s.type === 'note' ? <StickyNote className="h-4 w-4" /> : <Check className="h-4 w-4" />) : <MinusCircle className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${s.run ? 'text-foreground' : 'text-muted-foreground line-through decoration-muted-foreground/50'}`}>{s.summary}</p>
                    {!s.run && s.reason && <p className="text-xs text-muted-foreground">Skipped: {s.reason}</p>}
                    {s.notice && (
                      <p className="mt-0.5 flex items-start gap-1 text-xs text-amber-800 dark:text-amber-200">
                        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> {s.notice}
                      </p>
                    )}
                    {s.dueAt && <p className="text-xs text-muted-foreground">Due {new Date(s.dueAt).toLocaleString('en-CA', { timeZone: 'America/Vancouver', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p>}
                    {s.run && s.subject && <p className="mt-1 text-xs text-muted-foreground">Subject: <span className="text-foreground/85">{s.subject}</span></p>}
                    {s.run && s.html && (
                      // The message as the thread will show it (same renderer).
                      <div className="mt-1.5 max-h-48 overflow-y-auto settings-scrollbar rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm [&_img]:max-w-full">
                        <SafeHtml html={s.html} />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-300" role="alert">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} disabled={applying} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            ref={applyRef}
            type="button"
            onClick={apply}
            disabled={!preview || applying || runCount === 0}
            data-testid="macro-apply"
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
            Apply macro
          </button>
        </div>
      </div>
    </div>
  );
}

export function MacroMenu({ ticketId, onApplied, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [macros, setMacros] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open || macros) return;
    ticketsAPI.macros().then((res) => setMacros(unwrap(res) || [])).catch(() => setMacros([]));
  }, [open, macros]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <span ref={boxRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:border-violet-300 dark:hover:border-violet-500/40 hover:text-violet-700 dark:hover:text-violet-200 disabled:opacity-50"
      >
        <Wand2 className="w-3.5 h-3.5" aria-hidden="true" /> Macros
        <ChevronDown className={`w-3 h-3 transition-transform motion-off:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label="Macros" className="absolute right-0 top-full z-40 mt-1 w-72 tp-card rounded-xl shadow-soft p-1.5 animate-popIn">
          {macros === null && <p className="px-2 py-2 text-xs text-muted-foreground/75">Loading…</p>}
          {macros?.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground/75">No macros yet — admins create them in Settings → Macros.</p>}
          {(macros || []).map((macro) => (
            <button
              key={macro.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); setConfirming(macro); }}
              className="tp-focus-ring w-full rounded-lg px-2 py-1.5 text-left hover:bg-violet-50 dark:hover:bg-violet-500/15"
            >
              <span className="block text-xs font-semibold text-foreground/85">{macro.name}</span>
              {macro.description && <span className="block text-[10px] text-muted-foreground/75 truncate">{macro.description}</span>}
            </button>
          ))}
        </div>
      )}
      {confirming && (
        <MacroPreviewDialog
          ticketId={ticketId}
          macro={confirming}
          onClose={() => setConfirming(null)}
          onApplied={(result) => { setConfirming(null); onApplied?.(result); }}
        />
      )}
    </span>
  );
}

export default MacroMenu;
