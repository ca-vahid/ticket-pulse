import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Hand, ListChecks } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui';
import { formatDayTime, timeAgo } from '../tickets/ticketUi';
import {
  Confidence, DraftPreview, EmptyState, Loading, PersonLine, RunStatus, SectionTitle, SourcesList, TranscriptSteps,
} from './knowledgeUi';
import { fitReasonOf, fmtDuration, isNotThisPlaybook, readableReason } from './knowledgeFormat';
import PlaybookMetrics from './PlaybookMetrics';
import { DECISION_WORD, DISMISS_WORD, OUTCOME_WORD, runLifeLine, usd } from './autoHelpWords';

/**
 * Knowledge → Activity (reorganised 29 Sep 2026). Two views:
 *   Runs (default)  one line of outcome counts that doubles as the result
 *                   filter, then every run; a run opens a side panel.
 *   By playbook     one compact row per playbook (PlaybookMetrics).
 * The run panel answers, in order: what happened, what Auto-help would have
 * said (with any step the knowledge didn't back marked), what the team did,
 * your review. Sources, raw steps and cost sit under "Details".
 */

// The outcome line, in the order a ticket falls through Auto-help.
const OUTCOMES = [
  { value: 'drafted', label: 'Drafted' },
  { value: 'staged', label: 'Suggested to an agent' },
  { value: 'sent', label: 'Sent' },
  { value: 'not_answerable', label: 'Not answerable' },
  { value: 'no_match', label: 'No match' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
];

// Why a run ended where it did (gateDecision), in plain words.
const GATE_WORD = {
  shadow_recorded: 'Drafted from an article or verified solution.',
  playbook_only: 'Drafted from the playbook’s own instructions only — never sent without a person.',
  no_sources: 'No article or verified solution matched this ticket, so there was nothing to answer from.',
  no_grounded_source: 'The answer quoted nothing it had actually read.',
  model_declined: 'The AI said the knowledge doesn’t answer this.',
  invalid_submission: 'The AI’s answer was malformed.',
  guard_blocked: 'The safety guard blocked the answer.',
  time_budget: 'Ran out of time.',
  interrupted: 'Interrupted before it finished.',
  run_not_recorded: 'Could not be recorded, so it did not run.',
  no_match: 'No playbook covers this ticket’s category.',
  noise: 'Skipped: the ticket is marked noise.',
  security: 'Skipped: security ticket.',
  trusted_intake: 'Skipped: machine alert from a trusted integration.',
  approval_in_progress: 'Skipped: an approval is in progress.',
  open_proposed_reply: 'Skipped: a proposed reply is waiting for an agent.',
  agent_replied: 'Skipped: an agent already replied.',
  agent_requester: 'Skipped: the requester is an agent.',
  always_human: 'Skipped: the requester always gets a person.',
  requester_daily_cap: 'Skipped: this requester reached the daily limit.',
  resolved: 'Skipped: already resolved or closed.',
  already_ran: 'Skipped: Auto-help already ran on this ticket.',
  noise_decision: 'Skipped: the AI marked the ticket as noise.',
  not_actionable: 'Skipped: the AI marked the ticket as not needing action.',
  parked: 'Skipped: the ticket is parked.',
  uncited_step: 'A step quoted nothing it had read.',
  insufficient_context: 'The knowledge doesn’t cover enough of this to answer.',
  partial_context: 'Drafted from what the knowledge covers — never sent without a person.',
  check_failed: 'The answer check could not run.',
  staged_for_agent: 'Suggested on the ticket for an agent to send.',
  below_confidence: 'Drafted, but below the playbook’s confidence bar — not suggested to an agent.',
  human_draft_exists: 'Drafted, but a proposed reply was already waiting on the ticket — that one wins.',
  stage_failed: 'Drafted, but it could not be suggested on the ticket.',
  auto_sent: 'Sent automatically.',
  budget_exhausted: 'Skipped: the workspace reached its monthly Auto-help cost cap.',
  stayed_quiet: 'A “stay quiet when” rule applied, so a person picks it up.',
  not_this_playbook: 'In the playbook’s subcategories, but the AI read its “When to help” and decided it doesn’t fit.',
};
const HISTORY_WORD = {
  drafted: 'Drafted',
  staged: 'Suggested on the ticket',
  sent: 'Sent',
  parked: 'Waiting on the requester',
  park_failed: 'Sent, but the follow-up could not be scheduled',
  dismissed: 'Dismissed',
  nudged: 'Checked in with the requester',
  reopen_undone: 'Reopen undone (FreshService flip)',
  ...OUTCOME_WORD,
};

// R6 shadow review verdicts (words, never pills).
const VERDICTS = [
  { value: 'good', label: 'Good' },
  { value: 'partial', label: 'Partly right' },
  { value: 'wrong', label: 'Wrong' },
  { value: 'should_not_answer', label: 'Shouldn’t answer' },
];
const VERDICT_WORD = Object.fromEntries(VERDICTS.map((v) => [v.value, v.label]));
const CHECK_WORD = { yes: 'enough', partial: 'partly enough', no: 'not enough' };
const RANGE_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];
const TRIGGER_WORD = { categorized: 'New ticket', test: 'Test', manual: 'Manual', backtest: 'Backtest' };

