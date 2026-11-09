import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import { notifyAvailabilityChanged } from '../../hooks/useAvailabilityApprovalCount';
import BalancesRow from './BalancesRow';
import BookTimeForm from './BookTimeForm';
import MyRequestsList from './MyRequestsList';
import { CARD, ErrorNote } from './availabilityUi';

/** Fired by the page's "Book time away" button: leave a change and book anew. */
export const BOOK_NEW_EVENT = 'tp:availability-book-new';

/**
 * My time: balances on top, the booking form beside my requests. After a
 * booking, change or cancel the page reloads /me (balances move) and the list.
 * "Change" on a waiting request turns the form into "Change your request"
 * (Nov 2026) until it is saved or left as it was.
 */
export default function MyTimePanel({ me, onChanged, toast }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);

  const load = useCallback(() => {
    availabilityAPI.myRequests()
      .then((res) => { setRequests(Array.isArray(res?.data) ? res.data : []); setError(null); })
      .catch((err) => { setRequests([]); setError(err?.message || 'Could not load your requests'); });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const leave = () => setEditing(null);
    window.addEventListener(BOOK_NEW_EVENT, leave);
    return () => window.removeEventListener(BOOK_NEW_EVENT, leave);
  }, []);

  const refresh = () => { load(); onChanged?.(); notifyAvailabilityChanged(); };

  const cancel = async (r) => {
    try {
      await availabilityAPI.cancelRequest(r.id);
      toast?.('Request cancelled');
      if (editing?.id === r.id) setEditing(null);
      refresh();
    } catch (err) {
      toast?.(err?.message || 'Could not cancel', 'red');
    }
  };

  const startEditing = (r) => {
    setEditing(r);
    // Bring the form into view (on phones it sits above the list).
    setTimeout(() => {
      const form = document.querySelector('form[data-booking-form]');
      form?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      form?.querySelector('input:checked, input, button')?.focus?.({ preventScroll: true });
    }, 60);
  };

  return (
    <div>
      <BalancesRow balances={me.balances} leaveTypes={me.leaveTypes} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
        <div className={`${CARD} ${editing ? 'ring-2 ring-primary/40' : ''}`}>
          <BookTimeForm
            key={editing ? `edit-${editing.id}` : 'new'}
            me={me}
            editing={editing}
            onStopEditing={() => setEditing(null)}
            onBooked={() => { setEditing(null); refresh(); }}
            toast={toast}
          />
          {me.settings?.purposeNotice && !editing && (
            <p className="mt-4 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{me.settings.purposeNotice}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <ErrorNote>{error}</ErrorNote>
          <MyRequestsList requests={requests} typeById={typeById} onCancel={cancel} onEdit={startEditing} editingId={editing?.id ?? null} />
        </div>
      </div>
    </div>
  );
}
