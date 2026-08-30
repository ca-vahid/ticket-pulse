import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
  if (status === 'approved') return 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30';
  if (status === 'rejected') return 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30';
  if (status === 'auto_applied') return 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30';
  return 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30';
}

export default function CompetencyRequestsTab({ onPendingCountChange }) {
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState(null);
  const [actingGroupId, setActingGroupId] = useState(null);
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

  const displayGroups = useMemo(() => {
    const groups = [];
    const groupMap = new Map();
    for (const item of items) {
      const key = item.requestGroupId ? `group:${item.requestGroupId}` : `item:${item.id}`;
      if (!groupMap.has(key)) {
        const group = {
          key,
          requestGroupId: item.requestGroupId || null,
          items: [],
        };
        groupMap.set(key, group);
        groups.push(group);
      }
      groupMap.get(key).items.push(item);
    }
    return groups.map((group) => ({
      ...group,
      isBatch: Boolean(group.requestGroupId && group.items.length > 1),
      note: group.items.find((item) => item.note)?.note || null,
    }));
  }, [items]);

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

  const decideGroup = async (group, decision) => {
    if (!group.requestGroupId) return;
    setActingGroupId(group.key);
    setMessage(null);
    try {
      const res = await assignmentAPI.decideCompetencyRequestGroup(group.requestGroupId, { decision });
      setItems(res.data || []);
      setPendingCount(res.pendingCount || 0);
      onPendingCountChange?.(res.pendingCount || 0);
      setMessage({
        type: 'success',
        text: decision === 'approved'
          ? `${group.items.length} competency requests approved and applied.`
          : `${group.items.length} competency requests rejected.`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Group decision failed' });
    } finally {
      setActingGroupId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-300" />
            Competency Requests
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Agent-submitted increases and new skills wait here. Decreases and removals are auto-applied and kept in history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-3 py-1 text-sm font-semibold text-amber-800 dark:text-amber-200">
            {pendingCount} pending
          </span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground/85"
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
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground/85 hover:bg-muted/50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm ${message.type === 'error' ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200' : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'}`}>
          {message.text}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border">
        {loading ? (
          <div className="flex items-center justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600 dark:text-blue-300" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-semibold uppercase text-muted-foreground">
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
                {displayGroups.map((group) => (
                  <Fragment key={group.key}>
                    {group.isBatch && (
                      <tr className="border-t border-blue-100 dark:border-blue-500/20 bg-blue-50/70 dark:bg-blue-500/10">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <div className="font-semibold text-blue-950 dark:text-blue-200">
                                Request bundle: {group.items.length} skills from {group.items[0]?.technician?.name}
                              </div>
                              <div className="mt-0.5 text-xs text-blue-700 dark:text-blue-200">
                                {group.note || 'No shared note provided.'}
                              </div>
                            </div>
                            {group.items.every((item) => item.status === 'pending') && (
                              <div className="flex shrink-0 justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => decideGroup(group, 'rejected')}
                                  disabled={actingGroupId === group.key}
                                  className="rounded-lg border border-red-200 dark:border-red-500/30 bg-card px-3 py-1.5 text-xs font-semibold text-red-700 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-500/15 disabled:opacity-50"
                                >
                                  Reject all
                                </button>
                                <button
                                  type="button"
                                  onClick={() => decideGroup(group, 'approved')}
                                  disabled={actingGroupId === group.key}
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  Approve all
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {group.items.map((request) => (
                      <tr key={request.id} className={`border-t border-border/60 hover:bg-muted/50 ${group.isBatch ? 'bg-blue-50/20 dark:bg-blue-500/10' : ''}`}>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-foreground">{request.technician?.name}</div>
                          <div className="text-xs text-muted-foreground">{request.technician?.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-foreground">{request.competencyCategory?.name}</div>
                          {request.competencyCategory?.parent?.name && (
                            <div className="text-xs text-muted-foreground">{request.competencyCategory.parent.name}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">
                            {levelLabel(request.currentLevel)} to {levelLabel(request.requestedLevel)}
                          </div>
                          <div className="text-xs text-muted-foreground">{request.requestType}</div>
                        </td>
                        <td className="max-w-xs px-4 py-3 text-muted-foreground">
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
                                disabled={actingId === request.id || actingGroupId === group.key}
                                className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-500/20 disabled:opacity-50"
                              >
                                Reject
                              </button>
                              <button
                                type="button"
                                onClick={() => decide(request, 'approved')}
                                disabled={actingId === request.id || actingGroupId === group.key}
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                Approve
                              </button>
                            </div>
                          ) : (
                            <div className="text-right text-xs text-muted-foreground/75">
                              {request.reviewedAt ? new Date(request.reviewedAt).toLocaleString() : '-'}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground/75">
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
