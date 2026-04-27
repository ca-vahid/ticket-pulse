import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { formatDateLocal, formatDateOnlyInTimezone, formatDateTimeInTimezone } from '../../utils/dateHelpers';
import {
  Loader2, Brain, CheckCircle, XCircle, History, RefreshCw, Play,
  CalendarDays, FileText, Settings2, Award, ChevronRight, StopCircle,
  ArrowLeft, ExternalLink, Sparkles, Copy, ThumbsUp, AlertTriangle,
  Eye, MessageCircle, TrendingUp, ChevronUp, ChevronDown, Undo2, Trash2,
  Tags,
} from 'lucide-react';

function StatusBadge({ status }) {
  const styles = {
    running: 'bg-blue-100 text-blue-800',
    collecting: 'bg-blue-100 text-blue-800',
    analyzing: 'bg-purple-100 text-purple-800',
    saving: 'bg-purple-100 text-purple-800',
    completed: 'bg-green-100 text-green-800',
    applied: 'bg-blue-100 text-blue-800',
    partially_applied: 'bg-amber-100 text-amber-800',
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
  skipped: 'bg-amber-100 text-amber-700 border-amber-200',
  documented: 'bg-purple-100 text-purple-700 border-purple-200',
};

const PROFICIENCY_LEVELS = [
  { value: 'basic', label: 'Basic', num: '1', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { value: 'intermediate', label: 'Intermediate', num: '2', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'expert', label: 'Expert', num: '3', color: 'bg-green-100 text-green-800 border-green-200' },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatReviewRunDateLabel(run, workspaceTimezone) {
  if (!run) return '';
  const summaryWindow = run.summaryMetrics?.reviewWindow;
  const startDate = run.summaryMetrics?.reviewStartDate
    || summaryWindow?.localDate
    || run.reviewDate;
  const endDate = run.summaryMetrics?.reviewEndDate
    || summaryWindow?.endLocalDate
    || null;
  const startLabel = formatDateOnlyInTimezone(startDate, workspaceTimezone);
  if (!endDate || String(endDate).slice(0, 10) === String(startDate).slice(0, 10)) {
    return startLabel;
  }
  return `${startLabel} - ${formatDateOnlyInTimezone(endDate, workspaceTimezone)}`;
}

function SmoothCollapse({ open, children, className = '' }) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      } ${className}`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function getRecommendationMotionClass(state) {
  if (state === 'leaving') {
    return 'pointer-events-none -translate-x-2 scale-[0.985] opacity-0';
  }
  if (state === 'entering') {
    return 'translate-x-0 scale-100 opacity-100 ring-2 ring-emerald-200';
  }
  return 'translate-x-0 scale-100 opacity-100';
}

function RecommendationStatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${RECOMMENDATION_STATUS_STYLES[status] || RECOMMENDATION_STATUS_STYLES.pending}`}>
      {status || 'pending'}
    </span>
  );
}

function isDevBacklogItem(item) {
  if (item?.kind !== 'process') return false;
  const text = [
    item.title,
    item.rationale,
    item.suggestedAction,
    ...(Array.isArray(item.skillsAffected) ? item.skillsAffected : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(dev|developer|engineering|implementation|implement|code|backend|frontend|schema|database|api|ui|ux|bug|pipeline|tooling|telemetry|integration|automation)\b/.test(text)
    || text.includes('dev_required')
    || text.includes('app-side')
    || text.includes('requires dev');
}

function getTaxonomyProposal(item = {}) {
  const taxonomy = item.metadata?.taxonomy || {};
  if (
    item.kind !== 'taxonomy'
    && !item.taxonomyAction
    && !taxonomy.taxonomyAction
    && !taxonomy.categoryName
    && !taxonomy.parentCategoryName
    && !taxonomy.newName
  ) {
    return null;
  }
  return {
    action: item.taxonomyAction || taxonomy.taxonomyAction || 'review',
    categoryName: item.categoryName || taxonomy.categoryName || null,
    parentCategoryName: item.parentCategoryName || taxonomy.parentCategoryName || null,
    newName: item.newName || taxonomy.newName || null,
    source: taxonomy.source || null,
    issue: taxonomy.issue || null,
    categoryFit: taxonomy.categoryFit || null,
    subcategoryFit: taxonomy.subcategoryFit || null,
    evidenceRunIds: Array.isArray(taxonomy.evidenceRunIds) ? taxonomy.evidenceRunIds : [],
  };
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
  readOnly = false,
  compact = false,
}) {
  const [notes, setNotes] = useState(item.reviewNotes || '');
  const [expanded, setExpanded] = useState(!compact);
  const isSaving = savingRecommendationId === item.id;
  const taxonomyProposal = getTaxonomyProposal(item);

  useEffect(() => {
    setNotes(item.reviewNotes || '');
  }, [item.id, item.reviewNotes]);

  const supportTicketIds = Array.isArray(item.supportingFreshserviceTicketIds) && item.supportingFreshserviceTicketIds.length > 0
    ? item.supportingFreshserviceTicketIds
    : item.supportingTicketIds;

  const actionButtons = !readOnly && (
    <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
      {item.status !== 'approved' && item.status !== 'applied' && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onRecommendationAction?.(item.id, 'approved', notes);
          }}
          disabled={isSaving}
          className="flex-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
        >
          Approve
        </button>
      )}
      {item.status !== 'rejected' && item.status !== 'applied' && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onRecommendationAction?.(item.id, 'rejected', notes);
          }}
          disabled={isSaving}
          className="flex-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
        >
          Reject
        </button>
      )}
      {item.status === 'approved' && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onRecommendationAction?.(item.id, 'applied', notes);
          }}
          disabled={isSaving}
          className="w-full rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          Mark Applied
        </button>
      )}
    </div>
  );

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 transition-all hover:border-slate-300">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse recommendation' : 'Expand recommendation'}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected?.(item.id)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
          )}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 text-left"
            aria-expanded={expanded}
          >
            <div className="min-w-0">
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
                {readOnly && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                  visibility only
                  </span>
                )}
              </div>
              {(showDate || showRunMeta) && (
                <div className="text-[11px] text-slate-500 mb-1">
                  {showDate && <span>{formatDateOnlyInTimezone(item.reviewDate, workspaceTimezone)}</span>}
                  {showDate && showRunMeta && <span> · </span>}
                  {showRunMeta && <span>Run #{item.runId}</span>}
                </div>
              )}
              {!expanded && item.suggestedAction && (
                <div className="mt-1 text-xs text-slate-500">
                  {item.suggestedAction.length > 140 ? `${item.suggestedAction.slice(0, 140)}...` : item.suggestedAction}
                </div>
              )}
            </div>
          </button>
        </div>
        {actionButtons}
      </div>
      <SmoothCollapse open={expanded}>
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="text-xs text-slate-600 mb-2">{item.rationale}</div>
          {taxonomyProposal && (
            <div className="mb-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                <Tags className="h-3.5 w-3.5" />
                Taxonomy proposal
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                  {taxonomyProposal.action}
                </span>
                {taxonomyProposal.parentCategoryName && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    Parent: {taxonomyProposal.parentCategoryName}
                  </span>
                )}
                {taxonomyProposal.categoryName && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    Target: {taxonomyProposal.categoryName}
                  </span>
                )}
                {taxonomyProposal.newName && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    New: {taxonomyProposal.newName}
                  </span>
                )}
                {taxonomyProposal.categoryFit && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    Category {taxonomyProposal.categoryFit}
                  </span>
                )}
                {taxonomyProposal.subcategoryFit && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    Subcategory {taxonomyProposal.subcategoryFit}
                  </span>
                )}
                {taxonomyProposal.evidenceRunIds.length > 0 && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">
                    Runs {taxonomyProposal.evidenceRunIds.map((id) => `#${id}`).join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}
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
          {!readOnly && (
            <>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional review notes"
                className="mb-3 min-h-[72px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
              />
            </>
          )}
        </div>
      </SmoothCollapse>
    </div>
  );
}

function RunSignalCard({ label, value, detail, tone = 'slate', icon: Icon }) {
  const tones = {
    slate: 'border-slate-200 bg-white text-slate-800',
    green: 'border-green-200 bg-green-50 text-green-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
    purple: 'border-purple-200 bg-purple-50 text-purple-800',
  };

  return (
    <div className={`rounded-xl border p-3 ${tones[tone] || tones.slate}`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide opacity-75">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className="text-xl font-bold leading-tight">{value}</div>
      {detail && <div className="mt-1 text-xs opacity-80">{detail}</div>}
    </div>
  );
}

function ReviewHighlights({ summary, warnings, promptRecommendations, processRecommendations, taxonomyRecommendations, skillRecommendations }) {
  const totals = summary.totals || {};
  const totalReviewed = totals.totalTicketsReviewed || 0;
  const resolvedOutcomes = (totals.success || 0) + (totals.partialSuccess || 0) + (totals.failure || 0);
  const recommendationTotal = promptRecommendations.length + processRecommendations.length + taxonomyRecommendations.length + skillRecommendations.length;
  const noEvidence = totalReviewed <= 1 || resolvedOutcomes === 0;
  const threadGaps = summary.collectionDiagnostics?.ticketsWithNoThreadContext || 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <RunSignalCard
        label="Outcome"
        value={`${totalReviewed} reviewed`}
        detail={`${totals.success || 0} success · ${totals.failure || 0} failure · ${totals.unresolved || 0} unresolved`}
        tone={(totals.failure || 0) > 0 ? 'red' : (totals.unresolved || 0) > 0 ? 'amber' : 'green'}
        icon={TrendingUp}
      />
      <RunSignalCard
        label="Recommendations"
        value={recommendationTotal}
        detail={`${promptRecommendations.length} prompt · ${processRecommendations.length} process · ${taxonomyRecommendations.length} taxonomy · ${skillRecommendations.length} agent skill`}
        tone={recommendationTotal > 0 ? 'purple' : 'slate'}
        icon={Sparkles}
      />
      <RunSignalCard
        label="Attention"
        value={warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'No warnings'}
        detail={warnings[0] ? warnings[0].slice(0, 96) : 'No review warnings were reported.'}
        tone={warnings.length ? 'amber' : 'green'}
        icon={AlertTriangle}
      />
      <RunSignalCard
        label="Evidence"
        value={noEvidence ? 'Low signal' : 'Usable sample'}
        detail={threadGaps ? `${threadGaps} ticket(s) missing thread context` : `${resolvedOutcomes} resolved outcome(s) available`}
        tone={noEvidence || threadGaps ? 'amber' : 'blue'}
        icon={Eye}
      />
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
  compactCards = false,
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
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
              compact={compactCards}
            />
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-400">{emptyText}</div>
      )}
    </div>
  );
}

function getSupportingTicketIds(item) {
  return Array.isArray(item.supportingFreshserviceTicketIds) && item.supportingFreshserviceTicketIds.length > 0
    ? item.supportingFreshserviceTicketIds
    : item.supportingTicketIds;
}

function CompactSeverity({ severity }) {
  const normalized = severity || 'low';
  const styles = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-blue-100 text-blue-700',
  };
  const labels = {
    high: 'H',
    medium: 'M',
    low: 'L',
  };

  return (
    <span
      className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-bold uppercase leading-none ${styles[normalized] || styles.low}`}
      title={`${normalized} priority`}
    >
      {labels[normalized] || 'L'}
    </span>
  );
}

function ProficiencyBadge({ level, muted = false }) {
  const info = PROFICIENCY_LEVELS.find((item) => item.value === level);
  if (!info) {
    return (
      <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-400">
        -
      </span>
    );
  }
  return (
    <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-lg border px-2 text-xs font-bold ${muted ? 'bg-slate-50 text-slate-500 border-slate-200' : info.color}`}>
      {info.num}
    </span>
  );
}

function RecommendationMeta({ item, workspaceTimezone }) {
  const supportTicketIds = getSupportingTicketIds(item);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
      <CompactSeverity severity={item.severity} />
      <span>{formatDateOnlyInTimezone(item.reviewDate, workspaceTimezone)}</span>
      <span className="text-slate-300">•</span>
      <span>Run #{item.runId}</span>
      <span className="text-slate-300">•</span>
      <span className="capitalize">{item.kind}</span>
      {Array.isArray(supportTicketIds) && supportTicketIds.length > 0 && (
        <>
          <span className="text-slate-300">•</span>
          <span>{supportTicketIds.length} ticket{supportTicketIds.length === 1 ? '' : 's'}</span>
        </>
      )}
    </div>
  );
}

function BacklogRecommendationRow({
  item,
  workspaceTimezone,
  onRecommendationAction,
  savingRecommendationId,
  mode = 'pending',
  hideTitle = false,
  motionState = null,
  readOnly = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(item.reviewNotes || '');
  const isSaving = savingRecommendationId === item.id;
  const supportTicketIds = getSupportingTicketIds(item);

  useEffect(() => {
    setNotes(item.reviewNotes || '');
  }, [item.id, item.reviewNotes]);

  return (
    <div className={`overflow-hidden rounded-lg border border-slate-200 bg-white transition-all duration-300 ease-out ${getRecommendationMotionClass(motionState)}`}>
      <div className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-2 px-3 py-2.5 sm:flex sm:items-start">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-0.5 self-start rounded p-1 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          {!hideTitle && (
            <div className="whitespace-normal break-words text-sm font-semibold leading-snug text-slate-800">
              {item.title}
            </div>
          )}
          <RecommendationMeta item={item} workspaceTimezone={workspaceTimezone} />
        </div>
        <div className="col-span-2 mt-0.5 flex shrink-0 items-center justify-end gap-1 sm:col-span-1 sm:justify-start">
          {readOnly && (
            <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              visibility
            </span>
          )}
          {!readOnly && mode === 'pending' && (
            <>
              <button
                onClick={() => onRecommendationAction?.(item.id, 'approved', notes)}
                disabled={isSaving}
                className="rounded-lg border border-green-200 bg-green-50 p-1.5 text-green-700 hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-60"
                title="Approve"
              >
                <CheckCircle className="h-4 w-4" />
              </button>
              <button
                onClick={() => onRecommendationAction?.(item.id, 'rejected', notes)}
                disabled={isSaving}
                className="rounded-lg border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                title="Reject"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </>
          )}
          {!readOnly && mode === 'approved' && (
            <>
              <button
                onClick={() => onRecommendationAction?.(item.id, 'pending', notes)}
                disabled={isSaving}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                title="Move back to pending"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => onRecommendationAction?.(item.id, 'applied', notes)}
                disabled={isSaving}
                className="rounded-lg border border-blue-200 bg-blue-50 p-1.5 text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                title="Mark applied"
              >
                <CheckCircle className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
      <SmoothCollapse open={expanded}>
        <div className="border-t border-slate-100 bg-slate-50 px-3 py-3">
          <div className="space-y-2 text-xs text-slate-600">
            <p>{item.rationale}</p>
            {item.suggestedAction && (
              <p>
                <span className="font-semibold text-slate-700">Suggested action:</span> {item.suggestedAction}
              </p>
            )}
            {Array.isArray(item.skillsAffected) && item.skillsAffected.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.skillsAffected.map((skill) => (
                  <span key={skill} className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                    {skill}
                  </span>
                ))}
              </div>
            )}
            {Array.isArray(supportTicketIds) && supportTicketIds.length > 0 && (
              <div className="text-[11px] text-slate-500">
                <span className="font-medium">Supporting tickets:</span> {supportTicketIds.map((ticketId) => `#${ticketId}`).join(', ')}
              </div>
            )}
          </div>
          {!readOnly && (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional review notes"
              className="mt-3 min-h-[64px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            />
          )}
        </div>
      </SmoothCollapse>
    </div>
  );
}

