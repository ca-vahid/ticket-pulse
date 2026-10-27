import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Loader2, PauseCircle, Sparkles, X } from 'lucide-react';

/**
 * Parked tickets (plans/PARKED_BUILD_PLAN.md). A park is a marker, not a
 * status: the ticket waits on purpose until a date (FreshService sees plain
 * Pending) and comes back to its assignee on that date. A requester reply or
 * any status change ends it early.
 */

// QA 10-01 #6: "Waiting until a date" and "In progress, with an ETA" were too
// alike — one choice now covers both. 'eta' stays a valid kind for parks made
// before (and for the API), and still reads as "In progress, with an ETA".
//
// QA 10-09 #9: "Waiting on someone" is gone from the dialog too — waiting on a
// person is what Pending Response is for — so a park is always until a date.
// 'waiting_on' stays a valid kind for parks made before (and for the API), and
// still reads as "Waiting on someone — <who>" wherever a park is shown.
export const PARK_KINDS = [
  { value: 'until_date', label: 'Waiting until a date or an ETA', hint: 'Nothing to do before then, or work that is moving — a transfer, a start date, a return from leave, a rollout. It comes back to you on the date.' },
];
const KIND_LABEL = { ...Object.fromEntries(PARK_KINDS.map((k) => [k.value, k.label])), eta: 'In progress, with an ETA', waiting_on: 'Waiting on someone' };
const MAX_DAYS = 184;

function isoDay(d, timeZone = undefined) {
  const x = new Date(d);
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
    } catch { /* the viewer's calendar */ }
  }
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** "Mon, Nov 16" for a YYYY-MM-DD day (no time zone shift: it is a calendar day). */
function dayLabel(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }
function nextMonday() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); return d; }

function safeZone(tz) {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}

export function formatParkDate(value, timeZone = undefined) {
  if (!value) return '';
  const d = new Date(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: safeZone(timeZone) });
}

/** "8:00 AM" — the wake time on the zone's own clock. */
export function formatWakeTime(value, timeZone = undefined) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: safeZone(timeZone) });
}

// QA 10-26 #2: why this zone (the server picks: assignee, else requester,
// else workspace — ticketParkService.resolveWakeZone).
const ZONE_WHY = {
  assignee: 'the assignee’s time zone',
  requester: 'the requester’s time zone (no assignee)',
  workspace: 'the workspace time zone (no assignee)',
};

/** Quiet line under the ticket subject: when it wakes, why, who. No pill. */
export function ParkLine({ park, parkedUntil, wakeZone = null, onExtend, onUnpark, busy = false, canEdit = true }) {
  const until = park?.until || parkedUntil;
  if (!until) return null;
  const who = (park?.waitingOn || []).map((p) => p.name || p.email).filter(Boolean).join(', ');
  const tz = wakeZone?.timeZone;
  const localTime = formatWakeTime(until);
  const zoneTime = tz ? formatWakeTime(until, tz) : null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground" data-testid="park-line">
      <PauseCircle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-semibold text-foreground/85">Parked until {formatParkDate(until, tz)}</span>
      {tz && (
        <span
          data-testid="park-wake-zone"
          title={`Wakes at ${zoneTime} ${wakeZone.label} (${ZONE_WHY[wakeZone.source] || 'time zone'})${zoneTime !== localTime ? ` — ${localTime} your time` : ''}`}
        >
          · wakes {zoneTime} {wakeZone.label}
        </span>
      )}
      {park?.kind && park.kind !== 'until_date' && <span>· {KIND_LABEL[park.kind]}{who ? ` — ${who}` : ''}</span>}
      {park?.reason && <span className="min-w-0 truncate">· {park.reason}</span>}
      {park?.parkedBy && <span className="text-muted-foreground/75">· by {park.parkedBy}</span>}
      {canEdit && (
        <span className="inline-flex items-center gap-2">
          <button type="button" onClick={onExtend} disabled={busy} className="tp-focus-ring rounded text-xs font-semibold text-primary hover:underline disabled:opacity-50">Change date</button>
          <button type="button" onClick={onUnpark} disabled={busy} className="tp-focus-ring rounded text-xs font-semibold text-primary hover:underline disabled:opacity-50">
            {busy ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : 'Unpark'}
          </button>
        </span>
      )}
    </div>
  );
}

/** HR notice date, read strictly from the notice: one click to park. */
export function ParkSuggestion({ suggestion, onUse, onDismiss }) {
  if (!suggestion?.usable) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm" data-testid="park-suggestion">
      <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
      <span className="text-foreground/85">{suggestion.reason}. Park it until then?</span>
      <button type="button" onClick={onUse} className="tp-focus-ring rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
        Park until {formatParkDate(suggestion.until)}
      </button>
      <button type="button" onClick={onDismiss} className="tp-focus-ring rounded text-xs text-muted-foreground hover:text-foreground">Not now</button>
    </div>
  );
}

