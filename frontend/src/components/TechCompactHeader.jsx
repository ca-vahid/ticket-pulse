import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { getCompactColumns, getCompactGridTemplate } from './compactLayout';

/**
 * Sticky column header for the compact technician table.
 * Mirrors the CSS Grid template used by TechCardCompact so columns line up
 * exactly. Click a sortable header to sort the table; click again to flip
 * direction.
 *
 * Sticky offset — `.tp-compact-sticky` (index.css, beside `.tp-compact-scroll`):
 *   - Below 1100px the wrapper is `overflow-x:auto` (QA 08-04 #3), which makes
 *     it a SCROLL CONTAINER: `position:sticky` then resolves against the
 *     wrapper, not the page. Any positive `top` there parks the header that
 *     many px below the wrapper's top edge — i.e. over the first technician
 *     row (QA 09-01 #1, 49px of a 58px row hidden on iPad). So `top:0`; the
 *     wrapper never scrolls vertically, so there is nothing to dock under.
 *   - From 1100px the wrapper's overflow is visible again and the header
 *     docks under the app <header> at `var(--tp-app-header-h, 53px)` — the
 *     measured height, published by AppHeader (a ResizeObserver keeps it
 *     honest; the fallback is the desktop bar's resting height, NOT the old
 *     57px guess that left a 4px see-through strip).
 *   Phones (<sm) never render this table — the cards view takes over.
 *
 * z-index: the app header is z-40; z-30 keeps the column header under it and
 * above the rows. Nothing else competes for this slot (the purple stats
 * banner stopped being sticky long ago).
 */
export default function TechCompactHeader({ viewMode, sortField, sortDirection, onSort, simple = false }) {
  const columns = getCompactColumns(viewMode, simple);
  const gridTemplate = getCompactGridTemplate(viewMode, simple);
  // Simple style uses full-word labels ("Sent by a coordinator") that need to
  // wrap to two lines; detailed keeps the tight single-line caps style.
  const labelClass = simple
    ? 'text-[10px] normal-case font-semibold leading-tight'
    : 'text-[10px] uppercase font-semibold tracking-wide';

  const handleClick = (col) => {
    if (!col.sortable) return;
    if (sortField === col.key) {
      onSort(col.key, sortDirection === 'desc' ? 'asc' : 'desc');
    } else {
      // First click on a numeric column should usually sort high → low; for
      // the alphabetical name column, default to A → Z.
      onSort(col.key, col.key === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <div data-testid="tech-compact-header" className="tp-compact-sticky z-30 mb-2 -mx-1 px-1">
      <div
        className="grid items-center gap-3 px-3 py-2 bg-card/95 backdrop-blur-md border border-border rounded-lg shadow-md"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((col) => {
          const isActive = sortField === col.key;
          const alignClass =
            col.align === 'center' ? 'justify-center text-center' : 'justify-start text-left';

          if (!col.sortable) {
            return (
              <div
                key={col.key}
                className={`flex items-center ${alignClass} ${labelClass} text-muted-foreground select-none`}
              >
                {col.label}
              </div>
            );
          }

          return (
            <button
              key={col.key}
              type="button"
              onClick={() => handleClick(col)}
              className={`flex items-center gap-1 ${alignClass} ${labelClass} rounded px-1 py-0.5 hover:bg-muted transition-colors select-none ${
                isActive ? 'text-blue-600 dark:text-blue-300' : 'text-muted-foreground'
              }`}
              title={`Sort by ${col.label}${isActive ? ` (${sortDirection === 'desc' ? 'high → low' : 'low → high'})` : ''}`}
            >
              <span>{col.label}</span>
              {isActive ? (
                sortDirection === 'desc' ? (
                  <ArrowDown className="w-3 h-3" />
                ) : (
                  <ArrowUp className="w-3 h-3" />
                )
              ) : (
                <ArrowUpDown className="w-3 h-3 opacity-40" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
