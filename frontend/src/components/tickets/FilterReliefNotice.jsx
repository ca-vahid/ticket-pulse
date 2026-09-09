import { Filter, Search } from 'lucide-react';

/**
 * "Your filters are hiding this" (FR 09-09).
 *
 * Searching a ticket number and getting "No tickets match these filters" was a
 * dead end: the default Status filter excludes Resolved and Closed, so a
 * ticket that plainly exists is invisible — and Reset filters only clears the
 * typed text, so the user has to guess which checkbox is in the way.
 *
 * Rather than offer a vague "search everything", the backend works out which
 * filter group is responsible and how much it is hiding, so this can name it:
 * "1 ticket is hidden by your Status filter — Include Closed (1)". The typed
 * text is never cleared; it is the thing the person was looking for.
 */

const STATUS_JOIN = (names) => {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} more statuses`;
};

/** Human label for one group's widening action. */
export function reliefActionLabel(group, statusesToAdd) {
  if (group.key === 'status' && statusesToAdd?.length) {
    return `Include ${STATUS_JOIN(statusesToAdd.map((s) => s.status))}`;
  }
  return `Clear the ${group.label} filter`;
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function FilterReliefNotice({ relief, variant = 'empty', onWiden, onClearFilters }) {
  if (!relief) return null;
  const { groups = [], statusesToAdd = [], withoutFilters = 0, current = 0, query, hasQuery } = relief;
  if (!groups.length) return null;

  const top = groups[0];
  const others = groups.slice(1, 3);
  const totalHidden = Math.max(0, withoutFilters - current);

  // A slim one-liner above a non-empty list: results ARE showing, but more
  // exist. Only rendered while a text search is running, so ordinary browsing
  // is never nagged about the 16,000 closed tickets it is not showing.
  if (variant === 'inline') {
    return (
      <div
        className="mb-2 flex items-center gap-2 flex-wrap rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10 px-3 py-2"
        data-testid="filter-relief-inline"
      >
        <Filter className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs text-blue-900 dark:text-blue-100">
          <strong>{plural(top.hidden, 'more match', 'more matches')}</strong>
          {' '}hidden by your <strong>{top.label}</strong> filter.
        </span>
        <button
          type="button"
          onClick={() => onWiden?.(top)}
          className="tp-focus-ring text-xs font-semibold text-blue-700 dark:text-blue-300 underline decoration-blue-400/60 hover:decoration-blue-600"
          data-testid="filter-relief-inline-action"
        >
          {reliefActionLabel(top, statusesToAdd)}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 mx-auto max-w-md text-left" data-testid="filter-relief-empty">
      <div className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10 p-3.5">
        <p className="text-sm text-blue-900 dark:text-blue-100">
          <strong>{plural(top.hidden, 'ticket is', 'tickets are')}</strong> hidden by your{' '}
          <strong>{top.label}</strong> filter.
        </p>
        <button
          type="button"
          onClick={() => onWiden?.(top)}
          className="tp-focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          data-testid="filter-relief-primary"
        >
          <Filter className="w-3.5 h-3.5" aria-hidden="true" />
          {reliefActionLabel(top, statusesToAdd)} ({top.hidden.toLocaleString()})
        </button>

        {others.length > 0 && (
          <ul className="mt-2 space-y-1">
            {others.map((g) => (
              <li key={g.key}>
                <button
                  type="button"
                  onClick={() => onWiden?.(g)}
                  className="tp-focus-ring text-xs font-medium text-blue-700 dark:text-blue-300 underline decoration-blue-400/60 hover:decoration-blue-600"
                >
                  {reliefActionLabel(g, statusesToAdd)} ({g.hidden.toLocaleString()})
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* The escape hatch: drop every filter but keep what they typed. */}
        {totalHidden > top.hidden && (
          <button
            type="button"
            onClick={onClearFilters}
            className="tp-focus-ring mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 underline decoration-blue-400/60 hover:decoration-blue-600"
            data-testid="filter-relief-all"
          >
            <Search className="w-3.5 h-3.5" aria-hidden="true" />
            {hasQuery
              ? <>Search all tickets for &ldquo;{query}&rdquo; ({withoutFilters.toLocaleString()})</>
              : <>Show all tickets ({withoutFilters.toLocaleString()})</>}
          </button>
        )}
        <p className="mt-2 text-[11px] text-blue-900/70 dark:text-blue-100/70">
          Your search text is kept either way.
        </p>
      </div>
    </div>
  );
}
