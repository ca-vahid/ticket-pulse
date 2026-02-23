import { useMemo } from 'react';
import { Hand, CheckSquare, Star, ExternalLink } from 'lucide-react';

const PRIORITY_DOT_COLORS = {
  1: 'bg-blue-400',
  2: 'bg-green-400',
  3: 'bg-orange-400',
  4: 'bg-red-500',
};

const STATUS_COLORS = {
  'Open': 'bg-red-100 text-red-700',
  'Pending': 'bg-yellow-100 text-yellow-800',
  'Resolved': 'bg-green-100 text-green-700',
  'Closed': 'bg-gray-100 text-gray-600',
};

const FRESHDOMAIN = import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';

const PERIOD_LABELS = {
  daily: "Today's tickets",
  weekly: "This week's tickets",
  monthly: "This month's tickets",
};

function formatTicketTime(date, includeDate) {
  if (!date) return null;
  const d = new Date(date);
  if (includeDate) {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function TicketRow({ ticket, variant = 'active', techName, viewMode = 'daily' }) {
  const priorityDot = PRIORITY_DOT_COLORS[ticket.priority] || 'bg-gray-400';
  const statusClass = STATUS_COLORS[ticket.status] || 'bg-gray-100 text-gray-600';
  const isSelf = ticket.isSelfPicked || ticket.assignedBy === techName;
  const isClosed = ticket.status === 'Closed' || ticket.status === 'Resolved';

  const isMuted = variant === 'active' && isClosed;
  const includeDate = viewMode !== 'daily';

  const timeLabel = variant === 'closed'
    ? formatTicketTime(ticket.closedAt || ticket.resolvedAt, includeDate)
    : formatTicketTime(ticket.firstAssignedAt, includeDate);

  return (
    <div className={`flex items-center gap-1.5 py-1 px-2 hover:bg-gray-50 rounded text-[11px] leading-tight ${isMuted ? 'opacity-50' : ''}`}>
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot}`} title={`Priority ${ticket.priority}`} />

      <a
        href={`https://${FRESHDOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
        target="_blank"
        rel="noopener noreferrer"
        className={`font-semibold flex-shrink-0 flex items-center gap-0.5 ${isMuted ? 'text-gray-400 hover:text-gray-600' : 'text-blue-600 hover:text-blue-800'}`}
        onClick={(e) => e.stopPropagation()}
      >
        #{ticket.freshserviceTicketId}
        <ExternalLink className="w-2.5 h-2.5" />
      </a>

      <span className={`truncate flex-1 min-w-0 ${isMuted ? 'text-gray-400' : 'text-gray-800'}`}>{ticket.subject}</span>

      <span className={`${statusClass} px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0`}>
        {ticket.status}
      </span>
      {ticket.ticketCategory && (
        <span className="bg-blue-50 text-blue-600 px-1 py-0.5 rounded text-[9px] flex-shrink-0 max-w-[100px] truncate">
          {ticket.ticketCategory}
        </span>
      )}
      {isSelf && variant !== 'closed' && (
        <span className="bg-purple-50 text-purple-600 px-1 py-0.5 rounded text-[9px] flex-shrink-0 flex items-center gap-0.5">
          <Star className="w-2 h-2 fill-purple-600" />
          Self
        </span>
      )}

      {ticket.requesterName && (
        <span
          className="text-gray-400 text-[9px] flex-shrink-0 max-w-[200px] truncate"
          title={ticket.requesterEmail ? `${ticket.requesterName} (${ticket.requesterEmail})` : ticket.requesterName}
        >
          {ticket.requesterName}{ticket.requesterEmail ? ` (${ticket.requesterEmail})` : ''}
        </span>
      )}

      {timeLabel && (
        <span className="text-gray-400 text-[9px] flex-shrink-0 tabular-nums">{timeLabel}</span>
      )}
    </div>
  );
}

/**
 * Groups and sorts tickets for the expandable drilldown.
 *
 * Returns { allTickets, closedTickets } where:
 *  - allTickets: every ticket in the period, self-picked sorted first
 *  - closedTickets: only Closed/Resolved, sorted by close time (may overlap with allTickets)
 */
export function useGroupedTickets(tickets) {
  return useMemo(() => {
    if (!tickets || tickets.length === 0) return { allTickets: [], closedTickets: [] };

    // Sort by arrival time, newest first
    const all = [...tickets].sort((a, b) =>
      new Date(b.firstAssignedAt || b.createdAt) - new Date(a.firstAssignedAt || a.createdAt),
    );

    const closed = tickets
      .filter(t => t.status === 'Closed' || t.status === 'Resolved')
      .sort((a, b) =>
        new Date(b.closedAt || b.resolvedAt || b.updatedAt || 0)
        - new Date(a.closedAt || a.resolvedAt || a.updatedAt || 0),
      );

    return { allTickets: all, closedTickets: closed };
  }, [tickets]);
}

/**
 * Resolves which ticket array to use based on the current view mode.
 */
export function getTicketsForView(technician, viewMode) {
  if (viewMode === 'weekly') return technician.weeklyTickets || [];
  if (viewMode === 'monthly') return technician.tickets || [];
  return technician.tickets || [];
}

/**
 * Renders the two-section expandable ticket list (all tickets + closed/resolved).
 *
 * @param {Object} props
 * @param {Array}  props.allTickets      - sorted ticket array (self-picked first)
 * @param {Array}  props.closedTickets   - closed/resolved subset
 * @param {string} props.techName        - technician name (for self-pick badge logic)
 * @param {string} props.viewMode        - 'daily' | 'weekly' | 'monthly'
 */
export default function ExpandableTicketList({ allTickets, closedTickets, techName, viewMode = 'daily' }) {
  const periodLabel = PERIOD_LABELS[viewMode] || PERIOD_LABELS.daily;

  return (
    <div className="expanded-tickets border-t border-gray-200 bg-gray-50/80 px-4 py-2">
      {/* All tickets for the period */}
      {allTickets.length > 0 && (
        <div className="mb-1.5">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Hand className="w-3 h-3 text-blue-600" />
            <span className="text-[10px] font-bold text-blue-700 uppercase">
              {periodLabel} ({allTickets.length})
            </span>
          </div>
          <div className="space-y-0">
            {allTickets.map(ticket => (
              <TicketRow
                key={ticket.id || ticket.freshserviceTicketId}
                ticket={ticket}
                variant="active"
                techName={techName}
                viewMode={viewMode}
              />
            ))}
          </div>
        </div>
      )}

      {/* Closed / Resolved */}
      {closedTickets.length > 0 && (
        <div className={allTickets.length > 0 ? 'pt-1.5' : ''}>
          {allTickets.length > 0 && (
            <div className="border-t border-gray-300 mb-1.5" />
          )}
          <div className="flex items-center gap-1.5 mb-0.5">
            <CheckSquare className="w-3 h-3 text-gray-500" />
            <span className="text-[10px] font-bold text-gray-500 uppercase">
              Closed / Resolved ({closedTickets.length})
            </span>
          </div>
          <div className="space-y-0 opacity-75">
            {closedTickets.map(ticket => (
              <TicketRow
                key={`closed-${ticket.id || ticket.freshserviceTicketId}`}
                ticket={ticket}
                variant="closed"
                techName={techName}
                viewMode={viewMode}
              />
            ))}
          </div>
        </div>
      )}

      {allTickets.length === 0 && closedTickets.length === 0 && (
        <div className="text-[10px] text-gray-400 text-center py-2">
          Ticket details not loaded yet. Try clicking &quot;Sync Week&quot; or refreshing the dashboard.
        </div>
      )}
    </div>
  );
}
