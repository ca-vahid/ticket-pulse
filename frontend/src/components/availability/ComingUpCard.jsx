import { useState } from 'react';
import { ArrowRight, Loader2, Pencil, X } from 'lucide-react';
import {
  BTN_QUIET, CARD, Pictogram, REQUEST_STATUS, StatusDot, fmtMinute, leaveLabel, pictogramFor, sitePlace, todayKey,
} from './availabilityUi';
import { backDay, pastRequests, rangeWords, upcomingRequests } from './bookingModel';

/**
 * "Coming up" on My time (QA 11-25 #1): the person's approved and waiting
 * requests that are not over, soonest first. Cancelled and denied requests
 * never show here (the bug in the QA's screenshot: "Upcoming" was any request
 * ending today or later, so a cancelled vacation sat at the top).
 *
 * Each row, in the Overview's quiet style: the pictogram, the dates (bold,
 * "(today)" when it is today), type · where it came from, then the status as
 * a dot and a word. A waiting request can be changed; approved or waiting
 * ones can be cancelled after an inline confirm (with the Vacation Tracker or
 * shared-calendar note, as before).
 *
 * Past and cancelled requests: admins go to the History tab (`onOpenHistory`);
 * everyone else can open them here, folded away by default.
 * Props in, nothing fetched, so it renders on its own in a harness.
 */

const SHOW = 5;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LINK = 'tp-focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline';

function partWords(r) {
  if (r.dayPart === 'am') return 'morning';
  if (r.dayPart === 'pm') return 'afternoon';
  if (r.dayPart === 'hours' && r.startMinute != null) return `${fmtMinute(r.startMinute)}–${fmtMinute(r.endMinute)}`;
  return null;
}

function sourceWords(r) {
  if (r.source === 'vacation_tracker') return 'from Vacation Tracker';
  if (r.source === 'shared_calendar') return 'from the shared calendar';
  if (r.inVacationTracker && r.status === 'approved') return 'synced to Vacation Tracker';
  return null;
}

