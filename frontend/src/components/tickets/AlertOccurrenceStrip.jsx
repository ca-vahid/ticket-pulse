import { useEffect, useState } from 'react';
import { ExternalLink, Repeat } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { timeAgo } from './ticketUi';

const SHOWN = 5;

function systemLabel(system) {
  return String(system || '').toLowerCase() === 'sentinel' ? 'Sentinel incident' : `${system} record`;
}

/**
 * Monitoring-alert tickets (Sentinel integration, 24 Sep 2026): how often the
 * alert fired, when last, and the incidents in the other system it came from.
 * Renders nothing for ordinary tickets (occurrenceCount 0).
 */
export default function AlertOccurrenceStrip({ ticket }) {
  const count = Number(ticket?.occurrenceCount) || 0;
  const [refs, setRefs] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!ticket?.id || count === 0) { setRefs([]); return undefined; }
    ticketsAPI.externalReferences(ticket.id)
      .then((res) => { if (alive) setRefs(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (alive) setRefs([]); });
    return () => { alive = false; };
  }, [ticket?.id, count]);

  if (count === 0) return null;
  // One incident can hold several alerts of this ticket: list each incident once.
  const incidents = [];
  const seen = new Set();
  for (const r of refs) {
    const key = `${r.system}:${r.incidentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incidents.push(r);
  }
  const shown = open ? incidents : incidents.slice(0, SHOWN);

  return (
    <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground" data-testid="alert-occurrences">
      <p className="flex items-start gap-1.5">
        <Repeat className="mt-px h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground/85">
            {count === 1 ? 'Alert fired once' : `Alert fired ${count} times`}
          </span>
          {ticket.lastOccurrenceAt ? <> · last {timeAgo(ticket.lastOccurrenceAt)}</> : null}
        </span>
      </p>
      {incidents.length > 0 && (
        <ul className="mt-1 ml-5 space-y-0.5">
          {shown.map((r) => (
            <li key={`${r.system}:${r.incidentId}`}>
              {r.url ? (
                <a href={r.url} target="_blank" rel="noreferrer" className="tp-focus-ring inline-flex items-center gap-1 text-primary hover:underline">
                  {systemLabel(r.system)} {r.incidentNumber ? `#${r.incidentNumber}` : r.incidentId}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : (
                <span>{systemLabel(r.system)} {r.incidentNumber ? `#${r.incidentNumber}` : r.incidentId}</span>
              )}
              {r.time ? <span className="text-muted-foreground/75"> · {timeAgo(r.time)}</span> : null}
            </li>
          ))}
          {incidents.length > SHOWN && (
            <li>
              <button type="button" onClick={() => setOpen(!open)} className="tp-focus-ring text-primary hover:underline">
                {open ? 'Show fewer' : `Show all ${incidents.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