/** Queue row: a quiet clock + date in place of the due chip. */
export function ParkedMark({ until, kind }) {
  if (!until) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={`Parked — ${KIND_LABEL[kind] || 'waiting until a date'}`} data-testid="parked-mark">
      <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {formatParkDate(until)}
    </span>
  );
}

/**
 * Park dialog. `initial` pre-fills an extension or a suggestion.
 * onSubmit({ kind, until, reason }) — the caller saves and closes. kind is
 * 'until_date', except when an older waiting-on park gets a new date.
 */
export default function ParkDialog({
  ticketRef, initial = null, busy = false, error = null, onSubmit, onClose, onUsePendingResponse, bulkCount = null, wakeZone = null,
}) {
  // An existing park's day on the wake zone's calendar (not the viewer's).
  const [until, setUntil] = useState(initial?.until ? isoDay(initial.until, wakeZone?.timeZone) : '');
  const [reason, setReason] = useState(initial?.reason || '');
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const minDay = isoDay(addDays(1));
  const maxDay = isoDay(addDays(MAX_DAYS));
  const quick = useMemo(() => ([
    { label: 'Next Monday', date: nextMonday() },
    { label: 'In 2 weeks', date: addDays(14) },
    { label: 'In a month', date: addDays(30) },
    ...(initial?.suggestedUntil ? [{ label: 'From the HR notice', date: new Date(initial.suggestedUntil) }] : []),
  ]), [initial?.suggestedUntil]);
  const valid = until && until >= minDay && until <= maxDay && reason.trim();
  // Changing the date of an older "waiting on someone" park keeps who it waits on.
  const legacyWaitingOn = initial?.kind === 'waiting_on' && Array.isArray(initial.waitingOn) && initial.waitingOn.length ? initial.waitingOn : null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="park-dialog-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="tp-card w-full max-w-lg rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="park-dialog-title" className="text-base font-bold text-foreground">
              {bulkCount ? `Park ${bulkCount} ticket${bulkCount === 1 ? '' : 's'}` : `Park ${ticketRef || 'this ticket'}`}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              It waits on purpose until the date, out of the open and overdue counts, and comes back to its assignee then. A reply from the requester brings it back early. FreshService shows it as Pending.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground" htmlFor="park-until">
            Until / ETA <span className="font-normal">(up to six months)</span>
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              ref={firstRef}
              id="park-until"
              type="date"
              value={until}
              min={minDay}
              max={maxDay}
              onChange={(e) => setUntil(e.target.value)}
              className="tp-focus-ring rounded-lg border border-input bg-card px-3 py-1.5 text-sm text-foreground"
            />
            {quick.map((q) => (
              <button key={q.label} type="button" onClick={() => setUntil(isoDay(q.date))} className="tp-focus-ring inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" /> {q.label}
              </button>
            ))}
          </div>
          {/* QA 10-26 #2: say where 8:00 AM is — it wakes on its person's clock. */}
          <p className="mt-1.5 text-xs text-muted-foreground" data-testid="park-wake-hint">
            {bulkCount
              ? 'Each ticket wakes at 8:00 AM in its assignee’s time zone (no assignee: the requester’s, else the workspace’s).'
              : wakeZone?.timeZone
                ? <>Wakes {until ? <strong className="font-semibold text-foreground/85">{dayLabel(until)}, 8:00 AM {wakeZone.label}</strong> : <>at 8:00 AM {wakeZone.label}</>} — {ZONE_WHY[wakeZone.source] || 'its time zone'}.</>
                : 'Wakes at 8:00 AM in the assignee’s time zone.'}
          </p>
        </div>

        <div className="mt-3">
          <label className="block text-xs font-medium text-muted-foreground" htmlFor="park-reason">Reason (one line)</label>
          <input
            id="park-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="e.g. Transfer effective Oct 5, or DarkTrace rollout — ETA end of October"
            className="tp-focus-ring mt-1 w-full rounded-lg border border-input bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60"
          />
        </div>

        <p className="mt-3 text-xs text-muted-foreground" data-testid="park-pending-pointer">
          Waiting on the requester or on another person? That isn’t a park — set the ticket to <strong className="font-semibold text-foreground/85">Pending Response</strong>.
          {onUsePendingResponse && (
            <button type="button" onClick={onUsePendingResponse} className="tp-focus-ring ml-1 rounded font-medium text-primary hover:underline">Use Pending Response</button>
          )}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          A repeating task? <a href="/tickets?view=scheduled" className="tp-focus-ring rounded font-medium text-primary hover:underline">Schedule it instead</a> — a fresh ticket each time, closed when done.
        </p>
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onSubmit?.({ kind: legacyWaitingOn ? 'waiting_on' : 'until_date', until, reason: reason.trim(), ...(legacyWaitingOn ? { waitingOn: legacyWaitingOn } : {}) })}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
            Park
          </button>
        </div>
      </div>
    </div>
  );
}
