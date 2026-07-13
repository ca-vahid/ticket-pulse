import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertCircle, CalendarClock, Check, Loader2, Play, Repeat, Trash2 } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { timeAgo } from './ticketUi';

function inFuture(value) {
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return '—';
  const diffMin = Math.round((target - Date.now()) / 60000);
  if (diffMin <= 0) return 'due now';
  if (diffMin < 60) return `in ${diffMin}m`;
  if (diffMin < 48 * 60) return `in ${Math.round(diffMin / 60)}h`;
  return `in ${Math.round(diffMin / 1440)}d`;
}

/**
 * The "Scheduled" view: createTicket payloads waiting for their activation
 * time. Activation replays the payload through the normal create path.
 */
export default function ScheduledTicketsPanel({ ticketingOn = true }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // `${action}:${id}`
  const [confirming, setConfirming] = useState(null); // same key

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.listScheduled();
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setData({ pending: [], recent: [] });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (key, fn) => {
    setBusy(key);
    setConfirming(null);
    try {
      await fn();
      await load();
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };

  const confirmable = (key, label, icon, tone, fn, disabled = false) => (
    <button
      onClick={() => (confirming === key ? act(key, fn) : setConfirming(key))}
      onBlur={() => setConfirming((c) => (c === key ? null : c))}
      disabled={disabled || busy === key}
      className={`tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
        confirming === key ? tone.active : tone.idle
      } disabled:opacity-50`}
    >
      {busy === key ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : icon}
      {confirming === key ? 'Confirm?' : label}
    </button>
  );

  if (data === null) {
    return (
      <div className="tp-card rounded-xl p-16 flex items-center justify-center">
        <Activity className="w-8 h-8 animate-spin text-blue-600" aria-label="Loading scheduled tickets" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="tp-card rounded-xl p-3 flex items-start gap-2" role="alert">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}

      <div className="tp-card rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50/70 flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-violet-500" aria-hidden="true" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Waiting to activate ({data.pending.length})
          </span>
        </div>
        {data.pending.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">
            Nothing scheduled. Use New ticket → Schedule for later.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.pending.map((row) => (
              <li key={row.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap ${
                  row.status === 'error'
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-violet-50 text-violet-700 border-violet-200'
                }`}
                >
                  <CalendarClock className="w-3 h-3" aria-hidden="true" />
                  {new Date(row.scheduledForAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  <span className="font-normal">· {inFuture(row.scheduledForAt)}</span>
                </span>
                {row.recurrence && row.recurrence !== 'none' && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap bg-cyan-50 text-cyan-700 border-cyan-200"
                    title={`Repeats ${row.recurrence} at the same local time${row.lastSpawnedAt ? ` — last spawned ${timeAgo(row.lastSpawnedAt)}` : ''}`}
                  >
                    <Repeat className="w-3 h-3" aria-hidden="true" />
                    {row.recurrence}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800 truncate">{row.payload?.subject || '(no subject)'}</span>
                  <span className="block text-xs text-slate-400 truncate">
                    {row.payload?.requesterName || row.payload?.requesterEmail || 'Unknown requester'}
                    {row.createdByName || row.createdBy ? ` · scheduled by ${row.createdByName || row.createdBy}` : ''}
                    {row.status === 'error' && row.lastError ? <span className="text-red-500"> · failed: {row.lastError.slice(0, 80)}</span> : null}
                  </span>
                </span>
                {ticketingOn && confirmable(
                  `activate:${row.id}`,
                  row.status === 'error' ? 'Retry now' : 'Activate now',
                  <Play className="w-3 h-3" aria-hidden="true" />,
                  {
                    idle: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
                    active: 'bg-emerald-600 text-white border-emerald-600',
                  },
                  () => ticketsAPI.activateScheduled(row.id),
                )}
                {ticketingOn && confirmable(
                  `cancel:${row.id}`,
                  row.recurrence && row.recurrence !== 'none' ? 'Stop repeating' : 'Cancel',
                  <Trash2 className="w-3 h-3" aria-hidden="true" />,
                  {
                    idle: 'bg-white text-slate-500 border-slate-200 hover:border-red-300 hover:text-red-600',
                    active: 'bg-red-600 text-white border-red-600',
                  },
                  () => ticketsAPI.cancelScheduled(row.id),
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.recent.length > 0 && (
        <div className="tp-card rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50/70 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recently activated</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {data.recent.map((row) => (
              <li key={row.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-slate-600">{row.payload?.subject || '(no subject)'}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap">activated {timeAgo(row.activatedAt)}</span>
                {row.ticketId && (
                  <Link to={`/tickets/${row.ticketId}`} className="tp-focus-ring text-xs font-semibold text-blue-700 hover:underline rounded whitespace-nowrap">
                    Open ticket
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
