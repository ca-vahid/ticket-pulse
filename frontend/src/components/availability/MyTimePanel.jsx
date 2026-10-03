import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import BalancesRow from './BalancesRow';
import BookTimeForm from './BookTimeForm';
import MyRequestsList from './MyRequestsList';
import { CARD, ErrorNote } from './availabilityUi';

/**
 * My time: balances on top, the booking form beside my requests. After a
 * booking or cancel the page reloads /me (balances move) and the list.
 */
export default function MyTimePanel({ me, onChanged, toast }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);

  const load = useCallback(() => {
    availabilityAPI.myRequests()
      .then((res) => { setRequests(Array.isArray(res?.data) ? res.data : []); setError(null); })
      .catch((err) => { setRequests([]); setError(err?.message || 'Could not load your requests'); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = () => { load(); onChanged?.(); };

  const cancel = async (r) => {
    try {
      await availabilityAPI.cancelRequest(r.id);
      toast?.('Request cancelled');
      refresh();
    } catch (err) {
      toast?.(err?.message || 'Could not cancel', 'red');
    }
  };

  return (
    <div>
      <BalancesRow balances={me.balances} leaveTypes={me.leaveTypes} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
        <div className={CARD}>
          <BookTimeForm me={me} onBooked={refresh} toast={toast} />
          {me.settings?.purposeNotice && (
            <p className="mt-4 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{me.settings.purposeNotice}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <ErrorNote>{error}</ErrorNote>
          <MyRequestsList requests={requests} typeById={typeById} onCancel={cancel} />
        </div>
      </div>
    </div>
  );
}
