import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Pencil, Trash2 } from 'lucide-react';
import { formatDayTime } from './ticketUi';

/**
 * Due-date presets (QA 08-04 #13), each resolving to 11:59 PM local — mirrors
 * the FreshService "Resolution due" picker:
 *   Today / Tomorrow / This week (the coming Saturday, today if already
 *   Saturday) / Next week (Saturday after that) / This month (last day).
 * Exported for tests.
 */
export function duePresets(now = new Date()) {
  const at1159 = (y, m, d) => new Date(y, m, d, 23, 59, 0, 0);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const satOffset = (6 - now.getDay() + 7) % 7;
  const thisWeekDay = d + satOffset;
  return [
    { key: 'today', label: 'Today', date: at1159(y, m, d) },
    { key: 'tomorrow', label: 'Tomorrow', date: at1159(y, m, d + 1) },
    { key: 'this_week', label: 'This week', date: at1159(y, m, thisWeekDay) },
    { key: 'next_week', label: 'Next week', date: at1159(y, m, thisWeekDay + 7) },
    { key: 'this_month', label: 'This month', date: at1159(y, m + 1, 0) },
  ];
}

/** Date → the local "YYYY-MM-DDTHH:mm" a datetime-local input wants. */
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const x = new Date(date);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/**
 * Pencil-behind-the-date editor for a TP-born ticket's SLA clocks (QA 08-04
 * #13). Opens a light tp-card popover (our design language — the FS reference
 * uses a dark sheet, but consistency beats mimicry) with the FS preset rows,
 * a "Pick date and time" custom row, and "Remove due date" when one is set.
 *
 * The caller owns persistence: `onSave(isoString | null)` — null clears.
 */
export default function DueDateEditor({ label, value, onSave, saving = false }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState('');
  const rootRef = useRef(null);

  // Presets resolve when the popover OPENS, not at mount — a page left open
  // overnight must not offer yesterday's "Today".
  const [presets, setPresets] = useState(() => duePresets());

  const close = () => { setOpen(false); setPicking(false); };
  const toggle = () => {
    if (!open) {
      setPresets(duePresets());
      setCustom(toLocalInputValue(value ? new Date(value) : duePresets()[0].date));
    }
    setOpen((o) => !o);
    setPicking(false);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (date) => { close(); onSave(date ? new Date(date).toISOString() : null); };

  const rowClass = 'tp-focus-ring flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs text-foreground/85 hover:bg-muted/50';

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        onClick={toggle}
        disabled={saving}
        aria-label={`Edit ${label.toLowerCase()} due date`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Edit ${label.toLowerCase()} due date`}
        className="tp-focus-ring rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground disabled:opacity-50"
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Set ${label.toLowerCase()} due date`}
          onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
          className="tp-card absolute right-0 top-6 z-30 w-64 animate-scaleIn rounded-xl p-2 shadow-soft"
        >
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label} due</p>
          <div className="space-y-0.5">
            {presets.map((p) => (
              <button key={p.key} onClick={() => choose(p.date)} className={rowClass}>
                <span className="font-medium">{p.label}</span>
                <span className="text-[11px] text-muted-foreground/75">{formatDayTime(p.date)}</span>
              </button>
            ))}
          </div>
          <div className="my-1.5 border-t border-border/60" />
          <button
            onClick={() => setPicking((v) => !v)}
            aria-expanded={picking}
            className={rowClass}
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground/75" aria-hidden="true" />
              Pick date and time
            </span>
          </button>
          {picking && (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <label className="sr-only" htmlFor={`due-custom-${label}`}>Custom {label.toLowerCase()} due date and time</label>
              <input
                id={`due-custom-${label}`}
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="tp-focus-ring min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-1 text-[11px] text-foreground/85"
              />
              <button
                onClick={() => { const d = new Date(custom); if (!Number.isNaN(d.getTime())) choose(d); }}
                disabled={!custom || Number.isNaN(new Date(custom).getTime())}
                className="tp-focus-ring rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
              >
                Set
              </button>
            </div>
          )}
          {value && (
            <>
              <div className="my-1.5 border-t border-border/60" />
              <button onClick={() => choose(null)} className={`${rowClass} !text-rose-600 dark:!text-rose-300 hover:!bg-rose-50 dark:hover:!bg-rose-500/15`}>
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Remove due date
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
