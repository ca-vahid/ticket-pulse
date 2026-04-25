import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignmentAPI } from '../../services/api';
import { formatDateLocal, formatDateOnlyInTimezone, formatDateTimeInTimezone } from '../../utils/dateHelpers';
import {
  Loader2, Brain, CheckCircle, XCircle, History, RefreshCw, Play,
  CalendarDays, FileText, Settings2, Award, ChevronRight, StopCircle,
  ArrowLeft, ExternalLink, Sparkles, Copy, ThumbsUp, AlertTriangle,
  Eye, MessageCircle, TrendingUp, ChevronUp, ChevronDown, Undo2,
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

function RecommendationStatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${RECOMMENDATION_STATUS_STYLES[status] || RECOMMENDATION_STATUS_STYLES.pending}`}>
      {status || 'pending'}
    </span>
  );
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

function getSupportingTicketIds(item) {
  return Array.isArray(item.supportingFreshserviceTicketIds) && item.supportingFreshserviceTicketIds.length > 0
    ? item.supportingFreshserviceTicketIds
    : item.supportingTicketIds;
}

function RecommendationMeta({ item, workspaceTimezone }) {
  const supportTicketIds = getSupportingTicketIds(item);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
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
}) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(item.reviewNotes || '');
  const isSaving = savingRecommendationId === item.id;
  const supportTicketIds = getSupportingTicketIds(item);

  useEffect(() => {
    setNotes(item.reviewNotes || '');
  }, [item.id, item.reviewNotes]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="rounded p-1 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!hideTitle && <div className="truncate text-sm font-semibold text-slate-800">{item.title}</div>}
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              item.severity === 'high'
                ? 'bg-red-100 text-red-700'
                : item.severity === 'medium'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-blue-100 text-blue-700'
            }`}>
              {item.severity || 'low'}
            </span>
          </div>
          <RecommendationMeta item={item} workspaceTimezone={workspaceTimezone} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {mode === 'pending' && (
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
          {mode === 'approved' && (
            <button
              onClick={() => onRecommendationAction?.(item.id, 'applied', notes)}
              disabled={isSaving}
              className="rounded-lg border border-blue-200 bg-blue-50 p-1.5 text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
              title="Mark applied"
            >
              <CheckCircle className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {expanded && (
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
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional review notes"
            className="mt-3 min-h-[64px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
          />
        </div>
      )}
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
}) {
  const [expanded, setExpanded] = useState(false);
  const runs = [...new Set(group.rows.map((item) => item.runId).filter(Boolean))].sort((a, b) => b - a);
  const kinds = [...new Set(group.rows.map((item) => item.kind).filter(Boolean))];
  const ticketCount = group.rows.reduce((sum, item) => sum + (getSupportingTicketIds(item)?.length || 0), 0);
  const hasHigh = group.rows.some((item) => item.severity === 'high');
  const [notesById, setNotesById] = useState({});

  useEffect(() => {
    setNotesById((prev) => {
      const next = { ...prev };
      group.rows.forEach((item) => {
        if (next[item.id] === undefined) next[item.id] = item.reviewNotes || '';
      });
      return next;
    });
  }, [group.rows]);

  return (
    <div className="overflow-hidden rounded-lg border border-emerald-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-emerald-50/50"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-emerald-600" /> : <ChevronRight className="h-4 w-4 shrink-0 text-emerald-600" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{group.title}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span>{group.rows.length} approved</span>
            {kinds.length > 0 && <span>{kinds.join(', ')}</span>}
            {runs.length > 0 && <span>Run {runs.map((runId) => `#${runId}`).join(', ')}</span>}
            {ticketCount > 0 && <span>{ticketCount} ticket{ticketCount === 1 ? '' : 's'}</span>}
          </div>
        </div>
        {hasHigh && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-700">High</span>}
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-emerald-100 bg-slate-50 p-3">
          {group.rows.map((item) => {
            const supportTicketIds = getSupportingTicketIds(item);
            const isSaving = savingRecommendationId === item.id;
            return (
              <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
                {group.rows.length > 1 && (
                  <div className="mb-2 text-sm font-semibold text-slate-800">{item.title}</div>
                )}
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        item.severity === 'high'
                          ? 'bg-red-100 text-red-700'
                          : item.severity === 'medium'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-blue-100 text-blue-700'
                      }`}>
                        {item.severity || 'low'}
                      </span>
                    </div>
                    <RecommendationMeta item={item} workspaceTimezone={workspaceTimezone} />
                  </div>
                  <button
                    onClick={() => onRecommendationAction?.(item.id, 'applied', notesById[item.id] || '')}
                    disabled={isSaving}
                    className="rounded-lg border border-blue-200 bg-blue-50 p-1.5 text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Mark applied"
                  >
                    <CheckCircle className="h-4 w-4" />
                  </button>
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
      )}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 animate-fadeIn">
      <div className="flex max-h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Prompt Diff</h3>
            <p className="text-xs text-slate-500">
              {item.title} · {changedCount} changed line{changedCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={undoDraftChange}
              disabled={!draftHistory.length}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
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

        <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
          <div className="border-r border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Current Prompt</span>
              {diffNavControls}
            </div>
            <div ref={beforePaneRef} className="h-[70vh] overflow-auto bg-white font-mono text-xs leading-relaxed">
              {rows.map((row, index) => {
                const isFirstRemovedBlock = row.type === 'removed' && rows[index - 1]?.type !== 'removed';
                return (
                  <div
                    key={`before-${index}`}
                    data-diff-row={index}
                    className={`grid grid-cols-[48px,1fr,96px] border-b border-slate-100 px-2 py-1 ${
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
            <div ref={afterPaneRef} className="h-[70vh] overflow-auto bg-white font-mono text-xs leading-relaxed">
              {rows.map((row, index) => {
                const isFirstAddedBlock = row.type === 'added' && rows[index - 1]?.type !== 'added';
                return (
                  <div
                    key={`after-${index}`}
                    data-diff-row={index}
                    className={`grid grid-cols-[48px,1fr,112px] border-b border-slate-100 px-2 py-1 ${
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

function DeleteRunConfirmModal({ run, deleting, onCancel, onConfirm }) {
  if (!run) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 animate-fadeIn">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-red-50 p-2 text-red-600">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">Delete consolidation run?</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                This will delete Run #{run.id} and its saved consolidation recommendations. This cannot be undone.
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

function ConsolidationItemCard({ item, onSave, saving, currentPrompt, onOpenPromptDiff }) {
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

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 animate-[fadeIn_200ms_ease-out] transition-all duration-300 ease-out">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-slate-800">{item.title}</div>
            <RecommendationStatusBadge status={item.status} />
            {item.actionType && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">{item.actionType}</span>}
          </div>
          {item.section !== 'prompt' && item.rationale && <div className="mt-1 text-xs text-slate-500">{item.rationale}</div>}
        </div>
        {!isProcess && (
          <div className="flex shrink-0 items-center gap-2">
            {item.section === 'prompt' && (
              <button
                onClick={() => onOpenPromptDiff?.(item)}
                type="button"
                className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!currentPrompt || !payload.updatedPrompt}
              >
                Compare Prompt
              </button>
            )}
            {item.section !== 'prompt' && (
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={includeInApply}
                  disabled={isApplied}
                  onChange={(e) => setIncludeInApply(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                Include
              </label>
            )}
          </div>
        )}
      </div>

      {item.section === 'prompt' && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
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
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600">Action</label>
            <select value={payload.action || 'update'} onChange={(e) => updateField('action', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="add">Add</option>
              <option value="rename">Rename</option>
              <option value="update">Update</option>
              <option value="merge">Merge</option>
              <option value="deprecate">Deprecate</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Skill / Category</label>
            <input value={payload.categoryName || ''} onChange={(e) => updateField('categoryName', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">New Name</label>
            <input value={payload.newName || ''} onChange={(e) => updateField('newName', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Description</label>
            <input value={payload.description || ''} onChange={(e) => updateField('description', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
        </div>
      )}

      {item.section === 'technician_competencies' && (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600">Technician</label>
            <input value={payload.technicianName || ''} onChange={(e) => updateField('technicianName', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Skill / Category</label>
            <input value={payload.categoryName || ''} onChange={(e) => updateField('categoryName', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Level</label>
            <select value={payload.proficiencyLevel || 'intermediate'} onChange={(e) => updateField('proficiencyLevel', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="basic">Basic</option>
              <option value="intermediate">Intermediate</option>
              <option value="expert">Expert</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Notes</label>
            <input value={payload.notes || ''} onChange={(e) => updateField('notes', e.target.value)} disabled={isApplied} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
        </div>
      )}

      {item.section === 'process' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">{payload.changeType || 'dev_required'}</div>
          <div className="mt-1 text-xs">{payload.suggestedAction || item.rationale}</div>
        </div>
      )}

      {!isProcess && item.section !== 'prompt' && !isApplied && (
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
}) {
  const [promptDiffItem, setPromptDiffItem] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingRun, setDeletingRun] = useState(false);
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

  const sections = [
    { key: 'prompt', label: 'Prompt Edits', icon: FileText, applyable: true },
    { key: 'skills', label: 'Skill List Changes', icon: Award, applyable: true },
    { key: 'technician_competencies', label: 'Technician Skill Changes', icon: Brain, applyable: true },
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
    <div className="rounded-xl border border-indigo-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            Approved Recommendation Consolidation
          </h3>
          <p className="text-sm text-slate-500">
            Converts approved, unapplied Daily Review findings into editable prompt, skill, competency, and process recommendations.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <span className="relative inline-flex items-center gap-1.5">
              {(starting || isActive) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {starting
                ? 'Starting...'
                : isActive
                  ? `Running ${run?.progress?.percent || 0}%`
                  : 'Consolidate Approved'}
            </span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-sm text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading consolidation...
        </div>
      ) : !hasRun ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          No consolidation run yet.
        </div>
      ) : (
        <div className="space-y-4">
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
              <div key={key} className="rounded-xl border border-slate-200 bg-slate-50 p-3 transition-all duration-300 ease-out">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-slate-500" />
                    <h4 className="text-sm font-semibold text-slate-800">{label}</h4>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{items.length}</span>
                  </div>
                  {applyable && (
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
                      <input
                        type="checkbox"
                        checked={sectionApply[key] !== false}
                        onChange={(e) => onSectionApplyChange(key, e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      Apply this section
                    </label>
                  )}
                  {!applyable && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Dev work only</span>}
                </div>
                {items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-5 text-center text-sm text-slate-400">
                    No {label.toLowerCase()} proposed.
                  </div>
                ) : (
                  <div className="space-y-3 transition-all duration-300 ease-out">
                    {items.map((item) => (
                      <ConsolidationItemCard
                        key={item.id}
                        item={item}
                        saving={savingItemId === item.id}
                        onSave={onSaveItem}
                        currentPrompt={currentPrompt}
                        onOpenPromptDiff={setPromptDiffItem}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {['completed', 'partially_applied'].includes(run.status) && (
            <div className="flex justify-end">
              <button
                onClick={onApply}
                disabled={applying}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
              >
                {applying ? 'Applying...' : 'Apply Selected Sections'}
              </button>
            </div>
          )}
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
  const dateLabel = formatDateOnlyInTimezone(run.reviewDate, workspaceTimezone);
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
    <div className="rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50 to-indigo-50 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <h3 className="text-base font-semibold text-purple-900">Meeting Briefing</h3>
          {localBriefing && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
              Ready
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {localBriefing && (
            <button
              type="button"
              onClick={copyAsMarkdown}
              className="inline-flex items-center gap-1 rounded-lg border border-purple-200 bg-white px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-50"
            >
              <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied!' : 'Copy as Markdown'}
            </button>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={!isCompleted || generating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:from-purple-700 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
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
          The meeting briefing can be generated once the daily review reaches the <strong>completed</strong> status.
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
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Collection Diagnostics</h3>
        <div className="text-xs text-slate-500">What the LLM actually had to read</div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
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

      <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 md:grid-cols-4">
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
          {ticketsWithoutContext} ticket(s) reached the LLM with no thread context (no activities and no conversations). The model had only metadata for these. Try the <strong>Force refresh from FreshService</strong> option on a rerun.
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

      <CollectionDiagnosticsSection summary={summary} />

      <MeetingBriefingSection run={run} workspaceTimezone={workspaceTimezone} />

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

function LiveDailyReviewView({ reviewDate, forceRefreshThreads = false, onComplete }) {
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
    startedAtRef.current = Date.now();
    setStatus('starting');
    setElapsedSec(0);
    setError(null);
    setRunId(null);
    setPhase(null);
    setPhaseMessage('Queuing daily review on the server...');
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
        setError(row.errorMessage || 'Daily review failed');
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
          force: true,
          forceRefreshThreads,
        });
        const row = res?.data;
        if (cancelled) return;
        const id = row?.id;
        if (!id) throw new Error('Server did not return a run id');
        setRunId(id);
        appendActivity(`Started daily review run #${id}.`, 'started');
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
        setError(err?.message || 'Failed to start daily review');
        appendActivity(err?.message || 'Failed to start daily review', 'error');
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewDate, forceRefreshThreads]);

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
      }).catch(() => { /* non-fatal */ });
    }
  }, [status, runId]);

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
          {(status === 'running' || status === 'starting') && runId && (
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
  const [forceRefreshThreads, setForceRefreshThreads] = useState(false);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingRecommendationId, setSavingRecommendationId] = useState(null);
  const [backlogItems, setBacklogItems] = useState([]);
  const [pendingBacklogItems, setPendingBacklogItems] = useState([]);
  const [approvedBacklogItems, setApprovedBacklogItems] = useState([]);
  const [backlogTotal, setBacklogTotal] = useState(0);
  const [pendingBacklogTotal, setPendingBacklogTotal] = useState(0);
  const [approvedBacklogTotal, setApprovedBacklogTotal] = useState(0);
  const [loadingBacklog, setLoadingBacklog] = useState(false);
  const [backlogStatus, setBacklogStatus] = useState('pending');
  const [backlogKind, setBacklogKind] = useState('all');
  const [backlogSeverity, setBacklogSeverity] = useState('all');
  const [backlogStartDate, setBacklogStartDate] = useState('');
  const [backlogEndDate, setBacklogEndDate] = useState('');
  const [backlogRunFilter, setBacklogRunFilter] = useState('');
  const [consolidationRun, setConsolidationRun] = useState(null);
  const [loadingConsolidation, setLoadingConsolidation] = useState(false);
  const [startingConsolidation, setStartingConsolidation] = useState(false);
  const [applyingConsolidation, setApplyingConsolidation] = useState(false);
  const [savingConsolidationItemId, setSavingConsolidationItemId] = useState(null);
  const [consolidationSectionApply, setConsolidationSectionApply] = useState({
    prompt: true,
    skills: true,
    technician_competencies: true,
  });
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
      const baseParams = {
        limit: 100,
        kind: backlogKind,
        severity: backlogSeverity,
        ...(backlogStartDate ? { startDate: backlogStartDate } : {}),
        ...(backlogEndDate ? { endDate: backlogEndDate } : {}),
        ...(runIdParam ? { runId: runIdParam } : {}),
      };
      if (backlogStatus === 'pending') {
        const [pendingRes, approvedRes] = await Promise.all([
          assignmentAPI.getDailyReviewRecommendations({ ...baseParams, status: 'pending' }),
          assignmentAPI.getDailyReviewRecommendations({ ...baseParams, status: 'approved' }),
        ]);
        setPendingBacklogItems(pendingRes?.items || []);
        setPendingBacklogTotal(pendingRes?.total || 0);
        setApprovedBacklogItems(approvedRes?.items || []);
        setApprovedBacklogTotal(approvedRes?.total || 0);
        setBacklogItems(pendingRes?.items || []);
        setBacklogTotal((pendingRes?.total || 0) + (approvedRes?.total || 0));
        return;
      }

      const res = await assignmentAPI.getDailyReviewRecommendations({
        ...baseParams,
        status: backlogStatus,
      });
      setBacklogItems(res?.items || []);
      setBacklogTotal(res?.total || 0);
      setPendingBacklogItems([]);
      setPendingBacklogTotal(0);
      setApprovedBacklogItems(backlogStatus === 'approved' ? (res?.items || []) : []);
      setApprovedBacklogTotal(backlogStatus === 'approved' ? (res?.total || 0) : 0);
    } catch {
      setBacklogItems([]);
      setPendingBacklogItems([]);
      setApprovedBacklogItems([]);
      setBacklogTotal(0);
      setPendingBacklogTotal(0);
      setApprovedBacklogTotal(0);
    } finally {
      setLoadingBacklog(false);
    }
  }, [backlogEndDate, backlogKind, backlogRunFilter, backlogSeverity, backlogStartDate, backlogStatus]);

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

  useEffect(() => { loadBacklog(); }, [loadBacklog]);
  useEffect(() => { loadConsolidation(); }, [loadConsolidation]);

  useEffect(() => {
    if (!consolidationRun || !CONSOLIDATION_ACTIVE_STATUSES.includes(consolidationRun.status)) return undefined;
    const timer = setInterval(() => loadConsolidation({ quiet: true }), 1800);
    return () => clearInterval(timer);
  }, [consolidationRun, loadConsolidation]);

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
      await Promise.all([loadRuns(), loadBacklog(), loadConsolidation({ quiet: true })]);
      if (selectedRun?.id && view === 'detail') {
        await loadRunDetail(selectedRun.id, { openView: false });
      }
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
      await loadConsolidation({ quiet: true });
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
    setApplyingConsolidation(true);
    try {
      const res = await assignmentAPI.applyDailyReviewConsolidation(consolidationRun.id, {
        applyPrompt: consolidationSectionApply.prompt !== false,
        applySkills: consolidationSectionApply.skills !== false,
        applyTechnicianCompetencies: consolidationSectionApply.technician_competencies !== false,
      });
      setConsolidationRun(res?.data || null);
      await Promise.all([loadBacklog(), loadRuns()]);
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
      await loadConsolidation({ quiet: true });
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

  if (view === 'live') {
    return (
      <div>
        <button onClick={() => { setView('trigger'); loadRuns(); }} className="text-sm text-blue-600 hover:text-blue-800 mb-3 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Daily Review
        </button>
        <LiveDailyReviewView reviewDate={reviewDate} forceRefreshThreads={forceRefreshThreads} onComplete={async (runId) => {
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
            <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={forceRefreshThreads}
                onChange={(e) => setForceRefreshThreads(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>
                <span className="font-medium text-slate-800">Force refresh from FreshService</span>
                <span className="ml-1 text-slate-500">(bypass local cache; slower but pulls latest replies/notes)</span>
              </span>
            </label>
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

      <ConsolidationPanel
        run={consolidationRun}
        loading={loadingConsolidation}
        starting={startingConsolidation}
        applying={applyingConsolidation}
        savingItemId={savingConsolidationItemId}
        sectionApply={consolidationSectionApply}
        onSectionApplyChange={handleConsolidationSectionApplyChange}
        onStart={handleStartConsolidation}
        onRefresh={() => loadConsolidation()}
        onSaveItem={handleSaveConsolidationItem}
        onApply={handleApplyConsolidation}
        onCancel={handleCancelConsolidation}
        onDelete={handleDeleteConsolidation}
      />

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
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {runs.map((run) => {
              const totals = run.summaryMetrics?.totals || {};
              const isActiveStatus = ACTIVE_STATUSES.includes(run.status);
              return (
                <button
                  key={run.id}
                  onClick={() => loadRunDetail(run.id)}
                  disabled={loadingDetail}
                  className="group flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-indigo-50/40 disabled:cursor-wait"
                >
                  <div className="min-w-0 flex-1">
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
                      <span className="text-slate-500">{formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}</span>
                      {run.triggeredBy && (
                        <>
                          <span className="text-slate-300">•</span>
                          <span className="max-w-[220px] truncate text-slate-500">{run.triggeredBy}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-slate-500">
                    {totals.totalTicketsReviewed != null && <span className="tabular-nums">{totals.totalTicketsReviewed}</span>}
                    {totals.totalTicketsReviewed != null && <span className="text-slate-300">tickets</span>}
                    {totals.success != null && <span className="font-medium tabular-nums text-emerald-600">{totals.success} ✓</span>}
                    {totals.failure != null && <span className="font-medium tabular-nums text-red-600">{totals.failure} ✕</span>}
                    {isActiveStatus && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => cancelRun(e, run.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') cancelRun(e, run.id);
                        }}
                        className="rounded px-2 py-1 text-red-600 hover:bg-red-50"
                        title="Cancel this run"
                      >
                        <StopCircle className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-slate-300 transition-colors group-hover:text-indigo-500" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

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
              <label className="mb-1 block text-xs font-medium text-slate-600">Priority</label>
              <select
                value={backlogSeverity}
                onChange={(e) => setBacklogSeverity(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
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

          <div className="mb-3 text-xs text-slate-500">
            {backlogStatus === 'pending'
              ? `${pendingBacklogTotal} pending item(s) and ${approvedBacklogTotal} approved item(s) matched the current filters.`
              : `${backlogTotal} item(s) matched the current filters.`}
          </div>

          {loadingBacklog ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading backlog...
            </div>
          ) : backlogStatus === 'pending' ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.12fr),minmax(360px,0.88fr)]">
              <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
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
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="min-w-0 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
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
    </div>
  );
}
