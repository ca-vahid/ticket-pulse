import { Check, RefreshCw } from 'lucide-react';

/**
 * "N updates — refresh" pill for the ticket queue.
 *
 * Lifecycle (driven by the parent's `state`):
 *   idle  — count > 0: springy drop-in, ambient radar pulse, count badge that
 *           pops every time the number changes (the badge is re-keyed per
 *           value so the animation replays).
 *   busy  — the click landed: morphs into "Refreshing…" with a spinner while
 *           the list re-fetches and diff-highlights what changed.
 *   done  — brief emerald "Up to date" confirmation, then fades itself out
 *           (the parent unmounts it right after).
 *
 * Sticky (not absolute) so it stays visible below the app header even when
 * the user is scrolled deep into the list — updates can't arrive unseen.
 */
export default function LiveUpdatePill({ count, state = 'idle', onApply }) {
  const busy = state === 'busy';
  const done = state === 'done';

  return (
    <div className={`sticky top-[76px] z-20 h-0 flex justify-center pointer-events-none ${done ? '' : 'tp-pill-enter'}`}>
      <button
        type="button"
        onClick={onApply}
        disabled={busy || done}
        title={done ? undefined : busy ? undefined : 'Load the changes into the list — new and updated rows get highlighted'}
        className={`pointer-events-auto inline-flex items-center gap-2.5 pl-4 pr-5 py-3 rounded-full text-[15px] font-semibold text-white shadow-soft transition-all duration-200 tp-focus-ring ${
          done
            ? 'bg-emerald-600 tp-pill-done'
            : busy
              ? 'bg-blue-600 cursor-wait'
              : 'bg-blue-600 hover:bg-blue-700 hover:-translate-y-0.5 active:scale-95 active:translate-y-0 tp-pill-pulse'
        }`}
      >
        {done ? (
          <>
            <Check className="w-5 h-5" aria-hidden="true" />
            Up to date
          </>
        ) : busy ? (
          <>
            <RefreshCw className="w-5 h-5 animate-spin" aria-hidden="true" />
            Refreshing…
          </>
        ) : (
          <>
            <span aria-hidden="true" className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white/70" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-white" />
            </span>
            {/* Re-keying replays the pop each time the count moves. */}
            <span
              key={count}
              className="tp-count-pop inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 rounded-full bg-white text-blue-700 text-sm font-extrabold tabular-nums shadow-sm"
            >
              {count}
            </span>
            update{count === 1 ? '' : 's'} — refresh
          </>
        )}
        {/* Screen readers hear count changes without the pill stealing focus. */}
        <span className="sr-only" role="status" aria-live="polite">
          {done ? 'Ticket list is up to date' : busy ? 'Refreshing ticket list' : `${count} ticket update${count === 1 ? '' : 's'} available`}
        </span>
      </button>
    </div>
  );
}
