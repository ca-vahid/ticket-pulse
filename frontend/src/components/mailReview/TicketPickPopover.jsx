import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Search, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { closedNote, fmtRef, isClosedTicket } from './mailReviewText';

/**
 * "Pick another ticket": the tickets the AI looked at, each with why it was a
 * candidate, and a search over the workspace. A closed ticket asks one more
 * thing before anything is sent: reopen it, or add the mail quietly.
 *
 * From sm up it is a popover under the row's buttons: a solid layer above the
 * rows, at most 24rem tall with its own scroll, and it opens upward when there
 * is no room below. On a phone it is a bottom sheet over a scrim.
 */
// The row's buttons (h-8) plus their gap sit between the row text and the popover.
const ABOVE_BUTTONS = 'sm:bottom-11';
function TicketLine({ ticket, why = [], note = '', onPick }) {
  const closed = closedNote(ticket);
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(ticket)}
        className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-none"
        data-testid="mr-pick-option"
      >
        <span className="block text-sm text-foreground [overflow-wrap:anywhere]">
          <span className="font-medium tabular-nums text-primary">{fmtRef(ticket)}</span>
          {ticket.subject ? ` · ${ticket.subject}` : ''}
          <span className="text-muted-foreground">
            {closed ? ` ${closed}` : ticket.status ? ` (${ticket.status})` : ''}{ticket.requesterName ? ` · ${ticket.requesterName}` : ''}
          </span>
        </span>
        {(why.length > 0 || note) && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {note ? `${note}${why.length ? ' · ' : ''}` : ''}{why.join(' · ')}
          </span>
        )}
      </button>
    </li>
  );
}

export default function TicketPickPopover({ suggested = null, candidates = null, error = null, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [asking, setAsking] = useState(null); // the closed ticket waiting for "Reopen it?"
  const titleId = useId();
  const boxRef = useRef(null);
  const [flip, setFlip] = useState(false);

  // Keep it inside the viewport: when it would run past the bottom and there is room above, open upward.
  // Measured on open and again when the list arrives; it never flips back, so it cannot jump about.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || flip || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const overflows = r.bottom > window.innerHeight - 8;
    const roomAbove = r.top - 48 > r.height;
    if (overflows && roomAbove) setFlip(true);
  }, [candidates, flip]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); setSearching(false); return undefined; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => ticketsAPI.mailReviewTicketSearch(term))
        .then((res) => { if (alive) setResults(res?.data || []); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const choose = (ticket) => {
    if (isClosedTicket(ticket)) setAsking(ticket);
    else onPick(ticket, false);
  };

  return (
    <>
      <div className="fixed inset-0 z-[58] bg-slate-900/40 sm:hidden" onClick={onClose} aria-hidden="true" data-testid="mr-pick-scrim" />
      <div
        ref={boxRef}
        role="dialog"
        aria-labelledby={titleId}
        data-mr-popover
        data-testid="mr-pick"
        data-flip={flip ? 'up' : 'down'}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}
        className={`settings-scrollbar isolate overflow-y-auto overscroll-contain border border-border bg-card p-3 shadow-soft max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-[59] max-sm:max-h-[80vh] max-sm:rounded-t-2xl max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-6 sm:absolute sm:left-0 sm:z-40 sm:max-h-96 sm:w-full sm:max-w-xl sm:rounded-xl ${flip ? ABOVE_BUTTONS : 'sm:top-1'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 id={titleId} className="text-sm font-semibold text-foreground">{asking ? `${fmtRef(asking)} is closed. Reopen it?` : 'Pick another ticket'}</h3>
          <button type="button" onClick={onClose} aria-label="Close the ticket list" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {asking ? (
          <div className="mt-2" data-testid="mr-reopen-ask">
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {asking.subject} {closedNote(asking)}. Reopen it when the e-mail asks for something; add it quietly when it is a thank-you or a notice.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button type="button" autoFocus onClick={() => onPick(asking, true)} className="tp-focus-ring h-8 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Add and reopen it
              </button>
              <button type="button" onClick={() => onPick(asking, false)} className="tp-focus-ring h-8 rounded-lg px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted">
              Add, leave it closed
              </button>
              <button type="button" onClick={() => setAsking(null)} className="tp-focus-ring h-8 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
              Back
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search tickets in this workspace"
                placeholder="Search by number, subject or requester"
                className="tp-focus-ring h-8 w-full rounded-lg border border-input bg-card pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground/75"
              />
              {searching && <Activity className="absolute right-2.5 top-2 h-4 w-4 animate-spin text-muted-foreground motion-off:animate-none" aria-label="Searching" />}
            </div>

            {results !== null ? (
              <div className="mt-2">
                <p className="px-2 text-xs font-semibold text-muted-foreground">Search results</p>
                {results.length === 0
                  ? <p className="px-2 py-1.5 text-sm text-muted-foreground">{searching ? 'Searching…' : 'No tickets match.'}</p>
                  : <ul className="mt-0.5">{results.map((t) => <TicketLine key={t.id} ticket={t} onPick={choose} />)}</ul>}
              </div>
            ) : (
              <div className="mt-2">
                <p className="px-2 text-xs font-semibold text-muted-foreground">Tickets the AI looked at</p>
                {error && <p role="alert" className="px-2 py-1.5 text-sm text-red-700 dark:text-red-300">{error}</p>}
                {!error && candidates === null && (
                  <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                    <Activity className="h-4 w-4 animate-spin motion-off:animate-none" aria-hidden="true" /> Loading…
                  </p>
                )}
                {!error && candidates !== null && candidates.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">It found no likely tickets. Search for one above.</p>
                )}
                {candidates && candidates.length > 0 && (
                  <ul className="mt-0.5">
                    {candidates.map((c) => (
                      <TicketLine
                        key={c.ticket.id}
                        ticket={c.ticket}
                        why={c.why || []}
                        note={suggested && c.ticket.id === suggested.id ? 'The AI’s pick' : ''}
                        onPick={choose}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
