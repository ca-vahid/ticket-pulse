import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2, Clock3, Loader2, RefreshCw, ShieldCheck, XCircle,
} from 'lucide-react';
import { assignmentAPI } from '../../services/api';

const LEVEL_LABELS = {
  basic: 'Basic',
  intermediate: 'Comfortable',
  advanced: 'Advanced',
  expert: 'Expert / SME',
  '': 'No experience',
};

function levelLabel(level) {
  return LEVEL_LABELS[level || ''] || level || 'No experience';
}

function statusClasses(status) {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'rejected') return 'bg-red-50 text-red-700 border-red-200';
  if (status === 'auto_applied') return 'bg-blue-50 text-blue-700 border-blue-200';
  return 'bg-amber-50 text-amber-700 border-amber-200';
}

export default function CompetencyRequestsTab({ onPendingCountChange }) {
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState(null);
  const [message, setMessage] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.getCompetencyRequests({ status, limit: 200 });
      setItems(res.data || []);
      setPendingCount(res.pendingCount || 0);
      onPendingCountChange?.(res.pendingCount || 0);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to load competency requests' });
    } finally {
      setLoading(false);
    }
  }, [onPendingCountChange, status]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const decide = async (request, decision) => {
    setActingId(request.id);
    setMessage(null);
    try {
      const res = await assignmentAPI.decideCompetencyRequest(request.id, { decision });
      setItems(res.data || []);
      setPendingCount(res.pendingCount || 0);
      onPendingCountChange?.(res.pendingCount || 0);
      setMessage({ type: 'success', text: decision === 'approved' ? 'Request approved and applied.' : 'Request rejected.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Decision failed' });
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            Competency Requests
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Agent-submitted increases and new skills wait here. Decreases and removals are auto-applied and kept in history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">
            {pendingCount} pending
          </span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
          >
            <option value="pending">Pending</option>
            <option value="all">All history</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="auto_applied">Auto-applied</option>
          </select>
          <button
            type="button"
            onClick={fetchData}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {message.text}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200">
        {loading ? (
          <div className="flex items-center justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3">Skill</th>
                  <th className="px-4 py-3">Change</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((request) => (
                  <tr key={request.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{request.technician?.name}</div>
                      <div className="text-xs text-slate-500">{request.technician?.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{request.competencyCategory?.name}</div>
                      {request.competencyCategory?.parent?.name && (
                        <div className="text-xs text-slate-500">{request.competencyCategory.parent.name}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">
                        {levelLabel(request.currentLevel)} to {levelLabel(request.requestedLevel)}
                      </div>
                      <div className="text-xs text-slate-500">{request.requestType}</div>
                    </td>
                    <td className="max-w-xs px-4 py-3 text-slate-600">
                      <div className="line-clamp-3">{request.note || '-'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${statusClasses(request.status)}`}>
                        {request.status === 'pending' ? <Clock3 className="h-3 w-3" /> : request.status === 'rejected' ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                        {request.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {request.status === 'pending' ? (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => decide(request, 'rejected')}
                            disabled={actingId === request.id}
                            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => decide(request, 'approved')}
                            disabled={actingId === request.id}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            Approve
                          </button>
                        </div>
                      ) : (
                        <div className="text-right text-xs text-slate-400">
                          {request.reviewedAt ? new Date(request.reviewedAt).toLocaleString() : '-'}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                      No competency requests in this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
