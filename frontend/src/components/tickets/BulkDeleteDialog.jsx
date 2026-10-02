import { useEffect, useRef } from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';

/**
 * Bulk delete from the queue's bulk bar (2 Oct 2026). Three phases:
 *  - confirm: how many Ticket Pulse and how many FreshService tickets go;
 *  - running: "Deleting 3 of 12…" (the page deletes one at a time);
 *  - report:  per-ticket ✓/✗ with FreshService's reason — only for selections
 *             of more than five (smaller ones get a toast instead).
 */
export default function BulkDeleteDialog({
  phase = 'confirm',
  tpCount = 0,
  fsCount = 0,
  current = 0,
  results = [],
  onConfirm,
  onClose,
}) {
  const total = tpCount + fsCount;
  const running = phase === 'running';
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, [phase]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !running) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  const noun = (n, what) => `${n} ${what} ticket${n === 1 ? '' : 's'}`;
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" data-testid="bulk-delete-dialog">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={running ? undefined : onClose} aria-hidden="true" />
      <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-lg p-5 animate-scaleIn">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 rounded-lg bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300 inline-flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            {phase === 'report' ? (
              <>
                <h2 id="bulk-delete-title" className="text-base font-bold text-foreground">Delete report</h2>
                <p className="mt-1 text-sm text-muted-foreground" data-testid="bulk-delete-summary">
                  {okCount} deleted{failCount > 0 ? `, ${failCount} failed` : ''}
                  {failCount > 0 ? ' — the failed ones stay selected so you can try again.' : '.'}
                </p>
              </>
            ) : (
              <>
                <h2 id="bulk-delete-title" className="text-base font-bold text-foreground">
                  Delete {total} ticket{total === 1 ? '' : 's'}?
                </h2>
                <div className="mt-1 space-y-1.5 text-sm text-muted-foreground leading-relaxed">
                  {tpCount > 0 && (
                    <p><strong className="text-foreground">{noun(tpCount, 'Ticket Pulse')}</strong> — deleted here; any FreshService copy goes too.</p>
                  )}
                  {fsCount > 0 && (
                    <p><strong className="text-foreground">{noun(fsCount, 'FreshService')}</strong> — deleted in FreshService (moved to its trash, restorable there), one at a time.</p>
                  )}
                  <p>They disappear from Ticket Pulse lists; their history stays under the Deleted view.</p>
                </div>
              </>
            )}
            {running && (
              <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-foreground" role="status" aria-live="polite" data-testid="bulk-delete-progress">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                Deleting {current} of {total}…
              </p>
            )}
          </div>
        </div>

        {phase === 'report' && (
          <ul className="mt-4 max-h-72 overflow-y-auto settings-scrollbar divide-y divide-border/60 border-y border-border/60" data-testid="bulk-delete-results">
            {results.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 py-2 text-sm">
                {r.ok
                  ? <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-300" aria-label="Deleted" />
                  : <X className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-300" aria-label="Failed" />}
                <span className="min-w-0">
                  <span className="font-mono text-foreground">{r.ref}</span>
                  {r.subject ? <span className="text-muted-foreground"> · {r.subject}</span> : null}
                  {!r.ok && r.error && <span className="block text-xs text-red-700 dark:text-red-300">{r.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          {phase === 'report' ? (
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              className="tp-focus-ring px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700"
            >
              Done
            </button>
          ) : (
            <>
              <button
                ref={cancelRef}
                type="button"
                onClick={onClose}
                disabled={running}
                className="tp-focus-ring px-3 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={running}
                data-testid="bulk-delete-confirm"
                className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-destructive text-destructive-foreground hover:bg-red-700 disabled:opacity-60"
              >
                {running ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
                Delete {total}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
