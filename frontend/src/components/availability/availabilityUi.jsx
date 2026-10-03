import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';

/**
 * Shared pieces for Availability (native Vacation Tracker replacement).
 * Status = a small coloured dot + a word, never a pill (Vahid's taste).
 * Leave-type colours are Tailwind palette names stored on the type
 * (emerald / sky / amber / rose / violet / teal / slate …); the maps below spell
 * every class out literally so Tailwind's scanner keeps them.
 */

const DOT = {
  blue: 'bg-blue-500 dark:bg-blue-400',
  green: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-red-500 dark:bg-red-400',
  grey: 'bg-muted-foreground/50',
};

export function StatusDot({ tone = 'grey', label, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground/85 ${className}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone] || DOT.grey}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export const REQUEST_STATUS = {
  approved: { tone: 'green', label: 'Approved' },
  pending: { tone: 'amber', label: 'Waiting for approval' },
  denied: { tone: 'red', label: 'Denied' },
  cancelled: { tone: 'grey', label: 'Cancelled' },
};

// Calendar cell fills (light / dark), the swatch dot and the pending stripe hue.
export const COLOR_FILL = {
  emerald: 'bg-emerald-200 dark:bg-emerald-500/35',
  green: 'bg-green-200 dark:bg-green-500/35',
  teal: 'bg-teal-200 dark:bg-teal-500/35',
  cyan: 'bg-cyan-200 dark:bg-cyan-500/35',
  sky: 'bg-sky-200 dark:bg-sky-500/35',
  blue: 'bg-blue-200 dark:bg-blue-500/35',
  indigo: 'bg-indigo-200 dark:bg-indigo-500/35',
  violet: 'bg-violet-200 dark:bg-violet-500/35',
  purple: 'bg-purple-200 dark:bg-purple-500/35',
  fuchsia: 'bg-fuchsia-200 dark:bg-fuchsia-500/35',
  pink: 'bg-pink-200 dark:bg-pink-500/35',
  rose: 'bg-rose-200 dark:bg-rose-500/35',
  red: 'bg-red-200 dark:bg-red-500/35',
  orange: 'bg-orange-200 dark:bg-orange-500/35',
  amber: 'bg-amber-200 dark:bg-amber-500/35',
  yellow: 'bg-yellow-200 dark:bg-yellow-500/35',
  lime: 'bg-lime-200 dark:bg-lime-500/35',
  slate: 'bg-muted-foreground/25',
  gray: 'bg-muted-foreground/25',
};

export const COLOR_DOT = {
  emerald: 'bg-emerald-500', green: 'bg-green-500', teal: 'bg-teal-500', cyan: 'bg-cyan-500', sky: 'bg-sky-500',
  blue: 'bg-blue-500', indigo: 'bg-indigo-500', violet: 'bg-violet-500', purple: 'bg-purple-500', fuchsia: 'bg-fuchsia-500',
  pink: 'bg-pink-500', rose: 'bg-rose-500', red: 'bg-red-500', orange: 'bg-orange-500', amber: 'bg-amber-500',
  yellow: 'bg-yellow-500', lime: 'bg-lime-500', slate: 'bg-muted-foreground/60', gray: 'bg-muted-foreground/60',
};

// Pending entries: a light outline + diagonal stripes drawn in currentColor.
export const COLOR_STRIPE = {
  emerald: 'text-emerald-500/60 border-emerald-400', green: 'text-green-500/60 border-green-400', teal: 'text-teal-500/60 border-teal-400',
  cyan: 'text-cyan-500/60 border-cyan-400', sky: 'text-sky-500/60 border-sky-400', blue: 'text-blue-500/60 border-blue-400',
  indigo: 'text-indigo-500/60 border-indigo-400', violet: 'text-violet-500/60 border-violet-400', purple: 'text-purple-500/60 border-purple-400',
  fuchsia: 'text-fuchsia-500/60 border-fuchsia-400', pink: 'text-pink-500/60 border-pink-400', rose: 'text-rose-500/60 border-rose-400',
  red: 'text-red-500/60 border-red-400', orange: 'text-orange-500/60 border-orange-400', amber: 'text-amber-500/60 border-amber-400',
  yellow: 'text-yellow-500/60 border-yellow-400', lime: 'text-lime-500/60 border-lime-400',
  slate: 'text-muted-foreground/60 border-muted-foreground/50', gray: 'text-muted-foreground/60 border-muted-foreground/50',
};
export const STRIPES = { backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 6px)' };

