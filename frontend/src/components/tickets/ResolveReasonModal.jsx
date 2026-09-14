import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { RESOLUTION_REASONS } from '../../utils/resolutionReasons';

/**
 * Resolution reason picker (Simorgh C4, 09-14).
 *
 * Shown when an agent moves a Security-category ticket to a Resolved- or
 * Closed-base status. One of seven reasons, optional note ("Other" needs one).
 * The reason is stored on the ticket, mirrored to FreshService, and carried on
 * the status-changed webhook — it is how the security agent learns what the
 * analyst concluded and reconciles it against its own verdict.
 */
export default function ResolveReasonModal({ ticketRef, targetStatus, busy = false, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needsNote = reason === 'other' && !note.trim();
  const canConfirm = Boolean(reason) && !needsNote && !busy;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-reason-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="tp-card w-full max-w-lg rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="resolve-reason-title" className="text-base font-bold text-foreground">
              Why is {ticketRef} being {String(targetStatus).toLowerCase()}?
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Security tickets carry a reason so the detection side learns what you concluded.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="sr-only">Resolution reason</legend>
          {RESOLUTION_REASONS.map((r, i) => (
            <label
              key={r.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                reason === r.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              }`}
            >
              <input
                ref={i === 0 ? firstRef : undefined}
                type="radio"
                name="resolution-reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="tp-focus-ring mt-0.5 h-3.5 w-3.5 accent-primary"
              />
              <span>
                <span className="font-medium text-foreground">{r.label}</span>
                <span className="block text-[11px] text-muted-foreground">{r.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="mt-3 block text-xs font-medium text-muted-foreground" htmlFor="resolve-reason-note">
          Note {reason === 'other' ? <span className="text-destructive">(required for “Other”)</span> : <span className="font-normal">(optional)</span>}
        </label>
        <textarea
          id="resolve-reason-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="What you found, in a sentence. The security agent reads this."
          className="tp-focus-ring mt-1 w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm?.({ resolutionReason: reason, resolutionNote: note.trim() || null })}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {targetStatus}
          </button>
        </div>
      </div>
    </div>
  );
}
