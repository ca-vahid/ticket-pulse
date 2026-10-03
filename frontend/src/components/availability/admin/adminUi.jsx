import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Plus, X } from 'lucide-react';
import { PersonAvatar } from '../../tickets/ticketUi';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, INPUT, nameFromEmail } from '../availabilityUi';

/**
 * Small building blocks for the Availability admin sections: a right-hand
 * edit drawer, a checkbox multi-select, and a people picker (avatar + name
 * rows, never chips).
 */

export function Drawer({ open, title, onClose, onSave, saving = false, error = null, children, saveLabel = 'Save' }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
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

/** Pick people by e-mail from the known list; rows show avatar + name. */
export function PeoplePicker({ label, people = [], value = [], onChange, renderExtra = null }) {
  const listId = useId();
  const [text, setText] = useState('');
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const add = () => {
    const email = text.trim().toLowerCase();
    if (!email || !email.includes('@') || value.includes(email)) { setText(''); return; }
    onChange([...value, email]);
    setText('');
  };
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {value.length > 0 && (
        <ul className="mb-2 divide-y divide-border rounded-md border border-border">
          {value.map((email) => {
            const name = byEmail.get(email)?.name || nameFromEmail(email);
            return (
              <li key={email} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
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
      <div className="flex gap-2">
        <input
          type="email"
          list={listId}
          className={INPUT}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="name@company.com"
          aria-label={`Add to ${label}`}
        />
        <datalist id={listId}>
          {people.filter((p) => !value.includes(p.email)).map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
        </datalist>
        <button type="button" className={BTN_LINK} onClick={add}><Plus className="h-4 w-4" aria-hidden="true" />Add</button>
      </div>
    </div>
  );
}

export const TH = 'py-1.5 pr-3 text-left text-xs font-medium text-muted-foreground';
export const TD = 'py-2 pr-3 align-top';
