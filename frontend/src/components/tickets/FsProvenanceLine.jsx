import { useState } from 'react';
import { Archive, ExternalLink, Loader2, TicketCheck } from 'lucide-react';
import { adoptedAtOf, isAdoptedTicket, isImportedTicket, ticketFsUrl } from './ticketUi';

/**
 * FreshService switch (25 Nov 2026): one quiet line under the ticket subject.
 *
 *  - Imported: a FreshService-born ticket in a workspace whose FreshService is
 *    off. Read-only history; "Adopt to edit" (agents and admins) makes it a
 *    Ticket Pulse ticket after a one-line confirm.
 *  - Adopted: "Adopted from FreshService #12345 on 2 Dec". A link to the old
 *    ticket only while FreshService exists for the workspace (connected or
 *    Shadow); otherwise plain text, never a dead link.
 *
 * Props in, no fetches: the page passes `onAdopt` (POST /tickets/:id/adopt,
 * then reload) so the line renders the same in tests and screenshots.
 */

const PACIFIC = 'America/Vancouver';

/** "2 Dec" (Pacific), with the year when it isn't this year. Exported for tests. */
export function adoptedDateLabel(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const year = (x) => Number(x.toLocaleString('en-US', { timeZone: PACIFIC, year: 'numeric' }));
  return d.toLocaleDateString('en-GB', {
    timeZone: PACIFIC, day: 'numeric', month: 'short', ...(year(d) !== year(now) ? { year: 'numeric' } : {}),
  });
}

export default function FsProvenanceLine({ ticket, fsEnabled = true, canAdopt = false, onAdopt = null, adopting = false, error = null }) {
  const [confirming, setConfirming] = useState(false);
  if (!ticket) return null;
  const fsRef = ticket.freshserviceTicketId ? `#${String(ticket.freshserviceTicketId)}` : null;

  if (isAdoptedTicket(ticket)) {
    const when = adoptedDateLabel(adoptedAtOf(ticket));
    const text = `Adopted from FreshService${fsRef ? ` ${fsRef}` : ''}${when ? ` on ${when}` : ''}`;
    const url = ticketFsUrl(ticket, { fsEnabled });
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="fs-adopted-line">
        <TicketCheck className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/75" aria-hidden="true" />
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="tp-focus-ring inline-flex items-center gap-1 rounded hover:text-foreground hover:underline" title="Open the old ticket in FreshService (it is no longer updated)">
            {text} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : <span>{text}</span>}
      </p>
    );
  }

  if (!isImportedTicket(ticket, fsEnabled)) return null;

  return (
    <div className="mt-1 text-xs text-muted-foreground" data-testid="fs-imported-line">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Archive className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/75" aria-hidden="true" />
        <span>Imported from FreshService{fsRef ? ` ${fsRef}` : ''} · read-only</span>
        {canAdopt && onAdopt && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="tp-focus-ring rounded font-semibold text-primary hover:underline"
          >
            Adopt to edit
          </button>
        )}
      </p>
      {confirming && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5" role="group" aria-label="Adopt this ticket">
          <span className="text-foreground/85">This makes it a Ticket Pulse ticket (a new TP number), fully editable here. FreshService&rsquo;s copy is no longer updated.</span>
          <button
            type="button"
            disabled={adopting}
            onClick={async () => { await onAdopt?.(); setConfirming(false); }}
            className="tp-focus-ring inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {adopting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {adopting ? 'Adopting…' : 'Adopt'}
          </button>
          <button type="button" disabled={adopting} onClick={() => setConfirming(false)} className="tp-focus-ring rounded px-1 font-medium hover:text-foreground">
            Cancel
          </button>
        </p>
      )}
      {error && <p className="mt-1 pl-5 text-destructive" role="alert">{error}</p>}
    </div>
  );
}