export function ComingUpRow({ r, type, today, offices = [], holidaySet = new Set(), onCancel = null, onEdit = null, isEditing = false, readOnly = false }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = REQUEST_STATUS[r.status] || REQUEST_STATUS.cancelled;
  const fromVt = r.source === 'vacation_tracker';
  const fromCal = r.source === 'shared_calendar';
  const imported = fromVt || fromCal;
  const live = r.status === 'pending' || r.status === 'approved';
  const cancellable = !readOnly && Boolean(onCancel) && (imported ? r.status === 'approved' : live) && r.endDate >= today;
  const editable = !readOnly && Boolean(onEdit) && !imported && r.status === 'pending' && r.editable !== false;
  const stillInVt = fromVt && r.status === 'cancelled' && r.stillInVacationTracker === true;
  const waitingOn = r.status === 'pending' ? (r.waitingOn || []).map((p) => p.name || p.email).filter(Boolean) : [];
  const dates = rangeWords(r.startDate, r.endDate, { today });
  // "(today)" on a day that is today; "(now)" on a range that has started.
  const nowWord = r.startDate === today && r.endDate === today ? 'today' : r.startDate <= today && r.endDate >= today ? 'now' : null;
  const label = leaveLabel(type?.name, sitePlace(r, offices));
  const part = partWords(r);
  const away = !part && (!type?.availability || type.availability === 'OFF') && r.status !== 'denied' && r.status !== 'cancelled';
  const source = sourceWords(r);
  const reason = r.status === 'denied' ? (r.decisionNote || r.decision?.reason || null) : null;

  const doCancel = async () => {
    setBusy(true);
    try { await onCancel(r); } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <li className={`py-2.5 ${isEditing ? '-mx-2 rounded-md bg-primary/5 px-2 dark:bg-primary/10' : ''}`} data-testid={`coming-up-${r.id}`}>
      <div className="flex items-start gap-2.5">
        <Pictogram name={pictogramFor(type)} className="mt-0.5 h-6 w-6" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-sm font-semibold text-foreground">
            {dates}{nowWord && !readOnly && <span className="font-normal text-muted-foreground"> ({nowWord})</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="text-foreground/85">{label}</span>
            {part && ` · ${part}`}
            {source && ` · ${source}`}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <StatusDot tone={status.tone} label={status.label} />
            {waitingOn.length > 0 && <span>· {waitingOn.join(' or ')}</span>}
            {away && !readOnly && <span>· back {backDay(r.endDate, holidaySet)}</span>}
          </p>
          {reason && <p className="mt-0.5 text-xs text-muted-foreground">Why: {reason}</p>}
          {stillInVt && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300" data-testid={`still-in-vt-${r.id}`}>Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.</p>}
          {isEditing && <p className="mt-0.5 text-xs font-medium text-primary">Changing…</p>}
        </div>
        {!confirming && (editable || cancellable) && (
          <span className="-mr-1.5 flex shrink-0 items-center">
            {editable && !isEditing && (
              <button type="button" className={`${BTN_QUIET} h-9 w-9 px-0`} onClick={() => onEdit(r)} aria-label={`Change ${label}, ${dates}`} title="Change">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {cancellable && (
              <button type="button" className={`${BTN_QUIET} h-9 w-9 px-0`} onClick={() => setConfirming(true)} aria-label={`Cancel ${label}, ${dates}`} title="Cancel">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </div>
      {confirming && (
        <div role="group" aria-label="Confirm cancel" className="mt-2 space-y-2 pl-[2.125rem] text-sm animate-fadeIn">
          <p className="text-foreground/85">
            Cancel {type?.name?.toLowerCase() || 'this request'} for {dates}?
            {fromVt && <span className="block text-xs text-muted-foreground">It came from Vacation Tracker. Ticket Pulse cancels it there too when it can.</span>}
            {fromCal && <span className="block text-xs text-muted-foreground">It came from the shared calendar. It stays cancelled here; the calendar entry is not changed.</span>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={doCancel}
              disabled={busy}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Cancel request
            </button>
            <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)} disabled={busy}>Keep it</button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function ComingUpCard({
  requests,
  typeById = new Map(),
  offices = [],
  holidaySet = new Set(),
  today = todayKey(),
  onCancel = null,
  onEdit = null,
  editingId = null,
  onOpenHistory = null,
  historyHref = null,
  className = CARD,
}) {
  const [showAll, setShowAll] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const loading = requests === null || requests === undefined;
  const upcoming = loading ? [] : upcomingRequests(requests, today);
  const past = loading ? [] : pastRequests(requests, today);
  const shown = showAll ? upcoming : upcoming.slice(0, SHOW);
  const row = (r, readOnly = false) => (
    <ComingUpRow
      key={r.id}
      r={r}
      type={typeById.get(r.leaveTypeId)}
      today={today}
      offices={offices}
      holidaySet={holidaySet}
      onCancel={onCancel}
      onEdit={onEdit}
      isEditing={editingId === r.id}
      readOnly={readOnly}
    />
  );

  return (
    <section className={`min-w-0 ${className}`} aria-labelledby="mt-coming-up" data-testid="coming-up-card">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="mt-coming-up" className="text-sm font-semibold text-foreground">Coming up</h2>
        {!loading && <span className="text-xs text-muted-foreground" data-testid="coming-up-count">{plural(upcoming.length, 'request', 'requests')}</span>}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading your requests…</p>
      ) : !upcoming.length ? (
        <p className="py-3 text-sm text-muted-foreground">Nothing booked yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border/70" data-testid="coming-up-list">
          {shown.map((r) => row(r))}
        </ul>
      )}
      {upcoming.length > SHOW && (
        <button type="button" className={`${LINK} mb-1`} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? 'Show fewer' : `Show ${upcoming.length - SHOW} more`}
        </button>
      )}
      <div className="mt-2 border-t border-border/70 pt-2.5">
        {onOpenHistory ? (
          <a
            href={historyHref || '#'}
            className={LINK}
            onClick={(e) => { e.preventDefault(); onOpenHistory(); }}
            data-testid="coming-up-history"
          >
            Past and cancelled requests are in History <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : past.length > 0 ? (
          <>
            <button type="button" className={LINK} onClick={() => setShowPast((v) => !v)} aria-expanded={showPast} aria-controls={showPast ? 'mt-past' : undefined} data-testid="coming-up-past-toggle">
              {showPast ? 'Hide past and cancelled requests' : `Past and cancelled requests (${past.length})`}
            </button>
            {showPast && (
              <ul id="mt-past" className="mt-1 divide-y divide-border/70 animate-fadeIn" aria-label="Past and cancelled requests">
                {past.map((r) => row(r, true))}
              </ul>
            )}
          </>
        ) : (
          !loading && <p className="text-xs text-muted-foreground">Past and cancelled requests will show here.</p>
        )}
      </div>
    </section>
  );
}
