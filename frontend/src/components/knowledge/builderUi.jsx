import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Info, MoreVertical, X } from 'lucide-react';

/**
 * Building blocks of the Knowledge redesign (26 Sep 2026, from the outside
 * artist's mockup): the numbered section card, the header-card icon tile and
 * status badge, token chips, small help popovers, info tips, menus (⋮, the
 * split Save button, the mode control) and the tab-row action slot.
 * Chips and status badges are allowed in Knowledge (Vahid, 26 Sep 2026).
 */

// ---------- tab-row actions ----------

/** Knowledge.jsx provides the DOM node at the right end of the tab row. */
export const TabActionsContext = createContext(null);

/** Renders its children into the tab row (the open tab's page actions). */
export function TabActions({ children }) {
  const node = useContext(TabActionsContext);
  if (!node) return null;
  return createPortal(children, node);
}

// ---------- header card pieces ----------

const TILE_TONES = {
  primary: 'bg-blue-50 text-primary ring-blue-100 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/20',
  violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-400/20',
  amber: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/20',
  muted: 'bg-muted text-muted-foreground ring-border',
};

export function IconTile({ icon: Icon, tone = 'primary', size = 'lg', className = '' }) {
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'md' ? 'h-10 w-10 rounded-xl' : 'h-8 w-8 rounded-lg';
  const glyph = size === 'lg' ? 'h-7 w-7' : size === 'md' ? 'h-5 w-5' : 'h-4 w-4';
  return (
    <span className={`inline-flex flex-shrink-0 items-center justify-center ring-1 ${box} ${TILE_TONES[tone] || TILE_TONES.primary} ${className}`} aria-hidden="true">
      <Icon className={glyph} strokeWidth={1.75} />
    </span>
  );
}

const BADGE_TONES = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/25',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/25',
  info: 'bg-blue-50 text-blue-700 ring-blue-200/70 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/25',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200/70 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-400/25',
  muted: 'bg-muted text-muted-foreground ring-border',
};
const DOT_TONES = { success: 'bg-emerald-500', warning: 'bg-amber-500', info: 'bg-blue-500', violet: 'bg-violet-500', muted: 'bg-muted-foreground/60' };

/** A small status badge with a dot (Active / Off / Published / Draft / Sample). */
export function StatusBadge({ tone = 'muted', children, icon: Icon = null, className = '', testId = undefined }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone] || BADGE_TONES.muted} ${className}`}
      data-testid={testId}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONES[tone] || DOT_TONES.muted}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** The header card's meta row: items separated by a hairline. */
export function MetaRow({ children, className = '' }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground sm:gap-x-0 ${className}`}>
      {items.map((item, i) => (
        <span key={i} className={`inline-flex min-w-0 items-center ${i ? 'sm:ml-3 sm:border-l sm:border-border sm:pl-3' : ''}`}>{item}</span>
      ))}
    </div>
  );
}

/**
 * The header card's title: looks like a heading, edits like a field, and
 * grows to more lines instead of cutting a long name off on a phone.
 */
export function TitleField({ id, value, onChange, readOnly = false, placeholder, maxLength = 200, ariaLabel }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
      className="tp-focus-ring -mx-1.5 mt-0.5 block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xl font-semibold leading-tight text-foreground placeholder:text-muted-foreground/60 hover:border-input focus:border-input sm:text-2xl"
    />
  );
}

// ---------- numbered sections ----------

/**
 * One numbered step of a builder: a card with the step number in a soft
 * circle, a title, one line of context and an optional action (a help link)
 * at the right; the body sits under the title, aligned with it on wide
 * screens.
 */
