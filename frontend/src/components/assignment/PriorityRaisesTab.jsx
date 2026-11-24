import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, RefreshCw } from 'lucide-react';
import { priorityRaisesAPI } from '../../services/api';
import { pacificWhen } from '../../utils/priorityReason';

/**
 * Assignment Review → Raised by requester (QA 11-23 #2). Tickets the AI rated
 * Medium or Low that the requester raised from their status link in the last
 * days — the coordinators' weekly look at where the AI under-rated a request.
 * About tickets, never a ranking of people. Coordinator (reviewer) or higher.
 */
const PERIODS = [7, 14, 30];
const LEVEL_TONE = {
  low: 'text-muted-foreground',
  medium: 'text-amber-700 dark:text-amber-300',
  high: 'text-orange-700 dark:text-orange-300',
  urgent: 'text-red-700 dark:text-red-300',
};

function Level({ value }) {
  const tone = LEVEL_TONE[String(value || '').toLowerCase()] || 'text-foreground';
  return <span className={`font-semibold ${tone}`}>{value || 'Unknown'}</span>;
}

function Move({ from, to }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Level value={from} />
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/70" aria-label="raised to" />
      <Level value={to} />
    </span>
  );
}

export default function PriorityRaisesTab() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await priorityRaisesAPI.list(days); // GET /api/assignment/priority-raises
      setRows(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      const status = err?.response?.status;
      setError(status === 403
        ? 'Only coordinators and admins can see this list.'
        : err?.response?.data?.message || err?.message || 'Could not load the list.');
      setRows(null);
    }
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const count = rows?.length || 0;
  const verdict = rows
    ? count === 0
      ? `No requester raised a Medium or Low ticket in the last ${days} days.`
      : `${count === 1 ? '1 ticket' : `${count} tickets`} in the last ${days} days: the AI rated ${count === 1 ? 'it' : 'them'} Medium or Low, and the requester raised ${count === 1 ? 'it' : 'them'} from their status link.`
    : null;

  return (
    <section className="tp-card rounded-xl p-4 sm:p-5" aria-labelledby="priority-raises-heading" data-testid="priority-raises-tab">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="priority-raises-heading" className="text-base font-bold text-foreground">Raised by requester</h2>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Period">
          {PERIODS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={`tp-focus-ring rounded-md px-2.5 py-1 text-sm ${days === d ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {d} days
            </button>
          ))}
          <button type="button" onClick={load} aria-label="Refresh" title="Refresh" className="tp-focus-ring rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {loading && !rows && !error && (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
      )}
      {error && <p className="py-8 text-sm text-destructive" role="alert">{error}</p>}

      {rows && (
        <>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="priority-raises-verdict">{verdict}</p>
          {count > 0 && (
            <>
              {/* Desktop: a plain table. */}
              <table className="mt-3 hidden w-full text-sm md:table">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1.5 pr-3 font-medium">Ticket</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">Subject</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">AI rated → raised to</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">Raised by</th>
                    <th scope="col" className="py-1.5 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.ticketId} data-testid="priority-raise-row">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Link to={`/tickets/${r.ticketId}`} className="tp-focus-ring rounded font-mono text-primary hover:underline">{r.displayRef || `#${r.ticketId}`}</Link>
                      </td>
                      <td className="max-w-[28rem] truncate py-2 pr-3 text-foreground" title={r.subject || undefined}>{r.subject || 'No subject'}</td>
                      <td className="py-2 pr-3"><Move from={r.aiPriority} to={r.raisedTo} /></td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.requesterName || 'The requester'}</td>
                      <td className="py-2 whitespace-nowrap tabular-nums text-muted-foreground">{pacificWhen(r.raisedAt) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Phone: one block per ticket. */}
              <ul className="mt-3 divide-y divide-border md:hidden">
                {rows.map((r) => (
                  <li key={r.ticketId} className="py-2.5 text-sm" data-testid="priority-raise-item">
                    <div className="flex items-baseline gap-2">
                      <Link to={`/tickets/${r.ticketId}`} className="tp-focus-ring rounded font-mono text-primary hover:underline">{r.displayRef || `#${r.ticketId}`}</Link>
                      <Move from={r.aiPriority} to={r.raisedTo} />
                    </div>
                    <p className="mt-0.5 break-words text-foreground">{r.subject || 'No subject'}</p>
                    <p className="text-xs text-muted-foreground">{r.requesterName || 'The requester'} · {pacificWhen(r.raisedAt) || '—'}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
