import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { Circle, Clock3, CheckCircle2, Lock } from 'lucide-react';
import { PersonAvatar, SlaChip, StatusPill, TypePill, PRIORITY_STRIP_COLORS, PRIORITY_LABELS } from './ticketUi';
import { baseStatusOf, statusToneFromDefs } from './statusDefs';
import ErrorBoundary from '../ErrorBoundary';

/**
 * Board view for the tickets queue (QA 07-27 #3): Open / Pending / Closed
 * columns, drag a card between columns to change status.
 *
 * Status buckets (Phase 8b): bucketing keys on the ticket status's BASE
 * status from the workspace registry (`statusDefs`), so custom statuses land
 * in their base's column — Open-base in Open, Pending-base in Pending, and
 * the "Closed" column holds BOTH Resolved- and Closed-base statuses (every
 * aggregate in the app already treats them as one terminal bucket, QA 07-27
 * #2). Legacy FS "Waiting …" labels keep sitting in Pending. Cards whose
 * status name differs from the column's own label carry a small status tag
 * so e.g. a "Needs Rework" card in Pending stays identifiable.
 *
 * Drag OUT of a column with several member statuses: dropping into a column
 * sets that column's BASE canonical status — the simplest honest rule (no
 * mid-drag status picker; refine a card into a custom status via the row /
 * detail pickers instead). Dropping into the card's own bucket is a no-op.
 *
 * Drag rules mirror the queue's origin-aware editing exactly:
 *  - TP-born + native ticketing on  → direct status change (with undo toast).
 *  - FS-born with an FS id          → drop opens the same FreshService
 *                                     write-back confirm the StatusPicker uses.
 *  - anything else                  → card is not draggable (lock hint).
 */
const BOARD_COLUMNS = [
  {
    key: 'open',
    label: 'Open',
    status: 'Open',
    Icon: Circle,
    accent: 'text-blue-600',
    headerBg: 'bg-blue-50/80 border-blue-200',
    ring: 'ring-blue-300',
  },
  {
    key: 'pending',
    label: 'Pending',
    status: 'Pending',
    Icon: Clock3,
    accent: 'text-amber-600',
    headerBg: 'bg-amber-50/80 border-amber-200',
    ring: 'ring-amber-300',
  },
  {
    key: 'closed',
    label: 'Closed',
    status: 'Closed',
    Icon: CheckCircle2,
    accent: 'text-emerald-600',
    headerBg: 'bg-emerald-50/80 border-emerald-200',
    ring: 'ring-emerald-300',
  },
];

/**
 * Column for a status label, via its BASE status in the workspace registry
 * (canonical fallback while defs load). Pending-base absorbs the legacy FS
 * "Waiting …" states exactly as before.
 */
const makeBucketFor = (statusDefs) => (status) => {
  const base = baseStatusOf(statusDefs, status);
  if (base === 'Open') return 'open';
  if (base === 'Pending' || status === 'Waiting on Customer' || status === 'Waiting on Third Party') return 'pending';
  if (base === 'Resolved' || base === 'Closed') return 'closed';
  return null; // Deleted / Spam / unknown labels — not shown on the board
};

/**
 * Drag rules as pure, testable helpers (Phase MB6). `canDragTicket` mirrors
 * the queue's origin-aware editing; `planStatusDrop` resolves a drop onto a
 * column into the status to set — or null when nothing should happen (same
 * bucket, unknown column, unknown ticket).
 */
export const canDragTicket = (ticket, ticketingOn) => {
  if (!ticket || ['Deleted', 'Spam'].includes(ticket.status)) return false;
  if (ticket.origin === 'ticketpulse') return Boolean(ticketingOn);
  return Boolean(ticket.freshserviceTicketId); // FS-born → confirmed write-back
};
export const planStatusDrop = (ticket, overId, statusDefs = null) => {
  const column = BOARD_COLUMNS.find((c) => c.key === overId);
  if (!ticket || !column) return null;
  if (makeBucketFor(statusDefs)(ticket.status) === column.key) return null; // same column (any member status) — no-op
  // Dropping into a column always sets that column's BASE canonical status
  // (column.status) — see the drag-out rule in the header comment.
  return column.status;
};

// Anchor clicks on a card (QA 08-07 #7): plain left-click preventDefaults into
// the card's own open/peek flow; Ctrl/Cmd/Shift/middle-click and the
// right-click context menu keep NATIVE anchor behavior. Always stopPropagation
// so the root card's onClick doesn't double-fire alongside a native open.
const isModifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1;

