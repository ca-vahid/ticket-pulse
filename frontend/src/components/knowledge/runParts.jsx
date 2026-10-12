import { useState } from 'react';
import { ChevronRight, Hand, Mail } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { formatDayTime } from '../tickets/ticketUi';
import {
  DraftPreview, PersonLine, RunStatus, SectionTitle, SourcesList, TranscriptSteps,
} from './knowledgeUi';
import { fitReasonOf, fmtDuration, isNotThisPlaybook, readableReason } from './knowledgeFormat';
import { BAND_LABELS, actionWords } from './answeringFormat';
import { DECISION_WORD, DISMISS_WORD, OUTCOME_WORD, runLifeLine, usd } from './autoHelpWords';

/**
 * The pieces of one Auto-help run, shared by the Activity list and the run
 * page (split out of ActivityPanel on 12 Oct 2026 when a run got its own page).
 */

// The outcome line, in the order a ticket falls through Auto-help.
export const OUTCOMES = [
  { value: 'drafted', label: 'Drafted' },
  { value: 'staged', label: 'Suggested to an agent' },
  { value: 'sent', label: 'Sent' },
  { value: 'not_answerable', label: 'Not answerable' },
  { value: 'no_match', label: 'No match' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
];

// Why a run ended where it did (gateDecision), in plain words.
export const GATE_WORD = {
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
  no_match: 'No playbook fits this ticket.',
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
  // Knowledge-first.
  needs_person: 'A person has to do something here; written instructions would not sort it out.',
  category_off: 'Skipped: Auto-help is off for this category (Knowledge → Answering).',
  no_default_rule: 'Skipped: the workspace’s answer rule could not be read.',
};
export const HISTORY_WORD = {
  drafted: 'Drafted',
  staged: 'Suggested on the ticket',
  sent: 'Sent',
  sent_overnight: 'Sent by itself overnight (outside business hours)',
  assignee_told: 'The assignee was told it is waiting',
  parked: 'Waiting on the requester',
  park_failed: 'Sent, but the follow-up could not be scheduled',
  dismissed: 'Dismissed',
  nudged: 'Checked in with the requester',
  reopen_undone: 'Reopen undone (FreshService flip)',
  ...OUTCOME_WORD,
};

// R6 shadow review verdicts (words, never pills).
export const VERDICTS = [
  { value: 'good', label: 'Good' },
  { value: 'partial', label: 'Partly right' },
  { value: 'wrong', label: 'Wrong' },
  { value: 'should_not_answer', label: 'Shouldn’t answer' },
];
export const VERDICT_WORD = Object.fromEntries(VERDICTS.map((v) => [v.value, v.label]));
export const CHECK_WORD = { yes: 'enough', partial: 'partly enough', no: 'not enough' };
export const RANGE_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];
export const TRIGGER_WORD = { categorized: 'New ticket', test: 'Test', manual: 'Manual', backtest: 'Backtest' };

