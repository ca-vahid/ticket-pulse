import { useEffect, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { searchAPI } from '../../services/api';

/** Ticket typeahead for "Attach to ticket" — global search, tickets only. */
export function TicketPicker({ onPick, onCancel, initialQuery = '' }) {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return undefined; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      searchAPI.global(term, 'tickets')
        .then((res) => { if (alive) setResults(res.data?.sections?.tickets || []); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  return (
    <div className="mt-2 p-2 rounded-lg border border-border bg-muted/50 space-y-2" data-testid="held-ticket-picker">
      <div className="flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets — TP-1204, subject, requester…"
          aria-label="Search tickets to attach to"
          className="flex-1 text-sm bg-card border border-border rounded-md px-2 py-1.5"
        />
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/75" aria-hidden="true" />}
        <button type="button" onClick={onCancel} aria-label="Cancel attach" className="p-1 rounded-md text-muted-foreground/75 hover:text-foreground hover:bg-muted tp-focus-ring">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {results.length > 0 && (
        <ul className="max-h-48 overflow-y-auto settings-scrollbar divide-y divide-border/60 rounded-md border border-border bg-card">
          {results.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted tp-focus-ring flex items-center gap-2"
              >
                <span className="font-mono text-xs text-primary">{t.displayRef}</span>
                <span className="truncate text-foreground">{t.subject}</span>
                <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{t.status}{t.requesterName ? ` · ${t.requesterName}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && !busy && results.length === 0 && (
        <p className="text-xs text-muted-foreground/75 px-1">No tickets match.</p>
      )}
    </div>
  );
}
