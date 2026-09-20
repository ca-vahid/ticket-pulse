import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowUpRight, Check, ChevronDown, CircleAlert, Forward, Lock, Mail, MessageCircleQuestion, PenLine, ShieldAlert, Users, X,
} from 'lucide-react';
import RichTextEditor, { isRichContent } from './RichTextEditor';
import { HandoffPanel } from './ApprovalHandoff';
import { SafeHtml, formatDay } from './ticketUi';

/**
 * Approvals v3 — the one composer every approver surface uses (magic-link
 * page, the ticket's Approvals tab, the Approvals inbox). Mail-client sized
 * (260 px editor by default) with tabs:
 *
 *   Approve · Approve with condition · Ask a question · Reject · Escalate · Forward
 *
 * "Ask a question" has two audiences — the requester (To requester, Cc agent
 * + approver chain) or the approvers/agent only (never the requester) — and
 * every recipient is a chip the approver can untick.
 *
 * Callbacks return promises; the parent updates its own state on success.
 *   onDecide(decision, note, noteHtml, { conditionNote, conditionNoteHtml, notifyRequester })
 *
 * QA 09-18 #1: the ticket requester is NOT on the decision e-mail unless the
 * approver ticks the large "Also e-mail the requester" box - a rejection note
 * written for the agents reached an end user on 18 Sep 2026.
 *   onAsk({ kind, mode, to, cc, bodyText, bodyHtml })
 *   onHandoff({ mode, note, toEmail })
 */

function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'));
}

function Kbd({ children, onSolid = false }) {
  return (
    <kbd aria-hidden="true" className={`ml-1 rounded border px-1.5 py-px font-mono text-[11px] leading-none ${onSolid ? 'border-white/40 text-white/90' : 'border-border text-muted-foreground'}`}>
      {children}
    </kbd>
  );
}

const TABS = [
  { key: 'approved', label: 'Approve', Icon: Check, tone: 'text-emerald-700 dark:text-emerald-200', active: 'border-emerald-500 text-emerald-700 dark:text-emerald-200' },
  { key: 'condition', label: 'Approve with condition', Icon: PenLine, tone: 'text-emerald-700 dark:text-emerald-200', active: 'border-emerald-500 text-emerald-700 dark:text-emerald-200' },
  { key: 'question', label: 'Ask a question', Icon: MessageCircleQuestion, tone: 'text-violet-700 dark:text-violet-200', active: 'border-violet-500 text-violet-700 dark:text-violet-200' },
  { key: 'rejected', label: 'Reject', Icon: X, tone: 'text-red-700 dark:text-red-200', active: 'border-red-500 text-red-700 dark:text-red-200' },
  { key: 'escalate', label: 'Escalate', Icon: ArrowUpRight, tone: 'text-amber-700 dark:text-amber-200', active: 'border-amber-500 text-amber-700 dark:text-amber-200' },
  { key: 'forward', label: 'Forward', Icon: Forward, tone: 'text-foreground', active: 'border-primary text-primary' },
];

const PLACEHOLDER = {
  approved: 'Optional note — the agent and the other approvers read it in the decision e-mail (the requester too, only if you tick the box below).',
  condition: 'The condition — required. e.g. “Approved for UAT only; production needs a separate review.”',
  question: 'Your question…',
  rejected: 'The reason — required. The agents read it; the requester only if you tick the box below.',
};

/**
 * Confirmation sheet: every approve / reject / escalate / forward pauses here
 * first so a stray click or an "A" typed into the wrong window cannot decide.
 */
