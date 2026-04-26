import { useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Moon,
  RotateCcw,
  Sunrise,
} from 'lucide-react';
import { PRIORITY_STRIP_COLORS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from './constants';
import { fmtWaitTime } from '../tech-detail/utils';
import { isOvernight } from './timelineUtils';

/**
 * A single ticket row in the timeline.
 *
 * Props:
 *   ticket           — ticket object with _picked, _day, _section, and optional _techFirstName, _accent
 *   defaultFirstName — fallback agent first name (used in single-tech mode)
 *   onExcludeCategory — callback(category) to add category to exclude filter
 *   idx              — list index (used for key uniqueness)
 */
export default function TimelineTicketRow({ ticket, defaultFirstName, onExcludeCategory, idx: _idx, showFullDate }) {
  const [expanded, setExpanded] = useState(false);
  const picked = ticket._picked;
  const overnight = isOvernight(ticket);
  const wait = fmtWaitTime(ticket);
  const isExtended = ticket._section === 'after9am';

  // In multi-tech mode tickets carry _techFirstName; single-tech falls back to defaultFirstName
  const pickerName = ticket._techFirstName || defaultFirstName || 'Tech';
  const pickerPhoto = ticket._techPhotoUrl || null;
  const pickerInitials = pickerName.charAt(0).toUpperCase();
  // Accent colours from multi-tech merge (optional)
  const accent = ticket._accent;

  const pickedStripClass = accent ? accent.bg : 'bg-emerald-500';
  const pickedBadgeClass = accent ? accent.badge : 'bg-emerald-100 text-emerald-800 border border-emerald-300';
  const episodes = Array.isArray(ticket.assignmentEpisodes) ? ticket.assignmentEpisodes : [];
  const hasHandoffHistory = episodes.length > 0
    && (episodes.length > 1 || ticket.wasRejected || (ticket.assignmentEvents || []).length > 0);
  const selectedEpisode = episodes.find((ep) => ticket._techId && ep.techId === ticket._techId)
    || episodes.find((ep) => ep.techName && ep.techName.split(' ')[0] === pickerName)
    || null;
  const acquisitionLabel = selectedEpisode?.startMethod === 'self_picked'
    ? 'Self'
    : selectedEpisode?.startMethod === 'coordinator_assigned'
      ? 'Assigned'
      : selectedEpisode?.startMethod === 'workflow_assigned'
        ? 'Workflow'
        : null;
  const currentHolderName = ticket.currentHolderName || ticket.assignedTechName || null;
  const showCurrentHolder = picked && currentHolderName && (
    ticket._techId && ticket.currentHolderId
      ? ticket._techId !== ticket.currentHolderId
      : currentHolderName.split(' ')[0] !== pickerName
  );

  const formatPTTime = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles',
    });
  };

  return (
    <div
      className={`border rounded overflow-hidden transition-all ${
        picked
          ? isExtended
            ? 'bg-emerald-50/40 border-emerald-200'
            : 'bg-emerald-50 border-emerald-200'
          : isExtended
            ? 'bg-slate-50 border-slate-200 opacity-60'
            : 'bg-slate-100 border-slate-300 opacity-75'
      }`}
    >
      <div className="flex items-stretch">
        {/* Priority strip */}
        <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-slate-300'} w-1 flex-shrink-0`} />
        {/* Picked/not-picked indicator strip */}
        <div className={`w-1 flex-shrink-0 ${picked ? pickedStripClass : 'bg-slate-400'}`} />

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-2 py-2 sm:py-1.5">
          {hasHandoffHistory && (
            <button
              onClick={() => setExpanded((value) => !value)}
              className="p-0.5 rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 flex-shrink-0"
              title={expanded ? 'Hide handoff history' : 'Show handoff history'}
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}

          {/* Overnight / morning icon */}
          {overnight
            ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
            : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" />}

          {/* Date-time (PT) */}
          <span className={`text-slate-400 text-[10px] flex-shrink-0 whitespace-nowrap ${showFullDate ? 'sm:w-[105px]' : 'sm:w-[68px]'}`}>
            {(() => {
              const d = new Date(ticket.createdAt);
              const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
              if (!showFullDate) {
                return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' })} ${time}`;
              }
              const mo = d.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'America/Los_Angeles' });
              const day = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/Los_Angeles' });
              const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
              return `${mo}/${day} ${wd}. ${time}`;
            })()}
          </span>

          {/* FreshService link */}
          <a
            href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 flex-shrink-0"
          >
            <ExternalLink className="w-3 h-3" />
          </a>

          {/* Agent avatar (before subject) */}
          {picked && pickerPhoto ? (
            <img
              src={pickerPhoto}
              alt={pickerName}
              title={pickerName}
              className="w-5 h-5 rounded-full object-cover flex-shrink-0 border border-slate-200"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : picked ? (
            <div title={pickerName} className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[8px] font-bold text-white ${accent?.bg || 'bg-emerald-500'}`}>
              {pickerInitials}
            </div>
          ) : null}

          {/* Subject */}
          <span className={`order-first min-w-0 w-full font-medium text-sm sm:order-none sm:w-auto sm:flex-1 sm:text-xs ${picked ? 'text-slate-900' : 'text-slate-500'}`}>
            {ticket.subject}
          </span>

          {/* Picked badge */}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${picked ? pickedBadgeClass : 'bg-slate-200 text-slate-600'}`}>
            {picked ? `✓ ${pickerName}` : '✗ Not picked'}
          </span>

          {acquisitionLabel && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-indigo-50 text-indigo-700 border border-indigo-100">
              {acquisitionLabel}
            </span>
          )}

          {ticket.wasRejected && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 bg-red-50 text-red-700 border border-red-200"
              title={ticket.lastRejectedAt ? `Last returned ${formatPTTime(ticket.lastRejectedAt)}${ticket.lastRejectedByName ? ` by ${ticket.lastRejectedByName}` : ''}` : 'Ticket was returned to the queue'}
            >
              <RotateCcw className="w-3 h-3" />
              Rejected{ticket.rejectionCount > 1 ? ` ${ticket.rejectionCount}x` : ''}
            </span>
          )}

          {ticket.handoffCount > 1 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-amber-50 text-amber-700 border border-amber-100">
              <GitBranch className="w-3 h-3" />
              {ticket.handoffCount} handoffs
            </span>
          )}

          {/* Status */}
          <span className={`${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
            {ticket.status}
          </span>

          {/* Category (click to exclude) */}
          {ticket.ticketCategory && (
            <button
              onClick={() => onExcludeCategory?.(ticket.ticketCategory)}
              className="max-w-[150px] truncate rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer sm:max-w-[100px] flex-shrink-0"
              title={`Click to hide "${ticket.ticketCategory}"`}
            >
              {ticket.ticketCategory}
            </button>
          )}

          {/* Assignee (if not picked by any selected tech) */}
          {!picked && ticket.assignedTechName && (
            <span className="text-slate-500 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
              → {ticket.assignedTechName}
            </span>
          )}

          {showCurrentHolder && (
            <span className="text-slate-500 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
              Now → {currentHolderName}
            </span>
          )}

          {/* Wait time */}
          {wait && (
            <span
              className="bg-slate-100 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap"
              title="Time to first assignment"
            >
              ⏱ {wait}
            </span>
          )}
        </div>
      </div>
      {expanded && episodes.length > 0 && (
        <div className="border-t border-slate-200 bg-white/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {episodes.map((episode, index) => {
              const isRejected = episode.endMethod === 'rejected';
              const isActive = episode.endMethod === 'still_active' || !episode.endedAt;
              const methodLabel = episode.startMethod === 'self_picked' ? 'self' : 'assigned';
              return (
                <div key={episode.id || `${episode.techId}-${episode.startedAt}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <div
                    className={`flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] ${
                      isActive
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : isRejected
                          ? 'bg-red-50 border-red-200 text-red-700'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                    title={[
                      episode.techName || 'Unknown technician',
                      `Started ${formatPTTime(episode.startedAt)}`,
                      episode.startAssignedByName ? `Assigned by ${episode.startAssignedByName}` : null,
                      episode.endedAt ? `Ended ${episode.endMethod} ${formatPTTime(episode.endedAt)}` : 'Current holder',
                      episode.endActorName ? `Ended by ${episode.endActorName}` : null,
                    ].filter(Boolean).join('\n')}
                  >
                    <span className="max-w-[11rem] truncate font-semibold sm:max-w-none">{episode.techName || 'Unknown'}</span>
                    <span className="rounded bg-white/70 px-1 font-medium">{methodLabel}</span>
                    <span className="text-slate-400">{formatPTTime(episode.startedAt)}</span>
                    {isRejected && <RotateCcw className="w-3 h-3" />}
                    {isActive && <span className="font-semibold text-green-700">current</span>}
                  </div>
                  {index < episodes.length - 1 && (
                    <div className="flex items-center gap-0.5 text-[10px] font-medium text-slate-400">
                      <ArrowRight className="w-3 h-3" />
                      <span>{isRejected ? 'rejected' : 'reassigned'}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
