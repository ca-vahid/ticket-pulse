import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { assignmentAPI, workspaceAPI, syncAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import PipelineRunDetail from '../components/assignment/PipelineRunDetail';
import CompetencyManager from '../components/assignment/CompetencyManager';
import CalibrationManager from '../components/assignment/CalibrationManager';
import PromptManager from '../components/assignment/PromptManager';
import { formatDateTimeInTimezone } from '../utils/dateHelpers';
import LivePipelineView from '../components/assignment/LivePipelineView';
import {
  ArrowLeft, Inbox, History, Settings2, Award, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, ChevronDown, ToggleLeft, ToggleRight, AlertCircle,
  Play, Search, Mail, Zap, FileText, Trash2, XCircle, RotateCcw, Brain,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, Save, Check, TrendingUp,
} from 'lucide-react';

const ALL_TABS = [
  { id: 'queue', label: 'Review Queue', icon: Inbox, minRole: 'reviewer' },
  { id: 'history', label: 'History', icon: History, minRole: 'reviewer' },
  { id: 'calibration', label: 'Calibration', icon: TrendingUp, minRole: 'admin' },
  { id: 'competencies', label: 'Competencies', icon: Award, minRole: 'admin' },
  { id: 'prompts', label: 'Prompts', icon: FileText, minRole: 'admin' },
  { id: 'config', label: 'Configuration', icon: Settings2, minRole: 'admin' },
];

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
    <div className="border rounded-lg bg-gray-50 mt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between p-3 sm:p-4 touch-manipulation text-left"
      >
        <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Zap className="w-4 h-4" /> Manual Trigger
        </h4>
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
      </button>

      {expanded && (
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
      )}
    </div>
  );
}

// These three components are defined at module level (outside QueueTab) so their
// identity stays stable across QueueTab re-renders. Defining them inside QueueTab
// would create a new function reference on every render, causing React to unmount +
// remount the component (and lose input focus) each time state changes.

