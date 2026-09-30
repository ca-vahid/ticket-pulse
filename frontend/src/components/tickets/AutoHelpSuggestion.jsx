import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpen, CalendarClock, FileText, Info, PencilLine, Send, ShieldCheck, Sparkles, Ticket, X } from 'lucide-react';
import { SafeHtml } from './ticketUi';
import { sanitizeRichHtml } from './RichTextEditor';
import { followUpPromise, friendlyError } from '../knowledge/autoHelpWords';

/**
 * "Auto-help suggests" (P1 approve mode, plans/AUTO_HELP_P1_PLAN.md §1): an
 * answer a playbook drafted from the knowledge base, waiting on the ticket
 * for an agent. The mail is shown as the requester will read it — the
 * automated-answer line, the answer, and the follow-up footer — in the white
 * e-mail well. Send, Edit & send (the answer only; the line and footer are
 * always added by the server), or Dismiss with a one-tap reason.
 */
const REASON_LABEL = { wrong_answer: 'Wrong answer', not_needed: 'Not needed', other: 'Other' };
const SOURCE_ICON = { article: FileText, ticket: Ticket, playbook: BookOpen };

function SourceLinks({ sources = [] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs" data-testid="auto-help-sources">
      <span className="text-muted-foreground">From</span>
      {sources.map((s) => {
        const Icon = SOURCE_ICON[s.type] || FileText;
        const label = [s.ref, s.title].filter(Boolean).join(' · ') + (s.section ? ` › ${s.section}` : '');
        return (
          <span key={s.sourceId} className="inline-flex min-w-0 max-w-full items-center gap-1">
            <Icon className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden="true" />
            {s.url ? (
              <Link to={s.url} className="tp-focus-ring truncate rounded text-foreground/85 hover:text-foreground hover:underline">{label}</Link>
            ) : (
              <span className="truncate text-foreground/85">{label}</span>
            )}
            {s.stale && <span className="whitespace-nowrap text-muted-foreground">· review due</span>}
          </span>
        );
      })}
    </div>
  );
}