export function ConfirmSheet({ pending, approval, onConfirm, onCancel, busy }) {
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  if (!pending) return null;
  const { decision, note, conditionNote, amountLabel, notifyRequester } = pending;
  const requesterWho = approval?.requesterName ? `the requester (${approval.requesterName})` : 'the requester';
  const ref = approval?.ticketRef || '';
  const forWhom = approval?.requesterName ? ` for ${approval.requesterName}` : '';
  const verbs = {
    approved: { title: conditionNote ? 'Approve with this condition?' : 'Approve this request?', cta: conditionNote ? 'Yes, approve with condition' : 'Yes, approve', tone: 'bg-emerald-600 hover:bg-emerald-700', Icon: Check },
    rejected: { title: 'Reject this request?', cta: 'Yes, reject', tone: 'bg-red-600 hover:bg-red-700', Icon: X },
    escalate: { title: `Escalate to ${approval?.nextTier?.name || 'the next tier'}?`, cta: 'Yes, escalate', tone: 'bg-amber-600 hover:bg-amber-700', Icon: ArrowUpRight },
    forward: { title: `Forward to ${pending.toName || pending.toEmail || 'this person'}?`, cta: 'Yes, forward', tone: 'bg-primary hover:bg-blue-700', Icon: Forward },
  };
  const v = verbs[decision] || verbs.approved;
  let consequence;
  if (decision === 'approved') {
    consequence = approval?.autoEscalates
      ? `${amountLabel || 'The amount'} is over your ${approval.tierName || 'tier'} limit${approval.amountLimitLabel ? ` (${approval.amountLimitLabel})` : ''}. Your approval is recorded and the request moves on to ${approval.nextTier?.approverNames?.join(', ') || approval.nextTier?.name || 'the next tier'} automatically.`
      : `This ends the request — the agent and the other approvers get the decision by e-mail${conditionNote ? ', with your condition' : ''}${notifyRequester ? `, and so does ${requesterWho}` : `. ${requesterWho[0].toUpperCase()}${requesterWho.slice(1)} is not e-mailed`}. You can change your mind later only from inside the app.`;
  } else if (decision === 'rejected') {
    consequence = notifyRequester
      ? `This ends the request with your reason. The agent, the other approvers and ${requesterWho} are notified right away.`
      : `This ends the request with your reason. The agent and the other approvers are notified right away — ${requesterWho} is not e-mailed, the agent follows up.`;
  } else if (decision === 'escalate') {
    consequence = `You are handed off — ${approval?.nextTier?.approverNames?.join(', ') || 'the next tier'} decide from here and your note goes with it.`;
  } else {
    consequence = 'They become the final approver. You are handed off and your note goes with it.';
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 min-[800px]:items-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-soft motion-on:animate-scaleIn">
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
            {conditionNote && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                <span className="font-semibold">Condition:</span> {conditionNote}
              </p>
            )}
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

/** Recipient chips for a question: who gets it (To) and who is copied (Cc). */
export function AudienceChips({ mode, participants, selfEmail, picked, onToggle }) {
  const self = String(selfEmail || '').toLowerCase();
  const requester = participants?.requester || null;
  const agent = participants?.agent || null;
  const chain = (participants?.approvers || []).filter((a) => a?.email && a.email.toLowerCase() !== self);
  const dedupe = (list) => {
    const seen = new Set(); const out = [];
    for (const p of list) { if (!p?.email) continue; const k = p.email.toLowerCase(); if (seen.has(k) || k === self) continue; seen.add(k); out.push({ ...p, email: k }); }
    return out;
  };
  const to = mode === 'requester' ? dedupe([requester]) : dedupe([agent, ...chain]);
  const cc = mode === 'requester' ? dedupe([agent, ...chain]).filter((p) => !to.some((t) => t.email === p.email)) : [];
  const Chip = ({ p, bucket }) => {
    const on = picked[p.email] !== false;
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={() => onToggle(p.email)}
        title={p.email}
        className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${on
          ? (bucket === 'to' ? 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-100' : 'border-border bg-muted/60 text-foreground')
          : 'border-dashed border-border bg-transparent text-muted-foreground line-through'}`}
      >
        <span className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${on ? 'border-current' : 'border-muted-foreground/40'}`}>{on && <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden="true" />}</span>
        {p.name || p.email}
        {p.role && <span className="text-[10px] uppercase tracking-wide opacity-70">{p.role}</span>}
      </button>
    );
  };
  if (!to.length && !cc.length) return null;
  return (
    <div className="mt-2 space-y-1.5 text-[12px]" data-testid="audience-chips">
      {to.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-6 shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">To</span>
          {to.map((p) => <Chip key={p.email} p={p} bucket="to" />)}
        </div>
      )}
      {cc.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-6 shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">Cc</span>
          {cc.map((p) => <Chip key={p.email} p={p} bucket="cc" />)}
        </div>
      )}
    </div>
  );
}

