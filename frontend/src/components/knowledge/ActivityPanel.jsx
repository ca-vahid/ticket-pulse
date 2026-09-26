import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Hand, ListChecks } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui';
import { formatDayTime, timeAgo } from '../tickets/ticketUi';
import {
  Confidence, DraftPreview, EmptyState, Loading, PersonLine, RunStatus, SectionTitle, SourcesList, TranscriptSteps,
} from './knowledgeUi';
import { fmtDuration, readableReason } from './knowledgeFormat';
import PlaybookMetrics from './PlaybookMetrics';
import { DECISION_WORD, DISMISS_WORD, OUTCOME_WORD, runLifeLine, usd } from './autoHelpWords';

const STATUS_OPTIONS = [
  { value: '', label: 'Any result' },
  { value: 'drafted', label: 'Drafted' },
  { value: 'staged', label: 'Suggested to an agent' },
  { value: 'sent', label: 'Sent' },
  { value: 'not_answerable', label: 'Not answerable' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'no_match', label: 'No match' },
];
// Why a run ended where it did (gateDecision), in plain words.
const GATE_WORD = {
  shadow_recorded: 'Grounded in an article or verified solution.',
  playbook_only: 'Grounded only in the playbook’s own instructions — never sent without a person.',
  no_sources: 'Nothing in the knowledge matched, so the model was not asked.',
  no_grounded_source: 'The answer cited no article or verified solution it had seen.',
  model_declined: 'The model said the sources don’t answer this.',
  invalid_submission: 'The model’s answer was malformed.',
  guard_blocked: 'The safety guard blocked the answer.',
  time_budget: 'Ran out of its time budget.',
  interrupted: 'Interrupted before it finished.',
  run_not_recorded: 'Could not be recorded, so it did not run.',
  no_match: 'No playbook matched this ticket.',
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
  uncited_step: 'A step named no source the run had seen.',
  insufficient_context: 'The check found the retrieved knowledge not enough to answer.',
  partial_context: 'The check found the knowledge answers only part of this — never sent without a person.',
  check_failed: 'The answerability check could not run.',
  // P1 (approve mode, budgets)
  staged_for_agent: 'Passed every gate and was suggested on the ticket for an agent to send.',
  below_confidence: 'Drafted, but below the playbook’s confidence bar — not suggested to an agent.',
  human_draft_exists: 'Drafted, but a proposed reply was already waiting on the ticket — that one wins.',
  stage_failed: 'Drafted, but it could not be suggested on the ticket.',
  auto_sent: 'Sent automatically.',
  budget_exhausted: 'Skipped: the workspace reached its monthly Auto-help cost cap.',
  // "Stay quiet when" (26 Sep 2026)
  stayed_quiet: 'A “stay quiet when” rule applied, so Auto-help did not answer — a person picks it up.',
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

/** The stay-quiet record on a run (checks.stayQuiet), or null. */
function stayQuietOf(run) {
  if (run?.checks?.stayQuiet) return run.checks.stayQuiet;
  return run?.gateDecision === 'stayed_quiet' ? {} : null;
}
function stayQuietLine(sq) {
  return `Stayed quiet: ${sq?.condition || 'a stay-quiet condition applied'}`;
}

/** A drawer section: a quiet card with a small heading. */
function DrawerCard({ title, hint = null, children, testId = undefined }) {
  return (
    <section className="rounded-xl border border-border/80 p-3.5" data-testid={testId}>
      <SectionTitle hint={hint}>{title}</SectionTitle>
      {children}
    </section>
  );
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

/** P1: what happened after the draft — the agent's decision, the loop's steps, the cost. */
function RunLife({ run }) {
  const history = Array.isArray(run.outcomeDetail?.history) ? run.outcomeDetail.history : [];
  const shown = history.filter((h) => h.step !== 'drafted');
  const tokens = (Number(run.inputTokens) || 0) + (Number(run.outputTokens) || 0);
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
      {shown.length > 0 && (
        <ol className="space-y-1 border-l border-border pl-3">
          {shown.map((h, i) => (
            <li key={`${h.step}-${i}`} className="text-xs text-foreground/85">
              <span className="text-muted-foreground tabular-nums">{formatDayTime(h.at)}</span> · {HISTORY_WORD[h.step] || h.step.replace(/_/g, ' ')}
              {h.until ? <span className="text-muted-foreground"> until {formatDayTime(h.until)}</span> : null}
              {h.closeAt ? <span className="text-muted-foreground"> — next step {formatDayTime(h.closeAt)}</span> : null}
              {h.via === 'model' ? <span className="text-muted-foreground"> (reply read by the model)</span> : h.via === 'keywords' ? <span className="text-muted-foreground"> (reply read by keywords)</span> : null}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground" data-testid="run-cost">
        Model cost {usd(run.costUsd)}{tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}
      </p>
    </div>
  );
}
const RANGE_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];
const TRIGGER_WORD = { categorized: 'New ticket', test: 'Test', manual: 'Manual', backtest: 'Backtest' };

function StayedQuietStatus() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-blue-700 dark:text-blue-200">
      <Hand className="h-3.5 w-3.5" aria-hidden="true" /> Stayed quiet
    </span>
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
  const sq = stayQuietOf(run);
  return (
    <div className="space-y-4" data-testid="run-detail">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {sq ? <StayedQuietStatus /> : <RunStatus status={run.status} />}
          <Confidence value={run.confidence} min={run.minConfidence} />
          {fmtDuration(run.durationMs) && <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(run.durationMs)}</span>}
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{TRIGGER_WORD[run.trigger] || run.trigger} · {formatDayTime(run.createdAt)}</span>
          {run.createdBy && (
            <>
              <span aria-hidden="true">·</span>
              <span>by</span>
              <PersonLine person={run.createdByPerson} email={run.createdBy} />
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>{run.mode === 'approve' || run.mode === 'auto' ? `${run.mode} mode` : 'shadow — not sent'}</span>
        </p>
        {GATE_WORD[run.gateDecision] && <p className="text-xs text-muted-foreground">{GATE_WORD[run.gateDecision]}</p>}
        {run.checks?.answerability && (
          <p className="text-xs text-muted-foreground" data-testid="answerability">
            Context check: {CHECK_WORD[run.checks.answerability.sufficient] || run.checks.answerability.sufficient}
            {(run.checks.answerability.unsupportedSteps || []).length ? ` · unsupported step ${run.checks.answerability.unsupportedSteps.join(', ')}` : ''}
            {run.checks.answerability.reason ? ` — ${readableReason(run.checks.answerability.reason, run.sources)}` : ''}
          </p>
        )}
        <Link to={`/tickets/${run.ticketId}?tab=ai`} className="tp-focus-ring inline-flex items-center gap-1 rounded text-sm font-medium text-primary hover:underline">
          {run.ticketRef} · {run.ticketSubject} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        {run.playbookId && (
          <p className="text-xs text-muted-foreground">
            Playbook <Link to={`/knowledge/playbooks/${run.playbookId}`} className="tp-focus-ring rounded text-foreground/85 hover:underline">{run.playbookName || `#${run.playbookId}`}</Link>{run.playbookVersion ? ` v${run.playbookVersion}` : ''}
          </p>
        )}
      </div>

      <DrawerCard title={run.status === 'drafted' ? 'What the requester would get' : 'Why Auto-help didn’t answer'}>
        {run.status === 'drafted' ? (
          <DraftPreview subject={run.draftSubject} html={run.draftHtml} />
        ) : sq ? (
          <div className="rounded-lg border border-blue-200/80 bg-blue-50/60 px-3.5 py-3 text-sm text-blue-900 dark:border-blue-400/25 dark:bg-blue-500/10 dark:text-blue-100" data-testid="run-stayed-quiet">
            <p className="font-medium">{stayQuietLine(sq)}</p>
            {sq.reason && <p className="mt-0.5 text-[13px] opacity-80">{sq.reason}</p>}
            <p className="mt-1 text-xs opacity-75">
              {sq.scope === 'workspace' ? 'A workspace-wide rule' : sq.scope === 'playbook' ? 'One of this playbook’s rules' : 'A rule'}
              {sq.via === 'check' ? ', caught by the answerability check.' : ', reported by the drafting model.'}
            </p>
          </div>
        ) : (
          <p className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm text-foreground/85">
            {run.status === 'failed' ? (run.error || 'The run failed.') : (readableReason(run.transcript?.reason, run.sources) || (run.transcript?.reasons || []).join('; ') || 'Nothing — the playbook stayed quiet.')}
          </p>
        )}
      </DrawerCard>

      {(run.decision || run.status === 'staged' || run.costUsd !== null && run.costUsd !== undefined) && (
        <DrawerCard title="What happened" hint="What the agent did with the suggestion, and how the follow-up went.">
          {run.status === 'staged' && !run.decision ? <p className="text-sm text-muted-foreground">Suggested on the ticket — waiting for an agent.</p> : null}
          <RunLife run={run} />
        </DrawerCard>
      )}

      <DrawerCard title="What the team did" hint="The team's first public reply on the ticket, and where it stands now.">
        <TeamOutcome outcome={run.teamOutcome} />
      </DrawerCard>

      {canReview && !['skipped', 'no_match', 'running'].includes(run.status) && (
        <DrawerCard title="Your review" hint="Judge the draft against what the team did. Counts per playbook, never per person.">
          <ReviewBox run={run} onSaved={(next) => { if (next) setRun(next); }} />
        </DrawerCard>
      )}
      {!canReview && run.reviewVerdict && (
        <p className="text-xs text-muted-foreground">Reviewed: {VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict}</p>
      )}

      <DrawerCard title="Sources">
        <SourcesList sources={run.sources || []} />
      </DrawerCard>

      <DrawerCard title="Steps">
        <TranscriptSteps transcript={run.transcript} />
      </DrawerCard>
    </div>
  );
}

/** Runs table (time, ticket, playbook, result, confidence, outcome) + detail drawer. */
export default function ActivityPanel({ runId = null, canReview = false }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState('');
  // ?playbook=<id> (the builder's "Runs in Activity") pre-filters the list.
  const [playbookId, setPlaybookId] = useState(() => params.get('playbook') || '');
  const [range, setRange] = useState('');
  const [playbooks, setPlaybooks] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
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
  }, [range, runId]);

  useEffect(() => {
    knowledgeAPI.listPlaybooks().then((res) => setPlaybooks(res?.data || [])).catch(() => {});
    Promise.resolve()
      .then(() => knowledgeAPI.getSettings())
      .then((res) => setAutoModeAllowed(res?.data?.autoModeAllowed === true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const from = range ? new Date(Date.now() - Number(range) * 86400e3).toISOString() : undefined;
    knowledgeAPI.listRuns({ status: status || undefined, playbookId: playbookId || undefined, from })
      .then((res) => { if (!cancelled) { setData(res?.data || { items: [], total: 0 }); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load activity'); });
    return () => { cancelled = true; };
  }, [status, playbookId, range]);

  const playbookOptions = useMemo(() => [
    { value: '', label: 'Every playbook' },
    ...playbooks.map((p) => ({ value: p.id, label: p.name })),
  ], [playbooks]);

  return (
    <div className="space-y-3">
      <div className="tp-card grid grid-cols-1 gap-2 p-3 sm:flex sm:flex-wrap sm:items-center sm:p-4" data-testid="activity-filters">
        <div className="sm:w-48"><FancySelect value={status} onChange={setStatus} options={STATUS_OPTIONS} aria-label="Run result" className="h-10" /></div>
        <div className="sm:w-60"><FancySelect value={playbookId} onChange={setPlaybookId} options={playbookOptions} aria-label="Playbook" className="h-10" /></div>
        <div className="sm:w-48"><FancySelect value={range} onChange={setRange} options={RANGE_OPTIONS} aria-label="When" className="h-10" /></div>
        <p className="text-xs text-muted-foreground sm:ml-auto">Every run, per playbook — never per person.</p>
      </div>

      <PlaybookMetrics items={playbookId ? (summary || []).filter((p) => String(p.playbookId) === String(playbookId)) : summary} autoModeAllowed={autoModeAllowed} />

      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!data && !error ? <Loading label="Loading activity…" /> : data && data.items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={ListChecks} title="No runs yet">
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
                <th scope="col" className="px-2 py-2 font-medium">Confidence</th>
                <th scope="col" className="px-4 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => navigate(`/knowledge/activity/${r.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/knowledge/activity/${r.id}`); } }}
                  className="tp-focus-ring cursor-pointer align-middle transition-colors hover:bg-muted/40 max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:px-4 max-sm:py-3"
                  aria-label={`Run on ${r.ticketRef}`}
                >
                  <td className="whitespace-nowrap text-xs text-muted-foreground sm:px-4 sm:py-2.5" title={formatDayTime(r.createdAt)}>
                    {timeAgo(r.createdAt)}{r.trigger === 'test' ? ' · test' : r.trigger === 'backtest' ? ' · backtest' : ''}
                  </td>
                  <td className="min-w-0 max-w-[16rem] max-sm:w-full sm:px-2 sm:py-2.5">
                    <p className="truncate text-foreground"><span className="text-muted-foreground">{r.ticketRef}</span> {r.ticketSubject}</p>
                  </td>
                  <td className="max-w-[12rem] truncate text-xs text-foreground/85 sm:px-2 sm:py-2.5">{r.playbookName || '—'}</td>
                  <td className="sm:px-2 sm:py-2.5">{stayQuietOf(r) ? <StayedQuietStatus /> : <RunStatus status={r.status} />}</td>
                  <td className="sm:px-2 sm:py-2.5"><Confidence value={r.confidence} min={r.minConfidence} /></td>
                  <td className="text-xs text-muted-foreground sm:px-4 sm:py-2.5">
                    {stayQuietOf(r) ? <span className="text-foreground/80" data-testid="row-stayed-quiet">{stayQuietLine(stayQuietOf(r))}</span> : (runLifeLine(r) || (r.mode === 'approve' || r.mode === 'auto' ? 'not suggested' : 'shadow — not sent'))}
                    {r.reviewVerdict ? ` · ${VERDICT_WORD[r.reviewVerdict] || r.reviewVerdict}` : ''}
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

      <Sheet open={Boolean(runId)} onOpenChange={(open) => { if (!open) navigate('/knowledge/activity'); }}>
        <SheetContent side="right" className="settings-scrollbar w-full overflow-y-auto border-border bg-card sm:max-w-xl">
          <SheetTitle className="text-base">Auto-help run</SheetTitle>
          <SheetDescription className="sr-only">Draft, sources and steps of one Auto-help run.</SheetDescription>
          <div className="mt-4">{runId && <RunDetail runId={runId} canReview={canReview} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
