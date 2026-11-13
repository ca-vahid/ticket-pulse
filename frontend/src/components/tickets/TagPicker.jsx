import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Plus, Search } from 'lucide-react';
import { TagChip } from './ticketUi';

/**
 * Tag picker for forms (QA 11-12 #3). A workspace can hold 200+ tags, so
 * nothing unselected is ever drawn as a pill: the picked tags sit in the field
 * as removable chips, and the rest live behind a search box whose list opens
 * on focus — a short A–Z list first, then "Browse all (N)" for the tall list
 * in the same popover. Small palettes (≤ SIMPLE_MAX) just show everything.
 *
 * Controlled: `value` is an array of tag ids, `onChange(nextIds)` gets the new
 * array. Creation only exists when the caller passes `onCreate(name)` (which
 * resolves to the created tag) — callers pass it for admins only, mirroring
 * the ticket sidebar's TicketTagEditor; the picker never widens who can create.
 *
 * Keyboard: ↑/↓ move, Enter picks (the list stays open for the next one),
 * Backspace on an empty box removes the last chip, Esc closes the list
 * without leaving the form.
 */

export const SHORT_LIST = 8;
export const SIMPLE_MAX = 12;
export const LETTERS_FROM = 40;

// Small colour mark per palette key (keep in step with TAG_CHIP_TONES).
const TAG_DOTS = {
  slate: 'bg-muted-foreground/50',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
const letterOf = (name) => {
  const c = String(name || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
};

export default function TagPicker({
  tags = [],
  value = [],
  onChange,
  onCreate = null,
  id,
  ariaLabel,
  placeholder,
  invalid = false,
  required = false,
  describedBy,
  disabled = false,
  className = '',
}) {
  const baseId = useId().replace(/:/g, '');
  const inputId = id || `tag-picker-${baseId}`;
  const listId = `${inputId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState([]); // tags made here, until the caller's list catches up
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const quietFocusRef = useRef(false);
  const listRef = useRef(null);

  // The Tags field sits low on the new-ticket form: bring the open list into view
  // rather than letting it run off the bottom (phones especially).
  useEffect(() => {
    if (open) listRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, browsing]);

  const all = useMemo(() => {
    const seen = new Set((tags || []).map((t) => String(t.id)));
    return [...(tags || []), ...created.filter((t) => !seen.has(String(t.id)))].sort(byName);
  }, [tags, created]);
  const byId = useMemo(() => new Map(all.map((t) => [String(t.id), t])), [all]);
  const selectedSet = useMemo(() => new Set((value || []).map(String)), [value]);
  const selected = useMemo(() => (value || []).map((tid) => byId.get(String(tid))
    // A retired/unknown id still shows (and can be removed) rather than vanishing.
    || { id: tid, name: `Tag ${tid} (no longer active)`, color: 'slate' }), [value, byId]);

  const simple = all.length <= SIMPLE_MAX;
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all), [all, q]);
  const unpicked = useMemo(() => {
    const list = matches.filter((t) => !selectedSet.has(String(t.id)));
    if (!q) return list;
    // Typing: names that START with the words first, then the rest.
    return [...list.filter((t) => t.name.toLowerCase().startsWith(q)), ...list.filter((t) => !t.name.toLowerCase().startsWith(q))];
  }, [matches, selectedSet, q]);
  const exactExists = Boolean(q) && all.some((t) => t.name.toLowerCase() === q);
  const canCreate = typeof onCreate === 'function' && Boolean(q) && !exactExists && !disabled;

  // The rows the arrows walk: tag rows, then "Browse all", then "Create".
  const tagRows = browsing ? matches : (simple ? unpicked : unpicked.slice(0, SHORT_LIST));
  const showBrowse = !browsing && !simple && unpicked.length > SHORT_LIST;
  const navItems = useMemo(() => [
    ...tagRows.map((tag) => ({ kind: 'tag', tag })),
    ...(showBrowse ? [{ kind: 'browse' }] : []),
    ...(canCreate ? [{ kind: 'create' }] : []),
  ], [tagRows, showBrowse, canCreate]);
  const optionId = (i) => `${inputId}-opt-${i}`;
  const activeIndex = navItems.length ? Math.min(active, navItems.length - 1) : -1;
  const withLetters = browsing && tagRows.length > LETTERS_FROM;

  useEffect(() => { setActive(0); }, [q, browsing]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) close(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = document.getElementById(optionId(activeIndex));
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, browsing]);

  function close() {
    setOpen(false);
    setBrowsing(false);
    setQuery('');
    setCreateError(null);
  }

  const focusInputQuietly = () => {
    quietFocusRef.current = true;
    inputRef.current?.focus();
    quietFocusRef.current = false;
  };

  const emit = (next) => onChange?.(next);

  const toggle = (tag) => {
    if (selectedSet.has(String(tag.id))) emit((value || []).filter((tid) => String(tid) !== String(tag.id)));
    else emit([...(value || []), tag.id]);
    setQuery('');
    setCreateError(null);
  };

  const removeChip = (tag) => {
    emit((value || []).filter((tid) => String(tid) !== String(tag.id)));
    focusInputQuietly();
  };

  const create = async () => {
    const name = query.trim();
    if (!name || !canCreate || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const tag = await onCreate(name);
      if (tag?.id != null) {
        setCreated((list) => [...list, tag]);
        emit([...(value || []), tag.id]);
      }
      setQuery('');
    } catch (err) {
      setCreateError(err?.response?.data?.message || err?.message || 'Could not create that tag');
    } finally {
      setCreating(false);
    }
  };

  const activate = (item) => {
    if (!item) return;
    if (item.kind === 'tag') toggle(item.tag);
    else if (item.kind === 'browse') setBrowsing(true);
    else if (item.kind === 'create') create();
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive(Math.min(navItems.length - 1, activeIndex + 1));
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive(Math.max(0, activeIndex - 1));
      break;
    case 'Home':
      if (open && browsing) { e.preventDefault(); setActive(0); }
      break;
    case 'End':
      if (open && browsing) { e.preventDefault(); setActive(navItems.length - 1); }
      break;
    case 'Enter':
      // Never submits the surrounding form.
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      activate(navItems[activeIndex]);
      break;
    case 'Escape':
      if (open) {
        // Closes the list only: the form (and any dialog around it) stays.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      break;
    case 'Backspace':
      // Not on key repeat: holding Backspace to clear the typed text must stop at the box.
      if (!e.repeat && !query && (value || []).length > 0) {
        e.preventDefault();
        emit((value || []).slice(0, -1));
      }
      break;
    case 'Tab':
      if (open) close();
      break;
    default:
    }
  };

  const total = all.length;
  const shownPlaceholder = (value || []).length > 0
    ? 'Add another…'
    : (placeholder || (simple ? 'Pick tags…' : `Search ${total} tags…`));

  const renderTagRow = (tag, i) => {
    const isOn = selectedSet.has(String(tag.id));
    const isActive = i === activeIndex;
    return (
      <div
        key={tag.id}
        id={optionId(i)}
        role="option"
        aria-selected={isOn}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setActive(i)}
        onClick={() => toggle(tag)}
        className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive ? 'bg-muted text-foreground' : 'text-foreground/85'}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${TAG_DOTS[tag.color] || TAG_DOTS.slate}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{tag.name}</span>
        {isOn && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
      </div>
    );
  };

  const renderTagRows = () => {
    if (!withLetters) return tagRows.map((tag, i) => renderTagRow(tag, i));
    const out = [];
    let group = null;
    tagRows.forEach((tag, i) => {
      const letter = letterOf(tag.name);
      if (!group || group.letter !== letter) {
        group = { letter, rows: [] };
        out.push(group);
      }
      group.rows.push(renderTagRow(tag, i));
    });
    return out.map((g) => (
      <div key={g.letter} role="group" aria-label={g.letter === '#' ? 'Other' : g.letter}>
        <div className="sticky top-0 z-[1] bg-card px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75" aria-hidden="true">
          {g.letter}
        </div>
        {g.rows}
      </div>
    ));
  };

  const browseIndex = tagRows.length;
  const createIndex = tagRows.length + (showBrowse ? 1 : 0);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div
        onMouseDown={(e) => {
          if (disabled || e.target !== e.currentTarget) return;
          e.preventDefault();
          inputRef.current?.focus();
          setOpen(true);
        }}
        className={`flex min-h-[2.75rem] w-full cursor-text flex-wrap items-center gap-1 rounded-lg border bg-card px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background ${
          invalid ? 'border-red-400 dark:border-red-500/60' : 'border-input'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        {selected.map((tag) => (
          <TagChip key={tag.id} tag={tag} onRemove={disabled ? null : removeChip} />
        ))}
        <span className="flex min-w-[8rem] flex-1 items-center gap-1.5 px-1">
          {(value || []).length === 0 && <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />}
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            disabled={disabled}
            value={query}
            placeholder={shownPlaceholder}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setCreateError(null); }}
            onFocus={() => { if (!quietFocusRef.current) setOpen(true); }}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/75"
          />
          {creating && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
        </span>
      </div>

      {open && (
        <div className="tp-card absolute left-0 top-full z-30 mt-1 w-full min-w-[16rem] max-w-[calc(100vw-2.5rem)] rounded-lg p-1 shadow-soft motion-on:animate-scaleIn">
          {browsing && (
            <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
              <span>{q ? `${matches.length} of ${total} tags` : `All ${total} tags`}</span>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setBrowsing(false)}
                className="tp-focus-ring rounded px-1 font-medium text-primary hover:underline"
              >
                Show fewer
              </button>
            </div>
          )}
          <div
            ref={listRef}
            role="listbox"
            id={listId}
            aria-label="Tags"
            aria-multiselectable="true"
            data-testid="tag-picker-list"
            className={browsing ? 'max-h-80 overflow-y-auto settings-scrollbar' : ''}
          >
            {renderTagRows()}
            {showBrowse && <div className="mx-1 my-1 border-t border-border/60" aria-hidden="true" />}
            {showBrowse && (
              <div
                id={optionId(browseIndex)}
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(browseIndex)}
                onClick={() => setBrowsing(true)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-primary ${browseIndex === activeIndex ? 'bg-muted' : ''}`}
              >
                {q ? `Show all ${unpicked.length} matches` : `Browse all (${total})`}
              </div>
            )}
            {canCreate && (
              <div
                id={optionId(createIndex)}
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(createIndex)}
                onClick={create}
                className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-primary ${createIndex === activeIndex ? 'bg-muted' : ''}`}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Create “{query.trim()}”
              </div>
            )}
          </div>
          {navItems.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {q ? 'No matching tags.' : 'Every tag is already picked.'}
            </p>
          )}
          {createError && <p className="px-2 py-1 text-xs text-red-600 dark:text-red-300" role="alert">{createError}</p>}
        </div>
      )}
    </div>
  );
}
