import { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { RotateCcw, ExternalLink, Clock, AlertTriangle, Loader2, User } from 'lucide-react';
import { dashboardAPI } from '../../services/api';
import { FRESHSERVICE_DOMAIN } from './constants';

const PRESET_PILLS = [
  { id: '7d',  label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'Lifetime' },
];

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const PRIORITY_PILL = {
  1: 'bg-slate-100 text-slate-600',
  2: 'bg-yellow-100 text-yellow-800',
  3: 'bg-orange-100 text-orange-800',
  4: 'bg-red-100 text-red-800',
};

function formatWhen(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function formatShortDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMonthLabel(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Build a contextual pill from URL params — a deep-link from the dashboard
 * Rej badge supplies range + start + end.
 */
function getContextualPill(search) {
  const params = new URLSearchParams(search);
  const range = params.get('range');
  const start = params.get('start');
  const end = params.get('end');
  if (!range || !start || !end) return null;

  if (range === 'day') {
    return { id: 'custom-day', label: formatShortDate(start), start, end };
  }
  if (range === 'week') {
    return { id: 'custom-week', label: `${formatShortDate(start)} – ${formatShortDate(end)}`, start, end };
  }
  if (range === 'month') {
    return { id: 'custom-month', label: formatMonthLabel(start), start, end };
  }
  return null;
}

export default function BouncedTab({ technician }) {
  const location = useLocation();
  const contextualPill = useMemo(() => getContextualPill(location.search), [location.search]);

  // Default-select the contextual pill when the page was deep-linked
  const [selectedId, setSelectedId] = useState(contextualPill?.id || '7d');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (contextualPill && selectedId === '7d') {
      setSelectedId(contextualPill.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextualPill?.id]);

  useEffect(() => {
    if (!technician?.id) return;
    setLoading(true);
    setError(null);

    const opts = {};
    if (contextualPill && selectedId === contextualPill.id) {
      opts.start = contextualPill.start;
      opts.end = contextualPill.end;
    } else {
      opts.window = selectedId;
    }

    dashboardAPI.getTechnicianBounced(technician.id, opts)
      .then((res) => setRows(res?.data?.rejections || []))
      .catch((err) => setError(err.message || 'Failed to load bounced tickets'))
      .finally(() => setLoading(false));
  }, [technician?.id, selectedId, contextualPill]);

  // Counts for the always-shown pills (7d/30d/all) come from the tech object
  const staticCounts = {
    '7d': technician?.rejected7d || 0,
    '30d': technician?.rejected30d || 0,
    'all': technician?.rejectedLifetime || 0,
  };

  // The contextual pill's count = rows.length when it's the selected pill (we
  // just fetched exactly those rows). Otherwise show a neutral dash.
  const contextualCount = selectedId === contextualPill?.id ? rows.length : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-red-500" />
            Bounced tickets
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Tickets {technician?.name || 'this technician'} picked up and then put back in the queue.
          </p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1 flex-wrap">
          {contextualPill && (
            <button
              type="button"
              onClick={() => setSelectedId(contextualPill.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                selectedId === contextualPill.id
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-indigo-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="Range carried over from the dashboard view"
            >
              {contextualPill.label}
              {contextualCount != null && (
                <span className="ml-1.5 text-[10px] text-slate-400">({contextualCount})</span>
              )}
            </button>
          )}
          {PRESET_PILLS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                selectedId === p.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {p.label}
              <span className="ml-1.5 text-[10px] text-slate-400">({staticCounts[p.id]})</span>
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Loading bounced tickets...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg py-12 text-center">
          <RotateCcw className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No bounced tickets in this window.</p>
          <p className="text-xs text-slate-400 mt-0.5">
            This tech hasn&apos;t picked up and rejected any tickets in the selected timeframe.
          </p>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row) => {
            const ticket = row.ticket;
            const fsUrl = ticket?.freshserviceTicketId
              ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
              : null;
            const held = durationBetween(row.startedAt, row.endedAt);
            const currentHolder = ticket?.assignedTech?.name;
            const isSelfPick = row.startMethod === 'self_picked';

            return (
              <div key={row.episodeId} className="bg-white border border-slate-200 rounded-lg p-3 hover:border-slate-300 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs text-slate-400 font-mono">#{ticket?.freshserviceTicketId || '?'}</span>
                      {ticket?.priority && (
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${PRIORITY_PILL[ticket.priority] || 'bg-slate-100'}`}>
                          {PRIORITY_LABELS[ticket.priority] || '—'}
                        </span>
                      )}
                      {ticket?.ticketCategory && (
                        <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{ticket.ticketCategory}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        isSelfPick ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {isSelfPick ? 'Self-picked' : 'Assigned'}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-800 leading-snug break-words">
                      {ticket?.subject || 'Unknown ticket'}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500 flex-wrap">
                      {ticket?.requester?.name && (
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {ticket.requester.name}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Held {held || 'briefly'} · rejected {formatWhen(row.endedAt)}
                      </span>
                      {currentHolder && (
                        <span className="flex items-center gap-1 text-slate-600">
                          → now with <strong>{currentHolder}</strong>
                        </span>
                      )}
                      {!currentHolder && ticket && (
                        <span className="text-amber-700 font-medium">
                          → back in queue
                        </span>
                      )}
                    </div>
                  </div>
                  {fsUrl && (
                    <a
                      href={fsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 text-xs font-medium flex items-center gap-0.5 flex-shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
