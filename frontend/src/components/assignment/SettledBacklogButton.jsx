import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, Loader2 } from 'lucide-react';
import { assignmentAPI } from '../../services/api';

/**
 * "Clear N settled items" (MEGA 11-14 Part B).
 *
 * The review queue now settles a suggestion by itself once its ticket gets an
 * owner, closes or is removed. Suggestions left from before that sit in the
 * database as "pending review". This one button clears them through the same
 * server code: it shows the count first, asks once, and is safe to press
 * twice (the second press finds nothing). Admin only; hidden when there is
 * nothing to clear.
 */
export default function SettledBacklogButton({ isAdmin = false, onCleared = null, refreshKey = 0 }) {
  const [count, setCount] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState(null);
  const confirmRef = useRef(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await assignmentAPI.getSettledBacklog();
      setCount(Number(res?.data?.count) || 0);
    } catch {
      setCount(0);
    }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!confirming) return undefined;
    confirmRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !clearing) setConfirming(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming, clearing]);

  const clear = async () => {
    setClearing(true);
    try {
      const res = await assignmentAPI.clearSettledBacklog();
      const settled = Number(res?.data?.settled) || 0;
      const remaining = Number(res?.data?.remaining) || 0;
      setMessage({ tone: 'ok', text: settled ? `Cleared ${settled.toLocaleString()}.` : 'Nothing left to clear.' });
      setCount(remaining);
      setConfirming(false);
      onCleared?.({ settled, remaining });
    } catch (err) {
      setMessage({ tone: 'error', text: `Could not clear: ${err?.response?.data?.message || err?.message || 'unknown error'}` });
    } finally {
      setClearing(false);
    }
  };

  if (!isAdmin) return null;
  if (count <= 0) {
    return message ? (
      <span role="status" data-testid="settled-backlog-message" className={`text-[11px] ${message.tone === 'error' ? 'text-red-600 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
        {message.text}
      </span>
    ) : null;
  }

  const n = count.toLocaleString();
  const plural = count === 1 ? 'item' : 'items';
  return (
    <>
      <button
        type="button"
        onClick={() => { setMessage(null); setConfirming(true); }}
        data-testid="settled-backlog-button"
        title="AI suggestions for tickets that already have an owner, or are closed or removed"
        className="tp-focus-ring inline-flex touch-manipulation items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-primary hover:bg-muted"
      >
        <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Clear {n} settled {plural}
      </button>
      {message?.tone === 'error' && (
        <span role="alert" className="text-[11px] text-red-600 dark:text-red-300">{message.text}</span>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4 dark:bg-black/70"
          onClick={() => !clearing && setConfirming(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settled-backlog-title"
            data-testid="settled-backlog-dialog"
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-soft"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 id="settled-backlog-title" className="text-sm font-bold text-foreground">Clear {n} settled {plural}?</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  These AI suggestions are for tickets that already have an owner, or are closed or removed.
                  They move to history as <span className="font-medium text-foreground">Settled elsewhere</span>.
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">Nothing is assigned and nobody is told.</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={clearing}
                className="tp-focus-ring rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={clear}
                disabled={clearing}
                data-testid="settled-backlog-confirm"
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {clearing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <CheckCheck className="h-3 w-3" aria-hidden="true" />}
                {clearing ? 'Clearing…' : `Clear ${n}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
