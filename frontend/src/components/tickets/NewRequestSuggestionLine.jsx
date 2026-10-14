import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Split } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * "This reply looks like a new request" (13 Oct 2026): one quiet line above
 * the conversation when a reply reopened a ticket that had been resolved for
 * more than a day and reads like different work. Two answers: split the reply
 * into its own ticket, or keep it here. Nothing is ever split automatically.
 *
 * Self-contained: it asks for the ticket's waiting suggestion itself (and
 * again whenever `refreshKey` changes), so the ticket payload is untouched.
 * Renders nothing when there is no suggestion, or when the lookup fails.
 */
export default function NewRequestSuggestionLine({ ticketId, refreshKey = null, canSplit = false, onSplit = null, onDismissed = null, onError = null }) {
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(null); // 'split' | 'dismiss'
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    if (!ticketId) return;
    try {
      const res = await ticketsAPI.getNewRequestSuggestion(ticketId);
      const data = res?.data?.data ?? res?.data ?? null;
      if (alive.current) setSuggestion(data && data.id && data.state === 'suggested' ? data : null);
    } catch {
      if (alive.current) setSuggestion(null);
    }
  }, [ticketId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!suggestion) return null;

  const answer = async (kind) => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'split') {
        const res = await ticketsAPI.splitNewRequest(ticketId, suggestion.id);
        const data = res?.data?.data ?? res?.data ?? {};
        if (alive.current) setSuggestion(null);
        onSplit?.(data);
      } else {
        await ticketsAPI.dismissNewRequest(ticketId, suggestion.id);
        if (alive.current) setSuggestion(null);
        onDismissed?.();
      }
    } catch (err) {
      onError?.(err.response?.data?.message || err.message);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const link = 'tp-focus-ring rounded text-xs font-semibold text-primary hover:underline disabled:opacity-50';
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-muted-foreground" data-testid="new-request-suggestion" role="status">
      <Split className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="font-semibold text-foreground/85">This reply looks like a new request</span>
        {suggestion.reason ? `: ${suggestion.reason}` : '.'}
      </span>
      <span className="inline-flex items-center gap-3">
        {canSplit && (
          <button type="button" className={link} disabled={busy !== null} onClick={() => answer('split')}>
            {busy === 'split' && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Split into its own ticket
          </button>
        )}
        <button type="button" className={link} disabled={busy !== null} onClick={() => answer('dismiss')}>
          {busy === 'dismiss' && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          It belongs here
        </button>
      </span>
    </div>
  );
}
