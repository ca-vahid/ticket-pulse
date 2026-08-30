import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
import { getTicketCategoryLabel } from '../../utils/ticketFilter';

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
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  // Ticket Pulse's own ticket page is the primary destination (subject link);
  // FS is demoted to the small external icon. `state.from` gives /tickets/:id
  // a return address back to this exact timeline view.
  const internalHref = ticket.id ? `/tickets/${ticket.id}` : null;
  const linkState = { from: `${location.pathname}${location.search}` };
  const picked = ticket._picked;
  const overnight = isOvernight(ticket);
  const wait = fmtWaitTime(ticket);
  const isExtended = ticket._section === 'after9am';
  const categoryLabel = getTicketCategoryLabel(ticket);

  // In multi-tech mode tickets carry _techFirstName; single-tech falls back to defaultFirstName
  const pickerName = ticket._techFirstName || defaultFirstName || 'Tech';
  const pickerPhoto = ticket._techPhotoUrl || null;
  const pickerInitials = pickerName.charAt(0).toUpperCase();
  // Accent colours from multi-tech merge (optional)
  const accent = ticket._accent;

  const pickedStripClass = accent ? accent.bg : 'bg-emerald-500';
  const pickedBadgeClass = accent ? accent.badge : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-500/40';
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
            ? 'bg-emerald-50/40 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30'
            : 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30'
          : isExtended
            ? 'bg-muted/50 border-border opacity-60'
            : 'bg-muted border-input opacity-75'
      }`}
    >
      <div className="flex items-stretch">
        {/* Priority strip */}
        <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-muted-foreground/40'} w-1 flex-shrink-0`} />
        {/* Picked/not-picked indicator strip */}
        <div className={`w-1 flex-shrink-0 ${picked ? pickedStripClass : 'bg-muted-foreground/60'}`} />

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-2 py-2 sm:py-1.5">
          {hasHandoffHistory && (
            <button
              onClick={() => setExpanded((value) => !value)}
              className="p-0.5 rounded text-muted-foreground/75 hover:bg-secondary hover:text-foreground/85 flex-shrink-0"
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
          <span className={`text-muted-foreground/75 text-[10px] flex-shrink-0 whitespace-nowrap ${showFullDate ? 'sm:w-[105px]' : 'sm:w-[68px]'}`}>
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

          {/* FreshService link — secondary when the internal page exists */}
          {ticket.freshserviceTicketId && (
            <a
              href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in FreshService"
              className={`flex-shrink-0 ${internalHref ? 'text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300' : 'text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200'}`}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}

          {/* Agent avatar (before subject) */}
          {picked && pickerPhoto ? (
            <img
              src={pickerPhoto}
              alt={pickerName}
              title={pickerName}
              className="w-5 h-5 rounded-full object-cover flex-shrink-0 border border-border"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : picked ? (
            <div title={pickerName} className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[8px] font-bold text-white ${accent?.bg || 'bg-emerald-500'}`}>
              {pickerInitials}
            </div>
          ) : null}

          {/* Subject — primary link to the in-app ticket page */}
          {internalHref ? (
            <Link
              to={internalHref}
              state={linkState}
              title="Open in Ticket Pulse"
              className={`order-first min-w-0 w-full font-medium text-sm hover:underline hover:text-blue-700 dark:hover:text-blue-200 sm:order-none sm:w-auto sm:flex-1 sm:text-xs ${picked ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {ticket.subject}
            </Link>
          ) : (
            <span className={`order-first min-w-0 w-full font-medium text-sm sm:order-none sm:w-auto sm:flex-1 sm:text-xs ${picked ? 'text-foreground' : 'text-muted-foreground'}`}>
              {ticket.subject}
            </span>
          )}

          {/* Picked badge */}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${picked ? pickedBadgeClass : 'bg-secondary text-muted-foreground'}`}>
            {picked ? `✓ ${pickerName}` : '✗ Not picked'}
          </span>

          {acquisitionLabel && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border border-indigo-100 dark:border-indigo-500/20">
              {acquisitionLabel}
            </span>
          )}

          {ticket.wasRejected && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-500/30"
              title={ticket.lastRejectedAt ? `Last returned ${formatPTTime(ticket.lastRejectedAt)}${ticket.lastRejectedByName ? ` by ${ticket.lastRejectedByName}` : ''}` : 'Ticket was returned to the queue'}
            >
              <RotateCcw className="w-3 h-3" />
              Rejected{ticket.rejectionCount > 1 ? ` ${ticket.rejectionCount}x` : ''}
            </span>
          )}

          {ticket.handoffCount > 1 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border border-amber-100 dark:border-amber-500/20">
              <GitBranch className="w-3 h-3" />
              {ticket.handoffCount} handoffs
            </span>
          )}

          {/* Status */}
          <span className={`${STATUS_COLORS[ticket.status] || 'bg-muted text-muted-foreground'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
            {ticket.status}
          </span>

          {/* Category (click to exclude) */}
          {categoryLabel && (
            <button
              onClick={() => onExcludeCategory?.(categoryLabel)}
              className="max-w-[150px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300 hover:line-through cursor-pointer sm:max-w-[100px] flex-shrink-0"
              title={`Click to hide "${categoryLabel}"`}
            >
              {categoryLabel}
            </button>
          )}

          {/* Assignee (if not picked by any selected tech) */}
          {!picked && ticket.assignedTechName && (
            <span className="text-muted-foreground font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
              → {ticket.assignedTechName}
            </span>
          )}

          {showCurrentHolder && (
            <span className="text-muted-foreground font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
              Now → {currentHolderName}
            </span>
          )}

          {/* Wait time */}
          {wait && (
            <span
              className="bg-muted text-muted-foreground border border-border px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap"
              title="Time to first assignment"
            >
              ⏱ {wait}
            </span>
          )}
        </div>
      </div>
      {expanded && episodes.length > 0 && (
        <div className="border-t border-border bg-card/70 px-3 py-2">
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
                        ? 'bg-green-50 dark:bg-green-500/15 border-green-200 dark:border-green-500/30 text-green-800 dark:text-green-200'
                        : isRejected
                          ? 'bg-red-50 dark:bg-red-500/15 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-200'
                          : 'bg-muted/50 border-border text-foreground/85'
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
                    <span className="rounded bg-card/70 px-1 font-medium">{methodLabel}</span>
                    <span className="text-muted-foreground/75">{formatPTTime(episode.startedAt)}</span>
                    {isRejected && <RotateCcw className="w-3 h-3" />}
                    {isActive && <span className="font-semibold text-green-700 dark:text-green-200">current</span>}
                  </div>
                  {index < episodes.length - 1 && (
                    <div className="flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground/75">
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
