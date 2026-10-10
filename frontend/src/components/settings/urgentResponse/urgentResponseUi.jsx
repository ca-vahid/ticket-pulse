import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PersonAvatar } from '../../tickets/ticketUi';
import { useRequesterPhoto } from '../../../hooks/useRequesterPhoto';

/**
 * Small shared pieces for Settings → Urgent Response. People are an avatar +
 * a name; status is a coloured dot + a word, never a pill.
 */

/**
 * A technician's face. The settings API never returns photos, so the
 * directory photo is looked up by e-mail (cached for the session) and the
 * initials show until, or instead of, it.
 */
export function TechAvatar({ tech, size = 'h-6 w-6', textSize = 'text-[10px]' }) {
  const photo = useRequesterPhoto(tech?.email || null);
  return <PersonAvatar name={tech?.name} photoUrl={photo} size={size} textSize={textSize} />;
}

/** Avatar + name. `person` is { id, name }; `techById` supplies the e-mail for the photo. */
export function TechPerson({ person, techById = null, sub = null, size = 'h-6 w-6', className = '' }) {
  const tech = (person?.id != null && techById?.get(Number(person.id))) || person || null;
  const name = person?.name || tech?.name || 'Nobody';
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 align-middle ${className}`}>
      <TechAvatar tech={tech ? { ...tech, name } : null} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm text-foreground">{name}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}

/** FancySelect options for people: value is the id as a string, with a face. */
export function techOptions(technicians = []) {
  return technicians.map((t) => ({
    value: String(t.id),
    label: t.isActive === false ? `${t.name} (inactive)` : t.name,
    icon: <TechAvatar tech={t} size="h-5 w-5" textSize="text-[9px]" />,
  }));
}

/** A small number box that sits inside a sentence. */
export function InlineNumber({ value, onChange, label, min = 0, max = 480, disabled = false }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="tp-focus-ring mx-0.5 h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center text-sm font-medium text-foreground disabled:opacity-50"
    />
  );
}

/** Tick the people in a list: avatar + name per row. */
export function PeopleChecklist({ people, selectedIds, onChange, legend }) {
  const chosen = new Set(selectedIds.map(Number));
  const toggle = (id, on) => onChange(on ? [...chosen, id] : [...chosen].filter((x) => x !== id));
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {people.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50">
              <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} aria-label={p.name} className="accent-[hsl(var(--primary))]" />
              <TechPerson person={p} size="h-5 w-5" />
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** A quiet text action (Undo, Set cover, Cancel request). */
export function TextButton({ children, tone = 'primary', className = '', ...props }) {
  const tones = { primary: 'text-primary', muted: 'text-muted-foreground hover:text-foreground' };
  return (
    <button type="button" {...props} className={`tp-focus-ring rounded px-1 py-0.5 text-sm font-medium hover:underline disabled:opacity-40 disabled:hover:no-underline ${tones[tone] || tones.primary} ${className}`}>
      {children}
    </button>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog that holds a short form (Set cover, Ask for cover): focus goes to
 * the first field, Tab stays inside, Escape closes. Portalled to <body> so a
 * card with a backdrop-filter cannot clip it.
 */
export function FormDialog({ open, title, children, submitLabel, onSubmit, onCancel, busy = false, error = null, testId = undefined }) {
  const titleId = useId();
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    boxRef.current?.querySelector(FOCUSABLE)?.focus();
    return () => { if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); };
  }, [open]);
  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); return; }
    if (e.key !== 'Tab') return;
    const items = boxRef.current?.querySelectorAll(FOCUSABLE) || [];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground/30 p-4 animate-fadeIn" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <form
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={onKeyDown}
        onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-soft animate-scaleIn"
      >
        <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-3 space-y-3">{children}</div>
        {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-foreground/85 hover:bg-muted">Cancel</button>
          <button type="submit" disabled={busy} className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** A labelled field inside a dialog or a section. */
export function Field({ label, hint = null, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export const INPUT_CLASS = 'tp-focus-ring h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground';
export const CARD_CLASS = 'rounded-xl border border-border bg-card p-4 shadow-subtle';
