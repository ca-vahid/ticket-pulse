import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatInTimeZone } from 'date-fns-tz';
import { assignmentAPI, workspaceAPI, syncAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import PipelineRunDetail from '../components/assignment/PipelineRunDetail';
import CompetencyManager from '../components/assignment/CompetencyManager';
import CalibrationManager from '../components/assignment/CalibrationManager';
import DailyReviewManager from '../components/assignment/DailyReviewManager';
import PromptManager from '../components/assignment/PromptManager';
import { formatDateTimeInTimezone } from '../utils/dateHelpers';
import LivePipelineView from '../components/assignment/LivePipelineView';
import {
  ArrowLeft, Inbox, History, Settings2, Award, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, ChevronDown, ToggleLeft, ToggleRight, AlertCircle,
  Play, Search, Mail, Zap, FileText, Trash2, XCircle, RotateCcw, Brain,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, Save, Check, TrendingUp,
  ShieldCheck, Users, Bot, Sparkles, Clock, X, CalendarDays,
} from 'lucide-react';

const ALL_TABS = [
  { id: 'queue', label: 'Review Queue', icon: Inbox, minRole: 'reviewer' },
  { id: 'history', label: 'History', icon: History, minRole: 'reviewer' },
  { id: 'daily-review', label: 'Daily Review', icon: CalendarDays, minRole: 'admin' },
  { id: 'calibration', label: 'Calibration', icon: TrendingUp, minRole: 'admin' },
  { id: 'competencies', label: 'Competencies', icon: Award, minRole: 'admin' },
  { id: 'prompts', label: 'Prompts', icon: FileText, minRole: 'admin' },
  { id: 'config', label: 'Configuration', icon: Settings2, minRole: 'admin' },
];

const PACIFIC_TIMEZONE = 'America/Los_Angeles';

function getPacificDayStartISOString(reference = new Date()) {
  const ptDate = formatInTimeZone(reference, PACIFIC_TIMEZONE, 'yyyy-MM-dd');
  return formatInTimeZone(
    new Date(`${ptDate}T12:00:00Z`),
    PACIFIC_TIMEZONE,
    "yyyy-MM-dd'T'00:00:00XXX",
  );
}

function ManualTriggerPanel({ isAdmin = false }) {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [expanded, setExpanded] = useState(false);

  const fetchTickets = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getRecentTickets({ limit: 30, unassigned: showAll ? 'false' : 'true' });
      setTickets(res?.data || []);
    } catch {
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { if (expanded) fetchTickets(); }, [fetchTickets, expanded]);

  if (!isAdmin) {
    return null;
  }

  const handleTrigger = (ticketId) => {
    navigate(`/assignments/live/${ticketId}`);
  };

  const filtered = tickets.filter((t) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      t.subject?.toLowerCase().includes(term) ||
      String(t.freshserviceTicketId).includes(term) ||
      t.requester?.name?.toLowerCase().includes(term) ||
      t.requester?.email?.toLowerCase().includes(term)
    );
  });

  const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

  return (
    <div className="border rounded-lg bg-gray-50 mt-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between p-3 sm:p-4 touch-manipulation text-left hover:bg-gray-100/60 transition-colors"
        aria-expanded={expanded}
      >
        <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Zap className="w-4 h-4" /> Manual Trigger
        </h4>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 transition-transform duration-300 ${expanded ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>

      {/* Smooth collapse using grid-template-rows trick */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 sm:px-4 sm:pb-4">
            <div className="flex items-center justify-end gap-2 mb-3">
              <label className="flex items-center gap-1 text-xs text-gray-500 touch-manipulation">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="rounded w-4 h-4" />
                Assigned
              </label>
              <button onClick={fetchTickets} className="text-xs text-blue-600 hover:underline p-1 touch-manipulation">Refresh</button>
            </div>

            <div className="relative mb-3">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search tickets..."
                className="w-full pl-9 pr-3 py-2.5 sm:py-2 border rounded-lg text-sm bg-white"
              />
            </div>

            {loading ? (
              <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-blue-600" /></div>
            ) : filtered.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">No tickets found.</p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {filtered.map((ticket) => {
                  const hasPipeline = ticket.pipelineRuns?.length > 0;
                  return (
                    <div key={ticket.id} className="flex items-center justify-between bg-white border rounded-lg px-3 py-2.5 sm:py-2 gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">
                          <span className="text-gray-400 font-mono text-xs">#{ticket.freshserviceTicketId}</span>{' '}
                          {ticket.subject || 'No subject'}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {ticket.requester?.name || 'Unknown'}
                          {ticket.assignedTech ? ` · ${ticket.assignedTech.name}` : ''}
                          {' · '}{PRIORITY_LABELS[ticket.priority] || `P${ticket.priority}`}
                        </p>
                      </div>
                      <button
                        onClick={() => handleTrigger(ticket.id)}
                        className={`px-3 py-2 sm:py-1 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors touch-manipulation min-h-[36px] flex-shrink-0 ${
                          hasPipeline
                            ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        {hasPipeline ? <RotateCcw className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                        {hasPipeline ? 'Re-run' : 'Run'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// These three components are defined at module level (outside QueueTab) so their
// identity stays stable across QueueTab re-renders. Defining them inside QueueTab
// would create a new function reference on every render, causing React to unmount +
// remount the component (and lose input focus) each time state changes.

function QuickApproveInner({ run, recs, note, onNoteChange, selectedTechId, onTechSelect, approving, onCancel, onSubmit, techPhotos }) {
  const [showOtherPicker, setShowOtherPicker] = useState(false);
  const [otherSearch, setOtherSearch] = useState('');

  const recTechIds = useMemo(() => new Set(recs.map((r) => r.techId)), [recs]);
  const allTechs = useMemo(() => Object.values(techPhotos || {}), [techPhotos]);
  const otherTechs = useMemo(
    () => allTechs.filter((t) => !recTechIds.has(t.id)).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [allTechs, recTechIds],
  );
  const filteredOthers = useMemo(() => {
    const q = otherSearch.trim().toLowerCase();
    if (!q) return otherTechs;
    return otherTechs.filter(
      (t) => t.name?.toLowerCase().includes(q) || t.location?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q),
    );
  }, [otherTechs, otherSearch]);

  const isOverride = !!selectedTechId && !recTechIds.has(selectedTechId);
  const overrideTech = isOverride ? techPhotos?.[selectedTechId] : null;
  const overrideInitials = overrideTech?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2) || '?';

  const submitDisabled = approving || !selectedTechId || (isOverride && !note.trim());

  return (
    <>
      <div className="px-3 pt-3 pb-1.5 sm:px-3">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Assign to</p>
        <div className="space-y-1 max-h-52 overflow-y-auto">
          {recs.map((r, i) => {
            const isActive = selectedTechId === r.techId;
            const tech = techPhotos[r.techId];
            const initials = r.techName?.split(' ').map((n) => n[0]).join('').slice(0, 2) || '?';
            const pct = typeof r.score === 'number' ? Math.round(r.score * 100) : null;
            return (
              <button
                key={r.techId}
                type="button"
                onClick={() => onTechSelect(r.techId)}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 sm:py-1.5 text-left transition-all touch-manipulation ${isActive ? 'bg-blue-50 ring-1 ring-blue-300' : 'hover:bg-slate-50 active:bg-slate-100'}`}
              >
                {tech?.photoUrl ? (
                  <img src={tech.photoUrl} alt="" className={`w-8 h-8 sm:w-6 sm:h-6 rounded-full object-cover flex-shrink-0 ${isActive ? 'ring-2 ring-blue-400' : ''}`} />
                ) : (
                  <span className={`w-8 h-8 sm:w-6 sm:h-6 rounded-full text-[10px] sm:text-[9px] font-bold flex items-center justify-center flex-shrink-0 ${isActive ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-400' : 'bg-slate-100 text-slate-500'}`}>{initials}</span>
                )}
                <span className={`text-sm sm:text-xs font-medium truncate flex-1 ${isActive ? 'text-blue-900' : 'text-slate-800'}`}>{r.techName}</span>
                {pct !== null && <span className="text-xs sm:text-[10px] tabular-nums text-slate-400">{pct}%</span>}
                {i === 0 && <span className="text-[9px] sm:text-[8px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 sm:px-1 rounded flex-shrink-0">AI</span>}
              </button>
            );
          })}

          {isOverride && overrideTech && (
            <div className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 sm:py-1.5 bg-blue-50 ring-1 ring-blue-300">
              {overrideTech.photoUrl ? (
                <img src={overrideTech.photoUrl} alt="" className="w-8 h-8 sm:w-6 sm:h-6 rounded-full object-cover flex-shrink-0 ring-2 ring-blue-400" />
              ) : (
                <span className="w-8 h-8 sm:w-6 sm:h-6 rounded-full bg-blue-100 text-blue-700 ring-2 ring-blue-400 text-[10px] sm:text-[9px] font-bold flex items-center justify-center flex-shrink-0">{overrideInitials}</span>
              )}
              <span className="text-sm sm:text-xs font-medium truncate flex-1 text-blue-900">{overrideTech.name}</span>
              <span className="text-[9px] sm:text-[8px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-1.5 sm:px-1 rounded flex-shrink-0">Override</span>
            </div>
          )}
        </div>

        {!showOtherPicker ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowOtherPicker(true); }}
            className="mt-2 w-full text-left text-[11px] sm:text-[10px] font-medium text-blue-600 hover:text-blue-700 px-2 py-1.5 sm:py-1 rounded hover:bg-blue-50 transition-colors"
          >
            + Assign to someone else
          </button>
        ) : (
          <div className="mt-2 border border-slate-200 rounded-lg bg-white overflow-hidden shadow-sm">
            <div className="px-2 py-1.5 bg-slate-50 border-b border-slate-200">
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={otherSearch}
                  onChange={(e) => setOtherSearch(e.target.value)}
                  placeholder="Search by name or location..."
                  className="w-full pl-6 pr-2 py-1 text-xs border border-slate-200 rounded bg-white focus:ring-1 focus:ring-blue-200 focus:border-blue-300"
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-36 overflow-y-auto">
              {filteredOthers.map((t) => {
                const isActive = selectedTechId === t.id;
                const initials = t.name?.split(' ').map((n) => n[0]).join('').slice(0, 2) || '?';
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTechSelect(t.id);
                      setShowOtherPicker(false);
                      setOtherSearch('');
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs border-b border-slate-100 last:border-0 transition-colors ${isActive ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                  >
                    {t.photoUrl ? (
                      <img src={t.photoUrl} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold flex items-center justify-center flex-shrink-0">{initials}</span>
                    )}
                    <span className="font-medium text-slate-800 truncate flex-1">{t.name}</span>
                    {t.location && <span className="text-[10px] text-slate-400 truncate flex-shrink-0">{t.location}</span>}
                  </button>
                );
              })}
              {filteredOthers.length === 0 && (
                <div className="px-3 py-3 text-center text-[11px] text-slate-400">No technicians found</div>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowOtherPicker(false); setOtherSearch(''); }}
              className="w-full text-[10px] font-medium text-slate-500 hover:text-slate-700 py-1 border-t border-slate-100"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="px-3 pb-2">
        <input
          type="text"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={isOverride ? 'Why this technician? (required)' : 'Note (optional)'}
          className={`w-full border rounded-lg px-3 py-2.5 sm:py-1.5 text-sm sm:text-xs focus:ring-2 focus:border-blue-300 bg-slate-50 ${isOverride && !note.trim() ? 'border-amber-300 focus:ring-amber-200' : 'border-slate-200 focus:ring-blue-200'}`}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className="border-t border-slate-100 px-3 py-2.5 sm:py-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className="px-3 py-2 sm:py-1.5 text-sm sm:text-[11px] font-medium text-slate-500 hover:text-slate-700 rounded-md hover:bg-slate-50 touch-manipulation"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={(e) => onSubmit(e, run)}
          disabled={submitDisabled}
          className={`px-4 py-2 sm:px-3 sm:py-1.5 text-white rounded-lg sm:rounded-md text-sm sm:text-[11px] font-semibold disabled:opacity-50 transition-colors flex items-center gap-1.5 sm:gap-1 touch-manipulation min-h-[44px] sm:min-h-0 ${isOverride ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'}`}
        >
          {approving ? <Loader2 className="w-4 h-4 sm:w-3 sm:h-3 animate-spin" /> : <Check className="w-4 h-4 sm:w-3 sm:h-3" />}
          {isOverride ? 'Assign' : 'Approve'}
        </button>
      </div>
    </>
  );
}

function QuickApprovePopover({ run, align = 'right', quickApproveId, popoverRef, ...innerProps }) {
  const recs = run.recommendation?.recommendations || [];
  if (quickApproveId !== run.id || !recs.length) return null;
  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      className={`hidden md:block absolute z-50 mt-1 w-72 rounded-lg border border-slate-200 bg-white shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ top: '100%' }}
    >
      <QuickApproveInner run={run} recs={recs} {...innerProps} />
    </div>
  );
}

/**
 * Stat tile for the auto-assign empty-state panel. Big number, small label,
 * subtle icon. Color theming via `tone` so the auto-assigned tile pops while
 * secondary metrics stay quiet.
 */
/**
 * Stat tile for the auto-assign empty-state outcome row.
 *
 * Design notes (per UX redesign in v1.9.83):
 *  - White card with subtle shadow + rounded corners (depth, not flat).
 *  - Color is reserved for the icon chip and accent — body stays neutral so
 *    the cards feel like a unified set rather than a rainbow of pastels.
 *  - Number is the dominant element; label sits above as a small caps label.
 *  - When `onClick` is provided the entire card becomes a button-like
 *    affordance — hover lifts the card slightly so the click target is obvious.
 */
function StatTile({ icon: Icon, label, value, sublabel, tone = 'slate', onClick }) {
  const TONE_CLASSES = {
    blue:    { iconBg: 'bg-blue-50',    iconColor: 'text-blue-600',    accent: 'border-l-blue-500' },
    emerald: { iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600', accent: 'border-l-emerald-500' },
    amber:   { iconBg: 'bg-amber-50',   iconColor: 'text-amber-600',   accent: 'border-l-amber-500' },
    slate:   { iconBg: 'bg-slate-100',  iconColor: 'text-slate-500',   accent: 'border-l-slate-400' },
    rose:    { iconBg: 'bg-rose-50',    iconColor: 'text-rose-600',    accent: 'border-l-rose-500' },
  };
  const t = TONE_CLASSES[tone] || TONE_CLASSES.slate;
  const Comp = onClick ? 'button' : 'div';
  const interactive = onClick
    ? 'text-left cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300'
    : '';
  return (
    <Comp
      onClick={onClick}
      className={`group bg-white border border-slate-200/80 border-l-4 ${t.accent} rounded-2xl p-4 sm:p-5 shadow-sm flex flex-col gap-2 ${interactive}`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${t.iconBg}`}>
          <Icon className={`w-3.5 h-3.5 ${t.iconColor}`} />
        </span>
        <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
        {onClick && <ChevronRight className="ml-auto w-3.5 h-3.5 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>
      <div className="text-3xl sm:text-4xl font-bold tabular-nums leading-none text-slate-900">{value ?? 0}</div>
      {sublabel && <div className="text-[11px] text-slate-500 leading-snug">{sublabel}</div>}
    </Comp>
  );
}

/**
 * Replaces the sad "No tickets awaiting decision" placeholder when auto-assign
 * is on and the queue is genuinely empty. The pipeline is doing its job in the
 * background — show today's stats so the page is informative instead of feeling
 * broken. Also acknowledges that excluded groups (if configured) will still
 * surface tickets here for manual approval.
 */
