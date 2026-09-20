import { useEffect, useRef } from 'react';
import { GitMerge, X } from 'lucide-react';
import { StatusPill, formatDay } from './ticketUi';

/**
 * The bulk "Details" side panel (QA 09-18 #3): what is selected, one line
 * per ticket, drop any of them, and the merge shortcut with the same gate the
 * bar uses. Actions stay on the bar underneath — this is the selection's
 * inspector, not a second toolbar.
 */
export default function BulkSelectionPanel({ tickets = [], onRemove, onClose, onMerge, mergeBlockedReason = null }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const fsBorn = tickets.filter((t) => t.origin !== 'ticketpulse').length;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Selected tickets"
      data-testid="bulk-selection-panel"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(440px,100vw)] flex-col border-l border-border bg-card shadow-soft motion-on:animate-slide-in-right"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-foreground">{tickets.length} selected</h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {fsBorn > 0
              ? `${fsBorn} FreshService-born — read-only here except tags, and can only be folded into a Ticket Pulse ticket.`
              : 'All Ticket Pulse–born: every bulk action applies.'}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="tp-focus-ring rounded-lg p-1 text-muted-foreground hover:bg-muted">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto settings-scrollbar">
        {tickets.map((t) => (
          <li key={t.id} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">{t.subject || '(no subject)'}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                <span className="font-mono">{t.displayRef}</span>
                {t.requester?.name && <span>{t.requester.name}</span>}
                {t.createdAt && <span>{formatDay(t.createdAt)}</span>}
                {t.origin !== 'ticketpulse' && <span className="text-emerald-700 dark:text-emerald-300">FreshService</span>}
              </span>
            </span>
            <StatusPill status={t.status} size="sm" />
            <button
              onClick={() => onRemove?.(t.id)}
              aria-label={`Remove ${t.displayRef} from the selection`}
              className="tp-focus-ring rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus:opacity-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {tickets.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted-foreground">Nothing selected.</li>}
      </ul>
      <div className="border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={onMerge}
          disabled={Boolean(mergeBlockedReason)}
          title={mergeBlockedReason || undefined}
          className="tp-focus-ring inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GitMerge className="h-4 w-4" aria-hidden="true" />
          Merge these into one ticket
        </button>
        {mergeBlockedReason && <p className="mt-1.5 text-[11px] text-muted-foreground">{mergeBlockedReason}</p>}
      </div>
    </aside>
  );
}
