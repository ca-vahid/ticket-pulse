import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { formatDayTime } from '../tickets/ticketUi';
import { EmptyState, Loading, PersonLine } from './knowledgeUi';

/**
 * Tickets Auto-help answered and is waiting on (park kind 'auto_help').
 * Always empty in P0 — nothing is sent, so nothing waits.
 */
export default function WaitingPanel() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.waiting()
      .then((res) => { if (!cancelled) setItems(res?.data || []); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the waiting list'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!items) return <Loading label="Loading the waiting list…" />;
  if (!items.length) {
    return (
      <div className="tp-card" data-testid="waiting-empty">
        <EmptyState icon={Hourglass} title="Nobody is waiting on Auto-help">
          This list fills once sending is switched on (next phase): tickets that got an automatic answer wait here
          for the requester — a reply sends them back to a person, silence closes them on the playbook&rsquo;s schedule.
        </EmptyState>
      </div>
    );
  }
  return (
    <ul className="tp-card divide-y divide-border/70 overflow-hidden">
      {items.map((p) => (
        <li key={p.parkId} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <Link to={`/tickets/${p.ticketId}`} className="tp-focus-ring min-w-0 flex-1 rounded">
            <p className="truncate text-sm font-medium text-foreground"><span className="text-muted-foreground">{p.ticketRef}</span> · {p.subject}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <PersonLine person={p.requesterName ? { name: p.requesterName, email: p.requesterEmail } : null} email={p.requesterEmail} />
              {p.reason && <span className="truncate">· {p.reason}</span>}
            </p>
          </Link>
          <span className="text-xs tabular-nums text-muted-foreground">until {formatDayTime(p.until)}</span>
        </li>
      ))}
    </ul>
  );
}
