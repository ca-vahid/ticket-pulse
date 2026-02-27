import { Moon, Sunrise, ExternalLink } from 'lucide-react';
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
export default function TimelineTicketRow({ ticket, defaultFirstName, onExcludeCategory, idx, showFullDate }) {
  const picked = ticket._picked;
  const overnight = isOvernight(ticket);
  const wait = fmtWaitTime(ticket);
  const isExtended = ticket._section === 'after9am';

  // In multi-tech mode tickets carry _techFirstName; single-tech falls back to defaultFirstName
  const pickerName = ticket._techFirstName || defaultFirstName || 'Tech';
  // Accent colours from multi-tech merge (optional)
  const accent = ticket._accent;

  const pickedStripClass = accent ? accent.bg : 'bg-emerald-500';
  const pickedBadgeClass = accent ? accent.badge : 'bg-emerald-100 text-emerald-800 border border-emerald-300';

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

        <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
          {/* Overnight / morning icon */}
          {overnight
            ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
            : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" />}

          {/* Date-time (PT) */}
          <span className={`text-slate-400 text-[10px] flex-shrink-0 whitespace-nowrap ${showFullDate ? 'w-[105px]' : 'w-[68px]'}`}>
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

          {/* Subject */}
          <span className={`font-medium text-xs truncate min-w-0 flex-1 ${picked ? 'text-slate-900' : 'text-slate-500'}`}>
            {ticket.subject}
          </span>

          {/* Picked badge */}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${picked ? pickedBadgeClass : 'bg-slate-200 text-slate-600'}`}>
            {picked ? `✓ ${pickerName}` : '✗ Not picked'}
          </span>

          {/* Status */}
          <span className={`${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
            {ticket.status}
          </span>

          {/* Category (click to exclude) */}
          {ticket.ticketCategory && (
            <button
              onClick={() => onExcludeCategory?.(ticket.ticketCategory)}
              className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 truncate max-w-[100px] bg-slate-100 text-slate-600 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer"
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
    </div>
  );
}
