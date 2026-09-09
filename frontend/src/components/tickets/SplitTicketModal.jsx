import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, GitBranch, Loader2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Split a conversation out of a ticket (QA 09-08) — the inverse of
 * MergeTicketsModal, and deliberately shaped like it.
 *
 * The consequences are spelled out before you commit, because the counts
 * matter: messages are COPIED (the original thread is never edited), while
 * attachments on those messages MOVE (a screenshot of the split-out problem
 * belongs with the split-out ticket).
 *
 * Unlike merge, this works on FreshService-born tickets too: the parent is
 * never modified, so FreshService's ownership of it is untouched.
 */
export default function SplitTicketModal({ ticket, onClose, onSplit }) {
  const [entries, setEntries] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [subject, setSubject] = useState('');
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [moveAttachments, setMoveAttachments] = useState(true);
  const [notifyRequester, setNotifyRequester] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await ticketsAPI.splittable(ticket.id);
        if (!cancelled) setEntries(res.data || []);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || err.message || 'Could not load this conversation');
          setEntries([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [ticket.id]);

  const toggle = useCallback((id, excerpt) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // First selection seeds the subject — the message usually says what the
      // new ticket is about better than the parent's subject does.
      if (!subjectTouched && next.size === 1 && excerpt) {
        setSubject(String(excerpt).slice(0, 90));
      }
      return next;
    });
  }, [subjectTouched]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await ticketsAPI.split(ticket.id, {
        entryIds: [...selected],
        subject: subject.trim(),
        moveAttachments,
        notifyRequester,
      });
      onSplit?.(res.data);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not split this ticket');
      setBusy(false);
    }
  };

  const count = selected.size;
  const canSubmit = subject.trim().length > 0 && !busy;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="split-title">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => !busy && onClose?.()} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl bg-card border border-border shadow-soft"
        data-testid="split-modal"
      >
        <div className="flex items-start gap-3 border-b border-border p-4">
          <span className="h-9 w-9 rounded-lg bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300 inline-flex items-center justify-center flex-shrink-0">
            <GitBranch className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="split-title" className="text-base font-bold text-foreground">Split into a new ticket</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick the messages that are really a separate issue. <span className="font-mono">{ticket.displayRef}</span> stays exactly as it is.
            </p>
          </div>
          <button onClick={() => !busy && onClose?.()} className="tp-focus-ring rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto settings-scrollbar p-4 space-y-4">
          <div>
            <label htmlFor="split-subject" className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              New ticket subject
            </label>
            <input
              id="split-subject"
              value={subject}
              onChange={(e) => { setSubject(e.target.value); setSubjectTouched(true); }}
              maxLength={500}
              placeholder="What is the new ticket about?"
              className="mt-1.5 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground"
            />
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Messages to carry over {count > 0 && <span className="text-violet-700 dark:text-violet-300">({count} selected)</span>}
            </p>
            {entries === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the conversation…
              </div>
            ) : entries.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                This ticket has no conversation messages yet. You can still create a linked ticket below.
              </p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-lg border border-border overflow-hidden" data-testid="split-entries">
                {entries.map((e) => (
                  <li key={e.id} className="bg-card">
                    <label className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/40">
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggle(e.id, e.excerpt)}
                        className="mt-0.5 h-4 w-4 rounded border-input text-violet-600"
                        aria-label={`Include the message from ${e.author}`}
                      />
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-foreground">{e.author}</span>
                          {e.isPrivate && (
                            <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300">internal note</span>
                          )}
                          <span className="text-[11px] text-muted-foreground">{new Date(e.occurredAt).toLocaleString()}</span>
                        </span>
                        <span className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{e.excerpt || '(no text)'}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold text-foreground">What will happen</p>
            <ul className="text-[11px] text-muted-foreground space-y-1">
              <li>• A <strong>new ticket</strong> is created with the same requester, category and priority, linked as a child of <span className="font-mono">{ticket.displayRef}</span>.</li>
              <li>• The {count === 1 ? 'message' : `${count} messages`} you picked {count === 0 ? 'would be' : 'are'} <strong>copied</strong> across — <span className="font-mono">{ticket.displayRef}</span>&apos;s own thread is never edited.</li>
              <li>• Both tickets get an internal note recording the split.</li>
              <li>• Nothing is closed, and the original keeps its status.</li>
            </ul>
            <label className="flex items-center gap-2 text-[11px] text-foreground/85 pt-1">
              <input type="checkbox" checked={moveAttachments} onChange={(e) => setMoveAttachments(e.target.checked)} className="h-3.5 w-3.5 rounded border-input text-violet-600" />
              Move attachments on those messages to the new ticket
            </label>
            <label className="flex items-center gap-2 text-[11px] text-foreground/85">
              <input type="checkbox" checked={notifyRequester} onChange={(e) => setNotifyRequester(e.target.checked)} className="h-3.5 w-3.5 rounded border-input text-violet-600" />
              Email the requester about the new ticket
            </label>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-2.5">
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-700 dark:text-red-200">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <button
            onClick={() => !busy && onClose?.()}
            className="tp-focus-ring px-3 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="split-submit"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
            {busy ? 'Splitting…' : 'Split ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
