import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { assignmentAPI } from '../services/api';
import PipelineRunDetail from '../components/assignment/PipelineRunDetail';
import CompetencyManager from '../components/assignment/CompetencyManager';
import PromptManager from '../components/assignment/PromptManager';
import LivePipelineView from '../components/assignment/LivePipelineView';
import {
  ArrowLeft, Inbox, History, Settings2, Award, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, ChevronDown, ToggleLeft, ToggleRight, AlertCircle,
  Play, Search, Mail, Zap, FileText, Trash2, XCircle, RotateCcw, Brain,
  ArrowUpDown, ArrowUp, ArrowDown, Eye, Filter, Save,
} from 'lucide-react';

const TABS = [
  { id: 'queue', label: 'Review Queue', icon: Inbox },
  { id: 'history', label: 'History', icon: History },
  { id: 'competencies', label: 'Competencies', icon: Award },
  { id: 'prompts', label: 'Prompts', icon: FileText },
  { id: 'config', label: 'Configuration', icon: Settings2 },
];

function ManualTriggerPanel() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchTickets = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getRecentTickets({ limit: 30, unassigned: showAll ? 'false' : 'true' });
      setTickets(res?.data || []);
    } catch (err) {
      console.error('Failed to fetch tickets:', err);
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

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
    <div className="border rounded-lg bg-gray-50 p-3 sm:p-4 mt-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Zap className="w-4 h-4" /> Manual Trigger
        </h4>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-500 touch-manipulation">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="rounded w-4 h-4" />
            Assigned
          </label>
          <button onClick={fetchTickets} className="text-xs text-blue-600 hover:underline p-1 touch-manipulation">Refresh</button>
        </div>
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
            const pipelineStatus = ticket.pipelineRuns?.[0]?.status;
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
  );
}

