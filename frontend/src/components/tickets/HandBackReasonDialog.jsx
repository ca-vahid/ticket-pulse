import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, X } from 'lucide-react';
import { HAND_BACK_OPTIONS } from '../../utils/handBack';
import useDialogFocus from '../../hooks/useDialogFocus';

/**
 * Hand-back reason (QA 09-25 item 3): asked whenever the current assignee is
 * cleared in Ticket Pulse — assignee picker, mobile sheet, bulk release. The
 * reason reaches the assignment AI (the next pick accounts for it) and the
 * Hand-backs review in Assignment Review.
 *
 * `requireReason` (the person is handing back their own ticket) hides Skip;
 * a coordinator clearing someone else may Skip (sent as code 'skipped').
 * Enter submits (Shift+Enter = new line in the note), Esc cancels (ignored
 * while the hand-back is being saved). Focus stays inside the dialog and
 * returns to the trigger (`returnFocusRef` fallback) when it closes.
 */
export default function HandBackReasonDialog({
  open,
  onSubmit, // ({ code, note }) => Promise|void
  onCancel,
  requireReason = true,
  personName = null, // whose ticket is being cleared (coordinator view)
  count = 1, // bulk release: tickets affected
  busy = false,
  error = null,
  returnFocusRef = null,
}) {
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const firstRef = useRef(null);
  const noteRef = useRef(null);
  const panelRef = useRef(null);
  const trapTab = useDialogFocus(open, panelRef, returnFocusRef);

  useEffect(() => {
    if (!open) return undefined;
    setCode('');
    setNote('');
    const t = setTimeout(() => firstRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel, busy]);

  if (!open) return null;

  const needsNote = code === 'other' && !note.trim();
  const canSubmit = Boolean(code) && !needsNote && !busy;
  const submit = () => { if (canSubmit) onSubmit?.({ code, note: note.trim() || null }); };
  const onKeyDown = (e) => {
    if (e.key === 'Tab') { trapTab(e); return; }
    if (e.target?.tagName === 'BUTTON') return; // Enter on Cancel/Skip means that button
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const bulk = count > 1;
  const title = requireReason
    ? (bulk ? `Why are you handing back ${count} tickets?` : 'Why are you handing this back?')
    : (bulk ? `Why release ${count} tickets?` : `Why is ${personName ? `${personName}'s` : 'this'} ticket being released?`);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hand-back-title"
      data-testid="hand-back-dialog"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onCancel?.(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div ref={panelRef} className="tp-card w-full max-w-md rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="hand-back-title" className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The assignment AI reads this when it picks the next person, and the team reviews it to tune skills and routing.
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <fieldset className="space-y-1">
          <legend className="sr-only">Reason</legend>
          {HAND_BACK_OPTIONS.map((o, i) => {
            const selected = code === o.code;
            return (
              <label
                key={o.code}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                  selected ? 'bg-primary/10' : 'hover:bg-muted/60'
                }`}
              >
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="radio"
                  name="hand-back-reason"
                  value={o.code}
                  checked={selected}
                  onChange={() => {
                    setCode(o.code);
                    if (o.code === 'other') setTimeout(() => noteRef.current?.focus(), 0);
                  }}
                  className="tp-focus-ring h-3.5 w-3.5 accent-primary"
                />
                <o.Icon className={`h-4 w-4 flex-shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="text-foreground">{o.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{o.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="hand-back-note">
          Note {code === 'other' ? <span className="text-destructive">(needed for Other)</span> : '(optional)'}
        </label>
        <textarea
          id="hand-back-note"
          ref={noteRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder={code === 'location' ? 'e.g. needs someone in the Calgary office' : 'A few words'}
          className="tp-focus-ring mt-1 w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/75"
        />

        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          {!requireReason && (
            <button
              type="button"
              onClick={() => onSubmit?.({ code: 'skipped', note: null })}
              disabled={busy}
              className="tp-focus-ring rounded px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              Skip
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="tp-focus-ring rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {requireReason ? 'Hand back' : 'Release'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
