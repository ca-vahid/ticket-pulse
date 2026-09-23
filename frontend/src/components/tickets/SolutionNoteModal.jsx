import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Loader2, X } from 'lucide-react';

/**
 * "Mark as a verified solution" (QA 09-22 #6): one line on what fixed it,
 * prefilled from the resolution note when there is one. The note is what
 * other agents read in the "Verified solutions" card.
 */
export default function SolutionNoteModal({ ticketRef, initialNote = '', busy = false, onConfirm, onClose }) {
  const [note, setNote] = useState(initialNote || '');
  const ref = useRef(null);

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="solution-note-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="tp-card w-full max-w-lg rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="solution-note-title" className="text-base font-bold text-foreground">
              Mark {ticketRef} as a verified solution
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              It will show up under “Verified solutions” on tickets in the same category. Say what fixed it, in a sentence.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="block text-xs font-medium text-muted-foreground" htmlFor="solution-note">
          What fixed it <span className="font-normal">(optional — the resolution note is used when this is empty)</span>
        </label>
        <textarea
          id="solution-note"
          ref={ref}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="e.g. Port 12 on the Halifax switch was flapping — replaced the SFP."
          className="tp-focus-ring mt-1 w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm?.(note.trim() || null)}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
            Mark as solution
          </button>
        </div>
      </div>
    </div>
  );
}