function QueueTab({ deepRunId }) {
  const navigate = useNavigate();
  const [queue, setQueue] = useState({ items: [], total: 0 });
  const [queuedRuns, setQueuedRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPriority, setFilterPriority] = useState('all');

  const fetchQueue = useCallback(async () => {
    try {
      setLoading(true);
      const [queueRes, queuedRes] = await Promise.all([
        assignmentAPI.getQueue(),
        assignmentAPI.getQueuedRuns(),
      ]);
      setQueue({ items: queueRes?.items || [], total: queueRes?.total || 0 });
      setQueuedRuns(queuedRes?.data || []);
    } catch (err) {
      console.error('Failed to fetch queue:', err);
      setQueue({ items: [], total: 0 });
      setQueuedRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  useEffect(() => {
    if (deepRunId) {
      (async () => {
        try {
          const res = await assignmentAPI.getRun(parseInt(deepRunId));
          setSelectedRun(res?.data || null);
        } catch (err) {
          console.error('Failed to load deep-linked run:', err);
        }
      })();
    }
  }, [deepRunId]);

  const handleSelectRun = (runId) => {
    navigate(`/assignments/run/${runId}`);
  };

  const handleDecide = async (decisionData) => {
    if (!selectedRun) return;
    try {
      setDeciding(true);
      await assignmentAPI.decide(selectedRun.id, decisionData);
      setSelectedRun(null);
      await fetchQueue();
    } catch (err) {
      console.error('Failed to submit decision:', err);
    } finally {
      setDeciding(false);
    }
  };

  const handleDismiss = async (e, runId) => {
    e.stopPropagation();
    try {
      await assignmentAPI.dismissRun(runId);
      setActionMsg('Dismissed');
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      console.error('Failed to dismiss run:', err);
    }
  };

  const handleDelete = async (e, runId) => {
    e.stopPropagation();
    try {
      await assignmentAPI.deleteRun(runId);
      setActionMsg('Deleted');
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      console.error('Failed to delete run:', err);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Dismiss all pending reviews? This marks them as noise and removes them from the queue.')) return;
    try {
      await assignmentAPI.bulkDeleteRuns({ decision: 'pending_review' });
      setActionMsg('All cleared');
      await fetchQueue();
      setTimeout(() => setActionMsg(null), 2000);
    } catch (err) {
      console.error('Failed to clear all:', err);
    }
  };

  if (selectedRun) {
    return (
      <div>
        <button
          onClick={() => { setSelectedRun(null); navigate('/assignments/queue'); }}
          className="flex items-center gap-1 text-sm text-blue-600 hover:underline mb-4"
        >
          <ChevronLeft className="w-4 h-4" /> Back to queue
        </button>
        <PipelineRunDetail run={selectedRun} onDecide={handleDecide} deciding={deciding} onSyncComplete={async () => {
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

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-slate-400" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-blue-600" /> : <ArrowDown className="w-3 h-3 text-blue-600" />;
  };

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

  return (
    <div className="space-y-4">
      {actionMsg && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{actionMsg}</div>
      )}

      {/* Queued for business hours */}
      {queuedRuns.length > 0 && (
        <div className="border-2 border-orange-300 rounded-lg overflow-hidden">
          <div className="bg-orange-100 px-3 sm:px-4 py-2.5 flex items-center gap-2 border-b border-orange-200 flex-wrap">
            <AlertCircle className="w-4 h-4 text-orange-600" />
            <span className="text-sm font-bold text-orange-800">Queued for Business Hours</span>
            <span className="bg-orange-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">{queuedRuns.length}</span>
            <span className="text-xs text-orange-600 hidden sm:inline">Auto-processes when business hours resume.</span>
          </div>
          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-orange-100 bg-orange-50">
            {queuedRuns.map((run) => (
              <div key={run.id} className="px-3 py-3 space-y-2">
                <div>
                  <span className="text-xs text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                  <p className="font-semibold text-slate-800 text-sm leading-snug">{run.ticket?.subject || 'No subject'}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{run.queuedReason || 'Outside business hours'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={(e) => handleRunNow(e, run.id)} className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 flex items-center justify-center gap-1.5 shadow-sm touch-manipulation min-h-[44px]">
                    <Play className="w-3.5 h-3.5" /> Run Now
                  </button>
                  <button onClick={(e) => handleDelete(e, run.id)} className="p-2.5 text-red-400 hover:text-red-600 hover:bg-red-100 rounded-lg touch-manipulation min-h-[44px]" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table */}
          <table className="hidden md:table w-full text-sm bg-orange-50">
            <thead>
              <tr className="text-xs text-orange-600 border-b border-orange-100">
                <th className="text-left px-4 py-1.5 font-medium">Ticket</th>
                <th className="text-left px-4 py-1.5 font-medium">Reason</th>
                <th className="text-left px-4 py-1.5 font-medium">Queued At</th>
                <th className="px-4 py-1.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queuedRuns.map((run) => (
                <tr key={run.id} className="border-t border-orange-100 hover:bg-orange-100 transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                    <span className="ml-2 font-semibold text-slate-800">{run.ticket?.subject || 'No subject'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{run.queuedReason || 'Outside business hours'} · via {run.triggerSource}</td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{run.queuedAt ? new Date(run.queuedAt).toLocaleString() : ''}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={(e) => handleRunNow(e, run.id)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 shadow-sm">
                        <Play className="w-3.5 h-3.5" /> Run Now
                      </button>
                      <button onClick={(e) => handleDelete(e, run.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-100 rounded-lg" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending review table */}
      {queue.items.length === 0 && queuedRuns.length === 0 ? (
        <div className="text-center py-12">
          <Inbox className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No pending assignments</p>
          <p className="text-slate-400 text-sm mt-1">Trigger the pipeline manually below, or wait for incoming emails.</p>
          <button onClick={fetchQueue} className="mt-3 text-sm text-blue-600 hover:underline inline-flex items-center gap-1">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      ) : queue.items.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          {/* Toolbar */}
          <div className="bg-slate-50 border-b border-slate-200 px-3 sm:px-4 py-2.5 flex items-center gap-2 sm:gap-3 flex-wrap">
            <span className="text-sm font-medium text-slate-700">{queue.total} pending</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <Filter className="w-3.5 h-3.5" />
              <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="border border-slate-200 rounded px-2 py-1.5 text-xs bg-white touch-manipulation">
                <option value="all">All</option>
                <option value="4">Urgent</option>
                <option value="3">High</option>
                <option value="2">Medium</option>
                <option value="1">Low</option>
              </select>
            </div>
            <button onClick={handleClearAll} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1 p-1 touch-manipulation">
              <Trash2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Clear all</span>
            </button>
            <button onClick={fetchQueue} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 p-1 touch-manipulation">
              <RefreshCw className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-slate-100">
            {filteredItems.map((run) => (
              <div key={run.id} onClick={() => handleSelectRun(run.id)} className="px-3 py-3 active:bg-blue-50 transition-colors touch-manipulation cursor-pointer">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs text-slate-400 font-mono">#{run.ticket?.freshserviceTicketId}</span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${PRIORITY_PILL[run.ticket?.priority] || 'bg-slate-100 text-slate-500'}`}>
                        {PRIORITY_LABELS[run.ticket?.priority] || '—'}
                      </span>
                    </div>
                    <p className="font-medium text-slate-800 text-sm leading-snug line-clamp-2">{run.ticket?.subject || 'No subject'}</p>
                    <p className="text-xs text-slate-400 mt-1">{run.ticket?.requester?.name || '—'} · {new Date(run.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={(e) => handleDismiss(e, run.id)} className="p-2 text-yellow-500 hover:bg-yellow-50 rounded-lg touch-manipulation min-w-[36px] min-h-[36px] flex items-center justify-center" title="Dismiss">
                      <XCircle className="w-4 h-4" />
                    </button>
                    <button onClick={(e) => handleDelete(e, run.id)} className="p-2 text-red-400 hover:bg-red-50 rounded-lg touch-manipulation min-w-[36px] min-h-[36px] flex items-center justify-center" title="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <ChevronRight className="w-4 h-4 text-slate-300" />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <table className="hidden md:table w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('subject')}>
                  <span className="flex items-center gap-1">Ticket <SortIcon field="subject" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('requester')}>
                  <span className="flex items-center gap-1">Requester <SortIcon field="requester" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('priority')}>
                  <span className="flex items-center gap-1">Priority <SortIcon field="priority" /></span>
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 text-xs cursor-pointer select-none" onClick={() => toggleSort('createdAt')}>
                  <span className="flex items-center gap-1">Queued <SortIcon field="createdAt" /></span>
                </th>
                <th className="px-4 py-2.5 font-medium text-slate-500 text-xs text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.map((run) => (
                <tr key={run.id} className="hover:bg-blue-50 cursor-pointer group" onClick={() => handleSelectRun(run.id)}>
                  <td className="px-4 py-3">
                    <span className="text-xs text-slate-400 font-mono mr-1.5">#{run.ticket?.freshserviceTicketId}</span>
                    <span className="font-medium text-slate-800">{run.ticket?.subject || 'No subject'}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">{run.ticket?.requester?.name || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_PILL[run.ticket?.priority] || 'bg-slate-100 text-slate-500'}`}>
                      {PRIORITY_LABELS[run.ticket?.priority] || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{new Date(run.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); handleSelectRun(run.id); }} className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-100 rounded" title="View details">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={(e) => handleDismiss(e, run.id)} className="p-1.5 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-50 rounded" title="Dismiss as noise">
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={(e) => handleDelete(e, run.id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ManualTriggerPanel />
    </div>
  );
}

function HistoryTab({ deepRunId }) {
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
    } catch (err) {
      console.error('Failed to fetch runs:', err);
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
        } catch (err) {
          console.error('Failed to load deep-linked run:', err);
        }
      })();
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
          className="flex items-center gap-1 text-sm text-blue-600 hover:underline mb-4"
        >
          <ChevronLeft className="w-4 h-4" /> Back to history
        </button>
        <PipelineRunDetail run={selectedRun} onDecide={() => {}} deciding={false} onSyncComplete={refreshSelectedRun} />
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
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          run.syncStatus === 'synced' ? 'bg-green-100 text-green-700' :
                          run.syncStatus === 'failed' ? 'bg-red-100 text-red-700' :
                          run.syncStatus === 'dry_run' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-slate-100 text-slate-500'
                        }`}>
                          {run.syncStatus === 'synced' ? '✓ synced' : run.syncStatus === 'dry_run' ? '◑ dry run' : run.syncStatus === 'failed' ? '✗ sync failed' : run.syncStatus}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{new Date(run.createdAt).toLocaleString()}</td>
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

function ConfigTab() {
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
    } catch (err) {
      console.error('Failed to fetch config:', err);
      setConfig({ isEnabled: false, autoAssign: false, autoCloseNoise: false, dryRunMode: true, llmModel: 'claude-sonnet-4-6-20260217', maxRecommendations: 3, scoringWeights: null, pollForUnassigned: true, pollMaxPerCycle: 5, monitoredMailbox: null, emailPollingEnabled: false, emailPollingIntervalSec: 60 });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    try { setSaving(true); setSaveSuccess(false); const res = await assignmentAPI.updateConfig(config); setConfig(res?.data || config); setSaveSuccess(true); setTimeout(() => setSaveSuccess(false), 3000); }
    catch (err) { console.error('Failed to save config:', err); }
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
                {emailStatus.lastCheck && <p className="text-[10px] text-slate-400 mt-0.5">Last: {new Date(emailStatus.lastCheck).toLocaleString()}</p>}
              </div>
              <button onClick={async () => { setPolling(true); try { await assignmentAPI.emailPollNow(); const r = await assignmentAPI.emailStatus(); setEmailStatus(r?.data || null); } catch {} finally { setPolling(false); } }} disabled={polling} className="px-2.5 py-1 border border-slate-200 rounded text-xs font-medium hover:bg-white disabled:opacity-50 flex items-center gap-1">
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

  // Determine active tab and deep-link context from URL
  let activeTab = 'queue';
  let deepRunId = null;
  let historyRunId = null;
  let liveTicketId = null;
  let competencyRunId = null;
  let analyzeTechId = null;

  if (params.competencyRunId) {
    activeTab = 'competencies';
    competencyRunId = params.competencyRunId;
  } else if (params.analyzeTechId) {
    activeTab = 'competencies';
    analyzeTechId = parseInt(params.analyzeTechId);
  } else if (params.historyRunId) {
    activeTab = 'history';
    historyRunId = params.historyRunId;
  } else if (params.runId) {
    activeTab = 'queue';
    deepRunId = params.runId;
  } else if (params.ticketId) {
    activeTab = 'queue';
    liveTicketId = parseInt(params.ticketId);
  } else if (params.tab && TABS.some((t) => t.id === params.tab)) {
    activeTab = params.tab;
  }

  const setActiveTab = (tabId) => {
    navigate(`/assignments/${tabId}`);
  };

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

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* White top bar */}
      <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3">
          <button onClick={() => navigate('/dashboard')} className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium p-1 -ml-1 touch-manipulation min-h-[44px]">
            <ArrowLeft className="w-4 h-4" /> Back
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
            {activeTab === 'queue' && <QueueTab deepRunId={deepRunId} />}
            {activeTab === 'history' && <HistoryTab deepRunId={historyRunId} />}
            {activeTab === 'competencies' && <CompetencyManager deepRunId={competencyRunId} deepAnalyzeTechId={analyzeTechId} />}
            {activeTab === 'prompts' && <PromptManager />}
            {activeTab === 'config' && <ConfigTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
