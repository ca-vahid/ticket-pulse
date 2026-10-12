import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Columns2, Link2, Rows2 } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { formatDayTime } from '../tickets/ticketUi';
import { Confidence, Loading, PersonLine, SectionTitle, SourcesList } from './knowledgeUi';
import { fmtDuration } from './knowledgeFormat';
import { BAND_LABELS, actionWords } from './answeringFormat';
import { usd } from './autoHelpWords';
import {
  AnswerCard, GATE_WORD, ReviewBox, RunDetails, RunLife, RunResult, TRIGGER_WORD, TeamOutcome, VERDICT_WORD,
} from './runParts';
import { neighboursOf } from './activityList';

/**
 * One Auto-help run on its own page (12 Oct 2026; it used to be a side panel).
 * Reads top to bottom the way a reviewer works: what was asked, what Auto-help
 * would have said, what the team actually said. The right rail holds the
 * verdict, the facts behind "how sure", the sources and what happened next.
 * Previous / Next walk the list the run was opened from (J and K too).
 */

const COMPARE_KEY = 'tp:knowledge:run:compare';
const LEVEL_OF_MODE = { shadow: 'Draft only', approve: 'Suggest to an agent', auto: 'Send' };
const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

function Card({ title, hint = null, children, testId = undefined, aside = null }) {
  return (
    <section className="tp-card p-4 sm:p-5" data-testid={testId}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><SectionTitle hint={hint}>{title}</SectionTitle></div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A label and its value on one line of the facts list. */
function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-sm">
      <dt className="w-24 flex-shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground/90">{children}</dd>
    </div>
  );
}

/** What the requester wrote. Long requests fold. */
function RequestCard({ run }) {
  const req = run.request;
  const [open, setOpen] = useState(false);
  const text = req?.text || '';
  const long = text.length > 600;
  const shown = long && !open ? `${text.slice(0, 600).trimEnd()}…` : text;
  return (
    <Card title="What was asked" testId="run-request">
      <p className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {req?.requester?.name && <PersonLine person={{ name: req.requester.name, email: req.requester.email }} />}
        {[req?.requester?.jobTitle, req?.requester?.department].filter(Boolean).map((v) => (<span key={v}>· {v}</span>))}
        {req?.createdAt && <span>· {formatDayTime(req.createdAt)}</span>}
      </p>
      {text
        ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">{shown}</p>
        : <p className="text-sm text-muted-foreground">The ticket has no description.</p>}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="tp-focus-ring mt-2 rounded text-xs font-medium text-primary hover:underline">
          {open ? 'Show less' : 'Show the whole request'}
        </button>
      )}
    </Card>
  );
}

/** Why the answer was rated the way it was: the things that counted against it. */
function SureCard({ run }) {
  const misses = Array.isArray(run.evidence?.misses) ? run.evidence.misses : [];
  const act = actionWords(run.evidence);
  if (!run.confidenceBand && !act) return null;
  return (
    <Card title="How sure" testId="run-sure">
      <p className="text-sm font-medium text-foreground">{BAND_LABELS[run.confidenceBand] || 'Not rated'}</p>
      {misses.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          {misses.map((m) => <li key={m.key}>{m.label}</li>)}
        </ul>
      ) : run.confidenceBand === 'high' ? (
        <p className="mt-1 text-xs text-muted-foreground">Nothing counted against it.</p>
      ) : null}
      {act && (
        <p className="mt-2 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
          Category level: <span className="text-foreground/85">{act.ceiling}</span>. What happened: <span className="text-foreground/85">{act.level}</span>{act.why ? ` (${act.why})` : ''}.
        </p>
      )}
    </Card>
  );
}