/** The stay-quiet record on a run (checks.stayQuiet), or null. */
function stayQuietOf(run) {
  if (run?.checks?.stayQuiet) return run.checks.stayQuiet;
  return run?.gateDecision === 'stayed_quiet' ? {} : null;
}
function stayQuietLine(sq) {
  return `Stayed quiet: ${sq?.condition || 'a stay-quiet condition applied'}`;
}
function StayedQuietStatus() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-blue-700 dark:text-blue-200">
      <Hand className="h-3.5 w-3.5" aria-hidden="true" /> Stayed quiet
    </span>
  );
}
/** The Result cell / panel status: stay-quiet and "Not this playbook" win over the plain status. */
function RunResult({ run }) {
  if (stayQuietOf(run)) return <StayedQuietStatus />;
  if (isNotThisPlaybook(run)) {
    const why = fitReasonOf(run);
    return <RunStatus status="not_this_playbook" title={why ? `Why: ${why}` : undefined} />;
  }
  return <RunStatus status={run.status} />;
}

/** One short line for a run's row: why it ended where it did. */
function rowReason(r) {
  const sq = stayQuietOf(r);
  if (sq) return stayQuietLine(sq);
  if (isNotThisPlaybook(r)) return fitReasonOf(r) || 'The AI decided this playbook doesn’t fit';
  const life = runLifeLine(r);
  if (life) return life;
  if (r.status === 'drafted') {
    const dropped = r.checks?.droppedSteps || [];
    return dropped.length ? `Drafted without step ${dropped.join(', ')} (not in the knowledge)` : 'Drafted — not sent (shadow)';
  }
  if (r.gateDecision === 'insufficient_context') return 'The knowledge doesn’t cover enough of this';
  return GATE_WORD[r.gateDecision] || '—';
}

/** A panel section: a quiet card with a small heading. */
function DrawerCard({ title, hint = null, children, testId = undefined }) {
  return (
    <section className="rounded-xl border border-border/80 p-3.5" data-testid={testId}>
      <SectionTitle hint={hint}>{title}</SectionTitle>
      {children}
    </section>
  );
}

/**
 * The numbered draft the answer check judged (checks.draftSteps). Steps the
 * knowledge did not back are marked — this is what "step 3" refers to.
 */