function AutoAssignActiveEmptyState({ queueStatus, inProgressCount, queuedRunsTotal, onRefresh, onNavigate }) {
  const today = queueStatus?.today || {};
  const stats = {
    autoAssigned: today.autoAssigned || 0,        // decision='auto_assigned' — no human in the loop
    approved: today.approved || 0,                // decision='approved' OR 'modified' — admin clicked approve
    // Pending_review pipeline runs whose ticket later got assignedTechId set
    // (agent grabbed in FS after our analysis). Matches what the "Manually
    // in FreshService" sub-tab shows so click-through count is exact.
    handledInFs: today.handledInFs || 0,
    noiseDismissed: today.noiseDismissed || 0,    // decision='noise_dismissed' (pipeline ran, classified as noise)
    manualReviewRequired: today.manualReviewRequired || 0,
    inProgress: today.inProgress || 0,
    rebounds: today.rebounds || 0,
    noiseFiltered: today.noiseFiltered || 0,      // tickets with isNoise=true — silently skipped by polling
    // Tickets assigned today that NEVER went through our pipeline at all
    // (typically because the agent grabbed them in FS within the 30s
    // window before our next poll). Surfaced as a separate process pill.
    pipelineBypass: today.pipelineBypass || 0,
    totalRuns: today.totalRuns || 0,
  };
  const excludedGroupCount = queueStatus?.excludedGroupCount || 0;
  // Up to 10 recent auto-assignments. Backend returns array; older shape
  // (singular latestAutoAssignment) is no longer sent but the fallback
  // keeps things from crashing if a stale frontend hits an old backend.
  const recent = Array.isArray(today.recentAutoAssignments)
    ? today.recentAutoAssignments
    : (today.latestAutoAssignment ? [today.latestAutoAssignment] : []);
  const dryRun = queueStatus?.dryRunMode;

  // Pill detail modal — none of these three pills (rebounds, bypassed,
  // noise-filtered) have an existing destination tab in the app, so
  // clicking one opens an inline modal listing the actual tickets that
  // contributed to the count. Backend ships the lists alongside the
  // counts so there's no extra round-trip on click.
  const [pillDetail, setPillDetail] = useState(null);
  const closePillDetail = () => setPillDetail(null);
  const openReboundsDetail = () => setPillDetail({
    title: 'Rebounds today (PT)',
    description: 'Tickets that bounced back after a rejection and triggered a fresh pipeline run.',
    items: today.recentRebounds || [],
    kind: 'rebound',
  });
  const openBypassedDetail = () => setPillDetail({
    title: 'Bypassed pipeline (no analysis)',
    description: 'Tickets created today in Pacific Time that ended up assigned in FreshService but never had a pipeline run — typically because an agent grabbed them within the ~30s window before our next poll fired.',
    items: today.recentBypassed || [],
    kind: 'bypassed',
  });
  const openNoiseFilteredDetail = () => setPillDetail({
    title: 'Noise-filtered (skipped before analysis)',
    description: 'Tickets that matched a noise rule and were silently excluded from polling. If something here looks legitimate, the matching rule may be over-matching — review it on the Noise Rules page.',
    items: today.recentNoiseFiltered || [],
    kind: 'noise',
  });
  // Real-time in-progress beats today's snapshot when there's actual activity
  // happening right now. The today.inProgress field is bound by createdAt
  // window; this catches runs that started just now even if they outlive
  // the window.
  const liveInProgress = inProgressCount > 0 ? inProgressCount : stats.inProgress;

  // Each outcome tile drills into the appropriate sub-tab + filter combo so
  // the cards double as quick links AND the destination shows exactly the
  // count the card promised. Time range nudges to the current PT day.
  // decidedDecisionFilter narrows Via Pipeline to the
  // specific decision so AI vs admin counts match precisely.
  const goToAutoAssigned = () => onNavigate?.({
    subView: 'assigned',
    assignedFilter: 'via_pipeline',
    decidedDecisionFilter: 'auto_assigned',
    ticketStatus: 'all',
    timeRange: '24h',
  });
  const goToApprovedByYou = () => onNavigate?.({
    subView: 'assigned',
    assignedFilter: 'via_pipeline',
    decidedDecisionFilter: 'approved',
    ticketStatus: 'all',
    timeRange: '24h',
  });
  const goToHandledInFs = () => onNavigate?.({
    subView: 'assigned',
    assignedFilter: 'manually_in_fs',
    ticketStatus: 'all',
    timeRange: '24h',
  });
  const goToDismissed = () => onNavigate?.({
    subView: 'dismissed',
    ticketStatus: 'all',
    timeRange: '24h',
  });

  return (
    <div className="py-6 sm:py-10 px-3 sm:px-6">
      {/* Header — auto-assign is on, page intentionally empty.
          Serif headline + generous spacing per UX redesign. */}
      <div className="text-center max-w-2xl mx-auto mb-6 sm:mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold mb-4">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>Auto-Assign is ON</span>
          {dryRun && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px] font-semibold">DRY-RUN</span>}
        </div>
        <h3 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight leading-tight">
          No tickets are waiting for you right now.
        </h3>
        <p className="text-sm text-slate-500 mt-3 leading-relaxed">
          The pipeline is processing tickets in the background. Items only land here when they genuinely need a human decision — like tickets in {' '}
          <span className="font-semibold text-slate-700">excluded groups</span>
          {excludedGroupCount > 0 ? ` (${excludedGroupCount} configured)` : ''}, rebound exhaustion, or LLM uncertainty.
        </p>
      </div>

      {/* Hero — light, centered card with today's total processed by the
          pipeline as the focal point. Soft gradient background + decorative
          icon flourishes on the sides match the rest of the app's bright,
          friendly theme (the dark glassmorphism version felt off-brand). */}
      <div className="max-w-4xl mx-auto mb-4 sm:mb-5">
        <div className="relative overflow-hidden rounded-2xl shadow-sm
                        bg-gradient-to-br from-blue-50 via-indigo-50/60 to-violet-50
                        border border-blue-100 px-5 sm:px-8 py-6 sm:py-8">
          {/* Decorative pastel orbs in the background — subtle layering */}
          <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-blue-200/30 blur-3xl pointer-events-none" aria-hidden />
          <div className="absolute -bottom-24 -left-16 w-72 h-72 rounded-full bg-violet-200/30 blur-3xl pointer-events-none" aria-hidden />

          {/* Centered content with flanking decorative icons */}
          <div className="relative flex flex-col items-center text-center">
            {/* Top label with sparkle accent. The backend anchors this panel
                to the current Pacific day (midnight PT -> now), and the queue
                tab uses the same PT-day window for drill-downs. */}
            <div className="inline-flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-blue-500" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">{queueStatus?.today?.range?.label || 'Today PT'}</span>
              <Sparkles className="w-4 h-4 text-blue-500" />
            </div>

            {/* Big number with flanking icon flourishes (hidden on small) */}
            <div className="flex items-center gap-3 sm:gap-5">
              <Bot className="hidden sm:block w-7 h-7 text-emerald-500/70" aria-hidden />
              <div className="text-5xl sm:text-6xl font-bold tabular-nums leading-none text-slate-900">
                {stats.totalRuns}
              </div>
              <Zap className="hidden sm:block w-7 h-7 text-amber-500/70" aria-hidden />
            </div>

            <div className="mt-2 text-sm sm:text-base font-medium text-slate-600">
              tickets processed by the pipeline
            </div>
          </div>
        </div>
      </div>

      {/* Outcome tiles — 4 distinct paths a ticket can end up in.
          The math: autoAssigned + approved + handledInFs + noiseDismissed
          should equal totalRuns minus (manualReviewRequired + inProgress +
          queuedForLater + any failed runs). All tiles are clickable and
          navigate to the corresponding sub-tab + filter for drill-down. */}
      <div className="max-w-4xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-5">
        <StatTile
          icon={Bot}
          label="Auto-assigned by AI"
          value={stats.autoAssigned}
          sublabel="pipeline routed without review"
          tone="emerald"
          onClick={goToAutoAssigned}
        />
        <StatTile
          icon={Check}
          label="Approved by you"
          value={stats.approved}
          sublabel="admin clicked approve in app"
          tone="blue"
          onClick={goToApprovedByYou}
        />
        <StatTile
          icon={Users}
          label="Picked up in FreshService"
          value={stats.handledInFs}
          sublabel="agent grabbed after AI analysis"
          tone="amber"
          onClick={goToHandledInFs}
        />
        <StatTile
          icon={XCircle}
          label="Dismissed as noise"
          value={stats.noiseDismissed}
          sublabel="auto-classified non-actionable"
          tone="slate"
          onClick={goToDismissed}
        />
      </div>

      {/* Process state — only render pills that are actually non-zero so the
          panel doesn't drown in greyed-out tiles when nothing's happening.
          Centered horizontally to balance with the centered tile/hero rows
          above. The 3 data-list pills (rebounds, bypassed, noise-filtered)
          are clickable and open a modal listing the contributing tickets;
          the others (analyzing, needs attention, queued) describe state
          that's already visible elsewhere on this tab. */}
      {(liveInProgress > 0 || stats.rebounds > 0 || stats.pipelineBypass > 0 || stats.noiseFiltered > 0 || stats.manualReviewRequired > 0 || queuedRunsTotal > 0) && (
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-2 mb-4 sm:mb-5">
          {liveInProgress > 0 && (
            <SmallStatPill icon={Brain} tone="blue" value={liveInProgress} label="currently analyzing" />
          )}
          {stats.rebounds > 0 && (
            <SmallStatPill
              icon={RotateCcw}
              tone="amber"
              value={stats.rebounds}
              label={`rebound${stats.rebounds === 1 ? '' : 's'} today`}
              title="Tickets that bounced back after a rejection and triggered a fresh pipeline run. Click to see the list."
              onClick={openReboundsDetail}
            />
          )}
          {stats.pipelineBypass > 0 && (
            <SmallStatPill
              icon={Users}
              tone="amber"
              value={stats.pipelineBypass}
              label="bypassed pipeline (no analysis)"
              title="Tickets created today that ended up assigned in FreshService but never had a pipeline run — typically because the agent grabbed them within the 30s window before our next poll fired. Click to see the list."
              onClick={openBypassedDetail}
            />
          )}
          {stats.noiseFiltered > 0 && (
            <SmallStatPill
              icon={XCircle}
              tone="slate"
              value={stats.noiseFiltered}
              label="noise-filtered (skipped before analysis)"
              title="Tickets matched a noise rule and were silently excluded from polling. Click to see which tickets and which rule matched."
              onClick={openNoiseFilteredDetail}
            />
          )}
          {stats.manualReviewRequired > 0 && (
            <SmallStatPill icon={ShieldCheck} tone="rose" value={stats.manualReviewRequired} label={`need${stats.manualReviewRequired === 1 ? 's' : ''} your attention`} title="Excluded groups, rebound exhaustion, or LLM uncertainty" />
          )}
          {queuedRunsTotal > 0 && (
            <SmallStatPill icon={Clock} tone="slate" value={queuedRunsTotal} label="queued for after-hours" title="Will run automatically when business hours start" />
          )}
        </div>
      )}

      {/* Recent auto-assignments — up to 10 from today's PT window. Compact
          2-column grid on desktop (1-column on mobile) so the list fills
          the horizontal space instead of running a long thin column on
          the left. Each cell is a single-line chip linking to the run
          detail page: small avatar, ticket id, subject, assignee, time. */}
      {recent.length > 0 && (
        <div className="max-w-4xl mx-auto">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2 text-center">
            Recent auto-assignments {recent.length > 1 && <span className="text-slate-400 normal-case font-normal">· last {recent.length}</span>}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {recent.map((r) => (
              <a
                key={r.runId}
                href={`/assignments/history/${r.runId}`}
                className="group flex items-center gap-2.5 px-3 py-2 bg-white border border-slate-200/80 rounded-xl shadow-sm hover:shadow hover:border-slate-300 transition-all min-w-0"
                title={r.ticketSubject}
              >
                <TechAvatar
                  photoUrl={r.techPhotoUrl}
                  name={r.techName}
                  size="sm"
                  badge={<Check className="w-2.5 h-2.5 text-white" />}
                  badgeClass="bg-emerald-500 ring-2 ring-white"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-slate-900 truncate font-medium leading-tight">
                    {r.freshserviceTicketId && <span className="text-slate-400 mr-1 font-normal">#{r.freshserviceTicketId}</span>}
                    {r.ticketSubject}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate leading-tight mt-0.5">
                    to <span className="font-semibold text-slate-700">{r.techName || 'Unknown'}</span>
                    <span className="text-slate-300 mx-1.5">·</span>
                    <RelativeTime iso={r.decidedAt} />
                  </div>
                </div>
                <ChevronRight className="flex-shrink-0 w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 transition-colors" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Refresh */}
      <div className="text-center mt-5">
        <button onClick={onRefresh} className="text-xs text-slate-400 hover:text-slate-600 inline-flex items-center gap-1.5 transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh stats
        </button>
      </div>

      {pillDetail && (
        <PillDetailModal detail={pillDetail} onClose={closePillDetail} />
      )}
    </div>
  );
}

/**
 * Modal that lists the contributing tickets for one of the clickable
 * process-state pills (rebounds / bypassed / noise-filtered). Backend ships
 * up to 20 rows per pill so the modal is always client-side paginated.
 *
 * Renders different per-row info based on `kind`:
 *   - 'rebound':  ticket + assignee + trigger source
 *   - 'bypassed': ticket + assignee (no run record)
 *   - 'noise':    ticket + requester + rule that matched
 */
function PillDetailModal({ detail, onClose }) {
  // Esc to close — keyboard accessibility for non-mouse users.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const { title, description, items, kind } = detail;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 bg-slate-50/50">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {description && (
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 -mr-1 -mt-1 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              Nothing to show here right now.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((item, i) => (
                <li key={item.runId || item.ticketId || i} className="px-5 py-3 hover:bg-slate-50/60 transition-colors">
                  <PillDetailRow item={item} kind={kind} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Single row inside the pill detail modal. Shape varies by `kind`.
 */
function PillDetailRow({ item, kind }) {
  const ticketLabel = (
    <span className="text-sm text-slate-900 font-medium leading-tight">
      {item.freshserviceTicketId && <span className="text-slate-400 mr-1.5 font-normal">#{item.freshserviceTicketId}</span>}
      {item.ticketSubject}
    </span>
  );
  const time = (
    <span className="text-[11px] text-slate-500 inline-flex items-center gap-1">
      <Clock className="w-3 h-3 text-slate-400" />
      <RelativeTime iso={item.createdAt || item.decidedAt} />
    </span>
  );

  if (kind === 'rebound') {
    const trigger = item.triggerSource === 'rebound_exhausted'
      ? <span className="text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded text-[10px] font-semibold">REBOUND EXHAUSTED</span>
      : <span className="text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-[10px] font-semibold">REBOUND</span>;
    return (
      <a href={`/assignments/history/${item.runId}`} className="block group">
        <div className="flex items-center gap-3 min-w-0">
          <TechAvatar photoUrl={item.techPhotoUrl} name={item.techName} size="sm" />
          <div className="flex-1 min-w-0">
            <div className="truncate">{ticketLabel}</div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {trigger}
              {item.techName && <span className="text-[11px] text-slate-500">re-routed to <span className="font-semibold text-slate-700">{item.techName}</span></span>}
              <span className="text-slate-300 text-[11px]">·</span>
              {time}
            </div>
          </div>
          <ChevronRight className="flex-shrink-0 w-4 h-4 text-slate-300 group-hover:text-slate-500" />
        </div>
      </a>
    );
  }

  if (kind === 'bypassed') {
    return (
      <div className="flex items-center gap-3 min-w-0">
        <TechAvatar photoUrl={item.techPhotoUrl} name={item.techName} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="truncate">{ticketLabel}</div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>grabbed in FS by <span className="font-semibold text-slate-700">{item.techName || 'Unknown'}</span></span>
            <span className="text-slate-300">·</span>
            {time}
          </div>
        </div>
      </div>
    );
  }

  // kind === 'noise'
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 text-slate-500">
        <XCircle className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="truncate">{ticketLabel}</div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
          {item.requesterName && <span>from <span className="font-semibold text-slate-700">{item.requesterName}</span></span>}
          {item.noiseRuleMatched && (
            <>
              {item.requesterName && <span className="text-slate-300">·</span>}
              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-mono">{item.noiseRuleMatched}</span>
            </>
          )}
          <span className="text-slate-300">·</span>
          {time}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact inline pill for the "process state" row — smaller than a StatTile
 * (used when the metric is more "happening right now" than "outcome of the day").
 * Only rendered when value > 0 to keep the panel uncluttered.
 *
 * UX redesign v1.9.83: rounded-full pill with a small colored icon chip on
 * the left and a bold tabular-num value, then a quieter label. Reads like
 * "[icon] 2 rebounds today" at a glance.
 */
function SmallStatPill({ icon: Icon, label, value, tone = 'slate', title, onClick }) {
  const TONE_CLASSES = {
    blue:    { iconBg: 'bg-blue-100',    iconText: 'text-blue-700',    text: 'text-blue-900',    border: 'border-blue-200/70',    hover: 'hover:bg-blue-50/60 hover:border-blue-300' },
    emerald: { iconBg: 'bg-emerald-100', iconText: 'text-emerald-700', text: 'text-emerald-900', border: 'border-emerald-200/70', hover: 'hover:bg-emerald-50/60 hover:border-emerald-300' },
    amber:   { iconBg: 'bg-amber-100',   iconText: 'text-amber-700',   text: 'text-amber-900',   border: 'border-amber-200/70',   hover: 'hover:bg-amber-50/60 hover:border-amber-300' },
    rose:    { iconBg: 'bg-rose-100',    iconText: 'text-rose-700',    text: 'text-rose-900',    border: 'border-rose-200/70',    hover: 'hover:bg-rose-50/60 hover:border-rose-300' },
    slate:   { iconBg: 'bg-slate-200',   iconText: 'text-slate-600',   text: 'text-slate-700',   border: 'border-slate-200',      hover: 'hover:bg-slate-50 hover:border-slate-300' },
  };
  const tc = TONE_CLASSES[tone] || TONE_CLASSES.slate;
  // Render as button when onClick is provided so the pill behaves as an
  // affordance (cursor-pointer, hover, keyboard-accessible). Non-clickable
  // pills stay as <div> so they don't show a misleading hover state.
  const sharedClass = `inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-white border ${tc.border} shadow-sm text-xs ${tc.text}`;
  const inner = (
    <>
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${tc.iconBg}`}>
        <Icon className={`w-3 h-3 ${tc.iconText}`} />
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-slate-600">{label}</span>
      {onClick && <ChevronRight className={`w-3 h-3 -ml-0.5 ${tc.iconText} opacity-60`} />}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${sharedClass} ${tc.hover} cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-300`}
        title={title || undefined}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={sharedClass} title={title || undefined}>
      {inner}
    </div>
  );
}

/**
 * Tiny "X minutes ago / X hours ago" helper that updates every 30s. Used in the
 * empty-state's "most recent auto-assignment" strip so the relative time stays
 * accurate without forcing a full page refresh.
 */
function RelativeTime({ iso }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return <span>just now</span>;
  if (ms < 3_600_000) {
    const min = Math.floor(ms / 60_000);
    return <span>{min} min ago</span>;
  }
  if (ms < 86_400_000) {
    const hr = Math.floor(ms / 3_600_000);
    return <span>{hr} hr ago</span>;
  }
  const days = Math.floor(ms / 86_400_000);
  return <span>{days} day{days === 1 ? '' : 's'} ago</span>;
}

/**
 * Profile avatar for a technician with optional badge overlay. Falls back to
 * a colored initials circle when photoUrl is missing or the image fails to
 * load (broken-image alt would leak the real name in Demo Mode).
 *
 * @param {object} props
 * @param {string|null} props.photoUrl
 * @param {string|null} props.name
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {React.ReactNode} [props.badge]      Optional small overlay (e.g. status icon)
 * @param {string} [props.badgeClass]
 */
function TechAvatar({ photoUrl, name, size = 'md', badge = null, badgeClass = 'bg-emerald-500' }) {
  const [broken, setBroken] = useState(false);
  const SIZES = {
    sm: { wrap: 'w-7 h-7', text: 'text-[10px]', badge: 'w-3.5 h-3.5 -bottom-0.5 -right-0.5' },
    md: { wrap: 'w-9 h-9', text: 'text-xs', badge: 'w-4 h-4 -bottom-0.5 -right-0.5' },
    lg: { wrap: 'w-11 h-11 sm:w-12 sm:h-12', text: 'text-sm', badge: 'w-5 h-5 -bottom-0.5 -right-0.5' },
  };
  const s = SIZES[size] || SIZES.md;
  const initials = (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';
  const showImg = photoUrl && !broken;
  return (
    <div className={`relative flex-shrink-0 ${s.wrap}`}>
      {showImg ? (
        <img
          src={photoUrl}
          alt={name || ''}
          className={`${s.wrap} rounded-full object-cover border border-slate-200 shadow-sm`}
          onError={() => setBroken(true)}
        />
      ) : (
        <div className={`${s.wrap} rounded-full bg-gradient-to-br from-blue-500 to-blue-600 border border-blue-400 shadow-sm flex items-center justify-center`}>
          <span className={`${s.text} font-bold text-white`}>{initials}</span>
        </div>
      )}
      {badge && (
        <span className={`absolute ${s.badge} rounded-full ${badgeClass} flex items-center justify-center`}>
          {badge}
        </span>
      )}
    </div>
  );
}

function MobileQuickApproveSheet({ activeItems, quickApproveId, guardRef, onClose, sheetRef, ...innerProps }) {
  if (!quickApproveId) return null;
  const run = activeItems.find((r) => r.id === quickApproveId);
  if (!run) return null;
  const recs = run.recommendation?.recommendations || [];
  if (!recs.length) return null;
  return (
    <div className="md:hidden fixed inset-0 z-[100]" onClick={() => { guardRef.current = Date.now(); onClose(); }}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-2xl pb-safe max-h-[70vh] overflow-y-auto"
      >
        <div className="flex justify-center pt-2 pb-1"><div className="w-10 h-1 rounded-full bg-slate-300" /></div>
        <p className="px-4 pt-1 pb-0 text-xs font-medium text-slate-500 truncate">
          #{run.ticket?.freshserviceTicketId} — {run.ticket?.subject}
        </p>
        <QuickApproveInner run={run} recs={recs} {...innerProps} />
      </div>
    </div>
  );
}

function QueueFilterRail({
  subView,
  assignedTotal,
  assignedRunsTotal,
  outsideAssignedTotal,
  assignedFilter,
  onAssignedFilterChange,
  decidedDecisionFilter,
  onDecidedDecisionFilterChange,
  ticketStatusFilter,
  onTicketStatusFilterChange,
  differentAgentCount,
}) {
  if (subView === 'deleted' || subView === 'pending') {
    return null;
  }

  const groups = [];

  if (subView === 'assigned' && assignedTotal > 0) {
    groups.push({
      id: 'source',
      label: 'Source',
      value: assignedFilter,
      onChange: onAssignedFilterChange,
      options: [
        { id: 'all', label: 'All', count: assignedTotal, activeClass: 'bg-slate-900 text-white shadow-sm' },
        { id: 'via_pipeline', label: 'Pipeline', count: assignedRunsTotal, activeClass: 'bg-emerald-500 text-white shadow-sm' },
        { id: 'manually_in_fs', label: 'FreshService', count: outsideAssignedTotal, activeClass: 'bg-amber-300 text-amber-950 shadow-sm' },
      ],
    });
  }

  if (subView === 'assigned' && assignedFilter === 'via_pipeline') {
    groups.push({
      id: 'decision',
      label: 'Decision',
      value: decidedDecisionFilter,
      onChange: onDecidedDecisionFilterChange,
      options: [
        { id: 'all', label: 'All', activeClass: 'bg-slate-900 text-white shadow-sm' },
        { id: 'auto_assigned', label: 'AI Auto', activeClass: 'bg-emerald-500 text-white shadow-sm' },
        { id: 'approved', label: 'Approved', activeClass: 'bg-blue-500 text-white shadow-sm' },
      ],
    });
  }

  groups.push({
    id: 'status',
    label: 'Status',
    value: ticketStatusFilter,
    onChange: onTicketStatusFilterChange,
    options: [
      { id: 'all', label: 'All', activeClass: 'bg-slate-900 text-white shadow-sm' },
      { id: 'in_progress', label: 'In Progress', activeClass: 'bg-emerald-500 text-white shadow-sm' },
      { id: 'pending', label: 'Pending', activeClass: 'bg-amber-300 text-amber-950 shadow-sm' },
      { id: 'closed_resolved', label: 'Closed', activeClass: 'bg-slate-500 text-white shadow-sm' },
    ],
  });

  return (
    <>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 shadow-sm shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
        Filters
      </span>

      {groups.map((group) => (
        <div
          key={group.id}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50/90 p-1 shadow-sm"
        >
          <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 ring-1 ring-slate-200/80">
            {group.label}
          </span>
          {group.options.map((option) => {
            const isActive = group.value === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => group.onChange(option.id)}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-150 touch-manipulation ${
                  isActive
                    ? option.activeClass
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>{option.label}</span>
                {option.count != null && (
                  <span className={`tabular-nums text-[10px] ${isActive ? 'opacity-80' : 'text-slate-400'}`}>
                    {option.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}

      {subView === 'assigned' && differentAgentCount > 0 && assignedFilter !== 'manually_in_fs' && (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-[10px] font-medium text-blue-700 shadow-sm"
          title="Pipeline runs where the final assignee differed from the AI's top recommendation"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
          {differentAgentCount} different agent chosen
        </span>
      )}
    </>
  );
}

function QueueTab({ deepRunId, isAdmin = false, workspaceTimezone = 'America/Los_Angeles', timeRange = '7d', onTimeRangeChange }) {
  const navigate = useNavigate();
  const [queue, setQueue] = useState({ items: [], total: 0, totals: { all: 0, unassigned: 0, outsideAssigned: 0 }, inProgress: [] });
  const [outsideAssignedRuns, setOutsideAssignedRuns] = useState({ items: [], total: 0 });
  const [deletedRuns, setDeletedRuns] = useState({ items: [], total: 0 });
  const [assignedFilter, setAssignedFilter] = useState('all'); // 'all' | 'via_pipeline' | 'manually_in_fs'
  // Sub-filter inside Decided > Via Pipeline: 'all' (auto+approved+modified),
  // 'auto_assigned' (just AI), or 'approved' (just admin-approved/modified).
  // Set by drilling into the empty-state outcome cards so the destination
  // shows EXACTLY the count the card promised. Cleared by the chip's X.
  const [decidedDecisionFilter, setDecidedDecisionFilter] = useState('all');
  const [ticketStatusFilter, setTicketStatusFilter] = useState('in_progress'); // 'all' | 'in_progress' | 'pending' | 'closed_resolved'
  const [assignedRuns, setAssignedRuns] = useState({ items: [], total: 0 });
  const [queuedRuns, setQueuedRuns] = useState([]);
  const [queuedRunsMeta, setQueuedRunsMeta] = useState({ totalCount: 0, truncated: false });
  const [pruning, setPruning] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  // When the user clicks "Run Now" on a queued row we open a slide-over with
  // LivePipelineView wired to the run-now SSE endpoint, so the streaming LLM
  // analysis is visible immediately instead of vanishing into a 5-second toast.
  // Holds { runId, ticketId, freshserviceTicketId, subject } while the overlay is open.
  const [runNowLive, setRunNowLive] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPriority, setFilterPriority] = useState('all');
  const [queueStatus, setQueueStatus] = useState(null);
  const [subView, setSubView] = useState('pending');
  const [dismissedRuns, setDismissedRuns] = useState({ items: [], total: 0 });
  const [rejectedRuns, setRejectedRuns] = useState({ items: [], total: 0 });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [techPhotos, setTechPhotos] = useState({});
  const [avatarView, setAvatarView] = useState(false);
  const [removingIds, setRemovingIds] = useState(new Set());
  const [newIds, setNewIds] = useState(new Set());
  const seenIdsRef = useRef(null);
  const newIdsInitializedRef = useRef(false);
  const [queuePage, setQueuePage] = useState(0);
  const queuePageSize = 50;
  const queuedSectionRef = useRef(null);
  const [queuedExpanded, setQueuedExpanded] = useState(false);

  const scrollToQueuedSection = useCallback(() => {
    setQueuedExpanded(true);
    // Wait one tick so the expand animation starts before scrolling
    setTimeout(() => {
      queuedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }, []);

  const animateOut = useCallback((runId) => {
    setRemovingIds(prev => new Set([...prev, runId]));
    setTimeout(() => {
      setQueue(prev => ({
        items: prev.items.filter(r => r.id !== runId),
        total: Math.max(0, prev.total - 1),
        totals: {
          all: Math.max(0, (prev.totals?.all ?? prev.total) - 1),
          unassigned: Math.max(0, (prev.totals?.unassigned ?? 0) - 1),
          outsideAssigned: prev.totals?.outsideAssigned ?? 0,
        },
      }));
      setRemovingIds(prev => { const s = new Set(prev); s.delete(runId); return s; });
    }, 240);
  }, []);

  useEffect(() => {
    assignmentAPI.getCompetencyTechnicians().then(res => {
      const map = {};
      for (const t of (res?.data || [])) map[t.id] = t;
      setTechPhotos(map);
    }).catch(() => {});
  }, []);

  const getSince = (range) => {
    if (range === 'all') return undefined;
    const now = new Date();
    if (range === '24h') return getPacificDayStartISOString(now);
    if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    if (range === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return undefined;
  };

  const hasLoadedOnce = useRef(false);
  const fetchQueue = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) {
        if (hasLoadedOnce.current) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
      }
      const since = getSince(timeRange);
      // Awaiting Review: only ACTIVE tickets (open or pending status) - excludes closed/resolved/deleted.
      // These are the only tickets that genuinely need a review decision.
      const pendingTicketStatus = 'active';
      const assignedTicketStatus = subView === 'assigned' ? ticketStatusFilter : 'in_progress';
      const dismissedTicketStatus = subView === 'dismissed' ? ticketStatusFilter : 'all';
      const rejectedTicketStatus = subView === 'rejected' ? ticketStatusFilter : 'all';

      const [queueRes, outsideRes, assignedRes, dismissedRes, rejectedRes, deletedRes, queuedRes, statusRes] = await Promise.all([
        assignmentAPI.getQueue({
          limit: queuePageSize,
          offset: queuePage * queuePageSize,
          assignmentStatus: 'unassigned',
          ticketStatus: pendingTicketStatus,
          since,
          sinceField: 'createdAt',
        }),
        assignmentAPI.getQueue({ limit: 100, offset: 0, assignmentStatus: 'outside_assigned', ticketStatus: assignedTicketStatus, since, sinceField: 'createdAt' }),
        // The decision list narrows when the empty-state cards drill in:
        //   'auto_assigned'  → only AI-decided runs
        //   'approved'       → only admin-approved (approved + modified)
        //   'all'            → everything that lives under "Via Pipeline"
        assignmentAPI.getRuns({
          decisions: decidedDecisionFilter === 'auto_assigned'
            ? 'auto_assigned'
            : decidedDecisionFilter === 'approved'
              ? 'approved,modified'
              : 'approved,modified,auto_assigned',
          since,
          sinceField: 'decidedAt',
          limit: 50,
          ticketStatus: assignedTicketStatus,
        }),
        assignmentAPI.getRuns({ decisions: 'noise_dismissed', since, sinceField: 'decidedAt', limit: 50, ticketStatus: dismissedTicketStatus }),
        assignmentAPI.getRuns({ decisions: 'rejected', since, sinceField: 'decidedAt', limit: 50, ticketStatus: rejectedTicketStatus }),
        assignmentAPI.getRuns({ since, sinceField: 'createdAt', limit: 100, ticketStatus: 'deleted' }),
        assignmentAPI.getQueuedRuns(),
        assignmentAPI.getQueueStatus().catch(() => null),
      ]);
      setQueue({
        items: queueRes?.items || [],
        total: queueRes?.total || 0,
        totals: queueRes?.totals || { all: 0, unassigned: 0, outsideAssigned: 0 },
        inProgress: queueRes?.inProgress || [],
      });
      setOutsideAssignedRuns({ items: outsideRes?.items || [], total: outsideRes?.total || 0 });
      setAssignedRuns({ items: assignedRes?.items || [], total: assignedRes?.total || 0 });
      setDismissedRuns({ items: dismissedRes?.items || [], total: dismissedRes?.total || 0 });
      setRejectedRuns({ items: rejectedRes?.items || [], total: rejectedRes?.total || 0 });
      setDeletedRuns({ items: deletedRes?.items || [], total: deletedRes?.total || 0 });
      setQueuedRuns(queuedRes?.data || []);
      setQueuedRunsMeta({
        totalCount: queuedRes?.totalCount ?? (queuedRes?.data?.length || 0),
        truncated: !!queuedRes?.truncated,
      });
      if (statusRes?.data) setQueueStatus(statusRes.data);
      hasLoadedOnce.current = true;
    } catch {
      if (!silent) {
        setQueue({ items: [], total: 0, totals: { all: 0, unassigned: 0, outsideAssigned: 0 }, inProgress: [] });
        setOutsideAssignedRuns({ items: [], total: 0 });
        setAssignedRuns({ items: [], total: 0 });
        setDismissedRuns({ items: [], total: 0 });
        setRejectedRuns({ items: [], total: 0 });
        setDeletedRuns({ items: [], total: 0 });
        setQueuedRuns([]);
        setQueuedRunsMeta({ totalCount: 0, truncated: false });
      }
    } finally {
      if (!silent) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [timeRange, queuePage, ticketStatusFilter, subView, decidedDecisionFilter]);

  const handleSmartRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncAPI.trigger();
    } catch {
      // Sync failed (e.g. network, auth) — still refresh from DB below
    }
    await fetchQueue();
    setRefreshing(false);

    // The sync's pipeline-polling step is fire-and-forget — by the time
    // we got our response and refreshed the queue, those runs may not
    // have been created yet (or may still be in 'running' status). Poll
    // a few extra times over the next 8s to catch them as they appear.
    // Once any inProgress runs land, the dedicated fast-poll effect
    // (4s interval) takes over until they all finish.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try { await fetchQueue({ silent: true }); } catch { /* ignore */ }
    }
  }, [fetchQueue]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  // Detect genuinely new items arriving via silent polls (not on initial load).
  // We only start diffing AFTER the first non-empty load has been recorded, so
  // switching tabs or a fresh page load never triggers a "new tickets" toast.
  useEffect(() => {
    if (queue.items.length === 0) return;
    const currentIds = new Set(queue.items.map(r => r.id));

    if (!newIdsInitializedRef.current) {
      seenIdsRef.current = currentIds;
      newIdsInitializedRef.current = true;
      return;
    }

    const added = queue.items.filter(r => !seenIdsRef.current.has(r.id)).map(r => r.id);
    seenIdsRef.current = currentIds;
    if (added.length === 0) return;

    setNewIds(prev => new Set([...prev, ...added]));
    const timer = setTimeout(() => {
      setNewIds(prev => {
        const next = new Set(prev);
        added.forEach(id => next.delete(id));
        return next;
      });
    }, 6000);
    return () => clearTimeout(timer);
  }, [queue.items]);

  // Reset the "new items" tracker when pagination changes so page-flips don't flash items as new
  useEffect(() => {
    newIdsInitializedRef.current = false;
    seenIdsRef.current = null;
    setNewIds(new Set());
  }, [queuePage]);

  // Reset secondary status filter to that tab's default whenever the tab changes.
  // Awaiting Review (pending) doesn't use the filter at all; Assigned defaults to 'in_progress'.
  // EXCEPT: when navigating in from the empty-state outcome cards, the caller
  // sets ticketStatusFilter='all' explicitly so closed tickets stay visible
  // and the count matches the card. Skip the auto-reset for one render in
  // that case.
  const skipNextStatusReset = useRef(false);
  useEffect(() => {
    if (skipNextStatusReset.current) {
      skipNextStatusReset.current = false;
      setQueuePage(0);
      return;
    }
    if (subView === 'assigned') {
      setTicketStatusFilter('in_progress');
    } else {
      setTicketStatusFilter('all');
    }
    setQueuePage(0);
  }, [subView]);

  // Reset pagination when ticket-status filter changes
  useEffect(() => {
    setQueuePage(0);
  }, [ticketStatusFilter]);

  // Auto-poll every 30 seconds (matches backend sync interval)
  useEffect(() => {
    const id = setInterval(() => fetchQueue({ silent: true }), 30_000);
    return () => clearInterval(id);
  }, [fetchQueue]);

  // Fast-poll every 4 seconds while pipeline runs are actively analyzing.
  // The user's manual sync triggers fire-and-forget LLM runs that take
  // 5–30s each — without this, they'd only appear on the next 30s tick.
  // Deps include only `inProgressCount` (not the full array) so we don't
  // re-create the interval every poll.
  const inProgressCount = queue.inProgress?.length || 0;
  useEffect(() => {
    if (inProgressCount === 0) return;
    const id = setInterval(() => fetchQueue({ silent: true }), 4_000);
    return () => clearInterval(id);
  }, [inProgressCount, fetchQueue]);

  useEffect(() => {
    if (deepRunId) {
      (async () => {
        try {
          const res = await assignmentAPI.getRun(parseInt(deepRunId));
          setSelectedRun(res?.data || null);
        } catch {
          setSelectedRun(null);
        }
      })();
    } else {
      setSelectedRun(null);
    }
  }, [deepRunId]);

  const handleSelectRun = (runId) => {
    if (Date.now() - quickApproveGuardRef.current < 800) return;
    navigate(`/assignments/run/${runId}`);
  };

  const handleDecide = async (decisionData) => {
    if (!selectedRun) return;
    try {
      setDeciding(true);
      await assignmentAPI.decide(selectedRun.id, decisionData);
      setSelectedRun(null);
      navigate('/assignments/queue');
      await fetchQueue();
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      setTimeout(() => setActionMsg(null), 3000);
    } finally {
      setDeciding(false);
    }
  };

  const handleDismiss = async (e, runId) => {
    e.stopPropagation();
    animateOut(runId);
    try {
      await assignmentAPI.dismissRun(runId);
      setActionMsg('Dismissed');
      fetchQueue({ silent: true });
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      fetchQueue();
      setTimeout(() => setActionMsg(null), 3000);
    }
  };

  const handleDeleteClick = (e, runId) => {
    e.stopPropagation();
    setConfirmDeleteId(confirmDeleteId === runId ? null : runId);
  };

  const handleDeleteConfirm = async (e, runId) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
    animateOut(runId);
    try {
      await assignmentAPI.deleteRun(runId);
      setActionMsg('Deleted');
      fetchQueue({ silent: true });
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      fetchQueue();
      setTimeout(() => setActionMsg(null), 3000);
    }
  };

  const handleClearAll = async () => {
    setClearing(true);
    try {
      await assignmentAPI.bulkDeleteRuns({ decision: 'pending_review' });
      setShowClearConfirm(false);
      setActionMsg('Deleted pending runs');
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      setTimeout(() => setActionMsg(null), 3000);
    } finally {
      setClearing(false);
    }
  };

  /* ─── Quick Approve ──────────────────────────────────── */
  const [quickApproveId, setQuickApproveId] = useState(null);
  const [quickApproveNote, setQuickApproveNote] = useState('');
  const [quickApproveTechId, setQuickApproveTechId] = useState(null);
  const [quickApproving, setQuickApproving] = useState(false);
  const quickApproveRef = useRef(null);
  const quickApproveMobileRef = useRef(null);
  const quickApproveGuardRef = useRef(0);

  useEffect(() => {
    if (!quickApproveId) return;
    const onPointer = (e) => {
      const inDesktop = quickApproveRef.current?.contains(e.target);
      const inMobile = quickApproveMobileRef.current?.contains(e.target);
      if (!inDesktop && !inMobile) setQuickApproveId(null);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer, { passive: true });
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('touchstart', onPointer); };
  }, [quickApproveId]);

  const openQuickApprove = (e, run) => {
    e.stopPropagation();
    const topTech = run.recommendation?.recommendations?.[0]?.techId || null;
    if (quickApproveId === run.id) { setQuickApproveId(null); return; }
    setQuickApproveId(run.id);
    setQuickApproveTechId(topTech);
    setQuickApproveNote('');
  };

  const submitQuickApprove = async (e, run) => {
    e.stopPropagation();
    if (!quickApproveTechId) return;
    const recs = run.recommendation?.recommendations || [];
    const isTopPick = recs[0]?.techId === quickApproveTechId;
    animateOut(run.id);
    quickApproveGuardRef.current = Date.now();
    setQuickApproveId(null);
    try {
      setQuickApproving(true);
      await assignmentAPI.decide(run.id, {
        decision: isTopPick ? 'approved' : 'modified',
        assignedTechId: quickApproveTechId,
        decisionNote: quickApproveNote || undefined,
        overrideReason: !isTopPick ? (quickApproveNote || 'Quick approve override') : undefined,
      });
      setActionMsg('Approved');
      fetchQueue({ silent: true });
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      fetchQueue();
      setTimeout(() => setActionMsg(null), 3000);
    } finally {
      setQuickApproving(false);
    }
  };

  // Defined before any early-return below so React hook order stays stable
  // across renders (the conditional `if (selectedRun) return ...` and
  // `if (loading) return ...` would otherwise skip this useCallback).
  const closeRunNowLive = useCallback(async () => {
    setRunNowLive(null);
    // The promoted run is now either completed (pending_review / auto_assigned /
    // noise_dismissed), failed, or skipped_stale — refresh the queue so the row
    // moves to the right tab without the user having to manually reload.
    try { await fetchQueue(); } catch { /* ignore */ }
  }, [fetchQueue]);

  if (selectedRun) {
    return (
      <div>
        <button
          onClick={() => { setSelectedRun(null); navigate('/assignments/queue'); }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5 mb-4 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back to queue
        </button>
        <PipelineRunDetail run={selectedRun} workspaceTimezone={workspaceTimezone} onDecide={handleDecide} deciding={deciding} isAdmin={isAdmin} onSyncComplete={async () => {
          try { const res = await assignmentAPI.getRun(selectedRun.id); setSelectedRun(res?.data || null); } catch { /* ignore */ }
        }} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const handleRunNow = (e, runId) => {
    e.stopPropagation();
    // Find the queued run we're about to promote so the live overlay can show
    // the ticket subject/ID immediately. The actual claim + execution happens
    // server-side once LivePipelineView opens its SSE connection to
    // /assignment/runs/{runId}/run-now?stream=true.
    const run = queuedRuns.find((r) => r.id === runId);
    setRunNowLive({
      runId,
      ticketId: run?.ticket?.id || run?.ticketId || null,
      freshserviceTicketId: run?.ticket?.freshserviceTicketId ?? null,
      subject: run?.ticket?.subject || `Run #${runId}`,
    });
  };

  const handlePruneQueue = async () => {
    if (pruning) return;
    if (!window.confirm('Prune the queue? This marks any queued ticket that is already closed, deleted, or assigned as skipped — leaving only items still worth a decision.')) return;
    setPruning(true);
    try {
      const res = await assignmentAPI.pruneQueuedRuns();
      const data = res?.data || res;
      const pruned = data?.pruned ?? 0;
      const kept = data?.kept ?? 0;
      setActionMsg(`Queue pruned — ${pruned} stale removed, ${kept} kept`);
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 5000);
    } catch (err) {
      setActionMsg(`Failed to prune: ${err.message}`);
      setTimeout(() => setActionMsg(null), 4000);
    } finally {
      setPruning(false);
    }
  };

  const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
  const PRIORITY_PILL = {
    1: 'bg-slate-100 text-slate-600',
    2: 'bg-yellow-100 text-yellow-800',
    3: 'bg-orange-100 text-orange-800',
    4: 'bg-red-100 text-red-800',
  };
  const PRIORITY_BORDER = { 1: 'border-l-slate-200', 2: 'border-l-slate-200', 3: 'border-l-slate-200', 4: 'border-l-slate-200' };

  const fmtDate = (d) => formatDateTimeInTimezone(d, workspaceTimezone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-slate-400" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-blue-600" /> : <ArrowDown className="w-3 h-3 text-blue-600" />;
  };

  const isTicketOpen = (run) => ['Open', 'open', '2', 'Pending', 'pending', '3'].includes(String(run.ticket?.status || ''));
  const isTicketDeleted = (run) => ['deleted', 'spam'].includes(String(run.ticket?.status || '').toLowerCase());
  const getTicketFlag = (run) => {
    if (!run.ticket) return null;
    if (isTicketDeleted(run)) return 'deleted';
    if (!isTicketOpen(run)) return 'closed';
    if (run.ticket.assignedTechId) return 'assigned';
    return 'open';
  };

  // queue.items is already filtered server-side by assignmentStatus + ticketStatus.
  // We only apply client-side priority filter and sorting here.
  const filteredItems = [...queue.items]
    .filter((r) => filterPriority === 'all' || String(r.ticket?.priority) === filterPriority)
    .sort((a, b) => {
      let av, bv;
      if (sortField === 'createdAt') { av = new Date(a.createdAt); bv = new Date(b.createdAt); }
      else if (sortField === 'priority') { av = a.ticket?.priority || 0; bv = b.ticket?.priority || 0; }
      else if (sortField === 'requester') { av = a.ticket?.requester?.name || ''; bv = b.ticket?.requester?.name || ''; }
      else { av = a.ticket?.subject || ''; bv = b.ticket?.subject || ''; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  const DECISION_LABELS = { approved: 'Approved', modified: 'Override', auto_assigned: 'Auto', noise_dismissed: 'Noise', rejected: 'Rejected', pending_review: 'Pending' };
  const DECISION_PILL = { approved: 'bg-green-100 text-green-800', modified: 'bg-blue-100 text-blue-800', auto_assigned: 'bg-purple-100 text-purple-800', noise_dismissed: 'bg-slate-100 text-slate-500', rejected: 'bg-red-100 text-red-800' };

  // Contextual decision label. A run's `decision` may be 'pending_review'
  // even though no human action is needed in our app — the ticket has
  // already been assigned externally in FreshService. In that case, render
  // a clearer 'Handled in FS' label with an amber pill instead of the
  // confusing yellow 'Pending'. Tooltip explains why.
  const getDisplayDecision = (run) => {
    // A pending_review run with an assignedTechId means someone took the
    // ticket in FreshService directly, outside the pipeline. The label should
    // reflect that regardless of the ticket's current status — showing
    // "Pending" on a Closed ticket that was manually handled is misleading
    // (implies action needed when nothing is). Also keeps this check in sync
    // with the backend's "outside_assigned" filter (which doesn't look at
    // status either), so the "Manually in FreshService" sub-tab and the
    // per-row decision pill always agree.
    const externallyAssigned = run.decision === 'pending_review' && run.ticket?.assignedTechId;
    if (externallyAssigned) {
      return {
        label: 'Handled in FS',
        pillClass: 'bg-amber-100 text-amber-800',
        tooltip: `Assigned in FreshService outside the pipeline${run.ticket?.assignedTech?.name ? ' — ' + run.ticket.assignedTech.name : ''}. AI suggestion left unresolved.`,
      };
    }
    return {
      label: DECISION_LABELS[run.decision] || run.decision,
      pillClass: DECISION_PILL[run.decision] || 'bg-slate-100 text-slate-500',
      tooltip: null,
    };
  };
  const _FLAG_PILL = { open: { label: 'Unassigned', style: 'bg-green-100 text-green-700' }, assigned: { label: 'Assigned', style: 'bg-amber-100 text-amber-700' }, closed: { label: 'Closed', style: 'bg-slate-100 text-slate-500' }, deleted: { label: 'Deleted', style: 'bg-red-100 text-red-600' } };
  const STATUS_PILL_STYLE = { Open: 'bg-green-100 text-green-700', Pending: 'bg-yellow-100 text-yellow-700', Closed: 'bg-slate-100 text-slate-500', Resolved: 'bg-slate-100 text-slate-500', Deleted: 'bg-red-100 text-red-600', Spam: 'bg-red-100 text-red-600', 'Waiting on Customer': 'bg-blue-100 text-blue-600', 'Waiting on Third Party': 'bg-blue-100 text-blue-600' };
  const getStatusPillStyle = (status) => STATUS_PILL_STYLE[status] || 'bg-slate-100 text-slate-500';
  const getStatusLabel = (status) => {
    if (!status) return 'Unknown';
    if (status === '2' || status === 'open') return 'Open';
    if (status === '3' || status === 'pending') return 'Pending';
    if (status === '4' || status === 'resolved') return 'Resolved';
    if (status === '5' || status === 'closed') return 'Closed';
    return status;
  };

  // Heuristic: was a "different agent" (not the AI's top suggestion) chosen?
  const wasDifferentAgentChosen = (run) => {
    const topTechId = run.recommendation?.recommendations?.[0]?.techId;
    const finalTechId = run.assignedTech?.id || run.ticket?.assignedTech?.id || run.ticket?.assignedTechId;
    if (!topTechId || !finalTechId) return false;
    return Number(topTechId) !== Number(finalTechId);
  };

  // Combined "Assigned" view: pipeline-assigned runs + outside-pipeline-assigned runs (tickets that
  // got an assignee in FreshService before the pipeline review was decided).
  const assignedTotal = (assignedRuns?.total || 0) + (outsideAssignedRuns?.total || 0);
  const combinedAssignedItems = (() => {
    const viaPipeline = (assignedRuns?.items || []).map(r => ({ ...r, _source: 'via_pipeline' }));
    const manual = (outsideAssignedRuns?.items || []).map(r => ({ ...r, _source: 'manually_in_fs' }));
    if (assignedFilter === 'via_pipeline') return viaPipeline;
    if (assignedFilter === 'manually_in_fs') return manual;
    // 'all' view: a ticket can show up in BOTH lists (e.g. originally
    // decided via_pipeline, then bounced and now has a pending_review
    // rebound run that catches the manually_in_fs filter). Dedupe by
    // ticket — keep the most recent run, attach _siblingCount for a
    // subtle indicator. Sub-tabs intentionally don't dedupe so a user
    // investigating can still see the full history.
    const merged = [...viaPipeline, ...manual]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const seenByTicket = new Map();
    for (const run of merged) {
      const tid = run.ticket?.id;
      if (!tid) { continue; }
      if (!seenByTicket.has(tid)) {
        seenByTicket.set(tid, { run, count: 1 });
      } else {
        seenByTicket.get(tid).count += 1;
      }
    }
    return [...seenByTicket.values()].map(({ run, count }) => ({
      ...run,
      _siblingCount: count - 1, // 0 if unique, otherwise count of older runs we hid
    }));
  })();
  const differentAgentCount = (assignedRuns?.items || []).filter(wasDifferentAgentChosen).length;

  const TechAvatar = ({ techId, name, size = 'sm', ring = '' }) => {
    const tech = techPhotos[techId];
    const initials = name?.split(' ').map(n => n[0]).join('').slice(0, 2) || '?';
    const sz = size === 'sm' ? 'w-6 h-6' : size === 'xs' ? 'w-5 h-5' : 'w-7 h-7';
    const textSz = size === 'sm' ? 'text-[9px]' : size === 'xs' ? 'text-[8px]' : 'text-[10px]';
    return tech?.photoUrl ? (
      <img src={tech.photoUrl} alt="" className={`${sz} rounded-full object-cover flex-shrink-0 ${ring}`} />
    ) : (
      <span className={`${sz} rounded-full bg-slate-200 text-slate-500 ${textSz} font-bold flex items-center justify-center flex-shrink-0 ${ring}`}>{initials}</span>
    );
  };

  const _TechBadge = ({ techId, name }) => (
    <span className="inline-flex items-center gap-1">
      <TechAvatar techId={techId} name={name} />
      <span className="truncate max-w-[70px] text-[11px]">{name?.split(' ')[0]}</span>
    </span>
  );

  const AiPicks = ({ recommendations = [] }) => {
    const [open, setOpen] = useState(false);
    const hoverTimeoutRef = useRef(null);
    if (!recommendations.length) return null;
    const [top, ...rest] = recommendations;

    const showPopover = () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = setTimeout(() => setOpen(true), 350);
    };

    const hidePopover = () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      setOpen(false);
    };

    return (
      <span className="relative inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold">
          <span className="uppercase tracking-wide">AI</span>
          <TechAvatar techId={top.techId} name={top.techName} size="xs" />
          <span className="max-w-[58px] truncate">{top.techName?.split(' ')[0]}</span>
        </span>
        {rest.length > 0 && (
          <button
            type="button"
            onMouseEnter={showPopover}
            onMouseLeave={hidePopover}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-1.5 py-0.5 text-[10px] font-medium hover:bg-slate-200 touch-manipulation"
            aria-label={`Show ${rest.length} more AI recommendations`}
          >
            <span>+{rest.length}</span>
            <span className="inline-flex -space-x-1">
              {rest.slice(0, 2).map((r) => (
                <TechAvatar key={r.techId} techId={r.techId} name={r.techName} size="xs" ring="ring-1 ring-white" />
              ))}
            </span>
          </button>
        )}
        {open && (
          <div
            onMouseEnter={showPopover}
            onMouseLeave={hidePopover}
            className="absolute left-0 top-full mt-1 z-50 min-w-[190px] max-w-[240px] bg-slate-900 text-white text-[10px] rounded-lg py-1.5 px-2 shadow-lg"
          >
            {recommendations.map((r, i) => (
              <div key={r.techId} className="flex items-center gap-2 py-1">
                <span className="w-4 text-slate-400">{i + 1}.</span>
                <TechAvatar techId={r.techId} name={r.techName} size="xs" />
                <span className="truncate flex-1">{r.techName}</span>
                <span className="text-slate-300">{typeof r.score === 'number' ? `${(r.score * 100).toFixed(0)}%` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </span>
    );
  };

  // Shared props passed to the stable module-level QuickApprove components
  const qaInnerProps = {
    note: quickApproveNote,
    onNoteChange: setQuickApproveNote,
    selectedTechId: quickApproveTechId,
    onTechSelect: setQuickApproveTechId,
    approving: quickApproving,
    onCancel: () => setQuickApproveId(null),
    onSubmit: submitQuickApprove,
    techPhotos,
  };

  const activeItems = (() => {
    if (subView === 'pending') return filteredItems;
    if (subView === 'assigned') return combinedAssignedItems;
    if (subView === 'dismissed') return dismissedRuns.items;
    if (subView === 'rejected') return rejectedRuns.items;
    if (subView === 'deleted') return deletedRuns.items;
    return [...queue.items, ...combinedAssignedItems, ...dismissedRuns.items, ...rejectedRuns.items, ...deletedRuns.items]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  })();
  const showActions = subView === 'pending';

  const renderRunCard = (run) => {
    const topRec = run.recommendation?.recommendations?.[0];
    const flag = getTicketFlag(run);
    const recs = run.recommendation?.recommendations || [];
    const priLabel = PRIORITY_LABELS[run.ticket?.priority];
    const priPill = PRIORITY_PILL[run.ticket?.priority] || 'bg-slate-100 text-slate-500';
    const rowBg = flag === 'deleted' ? 'opacity-40 bg-red-50/30' : flag === 'closed' ? 'opacity-50 bg-slate-50' : flag === 'assigned' ? 'bg-amber-50/30' : '';
    const isNew = newIds.has(run.id);
    const cardBorder = isNew
      ? 'border-emerald-300'
      : flag === 'deleted' ? 'border-red-200' : flag === 'closed' ? 'border-slate-200' : flag === 'assigned' ? 'border-amber-200' : 'border-slate-300';
    const statusLabel = getStatusLabel(run.ticket?.status);
    const assignee = subView !== 'pending' ? (run.assignedTech || run.ticket?.assignedTech) : run.ticket?.assignedTech;

    return (
      <div
        key={run.id}
        onClick={() => handleSelectRun(run.id)}
        className={`px-3.5 py-3 active:bg-blue-50/60 touch-manipulation cursor-pointer border ${cardBorder} rounded-xl bg-white shadow-sm ${rowBg} transition-[border-color,box-shadow] duration-[2000ms] ${isNew ? 'shadow-emerald-100 shadow-md' : ''}`}
      >
        {/* Row 1: priority + ticket ID + category + decision (non-pending) + chevron */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${priPill}`}>{priLabel || '—'}</span>
          <span className="text-slate-400 font-mono text-[11px]">#{run.ticket?.freshserviceTicketId}</span>
          {run.ticket?.ticketCategory && <span className="text-[10px] text-slate-400 bg-slate-100 rounded px-1 py-0.5">{run.ticket.ticketCategory}</span>}
          {(run.reboundFrom || run.ticket?.lastReboundContext)?.previousTechName && (() => {
            const ctx = run.reboundFrom || run.ticket.lastReboundContext;
            return (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded leading-none"
                title={`Returned from ${ctx.previousTechName}${ctx.unassignedAt ? ' at ' + new Date(ctx.unassignedAt).toLocaleString() : ''}${ctx.unassignedByName ? ' by ' + ctx.unassignedByName : ''}${ctx.reboundCount > 1 ? ' (rebound #' + ctx.reboundCount + ')' : ''}`}
                onClick={(e) => e.stopPropagation()}
              >
                <RotateCcw className="w-2.5 h-2.5" />
                Returned from {ctx.previousTechName?.split(' ')[0]}
              </span>
            );
          })()}
          <span className="ml-auto" />
          {subView !== 'pending' && run.decision && (() => {
            const dd = getDisplayDecision(run);
            return (
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${dd.pillClass}`} title={dd.tooltip || undefined}>
                {dd.label}
              </span>
            );
          })()}
          <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
        </div>

        {/* Row 2: subject */}
        <p className="text-sm font-semibold text-slate-800 leading-snug mt-1.5 break-words">
          {run.ticket?.subject || 'No subject'}
        </p>

        {/* Row 3: requester + date */}
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] leading-none flex-wrap">
          <span className="text-slate-500 font-medium">{run.ticket?.requester?.name || '—'}</span>
          {run.ticket?.requester?.department && (
            <><span className="text-slate-300">·</span><span className="text-slate-400">{run.ticket.requester.department}</span></>
          )}
          <span className="text-slate-300">·</span>
          <span className="text-slate-400">{fmtDate(run.decidedAt || run.updatedAt || run.createdAt)}</span>
        </div>

        {/* Row 4: Status + AI Suggestion side by side */}
        <div className="flex items-start gap-3 mt-2">
          {/* Status section */}
          <div className={`flex items-center gap-1.5 ${flag === 'closed' || flag === 'deleted' ? 'opacity-50' : ''}`}>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${getStatusPillStyle(statusLabel)}`}>{statusLabel}</span>
            {assignee ? (
              avatarView ? (
                <span className="inline-flex items-center gap-1">
                  <TechAvatar techId={assignee.id} name={assignee.name} size="xs" ring="ring-1 ring-amber-300" />
                  <span className="text-[10px] text-slate-600">{assignee.name?.split(' ')[0]}</span>
                </span>
              ) : (
                <span className="text-[10px] text-amber-700 font-medium">{assignee.name?.split(' ')[0]}</span>
              )
            ) : run.ticket?.assignedTechId ? (
              <span className="text-[10px] text-slate-400 italic">External</span>
            ) : (
              <span className="text-[10px] text-slate-300">Unassigned</span>
            )}
          </div>

          {/* AI Suggestion section */}
          {recs.length > 0 && (
            <div className="flex items-center gap-1.5">
              {avatarView ? (
                <AiPicks recommendations={recs} />
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] text-blue-700 font-medium">
                  <span className="text-[9px] font-bold uppercase tracking-wider bg-blue-50 text-blue-600 px-1 rounded">AI</span>
                  {topRec.techName?.split(' ')[0]}
                  {recs.length > 1 && <span className="text-blue-400">+{recs.length - 1}</span>}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Row 5: Quick actions (pending only) */}
        {showActions && recs.length > 0 && flag !== 'deleted' && (
          <div className="flex items-center justify-end gap-0 mt-1.5 relative">
            <button onClick={(e) => openQuickApprove(e, run)} className={`p-1.5 rounded-md touch-manipulation min-w-[32px] min-h-[32px] flex items-center justify-center transition-colors ${quickApproveId === run.id ? 'bg-green-100 text-green-700' : 'text-green-500 active:bg-green-50'}`} aria-label="Quick approve">
              <Check className="w-4 h-4" />
            </button>
            {isAdmin && (
              <>
                <button onClick={(e) => handleDismiss(e, run.id)} className="p-1.5 text-yellow-500 active:bg-yellow-50 rounded-md touch-manipulation min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Dismiss">
                  <XCircle className="w-4 h-4" />
                </button>
                {confirmDeleteId === run.id ? (
                  <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-2 py-1 bg-red-500 text-white rounded text-[10px] font-semibold touch-manipulation min-h-[32px]">Delete?</button>
                ) : (
                  <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1.5 text-red-400 active:bg-red-50 rounded-md touch-manipulation min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </>
            )}
            <QuickApprovePopover run={run} align="left" quickApproveId={quickApproveId} popoverRef={quickApproveRef} {...qaInnerProps} />
          </div>
        )}

        {/* Pending with no recs or deleted — still show admin actions */}
        {showActions && (recs.length === 0 || flag === 'deleted') && isAdmin && (
          <div className="flex items-center justify-end gap-0 mt-1.5 relative">
            <button onClick={(e) => handleDismiss(e, run.id)} className="p-1.5 text-yellow-500 active:bg-yellow-50 rounded-md touch-manipulation min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Dismiss">
              <XCircle className="w-4 h-4" />
            </button>
            {confirmDeleteId === run.id ? (
              <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-2 py-1 bg-red-500 text-white rounded text-[10px] font-semibold touch-manipulation min-h-[32px]">Delete?</button>
            ) : (
              <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1.5 text-red-400 active:bg-red-50 rounded-md touch-manipulation min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Delete">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Action toast -- fixed position so it doesn't shift content */}
      {actionMsg && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] animate-in fade-in slide-in-from-top-2 duration-200">
          <div className={`text-sm rounded-lg px-4 py-2.5 border shadow-lg backdrop-blur-sm ${actionMsg.startsWith('Failed:') ? 'text-red-700 bg-red-50/95 border-red-200' : 'text-green-700 bg-green-50/95 border-green-200'}`}>{actionMsg}</div>
        </div>
      )}

      {/* Compact warning banner — clickable, scrolls down to the queued section */}
      {queuedRunsMeta.totalCount > 0 && (
        <button
          type="button"
          onClick={scrollToQueuedSection}
          className="group flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg border border-amber-200 bg-amber-50/70 hover:bg-amber-50 hover:border-amber-300 transition-colors"
          title="Jump to queued tickets"
        >
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
          <span className="text-[12px] font-semibold text-amber-800">
            {queuedRunsMeta.totalCount} ticket{queuedRunsMeta.totalCount !== 1 ? 's' : ''} queued for next business hours
          </span>
          {queuedRunsMeta.truncated && (
            <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              showing first {queuedRuns.length}
            </span>
          )}
          {queueStatus && !queueStatus.isBusinessHours && queueStatus.nextWindow && (
            <span className="text-[11px] text-amber-600">· starts {queueStatus.nextWindow.label}</span>
          )}
          {queueStatus?.isBusinessHours && (
            <span className="text-[11px] text-emerald-600 font-medium">· active — processing on next sync</span>
          )}
          <span className="ml-auto text-[11px] font-medium text-amber-700 opacity-0 group-hover:opacity-100 transition-opacity">View ↓</span>
        </button>
      )}

      {/* Sub-view tabs + filters + toolbar (single compact row; ticket status only on Pending) */}
      <div className="border border-slate-200 rounded-lg">
        <div className="bg-slate-50 border-b border-slate-200 px-3 sm:px-4 py-2 rounded-t-lg">
          <div className="overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex min-w-max items-center gap-2">
              {/* Primary tabs — modern segmented control with subtle elevation on active */}
              <div className="inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-slate-100 p-1 ring-1 ring-slate-200/60">
                {[
                  { id: 'pending', label: 'Awaiting Decision', count: queue.totals?.unassigned ?? 0, dot: 'bg-amber-400', activeRing: 'ring-amber-200' },
                  { id: 'assigned', label: 'Decided', count: assignedTotal, dot: 'bg-emerald-400', activeRing: 'ring-emerald-200' },
                  { id: 'dismissed', label: 'Dismissed', count: dismissedRuns.total, dot: 'bg-slate-400', activeRing: 'ring-slate-200' },
                  { id: 'rejected', label: 'Rejected', count: rejectedRuns.total, dot: 'bg-rose-400', activeRing: 'ring-rose-200' },
                  { id: 'deleted', label: 'Deleted', count: deletedRuns.total, dot: 'bg-red-500', activeRing: 'ring-red-200' },
                  { id: 'all', label: 'All', count: null, dot: null, activeRing: 'ring-slate-200' },
                ].map((tab) => {
                  const isActive = subView === tab.id;
                  const isZero = tab.count === 0;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => { setSubView(tab.id); setAssignedFilter('all'); setDecidedDecisionFilter('all'); }}
                      className={`group relative rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200 touch-manipulation flex items-center gap-1.5 sm:px-3 ${
                        isActive
                          ? `bg-white text-slate-900 shadow-sm ring-1 ${tab.activeRing}`
                          : `${isZero ? 'text-slate-400' : 'text-slate-600'} hover:text-slate-900 hover:bg-white/70`
                      }`}
                    >
                      {tab.dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.dot} ${isZero && !isActive ? 'opacity-40' : ''}`} />}
                      <span>{tab.label}</span>
                      {tab.count != null && (
                        <span className={`tabular-nums text-[10px] font-bold ${isActive ? 'text-slate-500' : isZero ? 'text-slate-300' : 'text-slate-400'}`}>
                          {tab.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <QueueFilterRail
                subView={subView}
                assignedTotal={assignedTotal}
                assignedRunsTotal={assignedRuns.total}
                outsideAssignedTotal={outsideAssignedRuns.total}
                assignedFilter={assignedFilter}
                onAssignedFilterChange={setAssignedFilter}
                decidedDecisionFilter={decidedDecisionFilter}
                onDecidedDecisionFilterChange={setDecidedDecisionFilter}
                ticketStatusFilter={ticketStatusFilter}
                onTicketStatusFilterChange={setTicketStatusFilter}
                differentAgentCount={differentAgentCount}
              />

              <div className="min-w-4 flex-1" />

              {filterPriority !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFilterPriority('all')}
                  className="shrink-0 text-[10px] font-medium text-blue-600 hover:text-blue-800"
                >
                  Clear priority
                </button>
              )}

              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="touch-manipulation rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] shadow-sm">
                <option value="all">Priority</option>
                <option value="4">Urgent</option>
                <option value="3">High</option>
                <option value="2">Medium</option>
                <option value="1">Low</option>
              </select>

              {subView === 'pending' && (queue.totals?.all ?? queue.total) > 0 && isAdmin && (
                <button type="button" onClick={() => setShowClearConfirm(true)} className="flex touch-manipulation items-center gap-1 rounded border border-red-200 px-2 py-1 text-[10px] text-red-600 hover:bg-red-50 hover:text-red-700">
                  <Trash2 className="h-3 w-3" /> Delete all
                </button>
              )}
              <button
                type="button"
                onClick={() => setAvatarView((v) => !v)}
                className={`touch-manipulation rounded border px-2 py-1 text-[10px] font-medium transition-colors ${avatarView ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'}`}
                title={avatarView ? 'Switch to text view' : 'Switch to avatar view'}
              >
                {avatarView ? '≡ Text' : '⊙ Avatars'}
              </button>
              <span className="hidden sm:flex items-center gap-1 text-[10px] font-medium text-emerald-600 select-none" title="Auto-refreshes every 30 seconds">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
              <button type="button" onClick={handleSmartRefresh} disabled={refreshing} className="touch-manipulation p-1 text-blue-600 hover:text-blue-800 disabled:opacity-50" title="Sync with FreshService & refresh">
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
              </div>
            </div>
          </div>
        </div>

        {/* Clear all confirmation */}
        {showClearConfirm && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-3 flex items-center gap-3 flex-wrap">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-800 flex-1 min-w-0">
              Delete all <strong>{queue.totals?.all ?? queue.total}</strong> pending reviews? This permanently removes these pipeline runs from Ticket Pulse and does not change the FreshService tickets.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAll}
                disabled={clearing}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {clearing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                {clearing ? 'Deleting...' : 'Yes, delete all'}
              </button>
            </div>
          </div>
        )}

        {/* Refreshing indicator - floating, doesn't reflow content */}
        {refreshing && (
          <div className="pointer-events-none fixed top-4 right-4 z-[150] animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="pointer-events-auto bg-blue-50/95 border border-blue-200 rounded-full px-3 py-1.5 flex items-center gap-2 text-[11px] text-blue-700 font-medium shadow-lg backdrop-blur-sm">
              <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
              Syncing with FreshService…
            </div>
          </div>
        )}

        {/* New arrivals toast -- fixed position so it doesn't shift ticket list */}
        {newIds.size > 0 && subView === 'pending' && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[200] animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="bg-emerald-50/95 border border-emerald-300 rounded-full px-4 py-2 flex items-center gap-2 text-[11px] text-emerald-700 font-semibold shadow-lg backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
              {newIds.size} new ticket{newIds.size > 1 ? 's' : ''} arrived
            </div>
          </div>
        )}

        {/* In-progress pipeline runs — tickets being analyzed by the LLM right now.
            These appear right after a sync (or scheduled poll) and stay for a few
            seconds-to-minutes until the LLM finishes ranking candidates. Without
            this section the user wouldn't know the system is working — the queue
            looks empty even though analysis is underway. */}
        {subView === 'pending' && queue.inProgress && queue.inProgress.length > 0 && (
          <div className="border border-blue-200 bg-blue-50/40 rounded-lg overflow-hidden">
            <div className="px-3 py-1.5 border-b border-blue-100 bg-blue-50/60 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin flex-shrink-0" />
              <span className="text-[12px] font-semibold text-blue-800">
                Analyzing {queue.inProgress.length} ticket{queue.inProgress.length !== 1 ? 's' : ''}…
              </span>
              <span className="text-[10px] text-blue-600">
                AI is ranking candidates — usually 5–30s per ticket
              </span>
            </div>
            <div className="divide-y divide-blue-50">
              {queue.inProgress.map((run) => (
                <div key={`ip-${run.id}`} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                  <Loader2 className="w-3 h-3 text-blue-500 animate-spin flex-shrink-0 opacity-60" />
                  <span className="text-[10px] text-slate-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                  <span className="text-slate-700 font-medium truncate flex-1">{run.ticket?.subject || 'No subject'}</span>
                  <span className="text-[10px] text-slate-400 hidden sm:inline">{run.ticket?.requester?.name || ''}</span>
                  <span className="text-[10px] text-blue-600 italic">analyzing…</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* List content - key triggers a subtle fade-in on tab/filter/page change */}
        <div key={`${subView}-${assignedFilter}-${queuePage}-${ticketStatusFilter}`} className="animate-in fade-in duration-150">
          {activeItems.length === 0 ? (
            // When auto-assign is on and the pending queue is empty, the
            // pipeline is doing its job behind the scenes — show today's
            // stats so the page is informative instead of feeling broken.
            // Falls back to the original sparse placeholder for every other
            // case (decided/dismissed/rejected/deleted tabs, or auto-assign
            // off).
            subView === 'pending' && queueStatus?.autoAssign ? (
              <AutoAssignActiveEmptyState
                queueStatus={queueStatus}
                inProgressCount={queue.inProgress?.length || 0}
                queuedRunsTotal={queuedRunsMeta?.totalCount || 0}
                onRefresh={handleSmartRefresh}
                onNavigate={(target) => {
                  // Drive the parent's tab + sub-filter state from the
                  // empty-state stat tiles so they double as quick links.
                  // Also nudge the short-range filter so the destination
                  // uses the same current-PT-day window the cards just
                  // promised.
                  if (target.subView) setSubView(target.subView);
                  // Reset filters when not provided so a stale value from a
                  // previous visit doesn't leak through.
                  setAssignedFilter(target.assignedFilter || 'all');
                  setDecidedDecisionFilter(target.decidedDecisionFilter || 'all');
                  // Default to 'all' ticket statuses on drill-down so closed/
                  // resolved tickets aren't silently hidden by the
                  // 'in_progress' default — the empty-state counts include
                  // every ticket regardless of current status. Skip the
                  // subView useEffect's auto-reset for this render.
                  skipNextStatusReset.current = true;
                  setTicketStatusFilter(target.ticketStatus || 'all');
                  if (target.timeRange && onTimeRangeChange) {
                    onTimeRangeChange(target.timeRange);
                  }
                }}
              />
            ) : (
              <div className="text-center py-10">
                <Inbox className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                <p className="text-slate-500 text-sm font-medium">
                  {subView === 'pending'
                    ? (queue.inProgress?.length > 0
                      ? 'No tickets awaiting decision yet — AI is still analyzing'
                      : 'No tickets awaiting decision')
                    : subView === 'assigned'
                      ? 'No decisions in this period'
                      : subView === 'dismissed'
                        ? 'No dismissed runs in this period'
                        : subView === 'rejected'
                          ? 'No rejected runs in this period'
                          : subView === 'deleted'
                            ? 'No deleted tickets in this period'
                            : 'No runs found'}
                </p>
                <button onClick={handleSmartRefresh} className="mt-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
              </div>
            )
          ) : (
            <>
              {/* Mobile cards */}
              <div className="md:hidden space-y-0 py-3 px-1">
                {activeItems.map((run) => (
                  <div
                    key={run.id}
                    style={{
                      display: 'grid',
                      gridTemplateRows: removingIds.has(run.id) ? '0fr' : '1fr',
                      opacity: removingIds.has(run.id) ? 0 : 1,
                      transition: 'grid-template-rows 240ms ease, opacity 200ms ease',
                      marginBottom: removingIds.has(run.id) ? 0 : '0.75rem',
                    }}
                  >
                    <div style={{ overflow: 'hidden' }}>
                      {renderRunCard(run)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <table className="hidden md:table w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-slate-500 cursor-pointer select-none" onClick={() => toggleSort('subject')}>
                      <span className="flex items-center gap-1">Ticket <SortIcon field="subject" /></span>
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500 cursor-pointer select-none" onClick={() => toggleSort('requester')}>
                      <span className="flex items-center gap-1">Requester <SortIcon field="requester" /></span>
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500 cursor-pointer select-none w-12" onClick={() => toggleSort('priority')}>
                      <span className="flex items-center gap-1">Pri <SortIcon field="priority" /></span>
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500">Status</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500">AI Suggestion</th>
                    {subView !== 'pending' && <th className="text-left px-3 py-2 font-medium text-slate-500">Decision</th>}
                    <th className="text-left px-3 py-2 font-medium text-slate-500 cursor-pointer select-none" onClick={() => toggleSort('createdAt')}>
                      <span className="flex items-center gap-1">{subView === 'pending' ? 'Analyzed' : 'Decided'} <SortIcon field="createdAt" /></span>
                    </th>
                    {showActions && <th className="px-3 py-2 font-medium text-slate-500 text-right w-20"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {activeItems.map((run) => {
                    const topRec = run.recommendation?.recommendations?.[0];
                    const flag = getTicketFlag(run);
                    const rowDim = subView === 'pending' && flag === 'deleted' ? 'opacity-40' : subView === 'pending' && flag === 'closed' ? 'opacity-50' : '';
                    return (
                      <tr key={run.id} className={`hover:bg-blue-50 cursor-pointer group border-l-3 ${PRIORITY_BORDER[run.ticket?.priority] || 'border-l-slate-200'} ${subView === 'pending' && flag === 'deleted' ? 'bg-red-50/30' : subView === 'pending' && flag === 'closed' ? 'bg-slate-50' : subView === 'pending' && flag === 'assigned' ? 'bg-amber-50/30' : newIds.has(run.id) ? 'bg-emerald-50/60' : ''} transition-[opacity,background-color] duration-[240ms] ${removingIds.has(run.id) ? 'opacity-0' : ''}`} onClick={() => handleSelectRun(run.id)}>
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          <span className="font-medium text-slate-800 leading-snug flex items-center gap-1.5 flex-wrap">
                            {run.ticket?.subject || 'No subject'}
                            {flag === 'deleted' && <Trash2 className="w-3.5 h-3.5 text-red-400 flex-shrink-0" title="Deleted in FreshService" />}
                            {(run.reboundFrom || run.ticket?.lastReboundContext)?.previousTechName && (() => {
                              const ctx = run.reboundFrom || run.ticket.lastReboundContext;
                              return (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded leading-none"
                                  title={`Returned from ${ctx.previousTechName}${ctx.unassignedAt ? ' at ' + new Date(ctx.unassignedAt).toLocaleString() : ''}${ctx.unassignedByName ? ' by ' + ctx.unassignedByName : ''}${ctx.reboundCount > 1 ? ' (rebound #' + ctx.reboundCount + ')' : ''}`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <RotateCcw className="w-2.5 h-2.5" />
                                  Returned from {ctx.previousTechName?.split(' ')[0]}
                                </span>
                              );
                            })()}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                          {run.ticket?.ticketCategory && <span className="text-[10px] text-slate-300 ml-1.5">{run.ticket.ticketCategory}</span>}
                          {run._siblingCount > 0 && (
                            <span className="ml-1.5 text-[9px] text-slate-400" title={`${run._siblingCount} earlier run${run._siblingCount > 1 ? 's' : ''} for this ticket — switch to a sub-filter to see all`}>
                              +{run._siblingCount} earlier
                            </span>
                          )}
                        </td>
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          <span className="text-slate-700">{run.ticket?.requester?.name || '—'}</span>
                          {run.ticket?.requester?.department && <span className="block text-[10px] text-slate-400">{run.ticket.requester.department}</span>}
                          {run.ticket?.requester?.email && !run.ticket?.requester?.department && <span className="block text-[10px] text-slate-300">{run.ticket.requester.email}</span>}
                        </td>
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_PILL[run.ticket?.priority] || 'bg-slate-100 text-slate-500'}`}>
                            {PRIORITY_LABELS[run.ticket?.priority] || '—'}
                          </span>
                        </td>
                        {/* Status column */}
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          <div className="flex flex-col gap-0.5">
                            <span className={`inline-flex self-start rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${getStatusPillStyle(getStatusLabel(run.ticket?.status))}`}>
                              {getStatusLabel(run.ticket?.status)}
                            </span>
                            {(() => {
                              const assignee = subView !== 'pending' ? (run.assignedTech || run.ticket?.assignedTech) : run.ticket?.assignedTech;
                              if (assignee) return avatarView ? (
                                <span className="inline-flex items-center gap-1 mt-0.5" title={assignee.name}>
                                  <TechAvatar techId={assignee.id} name={assignee.name} size="xs" ring="ring-1 ring-amber-300" />
                                  <span className="text-[10px] text-slate-600 truncate max-w-[80px]">{assignee.name?.split(' ')[0]}</span>
                                </span>
                              ) : (
                                <span className="text-[10px] text-amber-700 font-medium truncate max-w-[100px]">{assignee.name}</span>
                              );
                              if (run.ticket?.assignedTechId) return <span className="text-[10px] text-slate-400 italic">External</span>;
                              return <span className="text-[10px] text-slate-300">Unassigned</span>;
                            })()}
                          </div>
                        </td>
                        {/* AI Suggestion column */}
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          {run.recommendation?.recommendations?.length > 0 ? (
                            avatarView ? (
                              <AiPicks recommendations={run.recommendation.recommendations} />
                            ) : (
                              <div className="text-[11px] leading-snug">
                                <span className="text-blue-700 font-medium">{topRec?.techName}</span>
                                {run.recommendation.recommendations.length > 1 && (
                                  <span className="text-blue-400 ml-1 text-[10px]">+{run.recommendation.recommendations.length - 1}</span>
                                )}
                              </div>
                            )
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        {subView !== 'pending' && (() => {
                          const dd = getDisplayDecision(run);
                          return (
                            <td className={`px-3 py-1.5 ${rowDim}`}>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${dd.pillClass}`} title={dd.tooltip || undefined}>
                                {dd.label}
                              </span>
                            </td>
                          );
                        })()}
                        <td className={`px-3 py-1.5 text-slate-400 whitespace-nowrap ${rowDim}`}>{fmtDate(run.decidedAt || run.updatedAt || run.createdAt)}</td>
                        {showActions && (
                          <td className="px-3 py-1.5 relative">
                            <div className={`flex items-center justify-end gap-0.5 transition-opacity ${quickApproveId === run.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                              {run.recommendation?.recommendations?.length > 0 && flag !== 'deleted' && (
                                <button onClick={(e) => openQuickApprove(e, run)} className={`p-1 rounded transition-colors ${quickApproveId === run.id ? 'bg-green-100 text-green-700' : 'text-green-500 hover:text-green-700 hover:bg-green-50'}`} title="Quick approve"><Check className="w-3.5 h-3.5" /></button>
                              )}
                              {isAdmin && (
                                <>
                                  <button onClick={(e) => handleDismiss(e, run.id)} className="p-1 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-50 rounded" title="Dismiss"><XCircle className="w-3.5 h-3.5" /></button>
                                  {confirmDeleteId === run.id ? (
                                    <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-1.5 py-0.5 bg-red-500 text-white rounded text-[10px] font-semibold">Delete?</button>
                                  ) : (
                                    <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                                  )}
                                </>
                              )}
                            </div>
                            <QuickApprovePopover run={run} quickApproveId={quickApproveId} popoverRef={quickApproveRef} {...qaInnerProps} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* Pagination controls for pending queue */}
        {subView === 'pending' && queue.total > queuePageSize && (
          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/50 px-4 py-2.5 animate-in fade-in duration-150">
            <span className="text-[11px] text-slate-500">
              Showing {queuePage * queuePageSize + 1}–{Math.min((queuePage + 1) * queuePageSize, queue.total)} of {queue.total}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setQueuePage(p => Math.max(0, p - 1))}
                disabled={queuePage === 0}
                className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              {Array.from({ length: Math.ceil(queue.total / queuePageSize) }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setQueuePage(i)}
                  className={`w-7 h-7 text-[11px] font-medium rounded border transition-colors ${i === queuePage ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                onClick={() => setQueuePage(p => Math.min(Math.ceil(queue.total / queuePageSize) - 1, p + 1))}
                disabled={queuePage >= Math.ceil(queue.total / queuePageSize) - 1}
                className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Queued for business hours — collapsible (collapsed by default) */}
      {queuedRunsMeta.totalCount > 0 && (
        <div ref={queuedSectionRef} className="border border-amber-200 rounded-lg overflow-hidden scroll-mt-4">
          <div className="w-full bg-amber-50/80 px-3 sm:px-4 py-1.5 border-b border-amber-100 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQueuedExpanded((v) => !v)}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left"
              aria-expanded={queuedExpanded}
            >
              <ChevronDown
                className={`w-3.5 h-3.5 text-amber-600 flex-shrink-0 transition-transform duration-300 ${queuedExpanded ? 'rotate-0' : '-rotate-90'}`}
              />
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <span className="text-[12px] font-semibold text-amber-800">Queued for Business Hours</span>
              <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums">{queuedRunsMeta.totalCount}</span>
              {queuedRunsMeta.truncated && (
                <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  showing first {queuedRuns.length}
                </span>
              )}
            </button>
            <div className="flex-1" />
            {isAdmin && (
              <button
                type="button"
                onClick={handlePruneQueue}
                disabled={pruning}
                className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 hover:bg-amber-100 px-2 py-0.5 rounded transition-colors disabled:opacity-50"
                title="Mark all queued tickets as skipped if they're no longer eligible (closed, deleted, assigned)"
              >
                {pruning ? 'Pruning…' : 'Prune stale'}
              </button>
            )}
            {queueStatus && !queueStatus.isBusinessHours && queueStatus.nextWindow ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-700">
                <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
                Starts {queueStatus.nextWindow.label}
              </span>
            ) : queueStatus?.isBusinessHours ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700">
                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                Active — processing on next sync
              </span>
            ) : null}
          </div>
          {/* Smooth collapse using grid-template-rows trick (transitions max content height fluidly) */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out"
            style={{ gridTemplateRows: queuedExpanded ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              <div className="md:hidden divide-y divide-amber-50 bg-white">
                {queuedRuns.map((run) => (
                  <div key={run.id} className="px-3 py-2 space-y-1.5">
                    <div>
                      <span className="text-[10px] text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                      {run.reboundFrom?.previousTechName && (
                        <span
                          className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded leading-none"
                          title={`Returned from ${run.reboundFrom.previousTechName}${run.reboundFrom.unassignedAt ? ' at ' + new Date(run.reboundFrom.unassignedAt).toLocaleString() : ''}${run.reboundFrom.unassignedByName ? ' by ' + run.reboundFrom.unassignedByName : ''}${run.reboundFrom.reboundCount > 1 ? ' (rebound #' + run.reboundFrom.reboundCount + ')' : ''}`}
                        >
                          <RotateCcw className="w-2.5 h-2.5" />
                          Returned from {run.reboundFrom.previousTechName?.split(' ')[0]}
                        </span>
                      )}
                      <p className="font-medium text-slate-800 text-[13px] leading-snug">{run.ticket?.subject || 'No subject'}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{run.queuedReason || 'Outside business hours'}</p>
                    </div>
                    {isAdmin && (
                      <div className="flex items-center gap-1.5">
                        <button onClick={(e) => handleRunNow(e, run.id)} className="flex-1 px-2.5 py-1.5 bg-blue-600 text-white rounded text-[11px] font-semibold hover:bg-blue-700 flex items-center justify-center gap-1 shadow-sm touch-manipulation">
                          <Play className="w-3 h-3" /> Run Now
                        </button>
                        {confirmDeleteId === run.id ? (
                          <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-2 py-1.5 bg-red-500 text-white rounded text-[11px] font-semibold touch-manipulation">Delete?</button>
                        ) : (
                          <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-100 rounded touch-manipulation" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <table className="hidden md:table w-full text-xs">
                <thead><tr className="text-[10px] text-amber-600 border-b border-amber-100 bg-amber-50/40">
                  <th className="text-left px-3 py-1 font-medium">Ticket</th>
                  <th className="text-left px-3 py-1 font-medium">Reason</th>
                  <th className="text-left px-3 py-1 font-medium">Queued At</th>
                  {isAdmin && <th className="px-3 py-1 text-right font-medium w-32">Actions</th>}
                </tr></thead>
                <tbody>
                  {queuedRuns.map((run) => (
                    <tr key={run.id} className="border-t border-amber-50 hover:bg-amber-50/60 transition-colors">
                      <td className="px-3 py-1.5">
                        <span className="text-[10px] text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                        {run.reboundFrom?.previousTechName && (
                          <span
                            className="ml-2 inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded align-middle leading-none"
                            title={`Returned from ${run.reboundFrom.previousTechName}${run.reboundFrom.unassignedAt ? ' at ' + new Date(run.reboundFrom.unassignedAt).toLocaleString() : ''}${run.reboundFrom.unassignedByName ? ' by ' + run.reboundFrom.unassignedByName : ''}${run.reboundFrom.reboundCount > 1 ? ' (rebound #' + run.reboundFrom.reboundCount + ')' : ''}`}
                          >
                            <RotateCcw className="w-2.5 h-2.5" />
                            Returned from {run.reboundFrom.previousTechName}
                          </span>
                        )}
                        <span className="ml-2 font-medium text-slate-800">{run.ticket?.subject || 'No subject'}</span>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-slate-500">{run.queuedReason || 'Outside business hours'} · via {run.triggerSource}</td>
                      <td className="px-3 py-1.5 text-[11px] text-slate-400 whitespace-nowrap">{formatDateTimeInTimezone(run.queuedAt, workspaceTimezone)}</td>
                      {isAdmin && (
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            <button onClick={(e) => handleRunNow(e, run.id)} className="px-2 py-1 bg-blue-600 text-white rounded text-[10px] font-semibold hover:bg-blue-700 flex items-center gap-1 shadow-sm transition-colors"><Play className="w-3 h-3" /> Run Now</button>
                            {confirmDeleteId === run.id ? (
                              <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-1.5 py-0.5 bg-red-500 text-white rounded text-[10px] font-semibold">Delete?</button>
                            ) : (
                              <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <ManualTriggerPanel isAdmin={isAdmin} />
      <MobileQuickApproveSheet
        activeItems={activeItems}
        quickApproveId={quickApproveId}
        guardRef={quickApproveGuardRef}
        onClose={() => setQuickApproveId(null)}
        sheetRef={quickApproveMobileRef}
        {...qaInnerProps}
      />

      {/* Run Now live overlay -- streams the promoted queued run via SSE so the
          user sees Claude's analysis live instead of staring at a 5s toast. */}
      {runNowLive && (
        <RunNowLiveOverlay
          info={runNowLive}
          onClose={closeRunNowLive}
        />
      )}
    </div>
  );
}

/**
 * Modal/slide-over wrapping LivePipelineView for the "Run Now" flow on a queued run.
 * The run-now SSE endpoint at /assignment/runs/{runId}/run-now?stream=true mirrors
 * the manual /trigger?stream=true contract, so the existing live view can stream it
 * unchanged once we pass streamPath + skipExistingCheck + initialRunId.
 */
function RunNowLiveOverlay({ info, onClose }) {
  // Block background scroll while the overlay is open and let Esc close it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const fsLabel = info.freshserviceTicketId ? `#${info.freshserviceTicketId}` : `Run #${info.runId}`;

  return (
    <div className="fixed inset-0 z-[300] bg-black/40 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-white w-full sm:max-w-5xl sm:rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-screen sm:max-h-[90vh]">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
              <Brain className="w-3.5 h-3.5" />
              Running queued ticket now
            </div>
            <div className="mt-0.5 text-sm font-semibold text-slate-800 truncate" title={info.subject}>
              <span className="text-slate-400 mr-1.5">{fsLabel}</span>
              {info.subject}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-white/70 transition-colors"
            title="Close (Esc) — analysis continues in the background"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-5">
          {info.ticketId ? (
            <LivePipelineView
              ticketId={info.ticketId}
              streamPath={assignmentAPI.runNowStreamPath(info.runId)}
              skipExistingCheck
              initialRunId={info.runId}
              onComplete={onClose}
            />
          ) : (
            <div className="p-6 text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">
              Cannot stream this run — internal ticket ID is missing. The run is still executing in the background; check the History tab in a few seconds.
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-2.5 border-t bg-slate-50 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Closing this window won&apos;t cancel the run — it continues server-side.</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ deepRunId, isAdmin = false, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState({ items: [], total: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDecision, setFilterDecision] = useState('all');
  const limit = 20;

  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getRuns({ limit, offset: page * limit });
      setRuns({ items: res?.items || [], total: res?.total || 0 });
    } catch {
      setRuns({ items: [], total: 0 });
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  useEffect(() => {
    if (deepRunId) {
      (async () => {
        try {
          const res = await assignmentAPI.getRun(parseInt(deepRunId));
          setSelectedRun(res?.data || null);
        } catch {
          setSelectedRun(null);
        }
      })();
    } else {
      setSelectedRun(null);
    }
  }, [deepRunId]);

  const handleSelectRun = (runId) => {
    navigate(`/assignments/history/${runId}`);
  };

  const refreshSelectedRun = async () => {
    if (!selectedRun) return;
    try {
      const res = await assignmentAPI.getRun(selectedRun.id);
      setSelectedRun(res?.data || null);
    } catch { /* ignore */ }
  };

  if (selectedRun) {
    return (
      <div>
        <button
          onClick={() => { setSelectedRun(null); navigate('/assignments/history'); }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5 mb-4 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back to history
        </button>
        <PipelineRunDetail run={selectedRun} workspaceTimezone={workspaceTimezone} onDecide={null} deciding={false} isAdmin={isAdmin} onSyncComplete={refreshSelectedRun} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const DECISION_BADGES = {
    pending_review: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    modified: 'bg-blue-100 text-blue-800',
    rejected: 'bg-red-100 text-red-800',
    auto_assigned: 'bg-purple-100 text-purple-800',
    noise_dismissed: 'bg-gray-100 text-gray-600',
    deferred: 'bg-orange-100 text-orange-800',
  };
  const STATUS_BADGES = {
    queued: 'bg-orange-100 text-orange-800',
    running: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-600',
    superseded: 'bg-gray-100 text-gray-600',
    skipped_stale: 'bg-gray-100 text-gray-600',
  };

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-slate-400" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-blue-600" /> : <ArrowDown className="w-3 h-3 text-blue-600" />;
  };

  const filteredRuns = [...runs.items]
    .filter((r) => filterStatus === 'all' || r.status === filterStatus)
    .filter((r) => filterDecision === 'all' || r.decision === filterDecision)
    .sort((a, b) => {
      let av, bv;
      if (sortField === 'createdAt') { av = new Date(a.createdAt); bv = new Date(b.createdAt); }
      else if (sortField === 'status') { av = a.status || ''; bv = b.status || ''; }
      else if (sortField === 'trigger') { av = a.triggerSource || ''; bv = b.triggerSource || ''; }
      else { av = a.ticket?.subject || ''; bv = b.ticket?.subject || ''; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  const totalPages = Math.ceil(runs.total / limit);

  return (
    <div className="space-y-3">
      {runs.items.length === 0 ? (
        <div className="text-center py-12">
          <History className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No pipeline runs yet</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          {/* Toolbar */}
          <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm font-medium text-slate-700">{runs.total} run{runs.total !== 1 ? 's' : ''}</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <Filter className="w-3.5 h-3.5" />
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white">
                <option value="all">All statuses</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="running">Running</option>
                <option value="queued">Queued</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select value={filterDecision} onChange={(e) => setFilterDecision(e.target.value)} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white">
                <option value="all">All decisions</option>
                <option value="pending_review">Pending review</option>
                <option value="approved">Approved</option>
                <option value="noise_dismissed">Noise dismissed</option>
                <option value="auto_assigned">Auto assigned</option>
                <option value="rejected">Rejected</option>
                <option value="modified">Modified</option>
              </select>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs">Run</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('subject')}>
                  <span className="flex items-center gap-1">Ticket <SortIcon field="subject" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('trigger')}>
                  <span className="flex items-center gap-1">Trigger <SortIcon field="trigger" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('status')}>
                  <span className="flex items-center gap-1">Status <SortIcon field="status" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('createdAt')}>
                  <span className="flex items-center gap-1">Date <SortIcon field="createdAt" /></span>
                </th>
                <th className="px-4 py-2.5 text-xs text-right font-medium text-slate-500">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRuns.map((run) => (
                <tr key={run.id} className="hover:bg-slate-50 cursor-pointer group" onClick={() => handleSelectRun(run.id)}>
                  <td className="px-4 py-3 text-xs font-mono text-slate-400">#{run.id}</td>
                  <td className="px-4 py-3 max-w-xs">
                    <p className="font-medium text-slate-800 truncate">#{run.ticket?.freshserviceTicketId} — {run.ticket?.subject || 'No subject'}</p>
                    {run.assignedTech && <p className="text-xs text-slate-400 mt-0.5">→ {run.assignedTech.name}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 capitalize">{run.triggerSource}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGES[run.status] || 'bg-slate-100 text-slate-600'}`}>
                        {(run.status || 'unknown').replace(/_/g, ' ')}
                      </span>
                      {run.status === 'completed' && run.decision && (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${DECISION_BADGES[run.decision] || 'bg-slate-100 text-slate-600'}`}>
                          {run.decision.replace(/_/g, ' ')}
                        </span>
                      )}
                      {run.syncStatus && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            run.syncStatus === 'synced'
                              ? 'bg-green-100 text-green-700'
                              : run.syncStatus === 'failed'
                                ? 'bg-red-100 text-red-700'
                                : run.syncStatus === 'dry_run'
                                  ? 'bg-yellow-100 text-yellow-700'
                                  : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {run.syncStatus === 'synced' ? '✓ synced' : run.syncStatus === 'dry_run' ? '◑ dry run' : run.syncStatus === 'failed' ? '✗ sync failed' : run.syncStatus}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{formatDateTimeInTimezone(run.createdAt, workspaceTimezone)}</td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-blue-500 ml-auto transition-colors" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 flex items-center justify-between">
              <span className="text-xs text-slate-500">Page {page + 1} of {totalPages}</span>
              <div className="flex gap-1">
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 border border-slate-200 rounded text-xs hover:bg-white disabled:opacity-40 flex items-center gap-1">
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1} className="px-3 py-1 border border-slate-200 rounded text-xs hover:bg-white disabled:opacity-40 flex items-center gap-1">
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigToggle({ label, description, checked, onChange, color = 'text-blue-600' }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="mr-4">
        <h4 className="font-medium text-sm text-slate-800">{label}</h4>
        <p className="text-xs text-slate-500 mt-0.5">{description}</p>
      </div>
      <button onClick={onChange} className="flex-shrink-0">
        {checked
          ? <ToggleRight className={`w-8 h-8 ${color}`} />
          : <ToggleLeft className="w-8 h-8 text-slate-300" />
        }
      </button>
    </div>
  );
}

function ConfigSection({ icon: Icon, title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2.5 px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left">
        <Icon className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-slate-700 flex-1">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && <div className="px-4 pb-4 divide-y divide-slate-100">{children}</div>}
    </div>
  );
}

/**
 * Multi-select group picker. When `autoAssign` is off this whole control is
 * informational only (any selections are saved but have no effect, so we
 * surface a hint instead of disabling). Live-fetches the FreshService group
 * list once on mount via GET /assignment/groups; if FS is unreachable we
 * still render the currently-selected IDs as opaque chips so the admin
 * doesn't lose their selection silently.
 */
function ExcludedGroupsPicker({ autoAssign, excludedGroupIds, onChange }) {
  const [groups, setGroups] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await assignmentAPI.getGroups();
        if (!cancelled) {
          setGroups(res?.data || []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || err.message || 'Could not load FreshService groups');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedSet = new Set((excludedGroupIds || []).map(Number));
  const toggle = (id) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };

  const visibleGroups = (groups || []).filter((g) =>
    !filter || g.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="py-3 space-y-3">
      <p className="text-xs text-slate-500 leading-relaxed">
        Tickets in any of the selected groups will <span className="font-semibold text-slate-700">always require manual approval</span> in the Review Queue, even when Auto-Assign is on. The LLM still produces a recommendation; an admin just has to click approve before it gets written back to FreshService.
      </p>

      {!autoAssign && (
        <div className="flex items-start gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
          <AlertCircle className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
          <span>Auto-Assign is currently off, so this list has no effect right now. Selections are still saved.</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading groups from FreshService...
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Could not load FreshService groups</p>
            <p className="mt-0.5">{error}</p>
            {selectedSet.size > 0 && (
              <p className="mt-1.5 text-red-800">
                Currently selected (by ID): {[...selectedSet].join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {!loading && !error && groups && (
        <>
          {groups.length > 8 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter groups..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
              />
            </div>
          )}

          {selectedSet.size > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <Check className="w-3 h-3 text-emerald-600" />
              <span>{selectedSet.size} group{selectedSet.size === 1 ? '' : 's'} excluded</span>
              <button
                onClick={() => onChange([])}
                className="ml-auto text-blue-600 hover:text-blue-800 hover:underline"
              >
                Clear all
              </button>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {visibleGroups.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                {filter ? 'No groups match the filter.' : 'No FreshService groups in this workspace.'}
              </div>
            )}
            {visibleGroups.map((g) => {
              const checked = selectedSet.has(g.id);
              return (
                <label
                  key={g.id}
                  className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 ${checked ? 'bg-blue-50/40' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(g.id)}
                    className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-800 truncate">{g.name}</div>
                    <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                      <Users className="w-2.5 h-2.5" />
                      {g.agentCount} agent{g.agentCount === 1 ? '' : 's'}
                      <span className="text-slate-300">·</span>
                      <span className="font-mono">#{g.id}</span>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ConfigTab({ workspaceTimezone = 'America/Los_Angeles' }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState(null);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailStatus, setEmailStatus] = useState(null);
  const [polling, setPolling] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getConfig();
      const cfg = res?.data || {};
      setConfig({
        isEnabled: false, autoAssign: false, autoCloseNoise: false, dryRunMode: true,
        llmModel: 'claude-sonnet-4-6-20260217', maxRecommendations: 3, scoringWeights: null,
        pollForUnassigned: true, pollMaxPerCycle: 5,
        monitoredMailbox: null, emailPollingEnabled: false, emailPollingIntervalSec: 60,
        excludedGroupIds: [],
        dailyReviewEnabled: false, dailyReviewRunHour: 18, dailyReviewRunMinute: 5, dailyReviewLookbackDays: 14,
        ...cfg,
      });
      setAnthropicConfigured(res?.anthropicConfigured ?? false);
      try { const statusRes = await assignmentAPI.emailStatus(); setEmailStatus(statusRes?.data || null); } catch { /* ignore */ }
    } catch {
      setConfig({ isEnabled: false, autoAssign: false, autoCloseNoise: false, dryRunMode: true, llmModel: 'claude-sonnet-4-6-20260217', maxRecommendations: 3, scoringWeights: null, pollForUnassigned: true, pollMaxPerCycle: 5, monitoredMailbox: null, emailPollingEnabled: false, emailPollingIntervalSec: 60, excludedGroupIds: [], dailyReviewEnabled: false, dailyReviewRunHour: 18, dailyReviewRunMinute: 5, dailyReviewLookbackDays: 14 });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    try { setSaving(true); setSaveSuccess(false); const res = await assignmentAPI.updateConfig(config); setConfig(res?.data || config); setSaveSuccess(true); setTimeout(() => setSaveSuccess(false), 3000); }
    catch { /* keep current config visible on save failure */ }
    finally { setSaving(false); }
  };

  if (loading || !config) return <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-4 max-w-2xl">
      {!anthropicConfigured && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-yellow-800"><strong>ANTHROPIC_API_KEY</strong> is not configured. The assignment pipeline requires a valid API key.</div>
        </div>
      )}

      {/* Section 1: Pipeline */}
      <ConfigSection icon={Brain} title="Pipeline">
        <ConfigToggle label="Enable Assignment Pipeline" description="When enabled, incoming tickets will be analyzed for technician assignment" checked={config.isEnabled} onChange={() => setConfig({ ...config, isEnabled: !config.isEnabled })} />
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">LLM Model</h4>
          <input type="text" value={config.llmModel || ''} onChange={(e) => setConfig({ ...config, llmModel: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white" />
        </div>
      </ConfigSection>

      {/* Section 2: Assignment Behavior */}
      <ConfigSection icon={Settings2} title="Assignment Behavior">
        <ConfigToggle label="Auto-Assign Tickets" description="Skip admin review and auto-assign the top recommendation to the technician" checked={config.autoAssign} onChange={() => setConfig({ ...config, autoAssign: !config.autoAssign })} />
        <ConfigToggle label="Auto-Close Noise Tickets" description="Automatically close/resolve noise and spam tickets in FreshService without admin review" checked={config.autoCloseNoise} onChange={() => setConfig({ ...config, autoCloseNoise: !config.autoCloseNoise })} />
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">Max Recommendations</h4>
          <p className="text-xs text-slate-500 mb-2">Number of technician recommendations the LLM should provide</p>
          <input type="number" min="1" max="10" value={config.maxRecommendations || 3} onChange={(e) => setConfig({ ...config, maxRecommendations: parseInt(e.target.value) || 3 })} className="w-24 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </div>
      </ConfigSection>

      {/* Section 2b: Excluded Groups — overrides auto-assign for specific FS groups. */}
      <ConfigSection icon={ShieldCheck} title="Excluded Groups (Manual Approval)">
        <ExcludedGroupsPicker
          autoAssign={config.autoAssign}
          excludedGroupIds={config.excludedGroupIds || []}
          onChange={(ids) => setConfig({ ...config, excludedGroupIds: ids })}
        />
      </ConfigSection>

      {/* Section 3: FreshService Sync */}
      <ConfigSection icon={RefreshCw} title="FreshService Sync">
        <ConfigToggle label="Dry-Run Mode" description="Preview all FreshService changes without executing them. Turn off when ready to go live." checked={config.dryRunMode} onChange={() => setConfig({ ...config, dryRunMode: !config.dryRunMode })} color="text-orange-500" />
        <div className="py-3">
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${config.dryRunMode ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-800'}`}>
            <span className={`w-2 h-2 rounded-full ${config.dryRunMode ? 'bg-orange-500' : 'bg-green-500'}`} />
            {config.dryRunMode ? 'Dry-run active — FreshService will NOT be modified' : 'Live mode — changes will be written to FreshService'}
          </div>
        </div>
      </ConfigSection>

      {/* Section 4: Ticket Detection */}
      <ConfigSection icon={Search} title="Ticket Detection">
        <ConfigToggle label="Poll for Unassigned Tickets" description="Safety net: check for unassigned tickets after each sync cycle" checked={config.pollForUnassigned} onChange={() => setConfig({ ...config, pollForUnassigned: !config.pollForUnassigned })} />
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">Max Tickets Per Poll Cycle</h4>
          <input type="number" min="1" max="20" value={config.pollMaxPerCycle || 5} onChange={(e) => setConfig({ ...config, pollMaxPerCycle: parseInt(e.target.value) || 5 })} className="w-24 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </div>
      </ConfigSection>

      {/* Section 5: Email Monitoring */}
      <ConfigSection icon={Mail} title="Email Monitoring (Office 365)" defaultOpen={false}>
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">Monitored Mailbox</h4>
          <p className="text-xs text-slate-500 mb-2">Shared mailbox to monitor for incoming tickets</p>
          <div className="flex gap-2">
            <input type="email" value={config.monitoredMailbox || ''} onChange={(e) => setConfig({ ...config, monitoredMailbox: e.target.value })} placeholder="helpdesk@company.com" className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <button
              onClick={async () => {
                if (!config.monitoredMailbox) return;
                setEmailTesting(true); setEmailTestResult(null);
                try { const res = await assignmentAPI.emailTest(config.monitoredMailbox); setEmailTestResult(res?.data || { success: false, message: 'No response' }); }
                catch (err) { setEmailTestResult({ success: false, message: err.message }); }
                finally { setEmailTesting(false); }
              }}
              disabled={emailTesting || !config.monitoredMailbox}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1"
            >
              {emailTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Test
            </button>
          </div>
          {emailTestResult && (
            <div className={`mt-2 p-2 rounded-lg text-xs ${emailTestResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {emailTestResult.message}
            </div>
          )}
        </div>
        <ConfigToggle label="Enable Email Polling" description="Automatically check the mailbox for new emails and trigger assignment" checked={config.emailPollingEnabled} onChange={() => setConfig({ ...config, emailPollingEnabled: !config.emailPollingEnabled })} />
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">Polling Interval</h4>
          <select value={config.emailPollingIntervalSec || 60} onChange={(e) => setConfig({ ...config, emailPollingIntervalSec: parseInt(e.target.value) })} className="border border-slate-200 rounded-lg px-3 py-2 text-sm">
            <option value={30}>Every 30 seconds</option>
            <option value={60}>Every 60 seconds</option>
            <option value={120}>Every 2 minutes</option>
            <option value={300}>Every 5 minutes</option>
          </select>
        </div>
        {emailStatus && (
          <div className="py-3">
            <div className="flex items-center justify-between bg-slate-50 rounded-lg p-3">
              <div>
                <span className={`inline-flex items-center gap-1 text-xs font-medium ${emailStatus.running ? 'text-green-600' : 'text-slate-400'}`}>
                  <span className={`w-2 h-2 rounded-full ${emailStatus.running ? 'bg-green-500' : 'bg-slate-300'}`} />
                  {emailStatus.running ? 'Polling active' : 'Polling inactive'}
                </span>
                {emailStatus.lastCheck && <p className="text-[10px] text-slate-400 mt-0.5">Last: {formatDateTimeInTimezone(emailStatus.lastCheck, workspaceTimezone)}</p>}
              </div>
              <button onClick={async () => { setPolling(true); try { await assignmentAPI.emailPollNow(); const r = await assignmentAPI.emailStatus(); setEmailStatus(r?.data || null); } catch { /* ignore polling refresh errors */ } finally { setPolling(false); } }} disabled={polling} className="px-2.5 py-1 border border-slate-200 rounded text-xs font-medium hover:bg-white disabled:opacity-50 flex items-center gap-1">
                {polling ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Poll Now
              </button>
            </div>
          </div>
        )}
      </ConfigSection>

      {/* Section 6: Advanced */}
      <ConfigSection icon={CalendarDays} title="Daily Review Automation" defaultOpen={false}>
        <ConfigToggle
          label="Enable Scheduled Daily Review"
          description="Automatically run the daily assignment review after business hours using the configured local time."
          checked={config.dailyReviewEnabled}
          onChange={() => setConfig({ ...config, dailyReviewEnabled: !config.dailyReviewEnabled })}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-3">
          <div>
            <h4 className="font-medium text-sm text-slate-800 mb-1.5">Run Hour</h4>
            <input
              type="number"
              min="0"
              max="23"
              value={config.dailyReviewRunHour ?? 18}
              onChange={(e) => setConfig({ ...config, dailyReviewRunHour: Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)) })}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <h4 className="font-medium text-sm text-slate-800 mb-1.5">Run Minute</h4>
            <input
              type="number"
              min="0"
              max="59"
              value={config.dailyReviewRunMinute ?? 5}
              onChange={(e) => setConfig({ ...config, dailyReviewRunMinute: Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)) })}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <h4 className="font-medium text-sm text-slate-800 mb-1.5">Thread Backfill Window</h4>
            <input
              type="number"
              min="1"
              max="90"
              value={config.dailyReviewLookbackDays ?? 14}
              onChange={(e) => setConfig({ ...config, dailyReviewLookbackDays: Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 14)) })}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="text-xs text-slate-500">
          Runs are evaluated in the workspace timezone ({workspaceTimezone}). The thread backfill window controls how far back the system should be prepared to hydrate missing FreshService thread data for manual reviews.
        </div>
      </ConfigSection>

      {/* Section 6: Advanced */}
      <ConfigSection icon={Settings2} title="Advanced" defaultOpen={false}>
        <div className="py-3">
          <h4 className="font-medium text-sm text-slate-800 mb-1.5">Scoring Weights</h4>
          <p className="text-xs text-slate-500 mb-3">Relative importance of each factor when ranking technicians. Values should sum to 1.0.</p>
          <div className="grid grid-cols-2 gap-3">
            {['competency', 'workload', 'location', 'recency'].map((key) => (
              <div key={key}>
                <label className="text-xs text-slate-500 capitalize font-medium">{key}</label>
                <input type="number" min="0" max="1" step="0.05"
                  value={config.scoringWeights?.[key] ?? (key === 'competency' ? 0.35 : key === 'workload' ? 0.30 : key === 'location' ? 0.20 : 0.15)}
                  onChange={(e) => setConfig({ ...config, scoringWeights: { ...(config.scoringWeights || {}), [key]: parseFloat(e.target.value) || 0 } })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
            ))}
          </div>
        </div>
      </ConfigSection>

      {/* Save */}
      <div className="flex items-center gap-3 pt-2">
        <button onClick={handleSave} disabled={saving} className="px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-sm transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Configuration
        </button>
        {saveSuccess && <span className="text-sm text-green-600 font-medium">Saved successfully</span>}
      </div>
    </div>
  );
}

export default function AssignmentReview() {
  const navigate = useNavigate();
  const params = useParams();
  const { currentWorkspace, availableWorkspaces } = useWorkspace();
  const { user } = useAuth();
  const [workspaceTimezone, setWorkspaceTimezone] = useState('America/Los_Angeles');
  const [timeRange, setTimeRange] = useState('7d');

  const isGlobalAdmin = user?.role === 'admin';
  const wsRole = (() => {
    if (isGlobalAdmin) return 'admin';
    const ws = availableWorkspaces?.find(w => w.id === currentWorkspace?.id);
    return ws?.role || 'viewer';
  })();
  const isWsAdmin = wsRole === 'admin';
  const isReviewer = wsRole === 'reviewer' || isWsAdmin;

  useEffect(() => {
    let cancelled = false;

    if (!currentWorkspace?.id) {
      setWorkspaceTimezone('America/Los_Angeles');
      return undefined;
    }

    workspaceAPI.getById(currentWorkspace.id)
      .then((res) => {
        if (!cancelled) {
          setWorkspaceTimezone(res?.data?.defaultTimezone || 'America/Los_Angeles');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceTimezone('America/Los_Angeles');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentWorkspace?.id]);

  const TABS = ALL_TABS.filter(tab => {
    if (tab.minRole === 'admin') return isWsAdmin;
    if (tab.minRole === 'reviewer') return isReviewer;
    return true;
  });

  // Determine active tab and deep-link context from URL
  let activeTab = 'queue';
  let deepRunId = null;
  let historyRunId = null;
  let liveTicketId = null;
  let competencyRunId = null;
  let analyzeTechId = null;

  if (params.competencyRunId && isWsAdmin) {
    activeTab = 'competencies';
    competencyRunId = params.competencyRunId;
  } else if (params.analyzeTechId && isWsAdmin) {
    activeTab = 'competencies';
    analyzeTechId = parseInt(params.analyzeTechId);
  } else if (params.historyRunId) {
    activeTab = 'history';
    historyRunId = params.historyRunId;
  } else if (params.runId) {
    activeTab = 'queue';
    deepRunId = params.runId;
  } else if (params.ticketId && isWsAdmin) {
    activeTab = 'queue';
    liveTicketId = parseInt(params.ticketId);
  } else if (params.tab && TABS.some((t) => t.id === params.tab)) {
    activeTab = params.tab;
  }

  const setActiveTab = (tabId) => {
    navigate(`/assignments/${tabId}`);
  };

  // Viewer guard -- redirect to dashboard if no review access
  if (!isReviewer) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center max-w-sm">
          <Brain className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Access Restricted</h2>
          <p className="text-sm text-slate-500 mb-4">Ticket Assignment requires Reviewer or Admin access to this workspace.</p>
          <button onClick={() => navigate('/dashboard')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Live pipeline view (dedicated URL)
  if (liveTicketId) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col">
        <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
          <div className="px-4 py-2 flex items-center gap-3">
            <button onClick={() => navigate('/assignments/queue')} className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="w-px h-5 bg-slate-200" />
            <Brain className="w-4 h-4 text-blue-600" />
            <h1 className="text-sm font-bold text-slate-900">Pipeline Analysis</h1>
          </div>
        </header>
        <div className="flex-1 px-2 py-2 pb-2 sm:px-4 sm:py-3 sm:pb-4 overflow-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-3 py-3 sm:px-6 sm:py-5">
            <LivePipelineView
              ticketId={liveTicketId}
              onComplete={() => navigate('/assignments/queue')}
              onBack={() => navigate('/assignments/queue')}
            />
          </div>
        </div>
      </div>
    );
  }

  const isDetailView = !!(deepRunId || historyRunId);
  const handleHeaderBack = () => {
    if (deepRunId) {
      navigate('/assignments/queue');
    } else if (historyRunId) {
      navigate('/assignments/history');
    } else {
      navigate('/dashboard');
    }
  };
  const headerBackLabel = deepRunId ? 'Back to Queue' : historyRunId ? 'Back to History' : 'Back';

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* White top bar */}
      <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3">
          <button onClick={handleHeaderBack} className={`flex items-center gap-1.5 transition-colors text-sm font-medium p-1 -ml-1 touch-manipulation min-h-[44px] ${isDetailView ? 'text-blue-600 hover:text-blue-800' : 'text-slate-500 hover:text-slate-800'}`}>
            <ArrowLeft className="w-4 h-4" /> {headerBackLabel}
          </button>
          <div className="w-px h-5 bg-slate-200" />
          <Brain className="w-4 h-4 text-blue-600" />
          <h1 className="text-sm font-bold text-slate-900">Ticket Assignment</h1>
        </div>
      </header>

      {/* Purple gradient tab bar */}
      <div className="flex-shrink-0 px-2 sm:px-4 pt-3 pb-2">
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg shadow-md px-1.5 sm:px-2 py-1 flex items-center gap-0.5 sm:gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap touch-manipulation ${
                  isActive
                    ? 'bg-white bg-opacity-25 text-white shadow-sm'
                    : 'text-white opacity-70 hover:bg-white hover:bg-opacity-15 hover:opacity-100'
                }`}
              >
                <Icon className="w-5 h-5 sm:w-4 sm:h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}

          {/* Time-range filter — visible on Review Queue tab, integrated into the purple header */}
          {activeTab === 'queue' && (
            <>
              <div className="flex-1" />
              <div className="inline-flex items-center gap-0.5 rounded-md bg-white/15 ring-1 ring-white/20 p-0.5">
                {['24h', '7d', '30d', 'all'].map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    title={range === '24h' ? 'Current Pacific day' : undefined}
                    className={`rounded px-2 py-1 text-[11px] font-semibold transition-all touch-manipulation ${
                      timeRange === range
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-white/80 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {range === 'all' ? 'All' : range === '24h' ? 'Today' : range}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-2 pb-2 sm:px-4 sm:pb-4 overflow-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-full">
          <div className="px-3 py-3 sm:px-6 sm:py-5">
            {activeTab === 'queue' && <QueueTab deepRunId={deepRunId} isAdmin={isWsAdmin} workspaceTimezone={workspaceTimezone} timeRange={timeRange} onTimeRangeChange={setTimeRange} />}
            {activeTab === 'history' && <HistoryTab deepRunId={historyRunId} isAdmin={isWsAdmin} workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'daily-review' && <DailyReviewManager workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'calibration' && <CalibrationManager workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'competencies' && <CompetencyManager deepRunId={competencyRunId} deepAnalyzeTechId={analyzeTechId} workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'prompts' && <PromptManager workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'config' && <ConfigTab workspaceTimezone={workspaceTimezone} />}
          </div>
        </div>
      </div>
    </div>
  );
}