export default function AutoHelpSuggestion({ proposal, onSend, onDismiss }) {
  const ah = proposal.autoHelp || {};
  const [busy, setBusy] = useState(null); // 'send' | 'dismiss' | null
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false); // dismiss reason row
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false); // the agent changed the answer
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editorRef = useRef(null);
  const reasons = (ah.dismissReasons && ah.dismissReasons.length ? ah.dismissReasons : Object.keys(REASON_LABEL));
  const pct = ah.confidence === null || ah.confidence === undefined ? null : Math.round(Number(ah.confidence) * 100);
  const promise = followUpPromise(ah.followUp);
  const answerHtml = ah.answerHtml || proposal.bodyHtml || '';
  // The last send could not be confirmed (FreshService did not answer and its
  // thread could not be read): the agent checks FreshService, then confirms.
  const needsCheck = proposal.status === 'needs_check';
  const disclosureOff = !String(ah.disclosure || '').trim();

  useEffect(() => {
    if (editing && editorRef.current) {
      // Model output never goes into a live DOM unsanitized: the composer's
      // allowlist (no scripts, handlers, styles or forms).
      editorRef.current.innerHTML = sanitizeRichHtml(answerHtml);
      editorRef.current.focus();
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopEditing = () => {
    setEditing(false);
    setDirty(false);
    setConfirmDiscard(false);
  };
  // Leaving the editor with changes asks first — in the card, not a browser dialog.
  const leaveEditing = () => {
    if (dirty) setConfirmDiscard(true);
    else stopEditing();
  };

  const run = async (kind, fn) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(friendlyError(err, kind));
      setBusy(null);
    }
  };

  const send = () => run('send', async () => {
    const edited = editing ? sanitizeRichHtml(String(editorRef.current?.innerHTML || '')).trim() : null;
    if (editing && !String(editorRef.current?.textContent || '').trim()) throw new Error('The answer is empty — write something or cancel the edit.');
    const confirm = needsCheck ? { confirmResend: true } : {};
    await onSend(edited ? { bodyHtml: edited, ...confirm } : confirm);
  });

  const dismiss = (reason) => run('dismiss', () => onDismiss(reason));

  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || busy) return;
    if (confirmDiscard) {
      e.stopPropagation();
      setConfirmDiscard(false); // Escape on the question = keep editing
      editorRef.current?.focus();
      return;
    }
    if (editing) {
      e.stopPropagation();
      leaveEditing();
      return;
    }
    if (asking) {
      e.stopPropagation();
      setAsking(false);
    }
  };

  return (
    <section
      className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.035] p-3 animate-fadeIn sm:p-3.5 dark:bg-primary/[0.07]"
      aria-label="Auto-help suggestion"
      data-testid="auto-help-suggestion"
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <BookOpen className="h-4 w-4 flex-shrink-0 translate-y-0.5 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Auto-help suggests</h2>
        {ah.playbookName && <span className="min-w-0 truncate text-xs text-muted-foreground">{ah.playbookName}</span>}
        {pct !== null && (
          <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground" title="How sure the model was that the sources answer this">
            {pct} % confident
          </span>
        )}
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="auto-help-ai-drafted">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden="true" />
        AI-drafted from the sources below — read it before you send; it goes out under your name.
      </p>
      {ah.sensitive && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Sensitive topic — Auto-help only ever suggests; a person always sends.
        </p>
      )}
      {ah.partial && (
        <div className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-100" data-testid="auto-help-partial">
          <p className="font-medium">Partial answer — check what’s missing before you send.</p>
          {Array.isArray(ah.leftOut) && ah.leftOut.length > 0 && (
            <>
              <p className="mt-0.5 opacity-80">Left out because the knowledge doesn’t cover it:</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {ah.leftOut.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {/* The mail as the requester reads it: a white e-mail well in both themes. */}
      <div className="mt-2.5 overflow-hidden rounded-lg border border-border" data-testid="email-well-wrap">
        <div className="tp-light max-h-80 overflow-y-auto bg-card px-3.5 py-3 text-sm text-card-foreground settings-scrollbar" data-testid="email-well">
          {ah.workflowAck?.text && (
            <p className="mb-2.5 whitespace-pre-wrap text-foreground/85" data-testid="auto-help-workflow-ack" title="The workflow's acknowledgement goes out on top of this answer — one e-mail">{ah.workflowAck.text}</p>
          )}
          {ah.disclosure && <p className="mb-2.5 text-xs text-muted-foreground" data-testid="auto-help-disclosure">{ah.disclosure}</p>}
          {editing ? (
            <div
              ref={editorRef}
              role="textbox"
              aria-multiline="true"
              aria-label="Edit the answer"
              contentEditable
              suppressContentEditableWarning
              className="tp-focus-ring min-h-[6rem] rounded-md px-1 py-0.5 outline-none ring-1 ring-primary/30 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5"
              data-testid="auto-help-editor"
              onInput={() => setDirty(true)}
            />
          ) : (
            <SafeHtml html={answerHtml} isDark={false} />
          )}
          {ah.footer && <p className="mt-3 text-foreground/85" data-testid="auto-help-footer">{ah.footer}</p>}
          {ah.signatureHtml && <div className="mt-3" data-testid="auto-help-signature"><SafeHtml html={ah.signatureHtml} isDark={false} /></div>}
        </div>
      </div>

      <div className="mt-2.5 space-y-1.5">
        {disclosureOff && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="auto-help-disclosure-off">
            <Info className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span>The automated-answer line is off for this workspace — the requester won’t be told this answer was drafted automatically.</span>
          </p>
        )}
        <SourceLinks sources={ah.sources || []} />
        {promise && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="auto-help-promise">
            <CalendarClock className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{promise} If they reply that they still need a hand, it comes straight back to a person.</span>
          </p>
        )}
      </div>

      {needsCheck && (
        <p role="alert" className="mt-3 text-xs text-destructive" data-testid="auto-help-needs-check">
          We couldn&apos;t confirm the answer went out — check the ticket in FreshService before sending again.
        </p>
      )}

      {ah.canSend === false ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="auto-help-waiting-approver">
          Waiting for the assignee, a reviewer or an admin to send it.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={send}
            disabled={Boolean(busy)}
            className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy === 'send' ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
            {needsCheck ? 'I checked — send again' : editing ? 'Send edited answer' : 'Send'}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={leaveEditing}
              disabled={Boolean(busy) || confirmDiscard}
              className="tp-focus-ring inline-flex h-8 items-center rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              Cancel edit
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setAsking(false); setDirty(false); setEditing(true); }}
              disabled={Boolean(busy)}
              className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground/85 hover:bg-muted disabled:opacity-60"
            >
              <PencilLine className="h-3.5 w-3.5" aria-hidden="true" /> Edit &amp; send
            </button>
          )}

          {asking ? (
            <div role="group" aria-label="Why dismiss it?" className="flex w-full flex-wrap items-center gap-1.5 sm:ml-auto sm:w-auto" data-testid="dismiss-reasons">
              <span className="text-xs text-muted-foreground">Why?</span>
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => dismiss(r)}
                  disabled={Boolean(busy)}
                  className="tp-focus-ring inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-foreground/85 hover:bg-muted disabled:opacity-60"
                >
                  {REASON_LABEL[r] || r}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAsking(false)}
                disabled={Boolean(busy)}
                aria-label="Keep the suggestion"
                className="tp-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              >
                {busy === 'dismiss' ? <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { stopEditing(); setAsking(true); }}
              disabled={Boolean(busy)}
              className="tp-focus-ring ml-auto inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Dismiss
            </button>
          )}
        </div>
      )}
      {confirmDiscard && (
        <div role="alertdialog" aria-label="Discard your edits?" className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs animate-fadeIn" data-testid="auto-help-discard-confirm">
          <span className="text-foreground">Discard your edits to this answer?</span>
          <button
            type="button"
            autoFocus
            onClick={() => { setConfirmDiscard(false); editorRef.current?.focus(); }}
            className="tp-focus-ring inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 font-medium text-foreground hover:bg-muted"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={stopEditing}
            className="tp-focus-ring inline-flex h-7 items-center rounded-lg px-2.5 font-medium text-destructive hover:bg-destructive/10"
          >
            Discard edits
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
    </section>
  );
}