function DraftSteps({ steps }) {
  return (
    <ol className="space-y-1.5" data-testid="draft-steps">
      {steps.map((st) => (
        <li key={st.n} className="flex gap-2.5 text-sm">
          <span className={`mt-px w-5 flex-shrink-0 text-right tabular-nums ${st.supported ? 'text-muted-foreground' : 'font-semibold text-amber-700 dark:text-amber-300'}`}>{st.n}.</span>
          <span className="min-w-0 flex-1">
            <span className={st.supported ? 'text-foreground/85' : 'text-foreground/60 line-through decoration-amber-500/70'}>{st.text}</span>
            {!st.supported && (
              <span className="mt-0.5 block text-xs font-medium text-amber-700 dark:text-amber-300">Not in the knowledge — left out</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "What Auto-help would have said" — or, when it didn't answer, why. */
function AnswerCard({ run }) {
  const draftSteps = Array.isArray(run.checks?.draftSteps) ? run.checks.draftSteps : [];
  const dropped = draftSteps.filter((st) => !st.supported);
  const checkReason = run.checks?.answerability?.reason ? readableReason(run.checks.answerability.reason, run.sources) : null;
  const sq = stayQuietOf(run);

  if (run.status === 'drafted' || run.status === 'staged' || run.status === 'sent') {
    return (
      <DrawerCard title="What the requester would get">
        {dropped.length > 0 && (
          <div className="mb-2.5 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-100" data-testid="dropped-steps">
            Left out {dropped.length === 1 ? 'a step' : `${dropped.length} steps`} the knowledge doesn’t cover:
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {dropped.map((st) => <li key={st.n}>{st.text}</li>)}
            </ul>
          </div>
        )}
        <DraftPreview subject={run.draftSubject} html={run.draftHtml} />
      </DrawerCard>
    );
  }

  let body;
  if (isNotThisPlaybook(run)) {
    body = (
      <div className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm text-foreground/85" data-testid="run-not-this-playbook">
        <p className="font-medium text-foreground">Not this playbook</p>
        <p className="mt-0.5 text-[13px]">{fitReasonOf(run) ? readableReason(fitReasonOf(run), run.sources) : 'The AI fit check gave no reason.'}</p>
      </div>
    );
  } else if (sq) {
    body = (
      <div className="rounded-lg border border-blue-200/80 bg-blue-50/60 px-3.5 py-3 text-sm text-blue-900 dark:border-blue-400/25 dark:bg-blue-500/10 dark:text-blue-100" data-testid="run-stayed-quiet">
        <p className="font-medium">{stayQuietLine(sq)}</p>
        {sq.reason && <p className="mt-0.5 text-[13px] opacity-80">{sq.reason}</p>}
        <p className="mt-1 text-xs opacity-75">
          {sq.scope === 'workspace' ? 'A workspace-wide rule' : sq.scope === 'playbook' ? 'One of this playbook’s rules' : 'A rule'}
          {sq.via === 'check' ? ', caught by the answer check.' : ', reported by the drafting AI.'}
        </p>
      </div>
    );
  } else if (draftSteps.length) {
    body = (
      <div className="space-y-2.5">
        {checkReason && <p className="text-sm text-foreground/85">{checkReason}</p>}
        <p className="text-xs font-medium text-muted-foreground">What it tried to say</p>
        <DraftSteps steps={draftSteps} />
      </div>
    );
  } else {
    const legacySteps = run.checks?.answerability?.unsupportedSteps || [];
    body = (
      <div className="space-y-1.5">
        <p className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm text-foreground/85">
          {run.status === 'failed'
            ? (run.error || 'The run failed.')
            : (checkReason || readableReason(run.transcript?.reason, run.sources) || (run.transcript?.reasons || []).join('; ') || GATE_WORD[run.gateDecision] || 'Auto-help did not answer.')}
        </p>
        {legacySteps.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Runs before 29 Sep did not keep the draft, so the step {legacySteps.length === 1 ? 'number refers' : 'numbers refer'} to a draft that is no longer shown.
          </p>
        )}
      </div>
    );
  }
  return <DrawerCard title="Why Auto-help didn’t answer">{body}</DrawerCard>;
}

/** "What the team did": the first public agent reply after the run, and where the ticket is now. */
function TeamOutcome({ outcome }) {
  const reply = outcome?.firstReply;
  const t = outcome?.ticket;
  return (
    <div className="space-y-2" data-testid="team-outcome">
      {reply ? (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <PersonLine person={reply.author} email={reply.author?.email} />
            <span aria-hidden="true">·</span>
            <span>{formatDayTime(reply.occurredAt)}</span>
          </p>
          <p className="settings-scrollbar max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 px-3.5 py-2.5 text-sm leading-relaxed text-foreground/85">{reply.text || '(empty reply)'}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No public reply from the team yet.</p>
      )}
      {t && (
        <p className="text-xs text-muted-foreground">
          Now <span className="font-medium text-foreground/85">{t.status}</span>
          {t.resolvedAt ? ` · resolved ${formatDayTime(t.resolvedAt)}` : ''}
          {t.resolutionReason ? ` · ${t.resolutionReason.replace(/_/g, ' ')}` : ''}
          {t.resolutionNote ? ` — ${t.resolutionNote}` : ''}
          {t.verifiedSolution ? ` · verified solution: ${t.verifiedSolution}` : ''}
        </p>
      )}
    </div>
  );
}

/** Verdict buttons + note (R6). Reviewers and admins only. */
function ReviewBox({ run, onSaved }) {
  const [verdict, setVerdict] = useState(run.reviewVerdict || '');
  const [note, setNote] = useState(run.reviewNote || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (v = verdict) => {
    if (!v) return;
    setSaving(true);
    setError(null);
    try {
      const res = await knowledgeAPI.reviewRun(run.id, { verdict: v, note: note.trim() || null });
      onSaved?.(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not save the review');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="review-box">
      <div role="group" aria-label="Verdict" className="flex flex-wrap gap-1.5">
        {VERDICTS.map((v) => (
          <button
            key={v.value}
            type="button"
            aria-pressed={verdict === v.value}
            onClick={() => setVerdict(v.value)}
            className={`tp-focus-ring inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors ${
              verdict === v.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground/85 hover:bg-muted'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <textarea
        aria-label="Review note"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What was right or wrong? (optional)"
        className="tp-focus-ring w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/75"
      />
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => save()} disabled={!verdict || saving} className="tp-focus-ring inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save review'}
        </button>
        {run.reviewedAt && (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Last: {VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict} by <PersonLine person={run.reviewedByPerson} email={run.reviewedBy} />
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}
    </div>
  );
}

/** Approve / auto mode: what the agent did with the suggestion and how the follow-up went. */
function RunLife({ run }) {
  const history = Array.isArray(run.outcomeDetail?.history) ? run.outcomeDetail.history : [];
  const shown = history.filter((h) => h.step !== 'drafted');
  return (
    <div className="space-y-2" data-testid="run-life">
      {run.decision && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-foreground/85">
          <span className="font-medium">{DECISION_WORD[run.decision] || run.decision}</span>
          {run.decidedBy && run.decision !== 'auto_sent' && (<><span className="text-muted-foreground">by</span><PersonLine person={run.decidedByPerson} email={run.decidedBy} /></>)}
          {run.decision === 'agent_edited_sent' && run.editDistance !== null && run.editDistance !== undefined && (
            <span className="text-xs text-muted-foreground">· changed about {Math.round(run.editDistance * 100)} % of the words</span>
          )}
          {run.decision === 'agent_dismissed' && run.dismissReason && <span className="text-xs text-muted-foreground">· {DISMISS_WORD[run.dismissReason] || run.dismissReason}</span>}
        </p>
      )}
      {run.status === 'staged' && !run.decision && <p className="text-sm text-muted-foreground">Suggested on the ticket — waiting for an agent.</p>}
      {shown.length > 0 && (
        <ol className="space-y-1 border-l border-border pl-3">
          {shown.map((h, i) => (
            <li key={`${h.step}-${i}`} className="text-xs text-foreground/85">
              <span className="text-muted-foreground tabular-nums">{formatDayTime(h.at)}</span> · {HISTORY_WORD[h.step] || h.step.replace(/_/g, ' ')}
              {h.until ? <span className="text-muted-foreground"> until {formatDayTime(h.until)}</span> : null}
              {h.closeAt ? <span className="text-muted-foreground"> — next step {formatDayTime(h.closeAt)}</span> : null}
              {h.via === 'model' ? <span className="text-muted-foreground"> (reply read by the AI)</span> : h.via === 'keywords' ? <span className="text-muted-foreground"> (reply read by keywords)</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Sources, the raw steps, the answer check and cost — for when you need them. */
function RunDetails({ run }) {
  const tokens = (Number(run.inputTokens) || 0) + (Number(run.outputTokens) || 0);
  const a = run.checks?.answerability;
  return (
    <details className="group rounded-xl border border-border/80" data-testid="run-details">
      <summary className="tp-focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3.5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted/40">
        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        Details
        <span className="ml-auto text-xs font-normal text-muted-foreground">sources, steps, cost</span>
      </summary>
      <div className="space-y-4 border-t border-border/70 px-3.5 py-3">
        {a && (
          <p className="text-xs text-muted-foreground" data-testid="answerability">
            Answer check: {CHECK_WORD[a.sufficient] || a.sufficient}
            {(a.unsupportedSteps || []).length ? ` · not backed: step ${a.unsupportedSteps.join(', ')}` : ''}
            {a.reason ? ` — ${readableReason(a.reason, run.sources)}` : ''}
          </p>
        )}
        <p className="text-xs text-muted-foreground" data-testid="run-cost">
          Model cost {usd(run.costUsd)}{tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}
          {fmtDuration(run.durationMs) ? ` · ${fmtDuration(run.durationMs)}` : ''}
        </p>
        <div>
          <SectionTitle>Sources</SectionTitle>
          <SourcesList sources={run.sources || []} />
        </div>
        <div>
          <SectionTitle>Steps</SectionTitle>
          <TranscriptSteps transcript={run.transcript} />
        </div>
      </div>
    </details>
  );
}

function RunDetail({ runId, canReview = false }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    knowledgeAPI.getRun(runId)
      .then((res) => { if (!cancelled) setRun(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the run'); });
    return () => { cancelled = true; };
  }, [runId]);

  if (error) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!run) return <Loading label="Loading run…" />;
  const reviewable = ['drafted', 'staged', 'sent'].includes(run.status)
    || (run.status === 'not_answerable' && (run.checks?.draftSteps || []).length > 0);
  return (
    <div className="space-y-4" data-testid="run-detail">
      <div className="space-y-1.5">
        <Link to={`/tickets/${run.ticketId}?tab=ai`} className="tp-focus-ring inline-flex items-center gap-1 rounded text-[15px] font-semibold text-foreground hover:underline">
          {run.ticketRef} · {run.ticketSubject} <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <RunResult run={run} />
          <Confidence value={run.confidence} min={run.minConfidence} />
        </div>
        {GATE_WORD[run.gateDecision] && <p className="text-sm text-foreground/85">{GATE_WORD[run.gateDecision]}</p>}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{TRIGGER_WORD[run.trigger] || run.trigger} · {formatDayTime(run.createdAt)}</span>
          {run.createdBy && (<><span aria-hidden="true">·</span><span>by</span><PersonLine person={run.createdByPerson} email={run.createdBy} /></>)}
          {run.playbookId && (
            <>
              <span aria-hidden="true">·</span>
              <Link to={`/knowledge/playbooks/${run.playbookId}`} className="tp-focus-ring rounded text-foreground/85 hover:underline">{run.playbookName || `Playbook #${run.playbookId}`}</Link>
              {run.playbookVersion ? <span>v{run.playbookVersion}</span> : null}
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>{run.mode === 'approve' || run.mode === 'auto' ? `${run.mode} mode` : 'shadow — never sent'}</span>
        </p>
      </div>

      <AnswerCard run={run} />

      {(run.decision || run.status === 'staged') && (
        <DrawerCard title="What the agent did">
          <RunLife run={run} />
        </DrawerCard>
      )}

      <DrawerCard title="What the team did" hint="The team's first public reply on the ticket, and where it stands now.">
        <TeamOutcome outcome={run.teamOutcome} />
      </DrawerCard>

      {canReview && reviewable && (
        <DrawerCard title="Your review" hint="Would this have been right? Counts per playbook, never per person.">
          <ReviewBox run={run} onSaved={(next) => { if (next) setRun(next); }} />
        </DrawerCard>
      )}
      {!canReview && run.reviewVerdict && (
        <p className="text-xs text-muted-foreground">Reviewed: {VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict}</p>
      )}

      <RunDetails run={run} />
    </div>
  );
}

/** The outcome line: every result with its count; a click filters the list. */
function OutcomeLine({ counts, total, value, onChange }) {
  const shown = OUTCOMES.filter((o) => (counts?.[o.value] || 0) > 0 || o.value === value);
  const item = (key, label, n, active) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(active && key ? '' : key)}
      aria-pressed={active}
      className={`tp-focus-ring inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
        active ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground/85 hover:bg-muted'
      }`}
    >
      <span className="tabular-nums">{n}</span>{' '}
      <span className={active ? '' : 'text-muted-foreground'}>{label}</span>
    </button>
  );
  return (
    <nav aria-label="Filter by result" className="flex flex-wrap items-center gap-x-1 gap-y-1" data-testid="outcome-line">
      {item('', 'All runs', total, value === '')}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {shown.map((o) => item(o.value, o.label, counts?.[o.value] || 0, value === o.value))}
    </nav>
  );
}

function RunsView({ playbookId, range, canReview }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const from = range ? new Date(Date.now() - Number(range) * 86400e3).toISOString() : undefined;
    knowledgeAPI.listRuns({ status: status || undefined, playbookId: playbookId || undefined, from })
      .then((res) => { if (!cancelled) { setData(res?.data || { items: [], total: 0 }); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load activity'); });
    return () => { cancelled = true; };
  }, [status, playbookId, range]);

  const counts = data?.statusCounts || null;
  const allTotal = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : (data?.total || 0);
  const open = (id) => navigate(`/knowledge/activity/${id}`);

  return (
    <div className="space-y-3" data-testid="runs-view">
      {counts && <OutcomeLine counts={counts} total={allTotal} value={status} onChange={setStatus} />}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!data && !error ? <Loading label="Loading activity…" /> : data && data.items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={ListChecks} title={status ? 'No runs with this result' : 'No runs yet'}>
            Runs appear here when a new ticket matches a switched-on playbook, or when someone tests a playbook on a ticket.
          </EmptyState>
        </div>
      ) : data && (
        <div className="tp-card overflow-hidden">
          <table className="w-full text-left text-sm" data-testid="runs-table">
            <thead className="hidden border-b border-border/70 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:table-header-group">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">When</th>
                <th scope="col" className="px-2 py-2 font-medium">Ticket</th>
                <th scope="col" className="px-2 py-2 font-medium">Playbook</th>
                <th scope="col" className="px-2 py-2 font-medium">Result</th>
                <th scope="col" className="px-4 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => open(r.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.id); } }}
                  className="tp-focus-ring cursor-pointer align-middle transition-colors hover:bg-muted/40 max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:px-4 max-sm:py-3"
                  aria-label={`Run on ${r.ticketRef}`}
                >
                  <td className="whitespace-nowrap text-xs text-muted-foreground sm:px-4 sm:py-2.5" title={formatDayTime(r.createdAt)}>
                    {timeAgo(r.createdAt)}{r.trigger === 'test' ? ' · test' : r.trigger === 'backtest' ? ' · backtest' : ''}
                  </td>
                  <td className="min-w-0 max-w-[18rem] max-sm:w-full sm:px-2 sm:py-2.5">
                    <p className="truncate text-foreground"><span className="text-muted-foreground">{r.ticketRef}</span> {r.ticketSubject}</p>
                  </td>
                  <td className="max-w-[11rem] truncate text-xs text-foreground/85 sm:px-2 sm:py-2.5">{r.playbookName || (r.playbookId ? `Removed playbook #${r.playbookId}` : '—')}</td>
                  <td className="sm:px-2 sm:py-2.5"><RunResult run={r} /></td>
                  <td className="max-w-[28rem] text-xs text-muted-foreground sm:px-4 sm:py-2.5">
                    <span className="line-clamp-2" data-testid={stayQuietOf(r) ? 'row-stayed-quiet' : isNotThisPlaybook(r) ? 'row-not-this-playbook' : undefined}>
                      {rowReason(r)}
                    </span>
                    {r.reviewVerdict ? <span className="text-foreground/80"> · reviewed: {VERDICT_WORD[r.reviewVerdict] || r.reviewVerdict}</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.items.length && (
        <p className="px-1 text-xs text-muted-foreground">Showing the newest {data.items.length} of {data.total}.</p>
      )}
      {canReview && data?.items?.some((r) => r.status === 'drafted' && !r.reviewVerdict) && (
        <p className="px-1 text-xs text-muted-foreground">Open a drafted run to review it — reviews are what unlock approve mode.</p>
      )}
    </div>
  );
}

function PlaybooksView({ playbookId, range }) {
  const [summary, setSummary] = useState(null);
  const [autoModeAllowed, setAutoModeAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const from = range ? new Date(Date.now() - Number(range) * 86400e3).toISOString() : undefined;
    Promise.resolve()
      .then(() => knowledgeAPI.runsSummary({ from }))
      .then((res) => { if (!cancelled) setSummary(res?.data || []); })
      .catch(() => { if (!cancelled) setSummary([]); });
    return () => { cancelled = true; };
  }, [range]);
  useEffect(() => {
    Promise.resolve()
      .then(() => knowledgeAPI.getSettings())
      .then((res) => setAutoModeAllowed(res?.data?.autoModeAllowed === true))
      .catch(() => {});
  }, []);
  if (summary === null) return <Loading label="Loading playbooks…" />;
  const items = playbookId ? summary.filter((p) => String(p.playbookId) === String(playbookId)) : summary;
  if (!items.length) {
    return (
      <div className="tp-card">
        <EmptyState icon={ListChecks} title="No playbook has run yet">Numbers appear once a playbook has drafted or declined at least one ticket.</EmptyState>
      </div>
    );
  }
  return <PlaybookMetrics items={items} autoModeAllowed={autoModeAllowed} />;
}

const VIEWS = [
  { value: 'runs', label: 'Runs' },
  { value: 'playbooks', label: 'By playbook' },
];

/** Knowledge → Activity: Runs / By playbook, shared filters, the run side panel. */
export default function ActivityPanel({ runId = null, canReview = false }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'playbooks' ? 'playbooks' : 'runs';
  // ?playbook=<id> (the builder's "Runs in Activity") pre-filters the list.
  const [playbookId, setPlaybookId] = useState(() => params.get('playbook') || '');
  const [range, setRange] = useState('');
  const [playbooks, setPlaybooks] = useState([]);

  useEffect(() => {
    knowledgeAPI.listPlaybooks().then((res) => setPlaybooks(res?.data || [])).catch(() => {});
  }, []);

  const playbookOptions = useMemo(() => [
    { value: '', label: 'Every playbook' },
    ...playbooks.map((p) => ({ value: p.id, label: p.name })),
  ], [playbooks]);

  const setView = (next) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'runs') nextParams.delete('view'); else nextParams.set('view', next);
    setParams(nextParams, { replace: true });
  };
  const closeRun = () => navigate(`/knowledge/activity${view === 'playbooks' ? '?view=playbooks' : ''}`);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="activity-filters">
        <div role="tablist" aria-label="Activity view" className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={view === v.value}
              onClick={() => setView(v.value)}
              className={`tp-focus-ring h-8 rounded-md px-3.5 text-sm font-medium transition-colors ${
                view === v.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex">
          <div className="sm:w-56"><FancySelect value={playbookId} onChange={setPlaybookId} options={playbookOptions} aria-label="Playbook" className="h-9" /></div>
          <div className="sm:w-44"><FancySelect value={range} onChange={setRange} options={RANGE_OPTIONS} aria-label="When" className="h-9" /></div>
        </div>
      </div>

      {view === 'runs'
        ? <RunsView playbookId={playbookId} range={range} canReview={canReview} />
        : <PlaybooksView playbookId={playbookId} range={range} />}

      <Sheet open={Boolean(runId)} onOpenChange={(isOpen) => { if (!isOpen) closeRun(); }}>
        <SheetContent side="right" className="settings-scrollbar w-full overflow-y-auto border-border bg-card sm:max-w-xl">
          <SheetTitle className="text-base">Auto-help run</SheetTitle>
          <SheetDescription className="sr-only">What Auto-help did on one ticket: its answer, what the team did, and your review.</SheetDescription>
          <div className="mt-4">{runId && <RunDetail runId={runId} canReview={canReview} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
