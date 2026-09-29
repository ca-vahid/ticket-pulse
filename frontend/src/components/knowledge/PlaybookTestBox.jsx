import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowUpRight, CheckCircle2, CircleCheck, CircleSlash, FileText, FlaskConical, Hand, Sparkles,
} from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import {
  Confidence, DraftPreview, RunStatus, SourcesList, inputClass,
} from './knowledgeUi';
import { fitReasonOf, fmtDuration, readableReason } from './knowledgeFormat';
import { IconTile } from './builderUi';

/**
 * "Test on a ticket": runs the SAVED playbook on a real ticket and shows the
 * answer exactly as the requester would get it (disclosure + footer), the
 * confidence against the playbook's bar, and the sources it cited. Shadow —
 * nothing is sent, but the run is recorded under Activity.
 *
 * `runRequest` (a counter) lets "Save & test" start a test after saving: it
 * runs when a ticket is typed, otherwise it focuses the ticket box.
 * `onResult(run)` tells the panel a new test finished (Preview answer shows it).
 */
// Same words as Activity's run drawer.
const CHECK_WORD = { yes: 'enough', partial: 'partly enough', no: 'not enough' };

/** The empty state: an icon composition, not an image (no external assets). */
function TestEmptyState() {
  return (
    <div className="flex flex-col items-center px-2 pb-2 pt-6 text-center" data-testid="test-empty">
      <div className="relative mb-5 flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-b from-blue-50 to-violet-50/60 dark:from-blue-500/10 dark:to-violet-500/10" aria-hidden="true">
        <span className="flex h-16 w-14 flex-col gap-1.5 rounded-lg border border-blue-200/80 bg-card p-2.5 shadow-soft dark:border-blue-400/25">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-400/80" />
            <span className="h-1.5 flex-1 rounded-full bg-blue-200 dark:bg-blue-400/40" />
          </span>
          <span className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
          <span className="h-1.5 w-4/5 rounded-full bg-muted-foreground/20" />
          <span className="h-1.5 w-3/5 rounded-full bg-muted-foreground/20" />
        </span>
        <Sparkles className="absolute right-3 top-4 h-5 w-5 text-violet-500 dark:text-violet-300" strokeWidth={1.75} />
        <Sparkles className="absolute bottom-6 left-3.5 h-3.5 w-3.5 text-violet-400 dark:text-violet-300/80" strokeWidth={1.75} />
      </div>
      <p className="text-[15px] font-semibold text-foreground">Test a ticket to see how this playbook responds</p>
      <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
        Enter a ticket number above and you&rsquo;ll see the exact answer the requester would get, from this playbook&rsquo;s settings and knowledge.
      </p>
      <ul className="mt-5 space-y-2.5 text-left text-[13px] text-foreground/85">
        {['Uses your scope, “When to help” and instructions', 'Shows source articles and links', 'Does not send a reply to the requester'].map((line) => (
          <li key={line} className="flex items-center gap-2.5">
            <CircleCheck className="h-[18px] w-[18px] flex-shrink-0 text-primary" aria-hidden="true" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PlaybookTestBox({
  playbookId, dirty = false, disabled = false, runRequest = 0, onResult = null,
}) {
  const [ref, setRef] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const refValue = useRef('');
  refValue.current = ref;

  const test = async (e) => {
    e?.preventDefault();
    const value = refValue.current.trim();
    if (!value || !playbookId) return;
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const res = await knowledgeAPI.testPlaybook(playbookId, value);
      setRun(res?.data || null);
      onResult?.(res?.data || null);
    } catch (err) {
      setError(err?.message || 'The test did not run');
    } finally {
      setRunning(false);
    }
  };

  // "Save & test": run with the typed ticket, or ask for one.
  useEffect(() => {
    if (!runRequest || !playbookId) return;
    if (refValue.current.trim()) test();
    else inputRef.current?.focus();
  }, [runRequest, playbookId]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per request

  const stayQuiet = run?.checks?.stayQuiet || (run?.gateDecision === 'stayed_quiet' ? {} : null);
  // Knowledge v2: the AI fit check read "When to help" and said no.
  const notThis = !stayQuiet && (run?.gateDecision === 'not_this_playbook' || run?.status === 'no_match');
  const fitReason = notThis ? fitReasonOf(run) : null;

  return (
    <section aria-label="Test on a ticket" data-testid="playbook-test">
      <div className="rounded-xl border border-border/80 p-3.5">
        <div className="flex items-start gap-3">
          <IconTile icon={FlaskConical} tone="violet" size="md" />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">Test on a ticket</h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              Runs this playbook on a real ticket. Nothing is sent &mdash; you see what the requester would get.
            </p>
          </div>
        </div>
        {!playbookId ? (
          <p className="mt-3 text-[13px] text-muted-foreground">Save the playbook first, then test it here.</p>
        ) : (
          <>
            <form onSubmit={test} className="mt-3.5 flex gap-2">
              <input
                ref={inputRef}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="TP-1234 or #241406"
                aria-label="Ticket to test on"
                className={`${inputClass} h-10`}
                disabled={disabled || running}
              />
              <button
                type="submit"
                disabled={disabled || running || !ref.trim()}
                className="tp-focus-ring inline-flex h-10 flex-shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Run test
              </button>
            </form>
            {dirty && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Unsaved changes are not tested &mdash; save first (or use Save &amp; test).</p>}
          </>
        )}
      </div>

      {running && (
        <div className="mt-6 flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground" role="status">
          <Activity className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
          Drafting an answer&hellip; this can take up to 45 seconds.
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!run && !running && !error && playbookId && <TestEmptyState />}

      {run && !running && (
        <div className="mt-4 space-y-3 animate-fadeIn" data-testid="playbook-test-result">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {stayQuiet ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-200"><Hand className="h-3.5 w-3.5" aria-hidden="true" /> Stayed quiet</span>
            ) : <RunStatus status={notThis ? 'not_this_playbook' : run.status} />}
            <Confidence value={run.confidence} min={run.minConfidence} />
            {fmtDuration(run.durationMs) && <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(run.durationMs)}</span>}
            {run.id && (
              <Link to={`/knowledge/activity/${run.id}`} className="tp-focus-ring ml-auto inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
                Run details <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" /> {run.ticketRef} · {run.ticketSubject}
          </p>
          {run.matchCheck && (
            <p className={`flex items-center gap-1.5 text-xs ${run.matchCheck.matches ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {run.matchCheck.matches ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <CircleSlash className="h-3.5 w-3.5" aria-hidden="true" />}
              {run.matchCheck.matches ? 'This playbook would pick up this ticket on its own.' : `On its own it would not pick this ticket up: ${run.matchCheck.reason.toLowerCase()}.`}
            </p>
          )}
          {run.checks?.answerability && (
            <p className="text-xs text-muted-foreground" data-testid="test-answerability">
              Context check: {CHECK_WORD[run.checks.answerability.sufficient] || run.checks.answerability.sufficient}
              {run.checks.answerability.reason ? ` — ${readableReason(run.checks.answerability.reason, run.sources)}` : ''}
            </p>
          )}
          {(run.warnings || []).length > 0 && (
            <ul className="space-y-0.5">
              {run.warnings.map((w) => (
                <li key={w} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {w} — a live run would skip it.
                </li>
              ))}
            </ul>
          )}

          {run.status === 'drafted' ? (
            <DraftPreview subject={run.draftSubject} html={run.draftHtml} />
          ) : notThis ? (
            <div className="rounded-lg border border-border bg-muted/50 px-3.5 py-3 text-sm text-foreground/90" data-testid="test-not-this-playbook">
              <p className="font-medium text-foreground">Not this playbook</p>
              <p className="mt-0.5 text-[13px]">
                {fitReason ? readableReason(fitReason, run.sources) : 'The AI read the ticket against “When to help” and decided this playbook doesn’t fit.'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">No answer was drafted. If it should fit, reword &ldquo;When to help&rdquo; in step 1 and test again.</p>
            </div>
          ) : stayQuiet ? (
            <div className="rounded-lg border border-blue-200/80 bg-blue-50/60 px-3.5 py-3 text-sm text-blue-900 dark:border-blue-400/25 dark:bg-blue-500/10 dark:text-blue-100" data-testid="test-stayed-quiet">
              <p className="font-medium">Stayed quiet: {stayQuiet.condition || 'a stay-quiet condition applied'}</p>
              {stayQuiet.reason && <p className="mt-0.5 text-[13px] opacity-80">{stayQuiet.reason}</p>}
              <p className="mt-1 text-xs opacity-75">No answer was drafted; a person would pick this ticket up.</p>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm text-foreground/85">
              {run.status === 'failed'
                ? (run.error || 'The run failed.')
                : (readableReason(run.transcript?.reason, run.sources) || 'The playbook could not answer this ticket from its sources, so it stays quiet.')}
            </div>
          )}

          {(run.sources || []).length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-foreground/85">Sources</p>
              <SourcesList sources={run.sources} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
