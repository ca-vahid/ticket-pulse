import { useState, useEffect, useMemo } from 'react';
import { RotateCcw, ExternalLink, Clock, AlertTriangle, Loader2 } from 'lucide-react';
import { dashboardAPI } from '../../services/api';
import { FRESHSERVICE_DOMAIN } from './constants';

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

function toIsoDate(d) {
  if (!d) return null;
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve the date range from the parent page's view mode + selected date.
 * The Bounced tab now relies SOLELY on this — the in-tab preset pills were
 * removed because their counts couldn't keep the parent's tab badge in sync
 * (the badge reads `technician.rejectedThisPeriod`, which only the page-level
 * date filter updates). Single source of truth = no surprises.
 */
function getRange({ viewMode, selectedDate, selectedWeek, selectedMonth }) {
  if (viewMode === 'daily') {
    const isoDate = toIsoDate(selectedDate) || toIsoDate(new Date());
    return {
      label: formatShortDate(isoDate),
      start: isoDate,
      end: isoDate,
    };
  }
  if (viewMode === 'weekly' && selectedWeek) {
    const wk = typeof selectedWeek === 'string' ? new Date(selectedWeek) : selectedWeek;
    const start = toIsoDate(wk);
    const endDate = new Date(wk);
    endDate.setDate(endDate.getDate() + 6);
    const end = toIsoDate(endDate);
    return {
      label: `${formatShortDate(start)} – ${formatShortDate(end)}`,
      start,
      end,
    };
  }
  if (viewMode === 'monthly' && selectedMonth) {
    const m = typeof selectedMonth === 'string' ? new Date(selectedMonth) : selectedMonth;
    const startDate = new Date(m.getFullYear(), m.getMonth(), 1);
    const endDate = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    return {
      label: formatMonthLabel(toIsoDate(startDate)),
      start: toIsoDate(startDate),
      end: toIsoDate(endDate),
    };
  }
  // Fallback: last 7 days when nothing's been selected (rare, e.g. deep-link
  // landed without view mode set). Keeps the tab functional instead of empty.
  return null;
}

/**
 * Owner cell — small avatar (or initials fallback) + first name. Used in the
 * "Now with" column so the row scans like a modern data table instead of
 * sentence fragments.
 */
function Owner({ name, photoUrl }) {
  if (!name) {
    return <span className="text-amber-700 text-[11px] font-medium">Back in queue</span>;
  }
  const initials = name.split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {photoUrl ? (
        <img src={photoUrl} alt="" className="h-5 w-5 rounded-full object-cover ring-1 ring-slate-200 flex-shrink-0" />
      ) : (
        <span className="h-5 w-5 rounded-full bg-slate-200 text-slate-600 text-[9px] font-bold flex items-center justify-center flex-shrink-0">
          {initials}
        </span>
      )}
      <span className="truncate text-[12px] text-slate-700">{name}</span>
    </span>
  );
}