export default function RunPage({ runId, canReview = false }) {
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [compare, setCompare] = useState(() => {
    try { return localStorage.getItem(COMPARE_KEY) === '1'; } catch { return false; }
  });
  const near = useMemo(() => neighboursOf(runId), [runId]);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    knowledgeAPI.getRun(runId)
      .then((res) => { if (!cancelled) setRun(res?.data || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the run'); });
    return () => { cancelled = true; };
  }, [runId]);

  const go = useCallback((id) => { if (id) navigate(`/knowledge/activity/${id}`); }, [navigate]);
  const back = `/knowledge/activity${near.search || ''}`;

  // J / K (and the arrow keys with Alt) walk the list; never while typing.
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '')) return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'j' || (e.altKey && e.key === 'ArrowRight')) { if (near.next) { e.preventDefault(); go(near.next); } }
      if (e.key === 'k' || (e.altKey && e.key === 'ArrowLeft')) { if (near.prev) { e.preventDefault(); go(near.prev); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [near.next, near.prev, go]);

  const toggleCompare = () => {
    setCompare((v) => {
      try { localStorage.setItem(COMPARE_KEY, v ? '0' : '1'); } catch { /* preference only */ }
      return !v;
    });
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked: the address bar still has it */ }
  };

  const nav = 'tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-40 disabled:hover:bg-card';
  const quiet = 'tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground';

  const bar = (
    <div className="flex flex-wrap items-center gap-2" data-testid="run-bar">
      <Link to={back} className={quiet}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Activity</Link>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {near.position && <span className="text-xs tabular-nums text-muted-foreground" data-testid="run-position">{near.position.toLocaleString()} of {near.total.toLocaleString()}</span>}
        <button type="button" className={nav} disabled={!near.prev} onClick={() => go(near.prev)} aria-label="Previous run" title="Previous (K)">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
        </button>
        <button type="button" className={nav} disabled={!near.next} onClick={() => go(near.next)} aria-label="Next run" title="Next (J)">
          Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  if (error) return <div className="space-y-3">{bar}<p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p></div>;
  if (!run) return <div className="space-y-3">{bar}<Loading label="Loading run…" /></div>;

  const answered = ['drafted', 'staged', 'sent'].includes(run.status);
  const reviewable = answered || (run.status === 'not_answerable' && (run.checks?.draftSteps || []).length > 0);
  const category = [run.categoryName || run.request?.category, run.subcategoryName || run.request?.subCategory].filter(Boolean).join(' › ');
  const tokens = (Number(run.inputTokens) || 0) + (Number(run.outputTokens) || 0);
  const twoUp = compare && answered;

  const answer = <AnswerCard run={run} />;
  const team = (
    <Card title="What the team did" hint="The team's first public reply on the ticket, and where it stands now." testId="run-team">
      <TeamOutcome outcome={run.teamOutcome} />
    </Card>
  );

  return (
    <div className="space-y-4 animate-fadeIn" data-testid="run-detail">
      {bar}

      <header className="space-y-2">
        <h1 className="text-xl font-semibold leading-snug text-foreground">
          <Link to={`/tickets/${run.ticketId}?tab=ai`} className="tp-focus-ring inline-flex items-baseline gap-1.5 rounded hover:underline">
            <span className="text-muted-foreground">{run.ticketRef}</span> {run.ticketSubject}
            <ArrowUpRight className="h-4 w-4 self-center text-muted-foreground" aria-hidden="true" />
          </Link>
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <RunResult run={run} />
          {run.confidenceBand && <span className="text-xs text-foreground/85">{BAND_LABELS[run.confidenceBand]}</span>}
          <Confidence value={run.confidence} min={run.minConfidence} />
          {run.reviewVerdict && <span className="text-xs text-foreground/85">Reviewed: {VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict}</span>}
        </div>
        {GATE_WORD[run.gateDecision] && <p className="max-w-3xl text-sm text-foreground/85">{GATE_WORD[run.gateDecision]}</p>}
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <RequestCard run={run} />
          {answered && (
            <div className="flex justify-end">
              <button type="button" onClick={toggleCompare} aria-pressed={compare} className={`${quiet} max-xl:hidden`} data-testid="run-compare">
                {compare ? <Rows2 className="h-4 w-4" aria-hidden="true" /> : <Columns2 className="h-4 w-4" aria-hidden="true" />}
                {compare ? 'Stack the answer and the team’s reply' : 'Compare with the team’s reply side by side'}
              </button>
            </div>
          )}
          <div className={twoUp ? 'grid gap-4 xl:grid-cols-2 xl:items-start' : 'space-y-4'}>
            <div className="min-w-0" data-testid="run-answer">{answer}</div>
            {team}
          </div>
          <RunDetails run={run} />
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
          {canReview && reviewable && (
            <Card title="Your review" hint="Would this have been right? Counted per category, never per person." testId="run-review">
              <ReviewBox key={run.id} run={run} onSaved={(next) => { if (next) setRun((prev) => ({ ...prev, ...next })); }} onNext={near.next ? () => go(near.next) : null} />
            </Card>
          )}
          {!canReview && run.reviewVerdict && (
            <p className="px-1 text-xs text-muted-foreground">Reviewed: {VERDICT_WORD[run.reviewVerdict] || run.reviewVerdict}</p>
          )}

          <SureCard run={run} />

          {(run.decision || run.status === 'staged') && (
            <Card title="What the agent did" testId="run-agent"><RunLife run={run} /></Card>
          )}

          <Card title="About this run" testId="run-facts">
            <dl className="divide-y divide-border/50">
              <Fact label="When">{formatDayTime(run.createdAt)}</Fact>
              <Fact label="Started by">
                {run.createdBy ? <PersonLine person={run.createdByPerson} email={run.createdBy} /> : (TRIGGER_WORD[run.trigger] || run.trigger)}
              </Fact>
              {run.createdBy && <Fact label="Kind">{TRIGGER_WORD[run.trigger] || run.trigger}</Fact>}
              <Fact label="Category">{category || null}</Fact>
              <Fact label="Priority">{PRIORITY[run.request?.priority] || null}</Fact>
              <Fact label="Assigned to">{run.request?.assigneeName || null}</Fact>
              <Fact label="Ticket now">{run.ticketStatus || null}</Fact>
              <Fact label="Rule">
                {run.playbookId ? (
                  <Link to={`/knowledge/playbooks/${run.playbookId}`} className="tp-focus-ring rounded hover:underline">
                    {run.playbookName || `Playbook #${run.playbookId}`}{run.playbookVersion ? ` v${run.playbookVersion}` : ''}
                  </Link>
                ) : null}
              </Fact>
              <Fact label="Level">{LEVEL_OF_MODE[run.mode] || 'Draft only'}{run.mode === 'shadow' || !run.mode ? ' (never sent)' : ''}</Fact>
              <Fact label="Cost">{`${usd(run.costUsd)}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}${fmtDuration(run.durationMs) ? ` · ${fmtDuration(run.durationMs)}` : ''}`}</Fact>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/60 pt-3">
              <Link to={`/tickets/${run.ticketId}?tab=ai`} className={quiet}><ArrowUpRight className="h-4 w-4" aria-hidden="true" /> Open the ticket</Link>
              <button type="button" onClick={copyLink} className={quiet} data-testid="run-copy-link">
                <Link2 className="h-4 w-4" aria-hidden="true" /> {copied ? 'Link copied' : 'Copy link'}
              </button>
            </div>
          </Card>

          {(run.sources || []).some((s) => s.cited) && (
            <Card title="What the answer used" hint="Open one to fix it at the source." testId="run-sources">
              <SourcesList sources={run.sources || []} onlyCited />
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
