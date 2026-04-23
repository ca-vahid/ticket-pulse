import { ExternalLink, CheckCircle2, Search, X } from 'lucide-react';
import CategoryFilter from '../CategoryFilter';
import { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from './constants';
import { formatResolutionTime, calculatePickupTime, calculateAgeSinceCreation } from './utils';

// ── Search + category bar ─────────────────────────────────────────────────────
// View selection is handled by clicking the metrics ribbon above this row, so
// this bar only carries free-text search + category filter. Cuts the previous
// three-row layout down to two and removes the duplicated count chips that
// used to live both here AND in the ribbon.

function SearchBar({
  searchTerm,
  onSearchChange,
  searchResultsCount,
  isFiltering,
  availableCategories,
  selectedCategories,
  onCategoryChange,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-lg p-1.5">
      {/* Search — grows to fill available space */}
      <div className="relative flex-1 min-w-[180px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search subject or requester (use | for OR)"
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-7 text-[12px] placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200"
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Result count chip — only when actively filtering */}
      {isFiltering && (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
          searchResultsCount === 0 ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700'
        }`}>
          {searchResultsCount === 0 ? 'No matches' : `${searchResultsCount} ${searchResultsCount === 1 ? 'match' : 'matches'}`}
        </span>
      )}

      {/* Category filter — right-aligned, only render when there are categories to filter on */}
      {availableCategories.length > 0 && (
        <CategoryFilter
          categories={availableCategories}
          selected={selectedCategories}
          onChange={onCategoryChange}
          placeholder="Categories"
        />
      )}
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

const ROW_GRID = 'grid-cols-[18px_90px_minmax(0,1fr)_90px_140px_140px_60px]';

function TableHeader({ activeView }) {
  return (
    <div className={`hidden md:grid ${ROW_GRID} items-center gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-semibold uppercase tracking-wide text-slate-400`}>
      <span />
      <span>Ticket</span>
      <span>Subject / Requester</span>
      <span>Status</span>
      <span>Category</span>
      <span>{activeView === 'assigned' ? 'Assigned by' : activeView === 'closed' ? 'Resolution' : 'Time metric'}</span>
      <span className="text-right">Open</span>
    </div>
  );
}

// ── Single ticket row — single-line column grid (matches BouncedTab) ──────────

function TicketRow({ ticket, technicianName, activeView }) {
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

  // Right-most "metric" column varies by view to keep the most decision-relevant
  // signal at a glance: who assigned (assigned tab), how long it took to close
  // (closed tab), or how fast it was picked up (open/all/self).
  let timeMetric = null;
  if (activeView === 'assigned' && assignedByName) {
    timeMetric = (
      <span className="text-slate-500 text-[11px] truncate" title={assignedAtTime ? `${assignedByName} · ${assignedAtTime}` : assignedByName}>
        {assignedByName}{assignedAtTime ? ` · ${assignedAtTime}` : ''}
      </span>
    );
  } else if (isClosed) {
    timeMetric = resolutionTime
      ? <span className="text-slate-500 text-[11px]">{resolutionTime}</span>
      : <span className="text-slate-300 text-[11px]">—</span>;
  } else if (pickupTime) {
    timeMetric = <span className="text-emerald-600 text-[11px] font-medium">Pickup {pickupTime}</span>;
  } else {
    timeMetric = <span className="text-slate-400 text-[11px] italic">Age {ageSinceCreation}</span>;
  }

  const fsUrl = `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`;

  return (
    <div className={`grid ${ROW_GRID} items-center gap-3 px-3 py-2 text-[12px] hover:bg-slate-50/70 transition-colors`}>
      {/* Priority dot */}
      <div className="flex items-center justify-center">
        <PriorityDot priority={ticket.priority} />
      </div>

      {/* Ticket ID + (only when relevant) self-picked tag stacked beneath */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <a
          href={fsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 font-medium text-[11px] truncate"
          onClick={(e) => e.stopPropagation()}
        >
          #{ticket.freshserviceTicketId}
          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
        </a>
        {isSelf && (
          <span className="inline-flex items-center w-fit px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[9px] font-semibold uppercase tracking-wide">
            Self
          </span>
        )}
      </div>

      {/* Subject + requester (stacked, both truncated) */}
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium text-slate-800 truncate" title={ticket.subject}>{ticket.subject}</span>
          {hasCSAT && (
            <span className="flex-shrink-0">
              <CSATDot score={ticket.csatScore} totalScore={ticket.csatTotalScore} feedback={ticket.csatFeedback} />
            </span>
          )}
        </div>
        {ticket.requesterName && (
          <div className="text-[10px] text-slate-400 truncate" title={ticket.requesterEmail || ticket.requesterName}>
            {ticket.requesterName}{ticket.requesterEmail ? ` · ${ticket.requesterEmail}` : ''}
          </div>
        )}
      </div>

      {/* Status pill */}
      <div>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600 border border-slate-200'}`}>
          {ticket.status}
        </span>
      </div>

      {/* Category — subtle pill, truncated */}
      <div className="min-w-0">
        {ticket.ticketCategory ? (
          <span
            className="inline-block max-w-full truncate align-middle text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded"
            title={ticket.ticketCategory}
          >
            {ticket.ticketCategory}
          </span>
        ) : (
          <span className="text-slate-300 text-[11px]">—</span>
        )}
      </div>

      {/* Time metric / assigner */}
      <div className="min-w-0">{timeMetric}</div>

      {/* Action — lightweight link */}
      <span className="text-right">
        <a
          href={fsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-800 text-[11px] font-medium"
          onClick={(e) => e.stopPropagation()}
        >
          Open <ExternalLink className="w-3 h-3" />
        </a>
      </span>
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
  displayedTickets,
  technicianName,
  // Search + category state still lives in the parent because it's also used
  // upstream to derive displayedTickets — keeping a single source means the
  // metrics ribbon's view counts stay in lockstep with the visible rows.
  searchTerm,
  onSearchChange,
  searchResultsCount,
  isFiltering,
  availableCategories,
  selectedCategories,
  onCategoryChange,
}) {
  return (
    <div className="space-y-3">
      <SearchBar
        searchTerm={searchTerm}
        onSearchChange={onSearchChange}
        searchResultsCount={searchResultsCount}
        isFiltering={isFiltering}
        availableCategories={availableCategories}
        selectedCategories={selectedCategories}
        onCategoryChange={onCategoryChange}
      />

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {displayedTickets.length === 0 ? (
          <EmptyState view={activeView} />
        ) : (
          <>
            <TableHeader activeView={activeView} />
            <div className="divide-y divide-slate-100">
              {displayedTickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  technicianName={technicianName}
                  activeView={activeView}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
