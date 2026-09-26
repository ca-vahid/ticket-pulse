import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * A select that opens like the assignee picker (16 Sep 2026): the native
 * <select> popup cannot animate, so the ticket page's Status / Priority / Type
 * / Source / Category / Group fields snapped while everything else eased in.
 *
 * Same contract as a controlled <select>: `value`, `onChange(nextValue)` with
 * the option's value (a string, like the DOM), `disabled`, `aria-label`.
 * Options: [{ value, label, group?, disabled?, hint?, dot?, icon? }] — `group` renders
 * an optgroup-style heading; `dot` a coloured swatch (status / priority);
 * `icon` a small leading node (e.g. a person's avatar).
 * Keyboard: Enter / Space / ArrowDown open, arrows move, Enter picks, Escape
 * closes, type-ahead on the first letters. Portal-positioned so it escapes
 * overflow-hidden cards, flips above when the viewport runs out.
 */
export default function FancySelect({
  value,
  onChange,
  options = [],
  disabled = false,
  className = '',
  placeholder = '—',
  title,
  'aria-label': ariaLabel,
  'data-testid': testId,
  renderValue,
}) {
  const id = useId();
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null);
  const typeahead = useRef({ text: '', at: 0 });

  const flat = useMemo(() => options.filter((o) => o && o.value !== undefined), [options]);
  const current = flat.find((o) => String(o.value) === String(value ?? '')) || null;
  const selectable = (i) => flat[i] && !flat[i].disabled;

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const wanted = Math.min(320, 40 + flat.length * 34);
    const below = vh - r.bottom - 8;
    const flip = below < wanted && r.top > below;
    setPos({
      left: r.left,
      width: r.width,
      top: flip ? undefined : r.bottom + 4,
      bottom: flip ? vh - r.top + 4 : undefined,
      maxHeight: Math.max(160, Math.min(320, (flip ? r.top : below) - 8)),
    });
  };
  useLayoutEffect(() => { if (open) place(); }, [open, flat.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); } };
    const onMove = () => place();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const idx = flat.findIndex((o) => String(o.value) === String(value ?? ''));
    setActive(idx >= 0 ? idx : flat.findIndex((_, i) => selectable(i)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const pick = (o) => {
    if (!o || o.disabled) return;
    setOpen(false);
    if (String(o.value) !== String(value ?? '')) onChange?.(String(o.value));
    btnRef.current?.focus();
  };
  const step = (dir) => {
    let i = active;
    for (let n = 0; n < flat.length; n += 1) {
      i = (i + dir + flat.length) % flat.length;
      if (selectable(i)) { setActive(i); return; }
    }
  };
  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(flat.findIndex((_, i) => selectable(i))); }
    else if (e.key === 'End') { e.preventDefault(); for (let i = flat.length - 1; i >= 0; i -= 1) if (selectable(i)) { setActive(i); break; } }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(flat[active]); }
    else if (e.key === 'Tab') { setOpen(false); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const idx = flat.findIndex((o, i) => selectable(i) && String(o.label).toLowerCase().startsWith(t.text));
      if (idx >= 0) setActive(idx);
    }
  };

  // Group headings: emitted the first time a group name appears, in option order.
  const rows = [];
  let lastGroup = null;
  flat.forEach((o, i) => {
    if (o.group && o.group !== lastGroup) { rows.push({ heading: o.group, key: `g-${o.group}` }); lastGroup = o.group; }
    if (!o.group) lastGroup = null;
    rows.push({ option: o, idx: i, key: `o-${o.value}` });
  });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        disabled={disabled}
        title={title}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        data-testid={testId}
        data-value={value ?? ''}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        onKeyDown={onKeyDown}
        className={`tp-focus-ring group/fs flex w-full items-center gap-2 text-left text-sm bg-card border border-input rounded-lg px-2.5 py-1.5 text-foreground/85 transition-colors hover:border-blue-300 dark:hover:border-blue-500/40 disabled:bg-muted/50 disabled:text-muted-foreground/75 disabled:cursor-not-allowed disabled:hover:border-input ${open ? 'border-blue-400 dark:border-blue-500/60 ring-2 ring-blue-100 dark:ring-blue-500/20' : ''} ${className}`}
      >
        {current?.dot && <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${current.dot}`} />}
        {current?.icon && !renderValue && <span aria-hidden="true" className="flex flex-shrink-0 items-center">{current.icon}</span>}
        <span className={`min-w-0 flex-1 truncate ${current ? '' : 'text-muted-foreground/75'}`}>
          {renderValue ? renderValue(current) : (current?.label ?? placeholder)}
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-muted-foreground/75 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, transformOrigin: pos.bottom != null ? 'bottom center' : 'top center' }}
          className="z-[60] overflow-y-auto settings-scrollbar tp-card rounded-xl shadow-soft p-1.5 animate-popIn"
        >
          {rows.map((r) => (r.heading ? (
            <li key={r.key} role="presentation" className="px-2.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 select-none">
              {r.heading}
            </li>
          ) : (
            <li
              key={r.key}
              id={`${id}-opt-${r.idx}`}
              role="option"
              data-idx={r.idx}
              aria-selected={current === r.option}
              aria-disabled={r.option.disabled || undefined}
              title={r.option.hint || undefined}
              onMouseEnter={() => { if (!r.option.disabled) setActive(r.idx); }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r.option)}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer select-none ${
                r.option.disabled ? 'text-muted-foreground/50 cursor-not-allowed'
                  : r.idx === active ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200'
                    : 'text-foreground/85'
              }`}
            >
              {r.option.dot && <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${r.option.dot}`} />}
              {r.option.icon && <span aria-hidden="true" className="flex flex-shrink-0 items-center">{r.option.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{r.option.label}</span>
              {current === r.option && <Check className="h-3.5 w-3.5 flex-shrink-0 text-blue-600 dark:text-blue-300" aria-hidden="true" />}
            </li>
          )))}
        </ul>,
        document.body,
      )}
    </>
  );
}
