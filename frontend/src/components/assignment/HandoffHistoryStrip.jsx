import { useEffect, useState } from 'react';
import { User, RotateCcw, ArrowRight, Clock, Loader2 } from 'lucide-react';
import { dashboardAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

/**
 * Compact horizontal ownership timeline for a ticket, showing every
 * pickup / rejection / reassignment episode.
 *
 * Renders as a chain of pills:
 *   [Andrew] --reject--> [Adrian] --reassign--> [Mehdi] (current)
 */
export default function HandoffHistoryStrip({ ticketId, freshserviceTicketId, workspaceTimezone = 'America/Los_Angeles' }) {
  const [episodes, setEpisodes] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const idToFetch = ticketId || freshserviceTicketId;
    if (!idToFetch) return;
    setLoading(true);
    dashboardAPI.getTicketHistory(idToFetch)
      .then((res) => setEpisodes(res?.data?.episodes || []))
      .catch(() => setEpisodes([]))
      .finally(() => setLoading(false));
  }, [ticketId, freshserviceTicketId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading handoff history...
      </div>
    );
  }

  if (!episodes || episodes.length === 0) return null;

  // Don't bother showing if there's just one active episode with no interesting history
  if (episodes.length === 1 && episodes[0].endMethod === 'still_active') return null;

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Clock className="w-3.5 h-3.5 text-slate-500" />
        <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
          Handoff history
        </h4>
        <span className="text-[10px] text-slate-400 ml-1">
          ({episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'})
        </span>
      </div>

      <div className="flex items-start gap-1.5 flex-wrap">
        {episodes.map((ep, i) => {
          const isActive = ep.endMethod === 'still_active';
          const wasRejected = ep.endMethod === 'rejected';
          const isNext = i < episodes.length - 1;
          const nextTransition = isNext ? (wasRejected ? 'rejected' : 'reassigned') : null;

          return (
            <div key={ep.id} className="flex items-center gap-1.5">
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs ${
                  isActive
                    ? 'bg-green-50 border-green-200 text-green-800'
                    : wasRejected
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'bg-white border-slate-200 text-slate-700'
                }`}
                title={
                  `${ep.techName}\n` +
                  `Started: ${ep.startMethod.replace('_', '-')} at ${formatDateTimeInTimezone(ep.startedAt, workspaceTimezone)}\n` +
                  (ep.endedAt
                    ? `Ended: ${ep.endMethod} at ${formatDateTimeInTimezone(ep.endedAt, workspaceTimezone)}` +
                      (ep.endActorName ? ` by ${ep.endActorName}` : '')
                    : 'Current holder')
                }
              >
                <User className="w-3 h-3 flex-shrink-0" />
                <span className="font-medium whitespace-nowrap">{ep.techName}</span>
                <span className={`text-[10px] px-1 rounded ${
                  ep.startMethod === 'self_picked'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-orange-100 text-orange-700'
                }`}>
                  {ep.startMethod === 'self_picked' ? 'self' : 'assigned'}
                </span>
                {isActive && <span className="text-[10px] font-semibold text-green-700">current</span>}
                {wasRejected && <RotateCcw className="w-3 h-3 text-red-500" />}
              </div>

              {isNext && (
                <div className="flex items-center gap-0.5 text-[10px] text-slate-400 font-medium">
                  <ArrowRight className="w-3 h-3" />
                  <span className="whitespace-nowrap">
                    {nextTransition === 'rejected' ? 'rejected' : 'reassigned'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
