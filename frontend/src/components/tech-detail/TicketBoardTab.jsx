import { ExternalLink, CheckCircle2 } from 'lucide-react';
import { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from './constants';
import { formatResolutionTime, calculatePickupTime, calculateAgeSinceCreation } from './utils';

// ── Sub-navigation pills ──────────────────────────────────────────────────────

const TICKET_VIEWS = [
  { id: 'all',      label: 'All Open' },
  { id: 'self',     label: 'Self-Picked' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'closed',   label: 'Closed' },
];

function SubNav({ active, onChange, counts }) {
  return (
    <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
      {TICKET_VIEWS.map((v) => (
        <button
          key={v.id}
          onClick={() => onChange(v.id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            active === v.id
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {v.label}
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
            active === v.id ? 'bg-slate-100 text-slate-700' : 'bg-slate-200 text-slate-500'
          }`}>
            {counts[v.id] ?? 0}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Priority indicator ────────────────────────────────────────────────────────

function PriorityDot({ priority }) {
  const color = PRIORITY_STRIP_COLORS[priority] || 'bg-slate-300';
  const label = PRIORITY_LABELS[priority] || '—';
  return (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${color}`} title={label} />
  );
}

// ── CSAT inline indicator ─────────────────────────────────────────────────────

function CSATDot({ score, totalScore, feedback }) {
  const color =
    score >= 4 ? 'text-emerald-600' :
    score === 3 ? 'text-amber-600' :
    score === 2 ? 'text-orange-600' :
    'text-red-600';
  const emoji = score >= 4 ? '😊' : score === 3 ? '😐' : score === 2 ? '😕' : '😞';
  return (
    <span className={`text-[11px] font-semibold ${color}`} title={feedback || 'Customer satisfaction'}>
      {emoji} {score}/{totalScore || 4}
    </span>
  );
}

// ── Table header ──────────────────────────────────────────────────────────────

function TableHeader({ activeView }) {
  return (
    <div className="grid grid-cols-[20px_80px_1fr_90px_120px_140px] gap-x-3 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
      <span />
      <span>Ticket #</span>
      <span>Subject / Requester</span>
      <span>Status</span>
      <span>Category</span>
      <span>{activeView === 'assigned' ? 'Assigned by' : activeView === 'closed' ? 'Resolution' : 'Time Metric'}</span>
    </div>
  );
}

// ── Single ticket row ─────────────────────────────────────────────────────────

function TicketRow({ ticket, technicianName, activeView, isAlternate }) {
  if (!ticket) return null;

  const isClosed = ticket.status === 'Closed' || ticket.status === 'Resolved';
  const hasCSAT = ticket.csatScore !== null && ticket.csatScore !== undefined;
  const pickupTime = calculatePickupTime(ticket.createdAt, ticket.firstAssignedAt);
  const ageSinceCreation = calculateAgeSinceCreation(ticket.createdAt);
  const resolutionTime = formatResolutionTime(ticket.resolutionTimeSeconds);
  const isSelf = ticket.isSelfPicked || ticket.assignedBy === technicianName;

  const assignedByName =
    ticket.assignedBy && ticket.assignedBy !== technicianName ? ticket.assignedBy : null;
  const assignedAtTime = ticket.firstAssignedAt
    ? new Date(ticket.firstAssignedAt).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
    : null;

  let timeMetric = null;
  if (activeView === 'assigned' && assignedByName) {
    timeMetric = (
      <span className="text-slate-500 text-[11px]">
        {assignedByName}{assignedAtTime ? ` · ${assignedAtTime}` : ''}
      </span>
    );
  } else if (isClosed) {
    timeMetric = resolutionTime
      ? <span className="text-slate-500 text-[11px]">{resolutionTime}</span>
      : null;
  } else if (pickupTime) {
    timeMetric = <span className="text-emerald-600 text-[11px] font-medium">Pickup {pickupTime}</span>;
  } else {
    timeMetric = <span className="text-slate-400 text-[11px] italic">Age {ageSinceCreation}</span>;
  }

  return (
    <div className={`grid grid-cols-[20px_80px_1fr_90px_120px_140px] gap-x-3 items-center px-3 py-2.5 border-b border-slate-100 text-sm hover:bg-blue-50/30 transition-colors ${isAlternate ? 'bg-slate-50/50' : 'bg-white'}`}>
      {/* Priority dot */}
      <div className="flex items-center justify-center">
        <PriorityDot priority={ticket.priority} />
      </div>

      {/* Ticket ID */}
      <a
        href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-blue-600 hover:text-blue-800 font-medium text-[11px] truncate"
      >
        #{ticket.freshserviceTicketId}
        <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
      </a>

      {/* Subject + Requester */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-slate-800 font-medium text-xs truncate">{ticket.subject}</span>
          {isSelf && (
            <span className="flex-shrink-0 text-[9px] text-slate-400 font-semibold uppercase tracking-wide">
              · self
            </span>
          )}
          {hasCSAT && (
            <span className="flex-shrink-0">
              <CSATDot score={ticket.csatScore} totalScore={ticket.csatTotalScore} feedback={ticket.csatFeedback} />
            </span>
          )}
        </div>
        {ticket.requesterName && (
          <div className="text-[10px] text-slate-400 truncate">
            {ticket.requesterName}{ticket.requesterEmail ? ` · ${ticket.requesterEmail}` : ''}
          </div>
        )}
        {hasCSAT && ticket.csatFeedback && (
          <div className="text-[10px] text-slate-400 italic truncate mt-0.5">
            &ldquo;{ticket.csatFeedback}&rdquo;
          </div>
        )}
      </div>

      {/* Status */}
      <div>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600 border border-slate-200'}`}>
          {ticket.status}
        </span>
      </div>

      {/* Category */}
      <div className="truncate">
        {ticket.ticketCategory ? (
          <span className="text-[11px] text-slate-500 truncate">{ticket.ticketCategory}</span>
        ) : (
          <span className="text-slate-300 text-[11px]">—</span>
        )}
      </div>

      {/* Time metric / assignment */}
      <div>{timeMetric}</div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

const EMPTY_MESSAGES = {
  all:      'No open tickets.',
  self:     'No self-picked tickets for this period.',
  assigned: 'No assigned tickets for this period.',
  closed:   'No closed tickets for this period.',
};

function EmptyState({ view }) {
  return (
    <div className="text-center py-12">
      <CheckCircle2 className="w-8 h-8 text-slate-200 mx-auto mb-2" />
      <p className="text-slate-400 text-sm">{EMPTY_MESSAGES[view] || 'No tickets.'}</p>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function TicketBoardTab({
  activeView,
  onViewChange,
  displayedTickets,
  technicianName,
  openCount,
  pendingCount,
  selfPickedCount,
  assignedCount,
  closedCount,
}) {
  const counts = {
    all:      openCount + pendingCount,
    self:     selfPickedCount,
    assigned: assignedCount,
    closed:   closedCount,
  };

  return (
    <div className="space-y-3">
      <SubNav active={activeView} onChange={onViewChange} counts={counts} />

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {displayedTickets.length === 0 ? (
          <EmptyState view={activeView} />
        ) : (
          <>
            <TableHeader activeView={activeView} />
            <div>
              {displayedTickets.map((ticket, i) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  technicianName={technicianName}
                  activeView={activeView}
                  isAlternate={i % 2 === 1}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
