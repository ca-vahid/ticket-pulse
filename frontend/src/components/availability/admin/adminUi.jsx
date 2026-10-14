import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { PersonAvatar } from '../../tickets/ticketUi';
import { BTN_PRIMARY, BTN_QUIET, INPUT, nameFromEmail } from '../availabilityUi';

/**
 * Small building blocks for the Availability admin sections: a right-hand
 * edit drawer, a checkbox multi-select, and a people picker (avatar + name
 * rows, never chips).
 */

/** A titled block inside a drawer: what it is, one line on what it does, then the controls. */
export function DrawerSection({ title, hint = null, children }) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
      <div className={`space-y-3 ${hint ? '' : 'mt-2'}`}>{children}</div>
    </section>
  );
}

export function Drawer({ open, title, onClose, onSave, saving = false, error = null, children, saveLabel = 'Save' }) {
  const ref = useRef(null);
  const titleId = useId();
  // QA 10-13 #9: this effect used to depend on onClose, which every caller
  // passes as a new function on each render. So every keystroke re-ran it and
  // moved focus from the field to the drawer, one letter at a time. It now
  // runs when the drawer opens, and puts the cursor in the first field once.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea');
    (first || ref.current)?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex justify-end">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-black/30 animate-fadeIn" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-soft animate-slide-in-right focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
          <button type="button" className={BTN_QUIET} onClick={onClose} aria-label="Close"><X className="h-4 w-4" aria-hidden="true" /></button>
        </div>
        <div className="settings-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {error && <span role="alert" className="mr-auto text-sm text-red-700 dark:text-red-300">{error}</span>}
          <button type="button" className={BTN_QUIET} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{saveLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Checkbox list; `allValue` (e.g. '*') adds an "All" row that excludes the rest. */
export function MultiCheck({ options, value = [], onChange, label, allValue = null, allLabel = 'All types' }) {
  const all = allValue != null && value.includes(allValue);
  const toggle = (v, on) => onChange(on ? [...value.filter((x) => x !== allValue), v] : value.filter((x) => x !== v));
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {allValue != null && (
          <label className="inline-flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? [allValue] : [])} className="accent-[hsl(var(--primary))]" />
            {allLabel}
          </label>
        )}
        {options.map((o) => (
          <label key={o.value} className={`inline-flex items-center gap-2 text-sm text-foreground ${all ? 'opacity-50' : ''}`}>
            <input type="checkbox" disabled={all} checked={all || value.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} className="accent-[hsl(var(--primary))]" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Pick people from the known list: type a name (or an e-mail), choose from the
 * list with the mouse or the arrow keys. Chosen people are rows with avatar +
 * name, never chips. A full address that is not on the list can still be added.
 *
 * QA 10-13 #9: this was a bare e-mail box backed by the browser's datalist,
 * which only matched addresses and looked different in every browser.
 */
export function PeoplePicker({ label, hint = null, people = [], value = [], onChange, renderExtra = null, placeholder = 'Search by name or e-mail', quickAdd = null }) {
  const listId = useId();
  const inputRef = useRef(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const q = text.trim().toLowerCase();
  const chosen = new Set(value);
  const matches = people
    .filter((p) => !chosen.has(p.email))
    .filter((p) => !q || String(p.name || '').toLowerCase().includes(q) || String(p.email || '').toLowerCase().includes(q))
    .slice(0, 40);
  const typedEmail = q.includes('@') && q.includes('.') && !q.includes(' ') && !chosen.has(q) && !byEmail.has(q) ? q : null;
  const options = [...matches.map((p) => ({ email: p.email, name: p.name || nameFromEmail(p.email) })), ...(typedEmail ? [{ email: typedEmail, name: null, typed: true }] : [])];
  const at = Math.min(active, Math.max(0, options.length - 1));

  const add = (email) => {
    if (!email || chosen.has(email)) return;
    onChange([...value, email]);
    setText('');
    setActive(0);
    inputRef.current?.focus();
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(Math.min(at + 1, options.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (open && options[at]) add(options[at].email); return; }
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };
  const extra = quickAdd ? quickAdd.emails.filter((e) => !chosen.has(e)) : [];

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-xs font-medium text-muted-foreground">{label}{value.length ? ` · ${value.length}` : ''}</p>
        {extra.length > 0 && (
          <button type="button" className="tp-focus-ring rounded text-xs text-primary hover:underline" onClick={() => onChange([...value, ...extra])}>{quickAdd.label(extra.length)}</button>
        )}
      </div>
      {hint && <p className="mb-1.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[at] ? `${listId}-${at}` : undefined}
          aria-label={`Add to ${label}`}
          autoComplete="off"
          spellCheck={false}
          className={`${INPUT} pl-8`}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <ul id={listId} role="listbox" aria-label={label} className="settings-scrollbar absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card py-1 shadow-soft">
            {options.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{q ? 'No one matches. Type a full e-mail address to add someone who is not listed.' : 'Everyone listed is already added.'}</li>}
            {options.map((o, i) => (
              <li
                key={o.email}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === at}
                className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 ${i === at ? 'bg-muted' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); add(o.email); }}
                onMouseEnter={() => setActive(i)}
              >
                {o.typed ? <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <PersonAvatar name={o.name} size="h-6 w-6" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{o.typed ? `Add ${o.email}` : o.name}</span>
                  {!o.typed && <span className="block truncate text-xs text-muted-foreground">{o.email}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {value.length > 0 && (
        <ul className="mt-2 divide-y divide-border border-y border-border">
          {value.map((email) => {
            const name = byEmail.get(email)?.name || nameFromEmail(email);
            return (
              <li key={email} className="flex flex-wrap items-center gap-2 py-1.5">
                <PersonAvatar name={name} size="h-6 w-6" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{email}</span>
                </span>
                {renderExtra?.(email)}
                <button type="button" className={BTN_QUIET} onClick={() => onChange(value.filter((x) => x !== email))} aria-label={`Remove ${name}`}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const TH = 'py-1.5 pr-3 text-left text-xs font-medium text-muted-foreground';
export const TD = 'py-2 pr-3 align-top';
