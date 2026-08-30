import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getExpandedRowModel,
  flexRender, createColumnHelper,
} from '@tanstack/react-table';
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, Inbox, Waves } from 'lucide-react';
import {
  TicketRefLink, StatusPill, TypePill, PersonAvatar, PriorityDot, StateChip,
  ticketCategoryLabels, formatDayTime, timeAgo, PRIORITY_STRIP_COLORS,
} from '../tickets/ticketUi';

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceTable — ONE ticket table showing the set behind the active stat chip
// ("every number is a door"). Rows follow the Tickets queue's compact row
// grammar: left priority accent strip, bold subject with the TypePill folded
// in + state dot, a mono ref/requester meta line beneath, leaf-first category
// cell, StatusPill status, and a timeago handled column. TanStack Table keeps
// the sorting, like Settings → MembersPanel.
//
// Batch-grouping: when ≥5 rows share a category AND all their activity
// timestamps fall within a 30-minute window, they collapse into one expandable
// batch row ("Phishing ×30") instead of 30 identical lines.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_MIN = 5;
const BATCH_WINDOW_MS = 30 * 60 * 1000;

/** Best-available activity timestamp for a ticket in this evidence set. */
function activityTs(t, chipKey) {
  const raw = chipKey === 'closed'
    ? (t.closedAt || t.resolvedAt || t.updatedAt || t.firstAssignedAt || t.createdAt)
    : (t.firstAssignedAt || t.createdAt);
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function categoryLabel(t) {
  const { category, subcategory } = ticketCategoryLabels(t);
  if (!category) return null;
  return subcategory ? `${category} / ${subcategory}` : category;
}

/**
 * Collapse batch clusters: sort by activity timestamp, then greedily group
 * consecutive same-category tickets whose window stays ≤30 min. Groups of ≥5
 * become one batch row with subRows.
 */
export function groupBatches(tickets, chipKey) {
  const sorted = [...tickets].sort((a, b) => activityTs(a, chipKey) - activityTs(b, chipKey));
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    const cat = categoryLabel(sorted[i]) || 'Uncategorized';
    const startTs = activityTs(sorted[i], chipKey);
    const run = [sorted[i]];
    let j = i + 1;
    while (
      j < sorted.length &&
      (categoryLabel(sorted[j]) || 'Uncategorized') === cat &&
      activityTs(sorted[j], chipKey) - startTs <= BATCH_WINDOW_MS &&
      startTs > 0
    ) {
      run.push(sorted[j]);
      j += 1;
    }
    if (run.length >= BATCH_MIN) {
      out.push({
        isBatch: true,
        id: `batch-${run[0].id}`,
        category: cat,
        count: run.length,
        startTs,
        endTs: activityTs(run[run.length - 1], chipKey),
        subRows: run,
      });
      i = j;
    } else {
      out.push(sorted[i]);
      i += 1;
    }
  }
  return out;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const columnHelper = createColumnHelper();

export default function EvidenceTable({ tickets = [], chipKey = 'handled', title = '' }) {
  const [sorting, setSorting] = useState([]);
  const [expanded, setExpanded] = useState({});
  const location = useLocation();

  const data = useMemo(() => groupBatches(tickets, chipKey), [tickets, chipKey]);
  // Return address for /tickets/:id — the ticket page's Back control comes
  // back HERE (same period/chip) instead of dumping the user on the queue.
  const fromPath = `${location.pathname}${location.search}`;

  const columns = useMemo(() => {
    const backState = { from: fromPath };
    return [
      columnHelper.accessor((r) => (r.isBatch ? r.id : (r.subject || '')), {
        id: 'ticket',
        header: 'Ticket',
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          if (r.isBatch) {
            const uniq = new Set(r.subRows.map((t) => t.requesterName).filter(Boolean));
            const requesters = uniq.size || r.count;
            return (
              <div className="min-w-0">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-sky-800 dark:text-sky-200">
                  <Waves className="h-3.5 w-3.5 flex-shrink-0 text-sky-500" aria-hidden="true" />
                  <span className="truncate">{r.category} ×{r.count}</span>
                </span>
                <span className="mt-0.5 block truncate pl-5 text-[11px] text-muted-foreground/75">
                  {requesters} requester{requesters === 1 ? '' : 's'} · {fmtTime(r.startTs)} – {fmtTime(r.endTs)}
                </span>
              </div>
            );
          }
          return (
            <div className={`min-w-0 ${row.depth > 0 ? 'pl-5' : ''}`}>
              {/* Subject line — queue compact grammar: priority dot, type glyph
                  folded in, bold subject, state dot. Subject is the primary
                  in-app link and carries the return address. */}
              <span className="flex w-full min-w-0 items-center gap-1.5">
                {r.priority != null && <PriorityDot priority={r.priority} />}
                {r.type && <span className="shrink-0"><TypePill type={r.type} /></span>}
                {r.id ? (
                  <Link
                    to={`/tickets/${r.id}`}
                    state={backState}
                    className="tp-focus-ring min-w-0 truncate rounded text-left text-sm font-medium text-foreground hover:text-blue-700 dark:hover:text-blue-200"
                    title={r.subject}
                  >
                    {r.subject || '(no subject)'}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-sm font-medium text-foreground" title={r.subject}>
                    {r.subject || '(no subject)'}
                  </span>
                )}
                <StateChip state={r.stateChip} />
              </span>
              {/* Meta line: mono ref · requester · age */}
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] text-muted-foreground/75">
                <TicketRefLink
                  ticket={r}
                  state={backState}
                  className="text-[11px]"
                  linkClassName="font-mono font-medium text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200"
                />
                <span aria-hidden="true">·</span>
                <PersonAvatar name={r.requesterName} size="h-4 w-4" textSize="text-[8px]" />
                <span className="truncate">{r.requesterName || 'Unknown requester'}</span>
                {r.createdAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap" title={new Date(r.createdAt).toLocaleString()}>
                      {formatDayTime(r.createdAt)} · {timeAgo(r.createdAt)}
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        },
      }),
      columnHelper.accessor((r) => (r.isBatch ? r.category : (categoryLabel(r) || '')), {
        id: 'category',
        header: 'Category',
        cell: ({ row }) => {
          const r = row.original;
          if (r.isBatch) {
            return <span className="block truncate text-xs text-muted-foreground" title={r.category}>{r.category}</span>;
          }
          // Leaf-first (queue convention): the SUBCATEGORY is the most specific
          // (= most useful) piece, so it gets the primary line; parent under it.
          const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(r);
          if (!catLabel && !subLabel) return <span className="text-[11px] text-muted-foreground/50">—</span>;
          return (
            <div className="min-w-0" title={[catLabel, subLabel].filter(Boolean).join(' / ')}>
              {subLabel ? (
                <>
                  <span className="block w-full truncate text-xs font-medium text-foreground/85">{subLabel}</span>
                  {catLabel && <span className="block w-full truncate text-[10px] text-muted-foreground/75">in {catLabel}</span>}
                </>
              ) : (
                <span className="block w-full truncate text-xs text-muted-foreground">{catLabel}</span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor((r) => (r.isBatch ? '' : (r.status || '')), {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const r = row.original;
          if (r.isBatch) {
            const closed = r.subRows.filter((t) => ['Resolved', 'Closed'].includes(t.status)).length;
            return closed === r.count
              ? <StatusPill status="Closed" size="sm" />
              : <span className="text-[11px] text-muted-foreground">{closed}/{r.count} closed</span>;
          }
          return <StatusPill status={r.status} size="sm" />;
        },
      }),
      columnHelper.accessor((r) => (r.isBatch ? r.startTs : activityTs(r, chipKey)), {
        id: 'when',
        header: chipKey === 'closed' ? 'Closed' : chipKey === 'open' ? 'Assigned' : 'Handled',
        cell: ({ row, getValue }) => {
          const r = row.original;
          if (r.isBatch) {
            return (
              <span
                className="whitespace-nowrap text-xs text-muted-foreground/75"
                title={`${new Date(r.startTs).toLocaleString()} – ${new Date(r.endTs).toLocaleString()}`}
              >
                {formatDayTime(r.startTs)} · {timeAgo(r.startTs)}
              </span>
            );
          }
          const ts = getValue();
          return (
            <span
              className="whitespace-nowrap text-xs text-muted-foreground/75"
              title={ts ? new Date(ts).toLocaleString() : ''}
            >
              {ts ? <>{formatDayTime(ts)} · {timeAgo(ts)}</> : '—'}
            </span>
          );
        },
      }),
    ];
  }, [chipKey, fromPath]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getSubRows: (row) => (row.isBatch ? row.subRows : undefined),
    getRowId: (row, index, parent) => (parent ? `${parent.id}.${row.id}` : String(row.isBatch ? row.id : row.id)),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  return (
    <section className="tp-card overflow-hidden rounded-xl" aria-label="Evidence table">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
      </div>

      {tickets.length === 0 ? (
        <div className="py-12 text-center">
          <Inbox className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
          <p className="text-sm text-muted-foreground/75">Nothing in this bucket for the selected period.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-1 p-0" aria-hidden="true" />
                <th className="w-6 px-2 py-2" aria-label="Expand" />
                {table.getFlatHeaders().map((header) => {
                  const canSort = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  const SortIcon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
                  return (
                    <th key={header.id} className="px-3 py-2">
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="tp-focus-ring inline-flex items-center gap-1 rounded hover:text-foreground/85"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon className={`h-3 w-3 ${dir ? 'text-blue-500' : 'text-muted-foreground/50'}`} aria-hidden="true" />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {table.getRowModel().rows.map((row) => {
                const r = row.original;
                const isBatch = Boolean(r.isBatch);
                const isChild = row.depth > 0;
                // Queue convention: the accent strip only fires for High/Urgent.
                const strip = !isBatch && r.priority >= 3
                  ? (PRIORITY_STRIP_COLORS[r.priority] || 'bg-transparent')
                  : 'bg-transparent';
                return (
                  <tr
                    key={row.id}
                    className={`${isBatch ? 'cursor-pointer bg-sky-50/40 dark:bg-sky-500/10 hover:bg-sky-50 dark:hover:bg-sky-500/15' : isChild ? 'bg-muted/25 hover:bg-muted/50' : 'hover:bg-muted/50'} transition-colors`}
                    onClick={isBatch ? row.getToggleExpandedHandler() : undefined}
                  >
                    {/* Left priority accent strip (PRIORITY_STRIP_COLORS) */}
                    <td className="relative w-1 p-0" aria-hidden="true">
                      <span className={`absolute inset-y-0 left-0 w-1 ${strip}`} />
                    </td>
                    <td className="px-2 py-2 align-middle">
                      {isBatch && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
                          aria-expanded={row.getIsExpanded()}
                          aria-label={row.getIsExpanded() ? `Collapse batch of ${r.count}` : `Expand batch of ${r.count}`}
                          className="tp-focus-ring rounded p-0.5 text-muted-foreground/75 hover:text-foreground/85"
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${row.getIsExpanded() ? 'rotate-90' : ''}`}
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={`${cell.column.id === 'ticket' ? 'w-full max-w-0' : 'max-w-[220px]'} px-3 py-1.5 align-middle`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
