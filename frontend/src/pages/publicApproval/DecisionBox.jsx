import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, CircleAlert, Forward, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react';
import RichTextEditor, { isRichContent } from '../../components/tickets/RichTextEditor';
import { formatDay } from '../../components/tickets/ticketUi';
import { HandoffPanel } from '../../components/tickets/ApprovalHandoff';

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
 * Confirmation sheet (Approvals v2): every approve / reject / escalate /
 * forward from the magic link pauses here first so a stray click or an "A"
 * typed into the wrong window cannot decide a request.
 */
function ConfirmSheet({ pending, approval, onConfirm, onCancel, busy }) {
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  if (!pending) return null;
  const { decision, note, amountLabel } = pending;
  const ref = approval?.ticketRef || '';
  const forWhom = approval?.requesterName ? ` for ${approval.requesterName}` : '';
  const verbs = {
    approved: { title: 'Approve this request?', cta: 'Yes, approve', tone: 'bg-emerald-600 hover:bg-emerald-700', Icon: Check },
    rejected: { title: 'Reject this request?', cta: 'Yes, reject', tone: 'bg-red-600 hover:bg-red-700', Icon: X },
    escalate: { title: `Escalate to ${approval?.nextTier?.name || 'the next tier'}?`, cta: 'Yes, escalate', tone: 'bg-amber-600 hover:bg-amber-700', Icon: ArrowUpRight },
    forward: { title: `Forward to ${pending.toName || pending.toEmail || 'this person'}?`, cta: 'Yes, forward', tone: 'bg-primary hover:bg-blue-700', Icon: Forward },
  };
  const v = verbs[decision] || verbs.approved;
  let consequence;
  if (decision === 'approved') {
    consequence = approval?.autoEscalates
      ? `${amountLabel || 'The amount'} is over your ${approval.tierName || 'tier'} limit${approval.amountLimitLabel ? ` (${approval.amountLimitLabel})` : ''}. Your approval is recorded and the request moves on to ${approval.nextTier?.approverNames?.join(', ') || approval.nextTier?.name || 'the next tier'} automatically.`
      : 'This ends the request — the requester and the agent are notified right away. You can change your mind later only from inside the app.';
  } else if (decision === 'rejected') {
    consequence = 'This ends the request with your reason. The requester and the agent are notified right away.';
  } else if (decision === 'escalate') {
    consequence = `You are handed off — ${approval?.nextTier?.approverNames?.join(', ') || 'the next tier'} decide from here and your note goes with it.`;
  } else {
    consequence = 'They become the final approver. You are handed off and your note goes with it.';
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 min-[800px]:items-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-soft motion-safe:animate-scaleIn">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h4 id="confirm-title" className="text-base font-bold text-foreground">{v.title}</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              You are about to <span className="font-semibold text-foreground">{decision === 'approved' ? 'approve' : decision === 'rejected' ? 'reject' : decision}</span>{' '}
              <span className="font-mono font-semibold text-foreground">{ref}</span>{forWhom}{amountLabel ? <> · <span className="font-semibold text-foreground">{amountLabel}</span></> : null}.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{consequence}</p>
            {note && (
              <p className="mt-2 rounded-lg border border-border/60 bg-muted/60 px-3 py-2 text-[13px] text-foreground/85">
                <span className="font-semibold">Your note:</span> {note}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="tp-focus-ring rounded-[10px] border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted">Go back</button>
          <button
            ref={first}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60 ${v.tone}`}
          >
            {busy ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <v.Icon className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
            {busy ? 'Working…' : v.cta}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The approver's decision surface. Sticky at the bottom of the main column
 * (a bottom sheet below 800px). `onDecide(decision, note, noteHtml)` and
 * `onHandoff({ mode, note, toEmail })` return promises; the parent swaps this
 * box for the decided banner on success and we only render inline errors here.
 * Approvals v2: every action confirms first; Escalate shows when the category
 * has a higher tier; Forward is always offered (anyone in the workspace).
 */
export default function DecisionBox({ approval, onDecide, onHandoff, forwardCandidates = [], disabled = false }) {
  const [note, setNote] = useState('');
  const [noteHtml, setNoteHtml] = useState('');
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // { decision, note, noteHtml, toEmail, toName, amountLabel }
  const [handoffMode, setHandoffMode] = useState(null); // 'escalate' | 'forward' | null
  const editorRef = useRef(null);
  const hasNote = note.trim().length > 0;
  const busy = Boolean(submitting) || disabled;

  const stage = useCallback((decision) => {
    if (busy) return;
    const text = note.trim();
    if (decision === 'rejected' && !text) {
      setError('Add a reason for rejecting so the requester knows what to change.');
      editorRef.current?.focus();
      return;
    }
    setError(null);
    setPending({ decision, note: text || null, noteHtml: text && isRichContent(noteHtml) ? noteHtml : null, amountLabel: approval?.amountLabel || null });
  }, [busy, note, noteHtml, approval]);

  const runDecision = useCallback(async (decision, text, richHtml) => {
    setSubmitting(decision);
    try {
      await onDecide(decision, text || null, richHtml || null);
      if (decision === 'clarify') { setNote(''); setNoteHtml(''); }
      setPending(null);
    } catch (err) {
      setPending(null);
      setError(err?.response?.data?.message || err?.message || 'Could not record your decision. Check your connection and try again.');
    } finally {
      setSubmitting(null);
    }
  }, [onDecide]);

  const clarify = useCallback(async () => {
    if (busy) return;
    const text = note.trim();
    if (!text) {
      setError('Type your question in the note first — it is sent to the agent by email.');
      editorRef.current?.focus();
      return;
    }
    setError(null);
    await runDecision('clarify', text, isRichContent(noteHtml) ? noteHtml : null);
  }, [busy, note, noteHtml, runDecision]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    if (pending.decision === 'escalate' || pending.decision === 'forward') {
      setSubmitting(pending.decision);
      try {
        await onHandoff({ mode: pending.decision, note: pending.note, toEmail: pending.toEmail || null });
        setPending(null);
        setHandoffMode(null);
      } catch (err) {
        setPending(null);
        setError(err?.response?.data?.message || err?.message || 'Could not hand this off. Try again.');
      } finally {
        setSubmitting(null);
      }
      return;
    }
    await runDecision(pending.decision, pending.note, pending.noteHtml);
  }, [pending, onHandoff, runDecision]);

  // A / R shortcuts open the confirmation — only outside the editor, no modifier, no sheet open.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target) || pending || handoffMode) return;
      const key = String(event.key || '').toLowerCase();
      if (key === 'a') { event.preventDefault(); stage('approved'); }
      else if (key === 'r') {
        event.preventDefault();
        if (hasNote) stage('rejected');
        else { setError('Add a reason for rejecting so the requester knows what to change.'); editorRef.current?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, hasNote, pending, handoffMode]);

  const expires = approval?.expiresAt ? formatDay(approval.expiresAt) : null;
  const canEscalate = Boolean(approval?.canEscalate) && typeof onHandoff === 'function';
  const canForward = typeof onHandoff === 'function';

  return (
    <section
      aria-labelledby="decision-heading"
      className="sticky bottom-0 z-20 -mx-5 mt-5 min-[800px]:bottom-4 min-[800px]:mx-0"
    >
      <div className="rounded-t-2xl border border-border bg-card px-4 py-4 shadow-[0_-12px_34px_hsl(var(--foreground)/0.12)] min-[800px]:rounded-2xl min-[800px]:px-[18px] min-[800px]:shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="decision-heading" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Your decision</h3>
          {approval?.amountLabel && (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">{approval.amountLabel}</span>
              {approval.autoEscalates
                ? <> · over your {approval.tierName || 'tier'} limit{approval.amountLimitLabel ? ` (${approval.amountLimitLabel})` : ''} — approving sends it on to {approval.nextTier?.name || 'the next tier'}</>
                : approval.amountLimitLabel ? <> · within your limit ({approval.amountLimitLabel})</> : null}
            </p>
          )}
        </div>

        {handoffMode ? (
          <HandoffPanel
            mode={handoffMode}
            people={forwardCandidates}
            nextTierName={approval?.nextTier?.name || null}
            nextTierNames={approval?.nextTier?.approverNames || []}
            onCancel={() => setHandoffMode(null)}
            onSubmit={async ({ mode, note: hn, toEmail }) => {
              const target = forwardCandidates.find((p) => p.email === toEmail);
              setPending({ decision: mode, note: hn, toEmail, toName: target?.name || null, amountLabel: approval?.amountLabel || null });
            }}
          />
        ) : (
          <>
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
                onClick={() => stage('approved')}
                disabled={busy}
                aria-keyshortcuts="a"
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-emerald-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
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
                  onClick={() => stage('rejected')}
                  disabled={busy || !hasNote}
                  aria-keyshortcuts="r"
                  aria-describedby={!hasNote ? 'reject-helper' : undefined}
                  className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-red-300 bg-red-50 px-3.5 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200 dark:hover:bg-red-500/25"
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
                onClick={clarify}
                disabled={busy}
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-transparent px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-60"
              >
                {submitting === 'clarify'
                  ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" />}
                {submitting === 'clarify' ? 'Sending…' : 'Ask a question'}
              </button>

              {canEscalate && (
                <button
                  type="button"
                  onClick={() => { setError(null); setHandoffMode('escalate'); }}
                  disabled={busy}
                  className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-amber-300 bg-amber-50 px-3.5 py-2 text-[13px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100 dark:hover:bg-amber-500/25"
                >
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  Escalate to {approval?.nextTier?.name || 'next tier'}
                </button>
              )}

              {canForward && (
                <button
                  type="button"
                  onClick={() => { setError(null); setHandoffMode('forward'); }}
                  disabled={busy}
                  className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-transparent px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-60"
                >
                  <Forward className="h-4 w-4" aria-hidden="true" />
                  Forward
                </button>
              )}

              {!hasNote && (
                <span id="reject-helper" className="text-xs text-muted-foreground">Add a reason to reject</span>
              )}
            </div>
          </>
        )}

        <p className="mt-2.5 text-xs text-muted-foreground">
          Sent to {approval?.approverEmail || 'you'}{expires ? ` · link expires ${expires}` : ''} · every action asks you to confirm first
        </p>
      </div>

      {pending && (
        <ConfirmSheet pending={pending} approval={approval} busy={Boolean(submitting)} onConfirm={confirm} onCancel={() => setPending(null)} />
      )}
    </section>
  );
}
