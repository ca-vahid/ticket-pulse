import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, CircleSlash, FlaskConical } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import {
  Confidence, DraftPreview, RunStatus, SectionTitle, SourcesList, inputClass,
} from './knowledgeUi';
import { fmtDuration, readableReason } from './knowledgeFormat';

/**
 * "Test on a ticket": runs the SAVED playbook on a real ticket and shows the
 * answer exactly as the requester would get it (disclosure + footer), the
 * confidence against the playbook's bar, and the sources it cited. Shadow —
 * nothing is sent, but the run is recorded under Activity.
 */
// Same words as Activity's run drawer.
const CHECK_WORD = { yes: 'enough', partial: 'partly enough', no: 'not enough' };

export default function PlaybookTestBox({ playbookId, dirty = false, disabled = false }) {
  const [ref, setRef] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  const test = async (e) => {
    e?.preventDefault();
    if (!ref.trim() || !playbookId) return;
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const res = await knowledgeAPI.testPlaybook(playbookId, ref.trim());
      setRun(res?.data || null);
    } catch (err) {
      setError(err?.message || 'The test did not run');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-label="Test on a ticket" data-testid="playbook-test">
      <SectionTitle icon={FlaskConical} hint="Runs this playbook on a real ticket. Nothing is sent — you see what the requester would get.">
        Test on a ticket
      </SectionTitle>
      {!playbookId ? (
        <p className="text-xs text-muted-foreground">Save the playbook first, then test it here.</p>
      ) : (
        <>
          <form onSubmit={test} className="flex gap-2">
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="TP-1234 or #241406"
              aria-label="Ticket to test on"
              className={inputClass}
              disabled={disabled || running}
            />
            <button
              type="submit"
              disabled={disabled || running || !ref.trim()}
              className="tp-focus-ring inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              Run test
            </button>
          </form>
          {dirty && <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">Unsaved changes are not tested — save first.</p>}
        </>
      )}

      {running && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Drafting an answer… this can take up to 45 seconds.
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      {run && !running && (
        <div className="mt-4 space-y-3 animate-fadeIn" data-testid="playbook-test-result">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <RunStatus status={run.status} />
            <Confidence value={run.confidence} min={run.minConfidence} />
            {fmtDuration(run.durationMs) && <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(run.durationMs)}</span>}
            {run.id && (
              <Link to={`/knowledge/activity/${run.id}`} className="tp-focus-ring ml-auto inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
                Run details <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {run.ticketRef} · {run.ticketSubject}
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