export function NumberedSection({
  n, id, title, description = null, action = null, children, className = '', testId = undefined,
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className={`tp-card p-4 sm:p-5 ${className}`} data-testid={testId}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-primary ring-1 ring-blue-100 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/20" aria-hidden="true">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-semibold leading-8 text-foreground">
            <span className="sr-only">{`Step ${n}: `}</span>{title}
          </h2>
          {description && <p className="-mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="w-full sm:ml-auto sm:w-auto">{action}</div>}
      </div>
      <div className="mt-4 sm:pl-11">{children}</div>
    </section>
  );
}

export const fieldLabel = 'mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-foreground/90';
export const fieldHint = 'mt-1.5 text-xs leading-relaxed text-muted-foreground';

// ---------- small popovers ----------

function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (refs.some((r) => r.current && r.current.contains(e.target))) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(true); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]); // eslint-disable-line react-hooks/exhaustive-deps -- refs are stable
}

/**
 * A secondary help link ("Learn how matching works") that opens a small,
 * non-modal popover. Escape or a click outside closes it; focus returns to
 * the link.
 */
export function HelpPopover({ label, icon: Icon = null, title, children, align = 'right', testId = undefined }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);
  const id = useId();
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  useDismiss(open, close, [btn, panel]);
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  return (
    <div className="relative inline-block">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-200/80 bg-blue-50/60 px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-400/25 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/15"
        data-testid={testId}
      >
        {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
        {label}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={title || label}
          tabIndex={-1}
          className={`absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-4 text-left shadow-soft animate-scaleIn focus:outline-none ${align === 'left' ? 'left-0' : 'left-0 sm:left-auto sm:right-0'}`}
        >
          <div className="mb-2 flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">{title || label}</p>
            <button type="button" onClick={() => close(true)} aria-label="Close" className="tp-focus-ring -mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
        </div>
      )}
    </div>
  );
}

/** An (i) that explains a field on hover or focus. */
export function InfoTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="tp-focus-ring inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-40 mb-2 w-60 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-normal leading-relaxed text-white shadow-soft animate-fadeIn dark:bg-slate-700"
        >
          {children}
        </span>
      )}
    </span>
  );
}

// ---------- menus ----------

/**
 * A menu button (⋮, a split button's chevron, the mode control). Items:
 * [{ id, label, hint?, icon?, onSelect, disabled?, destructive?, checked? }]
 * (`checked` makes it a menuitemradio). Arrow keys move, Home/End jump,
 * Enter/Space pick, Escape closes and returns focus, Tab closes.
 */
