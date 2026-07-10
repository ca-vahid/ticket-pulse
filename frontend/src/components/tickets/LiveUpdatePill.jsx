import { Check, Inbox, RefreshCw } from 'lucide-react';

/**
 * "N updates — refresh" pill for the ticket queue.
 *
 * Lifecycle (driven by the parent's `state`):
 *   idle  — count > 0: springy drop-in, ambient pulse, and a notification-style
 *           count badge perched on the inbox icon (re-keyed per value so the
 *           pop animation replays when the number moves).
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
        className={`pointer-events-auto inline-flex items-center gap-2 pl-3.5 pr-4 py-2 rounded-full text-sm font-semibold text-white shadow-soft transition-all duration-200 tp-focus-ring ${
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
            {/* Inbox wearing the count — the ring matches the pill background
                so the badge reads punched-out, never bigger than the pill. */}
            <span aria-hidden="true" className="relative inline-flex mr-1">
              <Inbox className="w-[18px] h-[18px]" />
              <span
                key={count}
                className="tp-count-pop absolute -top-1.5 -right-2 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-extrabold leading-none text-blue-700 ring-2 ring-blue-600"
              >
                {count > 99 ? '99+' : count}
              </span>
            </span>
            {count === 1 ? 'New update' : 'New updates'} — refresh
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