function groupRecommendationsByTitle(items = []) {
  const map = new Map();
  for (const item of items) {
    const key = item.title || 'Untitled recommendation';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries()).map(([title, rows]) => ({ title, rows }));
}

function ApprovedBacklogGroup({
  group,
  workspaceTimezone,
  onRecommendationAction,
  savingRecommendationId,
  motionById = {},
}) {
  const [expanded, setExpanded] = useState(false);
  const runs = [...new Set(group.rows.map((item) => item.runId).filter(Boolean))].sort((a, b) => b - a);
  const kinds = [...new Set(group.rows.map((item) => item.kind).filter(Boolean))];
  const ticketCount = group.rows.reduce((sum, item) => sum + (getSupportingTicketIds(item)?.length || 0), 0);
  const hasHigh = group.rows.some((item) => item.severity === 'high');
  const strongestSeverity = hasHigh
    ? 'high'
    : group.rows.some((item) => item.severity === 'medium')
      ? 'medium'
      : 'low';
  const [notesById, setNotesById] = useState({});
  const isGroupSaving = group.rows.some((item) => savingRecommendationId === item.id);

  useEffect(() => {
    setNotesById((prev) => {
      const next = { ...prev };
      group.rows.forEach((item) => {
        if (next[item.id] === undefined) next[item.id] = item.reviewNotes || '';
      });
      return next;
    });
  }, [group.rows]);

  const moveGroupToPending = async () => {
    for (const item of group.rows) {
      await onRecommendationAction?.(item.id, 'pending', notesById[item.id] || '');
    }
  };

  return (
    <div className={`overflow-hidden rounded-lg border border-emerald-200 bg-white transition-all duration-300 ease-out ${
      group.rows.some((item) => motionById[item.id] === 'entering') ? 'ring-2 ring-emerald-200' : ''
    }`}>
      <div className="grid w-full grid-cols-[auto,1fr] gap-x-2 gap-y-2 px-3 py-2.5 hover:bg-emerald-50/50 sm:flex sm:items-start">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-0.5 self-start rounded p-1 text-emerald-600 hover:bg-emerald-50"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="whitespace-normal break-words text-sm font-semibold leading-snug text-slate-800">{group.title}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <CompactSeverity severity={strongestSeverity} />
            <span>{group.rows.length} approved</span>
            {kinds.length > 0 && <span>{kinds.join(', ')}</span>}
            {runs.length > 0 && <span>Run {runs.map((runId) => `#${runId}`).join(', ')}</span>}
            {ticketCount > 0 && <span>{ticketCount} ticket{ticketCount === 1 ? '' : 's'}</span>}
          </div>
        </button>
        <button
          type="button"
          onClick={moveGroupToPending}
          disabled={isGroupSaving}
          className="col-span-2 mt-0.5 justify-self-end rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-1 sm:self-start"
          title={group.rows.length === 1 ? 'Move back to pending' : 'Move group back to pending'}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      </div>
      <SmoothCollapse open={expanded}>
        <div className="space-y-3 border-t border-emerald-100 bg-slate-50 p-3">
          {group.rows.map((item) => {
            const supportTicketIds = getSupportingTicketIds(item);
            const isSaving = savingRecommendationId === item.id;
            return (
              <div key={item.id} className={`rounded-lg border border-slate-200 bg-white p-3 transition-all duration-300 ease-out ${getRecommendationMotionClass(motionById[item.id])}`}>
                {group.rows.length > 1 && (
                  <div className="mb-2 whitespace-normal break-words text-sm font-semibold leading-snug text-slate-800">{item.title}</div>
                )}
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <RecommendationMeta item={item} workspaceTimezone={workspaceTimezone} />
                  </div>
                  <div className="flex shrink-0 items-center justify-end gap-1 sm:justify-start">
                    <button
                      onClick={() => onRecommendationAction?.(item.id, 'pending', notesById[item.id] || '')}
                      disabled={isSaving}
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                      title="Move back to pending"
                    >
                      <Undo2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onRecommendationAction?.(item.id, 'applied', notesById[item.id] || '')}
                      disabled={isSaving}
                      className="rounded-lg border border-blue-200 bg-blue-50 p-1.5 text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                      title="Mark applied"
                    >
                      <CheckCircle className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-xs leading-relaxed text-slate-600">
                  <p>{item.rationale}</p>
                  {item.suggestedAction && (
                    <p>
                      <span className="font-semibold text-slate-700">Suggested action:</span> {item.suggestedAction}
                    </p>
                  )}
                  {Array.isArray(supportTicketIds) && supportTicketIds.length > 0 && (
                    <div className="text-[11px] text-slate-500">
                      <span className="font-medium">Supporting tickets:</span> {supportTicketIds.map((ticketId) => `#${ticketId}`).join(', ')}
                    </div>
                  )}
                </div>
                <textarea
                  value={notesById[item.id] || ''}
                  onChange={(e) => setNotesById((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Optional review notes"
                  className="mt-3 min-h-[64px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                />
              </div>
            );
          })}
        </div>
      </SmoothCollapse>
    </div>
  );
}

const CONSOLIDATION_ACTIVE_STATUSES = ['collecting', 'analyzing', 'saving'];

function getItemPayload(item) {
  return item.editedPayload || item.payload || {};
}

function buildLineDiff(before = '', after = '') {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', before: a[i], after: b[j], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'removed', before: a[i], after: '', beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      rows.push({ type: 'added', before: '', after: b[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ type: 'removed', before: a[i], after: '', beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ type: 'added', before: '', after: b[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }
  return rows;
}

function PromptDiffModal({ item, currentPrompt, onClose, onSaveDraft, saving }) {
  const payload = getItemPayload(item);
  const [draftPrompt, setDraftPrompt] = useState(payload.updatedPrompt || '');
  const [draftHistory, setDraftHistory] = useState([]);
  const [activeDiffIndex, setActiveDiffIndex] = useState(-1);
  const beforePaneRef = useRef(null);
  const afterPaneRef = useRef(null);
  const rows = buildLineDiff(currentPrompt || '', draftPrompt);
  const changedCount = rows.filter((row) => row.type !== 'same').length;
  const diffRowIndexes = rows.map((row, index) => (row.type !== 'same' ? index : null)).filter((index) => index !== null);

  useEffect(() => {
    if (!diffRowIndexes.length && activeDiffIndex !== -1) {
      setActiveDiffIndex(-1);
      return;
    }
    if (activeDiffIndex > diffRowIndexes.length - 1) {
      setActiveDiffIndex(diffRowIndexes.length - 1);
    }
  }, [activeDiffIndex, diffRowIndexes.length]);

  const scrollToDiff = (direction) => {
    if (!diffRowIndexes.length) return;
    const nextIndex = direction === 'previous'
      ? Math.max(activeDiffIndex - 1, 0)
      : Math.min(activeDiffIndex + 1, diffRowIndexes.length - 1);
    const rowIndex = diffRowIndexes[nextIndex];
    setActiveDiffIndex(nextIndex);
    [beforePaneRef.current, afterPaneRef.current].forEach((pane) => {
      const target = pane?.querySelector(`[data-diff-row="${rowIndex}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  const diffNavControls = (
    <div className="flex items-center gap-1 normal-case tracking-normal">
      <span className="mr-1 text-[10px] font-medium text-slate-400">
        {diffRowIndexes.length ? `${Math.max(activeDiffIndex + 1, 0)}/${diffRowIndexes.length}` : '0/0'}
      </span>
      <button
        type="button"
        onClick={() => scrollToDiff('previous')}
        disabled={!diffRowIndexes.length || activeDiffIndex <= 0}
        className="rounded border border-slate-200 bg-white p-0.5 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Previous diff"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => scrollToDiff('next')}
        disabled={!diffRowIndexes.length || activeDiffIndex >= diffRowIndexes.length - 1}
        className="rounded border border-slate-200 bg-white p-0.5 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        title="Next diff"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const commitDraftPrompt = (nextPrompt) => {
    if (nextPrompt === draftPrompt) return;
    setDraftHistory((prev) => [...prev.slice(-19), draftPrompt]);
    setDraftPrompt(nextPrompt);
  };

  const undoDraftChange = () => {
    setDraftHistory((prev) => {
      if (!prev.length) return prev;
      const nextHistory = prev.slice(0, -1);
      setDraftPrompt(prev[prev.length - 1]);
      return nextHistory;
    });
  };

  const updateDraftLine = (lineNumber, value) => {
    if (!lineNumber) return;
    const lines = draftPrompt.split('\n');
    lines[lineNumber - 1] = value;
    commitDraftPrompt(lines.join('\n'));
  };
  const insertDraftLineAfter = (lineNumber) => {
    const lines = draftPrompt.split('\n');
    const insertAt = lineNumber ? lineNumber : lines.length;
    lines.splice(insertAt, 0, '');
    commitDraftPrompt(lines.join('\n'));
  };
  const removeAddedBlock = (lineNumber) => {
    if (!lineNumber) return;
    const targetIndex = rows.findIndex((row) => row.afterLine === lineNumber);
    if (targetIndex < 0) return;
    let start = targetIndex;
    let end = targetIndex;
    while (start > 0 && rows[start - 1].type === 'added' && rows[start - 1].afterLine) start -= 1;
    while (end + 1 < rows.length && rows[end + 1].type === 'added' && rows[end + 1].afterLine) end += 1;
    const removeLines = new Set(rows.slice(start, end + 1).map((row) => row.afterLine).filter(Boolean));
    const lines = draftPrompt.split('\n').filter((_, index) => !removeLines.has(index + 1));
    commitDraftPrompt(lines.join('\n'));
  };
  const restoreRemovedBlock = (lineNumber) => {
    if (!lineNumber) return;
    const targetIndex = rows.findIndex((row) => row.beforeLine === lineNumber);
    if (targetIndex < 0) return;
    let start = targetIndex;
    let end = targetIndex;
    while (start > 0 && rows[start - 1].type === 'removed' && rows[start - 1].beforeLine) start -= 1;
    while (end + 1 < rows.length && rows[end + 1].type === 'removed' && rows[end + 1].beforeLine) end += 1;

    const restoredLines = rows.slice(start, end + 1).map((row) => row.before);
    const nextAnchor = rows.slice(end + 1).find((row) => row.afterLine);
    const insertAt = nextAnchor?.afterLine ? nextAnchor.afterLine - 1 : draftPrompt.split('\n').length;
    const lines = draftPrompt.split('\n');
    lines.splice(insertAt, 0, ...restoredLines);
    commitDraftPrompt(lines.join('\n'));
  };
  const saveDraft = async () => {
    await onSaveDraft?.(item.id, {
      editedPayload: { ...payload, updatedPrompt: draftPrompt },
      includeInApply: true,
    });
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-2 animate-fadeIn sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl sm:max-h-[88vh]">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Prompt Diff</h3>
            <p className="break-words text-xs text-slate-500">
              {item.title} · {changedCount} changed line{changedCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
            <button
              onClick={undoDraftChange}
              disabled={!draftHistory.length}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              title="Undo last prompt edit"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
            <button
              onClick={saveDraft}
              disabled={saving}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Draft'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-2">
          <div className="min-h-0 border-b border-slate-200 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Current Prompt</span>
              {diffNavControls}
            </div>
            <div ref={beforePaneRef} className="h-[36vh] overflow-auto bg-white font-mono text-xs leading-relaxed md:h-[70vh]">
              {rows.map((row, index) => {
                const isFirstRemovedBlock = row.type === 'removed' && rows[index - 1]?.type !== 'removed';
                return (
                  <div
                    key={`before-${index}`}
                    data-diff-row={index}
                    className={`grid grid-cols-[36px,1fr,76px] border-b border-slate-100 px-2 py-1 sm:grid-cols-[48px,1fr,96px] ${
                      row.type === 'removed' ? 'bg-red-50 text-red-900' : row.type === 'added' ? 'bg-slate-50 text-slate-300' : 'text-slate-700'
                    }`}
                  >
                    <span className="select-none text-right text-slate-400">{row.beforeLine || ''}</span>
                    <span className="whitespace-pre-wrap pl-3">{row.before || ' '}</span>
                    <span className="pl-2 text-right">
                      {isFirstRemovedBlock && (
                        <button
                          onClick={() => restoreRemovedBlock(row.beforeLine)}
                          className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                          title="Restore this deleted prompt block"
                        >
                          Restore
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between border-b border-slate-200 bg-blue-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-blue-700">
              <span>Recommended Prompt · Editable</span>
              <div className="flex items-center gap-2">
                {diffNavControls}
                <button
                  onClick={() => insertDraftLineAfter(draftPrompt.split('\n').length)}
                  className="rounded border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-blue-600 hover:bg-blue-50"
                >
                  Add line at end
                </button>
              </div>
            </div>
            <div ref={afterPaneRef} className="h-[42vh] overflow-auto bg-white font-mono text-xs leading-relaxed md:h-[70vh]">
              {rows.map((row, index) => {
                const isFirstAddedBlock = row.type === 'added' && rows[index - 1]?.type !== 'added';
                return (
                  <div
                    key={`after-${index}`}
                    data-diff-row={index}
                    className={`grid grid-cols-[36px,1fr,76px] border-b border-slate-100 px-2 py-1 sm:grid-cols-[48px,1fr,112px] ${
                      row.type === 'added' ? 'bg-emerald-50 text-emerald-900' : row.type === 'removed' ? 'bg-slate-50 text-slate-300' : 'text-slate-700'
                    }`}
                  >
                    <span className="select-none text-right text-slate-400">{row.afterLine || ''}</span>
                    {row.afterLine ? (
                      <span
                        className="min-h-[1.45rem] whitespace-pre-wrap rounded border border-transparent px-3 py-0.5 outline-none transition-colors focus:border-blue-200 focus:bg-white focus:ring-2 focus:ring-blue-100"
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(e) => updateDraftLine(row.afterLine, e.currentTarget.innerText.replace(/\n$/u, ''))}
                      >
                        {row.after || ' '}
                      </span>
                    ) : (
                      <span className="whitespace-pre-wrap px-3 py-0.5">{' '}</span>
                    )}
                    <span className="pl-2 text-right">
                      {isFirstAddedBlock && (
                        <button
                          onClick={() => removeAddedBlock(row.afterLine)}
                          className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                          title="Remove this full added recommendation block"
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteRunConfirmModal({
  run,
  deleting,
  onCancel,
  onConfirm,
  title = 'Delete consolidation run?',
  message,
}) {
  if (!run) return null;
  const body = message || `This will delete Run #${run.id} and its saved consolidation recommendations. This cannot be undone.`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 animate-fadeIn">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-red-50 p-2 text-red-600">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                {body}
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 bg-slate-50 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            {deleting ? 'Deleting...' : 'Delete Run'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TechnicianCompetencyCompactEditor({
  payload,
  isApplied,
  onFieldChange,
  competencyOptions,
  onSave,
  saving,
}) {
  const technicians = competencyOptions?.technicians || [];
  const categories = competencyOptions?.categories || [];
  const mappings = competencyOptions?.mappings || [];
  const selectedTech = technicians.find((tech) => (
    String(tech.id) === String(payload.technicianId || '')
    || tech.name?.toLowerCase() === String(payload.technicianName || '').toLowerCase()
  ));
  const selectedCategory = categories.find((cat) => (
    String(cat.id) === String(payload.categoryId || '')
    || cat.name?.toLowerCase() === String(payload.categoryName || '').toLowerCase()
  ));
  const currentMapping = mappings.find((mapping) => (
    Number(mapping.technicianId) === Number(selectedTech?.id)
    && Number(mapping.competencyCategoryId) === Number(selectedCategory?.id)
  ));
  const currentLevel = currentMapping?.proficiencyLevel || '';
  const proposedLevel = payload.proficiencyLevel || 'intermediate';

  const handleTechnicianChange = (value) => {
    const tech = technicians.find((row) => String(row.id) === value);
    onFieldChange('technicianId', tech?.id || null);
    onFieldChange('technicianName', tech?.name || '');
  };

  const handleCategoryChange = (value) => {
    const category = categories.find((row) => String(row.id) === value);
    onFieldChange('categoryId', category?.id || null);
    onFieldChange('categoryName', category?.name || '');
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
      <div className="grid items-center gap-2 xl:grid-cols-[minmax(180px,0.9fr)_minmax(220px,1fr)_auto_minmax(160px,auto)_minmax(220px,1fr)_auto]">
        <select
          value={selectedTech?.id || ''}
          onChange={(e) => handleTechnicianChange(e.target.value)}
          disabled={isApplied}
          className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60"
          title="Technician"
        >
          <option value="">{payload.technicianName || 'Select technician'}</option>
          {technicians.map((tech) => (
            <option key={tech.id} value={tech.id}>{tech.name}</option>
          ))}
        </select>

        <select
          value={selectedCategory?.id || ''}
          onChange={(e) => handleCategoryChange(e.target.value)}
          disabled={isApplied}
          className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 disabled:opacity-60"
          title="Skill / Category"
        >
          <option value="">{payload.categoryName || 'Select skill'}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>

        <div className="flex items-center justify-center gap-1 text-xs text-slate-500">
          <ProficiencyBadge level={currentLevel} muted />
          <span>to</span>
        </div>

        <div className="flex w-full items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white p-1 xl:w-auto">
          {PROFICIENCY_LEVELS.map((level) => {
            const active = proposedLevel === level.value;
            return (
              <button
                key={level.value}
                type="button"
                onClick={() => onFieldChange('proficiencyLevel', level.value)}
                disabled={isApplied}
                className={`h-7 min-w-8 rounded-md border px-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  active ? level.color : 'border-transparent text-slate-400 hover:bg-slate-50'
                }`}
                title={level.label}
              >
                {level.num}
              </button>
            );
          })}
        </div>

        <input
          value={payload.notes || ''}
          onChange={(e) => onFieldChange('notes', e.target.value)}
          disabled={isApplied}
          placeholder="Optional note"
          className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 disabled:opacity-60"
        />
        {!isApplied && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 xl:w-auto"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>1 Basic</span>
        <span className="text-slate-300">•</span>
        <span>2 Intermediate</span>
        <span className="text-slate-300">•</span>
        <span>3 Expert</span>
        {currentLevel && (
          <>
            <span className="text-slate-300">•</span>
            <span>Current matrix: {currentLevel}</span>
          </>
        )}
      </div>
    </div>
  );
}

function SkillListCompactEditor({
  payload,
  isApplied,
  onFieldChange,
  competencyOptions,
  onSave,
  saving,
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const categories = competencyOptions?.categories || [];
  const topLevelCategories = categories.filter((cat) => !cat.parentId);
  const normalizeName = (value) => String(value || '').trim().toLowerCase();
  const categoryLabel = (category) => {
    if (!category?.parentId) return category?.name || '';
    const parent = categories.find((row) => row.id === category.parentId);
    return parent ? `${parent.name} > ${category.name}` : category.name;
  };
  const action = payload.action || 'update';
  const selectedCategory = categories.find((cat) => (
    String(cat.id) === String(payload.categoryId || '')
    || normalizeName(cat.name) === normalizeName(payload.categoryName)
  ));
  const isAdd = action === 'add';
  const isRename = action === 'rename';
  const isMove = action === 'move';
  const isMerge = action === 'merge';
  const isDeprecate = action === 'deprecate';
  const needsTarget = !isAdd;
  const needsNewName = isAdd || isRename;
  const needsParent = isAdd || isMove;
  const targetLabel = isMerge ? 'Source skill' : 'Target skill';
  const parentPayloadId = payload.parentCategoryId ?? payload.parentId;
  const selectedParent = topLevelCategories.find((cat) => (
    String(cat.id) === String(parentPayloadId || '')
    || normalizeName(cat.name) === normalizeName(payload.parentCategoryName)
  ));
  const selectedParentId = selectedParent ? String(selectedParent.id) : 'top';
  const newSkillName = isAdd ? (payload.newName || payload.categoryName || '') : (payload.newName || '');
  const notesFieldId = `skill-note-${String(payload.categoryId || payload.categoryName || payload.newName || action)
    .replace(/[^a-z0-9_-]/gi, '-')}`;
  const actionCopy = {
    add: 'Create category or subcategory',
    rename: 'Rename an existing skill',
    update: 'Update description or guidance',
    move: 'Move under a different parent',
    merge: 'Record merge guidance',
    deprecate: 'Deactivate a stale skill',
  };

  const handleCategoryChange = (value) => {
    const category = categories.find((row) => String(row.id) === value);
    onFieldChange('categoryId', category?.id || null);
    onFieldChange('categoryName', category?.name || '');
  };

  const handleParentChange = (value) => {
    if (value === 'top') {
      onFieldChange('parentCategoryId', null);
      onFieldChange('parentCategoryName', null);
      onFieldChange('parentId', null);
      return;
    }
    const parent = topLevelCategories.find((row) => String(row.id) === value);
    onFieldChange('parentCategoryId', parent?.id || null);
    onFieldChange('parentCategoryName', parent?.name || null);
    onFieldChange('parentId', parent?.id || null);
  };

  const handleNewNameChange = (value) => {
    onFieldChange('newName', value);
    if (isAdd) {
      onFieldChange('categoryName', value);
      onFieldChange('categoryId', null);
    }
  };

  const handleSave = () => {
    const normalized = { ...payload };
    if (normalized.action === 'add') {
      const createName = String(normalized.newName || normalized.categoryName || '').trim();
      normalized.newName = createName || null;
      normalized.categoryName = createName;
      normalized.categoryId = null;
    }
    if (normalized.parentCategoryId === 'top') {
      normalized.parentCategoryId = null;
      normalized.parentCategoryName = null;
      normalized.parentId = null;
    }
    onSave?.(normalized);
  };

  const renderTargetSelect = () => (
    <div className="min-w-0 flex-1 xl:min-w-[220px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{targetLabel}</div>
      <select
        value={selectedCategory?.id || ''}
        onChange={(e) => handleCategoryChange(e.target.value)}
        disabled={isApplied}
        className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60"
        title={targetLabel}
      >
        <option value="">{payload.categoryName || `Select ${targetLabel.toLowerCase()}`}</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
        ))}
      </select>
    </div>
  );

  const renderParentSelect = () => (
    <div className="min-w-0 flex-1 xl:min-w-[220px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {isMove ? 'Move to' : 'Parent'}
      </div>
      <select
        value={selectedParentId}
        onChange={(e) => handleParentChange(e.target.value)}
        disabled={isApplied}
        className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-60"
        title="Parent category"
      >
        <option value="top">Top-level category</option>
        {topLevelCategories.map((category) => (
          <option key={category.id} value={category.id}>Under {category.name}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/80 px-3 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
        <div className="min-w-0 xl:min-w-[140px]">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Action</div>
          <select
            value={action}
            onChange={(e) => onFieldChange('action', e.target.value)}
            disabled={isApplied}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold capitalize text-slate-800 disabled:opacity-60"
            title="Action"
          >
            <option value="add">Add</option>
            <option value="rename">Rename</option>
            <option value="update">Update</option>
            <option value="move">Move</option>
            <option value="merge">Merge</option>
            <option value="deprecate">Deprecate</option>
          </select>
        </div>

        {needsTarget && renderTargetSelect()}

        {needsNewName && (
          <div className="min-w-0 flex-1 xl:min-w-[220px]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {isAdd ? 'New skill' : 'New name'}
            </div>
            <input
              value={newSkillName}
              onChange={(e) => handleNewNameChange(e.target.value)}
              disabled={isApplied}
              placeholder={isAdd ? 'Skill or subcategory name' : 'Rename to...'}
              className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60"
            />
          </div>
        )}

        {needsParent && renderParentSelect()}

        {(isMerge || isDeprecate) && (
          <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 xl:min-w-[210px]">
            {isMerge ? 'Manual merge note is recorded; no automatic merge is applied.' : 'Deprecates this skill after approval.'}
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => setDetailsOpen((prev) => !prev)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:w-auto"
            title={detailsOpen ? 'Hide notes' : 'Edit notes'}
          >
            <span className="inline-flex items-center gap-1">
              {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              Notes
            </span>
          </button>

          {!isApplied && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 sm:w-auto"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="rounded-full bg-white px-2 py-0.5 font-semibold text-slate-600 ring-1 ring-slate-200">
          {actionCopy[action] || 'Skill change'}
        </span>
        {needsTarget && (
          <>
            <span className="text-slate-300">•</span>
            <span>{targetLabel}: {selectedCategory ? categoryLabel(selectedCategory) : payload.categoryName || 'unresolved'}</span>
          </>
        )}
        {isAdd && newSkillName && (
          <>
            <span className="text-slate-300">•</span>
            <span>Creates: {newSkillName}</span>
          </>
        )}
        {needsParent && (
          <>
            <span className="text-slate-300">•</span>
            <span>{selectedParent ? `Under ${selectedParent.name}` : 'Top-level category'}</span>
          </>
        )}
      </div>

      <SmoothCollapse open={detailsOpen}>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-600">
          <label className="font-semibold uppercase tracking-wide text-slate-400" htmlFor={notesFieldId}>
            Description / Review Notes
          </label>
          <textarea
            id={notesFieldId}
            value={payload.description || ''}
            onChange={(e) => onFieldChange('description', e.target.value)}
            disabled={isApplied}
            rows={3}
            placeholder="Describe what changes and why this taxonomy update is justified."
            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-700 disabled:opacity-60"
          />
          {needsParent && selectedParent && (
            <div className="mt-2 text-slate-500">
              This will be applied as an internal subcategory under {selectedParent.name}.
            </div>
          )}
        </div>
      </SmoothCollapse>
    </div>
  );
}

function ConsolidationItemCard({ item, onSave, saving, currentPrompt, onOpenPromptDiff, competencyOptions }) {
  const [payload, setPayload] = useState(getItemPayload(item));
  const [includeInApply, setIncludeInApply] = useState(item.includeInApply !== false);
  const isApplied = item.status === 'applied';
  const isProcess = item.section === 'process';

  useEffect(() => {
    setPayload(getItemPayload(item));
    setIncludeInApply(item.includeInApply !== false);
  }, [item.id, item.editedPayload, item.payload, item.includeInApply]);

  const updateField = (field, value) => setPayload((prev) => ({ ...prev, [field]: value }));
  const save = () => onSave?.(item.id, {
    editedPayload: payload,
    includeInApply: item.section === 'prompt' ? true : includeInApply,
  });
  const toggleIncludeInApply = () => {
    const nextValue = !includeInApply;
    setIncludeInApply(nextValue);
    onSave?.(item.id, {
      editedPayload: payload,
      includeInApply: nextValue,
    });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 animate-[fadeIn_200ms_ease-out] transition-all duration-300 ease-out">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-slate-800">{item.title}</div>
            <RecommendationStatusBadge status={item.status} />
            {item.actionType && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">{item.actionType}</span>}
          </div>
          {item.section !== 'prompt' && item.rationale && <div className="mt-1 text-xs text-slate-500">{item.rationale}</div>}
        </div>
        {!isProcess && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
            {item.section === 'prompt' && (
              <button
                onClick={() => onOpenPromptDiff?.(item)}
                type="button"
                className="w-full rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                disabled={!currentPrompt || !payload.updatedPrompt}
              >
                Compare Prompt
              </button>
            )}
            {item.section !== 'prompt' && (
              <button
                type="button"
                onClick={toggleIncludeInApply}
                disabled={isApplied || saving}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  includeInApply
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100'
                }`}
                title={includeInApply ? 'This item will be applied. Click to skip it.' : 'This item is skipped. Click to apply it.'}
              >
                {includeInApply ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {includeInApply ? 'Apply' : 'Skip'}
              </button>
            )}
          </div>
        )}
      </div>

      {item.section === 'prompt' && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommendation</div>
            <div className="mt-2 text-sm leading-relaxed text-slate-600">
              {item.rationale || 'No recommendation rationale provided.'}
            </div>
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Change Summary</div>
            <div className="mt-2 text-sm leading-relaxed text-slate-700">
              {payload.changeSummary || 'No change summary provided.'}
            </div>
          </div>
        </div>
      )}

      {item.section === 'skills' && (
        <SkillListCompactEditor
          payload={payload}
          isApplied={isApplied}
          onFieldChange={updateField}
          competencyOptions={competencyOptions}
          onSave={(normalizedPayload) => onSave?.(item.id, {
            editedPayload: normalizedPayload,
            includeInApply,
          })}
          saving={saving}
        />
      )}

      {item.section === 'technician_competencies' && (
        <TechnicianCompetencyCompactEditor
          payload={payload}
          isApplied={isApplied}
          onFieldChange={updateField}
          competencyOptions={competencyOptions}
          onSave={save}
          saving={saving}
        />
      )}

      {item.section === 'process' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">{payload.changeType || 'dev_required'}</div>
          <div className="mt-1 text-xs">{payload.suggestedAction || item.rationale}</div>
        </div>
      )}

      {!isProcess && item.section !== 'prompt' && item.section !== 'technician_competencies' && item.section !== 'skills' && !isApplied && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save Item'}
          </button>
        </div>
      )}
    </div>
  );
}

function ConsolidationPanel({
  run,
  loading,
  applyNotice,
  queueSummary,
  queueLoading,
  starting,
  applying,
  savingItemId,
  sectionApply,
  onSectionApplyChange,
  onStart,
  onRefresh,
  onSaveItem,
  onApply,
  onCancel,
  onDelete,
  onDismissApplyNotice,
}) {
  const [promptDiffItem, setPromptDiffItem] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingRun, setDeletingRun] = useState(false);
  const [competencyOptions, setCompetencyOptions] = useState({ technicians: [], categories: [], mappings: [] });
  const [loadingCompetencyOptions, setLoadingCompetencyOptions] = useState(false);
  const events = run?.events || [];
  const thinking = events.filter((event) => event.type === 'thinking').map((event) => event.message).join('');
  const visibleText = events.filter((event) => event.type === 'text').map((event) => event.message).join('');
  const latestToolJson = [...events].reverse().find((event) => event.type === 'tool_json');
  const latestHeartbeat = [...events].reverse().find((event) => event.type === 'heartbeat');
  const latestByType = events
    .filter((event) => !['thinking', 'text', 'stream_delta'].includes(event.type))
    .reduce((acc, event) => ({ ...acc, [event.type]: event }), {});
  const progressEvents = Object.values(latestByType).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const thinkingKb = Math.max(parseFloat((thinking.length / 1024).toFixed(1)), latestHeartbeat?.payload?.thinkingKb || 0).toFixed(1);
  const visibleTextKb = Math.max(parseFloat((visibleText.length / 1024).toFixed(1)), latestHeartbeat?.payload?.textKb || 0).toFixed(1);
  const structuredPlanKb = Math.max(latestToolJson?.payload?.kb || 0, latestHeartbeat?.payload?.structuredPlanKb || 0).toFixed(1);
  const grouped = run?.groupedItems || {};
  const isActive = run && CONSOLIDATION_ACTIVE_STATUSES.includes(run.status);
  const hasRun = !!run;
  const currentPrompt = run?.contextSnapshot?.prompt?.systemPrompt || '';
  const queueByKind = queueSummary?.byKind || {};
  const queueItems = queueSummary?.items || [];
  const queueTotal = queueSummary?.total || 0;
  const queuePreviewItems = queueItems.slice(0, 5);
  const queueMoreCount = Math.max(0, queueTotal - queuePreviewItems.length);

  useEffect(() => {
    const needsCompetencyOptions = (grouped.technician_competencies || []).length > 0 || (grouped.skills || []).length > 0;
    if (!needsCompetencyOptions) return undefined;
    let cancelled = false;
    setLoadingCompetencyOptions(true);
    Promise.all([
      assignmentAPI.getCompetencyTechnicians(),
      assignmentAPI.getCompetencies(),
    ]).then(([techRes, compRes]) => {
      if (cancelled) return;
      const competencyData = compRes?.data || {};
      setCompetencyOptions({
        technicians: techRes?.data || [],
        categories: competencyData.categories || [],
        mappings: competencyData.mappings || [],
      });
    }).catch(() => {
      if (!cancelled) setCompetencyOptions({ technicians: [], categories: [], mappings: [] });
    }).finally(() => {
      if (!cancelled) setLoadingCompetencyOptions(false);
    });
    return () => { cancelled = true; };
  }, [grouped.skills, grouped.technician_competencies]);

  const sections = [
    { key: 'prompt', label: 'Prompt Edits', icon: FileText, applyable: true },
    { key: 'skills', label: 'Taxonomy Changes', icon: Tags, applyable: true },
    { key: 'technician_competencies', label: 'Agent Skill Changes', icon: Brain, applyable: true },
    { key: 'process', label: 'Process Changes', icon: Settings2, applyable: false },
  ];

  const confirmDeleteRun = async () => {
    if (!run?.id) return;
    setDeletingRun(true);
    try {
      await onDelete?.();
      setDeleteConfirmOpen(false);
    } finally {
      setDeletingRun(false);
    }
  };

  return (
    <div className="rounded-xl border border-indigo-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            Approved Recommendation Consolidation
          </h3>
          <p className="text-sm text-slate-500">
            Converts approved, unapplied Review findings into editable prompt, skill, competency, and process recommendations.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
          <button onClick={onRefresh} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
            Refresh
          </button>
          {hasRun && isActive && (
            <button
              onClick={onCancel}
              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
            >
              Cancel
            </button>
          )}
          {hasRun && !isActive && (
            <button
              onClick={() => setDeleteConfirmOpen(true)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Delete Run
            </button>
          )}
          {hasRun && ['completed', 'partially_applied'].includes(run.status) && (
            <button
              onClick={onApply}
              disabled={applying}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60 sm:justify-start"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {applying ? 'Applying...' : 'Apply Selected Sections'}
            </button>
          )}
          <button
            onClick={onStart}
            disabled={starting || isActive}
            className={`relative overflow-hidden rounded-lg px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed ${
              isActive ? 'bg-indigo-600 disabled:opacity-100' : 'bg-indigo-600 disabled:opacity-60'
            }`}
          >
            {isActive && (
              <span
                className="absolute inset-y-0 left-0 bg-white/20 transition-all duration-500 ease-out"
                style={{ width: `${Math.min(Math.max(run?.progress?.percent || 0, 8), 100)}%` }}
              />
            )}
            <span className="relative inline-flex items-center justify-center gap-1.5">
              {(starting || isActive) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {starting
                ? 'Starting...'
                : isActive
                  ? `Running ${run?.progress?.percent || 0}%`
                  : 'Run Opus Consolidation'}
            </span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-sm text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading consolidation...
        </div>
      ) : !hasRun ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/40 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-slate-800">Approved queue waiting for Opus</div>
              <div className="text-xs text-slate-500">
                {queueLoading ? 'Loading approved recommendations...' : `${queueTotal} approved item${queueTotal === 1 ? '' : 's'} ready to consolidate.`}
              </div>
            </div>
            {queueLoading && <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />}
          </div>

          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {[
              { key: 'prompt', label: 'Prompt', tone: 'blue' },
              { key: 'skill', label: 'Skill', tone: 'emerald' },
              { key: 'process', label: 'Process', tone: 'amber' },
            ].map((item) => (
              <div
                key={item.key}
                className={`rounded-lg border bg-white px-3 py-2 ${
                  item.tone === 'blue'
                    ? 'border-blue-100'
                    : item.tone === 'emerald'
                      ? 'border-emerald-100'
                      : 'border-amber-100'
                }`}
              >
                <div className={`text-xl font-bold ${
                  item.tone === 'blue'
                    ? 'text-blue-700'
                    : item.tone === 'emerald'
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                }`}>
                  {queueByKind[item.key]?.total || 0}
                </div>
                <div className="text-xs font-medium text-slate-500">{item.label}</div>
              </div>
            ))}
          </div>

          {queuePreviewItems.length > 0 ? (
            <div className="space-y-1.5">
              {queuePreviewItems.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs">
                  <CompactSeverity severity={item.severity} />
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{item.title}</span>
                  <span className="shrink-0 capitalize text-slate-400">{item.kind}</span>
                  <span className="shrink-0 text-slate-400">Run #{item.runId}</span>
                </div>
              ))}
              {queueMoreCount > 0 && (
                <div className="px-1 text-xs text-slate-400">
                  +{queueMoreCount} more approved item{queueMoreCount === 1 ? '' : 's'}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-100 bg-white px-4 py-5 text-center text-sm text-slate-400">
              No approved recommendations are waiting.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {applyNotice && (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <div className="flex min-w-0 gap-2">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <div>
                  <div className="font-semibold">
                    Applied {applyNotice.total} consolidation item{applyNotice.total === 1 ? '' : 's'} from Run #{applyNotice.runId}.
                  </div>
                  <div className="mt-0.5 text-xs text-emerald-700">
                    {applyNotice.summary || 'The selected sections were applied and the approved backlog was refreshed.'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onDismissApplyNotice}
                className="rounded-md px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              >
                Dismiss
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <StatusBadge status={run.status} />
            <span className="text-slate-500">Run #{run.id}</span>
            <span className="text-slate-500">{run.sourceCounts?.total || 0} source recommendation(s)</span>
            {run.progress?.message && <span className="font-medium text-slate-700">{run.progress.message}</span>}
          </div>

          {(isActive || thinking || visibleText || progressEvents.length > 0) && (
            <div className="grid gap-3 xl:grid-cols-3 transition-all duration-300 ease-out">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 transition-all duration-300 ease-out">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <span>Progress</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                    Plan {structuredPlanKb} KB
                  </span>
                </div>
                <div className="h-40 overflow-auto space-y-1 text-xs text-slate-600 transition-all duration-300 ease-out">
                  {progressEvents.map((event) => (
                    <div key={event.id} className="flex gap-2 animate-fadeIn transition-colors duration-200">
                      <span className="w-20 shrink-0 font-semibold text-slate-400">{event.type}</span>
                      <span>{event.message}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 transition-all duration-300 ease-out">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-purple-700">
                  <span className="flex items-center gap-2">
                    <Brain className="h-3.5 w-3.5" />
                    Thinking / Plan Stream
                  </span>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-purple-700">
                    Thinking {thinkingKb} KB · Plan {structuredPlanKb} KB
                  </span>
                </div>
                <div className="h-40 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-purple-900 transition-all duration-300 ease-out">
                  {thinking && <div className="animate-fadeIn">{thinking}</div>}
                  {latestToolJson && (
                    <div className={`${thinking ? 'mt-3 border-t border-purple-200 pt-2' : ''} animate-fadeIn`}>
                      Structured plan JSON: {latestToolJson.payload?.kb || 0} KB generated.
                    </div>
                  )}
                  {!thinking && !latestToolJson && (
                    <div>{isActive ? 'Connected. Waiting for thinking or structured plan output...' : 'No thinking or structured plan stream was emitted for this run.'}</div>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 transition-all duration-300 ease-out">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-blue-700">
                  <span className="flex items-center gap-2">
                    <MessageCircle className="h-3.5 w-3.5" />
                    Visible Text Stream
                  </span>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                    Text {visibleTextKb} KB
                  </span>
                </div>
                <div className="h-40 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-blue-900 transition-all duration-300 ease-out">
                  {visibleText ? <div className="animate-fadeIn">{visibleText}</div> : (
                    latestHeartbeat?.payload
                      ? `No visible text yet. Last output channel: ${latestHeartbeat.payload.lastOutputType || 'unknown'}; structured plan: ${latestHeartbeat.payload.structuredPlanKb || 0} KB.`
                      : (isActive ? 'Waiting for visible text output...' : 'No visible text was emitted for this run.')
                  )}
                </div>
              </div>
            </div>
          )}

          {sections.map(({ key, label, icon: Icon, applyable }) => {
            const items = grouped[key] || [];
            return (
              <div key={key} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition-all duration-300 ease-out">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-3">
                    {applyable && (
                      <input
                        type="checkbox"
                        checked={sectionApply[key] !== false}
                        onChange={(e) => onSectionApplyChange(key, e.target.checked)}
                        className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        title={`${sectionApply[key] !== false ? 'Apply' : 'Skip'} ${label}`}
                        aria-label={`${sectionApply[key] !== false ? 'Apply' : 'Skip'} ${label}`}
                      />
                    )}
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 ring-1 ring-slate-200">
                      <Icon className="h-5 w-5" />
                    </span>
                    <h4 className="text-lg font-semibold text-slate-900">{label}</h4>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-semibold text-slate-600">{items.length}</span>
                  </div>
                  {!applyable && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Dev work only</span>}
                </div>
                <div className="p-3">
                  {items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-5 text-center text-sm text-slate-400">
                      No {label.toLowerCase()} proposed.
                    </div>
                  ) : (
                    <div className="space-y-3 transition-all duration-300 ease-out">
                      {(key === 'technician_competencies' || key === 'skills') && loadingCompetencyOptions && (
                        <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
                          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                          Loading skill matrix options...
                        </div>
                      )}
                      {items.map((item) => (
                        <ConsolidationItemCard
                          key={item.id}
                          item={item}
                          saving={savingItemId === item.id}
                          onSave={onSaveItem}
                          currentPrompt={currentPrompt}
                          onOpenPromptDiff={setPromptDiffItem}
                          competencyOptions={competencyOptions}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        </div>
      )}
      {promptDiffItem && (
        <PromptDiffModal
          item={promptDiffItem}
          currentPrompt={currentPrompt}
          onSaveDraft={onSaveItem}
          saving={savingItemId === promptDiffItem.id}
          onClose={() => setPromptDiffItem(null)}
        />
      )}
      {deleteConfirmOpen && (
        <DeleteRunConfirmModal
          run={run}
          deleting={deletingRun}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={confirmDeleteRun}
        />
      )}
    </div>
  );
}

function CasesTable({ cases = [], workspaceTimezone }) {
  const displayCases = cases.slice(0, 20);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Key Cases</h3>
      {displayCases.length === 0 ? (
        <div className="text-sm text-slate-400">No cases available.</div>
      ) : (
        <div className="space-y-3">
          {displayCases.map((item) => (
            <div key={`${item.type}-${item.runId || item.ticketId}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">#{item.freshserviceTicketId}</span>
                <span className="min-w-0 break-words text-sm text-slate-700">{item.subject}</span>
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

const TONE_STYLES = {
  good: {
    border: 'border-green-200',
    bg: 'bg-green-50',
    text: 'text-green-800',
    pill: 'bg-green-100 text-green-700',
    icon: ThumbsUp,
  },
  bad: {
    border: 'border-red-200',
    bg: 'bg-red-50',
    text: 'text-red-800',
    pill: 'bg-red-100 text-red-700',
    icon: AlertTriangle,
  },
  watch: {
    border: 'border-amber-200',
    bg: 'bg-amber-50',
    text: 'text-amber-800',
    pill: 'bg-amber-100 text-amber-800',
    icon: Eye,
  },
  neutral: {
    border: 'border-slate-200',
    bg: 'bg-slate-50',
    text: 'text-slate-800',
    pill: 'bg-slate-100 text-slate-700',
    icon: MessageCircle,
  },
};

function toneOf(value) {
  return TONE_STYLES[value] || TONE_STYLES.neutral;
}

function briefingToMarkdown(briefing, run, workspaceTimezone) {
  if (!briefing) return '';
  const lines = [];
  const dateLabel = formatReviewRunDateLabel(run, workspaceTimezone);
  lines.push(`# Daily Briefing — ${run.summaryMetrics?.workspaceName || 'Workspace'} · ${dateLabel}`);
  if (briefing.headline) {
    lines.push('');
    lines.push(`**${briefing.headline}**`);
  }
  if (briefing.narrative) {
    lines.push('');
    lines.push(briefing.narrative);
  }
  if (Array.isArray(briefing.keyMetrics) && briefing.keyMetrics.length > 0) {
    lines.push('');
    lines.push('## Key metrics');
    for (const m of briefing.keyMetrics) {
      const ctx = m.context ? ` _(${m.context})_` : '';
      lines.push(`- **${m.label}:** ${m.value}${ctx}`);
    }
  }
  if (Array.isArray(briefing.highlights) && briefing.highlights.length > 0) {
    lines.push('');
    lines.push('## Highlights');
    for (const h of briefing.highlights) {
      const ids = Array.isArray(h.supportingFreshserviceTicketIds) && h.supportingFreshserviceTicketIds.length > 0
        ? ` (tickets: ${h.supportingFreshserviceTicketIds.map((id) => `#${id}`).join(', ')})`
        : '';
      lines.push(`- _[${h.tone || 'neutral'}]_ **${h.title}** — ${h.detail}${ids}`);
    }
  }
  if (Array.isArray(briefing.shoutouts) && briefing.shoutouts.length > 0) {
    lines.push('');
    lines.push('## Shoutouts');
    for (const s of briefing.shoutouts) {
      lines.push(`- **${s.name}** — ${s.reason}`);
    }
  }
  if (Array.isArray(briefing.talkingPoints) && briefing.talkingPoints.length > 0) {
    lines.push('');
    lines.push('## Talking points');
    briefing.talkingPoints.forEach((p, idx) => {
      lines.push(`${idx + 1}. ${p}`);
    });
  }
  if (briefing.lookahead) {
    lines.push('');
    lines.push('## Lookahead');
    lines.push(briefing.lookahead);
  }
  return lines.join('\n');
}

function MeetingBriefingSection({ run, workspaceTimezone }) {
  const briefing = run.meetingBriefing || null;
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [localBriefing, setLocalBriefing] = useState(briefing);
  const [generatedAt, setGeneratedAt] = useState(run.meetingBriefingGeneratedAt || null);
  const [generatedBy, setGeneratedBy] = useState(run.meetingBriefingBy || null);
  const [model, setModel] = useState(run.meetingBriefingModel || null);

  useEffect(() => {
    setLocalBriefing(run.meetingBriefing || null);
    setGeneratedAt(run.meetingBriefingGeneratedAt || null);
    setGeneratedBy(run.meetingBriefingBy || null);
    setModel(run.meetingBriefingModel || null);
  }, [run.id, run.meetingBriefing, run.meetingBriefingGeneratedAt, run.meetingBriefingBy, run.meetingBriefingModel]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await assignmentAPI.generateDailyReviewBriefing(run.id, { tone: 'standup' });
      setLocalBriefing(res?.data?.briefing || null);
      setGeneratedAt(res?.data?.generatedAt || new Date().toISOString());
      setGeneratedBy(res?.data?.generatedBy || null);
      setModel(res?.data?.model || null);
    } catch (err) {
      setError(err?.message || 'Failed to generate the meeting briefing.');
    } finally {
      setGenerating(false);
    }
  };

  const copyAsMarkdown = async () => {
    if (!localBriefing) return;
    const md = briefingToMarkdown(localBriefing, run, workspaceTimezone);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  };

  const isCompleted = run.status === 'completed';

  return (
    <div className="rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50 to-indigo-50 p-3 shadow-sm sm:p-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <h3 className="text-base font-semibold text-purple-900">Meeting Briefing</h3>
          {localBriefing && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
              Ready
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {localBriefing && (
            <button
              type="button"
              onClick={copyAsMarkdown}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-purple-200 bg-white px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-50"
            >
              <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied!' : 'Copy as Markdown'}
            </button>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={!isCompleted || generating}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:from-purple-700 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {generating
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating...</>
              : localBriefing
                ? <><RefreshCw className="h-3.5 w-3.5" /> Regenerate</>
                : <><Sparkles className="h-3.5 w-3.5" /> Generate Briefing</>}
          </button>
        </div>
      </div>

      <p className="mb-4 text-sm text-purple-800">
        A one-page narrative summary of the day for tomorrow&apos;s standup. Optional — generates only when you click. Uses the same analyzed dataset as the recommendations, scoped to this workspace only.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {!isCompleted && !localBriefing && (
        <div className="rounded-lg border border-dashed border-purple-200 bg-white/50 px-4 py-8 text-center text-sm text-purple-700">
          The meeting briefing can be generated once the review reaches the <strong>completed</strong> status.
        </div>
      )}

      {isCompleted && !localBriefing && !generating && (
        <div className="rounded-lg border border-dashed border-purple-200 bg-white/50 px-4 py-8 text-center text-sm text-purple-800">
          No briefing yet. Click <strong>Generate Briefing</strong> to produce a story-style summary, key metrics, highlights, and talking points for the next standup.
        </div>
      )}

      {generating && !localBriefing && (
        <div className="rounded-lg border border-purple-200 bg-white px-4 py-8 text-center text-sm text-purple-800">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-purple-600" />
          Asking the model to write your briefing...
        </div>
      )}

      {localBriefing && (
        <div className="space-y-4">
          {localBriefing.headline && (
            <div className="rounded-lg border border-purple-200 bg-white p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-purple-500">Headline</div>
              <div className="text-lg font-semibold leading-snug text-slate-900">{localBriefing.headline}</div>
            </div>
          )}

          {localBriefing.narrative && (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <FileText className="h-3.5 w-3.5" /> Story of the day
              </div>
              <div className="space-y-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                {localBriefing.narrative}
              </div>
            </div>
          )}

          {Array.isArray(localBriefing.keyMetrics) && localBriefing.keyMetrics.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <TrendingUp className="h-3.5 w-3.5" /> Numbers worth saying out loud
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {localBriefing.keyMetrics.map((metric, idx) => {
                  const tone = toneOf(metric.tone);
                  return (
                    <div key={idx} className={`rounded-lg border ${tone.border} ${tone.bg} p-3`}>
                      <div className={`text-2xl font-bold ${tone.text}`}>{metric.value}</div>
                      <div className="text-xs font-medium text-slate-700">{metric.label}</div>
                      {metric.context && (
                        <div className="mt-1 text-[11px] text-slate-500">{metric.context}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {Array.isArray(localBriefing.highlights) && localBriefing.highlights.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Highlights</div>
              <div className="space-y-2">
                {localBriefing.highlights.map((item, idx) => {
                  const tone = toneOf(item.tone);
                  const Icon = tone.icon;
                  return (
                    <div key={idx} className={`rounded-lg border ${tone.border} ${tone.bg} p-3`}>
                      <div className="mb-1 flex items-start gap-2">
                        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${tone.text}`} />
                        <div className="flex-1">
                          <div className={`text-sm font-semibold ${tone.text}`}>{item.title}</div>
                          <div className="mt-0.5 text-sm text-slate-700">{item.detail}</div>
                          {Array.isArray(item.supportingFreshserviceTicketIds) && item.supportingFreshserviceTicketIds.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {item.supportingFreshserviceTicketIds.map((id) => (
                                <span key={id} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.pill}`}>
                                  #{id}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {Array.isArray(localBriefing.shoutouts) && localBriefing.shoutouts.length > 0 && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-green-700">
                <ThumbsUp className="h-3.5 w-3.5" /> Shoutouts
              </div>
              <div className="space-y-2">
                {localBriefing.shoutouts.map((s, idx) => (
                  <div key={idx} className="rounded-lg bg-white px-3 py-2 text-sm text-slate-700">
                    <span className="font-semibold text-green-800">{s.name}</span> — {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(localBriefing.talkingPoints) && localBriefing.talkingPoints.length > 0 && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">
                <MessageCircle className="h-3.5 w-3.5" /> Talking points for the standup
              </div>
              <ol className="space-y-2 pl-5 text-sm text-slate-800" style={{ listStyleType: 'decimal' }}>
                {localBriefing.talkingPoints.map((point, idx) => (
                  <li key={idx} className="leading-relaxed">{point}</li>
                ))}
              </ol>
            </div>
          )}

          {localBriefing.lookahead && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                <Eye className="h-3.5 w-3.5" /> What to watch today
              </div>
              <div className="text-sm italic text-amber-900">{localBriefing.lookahead}</div>
            </div>
          )}

          <div className="text-[11px] text-slate-400">
            Generated {generatedAt ? formatDateTimeInTimezone(generatedAt, workspaceTimezone) : ''}
            {generatedBy ? ` by ${generatedBy}` : ''}
            {model ? ` · ${model}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function CollectionDiagnosticsSection({ summary }) {
  const diag = summary?.collectionDiagnostics;
  if (!diag) return null;

  const totalCandidates = diag.candidateTickets || 0;
  const ticketsWithoutContext = diag.ticketsWithNoThreadContext || 0;
  const conversationCoverage = totalCandidates > 0
    ? Math.round(((diag.ticketsWithConversations || 0) / totalCandidates) * 100)
    : 0;
  const activityCoverage = totalCandidates > 0
    ? Math.round(((diag.ticketsWithActivities || 0) / totalCandidates) * 100)
    : 0;

  const conversationTone = conversationCoverage >= 80
    ? 'green'
    : conversationCoverage >= 40
      ? 'amber'
      : 'red';
  const activityTone = activityCoverage >= 80 ? 'green' : 'amber';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Collection Diagnostics</h3>
        <div className="text-xs text-slate-500">What the LLM actually had to read</div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <MetricCard label="Candidate Tickets" value={totalCandidates} />
        <MetricCard label="With Conversations" value={`${diag.ticketsWithConversations || 0} (${conversationCoverage}%)`} tone={conversationTone} />
        <MetricCard label="With Activity Log" value={`${diag.ticketsWithActivities || 0} (${activityCoverage}%)`} tone={activityTone} />
        <MetricCard label="No Thread Context" value={ticketsWithoutContext} tone={ticketsWithoutContext > 0 ? 'red' : 'slate'} />
      </div>

      <div className="grid gap-3 text-xs text-slate-600 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Local cache (before this run)</div>
          <div>Activities cached: <strong>{diag.ticketsWithLocalActivitiesBeforeRun || 0}</strong> / {totalCandidates}</div>
          <div>Conversations cached: <strong>{diag.ticketsWithLocalConversationsBeforeRun || 0}</strong> / {totalCandidates}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {diag.forceRefresh
              ? 'Force-refresh was on — every ticket re-fetched from FreshService regardless of cache.'
              : 'Run reused already-cached data when present; only missing pieces were pulled.'}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pulled from FreshService this run</div>
          <div>Activity rows fetched: <strong>{diag.activityRowsFetched || 0}</strong> across {diag.ticketsHydratedActivities || 0} ticket(s)</div>
          <div>Conversation rows fetched: <strong>{diag.conversationRowsFetched || 0}</strong> across {diag.ticketsHydratedConversations || 0} ticket(s)</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {(diag.hydrationFailures || 0) > 0
              ? <span className="text-red-600">{diag.hydrationFailures} ticket(s) had hydration errors — see warnings above.</span>
              : 'No hydration errors.'}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 text-xs text-slate-600 sm:grid-cols-2 md:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-medium text-slate-500">Total thread entries</div>
          <div className="text-lg font-semibold text-slate-800">{diag.threadEntriesAvailable || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-medium text-slate-500">Conversation entries</div>
          <div className="text-lg font-semibold text-slate-800">{diag.conversationEntriesAvailable || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-medium text-slate-500">Activity-stream entries</div>
          <div className="text-lg font-semibold text-slate-800">{diag.activityEntriesAvailable || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-medium text-slate-500">Episodes / Assignments</div>
          <div className="text-lg font-semibold text-slate-800">{diag.episodes || 0} / {diag.assignmentActions || 0}</div>
        </div>
      </div>

      {ticketsWithoutContext > 0 && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {ticketsWithoutContext} ticket(s) reached the LLM with no thread context (no activities and no conversations). The model had only metadata for these. Try <strong>Force Refresh Tickets</strong> on a rerun.
        </div>
      )}
    </div>
  );
}

function RunDetail({ run, workspaceTimezone, onRecommendationAction, savingRecommendationId }) {
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const summary = run.summaryMetrics || {};
  const totals = summary.totals || {};
  const rates = summary.rates || {};
  const promptRecommendations = run.promptRecommendations || [];
  const processRecommendations = run.processRecommendations || [];
  const taxonomyRecommendations = run.taxonomyRecommendations || [];
  const skillRecommendations = run.skillRecommendations || [];
  const warnings = run.warnings || [];
  const cases = run.evidenceCases || [];
  const navigate = useNavigate();
  const executiveSummary = summary.executiveSummary || '';
  const summaryIsLong = executiveSummary.length > 320;
  const visibleWarnings = warnings.slice(0, 4);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold text-slate-800">Review #{run.id}</h2>
              <StatusBadge status={run.status} />
            </div>
            <div className="text-sm text-slate-500">
              {summary.workspaceName || 'Workspace'} · {formatReviewRunDateLabel(run, workspaceTimezone)} · {summary.reviewWindow?.startTime || '00:00'}-{summary.reviewWindow?.endTime || '23:59'}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            <button onClick={() => navigate('/assignments/prompts')} className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
              <FileText className="w-4 h-4" /> Open Prompts
            </button>
            <button onClick={() => navigate('/assignments/competencies')} className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
              <Award className="w-4 h-4" /> Open Competencies
            </button>
          </div>
        </div>
        <div className="mt-4">
          <ReviewHighlights
            summary={summary}
            warnings={warnings}
            promptRecommendations={promptRecommendations}
            processRecommendations={processRecommendations}
            taxonomyRecommendations={taxonomyRecommendations}
            skillRecommendations={skillRecommendations}
          />
        </div>
        {executiveSummary && (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">Executive summary</div>
              {summaryIsLong && (
                <button
                  type="button"
                  onClick={() => setSummaryExpanded((value) => !value)}
                  className="text-xs font-semibold text-indigo-700 hover:text-indigo-900"
                >
                  {summaryExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
            <div className={`${summaryIsLong && !summaryExpanded ? 'max-h-24 overflow-hidden' : ''}`}>
              {executiveSummary}
            </div>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              Needs attention
            </div>
            <div className="space-y-1">
              {visibleWarnings.map((warning, index) => (
                <div key={index} className="text-xs text-amber-800">
                  {warning}
                </div>
              ))}
              {warnings.length > visibleWarnings.length && (
                <div className="text-xs font-medium text-amber-700">
                  +{warnings.length - visibleWarnings.length} more warning{warnings.length - visibleWarnings.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
          </div>
        )}
        {run.errorMessage && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <div className="mb-1 font-semibold uppercase tracking-wide">Run error</div>
            {run.errorMessage}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
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

      <CollectionDiagnosticsSection summary={summary} />

      <MeetingBriefingSection run={run} workspaceTimezone={workspaceTimezone} />

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <RecommendationSection
          title="Prompt Recommendations"
          items={promptRecommendations}
          icon={FileText}
          emptyText="No prompt changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
          compactCards
        />
        <RecommendationSection
          title="Process Recommendations"
          items={processRecommendations}
          icon={Settings2}
          emptyText="No process changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
          compactCards
        />
        <RecommendationSection
          title="Taxonomy Recommendations"
          items={taxonomyRecommendations}
          icon={Tags}
          emptyText="No category taxonomy changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
          compactCards
        />
        <RecommendationSection
          title="Agent Skill Recommendations"
          items={skillRecommendations}
          icon={Award}
          emptyText="No agent skill changes recommended for this review."
          workspaceTimezone={workspaceTimezone}
          onRecommendationAction={onRecommendationAction}
          savingRecommendationId={savingRecommendationId}
          compactCards
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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

function LiveDailyReviewView({ reviewDate, reviewStartDate, reviewEndDate, forceRefreshThreads = false, onComplete, onFinished }) {
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
  // status: idle | starting | running | completed | cancelled | error
  const [status, setStatus] = useState('starting');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState(null);

  const startedAtRef = useRef(null);
  const pollTimerRef = useRef(null);
  const stoppedRef = useRef(false);
  const lastMessageRef = useRef(null);
  const completionNotifiedRef = useRef(false);

  const appendActivity = useCallback((message, eventPhase = 'update') => {
    if (!message) return;
    if (lastMessageRef.current === message) return;
    lastMessageRef.current = message;
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

  // Independent ticking timer — separate from the work itself, so it ticks
  // smoothly even between polls. Stops when we reach a terminal status.
  useEffect(() => {
    if (startedAtRef.current === null) return undefined;
    if (status !== 'starting' && status !== 'running') return undefined;
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  // Kick off the run and start polling. Polling is the source of truth
  // since the backend now runs the work in the background and persists
  // progress to the run row — no SSE, no Azure 230s timeout to fight.
  useEffect(() => {
    let cancelled = false;
    stoppedRef.current = false;
    completionNotifiedRef.current = false;
    startedAtRef.current = Date.now();
    setStatus('starting');
    setElapsedSec(0);
    setError(null);
    setRunId(null);
    setPhase(null);
    setPhaseMessage('Queuing review on the server...');
    setProgressPct(2);
    setLiveStats({});
    setActivityLog([]);
    setSummary(null);
    setCounts({ prompt: 0, process: 0, skill: 0 });
    setExecutiveSummary('');
    lastMessageRef.current = null;

    const stopPolling = () => {
      stoppedRef.current = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const applyProgress = (row) => {
      if (!row) return;
      const p = row.progress || {};
      if (p.phase) setPhase(p.phase);
      if (p.message) {
        setPhaseMessage(p.message);
        appendActivity(p.message, p.phase || row.status || 'update');
      }
      if (typeof p.percent === 'number') setProgressPct(Math.max(2, p.percent));
      if (p.stats && typeof p.stats === 'object') {
        setLiveStats((prev) => ({ ...prev, ...p.stats }));
        if (typeof p.stats.totalTicketsReviewed === 'number') {
          setSummary((prev) => ({ ...(prev || {}), ...p.stats }));
        }
      }
      if (row.status === 'completed') {
        setStatus('completed');
        stopPolling();
      } else if (row.status === 'failed') {
        setStatus('error');
        setError(row.errorMessage || 'Review failed');
        stopPolling();
      } else if (row.status === 'cancelled') {
        setStatus('cancelled');
        setIsCancelling(false);
        stopPolling();
      } else {
        setStatus('running');
      }
    };

    const pollOnce = async (id) => {
      if (cancelled || stoppedRef.current) return;
      try {
        const res = await assignmentAPI.getDailyReviewRunProgress(id);
        applyProgress(res?.data || null);
      } catch (err) {
        // Polling failure is transient — log to activity but keep trying.
        appendActivity(`Polling hiccup: ${err?.message || 'network error'}`, 'warn');
      }
      if (!cancelled && !stoppedRef.current) {
        pollTimerRef.current = setTimeout(() => pollOnce(id), 1500);
      }
    };

    const fetchFinalDetails = async (id) => {
      try {
        const res = await assignmentAPI.getDailyReviewRun(id);
        const row = res?.data;
        if (!row) return;
        const totals = row.summaryMetrics?.totals || {};
        setSummary(totals);
        setCounts({
          prompt: (row.promptRecommendations || []).length,
          process: (row.processRecommendations || []).length,
          skill: (row.skillRecommendations || []).length,
        });
        setExecutiveSummary(row.summaryMetrics?.executiveSummary || '');
      } catch {
        /* non-fatal — the user can still navigate to the run detail */
      }
    };

    (async () => {
      try {
        const res = await assignmentAPI.runDailyReview({
          reviewDate,
          reviewStartDate,
          reviewEndDate,
          force: true,
          forceRefreshThreads,
        });
        const row = res?.data;
        if (cancelled) return;
        const id = row?.id;
        if (!id) throw new Error('Server did not return a run id');
        setRunId(id);
        appendActivity(`Started review run #${id}.`, 'started');
        applyProgress(row);
        // If kickoff returned an already-completed row (force=false, cached),
        // skip polling and pull final details immediately.
        if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
          await fetchFinalDetails(id);
          return;
        }
        pollOnce(id);
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err?.message || 'Failed to start review');
        appendActivity(err?.message || 'Failed to start review', 'error');
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewDate, reviewStartDate, reviewEndDate, forceRefreshThreads]);

  // When status flips to completed, fetch the full run detail to populate
  // summary / counts / executiveSummary. Polling endpoint is intentionally
  // lightweight and doesn't include those.
  useEffect(() => {
    if (status === 'completed' && runId) {
      assignmentAPI.getDailyReviewRun(runId).then((res) => {
        const row = res?.data;
        if (!row) return;
        setSummary(row.summaryMetrics?.totals || null);
        setCounts({
          prompt: (row.promptRecommendations || []).length,
          process: (row.processRecommendations || []).length,
          skill: (row.skillRecommendations || []).length,
        });
        setExecutiveSummary(row.summaryMetrics?.executiveSummary || '');
        if (!completionNotifiedRef.current) {
          completionNotifiedRef.current = true;
          onFinished?.(runId, row);
        }
      }).catch(() => { /* non-fatal */ });
    }
  }, [status, runId, onFinished]);

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
      const message = cancelError?.message || 'Failed to cancel review run.';
      setPhaseMessage(message);
      appendActivity(message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {(status === 'running' || status === 'starting') ? (
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
            {status === 'running' || status === 'starting'
              ? `Running review... (${elapsedSec}s)`
              : status === 'cancelled'
                ? `Review cancelled (${elapsedSec}s)`
                : status === 'completed'
                  ? `Review complete (${elapsedSec}s)`
                  : 'Review failed'}
          </span>
          {runId && <span className="text-xs text-slate-400">Run #{runId}</span>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {(status === 'running' || status === 'starting') && runId && (
            <button
              onClick={cancelRun}
              disabled={isCancelling}
              className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              <StopCircle className="w-4 h-4" />
              {isCancelling ? 'Cancelling...' : 'Cancel Run'}
            </button>
          )}
          {status === 'completed' && (
            <button onClick={() => onComplete(runId)} className="w-full rounded-lg border border-blue-100 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-800 sm:w-auto sm:border-0 sm:px-0 sm:py-0">
              View Results
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
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
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          {visibleLiveStats.map((item) => (
            <MetricCard key={item.key} label={item.label} value={item.value} tone="slate" />
          ))}
        </div>
      )}

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <MetricCard label="Tickets Reviewed" value={summary.totalTicketsReviewed || 0} />
          <MetricCard label="Success" value={summary.success || 0} tone="green" />
          <MetricCard label="Failure" value={summary.failure || 0} tone="red" />
          <MetricCard label="Tickets With Rebounds" value={summary.rebounds || 0} tone="amber" />
        </div>
      )}

      {(counts.prompt > 0 || counts.process > 0 || counts.skill > 0) && (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Prompt Recs" value={counts.prompt} tone="blue" />
          <MetricCard label="Process Recs" value={counts.process} tone="amber" />
          <MetricCard label="Skill Recs" value={counts.skill} tone="green" />
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div className="text-sm font-semibold text-slate-800 mb-3">Live Activity</div>
        {activityLog.length === 0 ? (
          <div className="text-sm text-slate-400">Waiting for the first progress update...</div>
        ) : (
          <div className="space-y-2">
            {activityLog.map((item) => (
              <div key={item.id} className="flex flex-col gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-700">{item.phase.replace(/_/g, ' ')}</div>
                  <div className="text-sm text-slate-600">{item.message}</div>
                </div>
                <div className="whitespace-nowrap text-[11px] text-slate-400">{item.timeLabel}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {executiveSummary && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900 sm:p-4">
          {executiveSummary}
        </div>
      )}

      {(error || status === 'error') && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error || 'Review failed'}
        </div>
      )}
    </div>
  );
}

const ACTIVE_STATUSES = ['running', 'collecting', 'analyzing'];
const RUN_HISTORY_TIME_OPTIONS = { timeZoneName: 'short' };
const RUN_HISTORY_PAGE_SIZE = 8;
const REVIEW_PAGE_TABS = [
  { key: 'review', label: 'Review', icon: CalendarDays },
  { key: 'backlog', label: 'Backlog', icon: History },
  { key: 'consolidation', label: 'Consolidation', icon: Sparkles },
];
const BACKLOG_KIND_TABS = [
  { key: 'prompt', label: 'Prompt', icon: FileText },
  { key: 'process', label: 'Process', icon: Settings2 },
  { key: 'taxonomy', label: 'Taxonomy', icon: Tags },
  { key: 'skill', label: 'Agent Skills', icon: Award },
  { key: 'dev', label: 'Dev', icon: AlertTriangle, visibilityOnly: true },
];

function DailyReviewHistoryPanel({
  runs,
  total,
  page,
  pageSize,
  loadingRuns,
  loadingDetail,
  workspaceTimezone,
  onRefresh,
  onOpenRun,
  onCancelRun,
  onRequestDeleteRun,
  onPageChange,
}) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const start = total > 0 ? page * pageSize + 1 : 0;
  const end = Math.min(total || 0, (page + 1) * pageSize);

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-indigo-100 bg-white/90 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-indigo-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-indigo-600" />
          <span className="text-sm font-semibold text-slate-800">Review History</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{total || 0}</span>
          <span className="text-xs text-slate-400">Collapsed list</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:w-auto"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <div className="bg-white">
        {loadingRuns ? (
          <div className="flex items-center justify-center py-6 text-sm text-gray-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history...
          </div>
        ) : runs.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">
            No review runs yet. Start one above.
          </div>
        ) : (
          <div>
            {runs.map((run) => {
              const totals = run.summaryMetrics?.totals || {};
              const isActiveStatus = ACTIVE_STATUSES.includes(run.status);
              return (
                <div
                  key={run.id}
                  className="group flex w-full flex-col gap-2 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-indigo-50/40 sm:flex-row sm:items-center sm:gap-3"
                >
                  <button
                    type="button"
                    onClick={() => onOpenRun(run.id)}
                    disabled={loadingDetail}
                    className="min-w-0 flex-1 text-left disabled:cursor-wait"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-semibold text-slate-900">Run #{run.id}</span>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        run.status === 'completed'
                          ? 'bg-emerald-500'
                          : isActiveStatus
                            ? 'bg-indigo-500'
                            : run.status === 'failed'
                              ? 'bg-red-500'
                              : 'bg-slate-300'
                      }`} />
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        run.status === 'completed'
                          ? 'bg-emerald-50 text-emerald-700'
                          : isActiveStatus
                            ? 'bg-indigo-50 text-indigo-700'
                            : run.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-slate-100 text-slate-600'
                      }`}>
                        {run.status?.replace(/_/g, ' ')}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span className="text-slate-500">{formatReviewRunDateLabel(run, workspaceTimezone)}</span>
                      <span className="text-slate-300">•</span>
                      <span className="text-slate-500">{formatDateTimeInTimezone(run.createdAt, workspaceTimezone, RUN_HISTORY_TIME_OPTIONS)}</span>
                      {run.triggeredBy && (
                        <>
                          <span className="text-slate-300">•</span>
                          <span className="max-w-[220px] truncate text-slate-500">{run.triggeredBy}</span>
                        </>
                      )}
                    </div>
                  </button>

                  <div className="ml-0 flex w-full shrink-0 items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs text-slate-500 sm:ml-auto sm:w-auto sm:justify-end sm:border-t-0 sm:pt-0">
                    {totals.totalTicketsReviewed != null && <span className="tabular-nums">{totals.totalTicketsReviewed}</span>}
                    {totals.totalTicketsReviewed != null && <span className="text-slate-300">tickets</span>}
                    {totals.success != null && <span className="font-medium tabular-nums text-emerald-600">{totals.success} ✓</span>}
                    {totals.failure != null && <span className="font-medium tabular-nums text-red-600">{totals.failure} ✕</span>}
                    {isActiveStatus && (
                      <button
                        type="button"
                        onClick={(e) => onCancelRun(e, run.id)}
                        className="rounded px-2 py-1 text-red-600 hover:bg-red-50"
                        title="Cancel this run"
                      >
                        <StopCircle className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {!isActiveStatus && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRequestDeleteRun(run);
                        }}
                        className="rounded px-2 py-1 text-red-500 opacity-70 hover:bg-red-50 hover:opacity-100"
                        title="Delete this review run"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <ChevronRight className="h-4 w-4 text-slate-300 transition-colors group-hover:text-indigo-500" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Showing {start}-{end} of {total}
          </span>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0 || loadingRuns}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span className="col-span-2 text-center font-semibold text-slate-600 sm:col-span-1">
              Page {page + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1 || loadingRuns}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DailyReviewManager({ workspaceTimezone }) {
  const [view, setView] = useState('trigger');
  const [reviewDate, setReviewDate] = useState(formatDateLocal(new Date()));
  const [reviewMode, setReviewMode] = useState('single');
  const [reviewEndDate, setReviewEndDate] = useState(formatDateLocal(new Date()));
  const [forceRefreshThreads, setForceRefreshThreads] = useState(false);
  const [runs, setRuns] = useState([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runHistoryPage, setRunHistoryPage] = useState(0);
  const [runDeleteConfirm, setRunDeleteConfirm] = useState(null);
  const [deletingDailyReviewRun, setDeletingDailyReviewRun] = useState(false);
  const [activeRun, setActiveRun] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingRecommendationId, setSavingRecommendationId] = useState(null);
  const [backlogItems, setBacklogItems] = useState([]);
  const [pendingBacklogItems, setPendingBacklogItems] = useState([]);
  const [approvedBacklogItems, setApprovedBacklogItems] = useState([]);
  const [backlogMotionById, setBacklogMotionById] = useState({});
  const [backlogTotal, setBacklogTotal] = useState(0);
  const [pendingBacklogTotal, setPendingBacklogTotal] = useState(0);
  const [approvedBacklogTotal, setApprovedBacklogTotal] = useState(0);
  const [loadingBacklog, setLoadingBacklog] = useState(false);
  const [refreshingBacklog, setRefreshingBacklog] = useState(false);
  const [backlogStatus, setBacklogStatus] = useState('pending');
  const [backlogKind, setBacklogKind] = useState('prompt');
  const [backlogSeverity, setBacklogSeverity] = useState('all');
  const [backlogStartDate, setBacklogStartDate] = useState('');
  const [backlogEndDate, setBacklogEndDate] = useState('');
  const [backlogRunFilter, setBacklogRunFilter] = useState('');
  const [consolidationRun, setConsolidationRun] = useState(null);
  const [loadingConsolidation, setLoadingConsolidation] = useState(false);
  const [loadingConsolidationQueue, setLoadingConsolidationQueue] = useState(false);
  const [consolidationQueueSummary, setConsolidationQueueSummary] = useState({
    total: 0,
    byKind: {},
    items: [],
  });
  const [startingConsolidation, setStartingConsolidation] = useState(false);
  const [applyingConsolidation, setApplyingConsolidation] = useState(false);
  const [consolidationApplyNotice, setConsolidationApplyNotice] = useState(null);
  const [savingConsolidationItemId, setSavingConsolidationItemId] = useState(null);
  const [consolidationSectionApply, setConsolidationSectionApply] = useState({
    prompt: true,
    skills: true,
    technician_competencies: true,
  });
  const backlogHasLoadedRef = useRef(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const requestedRunId = searchParams.get('run');
  const activeTab = REVIEW_PAGE_TABS.some((tab) => tab.key === requestedTab) ? requestedTab : 'review';
  const effectiveReviewEndDate = reviewMode === 'range' ? reviewEndDate : reviewDate;

  const setActiveTab = useCallback((tabKey) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', tabKey);
    if (tabKey !== 'review') nextParams.delete('run');
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const setSelectedRunUrl = useCallback((id) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', 'review');
    if (id) {
      nextParams.set('run', String(id));
    } else {
      nextParams.delete('run');
    }
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await assignmentAPI.getDailyReviewRuns({
        limit: RUN_HISTORY_PAGE_SIZE,
        offset: runHistoryPage * RUN_HISTORY_PAGE_SIZE,
      });
      const items = res?.items || [];
      setRuns(items);
      setRunsTotal(res?.total || items.length);
      setActiveRun(items.find((item) => ACTIVE_STATUSES.includes(item.status)) || null);
    } catch {
      setRuns([]);
      setRunsTotal(0);
      setActiveRun(null);
    } finally {
      setLoadingRuns(false);
    }
  }, [runHistoryPage]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  useEffect(() => {
    if (!activeRun || view === 'live') return;
    const timer = setInterval(loadRuns, 10000);
    return () => clearInterval(timer);
  }, [activeRun, view, loadRuns]);

  const loadBacklog = useCallback(async () => {
    if (backlogHasLoadedRef.current) {
      setRefreshingBacklog(true);
    } else {
      setLoadingBacklog(true);
    }
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
      const baseParams = {
        limit: ['process', 'dev'].includes(backlogKind) ? 250 : 100,
        kind: backlogKind === 'dev' ? 'process' : backlogKind,
        severity: backlogSeverity,
        ...(backlogStartDate ? { startDate: backlogStartDate } : {}),
        ...(backlogEndDate ? { endDate: backlogEndDate } : {}),
        ...(runIdParam ? { runId: runIdParam } : {}),
      };
      const filterForKindTab = (items = []) => {
        if (backlogKind === 'dev') return items.filter(isDevBacklogItem);
        if (backlogKind === 'process') return items.filter((item) => !isDevBacklogItem(item));
        return items;
      };
      const usesClientFilteredTotals = ['process', 'dev'].includes(backlogKind);
      if (backlogStatus === 'pending') {
        const [pendingRes, approvedRes] = await Promise.all([
          assignmentAPI.getDailyReviewRecommendations({ ...baseParams, status: 'pending' }),
          assignmentAPI.getDailyReviewRecommendations({ ...baseParams, status: 'approved' }),
        ]);
        const pendingItems = filterForKindTab(pendingRes?.items || []);
        const approvedItems = filterForKindTab(approvedRes?.items || []);
        setPendingBacklogItems(pendingItems);
        setPendingBacklogTotal(usesClientFilteredTotals ? pendingItems.length : pendingRes?.total || 0);
        setApprovedBacklogItems(approvedItems);
        setApprovedBacklogTotal(usesClientFilteredTotals ? approvedItems.length : approvedRes?.total || 0);
        setBacklogItems(backlogKind === 'dev' ? [...pendingItems, ...approvedItems] : pendingItems);
        setBacklogTotal(usesClientFilteredTotals
          ? pendingItems.length + approvedItems.length
          : (pendingRes?.total || 0) + (approvedRes?.total || 0));
        return;
      }

      const res = await assignmentAPI.getDailyReviewRecommendations({
        ...baseParams,
        status: backlogStatus,
      });
      const filteredItems = filterForKindTab(res?.items || []);
      setBacklogItems(filteredItems);
      setBacklogTotal(usesClientFilteredTotals ? filteredItems.length : res?.total || 0);
      setPendingBacklogItems([]);
      setPendingBacklogTotal(0);
      setApprovedBacklogItems(backlogStatus === 'approved' ? filteredItems : []);
      setApprovedBacklogTotal(backlogStatus === 'approved'
        ? (usesClientFilteredTotals ? filteredItems.length : res?.total || 0)
        : 0);
    } catch {
      setBacklogItems([]);
      setPendingBacklogItems([]);
      setApprovedBacklogItems([]);
      setBacklogTotal(0);
      setPendingBacklogTotal(0);
      setApprovedBacklogTotal(0);
    } finally {
      backlogHasLoadedRef.current = true;
      setLoadingBacklog(false);
      setRefreshingBacklog(false);
    }
  }, [
    backlogEndDate,
    backlogKind,
    backlogRunFilter,
    backlogSeverity,
    backlogStartDate,
    backlogStatus,
  ]);

  const loadConsolidation = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoadingConsolidation(true);
    try {
      const res = await assignmentAPI.getDailyReviewConsolidationActive();
      setConsolidationRun(res?.data || null);
    } catch {
      setConsolidationRun(null);
    } finally {
      if (!quiet) setLoadingConsolidation(false);
    }
  }, []);

  const loadConsolidationQueue = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoadingConsolidationQueue(true);
    try {
      const [promptRes, skillRes, processRes] = await Promise.all([
        assignmentAPI.getDailyReviewRecommendations({ status: 'approved', kind: 'prompt', limit: 100 }),
        assignmentAPI.getDailyReviewRecommendations({ status: 'approved', kind: 'skill', limit: 100 }),
        assignmentAPI.getDailyReviewRecommendations({ status: 'approved', kind: 'process', limit: 100 }),
      ]);
      const byKind = {
        prompt: { total: promptRes?.total || 0, items: promptRes?.items || [] },
        skill: { total: skillRes?.total || 0, items: skillRes?.items || [] },
        process: { total: processRes?.total || 0, items: processRes?.items || [] },
      };
      const items = [...byKind.prompt.items, ...byKind.skill.items, ...byKind.process.items]
        .sort((a, b) => {
          const aTime = new Date(a.reviewedAt || a.createdAt || a.reviewDate || 0).getTime();
          const bTime = new Date(b.reviewedAt || b.createdAt || b.reviewDate || 0).getTime();
          return bTime - aTime;
        })
        .slice(0, 8);
      setConsolidationQueueSummary({
        total: byKind.prompt.total + byKind.skill.total + byKind.process.total,
        byKind,
        items,
      });
    } catch {
      setConsolidationQueueSummary({ total: 0, byKind: {}, items: [] });
    } finally {
      if (!quiet) setLoadingConsolidationQueue(false);
    }
  }, []);

  useEffect(() => { loadBacklog(); }, [loadBacklog]);
  useEffect(() => { loadConsolidation(); }, [loadConsolidation]);
  useEffect(() => { loadConsolidationQueue(); }, [loadConsolidationQueue]);

  useEffect(() => {
    if (!consolidationRun || !CONSOLIDATION_ACTIVE_STATUSES.includes(consolidationRun.status)) return undefined;
    const timer = setInterval(() => loadConsolidation({ quiet: true }), 1800);
    return () => clearInterval(timer);
  }, [consolidationRun, loadConsolidation]);

  const loadRunDetail = useCallback(async (id, { openView = true } = {}) => {
    setLoadingDetail(true);
    try {
      const res = await assignmentAPI.getDailyReviewRun(id);
      setSelectedRun(res?.data || null);
      if (openView) {
        setView('detail');
        setSelectedRunUrl(id);
      }
    } catch {
      setSelectedRun(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [setSelectedRunUrl]);

  useEffect(() => {
    if (activeTab !== 'review' || !requestedRunId) return;
    const runId = Number.parseInt(requestedRunId, 10);
    if (!Number.isFinite(runId)) return;
    if (loadingDetail) return;
    if (selectedRun?.id === runId && view === 'detail') return;
    loadRunDetail(runId, { openView: false });
    setView('detail');
  }, [activeTab, loadRunDetail, loadingDetail, requestedRunId, selectedRun?.id, view]);

  const updateRecommendationInSelectedRun = useCallback((updatedItem) => {
    if (!updatedItem?.id) return;
    const updateList = (items = []) => items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
    setSelectedRun((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        promptRecommendations: updateList(prev.promptRecommendations),
        processRecommendations: updateList(prev.processRecommendations),
        skillRecommendations: updateList(prev.skillRecommendations),
      };
    });
  }, []);

  const updateRecommendationLists = useCallback((updatedItem) => {
    if (!updatedItem?.id) return;
    const id = updatedItem.id;
    const removeById = (items = []) => items.filter((item) => item.id !== id);
    const replaceById = (items = []) => items.map((item) => (item.id === id ? updatedItem : item));
    const containsId = (items = []) => items.some((item) => item.id === id);
    const wasPending = containsId(pendingBacklogItems);
    const wasApproved = containsId(approvedBacklogItems);
    const wasInGenericList = containsId(backlogItems);

    if (updatedItem.status === 'approved') {
      setPendingBacklogItems((prev) => removeById(prev));
      setApprovedBacklogItems((prev) => (containsId(prev) ? replaceById(prev) : [updatedItem, ...prev]));
      if (wasPending) {
        setPendingBacklogTotal((prev) => Math.max(0, prev - 1));
        setApprovedBacklogTotal((prev) => prev + 1);
      }
    } else if (updatedItem.status === 'applied') {
      setApprovedBacklogItems((prev) => removeById(prev));
      if (wasApproved) setApprovedBacklogTotal((prev) => Math.max(0, prev - 1));
    } else if (updatedItem.status === 'rejected') {
      setPendingBacklogItems((prev) => removeById(prev));
      if (wasPending) setPendingBacklogTotal((prev) => Math.max(0, prev - 1));
    } else if (updatedItem.status === 'pending') {
      setApprovedBacklogItems((prev) => removeById(prev));
      setPendingBacklogItems((prev) => (containsId(prev) ? replaceById(prev) : [updatedItem, ...prev]));
      if (wasApproved) {
        setApprovedBacklogTotal((prev) => Math.max(0, prev - 1));
        setPendingBacklogTotal((prev) => prev + 1);
      }
    }

    if (backlogStatus === 'pending') {
      setBacklogTotal((prev) => {
        if (wasPending && updatedItem.status === 'rejected') return Math.max(0, prev - 1);
        if (wasApproved && updatedItem.status === 'applied') return Math.max(0, prev - 1);
        return prev;
      });
    } else if (backlogStatus === 'all') {
      setBacklogItems((prev) => (containsId(prev) ? replaceById(prev) : prev));
    } else if (backlogStatus === updatedItem.status) {
      setBacklogItems((prev) => (containsId(prev) ? replaceById(prev) : [updatedItem, ...prev]));
    } else {
      setBacklogItems((prev) => removeById(prev));
      if (wasInGenericList) setBacklogTotal((prev) => Math.max(0, prev - 1));
    }
  }, [approvedBacklogItems, backlogItems, backlogStatus, pendingBacklogItems]);

  const handleRecommendationAction = async (recommendationId, status, reviewNotes) => {
    setSavingRecommendationId(recommendationId);
    try {
      const res = await assignmentAPI.updateDailyReviewRecommendationStatus(recommendationId, { status, reviewNotes });
      const updatedItem = res?.data;
      setBacklogMotionById((prev) => ({ ...prev, [recommendationId]: 'leaving' }));
      await wait(180);
      updateRecommendationLists(updatedItem);
      updateRecommendationInSelectedRun(updatedItem);
      setBacklogMotionById((prev) => ({ ...prev, [recommendationId]: 'entering' }));
      setTimeout(() => {
        setBacklogMotionById((prev) => {
          const next = { ...prev };
          delete next[recommendationId];
          return next;
        });
      }, 650);
      loadConsolidation({ quiet: true });
      loadConsolidationQueue({ quiet: true });
    } catch {
      /* ignore */
    } finally {
      setSavingRecommendationId(null);
    }
  };

  const handleStartConsolidation = async () => {
    setStartingConsolidation(true);
    try {
      const res = await assignmentAPI.startDailyReviewConsolidation();
      setConsolidationRun(res?.data || null);
      await Promise.all([
        loadConsolidation({ quiet: true }),
        loadConsolidationQueue({ quiet: true }),
      ]);
    } catch {
      /* ignore */
    } finally {
      setStartingConsolidation(false);
    }
  };

  const handleSaveConsolidationItem = async (itemId, data) => {
    setSavingConsolidationItemId(itemId);
    try {
      await assignmentAPI.updateDailyReviewConsolidationItem(itemId, data);
      const runId = consolidationRun?.id;
      if (runId) {
        const res = await assignmentAPI.getDailyReviewConsolidationRun(runId);
        setConsolidationRun(res?.data || null);
      }
    } catch {
      /* ignore */
    } finally {
      setSavingConsolidationItemId(null);
    }
  };

  const handleApplyConsolidation = async () => {
    if (!consolidationRun?.id) return;
    const selectedSections = {
      prompt: consolidationSectionApply.prompt !== false,
      skills: consolidationSectionApply.skills !== false,
      technician_competencies: consolidationSectionApply.technician_competencies !== false,
    };
    const sectionLabels = {
      prompt: 'prompt',
      skills: 'skill',
      technician_competencies: 'technician skill',
    };
    const itemsToApply = (consolidationRun.items || []).filter((item) => (
      selectedSections[item.section]
      && item.includeInApply
      && item.status !== 'applied'
      && ['prompt', 'skills', 'technician_competencies'].includes(item.section)
    ));
    const countsBySection = itemsToApply.reduce((acc, item) => {
      acc[item.section] = (acc[item.section] || 0) + 1;
      return acc;
    }, {});
    setApplyingConsolidation(true);
    try {
      const runId = consolidationRun.id;
      await assignmentAPI.applyDailyReviewConsolidation(runId, {
        applyPrompt: selectedSections.prompt,
        applySkills: selectedSections.skills,
        applyTechnicianCompetencies: selectedSections.technician_competencies,
      });
      const refreshedRun = await assignmentAPI.getDailyReviewConsolidationRun(runId);
      setConsolidationRun(refreshedRun?.data || null);
      const summary = Object.entries(countsBySection)
        .filter(([, count]) => count > 0)
        .map(([section, count]) => `${count} ${sectionLabels[section]}${count === 1 ? '' : 's'}`)
        .join(' · ');
      setConsolidationApplyNotice({
        id: Date.now(),
        runId,
        total: itemsToApply.length,
        summary: summary ? `${summary} applied. Approved backlog and queue counts were refreshed.` : 'No pending applyable items were selected.',
      });
      await Promise.all([
        loadBacklog(),
        loadRuns(),
        loadConsolidationQueue({ quiet: true }),
      ]);
    } catch {
      /* ignore */
    } finally {
      setApplyingConsolidation(false);
    }
  };

  const handleConsolidationSectionApplyChange = (section, checked) => {
    setConsolidationSectionApply((prev) => ({ ...prev, [section]: checked }));
  };

  const handleCancelConsolidation = async () => {
    if (!consolidationRun?.id) return;
    try {
      const res = await assignmentAPI.cancelDailyReviewConsolidation(consolidationRun.id);
      setConsolidationRun(res?.data || null);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteConsolidation = async () => {
    if (!consolidationRun?.id) return;
    try {
      await assignmentAPI.deleteDailyReviewConsolidation(consolidationRun.id);
      await Promise.all([
        loadConsolidation({ quiet: true }),
        loadConsolidationQueue({ quiet: true }),
      ]);
    } catch {
      /* ignore */
    }
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

  const handleDeleteDailyReviewRun = async () => {
    if (!runDeleteConfirm?.id) return;
    setDeletingDailyReviewRun(true);
    try {
      await assignmentAPI.deleteDailyReviewRun(runDeleteConfirm.id);
      if (selectedRun?.id === runDeleteConfirm.id) {
        setSelectedRun(null);
        setView('trigger');
        setSelectedRunUrl(null);
      }
      setRunDeleteConfirm(null);
      await Promise.all([
        loadRuns(),
        loadBacklog(),
        loadConsolidation({ quiet: true }),
        loadConsolidationQueue({ quiet: true }),
      ]);
    } catch {
      /* ignore */
    } finally {
      setDeletingDailyReviewRun(false);
    }
  };

  if (view === 'live') {
    return (
      <div>
        <button
          onClick={() => { setView('trigger'); loadRuns(); }}
          className="mb-3 flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Review
        </button>
        <LiveDailyReviewView
          reviewDate={reviewDate}
          reviewStartDate={reviewDate}
          reviewEndDate={effectiveReviewEndDate}
          forceRefreshThreads={forceRefreshThreads}
          onComplete={async (runId) => {
            await loadRuns();
            if (runId) await loadRunDetail(runId);
          }}
          onFinished={async () => {
            await Promise.all([loadRuns(), loadBacklog(), loadConsolidationQueue({ quiet: true })]);
          }}
        />
      </div>
    );
  }

  if (view === 'detail' && loadingDetail && !selectedRun) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading review...
      </div>
    );
  }

  if (view === 'detail' && selectedRun) {
    return (
      <div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={() => { setSelectedRun(null); setView('trigger'); setSelectedRunUrl(null); }}
            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Review
          </button>
          <button
            onClick={() => navigate('/assignments/history')}
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          >
            Assignment History <ExternalLink className="h-4 w-4" />
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
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <div className="grid min-w-[520px] grid-cols-3 gap-1 sm:min-w-0">
          {REVIEW_PAGE_TABS.map(({ key, label, icon: Icon }) => {
            const isActiveTab = activeTab === key;
            const badge = key === 'backlog'
              ? (backlogStatus === 'pending' ? pendingBacklogTotal + approvedBacklogTotal : backlogTotal)
              : key === 'consolidation'
                ? consolidationQueueSummary.total
                : activeRun ? 1 : null;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
                  isActiveTab
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {badge != null && badge > 0 && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    isActiveTab ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                  }`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'review' && (
        <div>
          <h3 className="text-lg font-semibold text-slate-800 mb-1 flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-indigo-600" />
          Review
          </h3>
          <p className="text-sm text-slate-500 mb-4">
          Review assignment outcomes and generate prompt, process, and skill-matrix recommendations.
          </p>

          {activeRun && (
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="flex items-center gap-3">
                <Brain className="h-5 w-5 animate-spin text-indigo-600" />
                <div>
                  <div className="text-sm font-semibold text-indigo-800">Run #{activeRun.id} in progress</div>
                  <div className="text-xs text-indigo-500">
                    {formatReviewRunDateLabel(activeRun, workspaceTimezone)} · {activeRun.status.replace(/_/g, ' ')}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                <button onClick={() => loadRunDetail(activeRun.id)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700">
                View Progress
                </button>
                <button onClick={(e) => cancelRun(e, activeRun.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50">
                Cancel
                </button>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50 p-3 sm:p-4">
            <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:flex xl:items-end">
              <div className="w-full xl:w-auto">
                <label className="block text-xs text-slate-600 font-medium mb-1">Mode</label>
                <div className="flex w-full rounded-lg border border-indigo-200 bg-white p-1 text-xs font-semibold text-slate-600 xl:inline-flex xl:w-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setReviewMode('single');
                      setReviewEndDate(reviewDate);
                    }}
                    className={`flex-1 rounded-md px-3 py-1.5 transition-colors xl:flex-none ${reviewMode === 'single' ? 'bg-indigo-600 text-white shadow-sm' : 'hover:bg-indigo-50'}`}
                  >
                  One day
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewMode('range');
                      setReviewEndDate((prev) => prev || reviewDate);
                    }}
                    className={`flex-1 rounded-md px-3 py-1.5 transition-colors xl:flex-none ${reviewMode === 'range' ? 'bg-indigo-600 text-white shadow-sm' : 'hover:bg-indigo-50'}`}
                  >
                  Range
                  </button>
                </div>
              </div>
              <div className="w-full xl:w-auto">
                <label className="block text-xs text-slate-600 font-medium mb-1">{reviewMode === 'range' ? 'Start Date' : 'Review Date'}</label>
                <input
                  type="date"
                  value={reviewDate}
                  onChange={(e) => {
                    setReviewDate(e.target.value);
                    if (reviewMode === 'single') setReviewEndDate(e.target.value);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              {reviewMode === 'range' && (
                <div className="w-full xl:w-auto">
                  <label className="block text-xs text-slate-600 font-medium mb-1">End Date</label>
                  <input
                    type="date"
                    value={reviewEndDate}
                    onChange={(e) => setReviewEndDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              )}
              <button
                onClick={() => {
                  const today = formatDateLocal(new Date());
                  setReviewDate(today);
                  setReviewEndDate(today);
                }}
                className="w-full rounded-lg border border-indigo-200 bg-white px-2.5 py-2 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 sm:w-auto"
              >
                  Today
              </button>
              <button
                onClick={() => setView('live')}
                disabled={!reviewDate || (reviewMode === 'range' && !reviewEndDate)}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:from-indigo-700 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                <Play className="h-3.5 w-3.5" />
                  Run Review
              </button>
              <label className="inline-flex w-full cursor-pointer items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs text-slate-700 sm:col-span-2 xl:ml-auto xl:w-auto">
                <input
                  type="checkbox"
                  checked={forceRefreshThreads}
                  onChange={(e) => setForceRefreshThreads(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>
                  <span className="font-medium text-slate-800">Force Refresh Tickets</span>
                  <span className="ml-1 text-slate-500">(slower)</span>
                </span>
              </label>
            </div>

            <DailyReviewHistoryPanel
              runs={runs}
              total={runsTotal}
              page={runHistoryPage}
              pageSize={RUN_HISTORY_PAGE_SIZE}
              loadingRuns={loadingRuns}
              loadingDetail={loadingDetail}
              workspaceTimezone={workspaceTimezone}
              onRefresh={loadRuns}
              onOpenRun={loadRunDetail}
              onCancelRun={cancelRun}
              onRequestDeleteRun={setRunDeleteConfirm}
              onPageChange={setRunHistoryPage}
            />
          </div>
        </div>
      )}

      {activeTab === 'consolidation' && (
        <ConsolidationPanel
          run={consolidationRun}
          loading={loadingConsolidation}
          applyNotice={consolidationApplyNotice}
          queueSummary={consolidationQueueSummary}
          queueLoading={loadingConsolidationQueue}
          starting={startingConsolidation}
          applying={applyingConsolidation}
          savingItemId={savingConsolidationItemId}
          sectionApply={consolidationSectionApply}
          onSectionApplyChange={handleConsolidationSectionApplyChange}
          onStart={handleStartConsolidation}
          onRefresh={() => {
            loadConsolidation();
            loadConsolidationQueue();
          }}
          onSaveItem={handleSaveConsolidationItem}
          onApply={handleApplyConsolidation}
          onCancel={handleCancelConsolidation}
          onDelete={handleDeleteConsolidation}
          onDismissApplyNotice={() => setConsolidationApplyNotice(null)}
        />
      )}

      {runDeleteConfirm && (
        <DeleteRunConfirmModal
          run={runDeleteConfirm}
          deleting={deletingDailyReviewRun}
          title="Delete review run?"
          message={`This will delete Run #${runDeleteConfirm.id}, its analysis output, and its saved recommendation backlog items. This cannot be undone.`}
          onCancel={() => setRunDeleteConfirm(null)}
          onConfirm={handleDeleteDailyReviewRun}
        />
      )}

      {activeTab === 'backlog' && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-800">Recommendation Backlog</h3>
              <p className="text-sm text-slate-500">
                Review persisted recommendation items across runs and move them through pending, approved, rejected, and applied.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {refreshingBacklog && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-600">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating
                </span>
              )}
              <button onClick={loadBacklog} className="text-xs text-blue-600 hover:text-blue-800">
                Refresh
              </button>
            </div>
          </div>

          <div className="mb-4 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1">
            <div className="grid min-w-[560px] grid-cols-4 gap-1 sm:min-w-0">
              {BACKLOG_KIND_TABS.map(({ key, label, icon: Icon, visibilityOnly }) => {
                const selectedKind = backlogKind === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setBacklogKind(key);
                      setBacklogStatus(key === 'dev' ? 'all' : 'pending');
                    }}
                    className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                      selectedKind
                        ? visibilityOnly
                          ? 'bg-amber-100 text-amber-800 shadow-sm ring-1 ring-amber-200'
                          : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                        : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                    {visibilityOnly && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                        selectedKind ? 'bg-white/70 text-amber-700' : 'bg-amber-50 text-amber-600'
                      }`}>
                        read
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:flex xl:items-end">
            <div className="w-full xl:w-auto">
              <label className="mb-1 block text-xs font-medium text-slate-600">View</label>
              <select
                value={backlogStatus}
                onChange={(e) => setBacklogStatus(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="pending">Review queue</option>
                <option value="rejected">Rejected</option>
                <option value="applied">Applied</option>
                <option value="all">All</option>
              </select>
            </div>
            <div className="w-full xl:w-auto">
              <label className="mb-1 block text-xs font-medium text-slate-600">Priority</label>
              <select
                value={backlogSeverity}
                onChange={(e) => setBacklogSeverity(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="w-full xl:w-auto">
              <label className="mb-1 block text-xs font-medium text-slate-600">Start Date</label>
              <input
                type="date"
                value={backlogStartDate}
                onChange={(e) => setBacklogStartDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="w-full xl:w-auto">
              <label className="mb-1 block text-xs font-medium text-slate-600">End Date</label>
              <input
                type="date"
                value={backlogEndDate}
                onChange={(e) => setBacklogEndDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="w-full sm:col-span-2 xl:w-auto">
              <label className="mb-1 block text-xs font-medium text-slate-600">Run</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-1">
                <input
                  type="text"
                  list="daily-review-run-options"
                  value={backlogRunFilter}
                  onChange={(e) => setBacklogRunFilter(e.target.value)}
                  placeholder="All runs"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-56"
                />
                <datalist id="daily-review-run-options">
                  {runs.map((run) => {
                    const dateLabel = formatReviewRunDateLabel(run, workspaceTimezone);
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

          <div className="mb-3 text-xs text-slate-500">
            {backlogKind === 'dev'
              ? `${backlogTotal} dev visibility item(s) matched the current filters. These are not approvable from backlog.`
              : backlogStatus === 'pending'
                ? `Review queue: ${pendingBacklogTotal} pending item(s) on the left, ${approvedBacklogTotal} approved item(s) staged on the right.`
                : `${backlogTotal} item(s) matched the current filters.`}
          </div>

          {loadingBacklog ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading backlog...
            </div>
          ) : (
            <div className={`transition-opacity duration-200 ease-out ${refreshingBacklog ? 'opacity-70' : 'opacity-100'}`}>
              {backlogKind === 'dev' ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-800">Dev Visibility</h4>
                      <p className="text-xs text-slate-500">Engineering or app-change recommendations. Visible here, not approved from backlog.</p>
                    </div>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-amber-700">{backlogTotal}</span>
                  </div>
                  {backlogItems.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-amber-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
                      No dev visibility recommendations matched the current filters.
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
                          readOnly
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : backlogStatus === 'pending' ? (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.12fr),minmax(360px,0.88fr)]">
                  <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-800">Pending Review Queue</h4>
                        <p className="text-xs text-slate-500">Collapsed by default. Approve or reject directly from each row.</p>
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-500">{pendingBacklogTotal}</span>
                    </div>
                    {pendingBacklogItems.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
                    No pending recommendations matched the current filters.
                      </div>
                    ) : (
                      <div className="max-h-[680px] space-y-2 overflow-auto pr-1">
                        {pendingBacklogItems.map((item) => (
                          <BacklogRecommendationRow
                            key={item.id}
                            item={item}
                            workspaceTimezone={workspaceTimezone}
                            onRecommendationAction={handleRecommendationAction}
                            savingRecommendationId={savingRecommendationId}
                            mode="pending"
                            motionState={backlogMotionById[item.id]}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-800">Approved for Consolidation</h4>
                        <p className="text-xs text-slate-500">Grouped by title. Expand to inspect items or mark them applied.</p>
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-emerald-700">{approvedBacklogTotal}</span>
                    </div>
                    {approvedBacklogItems.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-emerald-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
                    No approved recommendations are waiting under these filters.
                      </div>
                    ) : (
                      <div className="max-h-[680px] space-y-2 overflow-auto pr-1">
                        {groupRecommendationsByTitle(approvedBacklogItems).map((group) => (
                          <ApprovedBacklogGroup
                            key={group.title}
                            group={group}
                            workspaceTimezone={workspaceTimezone}
                            onRecommendationAction={handleRecommendationAction}
                            savingRecommendationId={savingRecommendationId}
                            motionById={backlogMotionById}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : backlogStatus === 'approved' ? (
                approvedBacklogItems.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                No approved recommendation items matched the current backlog filters.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {groupRecommendationsByTitle(approvedBacklogItems).map((group) => (
                      <ApprovedBacklogGroup
                        key={group.title}
                        group={group}
                        workspaceTimezone={workspaceTimezone}
                        onRecommendationAction={handleRecommendationAction}
                        savingRecommendationId={savingRecommendationId}
                        motionById={backlogMotionById}
                      />
                    ))}
                  </div>
                )
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
          )}
        </div>
      )}
    </div>
  );
}
