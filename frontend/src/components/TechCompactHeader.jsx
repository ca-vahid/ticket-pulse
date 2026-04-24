import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { getCompactColumns, getCompactGridTemplate } from './compactLayout';

/**
 * Sticky column header for the compact technician table.
 * Mirrors the CSS Grid template used by TechCardCompact so columns line up
 * exactly. Click a sortable header to sort the table; click again to flip
 * direction.
 *
 * Sticky offset:
 *   - Mobile: top-[52px] — just below the mobile page <header> (banner not sticky).
 *   - Desktop (md+): top-[88px] — just below the white app <header>. The purple
 *     stats banner used to be sticky too (and we'd dock under it at top-[196px]),
 *     but the banner now scrolls away with the page, so we only need to clear
 *     the app header.
 *
 * z-index: matches the app header's z-40 baseline minus 10. The banner (when
 * it was sticky) used z-30; we keep z-30 here since nothing else competes
 * for this slot once the banner is non-sticky.
 */
export default function TechCompactHeader({ viewMode, sortField, sortDirection, onSort }) {
  const columns = getCompactColumns(viewMode);
  const gridTemplate = getCompactGridTemplate(viewMode);

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
    <div className="sticky top-[52px] md:top-[88px] z-30 mb-2 -mx-1 px-1">
      <div
        className="grid items-center gap-3 px-3 py-2 bg-white/95 backdrop-blur-md border border-gray-200 rounded-lg shadow-md"
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
                className={`flex items-center ${alignClass} text-[10px] uppercase font-semibold text-gray-500 tracking-wide select-none`}
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
              className={`flex items-center gap-1 ${alignClass} text-[10px] uppercase font-semibold tracking-wide rounded px-1 py-0.5 hover:bg-gray-100 transition-colors select-none ${
                isActive ? 'text-blue-600' : 'text-gray-500'
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
