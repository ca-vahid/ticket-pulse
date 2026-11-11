import { Undo2 } from 'lucide-react';
import { agoWords, formatPacificWhen } from '../../utils/ticketDates';
import { TicketRefLink } from './WaitingRow';
import { resolutionSentence } from './mailReviewText';

/**
 * Mail review → Done: held e-mail resolved in the last 14 days. What happened,
 * who did it (the AI or a person), the ticket, and Undo while it is still safe.
 * Undo acts at once (no confirm); when the server says it is no longer safe,
 * its plain message shows on the row.
 */
export default function DoneList({ rows, errors = {}, busyId = null, onUndo, onDetails }) {
  return (
    <ul className="divide-y divide-border/60" aria-label="Held e-mail already dealt with" data-testid="mr-done">
      {rows.map((item) => {
        const r = item.resolution || {};
        const undoable = r.undoable ?? item.undoable ?? false;
        const who = r.via === 'ai' ? 'the AI' : r.by || 'a person';
        return (
          <li key={item.heldId} className="px-3 py-3 hover:bg-muted/40 sm:px-4" data-testid="mr-done-row">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="min-w-0 shrink-0 truncate text-sm text-foreground/85 max-sm:flex-1" title={item.from?.email || undefined}>
                {item.from?.name || item.from?.email || 'Unknown sender'}
              </span>
              <button
                type="button"
                onClick={() => onDetails?.(item)}
                className="tp-focus-ring min-w-0 rounded text-left text-sm font-medium text-foreground hover:text-primary max-sm:order-3 max-sm:basis-full max-sm:[overflow-wrap:anywhere] sm:flex-1 sm:truncate"
                title="Open the details"
              >
                {item.subject || '(no subject)'}
              </button>
              <time dateTime={r.at || undefined} title={agoWords(r.at) || undefined} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                {formatPacificWhen(r.at)}
              </time>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">
                <span className="font-medium">{resolutionSentence(r)}</span>
                {r.ticket && (
                  <>
                    {' '}<TicketRefLink ticket={r.ticket} />
                    {r.ticket.subject && <span className="text-foreground/85"> · {r.ticket.subject}</span>}
                  </>
                )}
                <span className="text-muted-foreground"> · by {who}</span>
              </p>
              {undoable && (
                <button
                  type="button"
                  disabled={busyId === item.heldId}
                  onClick={() => onUndo?.(item)}
                  className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50"
                  aria-label={`Undo: ${item.subject || 'this e-mail'}`}
                  data-testid="mr-undo"
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo
                </button>
              )}
            </div>
            {errors[item.heldId] && <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300" data-testid="mr-undo-error">{errors[item.heldId]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
