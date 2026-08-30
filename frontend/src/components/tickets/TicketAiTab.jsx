import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bot, Building2, Check, ChevronDown, Clock, Cpu,
  ExternalLink, Hand, Loader2, Plus, RotateCcw, Sparkles, UserRound, X, Zap,
} from 'lucide-react';
import { assignmentAPI } from '../../services/api';
import { PersonAvatar, formatDayTime, pipelineRunLabel, pipelineTriggerLabel, timeAgo } from './ticketUi';
import { getRecommendationList } from '../../utils/assignmentRecommendations';

/**
 * "AI & Routing" tab on the ticket page: every assignment pipeline run for
 * this ticket as an expandable card (recommendations, stages, write-backs,
 * provider stats), preceded by the human ownership story — who took it, how,
 * who returned it — told as a timeline. The Assignment Review run page stays
 * the deep-dive (full transcript, decide/rerun actions); this tab is the
 * ticket-side account of what the AI did and how the ticket moved.
 */

const STEP_LABELS = {
  classification: 'Classify',
  categorization: 'Categorize',
  location: 'Location',
  availability: 'Availability',
  competency: 'Competency',
  workload: 'Workload',
  recommendation: 'Recommend',
};

const DECISION_CHIPS = {
  pending_review: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 ring-amber-200 dark:ring-amber-500/30',
  approved: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-emerald-200 dark:ring-emerald-500/30',
  modified: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200 ring-sky-200 dark:ring-sky-500/30',
  rejected: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-200 dark:ring-red-500/30',
  auto_assigned: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 ring-indigo-200 dark:ring-indigo-500/30',
  noise_dismissed: 'bg-muted text-muted-foreground ring-border',
  duplicate_dismissed: 'bg-cyan-50 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-200 ring-cyan-200 dark:ring-cyan-500/30',
  priority_only: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 ring-violet-200 dark:ring-violet-500/30',
};

const RUN_STATUS_CHIPS = {
  queued: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 ring-amber-200 dark:ring-amber-500/30',
  running: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 ring-blue-200 dark:ring-blue-500/30',
  failed: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-200 dark:ring-red-500/30',
  failed_schema_validation: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-200 dark:ring-red-500/30',
  cancelled: 'bg-muted text-muted-foreground ring-border',
  superseded: 'bg-muted text-muted-foreground ring-border',
  skipped_stale: 'bg-muted text-muted-foreground ring-border',
};

