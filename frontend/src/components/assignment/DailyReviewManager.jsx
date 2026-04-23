import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { useStreamingFetch } from '../../hooks/useStreamingFetch';
import { formatDateLocal, formatDateOnlyInTimezone, formatDateTimeInTimezone } from '../../utils/dateHelpers';
import {
  Loader2, Brain, CheckCircle, XCircle, History, RefreshCw, Play,
  CalendarDays, FileText, Settings2, Award, ChevronRight, StopCircle,
  ArrowLeft, ExternalLink,
} from 'lucide-react';

function StatusBadge({ status }) {
  const styles = {
    running: 'bg-blue-100 text-blue-800',
    collecting: 'bg-blue-100 text-blue-800',
    analyzing: 'bg-purple-100 text-purple-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-slate-100 text-slate-700',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-slate-100 text-slate-700'}`}>
      {status?.replace(/_/g, ' ')}
    </span>
  );
}

function MetricCard({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-50 border-slate-200 text-slate-800',
    green: 'bg-green-50 border-green-200 text-green-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
  };

  return (
    <div className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <div className="text-2xl font-bold">{value ?? 0}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

const RECOMMENDATION_STATUS_STYLES = {
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  approved: 'bg-green-100 text-green-700 border-green-200',
  rejected: 'bg-red-100 text-red-700 border-red-200',
  applied: 'bg-blue-100 text-blue-700 border-blue-200',
};

function RecommendationStatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${RECOMMENDATION_STATUS_STYLES[status] || RECOMMENDATION_STATUS_STYLES.pending}`}>
      {status || 'pending'}
    </span>
  );
}

function startOfWeekMondayLocal(date = new Date()) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function RecommendationCard({
  item,
  workspaceTimezone,
  onRecommendationAction,
  savingRecommendationId,
  showDate = false,
  showRunMeta = false,
  selectable = false,
  selected = false,
  onToggleSelected,
}) {
  const [notes, setNotes] = useState(item.reviewNotes || '');
  const isSaving = savingRecommendationId === item.id;

  useEffect(() => {
    setNotes(item.reviewNotes || '');
  }, [item.id, item.reviewNotes]);

  const supportTicketIds = Array.isArray(item.supportingFreshserviceTicketIds) && item.supportingFreshserviceTicketIds.length > 0
    ? item.supportingFreshserviceTicketIds
    : item.supportingTicketIds;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-start gap-2">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected?.(item.id)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <div className="text-sm font-semibold text-slate-800">{item.title}</div>
              <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full ${
                item.severity === 'high'
                  ? 'bg-red-100 text-red-700'
                  : item.severity === 'medium'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-blue-100 text-blue-700'
              }`}>
                {item.severity || 'low'}
              </span>
              <RecommendationStatusBadge status={item.status} />
            </div>
            {(showDate || showRunMeta) && (
              <div className="text-[11px] text-slate-500 mb-1">
                {showDate && <span>{formatDateOnlyInTimezone(item.reviewDate, workspaceTimezone)}</span>}
                {showDate && showRunMeta && <span> · </span>}
                {showRunMeta && <span>Run #{item.runId}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="text-xs text-slate-600 mb-2">{item.rationale}</div>
      <div className="text-xs text-slate-700 mb-2">
        <span className="font-medium">Suggested action:</span> {item.suggestedAction}
      </div>
      {Array.isArray(item.skillsAffected) && item.skillsAffected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.skillsAffected.map((skill) => (
            <span key={skill} className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
              {skill}
            </span>
          ))}
        </div>
      )}
      {Array.isArray(supportTicketIds) && supportTicketIds.length > 0 && (
        <div className="mb-2 text-[11px] text-slate-500">
          <span className="font-medium">Supporting tickets:</span> {supportTicketIds.map((ticketId) => `#${ticketId}`).join(', ')}
        </div>
      )}
      {(item.reviewedBy || item.appliedBy) && (
        <div className="mb-2 text-[11px] text-slate-500 space-y-1">
          {item.reviewedBy && (
            <div>
              Reviewed by {item.reviewedBy}
              {item.reviewedAt ? ` on ${formatDateTimeInTimezone(item.reviewedAt, workspaceTimezone)}` : ''}
            </div>
          )}
          {item.appliedBy && (
            <div>
              Applied by {item.appliedBy}
              {item.appliedAt ? ` on ${formatDateTimeInTimezone(item.appliedAt, workspaceTimezone)}` : ''}
            </div>
          )}
        </div>
      )}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional review notes"
        className="mb-3 min-h-[72px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
      />
      <div className="flex flex-wrap items-center gap-2">
        {item.status !== 'approved' && item.status !== 'applied' && (
          <button
            onClick={() => onRecommendationAction?.(item.id, 'approved', notes)}
            disabled={isSaving}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Approve
          </button>
        )}
        {item.status !== 'rejected' && item.status !== 'applied' && (
          <button
            onClick={() => onRecommendationAction?.(item.id, 'rejected', notes)}
            disabled={isSaving}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reject
          </button>
        )}
        {item.status === 'approved' && (
          <button
            onClick={() => onRecommendationAction?.(item.id, 'applied', notes)}
            disabled={isSaving}
            className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Mark Applied
          </button>
        )}
      </div>
    </div>
  );
}

