import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

/**
 * A filter you can type in (30 Sep 2026, Knowledge → Articles): a text box
 * that narrows a list of options as you type, arrow keys + Enter to pick,
 * Escape to close, × to clear. `options` = [{ value, label, hint? }].
 * `loadOptions(query)` (optional) fetches options as you type instead
 * (e.g. topics from the server). Empty value = "all".
 */
export default function SearchSelect({
  value = '',
  onChange,
  options = [],
  loadOptions = null,
  placeholder = 'Type to filter…',
  allLabel = 'All',
  className = '',
  'aria-label': ariaLabel,
  'data-testid': testId,
}) {
  const id = useId();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState(null);

  const current = useMemo(
    () => [...options, ...(remote || [])].find((o) => String(o.value) === String(value)) || (value ? { value, label: String(value) } : null),
    [options, remote, value],
  );

  useEffect(() => {
    if (!loadOptions || !open) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => loadOptions(text.trim()))
        .then((list) => { if (!cancelled) setRemote(Array.isArray(list) ? list : []); })
        .catch(() => { if (!cancelled) setRemote([]); });
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [loadOptions, text, open]);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = loadOptions ? (remote || []) : options;
    return q ? list.filter((o) => `${o.label} ${o.hint || ''}`.toLowerCase().includes(q)) : list;
  }, [text, options, remote, loadOptions]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (o) => {
    onChange?.(o ? o.value : '');
    setText('');
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { if (open && shown[active]) { e.preventDefault(); pick(shown[active]); } }
    else if (e.key === 'Escape') { setOpen(false); setText(''); }
  };

  const listId = `${id}-list`;
  return (
    <div ref={rootRef} className={`relative ${className}`} data-testid={testId}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={open ? text : (current?.label || '')}
        placeholder={current ? current.label : (open ? placeholder : allLabel)}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
        className="tp-focus-ring h-10 w-full rounded-lg border border-input bg-card pl-3 pr-14 text-sm text-foreground placeholder:text-muted-foreground/75"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/75">
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </span>
      {value !== '' && value !== null && value !== undefined && (
        <button
          type="button"
          onClick={() => pick(null)}
          aria-label={`Clear ${ariaLabel || 'filter'}`}
          className="tp-focus-ring absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/75 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="settings-scrollbar absolute left-0 right-0 top-11 z-30 max-h-72 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-soft animate-scaleIn"
        >
          <li
            role="option"
            aria-selected={!value}
            onMouseDown={(e) => { e.preventDefault(); pick(null); }}
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/60"
          >
            {allLabel}
          </li>
          {shown.length === 0 ? (
            <li className="px-2.5 py-1.5 text-sm text-muted-foreground/75">{loadOptions && remote === null ? 'Loading…' : 'Nothing matches'}</li>
          ) : shown.map((o, i) => (
            <li
              key={`${o.value}`}
              role="option"
              aria-selected={String(o.value) === String(value)}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm ${i === active ? 'bg-muted' : 'hover:bg-muted/60'} ${String(o.value) === String(value) ? 'font-medium text-primary' : 'text-foreground/85'}`}
            >
              <span className="min-w-0 truncate">{o.label}</span>
              {o.hint && <span className="flex-shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