function fmtMs(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtHold(startedAt, endedAt) {
  if (!startedAt) return null;
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const mins = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function chipFor(run) {
  if (run.decision && DECISION_CHIPS[run.decision]) return DECISION_CHIPS[run.decision];
  if (RUN_STATUS_CHIPS[run.status]) return RUN_STATUS_CHIPS[run.status];
  return 'bg-muted text-muted-foreground ring-border';
}

function WritebackChip({ label, status, error, at }) {
  if (!status) return null;
  const ok = /^(synced|success|written|done)$/i.test(status);
  const failed = /fail/i.test(status);
  const tone = ok
    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-emerald-200 dark:ring-emerald-500/30'
    : failed
      ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-200 dark:ring-red-500/30'
      : 'bg-muted text-muted-foreground ring-border';
  const title = [error, at ? `at ${new Date(at).toLocaleString()}` : null].filter(Boolean).join('\n') || undefined;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${tone}`} title={title}>
      {failed ? <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" /> : ok ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : null}
      {label}: {String(status).replace(/_/g, ' ')}
    </span>
  );
}

function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/75">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-foreground/85" title={typeof children === 'string' ? children : undefined}>{children}</dd>
    </div>
  );
}

function RunCard({ run, techById, expanded, onToggle, returnTo }) {
  const recs = getRecommendationList(run.recommendation);
  const topScore = typeof recs[0]?.score === 'number' ? Math.round(recs[0].score * 100) : null;
  const rebound = run.reboundFrom || null;

  return (
    <div className={`rounded-xl border transition-colors ${expanded ? 'border-indigo-200 dark:border-indigo-500/30 bg-card shadow-subtle' : 'border-border bg-card hover:border-indigo-200 dark:hover:border-indigo-500/30'}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="tp-focus-ring flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left"
      >
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-100 dark:ring-indigo-500/30">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-foreground">{pipelineRunLabel(run)}</span>
            <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${chipFor(run)}`}>
              {String(run.decision || run.status || '').replace(/_/g, ' ')}
            </span>
            {rebound && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-500/30">
                <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" /> after a return
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/75">
            via {pipelineTriggerLabel(run.triggerSource)}
            {run.assignedTech?.name ? ` · → ${run.assignedTech.name}` : ''}
            {topScore !== null ? ` · top match ${topScore}%` : ''}
          </span>
        </span>
        <span className="flex-none text-[11px] text-muted-foreground/75" title={new Date(run.decidedAt || run.createdAt).toLocaleString()}>
          {formatDayTime(run.decidedAt || run.createdAt)}
          {' · '}{timeAgo(run.decidedAt || run.createdAt)}
        </span>
        <ChevronDown className={`h-4 w-4 flex-none text-muted-foreground/75 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 px-3 pb-3 pt-2.5">
          {rebound && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
              <RotateCcw className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Triggered by a bounce — <b>{rebound.previousTechName || 'the previous assignee'}</b> returned this ticket
              {rebound.unassignedByName && rebound.unassignedByName !== rebound.previousTechName ? ` (unassigned by ${rebound.unassignedByName})` : ''}
              {rebound.unassignedAt ? ` on ${formatDayTime(rebound.unassignedAt)} · ${timeAgo(rebound.unassignedAt)}` : ''}.
              {Number(rebound.reboundCount) > 1 ? ` Return #${rebound.reboundCount} for this ticket.` : ''}
            </p>
          )}

          {run.errorMessage && (
            <p className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/70 dark:bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-700 dark:text-red-200">
              <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" /> {run.errorMessage}
            </p>
          )}

          {run.status === 'queued' && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
              <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Waiting for business hours{run.queuedReason ? ` — ${run.queuedReason}` : ''}.
            </p>
          )}

          {recs.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/75">Who the AI considered</p>
              <ul className="space-y-1.5">
                {recs.slice(0, 3).map((rec, idx) => {
                  const tech = techById.get(rec.techId);
                  const name = rec.techName || rec.name || tech?.name || `Technician ${rec.techId}`;
                  const score = typeof rec.score === 'number' ? Math.max(0, Math.min(1, rec.score)) : null;
                  const chosen = run.assignedTechId != null && rec.techId === run.assignedTechId;
                  return (
                    <li
                      key={`${run.id}-rec-${rec.techId ?? idx}`}
                      className={`rounded-lg border px-2.5 py-2 ${chosen ? 'border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-500/10 ring-1 ring-indigo-200 dark:ring-indigo-500/30' : 'border-border/60 bg-muted/30'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-4 flex-none text-center text-[10px] font-bold text-muted-foreground/75">{idx + 1}</span>
                        <PersonAvatar name={name} photoUrl={tech?.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{name}</span>
                        {chosen && (
                          <span className="flex-none rounded-md bg-indigo-100 dark:bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-700 dark:text-indigo-200">chosen</span>
                        )}
                        {score !== null && (
                          <span className="flex-none text-[11px] font-bold tabular-nums text-indigo-600 dark:text-indigo-300">{Math.round(score * 100)}%</span>
                        )}
                      </div>
                      {score !== null && (
                        <div className="ml-6 mt-1 h-1 rounded-full bg-secondary/70">
                          <div className="h-full rounded-full bg-indigo-400" style={{ width: `${Math.round(score * 100)}%` }} />
                        </div>
                      )}
                      {rec.reasoning && (
                        <p className="ml-6 mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-3" title={rec.reasoning}>{rec.reasoning}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {recs.length > 3 && (
                <p className="mt-1 text-[10px] text-muted-foreground/75">+{recs.length - 3} more considered — see the full run.</p>
              )}
            </div>
          )}

          {(run.steps || []).length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/75">Pipeline stages</p>
              <div className="flex flex-wrap items-center gap-1">
                {run.steps.map((step, i) => (
                  <span key={step.id} className="flex items-center gap-1">
                    {i > 0 && <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/50" aria-hidden="true" />}
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                        step.status === 'failed'
                          ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-200 dark:ring-red-500/30'
                          : step.status === 'skipped'
                            ? 'bg-muted text-muted-foreground/75 ring-border'
                            : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-emerald-200 dark:ring-emerald-500/30'
                      }`}
                      title={[step.errorMessage, step.tokensUsed ? `${step.tokensUsed} tokens` : null].filter(Boolean).join('\n') || undefined}
                    >
                      {step.status === 'failed' ? <X className="h-2.5 w-2.5" aria-hidden="true" /> : step.status === 'skipped' ? null : <Check className="h-2.5 w-2.5" aria-hidden="true" />}
                      {STEP_LABELS[step.stepName] || step.stepName}
                      {step.durationMs ? <span className="font-normal opacity-70">{fmtMs(step.durationMs)}</span> : null}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Fact label="Model">
              {run.llmProvider ? `${run.llmProvider}${run.llmModel ? ` · ${run.llmModel}` : ''}${run.llmFallbackUsed ? ' (fallback)' : ''}` : null}
            </Fact>
            <Fact label="Run time">{fmtMs(run.totalDurationMs)}</Fact>
            <Fact label="Tokens">{run.totalTokensUsed ? run.totalTokensUsed.toLocaleString() : null}</Fact>
            <Fact label="Attempts">{run.llmAttemptCount > 1 ? run.llmAttemptCount : null}</Fact>
            <Fact label="Decided by">{run.decidedByEmail}</Fact>
            <Fact label="Decided">{run.decidedAt ? new Date(run.decidedAt).toLocaleString() : null}</Fact>
          </dl>

          {(run.overrideReason || run.decisionNote) && (
            <p className="rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {run.overrideReason ? <><b>Override:</b> {run.overrideReason}</> : null}
              {run.overrideReason && run.decisionNote ? ' · ' : null}
              {run.decisionNote ? <><b>Note:</b> {run.decisionNote}</> : null}
            </p>
          )}

          {(run.corrections || []).map((c) => (
            <p key={c.id} className="rounded-lg border border-sky-200 dark:border-sky-500/30 bg-sky-50/70 dark:bg-sky-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-sky-800 dark:text-sky-200">
              <UserRound className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Corrected {c.fromTechnician?.name ? `from ${c.fromTechnician.name} ` : ''}to <b>{c.toTechnician?.name}</b>
              {c.createdByEmail ? ` by ${c.createdByEmail}` : ''} — {c.reason}
            </p>
          ))}

          <div className="flex flex-wrap items-center gap-1.5">
            <WritebackChip label="Assignment sync" status={run.syncStatus} error={run.syncError} at={run.syncedAt} />
            <WritebackChip label="Priority" status={run.priorityWritebackStatus} error={run.priorityWritebackError} at={run.priorityWrittenAt} />
            <WritebackChip label="Type" status={run.ticketTypeWritebackStatus} error={run.ticketTypeWritebackError} at={run.ticketTypeWrittenAt} />
            <Link
              to={`/assignments/history/${run.id}`}
              state={{ returnTo: returnTo || null }}
              className="tp-focus-ring ml-auto inline-flex items-center gap-1 rounded text-[11px] font-semibold text-indigo-600 dark:text-indigo-300 hover:underline"
            >
              <Bot className="h-3 w-3" aria-hidden="true" /> Full run in Assignment Review
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

const START_METHOD_META = {
  self_picked: { icon: Hand, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300', verb: 'picked it up themselves' },
  coordinator_assigned: { icon: UserRound, tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300', verb: 'was assigned' },
  workflow_assigned: { icon: Zap, tone: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300', verb: 'was assigned by automation' },
  unknown: { icon: UserRound, tone: 'bg-muted text-muted-foreground', verb: 'took ownership' },
};

const END_METHOD_META = {
  rejected: { icon: X, tone: 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-300', verb: 'returned it to the queue' },
  reassigned: { icon: RotateCcw, tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-600 dark:text-sky-300', verb: 'handed it off' },
  closed: { icon: Check, tone: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300', verb: 'closed it out' },
};

export default function TicketAiTab({ ticket, technicians = [], canReview = false }) {
  const [runs, setRuns] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const techById = useMemo(() => {
    const map = new Map();
    for (const t of technicians) map.set(t.id, t);
    return map;
  }, [technicians]);

  useEffect(() => {
    if (!canReview || !ticket?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    assignmentAPI.getTicketRuns(ticket.id)
      .then((res) => {
        if (cancelled) return;
        const data = res?.data || [];
        setRuns(data);
        // Newest run opens itself — it's usually why you're on this tab.
        if (data.length > 0) setExpandedId(data[0].id);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load AI runs'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [canReview, ticket?.id]);

  // ---- Ownership journey: episodes tell who held the ticket and how each
  // hold ended; group changes from the audit trail slot in between. ---------
  const journey = useMemo(() => {
    const nodes = [];
    if (ticket?.createdAt) {
      nodes.push({
        key: 'created',
        at: new Date(ticket.createdAt).getTime(),
        icon: Plus,
        tone: 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300',
        title: <span><b>Ticket created</b></span>,
        meta: null,
      });
    }
    for (const a of ticket?.activities || []) {
      if (a.activityType !== 'group_changed') continue;
      const d = a.details || {};
      nodes.push({
        key: `grp-${a.id}`,
        at: new Date(a.performedAt).getTime(),
        icon: Building2,
        tone: 'bg-sky-100 dark:bg-sky-500/20 text-sky-600 dark:text-sky-300',
        title: <span>Moved to another group{a.performedBy ? <span className="text-muted-foreground"> · {a.performedBy}</span> : null}</span>,
        meta: Array.isArray(d.to) ? `to ${d.to.join(', ')}` : null,
      });
    }
    const episodes = [...(ticket?.assignmentEpisodes || [])].sort(
      (a, b) => new Date(a.startedAt) - new Date(b.startedAt),
    );
    for (const ep of episodes) {
      const start = START_METHOD_META[ep.startMethod] || START_METHOD_META.unknown;
      const held = fmtHold(ep.startedAt, ep.endedAt);
      const active = !ep.endedAt || ep.endMethod === 'still_active';
      nodes.push({
        key: `ep-${ep.id}`,
        at: new Date(ep.startedAt).getTime(),
        icon: start.icon,
        tone: start.tone,
        title: (
          <span>
            <b>{ep.technician?.name || 'A technician'}</b>
            <span className="text-muted-foreground"> {start.verb}{ep.startAssignedByName && ep.startMethod === 'coordinator_assigned' ? ` by ${ep.startAssignedByName}` : ''}</span>
          </span>
        ),
        meta: active ? 'current owner' : held ? `held it for ${held}` : null,
        activeDot: active,
      });
      if (!active && ep.endMethod && END_METHOD_META[ep.endMethod]) {
        const end = END_METHOD_META[ep.endMethod];
        nodes.push({
          key: `ep-end-${ep.id}`,
          at: new Date(ep.endedAt).getTime(),
          icon: end.icon,
          tone: end.tone,
          title: (
            <span>
              <b>{ep.endMethod === 'rejected' && ep.endActorName ? ep.endActorName : ep.technician?.name || 'The owner'}</b>
              <span className="text-muted-foreground"> {end.verb}</span>
            </span>
          ),
          meta: ep.endActorName && ep.endMethod !== 'rejected' ? `by ${ep.endActorName}` : null,
        });
      }
    }
    // AI assignments that haven't materialized as an ownership episode yet —
    // the episode tracker can lag a fresh auto-assign (QA 07-08: a twice-
    // bounced ticket's final landing was invisible here). Runs whose assignee
    // and time match an episode are skipped so the story never doubles up.
    const episodeMarks = episodes.map((ep) => ({
      techId: ep.technicianId ?? ep.technician?.id ?? null,
      at: new Date(ep.startedAt).getTime(),
    }));
    for (const run of Array.isArray(runs) ? runs : []) {
      if (!run.assignedTechId) continue;
      if (!['auto_assigned', 'approved', 'modified'].includes(run.decision || '')) continue;
      const at = new Date(run.decidedAt || run.createdAt).getTime();
      const coveredByEpisode = episodeMarks.some(
        (m) => m.techId === run.assignedTechId && Math.abs(m.at - at) < 15 * 60000,
      );
      if (coveredByEpisode) continue;
      const name = run.assignedTech?.name || techById.get(run.assignedTechId)?.name || 'A technician';
      const isCurrent = ticket?.assignedTechId != null && ticket.assignedTechId === run.assignedTechId;
      const topScore = (() => {
        const recs = getRecommendationList(run.recommendation);
        return typeof recs[0]?.score === 'number' ? `top match ${Math.round(recs[0].score * 100)}%` : null;
      })();
      nodes.push({
        key: `run-assign-${run.id}`,
        at,
        icon: Bot,
        tone: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300',
        title: (
          <span>
            <b>{name}</b>
            <span className="text-muted-foreground"> was assigned by the AI{run.decision === 'auto_assigned' ? '' : ` (${String(run.decision).replace(/_/g, ' ')})`}</span>
          </span>
        ),
        meta: isCurrent ? `current owner${topScore ? ` · ${topScore}` : ''}` : topScore,
        activeDot: isCurrent,
      });
    }
    return nodes.sort((a, b) => a.at - b.at);
  }, [ticket?.createdAt, ticket?.activities, ticket?.assignmentEpisodes, ticket?.assignedTechId, runs, techById]);

  const returnCount = useMemo(
    () => (ticket?.assignmentEpisodes || []).filter((ep) => ep.endMethod === 'rejected').length,
    [ticket?.assignmentEpisodes],
  );

  const shownRuns = runs ?? (canReview ? [] : ticket?.pipelineRuns || []);

  return (
    <div className="space-y-4">
      {/* ---- Ownership & returns timeline ---- */}
      <section className="tp-card rounded-xl p-4" aria-label="Assignment journey">
        <div className="mb-3 flex items-center gap-2">
          <Hand className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
          <h2 className="text-sm font-bold text-foreground">Assignment journey</h2>
          {returnCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-500/15 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-300 ring-1 ring-red-200 dark:ring-red-500/30">
              <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
              {returnCount === 1 ? 'returned once' : `returned ${returnCount}×`}
            </span>
          )}
        </div>
        {journey.length <= 1 ? (
          <p className="text-sm text-muted-foreground/75">No ownership changes yet — nobody has taken this ticket.</p>
        ) : (
          <ol className="relative ml-3.5 space-y-3 border-l-2 border-border/60 pl-5">
            {journey.map((node) => {
              const Icon = node.icon;
              return (
                <li key={node.key} className="relative">
                  <span className={`absolute -left-[31px] top-0 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-card ${node.tone}`}>
                    <Icon className="h-3 w-3" aria-hidden="true" />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs text-foreground/85">{node.title}</span>
                    {node.meta && (
                      <span className={`text-[10px] font-semibold ${node.activeDot ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground/75'}`}>{node.meta}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/75" title={new Date(node.at).toLocaleString()}>
                    {formatDayTime(node.at)}
                    {' · '}{timeAgo(node.at)}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ---- AI runs ---- */}
      <section className="tp-card rounded-xl p-4" aria-label="AI runs">
        <div className="mb-3 flex items-center gap-2">
          <Cpu className="h-4 w-4 text-indigo-600 dark:text-indigo-300" aria-hidden="true" />
          <h2 className="text-sm font-bold text-foreground">AI runs</h2>
          {Array.isArray(runs) && runs.length > 0 && (
            <span className="rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30">{runs.length}</span>
          )}
        </div>

        {!canReview ? (
          <p className="text-sm leading-relaxed text-muted-foreground/75">
            AI run details are visible to workspace reviewers and admins.
            {(ticket?.pipelineRuns || []).length > 0 ? ` ${ticket.pipelineRuns.length} run${ticket.pipelineRuns.length === 1 ? ' has' : 's have'} touched this ticket.` : ''}
          </p>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground/75">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading runs…
          </p>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
        ) : shownRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground/75">
            The AI hasn&rsquo;t run on this ticket yet — runs appear here when the assignment pipeline analyzes it.
          </p>
        ) : (
          <div className="space-y-2">
            {shownRuns.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                techById={techById}
                expanded={expandedId === run.id}
                onToggle={() => setExpandedId((cur) => (cur === run.id ? null : run.id))}
                returnTo={ticket?.id ? `/tickets/${ticket.id}?tab=ai` : null}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