export default function BouncedTab({ technician, viewMode = 'daily', selectedDate, selectedWeek, selectedMonth }) {
  const range = useMemo(
    () => getRange({ viewMode, selectedDate, selectedWeek, selectedMonth }),
    [viewMode, selectedDate, selectedWeek, selectedMonth],
  );

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!technician?.id) return;
    setLoading(true);
    setError(null);

    // Range may be null briefly while the parent page resolves its initial
    // view-mode state. Fall back to the API's '7d' default so the user still
    // sees something instead of an empty card.
    const opts = range
      ? { start: range.start, end: range.end }
      : { window: '7d' };

    dashboardAPI.getTechnicianBounced(technician.id, opts)
      .then((res) => setRows(res?.data?.rejections || []))
      .catch((err) => setError(err.message || 'Failed to load bounced tickets'))
      .finally(() => setLoading(false));
    // Intentionally depend on the primitive start/end — the `range` object
    // identity changes every render but its values don't, so a `range` dep
    // would re-fetch infinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [technician?.id, range?.start, range?.end]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-red-500" />
            Bounced tickets
            {range?.label && (
              <span className="text-[11px] font-medium text-slate-400 normal-case">
                · {range.label}
              </span>
            )}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Tickets {technician?.name || 'this technician'} picked up and then put back in the queue.
            <span className="text-slate-400"> Use the date filter at the top of the page to change the range.</span>
          </p>
        </div>
        {rows.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 shadow-sm">
            {rows.length} bounced
          </span>
        )}
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
        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
          {/* Column header — pure presentational, mirrors the row grid below.
              Hidden on narrow screens (rows still read fine without it because
              each cell is intrinsically labelled by content/icon). */}
          <div className="hidden md:grid grid-cols-[110px_minmax(0,1fr)_72px_120px_70px_140px_minmax(0,160px)_70px] items-center gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span>Ticket</span>
            <span>Title</span>
            <span>Priority</span>
            <span>Category</span>
            <span>Held</span>
            <span>Rejected</span>
            <span>Now with</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="divide-y divide-slate-100">
            {rows.map((row) => {
              const ticket = row.ticket;
              const fsUrl = ticket?.freshserviceTicketId
                ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
                : null;
              const held = durationBetween(row.startedAt, row.endedAt);
              const currentHolder = ticket?.assignedTech?.name;
              const currentHolderPhoto = ticket?.assignedTech?.photoUrl;
              const isSelfPick = row.startMethod === 'self_picked';
              const priLabel = PRIORITY_LABELS[ticket?.priority];
              const priClass = PRIORITY_PILL[ticket?.priority] || 'bg-slate-100 text-slate-500';

              return (
                <div
                  key={row.episodeId}
                  className="grid grid-cols-[110px_minmax(0,1fr)_72px_120px_70px_140px_minmax(0,160px)_70px] items-center gap-3 px-3 py-2 text-[12px] hover:bg-slate-50/70 transition-colors"
                >
                  {/* Ticket ID + (only when relevant) self-picked tag stacked beneath */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-mono text-[11px] text-slate-500 truncate">
                      #{ticket?.freshserviceTicketId || '?'}
                    </span>
                    {isSelfPick && (
                      <span className="inline-flex items-center w-fit px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[9px] font-semibold uppercase tracking-wide">
                        Self-picked
                      </span>
                    )}
                  </div>

                  {/* Title — dominant, truncated with native tooltip */}
                  <span
                    className="font-medium text-slate-800 truncate"
                    title={ticket?.subject || 'Unknown ticket'}
                  >
                    {ticket?.subject || 'Unknown ticket'}
                  </span>

                  {/* Priority — compact pill */}
                  <span>
                    {priLabel ? (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${priClass}`}>
                        {priLabel}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-[11px]">—</span>
                    )}
                  </span>

                  {/* Category — subtle pill */}
                  <span className="min-w-0">
                    {ticket?.ticketCategory ? (
                      <span
                        className="inline-block max-w-full truncate align-middle text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded"
                        title={ticket.ticketCategory}
                      >
                        {ticket.ticketCategory}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-[11px]">—</span>
                    )}
                  </span>

                  {/* Held — small clock icon + duration */}
                  <span className="inline-flex items-center gap-1 text-slate-500 text-[11px]">
                    <Clock className="w-3 h-3" />
                    {held || '—'}
                  </span>

                  {/* Rejected timestamp — short format */}
                  <span className="text-slate-500 text-[11px] truncate" title={row.endedAt ? new Date(row.endedAt).toLocaleString() : ''}>
                    {formatWhen(row.endedAt)}
                  </span>

                  {/* Owner — avatar + name (or "Back in queue") */}
                  <Owner name={currentHolder} photoUrl={currentHolderPhoto} />

                  {/* Action — lightweight link */}
                  <span className="text-right">
                    {fsUrl && (
                      <a
                        href={fsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-800 text-[11px] font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Open <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