export const COLOR_NAMES = ['emerald', 'teal', 'sky', 'blue', 'indigo', 'violet', 'fuchsia', 'rose', 'red', 'orange', 'amber', 'lime', 'slate'];

export function ColorSwatch({ color, className = '' }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${COLOR_DOT[color] || COLOR_DOT.slate} ${className}`} aria-hidden="true" />;
}

export function Loading({ label = 'Loading…', className = '' }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground ${className}`} role="status">
      <Activity className="h-5 w-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function SectionTitle({ children, hint = null, action = null, as: Tag = 'h2' }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <Tag className="text-sm font-semibold text-foreground">{children}</Tag>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export const CARD = 'rounded-xl border border-border bg-card p-4 shadow-subtle';
export const INPUT = 'tp-focus-ring h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground disabled:opacity-50';
export const TEXTAREA = 'tp-focus-ring w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground';
export const BTN_PRIMARY = 'tp-focus-ring inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40';
export const BTN_QUIET = 'tp-focus-ring inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
export const BTN_LINK = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-primary hover:bg-muted disabled:opacity-40';

export function Field({ label, hint = null, children, className = '' }) {
  return (
    <label className={`grid gap-1 text-sm ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint = null, disabled = false }) {
  return (
    <label className={`flex items-start gap-2 text-sm text-foreground ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200">
      {children}
    </p>
  );
}

/** Page-local toast, same look as the Tickets queue toast. */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((message, tone = 'emerald') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = setTimeout(() => setToast(null), tone === 'red' ? 6000 : 3500);
  }, []);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);
  const node = toast ? (
    <div
      role={toast.tone === 'red' ? 'alert' : 'status'}
      data-testid="availability-toast"
      className={`fixed bottom-20 right-5 z-[70] flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-soft animate-slideInLeft md:bottom-5 ${
        toast.tone === 'red' ? 'bg-red-600' : 'bg-emerald-600'
      }`}
    >
      {toast.message}
    </div>
  ) : null;
  return { show, node };
}

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => dayKey(new Date());
/** Today, or the next Monday when today is a weekend (the booking form's default). */
export const nextWorkdayKey = () => {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return dayKey(d);
};
export const parseDay = (k) => {
  const [y, m, d] = String(k).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
export const addDaysKey = (k, n) => {
  const d = parseDay(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};

export function fmtDay(k, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!k) return '—';
  return parseDay(k).toLocaleDateString('en-CA', opts);
}

export const fmtMinute = (m) => {
  if (m == null) return '';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? `:${pad(mm)}` : ''}${ampm}`;
};

export function fmtRange(r) {
  const same = r.startDate === r.endDate;
  const base = same ? fmtDay(r.startDate) : `${fmtDay(r.startDate)} – ${fmtDay(r.endDate)}`;
  if (r.dayPart === 'am') return `${base} · morning`;
  if (r.dayPart === 'pm') return `${base} · afternoon`;
  if (r.dayPart === 'hours' && r.startMinute != null) return `${base} · ${fmtMinute(r.startMinute)}–${fmtMinute(r.endMinute)}`;
  return base;
}

export function fmtAmount(r, unit = 'day') {
  if (unit === 'hour' || r.dayPart === 'hours') {
    const h = Number(r.hours) || 0;
    return `${trimNum(h)} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = Number(r.days) || 0;
  return `${trimNum(d)} ${d === 1 ? 'day' : 'days'}`;
}

export const trimNum = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 100) / 100);
};

export const minuteToTime = (m) => (m == null ? '' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
export const timeToMinute = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** "jane.doe@x.ca" → "Jane Doe" when no display name is known. */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return 'Unknown';
  return local.split(/[._-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = [
  { n: 1, short: 'M', label: 'Monday' }, { n: 2, short: 'T', label: 'Tuesday' }, { n: 3, short: 'W', label: 'Wednesday' },
  { n: 4, short: 'T', label: 'Thursday' }, { n: 5, short: 'F', label: 'Friday' }, { n: 6, short: 'S', label: 'Saturday' },
  { n: 7, short: 'S', label: 'Sunday' },
];

export const AVAILABILITY_LABEL = {
  OFF: 'Away', WFH: 'Working from home', ONSITE: 'On site', PARTIAL: 'Partly away', NONE: 'No change',
};
