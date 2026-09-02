import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, CircleAlert, MessageCircleQuestion, X } from 'lucide-react';
import RichTextEditor, { isRichContent } from '../../components/tickets/RichTextEditor';
import { formatDay } from '../../components/tickets/ticketUi';

const NOTE_PLACEHOLDER = 'Optional note for approve · required reason for reject';

function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'));
}

function Kbd({ children, onSolid = false }) {
  return (
    <kbd
      aria-hidden="true"
      className={`ml-1 rounded border px-1.5 py-px font-mono text-[11px] leading-none ${
        onSolid ? 'border-white/40 text-white/90' : 'border-border text-muted-foreground'
      }`}
    >
      {children}
    </kbd>
  );
}

/**
 * The approver's decision surface. Sticky at the bottom of the main column
 * (a bottom sheet below 800px). `onDecide(decision, note, noteHtml)` returns a
 * promise; the parent swaps this box for the decided banner on success and
 * we only render inline errors here — the page never blanks.
 */
export default function DecisionBox({ approval, onDecide, disabled = false }) {
  const [note, setNote] = useState('');
  const [noteHtml, setNoteHtml] = useState('');
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState(null);
  const editorRef = useRef(null);
  const hasNote = note.trim().length > 0;
  const busy = Boolean(submitting) || disabled;

  const submit = useCallback(async (decision) => {
    if (busy) return;
    const text = note.trim();
    if (decision === 'rejected' && !text) {
      setError('Add a reason for rejecting so the requester knows what to change.');
      editorRef.current?.focus();
      return;
    }
    if (decision === 'clarify' && !text) {
      setError('Type your question in the note first — it is sent to the agent by email.');
      editorRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(decision);
    try {
      const richHtml = text && isRichContent(noteHtml) ? noteHtml : null;
      await onDecide(decision, text || null, richHtml);
      if (decision === 'clarify') {
        setNote('');
        setNoteHtml('');
      }
    } catch (err) {
      // services/api.js rewrites failures into Error { status, message }; keep the raw-axios shape too.
      setError(err?.response?.data?.message || err?.message || 'Could not record your decision. Check your connection and try again.');
    } finally {
      setSubmitting(null);
    }
  }, [busy, note, noteHtml, onDecide]);

  // A / R shortcuts — only when focus is outside the editor and no modifier is held.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = String(event.key || '').toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        submit('approved');
      } else if (key === 'r') {
        event.preventDefault();
        if (hasNote) submit('rejected');
        else {
          setError('Add a reason for rejecting so the requester knows what to change.');
          editorRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, hasNote]);

  const expires = approval?.expiresAt ? formatDay(approval.expiresAt) : null;

  return (
    <section
      aria-labelledby="decision-heading"
      className="sticky bottom-0 z-20 -mx-5 mt-5 min-[800px]:bottom-4 min-[800px]:mx-0"
    >
      <div className="rounded-t-2xl border border-border bg-card px-4 py-4 shadow-[0_-12px_34px_hsl(var(--foreground)/0.12)] min-[800px]:rounded-2xl min-[800px]:px-[18px] min-[800px]:shadow-[0_12px_34px_hsl(var(--foreground)/0.12)]">
        <h3 id="decision-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Your decision</h3>
        <RichTextEditor
          ref={editorRef}
          value={noteHtml}
          onChange={({ html, text }) => { setNoteHtml(html); setNote(text); if (error) setError(null); }}
          placeholder={NOTE_PLACEHOLDER}
          ariaLabel="Decision note"
          minHeight={64}
          className="border-input bg-background"
        />

        {error && (
          <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => submit('approved')}
            disabled={busy}
            aria-keyshortcuts="a"
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-emerald-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {submitting === 'approved'
              ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
            {submitting === 'approved' ? 'Approving…' : 'Approve'}
            {submitting !== 'approved' && <Kbd onSolid>A</Kbd>}
          </button>

          <span className="inline-flex flex-col">
            <button
              type="button"
              onClick={() => submit('rejected')}
              disabled={busy || !hasNote}
              aria-keyshortcuts="r"
              aria-describedby={!hasNote ? 'reject-helper' : undefined}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-red-300 bg-red-50 px-3.5 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/35 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/20"
            >
              {submitting === 'rejected'
                ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <X className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
              {submitting === 'rejected' ? 'Rejecting…' : 'Reject'}
              {submitting !== 'rejected' && <Kbd>R</Kbd>}
            </button>
          </span>

          <button
            type="button"
            onClick={() => submit('clarify')}
            disabled={busy}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-transparent px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-60"
          >
            {submitting === 'clarify'
              ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" />}
            {submitting === 'clarify' ? 'Sending…' : 'Ask a question'}
          </button>

          {!hasNote && (
            <span id="reject-helper" className="text-xs text-muted-foreground">Add a reason to reject</span>
          )}
        </div>

        <p className="mt-2.5 text-xs text-muted-foreground">
          Sent to {approval?.approverEmail || 'you'}{expires ? ` · link expires ${expires}` : ''}
        </p>
      </div>
    </section>
  );
}
