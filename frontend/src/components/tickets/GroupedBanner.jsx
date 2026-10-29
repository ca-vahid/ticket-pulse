import { CopyPlus } from 'lucide-react';

/** True when ticket grouping closed this ticket into another one (kept out of totals with is_noise). */
export function isGroupedCopy(ticket) {
  return Boolean(ticket?.isNoise && String(ticket?.noiseRuleMatched || '').startsWith('Grouped:'));
}

/**
 * QA 10-28 #4: a grouped copy is kept out of the totals the way noise is, but
 * it is not noise. The banner says which ticket it went into instead of
 * "Flagged as noise".
 */
export default function GroupedBanner({ ticket, onOpen }) {
  if (!isGroupedCopy(ticket)) return null;
  const into = ticket.groupedInto;
  const fallbackRef = String(ticket.noiseRuleMatched).replace(/^Grouped:\s*(repeat of|same request as)\s*/i, '');
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 p-2.5 bg-violet-50 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/30 rounded-lg text-xs text-violet-800 dark:text-violet-200" data-testid="grouped-banner">
      <CopyPlus className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {into?.kind === 'repeat' ? 'A repeat of' : 'The same request as'}{' '}
        {into ? (
          <button
            type="button"
            onClick={() => onOpen?.(into.id)}
            className="tp-focus-ring font-mono font-bold text-violet-700 dark:text-violet-200 hover:underline rounded"
          >
            {into.displayRef}
          </button>
        ) : (
          <span className="font-mono font-bold">{fallbackRef}</span>
        )}
        , so it was closed into that ticket. It is not noise: it is left out of the queue and the totals so the work is counted once. Undo it under Tickets → Grouped.
      </span>
    </div>
  );
}
