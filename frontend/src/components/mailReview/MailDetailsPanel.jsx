import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ImageOff, RefreshCw, X } from 'lucide-react';
import { LinkedText, SafeHtml } from '../tickets/ticketUi';
import { prepareEmailHtml } from '../tickets/attachmentPreview/prepareEmailHtml';
import { formatPacificWhen } from '../../utils/ticketDates';
import { SuggestionLine } from './WaitingRow';
import {
  MODE_WORD, OUTCOME_WORD, closedNote, finalSentence, fmtRef, money, needsPerson, seconds, suggestionSentence,
} from './mailReviewText';

/**
 * Details for one held e-mail: the mail itself, what the AI suggested and
 * why, the tickets it looked at, and every earlier judgement. A slide-in
 * dialog (full screen on a phone) that keeps the focus inside and closes on
 * Esc. The body takes the same path as the attached-e-mail preview (4.3.60):
 * remote pictures hidden until asked, DOMPurify via SafeHtml, and a white
 * `.tp-light` well in both themes.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Section({ title, children }) {
  return (
    <section className="border-t border-border/60 px-5 py-4 sm:px-6">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function EmailBody({ html, text }) {
  const [showImages, setShowImages] = useState(false);
  const body = useMemo(() => prepareEmailHtml(html, { showImages }), [html, showImages]);
  return (
    <div className="bg-muted/50 p-2 sm:p-3" data-testid="mr-email">
      {body.blocked > 0 && !showImages && (
        <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground" data-testid="mr-images-blocked">
          <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{body.blocked === 1 ? '1 picture from the internet is hidden' : `${body.blocked} pictures from the internet are hidden`}, so the sender can&apos;t tell this e-mail was opened.</span>
          <button type="button" onClick={() => setShowImages(true)} className="tp-focus-ring rounded font-semibold text-primary hover:underline">Show pictures</button>
        </p>
      )}
      <div className="tp-light overflow-x-auto rounded-md bg-card px-5 py-4 text-foreground shadow-subtle sm:px-6">
        {html
          ? <SafeHtml html={body.html} isDark={false} />
          : text
            ? <LinkedText text={text} className="text-sm text-foreground/85" />
            : <p className="text-sm text-muted-foreground">This e-mail has no message text.</p>}
      </div>
    </div>
  );
}

export default function MailDetailsPanel({
  item, detail = null, error = null, mode = 'off', isAdmin = false, rejudging = false, onRejudge, onClose,
}) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  // Focus goes in on open and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    closeRef.current?.focus();
    return () => { if (before && typeof before.focus === 'function' && document.contains(before)) before.focus(); };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...(panelRef.current?.querySelectorAll(FOCUSABLE) || [])];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!item) return null;
  const full = detail && detail.heldId === item.heldId ? detail : null;
  const s = (full || item).suggestion;
  const decisions = full?.decisions || [];
  const latest = decisions.find((d) => d.id === s?.decisionId) || decisions[0] || null;
  const earlier = decisions.filter((d) => d !== latest);
  const candidates = full?.candidates || [];
  const usage = latest ? [
    latest.model,
    latest.inputTokens != null || latest.outputTokens != null ? `${Number(latest.inputTokens || 0).toLocaleString('en-US')} tokens in, ${Number(latest.outputTokens || 0).toLocaleString('en-US')} out` : '',
    money(latest.costUsd),
    seconds(latest.latencyMs),
  ].filter(Boolean).join(' · ') : '';

  const scores = candidates
    .filter((c) => c.score !== null && c.score !== undefined)
    .map((c) => `${fmtRef(c.ticket)} ${Number(c.score).toFixed(2)}`)
    .join(' · ');

  return (
    <div className="fixed inset-0 z-[60]" data-testid="mr-details-layer">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mr-details-title"
        data-mr-popover
        data-testid="mr-details"
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 right-0 flex w-full flex-col bg-card shadow-soft animate-slide-in-right motion-off:animate-none sm:max-w-2xl sm:border-l sm:border-border"
      >
        <header className="flex items-start gap-3 px-5 pb-3 pt-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id="mr-details-title" className="text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{item.subject || '(no subject)'}</h2>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">From</dt>
              <dd className="min-w-0 break-words text-foreground/85">{item.from?.name ? `${item.from.name} <${item.from.email}>` : item.from?.email || '(unknown sender)'}</dd>
              {(item.to || []).length > 0 && (<><dt className="text-muted-foreground">To</dt><dd className="min-w-0 break-words text-foreground/85">{item.to.join('; ')}</dd></>)}
              {(item.cc || []).length > 0 && (<><dt className="text-muted-foreground">Cc</dt><dd className="min-w-0 break-words text-foreground/85">{item.cc.join('; ')}</dd></>)}
              <dt className="text-muted-foreground">Received</dt>
              <dd className="tabular-nums text-foreground/85">{formatPacificWhen(item.receivedAt)}</dd>
              {item.holdReasonLabel && (<><dt className="text-muted-foreground">Held because</dt><dd className="min-w-0 text-foreground/85">{item.holdReasonLabel}</dd></>)}
            </dl>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Section title="The AI’s suggestion">
            <SuggestionLine suggestion={s} mode={mode} />
            {s?.reason && <p className="mt-1.5 text-sm text-foreground/85">Why: {s.reason}</p>}
            {(s?.evidence || []).length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">It used: {s.evidence.join(' · ')}</p>
            )}
            {needsPerson(s || latest).length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="mr-details-needs-person">Needs a person: {needsPerson(s || latest).join(' · ')}</p>
            )}
            {(latest?.guards || []).length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="mr-guards">Checks applied: {latest.guards.join(' · ')}</p>
            )}
            {s?.judgedAt && <p className="mt-1 text-xs tabular-nums text-muted-foreground">Judged {formatPacificWhen(s.judgedAt)}</p>}
            {isAdmin && (
              <button
                type="button"
                disabled={rejudging}
                onClick={() => onRejudge?.(item)}
                className="tp-focus-ring mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50"
                data-testid="mr-rejudge"
              >
                {rejudging
                  ? <Activity className="h-4 w-4 animate-spin motion-off:animate-none" aria-hidden="true" />
                  : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                Judge again
              </button>
            )}
          </Section>

          <section className="border-t border-border/60">
            <h3 className="px-5 pb-1.5 pt-4 text-xs font-semibold text-muted-foreground sm:px-6">The e-mail</h3>
            {error ? (
              <p role="alert" className="px-5 pb-4 text-sm text-red-700 dark:text-red-300 sm:px-6">{error}</p>
            ) : full ? (
              <EmailBody html={full.bodyHtml} text={full.bodyText || item.snippet} />
            ) : (
              <p className="flex items-center gap-2 px-5 pb-4 text-sm text-muted-foreground sm:px-6">
                <Activity className="h-4 w-4 animate-spin motion-off:animate-none" aria-hidden="true" /> Loading the e-mail…
              </p>
            )}
          </section>

          {full && (
            <Section title={`Tickets the AI looked at (${candidates.length})`}>
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">None. Nothing in this workspace looked like the same matter.</p>
              ) : (
                <ul className="divide-y divide-border/60" data-testid="mr-candidates">
                  {candidates.map((c) => (
                    <li key={c.ticket.id} className="py-2 first:pt-0 last:pb-0">
                      <p className="text-sm text-foreground [overflow-wrap:anywhere]">
                        <a href={`/tickets/${c.ticket.id}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded font-medium tabular-nums text-primary hover:underline">{fmtRef(c.ticket)}</a>
                        {c.ticket.subject ? ` · ${c.ticket.subject}` : ''}
                        <span className="text-muted-foreground">
                          {closedNote(c.ticket) ? ` ${closedNote(c.ticket)}` : c.ticket.status ? ` (${c.ticket.status})` : ''}
                          {c.ticket.requesterName ? ` · ${c.ticket.requesterName}` : ''}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Considered because: {(c.why || []).join(' · ') || 'not recorded'}
                      </p>
                      {c.aiNote && <p className="mt-0.5 text-xs text-foreground/85">AI: {c.aiNote}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {full && earlier.length > 0 && (
            <Section title="Earlier judgements of this e-mail">
              <ul className="space-y-1.5" data-testid="mr-earlier">
                {earlier.map((d) => (
                  <li key={d.id} className="text-sm text-foreground/85">
                    <span className="tabular-nums text-muted-foreground">{formatPacificWhen(d.createdAt)}</span>
                    {suggestionSentence(d) ? ` · ${suggestionSentence(d)}` : ''}{d.confidence ? ` · ${d.confidence}` : ''}
                    <span className="text-muted-foreground">
                      {' · '}{OUTCOME_WORD[d.outcome] || d.outcome}{(d.outcome === 'changed' || d.outcome === 'manual') && finalSentence(d) ? `: “${finalSentence(d)}”` : ''}
                      {d.mode ? ` · ${MODE_WORD[d.mode] || d.mode}` : ''}
                    </span>
                    {d.reason && <span className="block text-xs text-muted-foreground">Why: {d.reason}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {isAdmin && (usage || scores) && (
          <footer className="border-t border-border/60 px-5 py-2 text-xs tabular-nums text-muted-foreground sm:px-6" data-testid="mr-usage">
            {usage && <p>{usage}</p>}
            {scores && <p data-testid="mr-scores">Match scores: {scores}</p>}
          </footer>
        )}
      </aside>
    </div>
  );
}
