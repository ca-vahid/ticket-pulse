import { Fragment, useState } from 'react';
import { ArrowRight, ChevronDown, Loader2, Pencil, X } from 'lucide-react';
import {
  BTN_QUIET, CARD, REQUEST_STATUS, StatusDot, TypeGlyph, fmtAmount, fmtMinute, leaveLabel, sitePlace, todayKey,
} from './availabilityUi';
import { backDay, pastRequests, rangeWords, upcomingRequests } from './bookingModel';

/** Spaces inside a name or a date become no-break spaces, so it never splits across lines. */
const keepTogether = (v) => (v == null ? v : String(v).replace(/ /g, '\u00A0'));

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
 * everyone else can open them here, folded away by default. A cancelled
 * Vacation Tracker leave that is still there stays in view. Every row opens
 * to its details (amount, note, why, the rules' words, the approver's note).
 * Props in, nothing fetched, so it renders on its own in a harness.
 */

const SHOW = 5;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LINK = 'tp-focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline';

function partWords(r) {
  const many = r.startDate !== r.endDate;
  if (r.dayPart === 'am') return many ? 'mornings' : 'morning';
  if (r.dayPart === 'pm') return many ? 'afternoons' : 'afternoon';
  if (r.dayPart === 'hours' && r.startMinute != null) return `${fmtMinute(r.startMinute)}–${fmtMinute(r.endMinute)}`;
  return null;
}

// Separators: the "·" is glued to the word BEFORE it with a no-break space, and
// a plain space follows, so a wrapped line never starts with a dot.
const DOT = ' ·';

