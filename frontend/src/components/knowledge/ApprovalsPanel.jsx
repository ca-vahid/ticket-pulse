import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { knowledgeAPI, ticketsAPI } from '../../services/api';
import AutoHelpSuggestion from '../tickets/AutoHelpSuggestion';
import { timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading } from './knowledgeUi';

/**
 * Knowledge → Approvals (30 Sep 2026, Vahid): every Auto-help answer waiting
 * for a person in this workspace, for reviewers and admins. Each one is the
 * same card the ticket shows — read, edit and send, or dismiss — without
 * opening the ticket. The assignee can still send it from the ticket;
 * whoever acts first wins (the other sees it's gone).
 */
export default function ApprovalsPanel() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await knowledgeAPI.approvals();
      setItems(res?.data || []);
      setError(null);
    } catch (err) {
      setError(err?.message || 'Could not load the approvals');
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = (id) => {
    setItems((list) => (list || []).filter((x) => x.id !== id));
    setDone((n) => n + 1);
  };

  if (items === null) return <Loading label="Loading answers waiting for approval…" />;

  return (
    <div className="space-y-4" data-testid="approvals-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <p className="text-sm text-foreground/85">
          <span className="font-semibold tabular-nums">{items.length}</span> Auto-help answer{items.length === 1 ? '' : 's'} waiting to be sent
        </p>
        {done > 0 && <p className="text-xs text-emerald-700 dark:text-emerald-300" role="status">{done} handled here just now</p>}
        <p className="text-xs text-muted-foreground sm:ml-auto">The assignee can also send it from the ticket — whoever acts first wins.</p>
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={CheckCircle2} title="Nothing waiting">
            Answers appear here when a playbook in approve mode drafts one. In shadow mode nothing is suggested, so this stays empty.
          </EmptyState>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="approvals-list">
          {items.map((p) => (
            <li key={p.id} className="tp-card p-3 sm:p-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <Link to={`/tickets/${p.ticketId}`} className="tp-focus-ring inline-flex items-center gap-1 rounded font-semibold text-foreground hover:underline">
                  {p.ticket?.ref} · {p.ticket?.subject} <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </Link>
                <span className="text-xs text-muted-foreground">
                  {p.ticket?.requester?.name ? `from ${p.ticket.requester.name} · ` : ''}
                  {p.ticket?.assignee?.name ? `assigned to ${p.ticket.assignee.name}` : 'not assigned yet'}
                  {' · '}waiting {timeAgo(p.createdAt)}
                </span>
              </div>
              <AutoHelpSuggestion
                proposal={p}
                onSend={async (body) => {
                  await ticketsAPI.sendProposedReply(p.ticketId, p.id, body);
                  remove(p.id);
                }}
                onDismiss={async (reason) => {
                  await ticketsAPI.dismissProposedReply(p.ticketId, p.id, { reason });
                  remove(p.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
