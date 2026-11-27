import { useCallback, useEffect, useMemo, useState } from 'react';
import { availabilityAPI } from '../../services/api';
import { notifyAvailabilityChanged } from '../../hooks/useAvailabilityApprovalCount';
import BookTimeForm from './BookTimeForm';
import ComingUpCard from './ComingUpCard';
import { CARD, ErrorNote, todayKey } from './availabilityUi';

/** Fired by the page's "Book time away" button: leave a change and book anew. */
export const BOOK_NEW_EVENT = 'tp:availability-book-new';

/**
 * My time (redesigned for QA 11-25 #1): "Book time away" (about two thirds)
 * beside "Coming up" (a third). The balances strip that sat on top went in QA
 * 11-26 #1: the Overview shows the same balances (left or over, taken of the
 * allowance, booked and waiting), and the booking's check says what is left
 * after it. On a phone
 * it is one column, the booking first. The long list of every request is gone:
 * Coming up shows the approved and waiting ones that are not over, and past
 * or cancelled requests are in History (admins) or folded under Coming up.
 *
 * After a booking, change or cancel the page reloads /me (balances move) and
 * the requests. "Change" on a waiting request turns the form into "Change
 * your request" (Nov 2026) until it is saved or left as it was.
 */
export default function MyTimePanel({ me, onChanged, toast, bookType = null, onOpenHistory = null, historyHref = null }) {
  const [requests, setRequests] = useState(null);
  const [holidays, setHolidays] = useState({});
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const today = todayKey();
  // Overview's one-click buttons arrive with the leave type to start on.
  const presetTypeId = Number(bookType) || null;
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);
  const holidaySet = useMemo(() => new Set(Object.keys(holidays)), [holidays]);

  const load = useCallback(() => {
    availabilityAPI.myRequests()
      .then((res) => { setRequests(Array.isArray(res?.data) ? res.data : []); setError(null); })
      .catch((err) => { setRequests([]); setError(err?.message || 'Could not load your requests'); });
  }, []);

  useEffect(() => { load(); }, [load]);
  // The calendar mutes holidays: the next ones within a year (the most the API gives).
  useEffect(() => {
    let live = true;
    if (typeof availabilityAPI.upcomingHolidays !== 'function') return undefined;
    Promise.resolve()
      .then(() => availabilityAPI.upcomingHolidays(10))
      .then((res) => { if (live) setHolidays(Object.fromEntries((Array.isArray(res?.data) ? res.data : []).map((h) => [String(h.date).slice(0, 10), h.name || 'Holiday']))); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const leave = () => setEditing(null);
    window.addEventListener(BOOK_NEW_EVENT, leave);
    return () => window.removeEventListener(BOOK_NEW_EVENT, leave);
  }, []);

  const refresh = () => { load(); onChanged?.(); notifyAvailabilityChanged(); };

  const cancel = async (r) => {
    try {
      const res = await availabilityAPI.cancelRequest(r.id);
      // QA 11-09 #2: leave from Vacation Tracker — was it cancelled there too?
      const vt = res?.data?.vacationTracker;
      if (vt && vt.updated === false) toast?.(vt.message || 'Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.', 'amber');
      else toast?.(vt?.updated ? 'Cancelled here and in Vacation Tracker' : 'Request cancelled');
      if (editing?.id === r.id) setEditing(null);
      refresh();
    } catch (err) {
      toast?.(err?.message || 'Could not cancel', 'red');
    }
  };

  const startEditing = (r) => {
    setEditing(r);
    // Bring the form into view (on phones it sits above Coming up).
    setTimeout(() => {
      const form = document.querySelector('form[data-booking-form]');
      form?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      form?.querySelector('input:checked, input, button')?.focus?.({ preventScroll: true });
    }, 60);
  };

  return (
    <div className="min-w-0" data-testid="my-time">
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start" data-testid="my-time-columns">
        <div className={`min-w-0 ${CARD} ${editing ? 'ring-2 ring-primary/40' : ''}`}>
          <BookTimeForm
            key={editing ? `edit-${editing.id}` : `new-${presetTypeId || 0}`}
            presetTypeId={presetTypeId}
            me={me}
            requests={requests || []}
            holidays={holidays}
            today={today}
            editing={editing}
            onStopEditing={() => setEditing(null)}
            onBooked={() => { setEditing(null); refresh(); }}
            toast={toast}
            notice={!editing ? me.settings?.purposeNotice || null : null}
          />
        </div>
        <div className="min-w-0 space-y-3">
          <ErrorNote>{error}</ErrorNote>
          <ComingUpCard
            requests={requests}
            typeById={typeById}
            offices={me.offices || []}
            holidaySet={holidaySet}
            today={today}
            onCancel={cancel}
            onEdit={startEditing}
            editingId={editing?.id ?? null}
            onOpenHistory={onOpenHistory}
            historyHref={historyHref}
          />
        </div>
      </div>
    </div>
  );
}
