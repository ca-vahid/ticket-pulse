import { useEffect, useRef, useState } from 'react';
import { Filter, Search, X } from 'lucide-react';

/**
 * Layout shell for a row of FilterDropdown buttons. Pure presentation —
 * filter state lives in the parent. Provides:
 *   - A leading "N filters active" pill when activeCount > 0
 *   - A debounced search input (250ms) that emits onSearchChange(value)
 *   - A trailing "Clear all" link when activeCount > 0
 *   - Slot for filter dropdown children, wrapped with flex-wrap so the bar
 *     gracefully wraps on narrow widths instead of horizontal-scrolling
 *
 * @param {object}   props
 * @param {React.ReactNode} props.children                FilterDropdown components
 * @param {number}   props.activeCount                    Count of non-default filters
 * @param {function} props.onClearAll                     Handler for the Clear all link
 * @param {string}   props.searchValue                    Controlled search text
 * @param {function} props.onSearchChange                 Debounced (string) => void
 * @param {string}   [props.searchPlaceholder='Search ticket, requester or #ID...']
 * @param {React.ReactNode} [props.trailing]              Optional trailing content rendered to the right (e.g. avatars/refresh buttons)
 */
export default function FilterBar({
  children,
  activeCount = 0,
  onClearAll,
  searchValue = '',
  onSearchChange,
  searchPlaceholder = 'Search ticket, requester or #ID...',
  trailing,
}) {
  // Local state for instant typing feedback; debounced commit to parent.
  const [localSearch, setLocalSearch] = useState(searchValue);
  const debounceRef = useRef(null);

  // Sync local state when parent value changes externally (e.g. URL hydration, Clear all)
  useEffect(() => {
    setLocalSearch(searchValue);
  }, [searchValue]);

  const handleSearch = (value) => {
    setLocalSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange?.(value);
    }, 250);
  };

  useEffect(() => () => debounceRef.current && clearTimeout(debounceRef.current), []);

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 py-1">
      {/* Search box — promoted to the leading slot and visually weightier than
          the dropdowns to reinforce that it's the highest-leverage control.
          Wider (w-64 sm:w-80), slightly taller, with a clear focus ring. */}
      {onSearchChange && (
        <div className="relative min-w-0 basis-full sm:basis-auto sm:shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full sm:w-80 rounded-lg border border-slate-200 bg-white py-2 sm:py-1.5 pl-8 pr-7 text-[12px] shadow-sm placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition-shadow"
          />
          {localSearch && (
            <button
              type="button"
              onClick={() => handleSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Lightweight filter indicator. The old heavy uppercase pill ("FILTERS"
          / "N active") read as a button; this inline icon + count is just a
          status cue, with no border or shadow competing with the dropdowns. */}
      <span
        className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${
          activeCount > 0 ? 'text-blue-700' : 'text-slate-400'
        }`}
        title={activeCount > 0 ? `${activeCount} filter${activeCount === 1 ? '' : 's'} active` : 'No filters applied'}
      >
        <Filter className="h-3.5 w-3.5" />
        {activeCount > 0 && (
          <span className="tabular-nums">{activeCount}</span>
        )}
      </span>

      {/* Filter dropdowns */}
      {children}

      {/* Clear all — only visible when filters are active */}
      {activeCount > 0 && onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          Clear all
        </button>
      )}

      {/* Push trailing content to the right */}
      {trailing && (
        <>
          <div className="hidden min-w-2 flex-1 sm:block" />
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">{trailing}</div>
        </>
      )}
    </div>
  );
}