function sourceWords(r) {
  // 26 Nov 2026: once Vacation Tracker is retired its bookings live here.
  if (r.source === 'vacation_tracker' && r.vtRetired === true) return 'booked in Vacation Tracker';
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
  // 26 Nov 2026: Vacation Tracker retired — its bookings are changed and cancelled like any other.
  const handedOver = fromVt && r.vtRetired === true;
  const fromCal = r.source === 'shared_calendar';
  const imported = (fromVt && !handedOver) || fromCal;
  const live = r.status === 'pending' || r.status === 'approved';
  const cancellable = !readOnly && Boolean(onCancel) && (imported ? r.status === 'approved' : live) && r.endDate >= today;
  const editable = !readOnly && Boolean(onEdit) && !imported && r.status === 'pending' && r.editable !== false;
  const stillInVt = fromVt && r.status === 'cancelled' && r.stillInVacationTracker === true;
  // A name or a date stays on one line ("Robin Vale", "Mon 4 Jan"); lines may break between them.
  const waitingOn = r.status === 'pending' ? (r.waitingOn || []).map((p) => keepTogether(p.name || p.email)).filter(Boolean) : [];
  const dates = rangeWords(r.startDate, r.endDate, { today });
  const datesShown = dates.split(' – ').map(keepTogether).join(' – ');
  // "(today)" on a day that is today; "(now)" on a range that has started.
  const nowWord = r.startDate === today && r.endDate === today ? 'today' : r.startDate <= today && r.endDate >= today ? 'now' : null;
  const label = leaveLabel(type?.name, sitePlace(r, offices));
  const part = partWords(r);
  const away = !part && (!type?.availability || type.availability === 'OFF') && r.status !== 'denied' && r.status !== 'cancelled';
  const source = sourceWords(r);
  const tail = [waitingOn.length > 0 ? waitingOn.join(' or ') : null, away && !readOnly ? keepTogether(`back ${backDay(r.endDate, holidaySet)}`) : null].filter(Boolean);
  // Details, as the old list had them: the note, why it waits (or was decided so), the rules' words, the approver's note, the amount.
  const [open, setOpen] = useState(false);
  const reason = r.decision?.reason || null;
  const fired = (r.decision?.fired || []).filter((f) => f.message && f.message !== reason);
  const detailsId = `coming-up-${r.id}-details`;

  const doCancel = async () => {
    setBusy(true);
    try { await onCancel(r); } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <li className={`py-2.5 ${isEditing ? '-mx-2 rounded-md bg-primary/5 px-2 dark:bg-primary/10' : ''}`} data-testid={`coming-up-${r.id}`}>
      <div className="flex items-start gap-2.5">
        <TypeGlyph type={type} className="mt-0.5 h-6 w-6" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-sm font-semibold text-foreground">
            {datesShown}{nowWord && !readOnly && <span className="whitespace-nowrap font-normal text-muted-foreground"> ({nowWord})</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid={`coming-up-${r.id}-what`}>
            <span className="text-foreground/85">{label}</span>
            {[part, source].filter(Boolean).map((w) => <Fragment key={w}>{`${DOT} `}{w}</Fragment>)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`coming-up-${r.id}-status`}>
            {/* The status dot is an inline box: its trailing "·" rides in the same no-wrap span. */}
            <span className="whitespace-nowrap"><StatusDot tone={status.tone} label={status.label} />{tail.length > 0 && DOT}</span>
            {tail.map((w, i) => <Fragment key={w}>{' '}{w}{i < tail.length - 1 && DOT}</Fragment>)}
          </p>
          {stillInVt && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300" data-testid={`still-in-vt-${r.id}`}>Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.</p>}
          {isEditing && <p className="mt-0.5 text-xs font-medium text-primary">Changing…</p>}
        </div>
        {!confirming && (
          <span className="-mr-1.5 flex shrink-0 items-center">
            <button
              type="button"
              className={`${BTN_QUIET} h-9 w-9 px-0`}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              aria-label={`Details for ${label}, ${dates}`}
              title="Details"
            >
              <ChevronDown className={`h-4 w-4 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {editable && !isEditing && (
              <button type="button" className={`${BTN_QUIET} h-9 w-9 px-0`} onClick={() => onEdit(r)} aria-label={`Change ${label}, ${dates}`} title="Change">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {cancellable && (
              <button type="button" className={`${BTN_QUIET} h-9 w-9 px-0`} onClick={() => setConfirming(true)} aria-label={`Cancel ${label}, ${dates}`} title="Cancel this request">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </div>
      {open && (
        <div id={detailsId} className="mt-2 ml-[2.125rem] space-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground animate-fadeIn" data-testid={`coming-up-${r.id}-details`}>
          <p><span className="text-foreground/85">Amount:</span> {fmtAmount(r, type?.unit)}</p>
          {r.note && <p><span className="text-foreground/85">Your note:</span> {r.note}</p>}
          {reason && <p><span className="text-foreground/85">{r.status === 'pending' ? 'Why it is waiting:' : 'Why:'}</span> {reason}</p>}
          {fired.map((f) => <p key={`${f.ruleId}-${f.name}`}>{f.message}</p>)}
          {r.decisionNote && <p><span className="text-foreground/85">Approver:</span> {r.decisionNote}</p>}
        </div>
      )}
      {confirming && (
        <div role="group" aria-label="Confirm cancel" className="mt-2 space-y-2 pl-[2.125rem] text-sm animate-fadeIn">
          <p className="text-foreground/85">
            Cancel {type?.name?.toLowerCase() || 'this request'} for {dates}?
            {fromVt && !handedOver && <span className="block text-xs text-muted-foreground">It came from Vacation Tracker. Ticket Pulse cancels it there too when it can.</span>}
            {handedOver && <span className="block text-xs text-muted-foreground">Booked in Vacation Tracker, which is retired: it is cancelled here only.</span>}
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
  const allPast = loading ? [] : pastRequests(requests, today);
  // A Vacation Tracker leave cancelled here that is still there, and not over:
  // something left for the person to do, so it stays in view (not folded away).
  const stillInVt = allPast.filter((r) => r.source === 'vacation_tracker' && r.status === 'cancelled' && r.stillInVacationTracker === true && r.endDate >= today);
  const past = allPast.filter((r) => !stillInVt.includes(r));
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
      {stillInVt.length > 0 && (
        <div className="mt-2 border-t border-border/70 pt-2" data-testid="coming-up-still-in-vt">
          <h3 className="text-xs font-medium text-amber-700 dark:text-amber-300">Still in Vacation Tracker</h3>
          <ul className="divide-y divide-border/70" aria-label="Still in Vacation Tracker">
            {stillInVt.map((r) => row(r, true))}
          </ul>
        </div>
      )}
      <div className="mt-2 border-t border-border/70 pt-2.5">
        {onOpenHistory ? (
          <a
            href={historyHref || '#'}
            className={LINK}
            onClick={(e) => {
              // A new tab or window (Ctrl/Cmd/Shift-click, middle click) follows the link as usual.
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onOpenHistory();
            }}
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
