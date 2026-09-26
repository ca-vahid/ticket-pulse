import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Forward, Activity, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import useDialogFocus from '../../hooks/useDialogFocus';

/**
 * "Forward to <team>" (QA 09-25 item 6): confirm with an optional note, send
 * through the existing forward endpoint (description + last public replies),
 * then offer "Resolve as forwarded" — the ticket's own resolve flow, with an
 * internal note saying where it went. The note is posted only AFTER the
 * resolve landed: `onResolve` returns a promise of true (resolved) / false
 * (the resolution-reason prompt was cancelled or the write failed) — on
 * false nothing is written and the dialog stays open.
 *
 * Keys: Enter in the note is a new line; Ctrl/Cmd+Enter forwards. Esc closes
 * unless a send is in flight. Focus is trapped inside and returns to the
 * trigger on close. `suspended` hides the dialog while the resolve flow's
 * own modal (resolution reason) is on screen.
 */
export default function TeamForwardDialog({ ticketId, ticketRef, team, canResolve = false, onResolve, onClose, onSent, suspended = false }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const noteRef = useRef(null);
  const panelRef = useRef(null);
  const trapTab = useDialogFocus(Boolean(team), panelRef);

  useEffect(() => { setTimeout(() => noteRef.current?.focus(), 0); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy && !suspended) { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, suspended, onClose]);

  if (!team) return null;

  const send = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await ticketsAPI.forward(ticketId, { to: [team.email], note: note.trim() });
      setSent(true);
      onSent?.();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Forward failed');
    }
    setBusy(false);
  };

  const resolve = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    let resolved = false;
    try {
      resolved = onResolve ? (await onResolve()) !== false : false;
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not resolve');
    }
    if (!resolved) { setBusy(false); return; } // cancelled or failed — no note
    try {
      const text = `Forwarded to ${team.label} (${team.email}) and resolved here.${note.trim() ? ` Note: ${note.trim()}` : ''}`;
      await ticketsAPI.note(ticketId, { bodyText: text });
      setBusy(false);
      onClose?.();
    } catch (err) {
      setError(`Resolved, but the internal note failed: ${err.response?.data?.message || err.message || 'unknown error'}`);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-[60] ${suspended ? 'hidden' : 'flex'} items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn`}
      aria-hidden={suspended || undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-forward-title"
      data-testid="team-forward-dialog"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
      onKeyDown={trapTab}
    >
      <div ref={panelRef} className="tp-card w-full max-w-md rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="team-forward-title" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Forward className="h-4 w-4 text-primary" aria-hidden="true" /> Forward to {team.label}
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {ticketRef ? `${ticketRef} · ` : ''}{team.email}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {!sent ? (
          <>
            <p className="text-xs text-muted-foreground">Sends the description and the latest public replies to their inbox.</p>
            <label htmlFor="team-forward-note" className="mt-3 block text-xs text-muted-foreground">Note (optional)</label>
            <textarea
              id="team-forward-note"
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent?.isComposing) { e.preventDefault(); send(); }
              }}
              aria-describedby="team-forward-keys"
              rows={3}
              maxLength={2000}
              placeholder="What they need to know"
              className="tp-focus-ring mt-1 w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/75"
            />
            <p id="team-forward-keys" className="mt-1 text-[11px] text-muted-foreground/75">Ctrl+Enter to forward</p>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-foreground" role="status">
            <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> Sent to {team.label}.
            {canResolve && <span className="text-muted-foreground">Resolve it here too?</span>}
          </p>
        )}

        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          {!sent ? (
            <>
              <button type="button" onClick={onClose} disabled={busy} className="tp-focus-ring rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={busy}
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy && <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Forward
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy} className="tp-focus-ring rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">
                Done
              </button>
              {canResolve && (
                <button
                  type="button"
                  onClick={resolve}
                  disabled={busy}
                  className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy && <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Resolve as forwarded
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