function QuickApproveInner({ run, recs, note, onNoteChange, selectedTechId, onTechSelect, approving, onCancel, onSubmit, techPhotos }) {
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
        </div>
      </div>
      <div className="px-3 pb-2">
        <input
          type="text"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="Note (optional)"
          className="w-full border border-slate-200 rounded-lg px-3 py-2.5 sm:py-1.5 text-sm sm:text-xs focus:ring-2 focus:ring-blue-200 focus:border-blue-300 bg-slate-50"
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
          disabled={approving || !selectedTechId}
          className="px-4 py-2 sm:px-3 sm:py-1.5 bg-green-600 text-white rounded-lg sm:rounded-md text-sm sm:text-[11px] font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center gap-1.5 sm:gap-1 touch-manipulation min-h-[44px] sm:min-h-0"
        >
          {approving ? <Loader2 className="w-4 h-4 sm:w-3 sm:h-3 animate-spin" /> : <Check className="w-4 h-4 sm:w-3 sm:h-3" />}
          Approve
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
      className={`hidden md:block absolute z-50 mt-1 w-64 rounded-lg border border-slate-200 bg-white shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ top: '100%' }}
    >
      <QuickApproveInner run={run} recs={recs} {...innerProps} />
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

function QueueTab({ deepRunId, isAdmin = false, workspaceTimezone = 'America/Los_Angeles' }) {
  const navigate = useNavigate();
  const [queue, setQueue] = useState({ items: [], total: 0 });
  const [assignedRuns, setAssignedRuns] = useState({ items: [], total: 0 });
  const [queuedRuns, setQueuedRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPriority, setFilterPriority] = useState('all');
  const [filterTicketStatus, setFilterTicketStatus] = useState('all');
  const [queueStatus, setQueueStatus] = useState(null);
  const [subView, setSubView] = useState('pending');
  const [timeRange, setTimeRange] = useState('7d');
  const [dismissedRuns, setDismissedRuns] = useState({ items: [], total: 0 });
  const [rejectedRuns, setRejectedRuns] = useState({ items: [], total: 0 });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [techPhotos, setTechPhotos] = useState({});
  const [avatarView, setAvatarView] = useState(false);
  const [removingIds, setRemovingIds] = useState(new Set());
  const [newIds, setNewIds] = useState(new Set());
  const seenIdsRef = useRef(null);

  const animateOut = useCallback((runId) => {
    setRemovingIds(prev => new Set([...prev, runId]));
    setTimeout(() => {
      setQueue(prev => ({
        items: prev.items.filter(r => r.id !== runId),
        total: Math.max(0, prev.total - 1),
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
    if (range === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
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
      const [queueRes, assignedRes, dismissedRes, rejectedRes, queuedRes, statusRes] = await Promise.all([
        assignmentAPI.getQueue(),
        assignmentAPI.getRuns({ decisions: 'approved,modified,auto_assigned', since, sinceField: 'decidedAt', limit: 50 }),
        assignmentAPI.getRuns({ decisions: 'noise_dismissed', since, sinceField: 'decidedAt', limit: 50 }),
        assignmentAPI.getRuns({ decisions: 'rejected', since, sinceField: 'decidedAt', limit: 50 }),
        assignmentAPI.getQueuedRuns(),
        assignmentAPI.getQueueStatus().catch(() => null),
      ]);
      setQueue({ items: queueRes?.items || [], total: queueRes?.total || 0 });
      setAssignedRuns({ items: assignedRes?.items || [], total: assignedRes?.total || 0 });
      setDismissedRuns({ items: dismissedRes?.items || [], total: dismissedRes?.total || 0 });
      setRejectedRuns({ items: rejectedRes?.items || [], total: rejectedRes?.total || 0 });
      setQueuedRuns(queuedRes?.data || []);
      if (statusRes?.data) setQueueStatus(statusRes.data);
      hasLoadedOnce.current = true;
    } catch {
      if (!silent) {
        setQueue({ items: [], total: 0 });
        setAssignedRuns({ items: [], total: 0 });
        setDismissedRuns({ items: [], total: 0 });
        setRejectedRuns({ items: [], total: 0 });
        setQueuedRuns([]);
      }
    } finally {
      if (!silent) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [timeRange]);

  const handleSmartRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncAPI.trigger();
    } catch {
      // Sync failed (e.g. network, auth) — still refresh from DB below
    }
    await fetchQueue();
    setRefreshing(false);
  }, [fetchQueue]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  // Detect new items arriving via silent polls
  useEffect(() => {
    const currentIds = new Set(queue.items.map(r => r.id));
    if (seenIdsRef.current === null) {
      // First load — just record what's here, don't highlight anything
      seenIdsRef.current = currentIds;
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

  // Auto-poll every 30 seconds (matches backend sync interval)
  useEffect(() => {
    const id = setInterval(() => fetchQueue({ silent: true }), 30_000);
    return () => clearInterval(id);
  }, [fetchQueue]);

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

  const handleRunNow = async (e, runId) => {
    e.stopPropagation();
    try {
      await assignmentAPI.runNow(runId);
      setActionMsg('Run started — processing in background. Check History tab for results.');
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 5000);
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
      setTimeout(() => setActionMsg(null), 3000);
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
  const isTicketUnassigned = (run) => !run.ticket?.assignedTechId;
  const getTicketFlag = (run) => {
    if (!run.ticket) return null;
    if (isTicketDeleted(run)) return 'deleted';
    if (!isTicketOpen(run)) return 'closed';
    if (run.ticket.assignedTechId) return 'assigned';
    return 'open';
  };

  const filteredItems = [...queue.items]
    .filter((r) => filterPriority === 'all' || String(r.ticket?.priority) === filterPriority)
    .filter((r) => {
      if (filterTicketStatus === 'all') return true;
      if (filterTicketStatus === 'open') return isTicketOpen(r) && isTicketUnassigned(r);
      if (filterTicketStatus === 'assigned') return isTicketOpen(r) && !isTicketUnassigned(r);
      if (filterTicketStatus === 'closed') return !isTicketOpen(r) && !isTicketDeleted(r);
      if (filterTicketStatus === 'deleted') return isTicketDeleted(r);
      return true;
    })
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

  const pendingStats = {
    total: queue.items.length,
    open: queue.items.filter((r) => isTicketOpen(r) && isTicketUnassigned(r)).length,
    assigned: queue.items.filter((r) => isTicketOpen(r) && !isTicketUnassigned(r)).length,
    closed: queue.items.filter((r) => !isTicketOpen(r) && !isTicketDeleted(r)).length,
    deleted: queue.items.filter((r) => isTicketDeleted(r)).length,
  };

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
    if (subView === 'assigned') return assignedRuns.items;
    if (subView === 'dismissed') return dismissedRuns.items;
    if (subView === 'rejected') return rejectedRuns.items;
    return [...queue.items, ...assignedRuns.items, ...dismissedRuns.items, ...rejectedRuns.items]
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
          <span className="ml-auto" />
          {subView !== 'pending' && run.decision && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${DECISION_PILL[run.decision] || 'bg-slate-100 text-slate-500'}`}>
              {DECISION_LABELS[run.decision] || run.decision}
            </span>
          )}
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

      {/* Queued for business hours */}
      {queuedRuns.length > 0 && (
        <div className="border border-amber-200 rounded-lg overflow-hidden">
          <div className="bg-amber-50 px-3 sm:px-4 py-2.5 border-b border-amber-100">
            <div className="flex items-center gap-2 flex-wrap">
              <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span className="text-sm font-bold text-amber-800">Queued for Business Hours</span>
              <span className="bg-amber-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{queuedRuns.length}</span>
              <div className="flex-1" />
              {queueStatus && !queueStatus.isBusinessHours && queueStatus.nextWindow ? (
                <div className="bg-amber-100 border border-amber-200 rounded-full px-3 py-1 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                  <span className="text-xs font-semibold text-amber-700">Starts {queueStatus.nextWindow.label}</span>
                </div>
              ) : queueStatus?.isBusinessHours ? (
                <div className="bg-green-50 border border-green-200 rounded-full px-3 py-1 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                  <span className="text-xs font-semibold text-green-700">Active — processing on next sync</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="md:hidden divide-y divide-amber-50 bg-white">
            {queuedRuns.map((run) => (
              <div key={run.id} className="px-3 py-3 space-y-2">
                <div>
                  <span className="text-xs text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                  <p className="font-semibold text-slate-800 text-sm leading-snug">{run.ticket?.subject || 'No subject'}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{run.queuedReason || 'Outside business hours'}</p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <button onClick={(e) => handleRunNow(e, run.id)} className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 flex items-center justify-center gap-1.5 shadow-sm touch-manipulation min-h-[44px]">
                      <Play className="w-3.5 h-3.5" /> Run Now
                    </button>
                    {confirmDeleteId === run.id ? (
                      <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-3 py-2 bg-red-500 text-white rounded-lg text-xs font-semibold touch-manipulation min-h-[44px]">Delete?</button>
                    ) : (
                      <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-2.5 text-red-400 hover:text-red-600 hover:bg-red-100 rounded-lg touch-manipulation min-h-[44px]" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <table className="hidden md:table w-full text-sm">
            <thead><tr className="text-xs text-amber-600 border-b border-amber-100 bg-amber-50/50">
              <th className="text-left px-4 py-1.5 font-medium">Ticket</th>
              <th className="text-left px-4 py-1.5 font-medium">Reason</th>
              <th className="text-left px-4 py-1.5 font-medium">Queued At</th>
              {isAdmin && <th className="px-4 py-1.5 text-right font-medium">Actions</th>}
            </tr></thead>
            <tbody>
              {queuedRuns.map((run) => (
                <tr key={run.id} className="border-t border-amber-50 hover:bg-amber-50 transition-colors">
                  <td className="px-4 py-3"><span className="text-xs text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span><span className="ml-2 font-semibold text-slate-800">{run.ticket?.subject || 'No subject'}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-500">{run.queuedReason || 'Outside business hours'} · via {run.triggerSource}</td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{formatDateTimeInTimezone(run.queuedAt, workspaceTimezone)}</td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={(e) => handleRunNow(e, run.id)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 shadow-sm"><Play className="w-3.5 h-3.5" /> Run Now</button>
                        {confirmDeleteId === run.id ? (
                          <button onClick={(e) => handleDeleteConfirm(e, run.id)} className="px-2 py-1 bg-red-500 text-white rounded text-[10px] font-semibold">Delete?</button>
                        ) : (
                          <button onClick={(e) => handleDeleteClick(e, run.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-100 rounded-lg" title="Delete"><Trash2 className="w-4 h-4" /></button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sub-view tabs + filters + toolbar (single compact row; ticket status only on Pending) */}
      <div className="border border-slate-200 rounded-lg">
        <div className="bg-slate-50 border-b border-slate-200 px-3 sm:px-4 py-2 rounded-t-lg">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            {/* Queue (decision) scope */}
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-200/90 p-0.5 ring-1 ring-slate-300/40 shadow-sm">
              {[
                { id: 'pending', label: 'Pending', count: queue.total, dot: 'bg-yellow-400' },
                { id: 'assigned', label: 'Assigned', count: assignedRuns.total, dot: 'bg-green-400' },
                { id: 'dismissed', label: 'Dismissed', count: dismissedRuns.total, dot: 'bg-slate-400' },
                { id: 'rejected', label: 'Rejected', count: rejectedRuns.total, dot: 'bg-red-400' },
                { id: 'all', label: 'All', count: null, dot: null },
              ].filter((tab) => tab.id === 'pending' || tab.id === 'all' || tab.count > 0).map((tab) => (
                <button key={tab.id} onClick={() => { setSubView(tab.id); setFilterTicketStatus('all'); }} className={`rounded-md px-2 py-1 text-[11px] font-medium transition-all touch-manipulation flex items-center gap-1 sm:px-2.5 ${subView === tab.id ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80' : 'text-slate-600 hover:text-slate-800'}`}>
                  {tab.dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.dot}`} />}
                  {tab.label}{tab.count != null ? ` (${tab.count})` : ''}
                </button>
              ))}
            </div>

            {subView === 'pending' && pendingStats.total > 0 && (
              <>
                <div className="hidden h-5 w-px shrink-0 bg-gradient-to-b from-transparent via-slate-300 to-transparent sm:block" aria-hidden />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Ticket</span>
                  <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100/90 p-0.5 ring-1 ring-slate-200/60">
                    {[
                      { id: 'all', label: 'All', count: pendingStats.total, tint: '' },
                      { id: 'open', label: 'Unassigned', count: pendingStats.open, tint: 'text-emerald-700' },
                      { id: 'assigned', label: 'Assigned', count: pendingStats.assigned, tint: 'text-amber-800' },
                      { id: 'closed', label: 'Closed', count: pendingStats.closed, tint: 'text-slate-600' },
                      { id: 'deleted', label: 'Deleted', count: pendingStats.deleted, tint: 'text-red-600' },
                    ].filter((f) => f.id === 'all' || f.count > 0).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setFilterTicketStatus(f.id)}
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-all touch-manipulation ${
                          filterTicketStatus === f.id
                            ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/70'
                            : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
                        }`}
                      >
                        {f.label}
                        {f.id !== 'all' && (
                          <span className={filterTicketStatus === f.id ? 'text-slate-700' : f.tint}> ({f.count})</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {(filterTicketStatus !== 'all' || filterPriority !== 'all') && (
                    <button
                      type="button"
                      onClick={() => { setFilterTicketStatus('all'); setFilterPriority('all'); }}
                      className="text-[10px] font-medium text-blue-600 hover:text-blue-800"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </>
            )}

            <div className="hidden min-w-[0.5rem] flex-1 lg:block" />

            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2 lg:ml-auto">
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-200/90 p-0.5 ring-1 ring-slate-300/30">
                {['24h', '7d', '30d', 'all'].map((range) => (
                  <button key={range} type="button" onClick={() => setTimeRange(range)} className={`rounded-md px-1.5 py-1 text-[11px] font-medium transition-all touch-manipulation ${timeRange === range ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/70' : 'text-slate-600 hover:text-slate-800'}`}>
                    {range === 'all' ? 'All' : range}
                  </button>
                ))}
              </div>

              <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="touch-manipulation rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] shadow-sm">
                <option value="all">Priority</option>
                <option value="4">Urgent</option>
                <option value="3">High</option>
                <option value="2">Medium</option>
                <option value="1">Low</option>
              </select>

              {subView === 'pending' && queue.total > 0 && isAdmin && (
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

        {/* Clear all confirmation */}
        {showClearConfirm && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-3 flex items-center gap-3 flex-wrap">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-800 flex-1 min-w-0">
              Delete all <strong>{queue.total}</strong> pending reviews? This permanently removes these pipeline runs from Ticket Pulse and does not change the FreshService tickets.
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

        {/* Refreshing indicator */}
        {refreshing && (
          <div className="bg-blue-50 border-b border-blue-100 px-3 py-1 flex items-center gap-2 text-[11px] text-blue-600">
            <Loader2 className="w-3 h-3 animate-spin" /> Syncing with FreshService...
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

        {/* List content */}
        {activeItems.length === 0 ? (
          <div className="text-center py-10">
            <Inbox className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-slate-500 text-sm font-medium">
              {subView === 'pending'
                ? 'No pending assignments'
                : subView === 'assigned'
                  ? 'No assignments in this period'
                  : subView === 'dismissed'
                    ? 'No dismissed runs in this period'
                    : subView === 'rejected'
                      ? 'No rejected runs in this period'
                      : 'No runs found'}
            </p>
            <button onClick={handleSmartRefresh} className="mt-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
          </div>
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
                        <span className="font-medium text-slate-800 leading-snug flex items-center gap-1.5">
                          {run.ticket?.subject || 'No subject'}
                          {flag === 'deleted' && <Trash2 className="w-3.5 h-3.5 text-red-400 flex-shrink-0" title="Deleted in FreshService" />}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                        {run.ticket?.ticketCategory && <span className="text-[10px] text-slate-300 ml-1.5">{run.ticket.ticketCategory}</span>}
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
                      {subView !== 'pending' && (
                        <td className={`px-3 py-1.5 ${rowDim}`}>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${DECISION_PILL[run.decision] || 'bg-slate-100 text-slate-500'}`}>
                            {DECISION_LABELS[run.decision] || run.decision}
                          </span>
                        </td>
                      )}
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

      <ManualTriggerPanel isAdmin={isAdmin} />
      <MobileQuickApproveSheet
        activeItems={activeItems}
        quickApproveId={quickApproveId}
        guardRef={quickApproveGuardRef}
        onClose={() => setQuickApproveId(null)}
        sheetRef={quickApproveMobileRef}
        {...qaInnerProps}
      />
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
        ...cfg,
      });
      setAnthropicConfigured(res?.anthropicConfigured ?? false);
      try { const statusRes = await assignmentAPI.emailStatus(); setEmailStatus(statusRes?.data || null); } catch { /* ignore */ }
    } catch {
      setConfig({ isEnabled: false, autoAssign: false, autoCloseNoise: false, dryRunMode: true, llmModel: 'claude-sonnet-4-6-20260217', maxRecommendations: 3, scoringWeights: null, pollForUnassigned: true, pollMaxPerCycle: 5, monitoredMailbox: null, emailPollingEnabled: false, emailPollingIntervalSec: 60 });
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
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-2 pb-2 sm:px-4 sm:pb-4 overflow-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-full">
          <div className="px-3 py-3 sm:px-6 sm:py-5">
            {activeTab === 'queue' && <QueueTab deepRunId={deepRunId} isAdmin={isWsAdmin} workspaceTimezone={workspaceTimezone} />}
            {activeTab === 'history' && <HistoryTab deepRunId={historyRunId} isAdmin={isWsAdmin} workspaceTimezone={workspaceTimezone} />}
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
