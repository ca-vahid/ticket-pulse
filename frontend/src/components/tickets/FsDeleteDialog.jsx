import { useEffect, useRef } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

/**
 * Confirm "Delete in FreshService" for an FS-born ticket (2 Oct 2026).
 * FreshService owns the ticket, so the delete happens there (its trash) and
 * Ticket Pulse follows. Nothing to type — one red, explicitly-named button.
 */
export default function FsDeleteDialog({ fsRef, subject = '', busy = false, error = null, onConfirm, onClose }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const shortSubject = subject && subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="fs-delete-title" aria-describedby="fs-delete-desc">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-md p-5 animate-scaleIn">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 rounded-lg bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300 inline-flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="fs-delete-title" className="text-base font-bold text-foreground">Delete in FreshService?</h2>
            <div id="fs-delete-desc" className="mt-1 space-y-2 text-sm text-muted-foreground leading-relaxed">
              <p>
                This moves FreshService ticket <span className="font-mono text-foreground">#{fsRef}</span>
                {shortSubject ? <> (<span className="text-foreground">{shortSubject}</span>)</> : null} to FreshService&rsquo;s trash.
                It can be restored from FreshService&rsquo;s trash.
              </p>
              <p>It disappears from Ticket Pulse lists; its history stays under the Deleted view.</p>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="tp-focus-ring px-3 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="fs-delete-confirm"
            className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-destructive text-destructive-foreground hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
            Delete in FreshService
          </button>
        </div>
      </div>
    </div>
  );
}
