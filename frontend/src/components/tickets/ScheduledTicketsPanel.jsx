import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, AlertCircle, CalendarClock, Check, Loader2, Play, Repeat, Trash2 } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { formatDayTime, timeAgo } from './ticketUi';

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
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this view.
  const backState = { from: `${location.pathname}${location.search}` };
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
        <Activity className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-300" aria-label="Loading scheduled tickets" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="tp-card rounded-xl p-3 flex items-start gap-2" role="alert">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-red-700 dark:text-red-200">{error}</span>
        </div>
      )}

      <div className="tp-card rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border/60 bg-muted/35 flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-violet-500" aria-hidden="true" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Waiting to activate ({data.pending.length})
          </span>
        </div>
        {data.pending.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground/75">
            Nothing scheduled. Use New ticket → Schedule for later.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.pending.map((row) => (
              <li key={row.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap ${
                  row.status === 'error'
                    ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30'
                    : 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30'
                }`}
                >
                  <CalendarClock className="w-3 h-3" aria-hidden="true" />
                  {formatDayTime(row.scheduledForAt)}
                  <span className="font-normal">· {inFuture(row.scheduledForAt)}</span>
                </span>
                {row.recurrence && row.recurrence !== 'none' && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap bg-cyan-50 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-200 border-cyan-200 dark:border-cyan-500/30"
                    title={`Repeats ${row.recurrence} at the same local time${row.lastSpawnedAt ? ` — last spawned ${formatDayTime(row.lastSpawnedAt)} · ${timeAgo(row.lastSpawnedAt)}` : ''}`}
                  >
                    <Repeat className="w-3 h-3" aria-hidden="true" />
                    {row.recurrence}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground truncate">{row.payload?.subject || '(no subject)'}</span>
                  <span className="block text-xs text-muted-foreground/75 truncate">
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
                    idle: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-100 dark:hover:bg-emerald-500/20',
                    active: 'bg-emerald-600 text-white border-emerald-600',
                  },
                  () => ticketsAPI.activateScheduled(row.id),
                )}
                {ticketingOn && confirmable(
                  `cancel:${row.id}`,
                  row.recurrence && row.recurrence !== 'none' ? 'Stop repeating' : 'Cancel',
                  <Trash2 className="w-3 h-3" aria-hidden="true" />,
                  {
                    idle: 'bg-card text-muted-foreground border-border hover:border-red-300 dark:hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-300',
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
          <div className="px-4 py-2.5 border-b border-border/60 bg-muted/35 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Recently activated</span>
          </div>
          <ul className="divide-y divide-border/60">
            {data.recent.map((row) => (
              <li key={row.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.payload?.subject || '(no subject)'}</span>
                <span className="text-xs text-muted-foreground/75 whitespace-nowrap">activated {formatDayTime(row.activatedAt)} · {timeAgo(row.activatedAt)}</span>
                {row.ticketId && (
                  <Link to={`/tickets/${row.ticketId}`} state={backState} className="tp-focus-ring text-xs font-semibold text-blue-700 dark:text-blue-200 hover:underline rounded whitespace-nowrap">
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