function BoardCard({ ticket, statusDefs, canDrag, dragging, linkState, onClick, onDoubleClick, slaCalendarAware = false }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(ticket.id),
    disabled: !canDrag,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30 }
    : undefined;
  // Ref + subject are real anchors for right-click/new-tab; `draggable={false}`
  // keeps native HTML5 anchor-dragging from fighting dnd-kit's PointerSensor
  // (its 8px activation distance is what still lets plain clicks through).
  const ticketHref = `/tickets/${ticket.id}`;
  const onAnchorClick = (e) => {
    e.stopPropagation();
    if (isModifiedClick(e)) return; // native new-tab / new-window path
    e.preventDefault();
    if (!isDragging) onClick?.(ticket.id);
  };
  const onAnchorDoubleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onDoubleClick?.(ticket.id);
  };

  // A card whose status name isn't its column's own label carries a small
  // status tag — keeps "Resolved" visible in the Closed column (QA 07-27 #2)
  // and identifies custom statuses ("Needs Rework") inside their base column.
  const bucket = makeBucketFor(statusDefs)(ticket.status);
  const columnLabel = { open: 'Open', pending: 'Pending', closed: 'Closed' }[bucket];
  const showStatusTag = Boolean(columnLabel) && ticket.status !== columnLabel;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={() => { if (!isDragging) onClick?.(ticket.id); }}
      onDoubleClick={() => onDoubleClick?.(ticket.id)}
      className={`group relative rounded-lg border border-slate-200 bg-white p-2.5 shadow-subtle transition-shadow ${
        canDrag ? 'cursor-grab active:cursor-grabbing hover:shadow-soft hover:border-blue-200' : 'cursor-pointer hover:border-slate-300'
      } ${isDragging && !dragging ? 'opacity-40' : ''}`}
    >
      <span className={`absolute inset-y-1.5 left-0 w-1 rounded-r ${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-slate-200'}`} aria-hidden="true" />
      <div className="pl-2">
        <div className="flex items-center gap-1.5">
          <Link
            to={ticketHref}
            state={linkState}
            draggable={false}
            onClick={onAnchorClick}
            onDoubleClick={onAnchorDoubleClick}
            className="font-mono text-[11px] font-bold text-slate-500 hover:text-blue-600"
          >
            {ticket.displayRef}
          </Link>
          {ticket.ticketType && <TypePill type={ticket.ticketType} />}
          {showStatusTag && (
            ticket.status === 'Resolved'
              ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[10px] font-bold text-emerald-700">Resolved</span>
              : <StatusPill status={ticket.status} size="sm" tone={statusToneFromDefs(statusDefs, ticket.status)} className="!text-[10px]" />
          )}
          {!canDrag && (
            <span
              className="ml-auto inline-flex items-center text-slate-300"
              title={ticket.origin === 'ticketpulse'
                ? 'Native ticketing is off for this workspace — status is read-only here'
                : 'FreshService-born ticket without write-back — change status in FreshService'}
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
            </span>
          )}
        </div>
        <Link
          to={ticketHref}
          state={linkState}
          draggable={false}
          onClick={onAnchorClick}
          onDoubleClick={onAnchorDoubleClick}
          className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-slate-900 hover:text-blue-700"
        >
          {ticket.subject || '(no subject)'}
        </Link>
        {/* Requester line (QA 08-07 #6) — quiet, between subject and assignee */}
        {ticket.requester?.name && (
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{ticket.requester.name}</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          {ticket.assignedTech ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} size="h-5 w-5" />
              <span className="truncate text-[11px] font-medium text-slate-600">{ticket.assignedTech.name}</span>
            </span>
          ) : (
            <span className="text-[11px] font-medium text-slate-400">Unassigned</span>
          )}
          <span className="ml-auto flex flex-none items-center gap-1.5">
            {baseStatusOf(statusDefs, ticket.status) === 'Open' && ticket.dueBy && (
              <SlaChip value={ticket.dueBy} calendarAware={slaCalendarAware} className="!px-1.5 !text-[10px]" />
            )}
            <span className="text-[10px] font-semibold uppercase text-slate-400" title={`Priority: ${PRIORITY_LABELS[ticket.priority] || ticket.priority}`}>
              {PRIORITY_LABELS[ticket.priority]?.slice(0, 3) || `P${ticket.priority}`}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function BoardColumn({ column, tickets, activeBucket, paginated, emptyState, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  const highlight = isOver && activeBucket && activeBucket !== column.key;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${column.label} column`}
      className={`flex min-w-[270px] flex-1 flex-col rounded-xl border bg-slate-50/60 transition-shadow ${
        highlight ? `ring-2 ${column.ring} border-transparent` : 'border-slate-200'
      }`}
    >
      <header className={`flex items-center gap-2 rounded-t-xl border-b px-3 py-2 ${column.headerBg}`}>
        <column.Icon className={`h-4 w-4 ${column.accent}`} aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">{column.label}</h3>
        {/* Honest count: the board renders ONE page of the queue, so when more
            pages exist the number says so instead of posing as a workspace
            total (QA 08-04 #16). */}
        <span
          className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-500 shadow-subtle"
          title={paginated ? `${tickets.length} ${column.label} ticket${tickets.length === 1 ? '' : 's'} on this page — more may match on other pages (use the pager below)` : undefined}
        >
          {tickets.length}
          {paginated && <span className="font-medium text-slate-400"> on page</span>}
        </span>
      </header>
      {/* Column body: guarantee a healthy stack of cards before scrolling
          (QA 07-30 — a viewport-only cap collapsed columns to ~2 cards on
          short screens), and still grow to fill tall viewports. Raised for
          the 50-card board page (QA 08-07 #12): on 1080p the columns now run
          to roughly the filter rail's Tags facet instead of stopping at a
          third of the screen. */}
      <div className="settings-scrollbar flex min-h-[42rem] max-h-[max(48rem,calc(100vh-200px))] flex-col gap-2 overflow-y-auto p-2">
        {children}
        {tickets.length === 0 && (
          emptyState || <p className="py-6 text-center text-xs text-slate-400">Nothing here — drag a card over.</p>
        )}
      </div>
    </section>
  );
}

function TicketBoardInner({
  tickets, ticketingOn, onCardClick, onCardDoubleClick, onStatusDrop,
  closedExcluded = false, onShowClosed = null, paginated = false,
  statusDefs = null, // workspace status registry (queue meta) — base-aware buckets
  slaCalendarAware = false, // Phase SLA: business-hours tooltip on due chips
}) {
  const [activeId, setActiveId] = useState(null);
  // Return address for the card anchors (QA 08-07 #7) — the same state the
  // queue's openTicket sends, so Back from a new-tab-less full open works.
  const location = useLocation();
  const linkState = { from: `${location.pathname}${location.search}` };
  const sensors = useSensors(
    // 8px activation distance so plain clicks still peek/open the ticket.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const bucketFor = useMemo(() => makeBucketFor(statusDefs), [statusDefs]);

  const buckets = useMemo(() => {
    const map = { open: [], pending: [], closed: [] };
    for (const t of tickets) {
      const bucket = bucketFor(t.status);
      if (bucket) map[bucket].push(t);
    }
    return map;
  }, [tickets, bucketFor]);

  const byId = useMemo(() => new Map(tickets.map((t) => [String(t.id), t])), [tickets]);
  // Crash guard (QA 08-07 #10): a live-refetch can remove the dragged ticket
  // mid-drag, leaving activeId pointing at nothing. `?? null` keeps the drag
  // overlay's ternary safe, and the effect below cancels the phantom drag so
  // dnd-kit isn't left mid-gesture on an unmounted draggable.
  const activeTicket = activeId ? (byId.get(activeId) ?? null) : null;
  const activeBucket = activeTicket ? bucketFor(activeTicket.status) : null;

  useEffect(() => {
    if (activeId && !byId.has(activeId)) setActiveId(null);
  }, [activeId, byId]);

  const handleDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const ticket = byId.get(String(active.id));
    const nextStatus = planStatusDrop(ticket, over.id, statusDefs);
    if (nextStatus) onStatusDrop?.(ticket, nextStatus);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-2" role="list" aria-label="Ticket board">
        {BOARD_COLUMNS.map((column) => (
          <BoardColumn
            key={column.key}
            column={column}
            tickets={buckets[column.key]}
            activeBucket={activeBucket}
            paginated={paginated}
            // The board honors the queue's status scope (QA 08-04 #15/#16) —
            // when that scope excludes Resolved/Closed, say so instead of
            // presenting an empty Closed column as "no closed tickets".
            emptyState={column.key === 'closed' && closedExcluded ? (
              <div className="py-6 text-center">
                <p className="text-xs text-slate-400">Closed hidden by current filters</p>
                {onShowClosed && (
                  <button
                    onClick={onShowClosed}
                    className="tp-focus-ring mt-2 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-subtle transition-colors hover:border-emerald-300 hover:text-emerald-700"
                  >
                    Show closed
                  </button>
                )}
              </div>
            ) : null}
          >
            {buckets[column.key].map((ticket) => (
              <BoardCard
                key={ticket.id}
                ticket={ticket}
                statusDefs={statusDefs}
                canDrag={canDragTicket(ticket, ticketingOn)}
                linkState={linkState}
                onClick={onCardClick}
                onDoubleClick={onCardDoubleClick}
                slaCalendarAware={slaCalendarAware}
              />
            ))}
          </BoardColumn>
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTicket ? (
          <div className="w-[260px] rotate-2 opacity-95">
            <BoardCard ticket={activeTicket} statusDefs={statusDefs} canDrag dragging linkState={linkState} slaCalendarAware={slaCalendarAware} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// Public export wraps the board in its own error boundary (second boundary
// per the Phase 2 plan): if the dnd tree still finds a way to throw, only the
// board area falls back — the queue chrome, filters, and header stay alive.
export default function TicketBoard(props) {
  return (
    <ErrorBoundary variant="inline" label="ticket board">
      <TicketBoardInner {...props} />
    </ErrorBoundary>
  );
}
