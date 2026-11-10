import { CornerDownRight } from 'lucide-react';

/**
 * QA 11-09 #5: a ticket that was closed into another one (ticket grouping's
 * "Combined into", or a manual merge) says where the conversation went, with
 * a link to that ticket — in the Tickets list and in the header search.
 *
 * Quiet text, not a pill: an arrow, the words, the ticket number as the link.
 * A real anchor, so a modified click / middle click opens a new tab natively;
 * a plain click goes to `onOpen(id, event)` (the list's peek, the search's open).
 */
export default function CombinedIntoMark({ into, onOpen = null, className = '' }) {
  if (!into?.id || !into?.displayRef) return null;
  const verb = into.kind === 'merged' ? 'Merged into' : 'Combined into';
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground ${className}`}
      data-testid="combined-into"
    >
      <CornerDownRight className="w-3 h-3 text-violet-500 dark:text-violet-300 flex-shrink-0" aria-hidden="true" />
      <span>{verb}</span>{' '}
      <a
        href={`/tickets/${into.id}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          onOpen(into.id, e);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="tp-focus-ring rounded font-mono font-semibold text-violet-700 dark:text-violet-200 hover:underline"
        aria-label={`${verb} ${into.displayRef}: open ${into.displayRef}`}
      >
        {into.displayRef}
      </a>
    </span>
  );
}
