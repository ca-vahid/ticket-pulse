import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Hand, CheckSquare, Star, ExternalLink } from 'lucide-react';
import { getTicketCategoryLabel } from '../utils/ticketFilter';

const PRIORITY_DOT_COLORS = {
  1: 'bg-blue-400',
  2: 'bg-green-400',
  3: 'bg-orange-400',
  4: 'bg-red-500',
};

const STATUS_COLORS = {
  'Open': 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200',
  'Pending': 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200',
  'Resolved': 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-200',
  'Closed': 'bg-muted text-muted-foreground',
};

const FRESHDOMAIN = import.meta.env.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';

// First-group headers: the ACTIVE (non-terminal) slice of the period. Closed/
// Resolved tickets live exclusively in the second group — no double-listing.
const PERIOD_LABELS = {
  daily: 'Active today · open/pending',
  weekly: 'Active this week · open/pending',
  monthly: 'Active this month · open/pending',
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

function TicketRow({ ticket, variant = 'active', techName, viewMode = 'daily', narrow = false }) {
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this page
  // (dashboard expanded row, tech detail, …) instead of the /tickets queue.
  const linkState = { from: `${location.pathname}${location.search}` };
  const priorityDot = PRIORITY_DOT_COLORS[ticket.priority] || 'bg-muted-foreground/60';
  const statusClass = STATUS_COLORS[ticket.status] || 'bg-muted text-muted-foreground';
  const isSelf = ticket.isSelfPicked || ticket.assignedBy === techName;
  const isClosed = ticket.status === 'Closed' || ticket.status === 'Resolved';
  const categoryLabel = getTicketCategoryLabel(ticket);

  const isMuted = variant === 'active' && isClosed;
  const includeDate = viewMode !== 'daily';

  const timeLabel = variant === 'closed'
    ? formatTicketTime(ticket.closedAt || ticket.resolvedAt, includeDate)
    : formatTicketTime(ticket.firstAssignedAt, includeDate);

  // Ticket Pulse's own ticket page is the primary destination (migration off
  // FreshService); FS stays one click away as the small external icon. Ref
  // label mirrors the server's ticketDisplayRef rule.
  const internalHref = ticket.id ? `/tickets/${ticket.id}` : null;
  const fsUrl = ticket.freshserviceTicketId
    ? `https://${FRESHDOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;
  const refLabel = (ticket.origin === 'ticketpulse' && ticket.nativeNumber !== null && ticket.nativeNumber !== undefined)
    ? `TP-${ticket.nativeNumber}`
    : ticket.freshserviceTicketId
      ? `#${ticket.freshserviceTicketId}`
      : `TP-ID-${ticket.id}`;
  const refClass = `font-semibold flex-shrink-0 ${isMuted ? 'text-muted-foreground/75 hover:text-muted-foreground' : 'text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200'}`;

  // Shared pieces so the wide (single-line) and narrow (stacked) layouts keep
  // identical link targets + `state.from` return-address behavior.
  const refEl = internalHref ? (
    <Link
      to={internalHref}
      state={linkState}
      title="Open in Ticket Pulse"
      className={refClass}
      onClick={(e) => e.stopPropagation()}
    >
      {refLabel}
    </Link>
  ) : (
    <a
      href={fsUrl || '#'}
      target="_blank"
      rel="noopener noreferrer"
      className={refClass}
      onClick={(e) => e.stopPropagation()}
    >
      {refLabel}
    </a>
  );

  const fsIconEl = fsUrl && internalHref ? (
    <a
      href={fsUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in FreshService"
      className={`flex-shrink-0 ${isMuted ? 'text-muted-foreground/50 hover:text-muted-foreground' : 'text-blue-300 hover:text-blue-600 dark:hover:text-blue-300'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="w-2.5 h-2.5" />
    </a>
  ) : null;

  const subjectEl = internalHref ? (
    <Link
      to={internalHref}
      state={linkState}
      title="Open in Ticket Pulse"
      className={`truncate flex-1 min-w-0 hover:underline ${isMuted ? 'text-muted-foreground/75' : 'text-foreground'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {ticket.subject}
    </Link>
  ) : (
    <span className={`truncate flex-1 min-w-0 ${isMuted ? 'text-muted-foreground/75' : 'text-foreground'}`}>{ticket.subject}</span>
  );

  if (narrow) {
    // Stacked two-line layout for tight containers (dashboard tech cards):
    // every segment truncates, so the row can never exceed the card width.
    return (
      <div className={`min-w-0 py-1 px-2 hover:bg-muted/50 rounded text-[11px] leading-tight ${isMuted ? 'opacity-50' : ''}`}>
        {/* Line 1: priority dot + ref + subject */}
        <div className="flex min-w-0 items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot}`} title={`Priority ${ticket.priority}`} />
          {refEl}
          {fsIconEl}
          {subjectEl}
        </div>
        {/* Line 2: status + category + self + requester + time */}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-[10px]">
          <span className={`${statusClass} px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0`}>
            {ticket.status}
          </span>
          {categoryLabel && (
            <span className="bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 px-1 py-0.5 rounded text-[9px] min-w-0 truncate">
              {categoryLabel}
            </span>
          )}
          {isSelf && variant !== 'closed' && (
            <span className="bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300 px-1 py-0.5 rounded text-[9px] flex-shrink-0 flex items-center gap-0.5">
              <Star className="w-2 h-2 fill-purple-600" />
              Self
            </span>
          )}
          {ticket.requesterName && (
            <span
              className="text-muted-foreground/75 text-[9px] min-w-0 flex-1 truncate"
              title={ticket.requesterEmail ? `${ticket.requesterName} (${ticket.requesterEmail})` : ticket.requesterName}
            >
              {ticket.requesterName}
            </span>
          )}
          {timeLabel && (
            <span className="text-muted-foreground/75 text-[9px] flex-shrink-0 tabular-nums ml-auto">{timeLabel}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex min-w-0 items-center gap-1.5 py-1 px-2 hover:bg-muted/50 rounded text-[11px] leading-tight ${isMuted ? 'opacity-50' : ''}`}>
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot}`} title={`Priority ${ticket.priority}`} />

      {refEl}
      {fsIconEl}
      {subjectEl}

      <span className={`${statusClass} px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0`}>
        {ticket.status}
      </span>
      {categoryLabel && (
        <span className="bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 px-1 py-0.5 rounded text-[9px] flex-shrink-0 max-w-[100px] truncate">
          {categoryLabel}
        </span>
      )}
      {isSelf && variant !== 'closed' && (
        <span className="bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300 px-1 py-0.5 rounded text-[9px] flex-shrink-0 flex items-center gap-0.5">
          <Star className="w-2 h-2 fill-purple-600" />
          Self
        </span>
      )}

      {ticket.requesterName && (
        <span
          className="text-muted-foreground/75 text-[9px] flex-shrink-0 max-w-[200px] truncate"
          title={ticket.requesterEmail ? `${ticket.requesterName} (${ticket.requesterEmail})` : ticket.requesterName}
        >
          {ticket.requesterName}{ticket.requesterEmail ? ` (${ticket.requesterEmail})` : ''}
        </span>
      )}

      {timeLabel && (
        <span className="text-muted-foreground/75 text-[9px] flex-shrink-0 tabular-nums">{timeLabel}</span>
      )}
    </div>
  );
}

/**
 * Groups and sorts tickets for the expandable drilldown.
 *
 * Returns DISJOINT groups { activeTickets, closedTickets } (no ticket appears
 * twice; period total = activeTickets.length + closedTickets.length):
 *  - activeTickets: non-terminal tickets (anything not Closed/Resolved),
 *    sorted by arrival time, newest first
 *  - closedTickets: only Closed/Resolved, sorted by close time
 */
export function useGroupedTickets(tickets) {
  return useMemo(() => {
    if (!tickets || tickets.length === 0) return { activeTickets: [], closedTickets: [] };

    const isTerminal = (t) => t.status === 'Closed' || t.status === 'Resolved';

    // Sort by arrival time, newest first
    const active = tickets
      .filter(t => !isTerminal(t))
      .sort((a, b) =>
        new Date(b.firstAssignedAt || b.createdAt) - new Date(a.firstAssignedAt || a.createdAt),
      );

    const closed = tickets
      .filter(isTerminal)
      .sort((a, b) =>
        new Date(b.closedAt || b.resolvedAt || b.updatedAt || 0)
        - new Date(a.closedAt || a.resolvedAt || a.updatedAt || 0),
      );

    return { activeTickets: active, closedTickets: closed };
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
 * Renders the two-section expandable ticket list. The groups are DISJOINT:
 * active (open/pending) tickets first, Closed/Resolved second — a ticket never
 * appears in both, so the period total is the sum of the two counts.
 *
 * @param {Object} props
 * @param {Array}  props.activeTickets   - non-terminal tickets, newest first
 * @param {Array}  props.closedTickets   - closed/resolved subset
 * @param {string} props.techName        - technician name (for self-pick badge logic)
 * @param {string} props.viewMode        - 'daily' | 'weekly' | 'monthly'
 * @param {boolean} props.narrow         - stacked two-line rows for tight containers
 *                                         (dashboard cards); default single-line
 */
export default function ExpandableTicketList({ activeTickets, closedTickets, techName, viewMode = 'daily', narrow = false }) {
  const periodLabel = PERIOD_LABELS[viewMode] || PERIOD_LABELS.daily;

  return (
    <div className="expanded-tickets min-w-0 border-t border-border bg-muted/40 px-4 py-2">
      {/* Active (open/pending) tickets for the period */}
      {activeTickets.length > 0 && (
        <div className="mb-1.5">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Hand className="w-3 h-3 text-blue-600 dark:text-blue-300" />
            <span className="text-[10px] font-bold text-blue-700 dark:text-blue-200 uppercase">
              {periodLabel} ({activeTickets.length})
            </span>
          </div>
          <div className="space-y-0">
            {activeTickets.map(ticket => (
              <TicketRow
                key={ticket.id || ticket.freshserviceTicketId}
                ticket={ticket}
                variant="active"
                techName={techName}
                viewMode={viewMode}
                narrow={narrow}
              />
            ))}
          </div>
        </div>
      )}

      {/* Closed / Resolved */}
      {closedTickets.length > 0 && (
        <div className={activeTickets.length > 0 ? 'pt-1.5' : ''}>
          {activeTickets.length > 0 && (
            <div className="border-t border-input mb-1.5" />
          )}
          <div className="flex items-center gap-1.5 mb-0.5">
            <CheckSquare className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] font-bold text-muted-foreground uppercase">
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
                narrow={narrow}
              />
            ))}
          </div>
        </div>
      )}

      {activeTickets.length === 0 && closedTickets.length === 0 && (
        <div className="text-[10px] text-muted-foreground/75 text-center py-2">
          Ticket details not loaded yet. Try clicking &quot;Sync Week&quot; or refreshing the dashboard.
        </div>
      )}
    </div>
  );
}