/** The stay-quiet record on a run (checks.stayQuiet), or null. */
export function stayQuietOf(run) {
  if (run?.checks?.stayQuiet) return run.checks.stayQuiet;
  return run?.gateDecision === 'stayed_quiet' ? {} : null;
}
export function stayQuietLine(sq) {
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
export function RunResult({ run }) {
  if (stayQuietOf(run)) return <StayedQuietStatus />;
  if (isNotThisPlaybook(run)) {
    const why = fitReasonOf(run);
    return <RunStatus status="not_this_playbook" title={why ? `Why: ${why}` : undefined} />;
  }
  if (run?.gateDecision === 'needs_person') {
    const why = run.checks?.triage?.reason;
    return <RunStatus status="needs_person" title={why ? `Why: ${why}` : undefined} />;
  }
  return <RunStatus status={run.status} />;
}

/** One short line for a run's row: why it ended where it did. */
export function rowReason(r) {
  const sq = stayQuietOf(r);
  if (sq) return stayQuietLine(sq);
  if (isNotThisPlaybook(r)) return fitReasonOf(r) || 'The AI decided this playbook doesn’t fit';
  if (r.gateDecision === 'needs_person') return r.checks?.triage?.reason || GATE_WORD.needs_person;
  const life = runLifeLine(r);
  if (life) return life;
  if (r.status === 'drafted') {
    const dropped = r.checks?.droppedSteps || [];
    if (dropped.length) return `Drafted without step ${dropped.join(', ')} (not in the knowledge)`;
    // Knowledge-first: how sure the answer was, and why it stayed a draft.
    const act = actionWords(r.evidence);
    if (act) return `Drafted, not sent · ${BAND_LABELS[r.confidenceBand] || 'not rated'}${act.why ? ` · ${act.why}` : ''}`;
    return 'Drafted — not sent (shadow)';
  }
  if (r.gateDecision === 'insufficient_context') return 'The knowledge doesn’t cover enough of this';
  if (r.gateDecision === 'no_match' && r.checks?.fit?.reason) return `No playbook fits: ${r.checks.fit.reason}`;
  return GATE_WORD[r.gateDecision] || '—';
}

/** A panel section: a quiet card with a small heading. */
export function DrawerCard({ title, hint = null, children, testId = undefined }) {
  return (
    <section className="tp-card p-4 sm:p-5" data-testid={testId}>
      <SectionTitle hint={hint}>{title}</SectionTitle>
      {children}
    </section>
  );
}

/**
 * The numbered draft the answer check judged (checks.draftSteps). Steps the
 * knowledge did not back are marked — this is what "step 3" refers to.
 */
export function DraftSteps({ steps }) {
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

/**
 * "Send to me" (30 Sep 2026): e-mails you exactly what the requester would
 * get — disclosure, answer, follow-up line and signature — under a
 * "Preview only" band. Nothing goes to the requester.
 */
export function SendToMe({ runId }) {
  const [state, setState] = useState({ busy: false, msg: null, error: null });
  const send = async () => {
    setState({ busy: true, msg: null, error: null });
    try {
      const res = await knowledgeAPI.sendRunToMe(runId);
      setState({ busy: false, msg: `Sent to ${res?.data?.to || 'you'} — check your inbox.`, error: null });
    } catch (err) {
      setState({ busy: false, msg: null, error: err?.message || 'Could not send the preview' });
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="send-to-me">
      <button
        type="button"
        onClick={send}
        disabled={state.busy}
        className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50"
      >
        <Mail className="h-3.5 w-3.5" aria-hidden="true" />
        {state.busy ? 'Sending…' : 'Send to me'}
      </button>
      <span className="text-xs text-muted-foreground">E-mails you exactly what the requester would get. Nothing goes to them.</span>
      {state.msg && <span className="w-full text-xs text-emerald-700 dark:text-emerald-300" role="status">{state.msg}</span>}
      {state.error && <span className="w-full text-xs text-red-700 dark:text-red-300" role="alert">{state.error}</span>}
    </div>
  );
}

/** "What Auto-help would have said" — or, when it didn't answer, why. */
export function AnswerCard({ run }) {
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
        <SendToMe runId={run.id} />
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
export function TeamOutcome({ outcome }) {
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
export function ReviewBox({ run, onSaved, onNext = null }) {
  const [verdict, setVerdict] = useState(run.reviewVerdict || '');
  const [note, setNote] = useState(run.reviewNote || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (v = verdict, thenNext = false) => {
    if (!v) return;
    setSaving(true);
    setError(null);
    try {
      const res = await knowledgeAPI.reviewRun(run.id, { verdict: v, note: note.trim() || null });
      onSaved?.(res?.data || null);
      if (thenNext) onNext?.();
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
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => save()} disabled={!verdict || saving} className="tp-focus-ring inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save review'}
        </button>
        {onNext && (
          <button type="button" onClick={() => save(verdict, true)} disabled={!verdict || saving} className="tp-focus-ring inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50" data-testid="review-save-next">
            Save and next
          </button>
        )}
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
export function RunLife({ run }) {
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
export function RunDetails({ run }) {
  const tokens = (Number(run.inputTokens) || 0) + (Number(run.outputTokens) || 0);
  const a = run.checks?.answerability;
  return (
    <details className="group tp-card" data-testid="run-details">
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
