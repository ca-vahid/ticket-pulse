import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';

/**
 * Toolbar filter button that opens a small flyout panel. Shows an active dot +
 * count when the filter is applied; flips alignment near the viewport edge.
 */
export function FilterFlyout({ label, activeCount = 0, onClear, children, width = 'w-64' }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setAlignRight(rect.left + 288 > window.innerWidth - 16);
  }, [open]);

  const active = activeCount > 0;
  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`tp-focus-ring relative inline-flex items-center gap-1 text-sm rounded-lg px-2.5 py-2 border transition-colors ${
          active ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30 font-medium' : 'bg-card text-foreground/85 border-input hover:border-blue-300 dark:hover:border-blue-500/40'
        }`}
      >
        {label}
        {active && <span className="text-xs font-semibold">· {activeCount}</span>}
        <ChevronDown className={`w-3.5 h-3.5 ${active ? 'text-blue-500' : 'text-muted-foreground/75'}`} aria-hidden="true" />
        {active && <span aria-hidden="true" className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-500" />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} filter`}
          className={`absolute top-full mt-1 z-30 ${alignRight ? 'right-0' : 'left-0'} ${width} tp-card rounded-lg shadow-soft p-2 animate-scaleIn`}
        >
          {children}
          {onClear && active && (
            <button
              onClick={() => { onClear(); setOpen(false); }}
              className="tp-focus-ring mt-1.5 w-full text-center px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15 rounded-md border-t border-border/60"
            >
              Clear {label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Multi-select checkbox list for a flyout, with optional search for long lists. */
export function CheckList({ options, selected, onToggle, searchable = false, emptyLabel = 'No options' }) {
  const [q, setQ] = useState('');
  const norm = q.trim().toLowerCase();
  const filtered = norm ? options.filter((o) => String(o.label).toLowerCase().includes(norm)) : options;
  return (
    <div>
      {searchable && (
        <div className="relative mb-1.5">
          <Search className="w-3.5 h-3.5 text-muted-foreground/75 absolute left-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label="Search options"
            className="tp-focus-ring w-full pl-7 pr-2 py-1.5 text-xs bg-card border border-input rounded-md placeholder:text-muted-foreground/75"
          />
        </div>
      )}
      <ul className="max-h-56 overflow-y-auto settings-scrollbar -mx-0.5">
        {filtered.map((o) => (
          <li key={o.value}>
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-blue-50 dark:hover:bg-blue-500/15 cursor-pointer text-sm text-foreground/85">
              <input
                type="checkbox"
                checked={selected.includes(String(o.value))}
                onChange={() => onToggle(String(o.value))}
                className="tp-focus-ring rounded border-input text-blue-600 dark:text-blue-300"
              />
              <span className="truncate flex-1">{o.label}</span>
              {o.count != null && <span className="text-[10px] text-muted-foreground/75 tabular-nums">{o.count}</span>}
            </label>
          </li>
        ))}
        {filtered.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground/75">{emptyLabel}</li>}
      </ul>
    </div>
  );
}
