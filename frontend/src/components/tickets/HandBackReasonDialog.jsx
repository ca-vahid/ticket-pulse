import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, X } from 'lucide-react';
import { reasonOptions } from '../../utils/handBack';
import useDialogFocus from '../../hooks/useDialogFocus';

/**
 * Assignee-change reason (QA 09-25 item 3; QA 10-16 item 1): THE one dialog
 * for every change of agent in Ticket Pulse — cleared (`mode="unassign"`) or
 * moved to another person (`mode="reassign"`), from the queue row, the bulk
 * bar, the peek, the ticket page and the phone sheet. The reason reaches the
 * assignment AI and the Hand-backs review in Assignment Review.
 *
 * Escalate ("Escalate to Advanced Troubleshooting Team") is offered only when
 * the ticket goes back to the queue: it sits apart below the other reasons,
 * because it asks for something (a more advanced person) instead of saying
 * why. Moving a ticket to a named person never shows it.
 *
 * `requireReason` (the person is giving up their own ticket) hides Skip; a
 * coordinator changing someone else's may Skip (sent as code 'skipped').
 * Enter submits (Shift+Enter = new line in the note), Esc cancels (ignored
 * while saving). Focus stays inside the dialog and returns to the trigger
 * (`returnFocusRef` fallback) when it closes.
 */
export default function HandBackReasonDialog({
  open,
  onSubmit, // ({ code, note }) => Promise|void
  onCancel,
  mode = 'unassign', // 'unassign' | 'reassign'
  toName = null, // reassign: the new person
  categoryLabel = null, // e.g. "Networking / VPN" — sharpens the Escalate hint
  requireReason = true,
  personName = null, // whose ticket is being changed (coordinator view)
  count = 1, // bulk: tickets affected
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
  const reassign = mode === 'reassign';
  const to = toName || 'someone else';
  let title;
  if (reassign) {
    title = requireReason
      ? (bulk ? `Why are you passing ${count} tickets to ${to}?` : `Why are you passing this to ${to}?`)
      : (bulk ? `Why move ${count} tickets to ${to}?` : `Why move ${personName ? `${personName}'s` : 'this'} ticket to ${to}?`);
  } else {
    title = requireReason
      ? (bulk ? `Why are you handing back ${count} tickets?` : 'Why are you handing this back?')
      : (bulk ? `Why release ${count} tickets?` : `Why is ${personName ? `${personName}'s` : 'this'} ticket being released?`);
  }
  const options = reasonOptions(mode);
  const reasons = options.filter((o) => !o.unassignOnly);
  const escalate = options.find((o) => o.code === 'escalate') || null;
  const submitLabel = code === 'escalate' ? 'Escalate' : (reassign ? 'Reassign' : (requireReason ? 'Hand back' : 'Release'));

  const renderOption = (o, i) => {
    const selected = code === o.code;
    const hint = o.code === 'escalate' && categoryLabel ? `Needs someone more advanced in ${categoryLabel}` : o.hint;
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
          <span className="ml-1.5 text-[11px] text-muted-foreground">{hint}</span>
        </span>
      </label>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hand-back-title"
      data-testid="hand-back-dialog"
      data-mode={mode}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onCancel?.(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div ref={panelRef} className="tp-card w-full max-w-md rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="hand-back-title" className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {reassign
                ? 'Kept with the ticket. The team reviews these to tune skills and routing, and the AI learns from them.'
                : 'The assignment AI reads this when it picks the next person, and the team reviews it to tune skills and routing.'}
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <fieldset className="space-y-1" data-testid="hand-back-reasons">
          <legend className="sr-only">Reason</legend>
          {reasons.map((o, i) => renderOption(o, i))}
          {escalate && (
            // Escalate asks for more than it explains: set apart, last.
            <div className="mt-1.5 border-t border-border/70 pt-1.5" data-testid="hand-back-escalate">
              {renderOption(escalate, reasons.length)}
              {code === 'escalate' && (
                <p className="mt-1 px-2.5 text-[11px] leading-snug text-muted-foreground">
                  The AI will only pick someone at a higher level{categoryLabel ? ` in ${categoryLabel}` : ' in this category'}.
                  If nobody more advanced is at work, it waits for a coordinator.
                </p>
              )}
            </div>
          )}
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
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
