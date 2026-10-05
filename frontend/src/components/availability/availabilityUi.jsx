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

// Wallchart / month bars (5 Oct 2026): approved = a soft fill with readable
// text in the same hue; waiting = a dashed outline in the hue, no fill.
export const COLOR_BAR = {
  emerald: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-500/30 dark:text-emerald-50',
  green: 'bg-green-200 text-green-950 dark:bg-green-500/30 dark:text-green-50',
  teal: 'bg-teal-200 text-teal-950 dark:bg-teal-500/30 dark:text-teal-50',
  cyan: 'bg-cyan-200 text-cyan-950 dark:bg-cyan-500/30 dark:text-cyan-50',
  sky: 'bg-sky-200 text-sky-950 dark:bg-sky-500/30 dark:text-sky-50',
  blue: 'bg-blue-200 text-blue-950 dark:bg-blue-500/30 dark:text-blue-50',
  indigo: 'bg-indigo-200 text-indigo-950 dark:bg-indigo-500/30 dark:text-indigo-50',
  violet: 'bg-violet-200 text-violet-950 dark:bg-violet-500/30 dark:text-violet-50',
  purple: 'bg-purple-200 text-purple-950 dark:bg-purple-500/30 dark:text-purple-50',
  fuchsia: 'bg-fuchsia-200 text-fuchsia-950 dark:bg-fuchsia-500/30 dark:text-fuchsia-50',
  pink: 'bg-pink-200 text-pink-950 dark:bg-pink-500/30 dark:text-pink-50',
  rose: 'bg-rose-200 text-rose-950 dark:bg-rose-500/30 dark:text-rose-50',
  red: 'bg-red-200 text-red-950 dark:bg-red-500/30 dark:text-red-50',
  orange: 'bg-orange-200 text-orange-950 dark:bg-orange-500/30 dark:text-orange-50',
  amber: 'bg-amber-200 text-amber-950 dark:bg-amber-500/30 dark:text-amber-50',
  yellow: 'bg-yellow-200 text-yellow-950 dark:bg-yellow-500/30 dark:text-yellow-50',
  lime: 'bg-lime-200 text-lime-950 dark:bg-lime-500/30 dark:text-lime-50',
  slate: 'bg-muted-foreground/25 text-foreground',
  gray: 'bg-muted-foreground/25 text-foreground',
};
export const COLOR_BAR_PENDING = {
  emerald: 'border-emerald-500 text-emerald-700 dark:border-emerald-400 dark:text-emerald-200',
  green: 'border-green-500 text-green-700 dark:border-green-400 dark:text-green-200',
  teal: 'border-teal-500 text-teal-700 dark:border-teal-400 dark:text-teal-200',
  cyan: 'border-cyan-500 text-cyan-700 dark:border-cyan-400 dark:text-cyan-200',
  sky: 'border-sky-500 text-sky-700 dark:border-sky-400 dark:text-sky-200',
  blue: 'border-blue-500 text-blue-700 dark:border-blue-400 dark:text-blue-200',
  indigo: 'border-indigo-500 text-indigo-700 dark:border-indigo-400 dark:text-indigo-200',
  violet: 'border-violet-500 text-violet-700 dark:border-violet-400 dark:text-violet-200',
  purple: 'border-purple-500 text-purple-700 dark:border-purple-400 dark:text-purple-200',
  fuchsia: 'border-fuchsia-500 text-fuchsia-700 dark:border-fuchsia-400 dark:text-fuchsia-200',
  pink: 'border-pink-500 text-pink-700 dark:border-pink-400 dark:text-pink-200',
  rose: 'border-rose-500 text-rose-700 dark:border-rose-400 dark:text-rose-200',
  red: 'border-red-500 text-red-700 dark:border-red-400 dark:text-red-200',
  orange: 'border-orange-500 text-orange-700 dark:border-orange-400 dark:text-orange-200',
  amber: 'border-amber-500 text-amber-700 dark:border-amber-400 dark:text-amber-200',
  yellow: 'border-yellow-500 text-yellow-700 dark:border-yellow-400 dark:text-yellow-200',
  lime: 'border-lime-500 text-lime-700 dark:border-lime-400 dark:text-lime-200',
  slate: 'border-muted-foreground/60 text-muted-foreground',
  gray: 'border-muted-foreground/60 text-muted-foreground',
};
/** Half days and hours: light diagonal hatching over the bar's own fill. */
export const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 3px, transparent 3px 7px)' };
// Weekend and holiday columns, the same way across Overview, Wallchart and Calendar.
export const WEEKEND_BG = 'bg-muted/60';
export const HOLIDAY_BG = 'bg-rose-50/80 dark:bg-rose-500/10';
export const HOLIDAY_DOT = 'bg-rose-400 dark:bg-rose-300';
// Today's column (5 Oct 2026, Vahid: the old faint tint read like a weekend):
// a clear blue tint with thin primary edges, header to last row.
export const TODAY_COL = 'bg-blue-100/80 shadow-[inset_1.5px_0_0_hsl(var(--primary)/0.55),inset_-1.5px_0_0_hsl(var(--primary)/0.55)] dark:bg-blue-500/20';
// Coverage: how many of the team are away that day (workload colours).
export const COVERAGE_BG = { none: 'bg-muted', light: 'bg-emerald-500', medium: 'bg-amber-500', heavy: 'bg-red-500' };

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