export default function ApprovalComposer({
  approval,
  participants = null,
  selfEmail = null,
  signatureHtml = null,
  forwardCandidates = [],
  onDecide,
  onAsk,
  onHandoff,
  disabled = false,
  minHeight = 260,
  compact = false,
  showShortcuts = true,
  footer = null,
  // false = the viewer may hand the request on but not decide it (an admin who
  // is not the named approver, 17 Sep 2026): only Forward / Escalate tabs show.
  canDecide = true,
}) {
  const [tab, setTab] = useState(canDecide ? 'approved' : 'forward');
  const [note, setNote] = useState('');
  const [noteHtml, setNoteHtml] = useState('');
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // { decision, note, noteHtml, conditionNote, toEmail, toName, amountLabel }
  const [askMode, setAskMode] = useState('requester');
  const [picked, setPicked] = useState({});
  // QA 09-18 #1: off by default — the requester hears the verdict from the agent.
  const [notifyRequester, setNotifyRequester] = useState(false);
  const [showSignature, setShowSignature] = useState(false);
  const editorRef = useRef(null);
  const text = note.trim();
  const hasNote = text.length > 0;
  const busy = Boolean(submitting) || disabled;
  const canEscalate = Boolean(approval?.canEscalate) && typeof onHandoff === 'function';
  const canForward = typeof onHandoff === 'function';
  const canAsk = typeof onAsk === 'function';
  const tabs = useMemo(() => TABS.filter((t) => (t.key === 'escalate' ? canEscalate : t.key === 'forward' ? canForward : t.key === 'question' ? canAsk : canDecide)), [canEscalate, canForward, canAsk, canDecide]);

  const clear = () => { setNote(''); setNoteHtml(''); };
  const rich = () => (text && isRichContent(noteHtml) ? noteHtml : null);

  const stage = useCallback((decision) => {
    if (busy) return;
    if (!canDecide && ['approved', 'rejected', 'condition'].includes(decision)) return;
    if (decision === 'rejected' && !text) {
      setError('Add a reason for rejecting — the agents read it and pass it on.');
      setTab('rejected');
      editorRef.current?.focus();
      return;
    }
    if (decision === 'condition' && !text) {
      setError('Type the condition first — it goes out with the approval.');
      editorRef.current?.focus();
      return;
    }
    setError(null);
    if (decision === 'condition') {
      setPending({ decision: 'approved', note: null, noteHtml: null, conditionNote: text, conditionNoteHtml: rich(), amountLabel: approval?.amountLabel || null, notifyRequester });
      return;
    }
    setPending({ decision, note: text || null, noteHtml: rich(), conditionNote: null, amountLabel: approval?.amountLabel || null, notifyRequester });
  }, [busy, text, noteHtml, approval, canDecide, notifyRequester]); // eslint-disable-line react-hooks/exhaustive-deps

  const runDecision = useCallback(async (p) => {
    setSubmitting(p.decision);
    try {
      await onDecide(p.decision, p.note || null, p.noteHtml || null, { conditionNote: p.conditionNote || null, conditionNoteHtml: p.conditionNoteHtml || null, notifyRequester: p.notifyRequester === true });
      setPending(null);
      clear();
    } catch (err) {
      setPending(null);
      setError(err?.response?.data?.message || err?.message || 'Could not record your decision. Check your connection and try again.');
    } finally {
      setSubmitting(null);
    }
  }, [onDecide]);

  const ask = useCallback(async () => {
    if (busy) return;
    if (!text) {
      setError('Type your question first — it is sent by e-mail and the answer lands back here.');
      editorRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting('question');
    try {
      const self = String(selfEmail || '').toLowerCase();
      const chain = (participants?.approvers || []).filter((a) => a?.email && a.email.toLowerCase() !== self);
      const all = askMode === 'requester'
        ? { to: [participants?.requester], cc: [participants?.agent, ...chain] }
        : { to: [participants?.agent, ...chain], cc: [] };
      const emails = (list) => [...new Set(list.filter((p) => p?.email).map((p) => p.email.toLowerCase()).filter((e) => e !== self && picked[e] !== false))];
      const payload = { kind: 'question', mode: askMode, bodyText: text, bodyHtml: rich() };
      if (participants) { payload.to = emails(all.to); payload.cc = emails(all.cc).filter((e) => !payload.to.includes(e)); }
      if (participants && payload.to.length === 0 && payload.cc.length === 0) {
        setError('Pick at least one person to send the question to.');
        return;
      }
      await onAsk(payload);
      clear();
      setPicked({});
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not send your question. Try again.');
    } finally {
      setSubmitting(null);
    }
  }, [busy, text, noteHtml, askMode, picked, participants, selfEmail, onAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = useCallback(async () => {
    if (!pending) return;
    if (pending.decision === 'escalate' || pending.decision === 'forward') {
      setSubmitting(pending.decision);
      try {
        await onHandoff({ mode: pending.decision, note: pending.note, toEmail: pending.toEmail || null });
        setPending(null);
        setTab('approved');
      } catch (err) {
        setPending(null);
        setError(err?.response?.data?.message || err?.message || 'Could not hand this off. Try again.');
      } finally {
        setSubmitting(null);
      }
      return;
    }
    await runDecision(pending);
  }, [pending, onHandoff, runDecision]);

  // A / R shortcuts open the confirmation — only outside the editor, no modifier, no sheet open.
  useEffect(() => {
    if (!showShortcuts || typeof window === 'undefined') return undefined;
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target) || pending || tab === 'escalate' || tab === 'forward') return;
      const key = String(event.key || '').toLowerCase();
      if (key === 'a') { event.preventDefault(); setTab('approved'); stage('approved'); }
      else if (key === 'r') {
        event.preventDefault();
        if (hasNote) { setTab('rejected'); stage('rejected'); }
        else { setTab('rejected'); setError('Add a reason for rejecting — the agents read it and pass it on.'); editorRef.current?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, hasNote, pending, tab, showShortcuts]);

  const expires = approval?.expiresAt ? formatDay(approval.expiresAt) : null;
  const isHandoff = tab === 'escalate' || tab === 'forward';
  const isDecision = tab === 'approved' || tab === 'condition' || tab === 'rejected';

  return (
    <section aria-labelledby="composer-heading" className={compact ? '' : 'mt-5'} data-testid="approval-composer">
      <div className={`rounded-2xl border border-border bg-card shadow-subtle ${compact ? '' : 'min-[800px]:shadow-soft'}`}>
        {/* Tabs */}
        <div role="tablist" aria-label="What do you want to do?" className="flex flex-wrap items-end gap-x-1 border-b border-border px-2 pt-1">
          <h3 id="composer-heading" className="sr-only">Your decision</h3>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); setError(null); }}
              disabled={busy}
              className={`tp-focus-ring -mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-semibold transition-colors ${tab === t.key ? t.active : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <t.Icon className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
              {t.label}
              {showShortcuts && t.key === 'approved' && <Kbd>A</Kbd>}
              {showShortcuts && t.key === 'rejected' && <Kbd>R</Kbd>}
            </button>
          ))}
        </div>

        <div className={compact ? 'px-3 py-3' : 'px-4 py-4 min-[800px]:px-[18px]'}>
          {isHandoff ? (
            <HandoffPanel
              mode={tab}
              compact={compact}
              people={forwardCandidates}
              nextTierName={approval?.nextTier?.name || null}
              nextTierNames={approval?.nextTier?.approverNames || []}
              onCancel={() => setTab('approved')}
              onSubmit={async ({ mode, note: hn, toEmail }) => {
                const target = forwardCandidates.find((p) => p.email === toEmail);
                setPending({ decision: mode, note: hn, toEmail, toName: target?.name || null, amountLabel: approval?.amountLabel || null });
              }}
            />
          ) : (
            <>
              {tab === 'question' && (
                <div className="mb-3 rounded-xl border border-violet-200/80 bg-violet-50/50 p-2.5 dark:border-violet-500/25 dark:bg-violet-500/10">
                  <div role="radiogroup" aria-label="Who should answer?" className="flex flex-wrap gap-1.5">
                    {[
                      { k: 'requester', label: 'Ask the requester', hint: 'Cc the agent and the approvers', Icon: Users },
                      { k: 'internal', label: 'Ask the approvers / agent only', hint: 'The requester is not copied', Icon: Lock },
                    ].map((m) => (
                      <button
                        key={m.k}
                        type="button"
                        role="radio"
                        aria-checked={askMode === m.k}
                        onClick={() => { setAskMode(m.k); setPicked({}); }}
                        className={`tp-focus-ring inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] ${askMode === m.k ? 'border-violet-400 bg-card text-foreground shadow-subtle dark:border-violet-400/60' : 'border-transparent text-muted-foreground hover:bg-card/70'}`}
                      >
                        <m.Icon className={`h-3.5 w-3.5 ${askMode === m.k ? 'text-violet-600 dark:text-violet-300' : ''}`} aria-hidden="true" />
                        <span>
                          <span className="block font-semibold">{m.label}</span>
                          <span className="block text-[11px] opacity-75">{m.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {participants && (
                    <AudienceChips mode={askMode} participants={participants} selfEmail={selfEmail} picked={picked} onToggle={(e) => setPicked((p) => ({ ...p, [e]: p[e] === false }))} />
                  )}
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    {askMode === 'requester'
                      ? 'They answer by replying to the e-mail or through a link — no sign-in needed. The request shows “question sent” until the answer arrives.'
                      : 'Internal: the requester never sees this exchange. The request stays with you; the requester sees “waiting on approver”.'}
                  </p>
                </div>
              )}

              {tab === 'condition' && (
                <p className="mb-2 text-[12.5px] text-muted-foreground">
                  The request is <span className="font-semibold text-emerald-700 dark:text-emerald-200">approved</span> and your condition travels with it — in the decision e-mail, on the ticket and in the API.
                </p>
              )}

              <RichTextEditor
                ref={editorRef}
                value={noteHtml}
                onChange={({ html, text: t }) => { setNoteHtml(html); setNote(t); if (error) setError(null); }}
                placeholder={PLACEHOLDER[tab] || PLACEHOLDER.approved}
                ariaLabel={tab === 'question' ? 'Your question' : tab === 'condition' ? 'Condition' : tab === 'rejected' ? 'Reason for rejecting' : 'Decision note'}
                minHeight={compact ? Math.min(minHeight, 160) : minHeight}
                className="border-input bg-background"
              />

              {isDecision && signatureHtml && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowSignature((v) => !v)}
                    aria-expanded={showSignature}
                    className="tp-focus-ring inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSignature ? 'rotate-180' : ''}`} aria-hidden="true" />
                    Your signature goes under the decision
                  </button>
                  {showSignature && (
                    <div className="mt-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 py-2" data-testid="signature-preview">
                      <SafeHtml html={signatureHtml} className="text-[12.5px] text-foreground/85" preferThemed />
                      <p className="mt-1 text-[11px] text-muted-foreground">Edit it under your profile signature in Ticket Pulse.</p>
                    </div>
                  )}
                </div>
              )}

              {isDecision && (
                <label
                  data-testid="notify-requester"
                  className={`mt-3 flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors ${notifyRequester ? 'border-primary/50 bg-primary/5 dark:bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted/50'}`}
                >
                  <input
                    type="checkbox"
                    className="tp-focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-input text-primary accent-[hsl(var(--primary))]"
                    checked={notifyRequester}
                    onChange={(e) => setNotifyRequester(e.target.checked)}
                    disabled={busy}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-foreground">
                      <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      Also e-mail the requester{approval?.requesterName ? `, ${approval.requesterName}` : ''}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                      {notifyRequester
                        ? 'They receive the verdict and your note by e-mail.'
                        : 'Off: the verdict and your note go to the agents on this request only. The agent tells the requester.'}
                    </span>
                  </span>
                </label>
              )}

              {error && (
                <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                {tab === 'approved' && (
                  <button type="button" onClick={() => stage('approved')} disabled={busy} aria-keyshortcuts={showShortcuts ? 'a' : undefined} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                    {submitting === 'approved' ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
                    {submitting === 'approved' ? 'Approving…' : 'Approve'}
                    {showShortcuts && submitting !== 'approved' && <Kbd onSolid>A</Kbd>}
                  </button>
                )}
                {tab === 'condition' && (
                  <button type="button" onClick={() => stage('condition')} disabled={busy || !hasNote} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                    {submitting === 'approved' ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />}
                    {submitting === 'approved' ? 'Approving…' : 'Approve with condition'}
                  </button>
                )}
                {tab === 'rejected' && (
                  <button type="button" onClick={() => stage('rejected')} disabled={busy || !hasNote} aria-keyshortcuts={showShortcuts ? 'r' : undefined} aria-describedby={!hasNote ? 'reject-helper' : undefined} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-60">
                    {submitting === 'rejected' ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <X className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
                    {submitting === 'rejected' ? 'Rejecting…' : 'Reject'}
                    {showShortcuts && submitting !== 'rejected' && <Kbd onSolid>R</Kbd>}
                  </button>
                )}
                {tab === 'question' && (
                  <button type="button" onClick={ask} disabled={busy} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-violet-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                    {submitting === 'question' ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" />}
                    {submitting === 'question' ? 'Sending…' : askMode === 'requester' ? 'Send to the requester' : 'Send to the approvers / agent'}
                  </button>
                )}
                {tab === 'rejected' && !hasNote && <span id="reject-helper" className="text-xs text-muted-foreground">Add a reason to reject</span>}
                {tab === 'condition' && !hasNote && <span className="text-xs text-muted-foreground">Type the condition to continue</span>}
              </div>
            </>
          )}

          {(footer || expires || approval?.approverEmail) && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              {footer || <>Sent to {approval?.approverEmail || 'you'}{expires ? ` · link expires ${expires}` : ''} · decisions ask you to confirm first</>}
            </p>
          )}
        </div>
      </div>

      {pending && (
        <ConfirmSheet pending={pending} approval={approval} busy={Boolean(submitting)} onConfirm={confirm} onCancel={() => setPending(null)} />
      )}
    </section>
  );
}