function RecommendationSection({
  title,
  items,
  icon: Icon,
  emptyText,
  workspaceTimezone,
  onRecommendationAction,
  savingRecommendationId,
  showDate = false,
  showRunMeta = false,
  selectableIds = null,
  selectedIds = [],
  onToggleSelected,
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      </div>
      {Array.isArray(items) && items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) => (
            <RecommendationCard
              key={item.id || `${title}-${item.title}-${item.ordinal || 0}`}
              item={item}
              workspaceTimezone={workspaceTimezone}
              onRecommendationAction={onRecommendationAction}
              savingRecommendationId={savingRecommendationId}
              showDate={showDate}
              showRunMeta={showRunMeta}
              selectable={Array.isArray(selectableIds) ? selectableIds.includes(item.id) : false}
              selected={selectedIds.includes(item.id)}
              onToggleSelected={onToggleSelected}
            />
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-400">{emptyText}</div>
      )}
    </div>
  );
}

function CasesTable({ cases = [], workspaceTimezone }) {
  const displayCases = cases.slice(0, 20);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Key Cases</h3>
      {displayCases.length === 0 ? (
        <div className="text-sm text-slate-400">No cases available.</div>
      ) : (
        <div className="space-y-3">
          {displayCases.map((item) => (
            <div key={`${item.type}-${item.runId || item.ticketId}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-slate-800">#{item.freshserviceTicketId}</span>
                <span className="text-sm text-slate-700">{item.subject}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  item.outcome === 'success'
                    ? 'bg-green-100 text-green-700'
                    : item.outcome === 'partial_success'
                      ? 'bg-blue-100 text-blue-700'
                      : item.outcome === 'failure'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-slate-100 text-slate-700'
                }`}>
                  {item.outcome.replace(/_/g, ' ')}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white border border-slate-200 text-[10px] font-medium text-slate-600">
                  {item.primaryTag.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="text-xs text-slate-500 mb-2">
                {item.category || 'Uncategorized'} · {item.status} · {formatDateTimeInTimezone(item.ticketCreatedAt, workspaceTimezone)}
              </div>
              <div className="text-xs text-slate-700 space-y-1">
                {item.topRecommendation?.techName && (
                  <div><span className="font-medium">Top recommendation:</span> {item.topRecommendation.techName}</div>
                )}
                {item.finalAssignee?.name && (
                  <div><span className="font-medium">Final assignee:</span> {item.finalAssignee.name}</div>
                )}
                {item.overrideReason && (
                  <div><span className="font-medium">Override:</span> {item.overrideReason}</div>
                )}
                {item.decisionNote && (
                  <div><span className="font-medium">Decision note:</span> {item.decisionNote}</div>
                )}
                {item.threadExcerpts?.length > 0 && (
                  <div>
                    <span className="font-medium">Thread excerpts:</span>
                    <div className="mt-1 space-y-1">
                      {item.threadExcerpts.slice(0, 3).map((excerpt) => (
                        <div key={excerpt.id} className="text-slate-600">
                          {excerpt.actorName ? `${excerpt.actorName}: ` : ''}{excerpt.excerpt}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunDetail({ run, workspaceTimezone, onRecommendationAction, savingRecommendationId }) {
  const summary = run.summaryMetrics || {};
  const totals = summary.totals || {};
  const rates = summary.rates || {};
  const promptRecommendations = run.promptRecommendations || [];
  const processRecommendations = run.processRecommendations || [];
  const skillRecommendations = run.skillRecommendations || [];
  const warnings = run.warnings || [];
  const cases = run.evidenceCases || [];
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold text-slate-800">Daily Review #{run.id}</h2>
              <StatusBadge status={run.status} />
            </div>
            <div className="text-sm text-slate-500">
              {summary.workspaceName || 'Workspace'} · {formatDateOnlyInTimezone(run.reviewDate, workspaceTimezone)} · {summary.reviewWindow?.startTime || '00:00'}-{summary.reviewWindow?.endTime || '23:59'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => navigate('/assignments/prompts')} className="inline-flex items-center gap-1 px-3 py-2 border border-slate-200 rounded-lg text-sm hover:bg-slate-50">
              <FileText className="w-4 h-4" /> Open Prompts
            </button>
            <button onClick={() => navigate('/assignments/competencies')} className="inline-flex items-center gap-1 px-3 py-2 border border-slate-200 rounded-lg text-sm hover:bg-slate-50">
              <Award className="w-4 h-4" /> Open Competencies
            </button>
          </div>
        </div>
        {summary.executiveSummary && (
          <div className="mt-4 rounded-lg bg-indigo-50 border border-indigo-200 p-3 text-sm text-indigo-900">
            {summary.executiveSummary}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mt-3 space-y-1">
            {warnings.map((warning, index) => (
              <div key={index} className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {warning}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Tickets Reviewed" value={totals.totalTicketsReviewed} />
        <MetricCard label="Success" value={`${totals.success || 0} (${rates.successRate || 0}%)`} tone="green" />
        <MetricCard label="Partial Success" value={`${totals.partialSuccess || 0} (${rates.partialSuccessRate || 0}%)`} tone="blue" />
        <MetricCard label="Failure" value={`${totals.failure || 0} (${rates.failureRate || 0}%)`} tone="red" />
        <MetricCard label="Unresolved" value={totals.unresolved || 0} tone="amber" />
        <MetricCard label="Tickets With Rebounds" value={totals.rebounds || 0} tone="amber" />
        <MetricCard label="Handled In FS" value={totals.handledInFreshService || 0} tone="blue" />
        <MetricCard label="Pipeline Bypass" value={totals.bypassedTickets || 0} tone="red" />
      </div>
      {summary.definitions?.rebounds && (
        <div className="text-xs text-slate-500">
          Rebound metric: {summary.definitions.rebounds}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <RecommendationSection
          title="Prompt Recommendations"
          items={promptRecommendations}
          icon={FileText}
          emptyText="No prompt changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
        />
        <RecommendationSection
          title="Process Recommendations"
          items={processRecommendations}
          icon={Settings2}
          emptyText="No process changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
        />
        <RecommendationSection
          title="Skill Matrix Recommendations"
          items={skillRecommendations}
          icon={Award}
          emptyText="No skill matrix changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Top Categories</h3>
          {summary.topCategories?.length ? (
            <div className="space-y-2">
              {summary.topCategories.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{item.name}</span>
                  <span className="font-semibold text-slate-900">{item.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-400">No category mismatches detected.</div>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Top Technicians Involved</h3>
          {summary.topTechnicians?.length ? (
            <div className="space-y-2">
              {summary.topTechnicians.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{item.name}</span>
                  <span className="font-semibold text-slate-900">{item.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-400">No technician mismatch clusters detected.</div>
          )}
        </div>
      </div>

      <CasesTable cases={cases} workspaceTimezone={workspaceTimezone} />
    </div>
  );
}

const LIVE_STAT_LABELS = {
  pipelineRuns: 'Pipeline Runs',
  bypassedTickets: 'Bypassed',
  candidateTickets: 'Candidate Tickets',
  ticketsNeedingThreadHydration: 'Threads Needed',
  threadHydrationProcessed: 'Threads Checked',
  threadsHydrated: 'Threads Hydrated',
  threadHydrationFailures: 'Thread Warnings',
  episodes: 'Episodes',
  assignmentActions: 'Assignments',
  threadEntries: 'Thread Entries',
  totalCases: 'Cases Built',
  totalTicketsReviewed: 'Reviewed',
  success: 'Success',
  failure: 'Failure',
  unresolved: 'Unresolved',
};

function LiveDailyReviewView({ reviewDate, onComplete }) {
  const [phase, setPhase] = useState(null);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [runId, setRunId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [counts, setCounts] = useState({ prompt: 0, process: 0, skill: 0 });
  const [executiveSummary, setExecutiveSummary] = useState('');
  const [progressPct, setProgressPct] = useState(2);
  const [liveStats, setLiveStats] = useState({});
  const [activityLog, setActivityLog] = useState([]);
  const [isCancelling, setIsCancelling] = useState(false);

  const appendActivity = useCallback((message, eventPhase = 'update') => {
    if (!message) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phase: eventPhase,
      message,
      timeLabel: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };
    setActivityLog((prev) => [entry, ...prev].slice(0, 8));
  }, []);

  const handleEvent = useCallback((event, controls) => {
    switch (event.type) {
    case 'daily_review_started':
      setRunId(event.runId);
      appendActivity(`Started daily review for ${event.workspaceName || 'workspace'} on ${event.reviewDate}.`, 'started');
      break;
    case 'phase_update':
      setPhase(event.phase);
      setPhaseMessage(event.message);
      if (typeof event.percent === 'number') setProgressPct(event.percent);
      if (event.stats && typeof event.stats === 'object') {
        setLiveStats((prev) => ({ ...prev, ...event.stats }));
      }
      appendActivity(event.message, event.phase);
      if (event.phase === 'cancelled') {
        setIsCancelling(false);
        controls.setStatus('cancelled');
        controls.stopTimer();
      }
      if (event.phase === 'completed') {
        controls.setStatus('completed');
        controls.stopTimer();
      }
      break;
    case 'dataset_collected':
      setSummary(event.totals || null);
      if (event.totals && typeof event.totals === 'object') {
        setLiveStats((prev) => ({ ...prev, ...event.totals }));
      }
      appendActivity(`Collected dataset for ${event.totals?.totalTicketsReviewed || 0} ticket(s).`, 'dataset');
      break;
    case 'recommendations_ready':
      setCounts({
        prompt: event.promptCount || 0,
        process: event.processCount || 0,
        skill: event.skillCount || 0,
      });
      setExecutiveSummary(event.executiveSummary || '');
      appendActivity(
        `Recommendations ready: ${event.promptCount || 0} prompt, ${event.processCount || 0} process, ${event.skillCount || 0} skill.`,
        'recommendations',
      );
      break;
    case 'cancelled':
      setIsCancelling(false);
      setPhase('cancelled');
      setPhaseMessage(event.message || 'Daily review cancelled.');
      controls.setStatus('cancelled');
      controls.stopTimer();
      appendActivity(event.message || 'Daily review cancelled.', 'cancelled');
      break;
    case 'daily_review_complete':
      setRunId(event.runId);
      appendActivity(`Run #${event.runId} finished.`, 'completed');
      break;
    case 'error':
      setIsCancelling(false);
      controls.setError(event.message);
      appendActivity(event.message, 'error');
      break;
    default:
      break;
    }
  }, [appendActivity]);

  const { status, elapsedSec, error } = useStreamingFetch({
    url: assignmentAPI.runDailyReviewStreamPath(),
    body: { reviewDate, force: true },
    onEvent: handleEvent,
    deps: [reviewDate],
  });

  const visibleLiveStats = Object.entries(LIVE_STAT_LABELS)
    .filter(([key]) => liveStats[key] != null)
    .map(([key, label]) => ({ key, label, value: liveStats[key] }))
    .slice(0, 8);

  const cancelRun = async () => {
    if (!runId || isCancelling) return;
    setIsCancelling(true);
    setPhaseMessage('Cancellation requested...');
    appendActivity(`Cancellation requested for run #${runId}.`, 'cancel_requested');
    try {
      await assignmentAPI.cancelDailyReviewRun(runId);
    } catch (cancelError) {
      setIsCancelling(false);
      const message = cancelError?.message || 'Failed to cancel daily review run.';
      setPhaseMessage(message);
      appendActivity(message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status === 'running' ? (
            <Brain className="w-5 h-5 text-purple-600 animate-spin" />
          ) : status === 'cancelled' ? (
            <StopCircle className="w-5 h-5 text-amber-600" />
          ) : status === 'completed' ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600" />
          )}
          <span className={`text-sm font-semibold ${
            status === 'completed'
              ? 'text-green-700'
              : status === 'cancelled'
                ? 'text-amber-700'
                : status === 'error'
                  ? 'text-red-700'
                  : 'text-purple-700'
          }`}>
            {status === 'running'
              ? `Running daily review... (${elapsedSec}s)`
              : status === 'cancelled'
                ? `Daily review cancelled (${elapsedSec}s)`
                : status === 'completed'
                  ? `Daily review complete (${elapsedSec}s)`
                  : 'Daily review failed'}
          </span>
          {runId && <span className="text-xs text-slate-400">Run #{runId}</span>}
        </div>
        <div className="flex items-center gap-3">
          {(status === 'running' || status === 'connecting') && runId && (
            <button
              onClick={cancelRun}
              disabled={isCancelling}
              className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <StopCircle className="w-4 h-4" />
              {isCancelling ? 'Cancelling...' : 'Cancel Run'}
            </button>
          )}
          {status === 'completed' && (
            <button onClick={() => onComplete(runId)} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              View Results
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-sm font-semibold text-slate-800">{phase ? phase.replace(/_/g, ' ') : 'Starting'}</div>
          <div className="text-xs font-medium text-slate-500">{Math.max(progressPct || 0, 2)}%</div>
        </div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-purple-600 transition-all duration-500"
            style={{ width: `${Math.max(progressPct || 0, 2)}%` }}
          />
        </div>
        <div className="text-sm text-slate-600">{phaseMessage || 'Preparing review run...'}</div>
        {status === 'running' && phase === 'collecting' && (
          <div className="mt-2 text-xs text-slate-500">
            Collection can take a bit if the review has to fetch missing thread history from FreshService.
          </div>
        )}
      </div>

      {visibleLiveStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {visibleLiveStats.map((item) => (
            <MetricCard key={item.key} label={item.label} value={item.value} tone="slate" />
          ))}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Tickets Reviewed" value={summary.totalTicketsReviewed || 0} />
          <MetricCard label="Success" value={summary.success || 0} tone="green" />
          <MetricCard label="Failure" value={summary.failure || 0} tone="red" />
          <MetricCard label="Tickets With Rebounds" value={summary.rebounds || 0} tone="amber" />
        </div>
      )}

      {(counts.prompt > 0 || counts.process > 0 || counts.skill > 0) && (
        <div className="grid grid-cols-3 gap-3">
          <MetricCard label="Prompt Recs" value={counts.prompt} tone="blue" />
          <MetricCard label="Process Recs" value={counts.process} tone="amber" />
          <MetricCard label="Skill Recs" value={counts.skill} tone="green" />
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-800 mb-3">Live Activity</div>
        {activityLog.length === 0 ? (
          <div className="text-sm text-slate-400">Waiting for the first progress update...</div>
        ) : (
          <div className="space-y-2">
            {activityLog.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-slate-700">{item.phase.replace(/_/g, ' ')}</div>
                  <div className="text-sm text-slate-600">{item.message}</div>
                </div>
                <div className="text-[11px] text-slate-400 whitespace-nowrap">{item.timeLabel}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {executiveSummary && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
          {executiveSummary}
        </div>
      )}

      {(error || status === 'error') && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error || 'Daily review failed'}
        </div>
      )}
    </div>
  );
}

const ACTIVE_STATUSES = ['running', 'collecting', 'analyzing'];

export default function DailyReviewManager({ workspaceTimezone }) {
  const [view, setView] = useState('trigger');
  const [reviewDate, setReviewDate] = useState(formatDateLocal(new Date()));
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingRecommendationId, setSavingRecommendationId] = useState(null);
  const [backlogItems, setBacklogItems] = useState([]);
  const [backlogTotal, setBacklogTotal] = useState(0);
  const [loadingBacklog, setLoadingBacklog] = useState(false);
  const [backlogStatus, setBacklogStatus] = useState('pending');
  const [backlogKind, setBacklogKind] = useState('all');
  const [backlogStartDate, setBacklogStartDate] = useState('');
  const [backlogEndDate, setBacklogEndDate] = useState('');
  const [backlogRunFilter, setBacklogRunFilter] = useState('');
  const [weeklyWeekStart, setWeeklyWeekStart] = useState(formatDateLocal(startOfWeekMondayLocal(new Date())));
  const [weeklyKind, setWeeklyKind] = useState('all');
  const [weeklyRollup, setWeeklyRollup] = useState(null);
  const [loadingWeeklyRollup, setLoadingWeeklyRollup] = useState(false);
  const [selectedWeeklyIds, setSelectedWeeklyIds] = useState([]);
  const [bulkApplying, setBulkApplying] = useState(false);
  const navigate = useNavigate();

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await assignmentAPI.getDailyReviewRuns({ limit: 20 });
      const items = res?.items || [];
      setRuns(items);
      setActiveRun(items.find((item) => ACTIVE_STATUSES.includes(item.status)) || null);
    } catch {
      setRuns([]);
      setActiveRun(null);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  useEffect(() => {
    if (!activeRun || view === 'live') return;
    const timer = setInterval(loadRuns, 10000);
    return () => clearInterval(timer);
  }, [activeRun, view, loadRuns]);

  const loadBacklog = useCallback(async () => {
    setLoadingBacklog(true);
    try {
      // Accept the dropdown label "Run #12 — Apr 21, 2026", a bare "Run #12",
      // "#12", "run 12", or just "12". We pull the id from the `#N` token
      // when it's there (so the trailing date in the dropdown label doesn't
      // get mashed into the id), and fall back to the leading number for
      // free-form typing like "12". Empty input clears the filter.
      const trimmed = backlogRunFilter.trim();
      let runIdParam = '';
      if (trimmed) {
        const hashMatch = trimmed.match(/#\s*(\d+)/);
        const leadingMatch = trimmed.match(/(\d+)/);
        runIdParam = hashMatch ? hashMatch[1] : leadingMatch ? leadingMatch[1] : '';
      }
      const res = await assignmentAPI.getDailyReviewRecommendations({
        limit: 100,
        status: backlogStatus,
        kind: backlogKind,
        ...(backlogStartDate ? { startDate: backlogStartDate } : {}),
        ...(backlogEndDate ? { endDate: backlogEndDate } : {}),
        ...(runIdParam ? { runId: runIdParam } : {}),
      });
      setBacklogItems(res?.items || []);
      setBacklogTotal(res?.total || 0);
    } catch {
      setBacklogItems([]);
      setBacklogTotal(0);
    } finally {
      setLoadingBacklog(false);
    }
  }, [backlogEndDate, backlogKind, backlogRunFilter, backlogStartDate, backlogStatus]);

  const loadWeeklyRollup = useCallback(async () => {
    setLoadingWeeklyRollup(true);
    try {
      const res = await assignmentAPI.getDailyReviewWeeklyRollup({
        weekStart: weeklyWeekStart,
        status: 'approved',
        kind: weeklyKind,
      });
      setWeeklyRollup(res?.data || null);
    } catch {
      setWeeklyRollup(null);
    } finally {
      setLoadingWeeklyRollup(false);
    }
  }, [weeklyKind, weeklyWeekStart]);

  useEffect(() => { loadBacklog(); }, [loadBacklog]);
  useEffect(() => { loadWeeklyRollup(); }, [loadWeeklyRollup]);

  useEffect(() => {
    const validIds = new Set(
      (weeklyRollup?.days || []).flatMap((day) => [
        ...(day.promptRecommendations || []).map((item) => item.id),
        ...(day.processRecommendations || []).map((item) => item.id),
        ...(day.skillRecommendations || []).map((item) => item.id),
      ]),
    );
    setSelectedWeeklyIds((prev) => prev.filter((id) => validIds.has(id)));
  }, [weeklyRollup]);

  const loadRunDetail = async (id, { openView = true } = {}) => {
    setLoadingDetail(true);
    try {
      const res = await assignmentAPI.getDailyReviewRun(id);
      setSelectedRun(res?.data || null);
      if (openView) setView('detail');
    } catch {
      setSelectedRun(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleRecommendationAction = async (recommendationId, status, reviewNotes) => {
    setSavingRecommendationId(recommendationId);
    try {
      await assignmentAPI.updateDailyReviewRecommendationStatus(recommendationId, { status, reviewNotes });
      await Promise.all([loadRuns(), loadBacklog(), loadWeeklyRollup()]);
      if (selectedRun?.id && view === 'detail') {
        await loadRunDetail(selectedRun.id, { openView: false });
      }
    } catch {
      /* ignore */
    } finally {
      setSavingRecommendationId(null);
    }
  };

  const handleBulkApply = async () => {
    if (selectedWeeklyIds.length === 0) return;
    setBulkApplying(true);
    try {
      await assignmentAPI.bulkUpdateDailyReviewRecommendationStatus({
        ids: selectedWeeklyIds,
        status: 'applied',
      });
      setSelectedWeeklyIds([]);
      await Promise.all([loadRuns(), loadBacklog(), loadWeeklyRollup()]);
      if (selectedRun?.id && view === 'detail') {
        await loadRunDetail(selectedRun.id, { openView: false });
      }
    } catch {
      /* ignore */
    } finally {
      setBulkApplying(false);
    }
  };

  const toggleWeeklySelection = (id) => {
    setSelectedWeeklyIds((prev) => (
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    ));
  };

  const cancelRun = async (e, id) => {
    e.stopPropagation();
    try {
      await assignmentAPI.cancelDailyReviewRun(id);
      loadRuns();
    } catch {
      /* ignore */
    }
  };

  if (view === 'live') {
    return (
      <div>
        <button onClick={() => { setView('trigger'); loadRuns(); }} className="text-sm text-blue-600 hover:text-blue-800 mb-3 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Daily Review
        </button>
        <LiveDailyReviewView reviewDate={reviewDate} onComplete={async (runId) => {
          loadRuns();
          if (runId) await loadRunDetail(runId);
        }} />
      </div>
    );
  }

  if (view === 'detail' && selectedRun) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => { setSelectedRun(null); setView('trigger'); }} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> Back to Daily Review
          </button>
          <button
            onClick={() => navigate('/assignments/history')}
            className="text-sm text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
          >
            Review Assignment History <ExternalLink className="w-4 h-4" />
          </button>
        </div>
        <RunDetail
          run={selectedRun}
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={handleRecommendationAction}
          savingRecommendationId={savingRecommendationId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-indigo-600" />
          Daily Review
        </h3>
        <p className="text-sm text-slate-500 mb-4">
          Review one business day of assignment outcomes and generate prompt, process, and skill-matrix recommendations.
        </p>

        {activeRun && (
          <div className="mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Brain className="w-5 h-5 text-indigo-600 animate-spin" />
              <div>
                <div className="text-sm font-semibold text-indigo-800">
                  Run #{activeRun.id} in progress
                </div>
                <div className="text-xs text-indigo-500">
                  {formatDateOnlyInTimezone(activeRun.reviewDate, workspaceTimezone)} · {activeRun.status.replace(/_/g, ' ')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => loadRunDetail(activeRun.id)} className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors">
                View Progress
              </button>
              <button onClick={(e) => cancelRun(e, activeRun.id)} className="text-xs px-3 py-1.5 text-red-600 border border-red-200 rounded-lg font-medium hover:bg-red-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-4">
          <div className="flex flex-wrap items-end gap-3 mb-3">
            <div>
              <label className="block text-xs text-slate-600 font-medium mb-1">Review Date</label>
              <input
                type="date"
                value={reviewDate}
                onChange={(e) => setReviewDate(e.target.value)}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={() => setReviewDate(formatDateLocal(new Date()))}
              className="text-xs px-2.5 py-2 bg-white border border-indigo-200 rounded-lg text-indigo-700 hover:bg-indigo-100 transition-colors font-medium"
            >
              Today
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setView('live')}
              disabled={!reviewDate}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-semibold hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all"
            >
              <Play className="w-4 h-4" />
              Run Daily Review
            </button>
            <button
              onClick={loadRuns}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-50 shadow-sm transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh History
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
            <History className="w-4 h-4 text-slate-500" />
            Review History
          </h3>
          <button onClick={loadRuns} className="text-xs text-blue-600 hover:text-blue-800">
            Refresh
          </button>
        </div>

        {loadingRuns ? (
          <div className="flex items-center justify-center py-8 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : runs.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            No daily review runs yet. Start one above.
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => {
              const totals = run.summaryMetrics?.totals || {};
              return (
                <button
                  key={run.id}
                  onClick={() => loadRunDetail(run.id)}
                  disabled={loadingDetail}
                  className="w-full text-left bg-white border border-slate-200 rounded-lg px-4 py-3 hover:border-indigo-300 hover:shadow-sm transition-all group"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-sm font-semibold text-slate-800">Run #{run.id}</div>
                      <StatusBadge status={run.status} />
                      <span className="text-xs text-slate-500">
                        {formatDateOnlyInTimezone(run.reviewDate, workspaceTimezone)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      {totals.totalTicketsReviewed != null && <span>{totals.totalTicketsReviewed} tickets</span>}
                      {totals.success != null && <span className="text-green-600">{totals.success} success</span>}
                      {totals.failure != null && <span className="text-red-600">{totals.failure} failure</span>}
                      {ACTIVE_STATUSES.includes(run.status) && (
                        <button
                          onClick={(e) => cancelRun(e, run.id)}
                          className="flex items-center gap-1 px-2 py-1 text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Cancel this run"
                        >
                          <StopCircle className="w-3.5 h-3.5" /> Cancel
                        </button>
                      )}
                      <ChevronRight className="w-4 h-4 group-hover:text-indigo-500 transition-colors" />
                    </div>
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}
                    {run.triggeredBy ? ` by ${run.triggeredBy}` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-800">Recommendation Backlog</h3>
              <p className="text-sm text-slate-500">
                Review persisted recommendation items across runs and move them through pending, approved, rejected, and applied.
              </p>
            </div>
            <button onClick={loadBacklog} className="text-xs text-blue-600 hover:text-blue-800">
              Refresh
            </button>
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Status</label>
              <select
                value={backlogStatus}
                onChange={(e) => setBacklogStatus(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="applied">Applied</option>
                <option value="all">All</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Kind</label>
              <select
                value={backlogKind}
                onChange={(e) => setBacklogKind(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="prompt">Prompt</option>
                <option value="process">Process</option>
                <option value="skill">Skill</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Start Date</label>
              <input
                type="date"
                value={backlogStartDate}
                onChange={(e) => setBacklogStartDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">End Date</label>
              <input
                type="date"
                value={backlogEndDate}
                onChange={(e) => setBacklogEndDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Run</label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  list="daily-review-run-options"
                  value={backlogRunFilter}
                  onChange={(e) => setBacklogRunFilter(e.target.value)}
                  placeholder="All runs"
                  className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <datalist id="daily-review-run-options">
                  {runs.map((run) => {
                    const dateLabel = formatDateOnlyInTimezone(run.reviewDate, workspaceTimezone);
                    return (
                      <option
                        key={run.id}
                        value={`Run #${run.id} — ${dateLabel}`}
                      />
                    );
                  })}
                </datalist>
                {backlogRunFilter && (
                  <button
                    type="button"
                    onClick={() => setBacklogRunFilter('')}
                    className="rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-500 hover:bg-slate-50"
                    title="Show all runs"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="mb-3 text-xs text-slate-500">{backlogTotal} item(s) matched the current filters.</div>

          {loadingBacklog ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading backlog...
            </div>
          ) : backlogItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
              No recommendation items matched the current backlog filters.
            </div>
          ) : (
            <div className="space-y-3">
              {backlogItems.map((item) => (
                <RecommendationCard
                  key={item.id}
                  item={item}
                  workspaceTimezone={workspaceTimezone}
                  onRecommendationAction={handleRecommendationAction}
                  savingRecommendationId={savingRecommendationId}
                  showDate
                  showRunMeta
                />
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-800">Weekly Approved Rollup</h3>
              <p className="text-sm text-slate-500">
                Group approved items by week so prompt, process, and skill updates can be reviewed together and then marked applied.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleBulkApply}
                disabled={selectedWeeklyIds.length === 0 || bulkApplying}
                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {bulkApplying ? 'Applying...' : `Mark Selected Applied (${selectedWeeklyIds.length})`}
              </button>
              <button onClick={loadWeeklyRollup} className="text-xs text-blue-600 hover:text-blue-800">
                Refresh
              </button>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Week Start</label>
              <input
                type="date"
                value={weeklyWeekStart}
                onChange={(e) => setWeeklyWeekStart(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Kind</label>
              <select
                value={weeklyKind}
                onChange={(e) => setWeeklyKind(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="prompt">Prompt</option>
                <option value="process">Process</option>
                <option value="skill">Skill</option>
              </select>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-3 gap-3">
            <MetricCard label="Prompt" value={weeklyRollup?.countsByKind?.prompt || 0} tone="blue" />
            <MetricCard label="Process" value={weeklyRollup?.countsByKind?.process || 0} tone="amber" />
            <MetricCard label="Skill" value={weeklyRollup?.countsByKind?.skill || 0} tone="green" />
          </div>

          {loadingWeeklyRollup ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading weekly rollup...
            </div>
          ) : !weeklyRollup?.days?.length ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
              No approved recommendations for this week yet.
            </div>
          ) : (
            <div className="space-y-4">
              {weeklyRollup.days.map((day) => {
                const selectableIds = [
                  ...(day.promptRecommendations || []).filter((item) => item.status === 'approved').map((item) => item.id),
                  ...(day.processRecommendations || []).filter((item) => item.status === 'approved').map((item) => item.id),
                  ...(day.skillRecommendations || []).filter((item) => item.status === 'approved').map((item) => item.id),
                ];
                return (
                  <div key={day.reviewDate} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          {formatDateOnlyInTimezone(day.reviewDate, workspaceTimezone)}
                        </div>
                        <div className="text-xs text-slate-500">{day.total} approved item(s)</div>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <RecommendationSection
                        title="Prompt"
                        items={day.promptRecommendations}
                        icon={FileText}
                        emptyText="No prompt items approved for this day."
                        workspaceTimezone={workspaceTimezone}
                        onRecommendationAction={handleRecommendationAction}
                        savingRecommendationId={savingRecommendationId}
                        showRunMeta
                        selectableIds={selectableIds}
                        selectedIds={selectedWeeklyIds}
                        onToggleSelected={toggleWeeklySelection}
                      />
                      <RecommendationSection
                        title="Process"
                        items={day.processRecommendations}
                        icon={Settings2}
                        emptyText="No process items approved for this day."
                        workspaceTimezone={workspaceTimezone}
                        onRecommendationAction={handleRecommendationAction}
                        savingRecommendationId={savingRecommendationId}
                        showRunMeta
                        selectableIds={selectableIds}
                        selectedIds={selectedWeeklyIds}
                        onToggleSelected={toggleWeeklySelection}
                      />
                      <RecommendationSection
                        title="Skill"
                        items={day.skillRecommendations}
                        icon={Award}
                        emptyText="No skill items approved for this day."
                        workspaceTimezone={workspaceTimezone}
                        onRecommendationAction={handleRecommendationAction}
                        savingRecommendationId={savingRecommendationId}
                        showRunMeta
                        selectableIds={selectableIds}
                        selectedIds={selectedWeeklyIds}
                        onToggleSelected={toggleWeeklySelection}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
