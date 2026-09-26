import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, GitBranch, ListChecks, Loader2, Scissors, UserRound, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import AssigneePicker from './AssigneePicker';

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
 *
 * QA 09-18 #6: two ways to choose what goes —
 *   "From a message onward": click the message where the new ask starts;
 *     that message and everything after it go (FreshService's split-from-a-
 *     note). Opened straight from a message's "Split from here" action.
 *   "Pick messages": the original checkbox list.
 * Plus: the new ticket's requester can be the person who actually asked, the
 * owner can be you in one click, and the original can be parked or resolved
 * once the split is done.
 */
const PARENT_AFTER = [
  { value: 'keep', label: 'Leave it as it is', hint: 'Status and owner unchanged.' },
  { value: 'Pending', label: 'Set it to Pending', hint: 'The rest is waiting on someone.' },
  { value: 'Resolved', label: 'Resolve it', hint: 'The split-out ask was the only thing left.' },
];

export default function SplitTicketModal({ ticket, onClose, onSplit, technicians = [], initialFromEntryId = null, selfTechnicianId = null }) {
  const [entries, setEntries] = useState(null);
  const [mode, setMode] = useState(initialFromEntryId ? 'from' : 'pick');
  const [fromId, setFromId] = useState(initialFromEntryId ? Number(initialFromEntryId) : null);
  const [picked, setPicked] = useState(() => new Set());
  const [subject, setSubject] = useState('');
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [moveAttachments, setMoveAttachments] = useState(true);
  // QA 09-15 #2: the request's own description and the files that came with it
  // (attachments with no message) used to stay behind; the child opened with
  // "Split out of TP-n" and nothing else.
  const [includeDescription, setIncludeDescription] = useState(true);
  const [notifyRequester, setNotifyRequester] = useState(false);
  const [useAuthorAsRequester, setUseAuthorAsRequester] = useState(false);
  const [parentAfter, setParentAfter] = useState('keep');
  // QA 09-09 #3: the new ticket used to land unassigned, so every split meant
  // opening the child afterwards just to give it an owner. Picked here, applied
  // at create — the backend has always accepted assignedTechId on split.
  const [assignedTechId, setAssignedTechId] = useState(null);
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

  const seedSubject = useCallback((excerpt) => {
    // The first pick seeds the subject — the message usually says what the
    // new ticket is about better than the parent's subject does.
    if (!subjectTouched && excerpt) setSubject(String(excerpt).slice(0, 90));
  }, [subjectTouched]);

  // The anchor arrived with the modal (a message's "Split from here"): seed
  // the subject from it once the conversation is loaded.
  useEffect(() => {
    if (mode !== 'from' || !fromId || !entries) return;
    const anchor = entries.find((e) => e.id === fromId);
    if (anchor && !subjectTouched && !subject) setSubject(String(anchor.excerpt || '').slice(0, 90));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, fromId, mode]);

  const togglePick = useCallback((id, excerpt) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 1 && !prev.has(id)) seedSubject(excerpt);
      return next;
    });
  }, [seedSubject]);

  const chooseFrom = useCallback((id, excerpt) => {
    setFromId((prev) => (prev === id ? null : id));
    seedSubject(excerpt);
  }, [seedSubject]);

  const fromIndex = useMemo(() => (mode === 'from' && fromId && entries ? entries.findIndex((e) => e.id === fromId) : -1), [mode, fromId, entries]);
  const selectedIds = useMemo(() => {
    if (!entries) return [];
    if (mode === 'from') return fromIndex >= 0 ? entries.slice(fromIndex).map((e) => e.id) : [];
    return entries.filter((e) => picked.has(e.id)).map((e) => e.id);
  }, [entries, mode, fromIndex, picked]);
  const count = selectedIds.length;

  // Requester suggestion: the person who wrote the anchor (or the first picked
  // message) when they are not an agent and not already the requester.
  const parentRequesterEmail = String(ticket?.requester?.email || '').toLowerCase();
  const suggestedRequester = useMemo(() => {
    if (!entries) return null;
    const lead = mode === 'from'
      ? (fromIndex >= 0 ? entries[fromIndex] : null)
      : entries.find((e) => picked.has(e.id)) || null;
    if (!lead || !lead.authorEmail || lead.authorType === 'agent' || lead.isPrivate) return null;
    if (lead.authorEmail === parentRequesterEmail) return null;
    return { email: lead.authorEmail, name: lead.author };
  }, [entries, mode, fromIndex, picked, parentRequesterEmail]);
  useEffect(() => { if (!suggestedRequester) setUseAuthorAsRequester(false); }, [suggestedRequester]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        entryIds: mode === 'from' ? [] : selectedIds,
        subject: subject.trim(),
        moveAttachments,
        includeDescription,
        notifyRequester,
        ...(mode === 'from' && fromId ? { fromEntryId: fromId } : {}),
        ...(assignedTechId ? { assignedTechId } : {}),
        ...(useAuthorAsRequester && suggestedRequester ? { requesterEmail: suggestedRequester.email, requesterName: suggestedRequester.name } : {}),
        ...(parentAfter !== 'keep' ? { parentStatus: parentAfter } : {}),
      };
      const res = await ticketsAPI.split(ticket.id, payload);
      onSplit?.(res.data);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not split this ticket');
      setBusy(false);
    }
  };

  const canSubmit = subject.trim().length > 0 && !busy && !(mode === 'from' && !fromId && (entries?.length || 0) > 0);
  const modeBtn = (key, label, Icon) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === key}
      onClick={() => setMode(key)}
      className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${mode === key ? 'border-violet-400 bg-violet-50 text-violet-800 dark:border-violet-400/60 dark:bg-violet-500/15 dark:text-violet-100' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );

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
              {mode === 'from'
                ? <>Click the message where the new ask starts — it and everything after it go. <span className="font-mono">{ticket.displayRef}</span>&apos;s thread stays exactly as it is.</>
                : <>Pick the messages that are really a separate issue. <span className="font-mono">{ticket.displayRef}</span> stays exactly as it is.</>}
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
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-auto">
                Messages to carry over {count > 0 && <span className="text-violet-700 dark:text-violet-300">({count})</span>}
              </p>
              <div role="radiogroup" aria-label="How to choose messages" className="flex items-center gap-1.5">
                {modeBtn('from', 'From a message onward', Scissors)}
                {modeBtn('pick', 'Pick messages', ListChecks)}
              </div>
            </div>
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
                {entries.map((e, i) => {
                  const isAnchor = mode === 'from' && e.id === fromId;
                  const goes = mode === 'from' ? (fromIndex >= 0 && i >= fromIndex) : picked.has(e.id);
                  const stays = mode === 'from' && fromIndex >= 0 && i < fromIndex;
                  const meta = (
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2 flex-wrap">
                        <span className={`text-xs font-semibold ${stays ? 'text-muted-foreground' : 'text-foreground'}`}>{e.author}</span>
                        {e.isPrivate && (
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300">internal note</span>
                        )}
                        <span className="text-[11px] text-muted-foreground">{new Date(e.occurredAt).toLocaleString()}</span>
                      </span>
                      <span className={`block text-[11px] mt-0.5 line-clamp-2 ${stays ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>{e.excerpt || '(no text)'}</span>
                    </span>
                  );
                  if (mode === 'from') {
                    return (
                      <li key={e.id} className={goes ? 'bg-violet-50/60 dark:bg-violet-500/10' : 'bg-card'}>
                        {isAnchor && (
                          <div className="flex items-center gap-2 px-3 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300" data-testid="split-cut-line">
                            <span className="h-px flex-1 bg-violet-300 dark:bg-violet-500/50" aria-hidden="true" />
                            <Scissors className="h-3 w-3" aria-hidden="true" /> everything from here goes to the new ticket
                            <span className="h-px flex-1 bg-violet-300 dark:bg-violet-500/50" aria-hidden="true" />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => chooseFrom(e.id, e.excerpt)}
                          aria-pressed={isAnchor}
                          aria-label={`Split from the message from ${e.author}`}
                          className={`tp-focus-ring flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-violet-50/80 dark:hover:bg-violet-500/15 ${isAnchor ? 'bg-violet-100/70 dark:bg-violet-500/20' : ''}`}
                        >
                          <Scissors className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isAnchor ? 'text-violet-700 dark:text-violet-200' : 'text-muted-foreground/40'}`} aria-hidden="true" />
                          {meta}
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={e.id} className="bg-card">
                      <label className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/40">
                        <input
                          type="checkbox"
                          checked={picked.has(e.id)}
                          onChange={() => togglePick(e.id, e.excerpt)}
                          className="mt-0.5 h-4 w-4 rounded border-input text-violet-600"
                          aria-label={`Include the message from ${e.author}`}
                        />
                        {meta}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {mode === 'from' && entries?.length > 0 && fromIndex < 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">Click the message where the new ask starts.</p>
            )}
          </div>

          {suggestedRequester && (
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 ${useAuthorAsRequester ? 'border-violet-300 bg-violet-50/60 dark:border-violet-400/50 dark:bg-violet-500/10' : 'border-border bg-muted/30'}`} data-testid="split-requester-suggestion">
              <input type="checkbox" checked={useAuthorAsRequester} onChange={(e) => setUseAuthorAsRequester(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input text-violet-600" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <UserRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Make {suggestedRequester.name || suggestedRequester.email} the requester of the new ticket
                </span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  They wrote the message the new ticket starts from. Off: it keeps {ticket?.requester?.name || 'the original requester'}.
                </span>
              </span>
            </label>
          )}

          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold text-foreground">What will happen</p>
            <ul className="text-[11px] text-muted-foreground space-y-1">
              <li>• A <strong>new ticket</strong> is created with the same requester, category and priority, linked as a child of <span className="font-mono">{ticket.displayRef}</span>.</li>
              <li>• {count === 0
                ? <>Any messages you choose are <strong>copied</strong> across</>
                : <>The {count === 1 ? 'message' : `${count} messages`} you chose are <strong>copied</strong> across</>
              } — <span className="font-mono">{ticket.displayRef}</span>&apos;s own thread is never edited.</li>
              <li>• Both tickets get an internal note recording the split.</li>
              <li>• {parentAfter === 'keep' ? 'Nothing is closed, and the original keeps its status.' : `The original is set to ${parentAfter} once the split is done.`}</li>
            </ul>
            <label className="flex items-center gap-2 text-[11px] text-foreground/85 pt-1">
              <input type="checkbox" checked={moveAttachments} onChange={(e) => setMoveAttachments(e.target.checked)} className="h-3.5 w-3.5 rounded border-input text-violet-600" />
              Move attachments on those messages to the new ticket
            </label>
            <label className="flex items-center gap-2 text-[11px] text-foreground/85">
              <input type="checkbox" checked={includeDescription} onChange={(e) => setIncludeDescription(e.target.checked)} className="h-3.5 w-3.5 rounded border-input text-violet-600" data-testid="split-include-description" />
              Include the original description and its attachments on the new ticket (the original keeps them)
            </label>
            <label className="flex items-center gap-2 text-[11px] text-foreground/85">
              <input type="checkbox" checked={notifyRequester} onChange={(e) => setNotifyRequester(e.target.checked)} className="h-3.5 w-3.5 rounded border-input text-violet-600" />
              Email the requester about the new ticket
            </label>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">The original ticket afterwards</p>
            <div role="radiogroup" aria-label="What happens to the original ticket" className="grid gap-1.5 sm:grid-cols-3">
              {PARENT_AFTER.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={parentAfter === o.value}
                  onClick={() => setParentAfter(o.value)}
                  className={`tp-focus-ring rounded-lg border px-2.5 py-2 text-left transition-colors ${parentAfter === o.value ? 'border-violet-400 bg-violet-50/70 dark:border-violet-400/60 dark:bg-violet-500/15' : 'border-border bg-card hover:bg-muted/40'}`}
                >
                  <span className="block text-xs font-semibold text-foreground">{o.label}</span>
                  <span className="block text-[10.5px] text-muted-foreground">{o.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-2.5">
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-700 dark:text-red-200">{error}</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
          {/* Beside Cancel, as asked (QA 09-09 #3): choose the new ticket's
              owner here instead of reopening it afterwards. Writes nothing on
              its own — the pick is applied when the ticket is created. */}
          <div className="mr-auto flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-muted-foreground/75 flex-shrink-0">Assign to</span>
            <AssigneePicker
              ticketId={null}
              askHandBack={false}
              value={assignedTechId}
              technicians={technicians}
              size="sm"
              showAi={false}
              disabled={busy}
              assignFn={async (techId) => {
                setAssignedTechId(techId ?? null);
                return { data: null };
              }}
            />
            {selfTechnicianId && assignedTechId !== selfTechnicianId && (
              <button
                type="button"
                onClick={() => setAssignedTechId(selfTechnicianId)}
                className="tp-focus-ring text-xs font-semibold text-violet-700 dark:text-violet-300 hover:underline"
                data-testid="split-assign-me"
              >
                me
              </button>
            )}
          </div>
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
