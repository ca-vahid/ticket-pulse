import { useState, useRef, useEffect, useMemo, useId } from 'react';
import { ChevronDown, Check, X, Search } from 'lucide-react';

/**
 * Standardized filter dropdown button used across the assignment-review filter bar.
 *
 * Renders as a single rounded pill button: `[icon] Label: <summary> ▾`. Clicking
 * opens a popover with radio (single) or checkbox (multi) options. Designed to
 * look identical for every filter type so the bar reads as a uniform row.
 *
 * @param {object}   props
 * @param {string}   props.label                    Short filter name (e.g. "Status")
 * @param {string|number|Array} props.value         Selected value (string/number for single, array for multi)
 * @param {Array}    props.options                  [{ id, label, count?, color?, avatarUrl?, hint?, dotClass? }]
 * @param {boolean}  [props.multi=false]            Multi-select with checkboxes
 * @param {function} props.onChange                 (newValue) => void — string for single, array for multi
 * @param {boolean}  [props.searchable]             Show search input (auto-on when options.length > 8)
 * @param {'left'|'right'} [props.align='left']     Popover horizontal alignment
 * @param {React.ComponentType} [props.icon]        Optional Lucide icon shown on the button
 * @param {string}   [props.placeholderWhenEmpty='any']  Shown when at default
 * @param {string}   [props.summaryFormatter]       Optional override (selected) => string
 * @param {boolean}  [props.disabled]
 */
export default function FilterDropdown({
  label,
  value,
  options = [],
  multi = false,
  onChange,
  searchable,
  align = 'left',
  icon: Icon,
  placeholderWhenEmpty = 'any',
  summaryFormatter,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const popoverId = useId();

  const showSearch = searchable ?? options.length > 8;

  const selectedSet = useMemo(() => {
    if (multi) return new Set((value || []).map(String));
    return value != null ? new Set([String(value)]) : new Set();
  }, [value, multi]);

  const isAtDefault = multi
    ? !value || value.length === 0
    : value == null || value === '' || value === 'all';

  const summary = useMemo(() => {
    if (summaryFormatter) return summaryFormatter(value);
    if (isAtDefault) return placeholderWhenEmpty;
    if (multi) {
      const selected = options.filter((o) => selectedSet.has(String(o.id)));
      if (selected.length === 1) return selected[0].label;
      if (selected.length === options.length && options.length > 0) return 'all';
      return `${selected.length} selected`;
    }
    const found = options.find((o) => String(o.id) === String(value));
    return found ? found.label : String(value);
  }, [value, options, multi, selectedSet, isAtDefault, placeholderWhenEmpty, summaryFormatter]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && showSearch) {
      // Defer focus until after popover paints so the input can grab focus reliably
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
    if (!isOpen) setSearch('');
  }, [isOpen, showSearch]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint || '').toLowerCase().includes(q));
  }, [options, search]);

  const handleSelect = (optId) => {
    if (multi) {
      const key = String(optId);
      const current = new Set((value || []).map(String));
      if (current.has(key)) current.delete(key);
      else current.add(key);
      // Preserve original type (number vs string) by mapping back through options
      const next = options
        .filter((o) => current.has(String(o.id)))
        .map((o) => o.id);
      onChange(next);
    } else {
      onChange(optId);
      setIsOpen(false);
    }
  };

  const handleClear = (e) => {
    e?.stopPropagation();
    onChange(multi ? [] : 'all');
  };

  return (
    <div className="relative inline-flex shrink-0" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm transition-colors touch-manipulation ${
          isAtDefault
            ? 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
            : 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="text-slate-500">{label}:</span>
        <span className="font-semibold">{summary}</span>
        {multi && Array.isArray(value) && value.length > 0 && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[9px] font-bold text-white tabular-nums">
            {value.length}
          </span>
        )}
        <ChevronDown className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          id={popoverId}
          role="listbox"
          aria-multiselectable={multi}
          className={`absolute top-full z-[60] mt-1 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl ring-1 ring-slate-900/5 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {showSearch && (
            <div className="border-b border-slate-100 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}...`}
                  className="w-full rounded border border-slate-200 bg-slate-50 py-1 pl-7 pr-2 text-[11px] focus:border-blue-400 focus:bg-white focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto py-1">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-slate-400">No matches</div>
            ) : (
              filteredOptions.map((opt) => {
                const checked = selectedSet.has(String(opt.id));
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => handleSelect(opt.id)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                      checked ? 'bg-blue-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                        multi ? 'border' : 'rounded-full border'
                      } ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'}`}
                    >
                      {checked && (multi ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-white" />)}
                    </span>

                    {opt.avatarUrl ? (
                      <img
                        src={opt.avatarUrl}
                        alt=""
                        className="h-5 w-5 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
                      />
                    ) : opt.dotClass ? (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${opt.dotClass}`} />
                    ) : null}

                    <span className={`flex-1 truncate ${checked ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>
                      {opt.label}
                    </span>

                    {opt.count != null && (
                      <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{opt.count}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {!isAtDefault && (
            <div className="border-t border-slate-100 p-1.5">
              <button
                type="button"
                onClick={handleClear}
                className="flex w-full items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              >
                <X className="h-3 w-3" />
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
