import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { workspaceAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Short ticket links (14 Oct 2026): /it/1876, /it/TP-1876, /TP-1876, /246762.
 * Finds the ticket, moves to its workspace when needed, and opens it. When a bare
 * number is both a Ticket Pulse and a FreshService number, the person chooses.
 */
export default function TicketShortLink() {
  const { wsSlug = null, ref = '' } = useParams();
  const navigate = useNavigate();
  const { currentWorkspace, switchWorkspace } = useWorkspace();
  const [state, setState] = useState({ phase: 'loading', matches: [], unknownWorkspace: false });
  const [attempt, setAttempt] = useState(0);
  const currentId = currentWorkspace?.id ?? null;

  const open = (match) => {
    const target = `/tickets/${match.ticketId}`;
    if (match.workspaceId === currentId) navigate(target, { replace: true });
    else switchWorkspace(match.workspaceId, { landOn: target });
  };

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading', matches: [], unknownWorkspace: false });
    workspaceAPI.resolveTicket(ref, wsSlug)
      .then((res) => {
        if (cancelled) return;
        const matches = res?.data?.matches || [];
        if (matches.length === 1) { open(matches[0]); return; }
        setState({ phase: matches.length ? 'choose' : 'none', matches, unknownWorkspace: Boolean(res?.data?.unknownWorkspace) });
      })
      .catch(() => { if (!cancelled) setState({ phase: 'error', matches: [], unknownWorkspace: false }); });
    return () => { cancelled = true; };
    // `open` reads the current workspace; resolving again on a workspace change is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, wsSlug, attempt]);

  const shown = decodeSafe(ref);
  return (
    <div className="tp-page-backdrop min-h-screen px-4 py-16">
      <div className="mx-auto max-w-lg">
        {state.phase === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening {shown}…
          </div>
        )}

        {state.phase === 'choose' && (
          <div className="tp-card p-5">
            <h1 className="text-base font-semibold text-foreground">{shown} matches more than one ticket</h1>
            <p className="mt-1 text-sm text-muted-foreground">The number is used by a Ticket Pulse ticket and a FreshService ticket. Which one?</p>
            <ul className="mt-4 divide-y divide-border">
              {state.matches.map((m) => (
                <li key={m.ticketId}>
                  <button
                    type="button"
                    onClick={() => open(m)}
                    className="tp-focus-ring flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-3 text-left hover:bg-muted"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {m.ref}
                      <span className="font-normal text-muted-foreground"> · {m.matchedAs === 'tp' ? 'Ticket Pulse number' : 'FreshService number'}{m.workspaceName ? ` · ${m.workspaceName}` : ''}</span>
                    </span>
                    <span className="text-sm text-muted-foreground">{m.subject || '(no subject)'}{m.status ? ` · ${m.status}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(state.phase === 'none' || state.phase === 'error') && (
          <div className="tp-card p-5">
            <h1 className="text-base font-semibold text-foreground">
              {state.phase === 'error' ? `Could not look up ${shown}` : `No ticket ${shown} that you can open`}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.phase === 'error'
                ? 'Ticket Pulse did not answer. Try again in a moment.'
                : state.unknownWorkspace
                  ? `There is no workspace "${decodeSafe(wsSlug)}" that you can open.`
                  : 'It may be in a workspace you do not have access to, or the number may be mistyped.'}
            </p>
            <div className="mt-4 flex gap-4 text-sm">
              {state.phase === 'error' && (
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="tp-focus-ring font-medium text-primary hover:underline">Try again</button>
              )}
              <Link to={`/tickets?q=${encodeURIComponent(shown)}`} className="tp-focus-ring font-medium text-primary hover:underline">Search tickets</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function decodeSafe(text) {
  try { return decodeURIComponent(String(text ?? '')); } catch { return String(text ?? ''); }
}
