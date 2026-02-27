import { useState, useRef, useEffect } from 'react';
import { Filter, X, Check } from 'lucide-react';

// ── Shared filtering utilities ────────────────────────────────────────────────

/** Parse a `|`-delimited OR string into trimmed lowercase terms */
export function parseTerms(text) {
  if (!text?.trim()) return [];
  return text.split('|').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Apply INCLUDE-only filters to a picked ticket.
 * Exclude filters are never applied to picked tickets — you never want to hide
 * something the tech actually picked up.
 * Returns true if the ticket should be visible.
 */
export function applyPickedFilters(ticket, { includeCats, includeText }) {
  const hay = (ticket.subject || '').toLowerCase();
  const inTerms = parseTerms(includeText);

  if (includeCats.size > 0 && !includeCats.has(ticket.ticketCategory)) return false;
  if (inTerms.length > 0 && !inTerms.some((t) => hay.includes(t))) return false;
  return true;
}

/**
 * Apply exclude + include filters to a single not-picked ticket.
 * Returns true if the ticket should be visible.
 *
 * Exclude text/cats:  ticket is hidden if it matches any term
 * Include text/cats:  ticket is hidden if it does NOT match (when filter is set)
 * Both sides support | OR syntax in text inputs.
 */
export function applyNotPickedFilters(ticket, { excludeCats, excludeText, includeCats, includeText }) {
  const hay = (ticket.subject || '').toLowerCase();
  const exTerms = parseTerms(excludeText);
  const inTerms = parseTerms(includeText);

  if (excludeCats.size > 0 && excludeCats.has(ticket.ticketCategory)) return false;
  if (exTerms.length > 0 && exTerms.some((t) => hay.includes(t))) return false;
  if (includeCats.size > 0 && !includeCats.has(ticket.ticketCategory)) return false;
  if (inTerms.length > 0 && !inTerms.some((t) => hay.includes(t))) return false;
  return true;
}

// ── Category dropdown ─────────────────────────────────────────────────────────

function CategoryDropdown({ mode, categories, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const count = selected.size;
  const isExclude = mode === 'exclude';

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap ${
          count > 0
            ? isExclude
              ? 'bg-red-50 text-red-700 border-red-300'
              : 'bg-emerald-50 text-emerald-700 border-emerald-300'
            : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'
        }`}
      >
        <Filter className="w-3 h-3" />
        {isExclude ? 'Exclude' : 'Include'}
        {count > 0 && (
          <span
            className={`rounded-full w-4 h-4 text-[9px] flex items-center justify-center font-bold ${
              isExclude ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
            }`}
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 z-[60] bg-white border border-slate-200 rounded-xl shadow-xl p-2 w-64 ${
            isExclude ? 'left-0' : 'right-0'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              {isExclude ? 'Exclude categories' : 'Include only'}
            </span>
            {count > 0 && (
              <button
                onClick={onClear}
                className="text-[10px] text-slate-400 hover:text-red-500 font-medium"
              >
                Clear
              </button>
            )}
          </div>
          {categories.length === 0 ? (
            <p className="text-xs text-slate-300 text-center py-3">No categories</p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-0.5">
              {categories.map((cat) => {
                const isSel = selected.has(cat);
                return (
                  <button
                    key={cat}
                    onClick={() => onToggle(cat)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors ${
                      isSel
                        ? isExclude
                          ? 'bg-red-50 text-red-700'
                          : 'bg-emerald-50 text-emerald-700'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                        isSel
                          ? isExclude
                            ? 'bg-red-500 border-red-500'
                            : 'bg-emerald-500 border-emerald-500'
                          : 'border-slate-300'
                      }`}
                    >
                      {isSel && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <span className="truncate flex-1">{cat}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function FilterBar({
  allCategories,
  excludeCats,
  setExcludeCats,
  excludeText,
  setExcludeText,
  includeCats,
  setIncludeCats,
  includeText,
  setIncludeText,
}) {
  const toggle = (setter) => (cat) =>
    setter((prev) => {
      const n = new Set(prev);
      n.has(cat) ? n.delete(cat) : n.add(cat);
      return n;
    });

  const hasAny = excludeCats.size > 0 || excludeText || includeCats.size > 0 || includeText;

  return (
    <div className="flex items-center gap-2">
      {/* Exclude side */}
      <CategoryDropdown
        mode="exclude"
        categories={allCategories}
        selected={excludeCats}
        onToggle={toggle(setExcludeCats)}
        onClear={() => setExcludeCats(new Set())}
      />
      <div className="relative flex-1">
        <input
          type="text"
          value={excludeText}
          onChange={(e) => setExcludeText(e.target.value)}
          placeholder="Exclude keywords… (use | for OR)"
          className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs placeholder-slate-300 focus:ring-1 focus:ring-red-300 focus:border-red-300"
        />
        {excludeText && (
          <button
            onClick={() => setExcludeText('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          >
            <X className="w-3 h-3 text-slate-400 hover:text-slate-600" />
          </button>
        )}
      </div>

      <div className="w-px h-5 bg-slate-200 flex-shrink-0" />

      {/* Include side */}
      <div className="relative flex-1">
        <input
          type="text"
          value={includeText}
          onChange={(e) => setIncludeText(e.target.value)}
          placeholder="Include only… (use | for OR)"
          className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs placeholder-slate-300 focus:ring-1 focus:ring-emerald-300 focus:border-emerald-300"
        />
        {includeText && (
          <button
            onClick={() => setIncludeText('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          >
            <X className="w-3 h-3 text-slate-400 hover:text-slate-600" />
          </button>
        )}
      </div>
      <CategoryDropdown
        mode="include"
        categories={allCategories}
        selected={includeCats}
        onToggle={toggle(setIncludeCats)}
        onClear={() => setIncludeCats(new Set())}
      />

      {hasAny && (
        <button
          onClick={() => {
            setExcludeCats(new Set());
            setExcludeText('');
            setIncludeCats(new Set());
            setIncludeText('');
          }}
          className="px-2 py-1.5 text-[10px] font-medium text-slate-400 hover:text-red-500 whitespace-nowrap hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-200"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