export function Menu({
  items, label, align = 'right', children, buttonClassName = '', testId = undefined, menuClassName = 'w-64', disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  useDismiss(open, close, [btn, menu]);
  const enabled = () => [...(menu.current?.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])') || [])];
  useEffect(() => {
    if (!open) return;
    const list = enabled();
    const checked = list.find((el) => el.getAttribute('aria-checked') === 'true');
    (checked || list[0])?.focus();
  }, [open]);

  const onMenuKey = (e) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="relative inline-flex">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        className={buttonClassName || 'tp-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50'}
        data-testid={testId}
      >
        {children || <MoreVertical className="h-4 w-4" aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className={`absolute top-full z-50 mt-1.5 rounded-xl border border-border bg-card p-1 shadow-soft animate-scaleIn ${align === 'left' ? 'left-0' : 'right-0'} ${menuClassName}`}
        >
          {items.filter(Boolean).map((item) => {
            const Icon = item.icon;
            const radio = item.checked !== undefined;
            return (
              <button
                key={item.id}
                type="button"
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? item.checked : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                onClick={() => {
                  if (item.disabled) return;
                  close(!item.keepFocusOut);
                  item.onSelect?.();
                }}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm focus:bg-muted focus:outline-none ${
                  item.disabled ? 'cursor-not-allowed text-muted-foreground/60' : item.destructive ? 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/15' : 'text-foreground hover:bg-muted'
                }`}
              >
                {radio ? (
                  <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">{item.checked && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}</span>
                ) : Icon ? <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 opacity-80" aria-hidden="true" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    {radio && Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
                    {item.label}
                  </span>
                  {item.hint && <span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground">{item.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Primary action + a chevron menu of alternatives, joined. */
export function SplitButton({
  label, onClick, disabled = false, busy = false, icon: Icon = null, items, menuLabel, testId = undefined,
}) {
  return (
    <div className="inline-flex rounded-lg shadow-sm" data-testid={testId}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="tp-focus-ring inline-flex h-9 items-center gap-2 rounded-l-lg bg-primary pl-3.5 pr-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {Icon && <Icon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />}
        {label}
      </button>
      <Menu
        items={items}
        label={menuLabel}
        disabled={disabled}
        menuClassName="w-56"
        buttonClassName="tp-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-r-lg border-l border-primary-foreground/25 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </Menu>
    </div>
  );
}

// ---------- token chips ----------

/** "a, b\nc" → ['a','b','c'] (trimmed, no blanks). */
export function splitTokens(text) {
  return String(text || '').split(/[\n,;]/).map((w) => w.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Terms as chips. Type and press Enter or a comma to add; × (or Backspace
 * in the empty box) removes; pasting "a, b, c" adds each. Duplicates are
 * ignored case-insensitively; a half-typed term is added when the box loses
 * focus, so nothing typed is lost on Save.
 */
export function TokenInput({
  id, values = [], onChange, placeholder = 'Type a term and press Enter…', disabled = false, max = 30, maxLength = 80,
  describedBy = undefined, label, testId = undefined, minRows = 2,
}) {
  const [draft, setDraft] = useState('');
  const input = useRef(null);
  const add = (terms) => {
    const next = [...values];
    for (const raw of terms) {
      const t = raw.slice(0, maxLength);
      if (t && !next.some((x) => x.toLowerCase() === t.toLowerCase()) && next.length < max) next.push(t);
    }
    if (next.length !== values.length) onChange(next);
  };
  const commit = () => {
    const terms = splitTokens(draft);
    if (terms.length) add(terms);
    setDraft('');
  };
  const remove = (i) => onChange(values.filter((_, j) => j !== i));
  return (
    <div
      className={`flex flex-wrap content-start items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-2 transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:border-blue-500/60 dark:focus-within:ring-blue-500/20 ${disabled ? 'opacity-70' : 'cursor-text'}`}
      style={{ minHeight: `${minRows * 2 + 1}rem` }}
      onMouseDown={(e) => { if (!disabled && e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}
      data-testid={testId}
    >
      <ul className="contents" aria-label={label ? `${label}: ${values.length} term${values.length === 1 ? '' : 's'}` : undefined}>
        {values.map((v, i) => (
          <li key={`${v}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/60 py-0.5 pl-2 pr-0.5 text-[13px] text-foreground/90">
            <span className="truncate">{v}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${v}`}
                className="tp-focus-ring inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <input
          ref={input}
          id={id}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]/.test(v)) {
              const parts = v.split(/[,;]/);
              const rest = parts.pop();
              add(parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean));
              setDraft(rest.trimStart());
            } else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && !draft && values.length) remove(values.length - 1);
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData('text') || '';
            if (/[,;\n]/.test(text)) {
              e.preventDefault();
              add(splitTokens(`${draft}${text}`));
              setDraft('');
            }
          }}
          onBlur={commit}
          placeholder={values.length ? 'Add another…' : placeholder}
          aria-label={id ? undefined : label}
          aria-describedby={describedBy}
          className="h-7 min-w-[9rem] flex-1 bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        />
      )}
    </div>
  );
}

// ---------- segmented tabs (the side panel) ----------

/**
 * A compact WAI-ARIA tablist for a panel ("Test on a ticket" / "Preview
 * answer" / "Backtest"). Panels are rendered by the caller with
 * id `${idPrefix}-panel-${id}` and aria-labelledby `${idPrefix}-tab-${id}`.
 */
export function PanelTabs({ tabs, activeId, onSelect, ariaLabel, idPrefix }) {
  const refs = useRef({});
  const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  const onKeyDown = (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    refs.current[tabs[next].id]?.focus();
    onSelect(tabs[next].id);
  };
  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className="grid gap-1 rounded-xl bg-muted/70 p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(t.id)}
            className={`flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active ? 'bg-card text-primary shadow-sm ring-1 ring-blue-200/80 dark:ring-blue-400/30' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {Icon && <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
            <span className="truncate">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
