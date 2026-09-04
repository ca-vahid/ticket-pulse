import { Check, RefreshCw } from 'lucide-react';

/**
 * "N new" pill for the ticket queue.
 *
 * Lifecycle (driven by the parent's `state`):
 *   idle  — count > 0: springy drop-in, ambient pulse, and the count popping
 *           in place whenever the number moves (re-keyed per value).
 *   busy  — the click landed: morphs into "Refreshing…" with a spinner while
 *           the list re-fetches and diff-highlights what changed.
 *   done  — brief emerald "Up to date" confirmation, then fades itself out
 *           (the parent unmounts it right after).
 *
 * The count is part of the text run, not a badge perched on an icon: at three
 * characters ("99+") the old badge cleared the pill's rounded edge and floated
 * outside it. Nothing here can overflow at any count.
 *
 * Blue stays `blue-600` in BOTH themes — the dark-mode `primary` token is a
 * light blue, and white on it misses AA.
 *
 * Sticky (not absolute) so it stays visible below the app header even when
 * the user is scrolled deep into the list — updates can't arrive unseen.
 */
export default function LiveUpdatePill({ count, state = 'idle', onApply }) {
  const busy = state === 'busy';
  const done = state === 'done';
  const shown = count > 99 ? '99+' : count;

  return (
    <div className={`sticky top-[76px] z-20 h-0 flex justify-center pointer-events-none ${done ? '' : 'tp-pill-enter'}`}>
      <button
        type="button"
        onClick={onApply}
        disabled={busy || done}
        title={done || busy ? undefined : `${count} ticket update${count === 1 ? '' : 's'} — load them into the list (new and updated rows get highlighted)`}
        className={`pointer-events-auto inline-flex items-center gap-2 rounded-full pl-3.5 pr-4 py-2.5 text-sm leading-5 font-semibold text-white shadow-soft transition-all duration-200 tp-focus-ring ${
          done
            ? 'bg-emerald-600 tp-pill-done'
            : busy
              ? 'bg-blue-600 cursor-wait'
              : 'bg-blue-600 hover:bg-blue-700 hover:-translate-y-0.5 active:scale-95 active:translate-y-0 tp-pill-pulse'
        }`}
      >
        {done ? (
          <>
            <Check className="w-4 h-4" aria-hidden="true" />
            Up to date
          </>
        ) : busy ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
            Refreshing…
          </>
        ) : (
          <>
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>
              {/* Re-keyed so the number pops when it moves, without moving the pill. */}
              <span key={count} className="tp-count-pop inline-block text-[15px] leading-5 font-extrabold tabular-nums">{shown}</span>
              {' '}
              <span className="font-semibold text-white/85">new</span>
            </span>
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
