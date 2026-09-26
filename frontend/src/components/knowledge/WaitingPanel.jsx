import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Hourglass, MailCheck } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { formatDayTime, timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading, PersonLine } from './knowledgeUi';
import { IconTile } from './builderUi';

/**
 * Tickets Auto-help answered and is waiting on (park kind 'auto_help'): who
 * it waits on, what happens next (the check-in, or the close) and when.
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
          Tickets whose Auto-help answer was sent wait here for the requester. &ldquo;It worked&rdquo; or silence closes them on the
          playbook&rsquo;s schedule; a reply asking for help sends them straight back to a person.
        </EmptyState>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((p) => (
        <li key={p.parkId} className="tp-card flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
          <IconTile icon={MailCheck} size="sm" className="hidden sm:inline-flex" />
          <Link to={`/tickets/${p.ticketId}`} className="tp-focus-ring min-w-0 flex-1 rounded">
            <p className="truncate text-sm font-medium text-foreground"><span className="text-muted-foreground">{p.ticketRef}</span> · {p.subject}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <PersonLine person={p.requesterName ? { name: p.requesterName, email: p.requesterEmail } : null} email={p.requesterEmail} />
              {p.playbookName && <span className="truncate">· {p.playbookName}</span>}
              {p.sentAt && <span className="whitespace-nowrap">· answered {timeAgo(p.sentAt)}</span>}
            </p>
          </Link>
          <span className="text-xs font-medium tabular-nums text-foreground/80 sm:text-right" data-testid="waiting-next">
            {p.nextStep === 'close' ? 'Checked in · closes' : 'Checks in'} {formatDayTime(p.until)}
          </span>
        </li>
      ))}
    </ul>
  );
}
