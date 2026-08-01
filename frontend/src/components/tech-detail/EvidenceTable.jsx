import { useMemo, useState } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getExpandedRowModel,
  flexRender, createColumnHelper,
} from '@tanstack/react-table';
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, Inbox, Waves } from 'lucide-react';
import {
  TicketRefLink, StatusPill, TypePill, PersonAvatar, ProvenanceChip,
  ticketCategoryLabels,
} from '../tickets/ticketUi';

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceTable — ONE ticket table showing the set behind the active stat chip
// ("every number is a door"). Reuses the queue's row grammar (TicketRefLink /
// StatusPill / TypePill / PersonAvatar / ProvenanceChip) and TanStack Table
// for sorting, like Settings → MembersPanel.
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

function fmtWhen(ms, verbose) {
  if (!ms) return '—';
  const d = new Date(ms);
  return verbose
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : fmtTime(ms);
}

const columnHelper = createColumnHelper();

export default function EvidenceTable({ tickets = [], chipKey = 'handled', title = '', viewMode = 'daily' }) {
  const [sorting, setSorting] = useState([]);
  const [expanded, setExpanded] = useState({});

  const data = useMemo(() => groupBatches(tickets, chipKey), [tickets, chipKey]);
  // Daily views show clock times; ranges show dates. The open-now snapshot
  // always shows dates — its tickets can be days old regardless of period.
  const showDate = viewMode !== 'daily' || chipKey === 'open';

  const columns = useMemo(() => [
    columnHelper.accessor((r) => (r.isBatch ? r.id : (r.subject || '')), {
      id: 'ticket',
      header: 'Ticket',
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        if (r.isBatch) {
          return (
            <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-sky-800">
              <Waves className="h-3.5 w-3.5 flex-shrink-0 text-sky-500" aria-hidden="true" />
              <span className="truncate">{r.category} ×{r.count}</span>
            </span>
          );
        }
        return (
          <div className={`min-w-0 ${row.depth > 0 ? 'pl-5' : ''}`}>
            <TicketRefLink ticket={r} className="text-[11px]" />
            <div className="truncate text-[12px] font-medium text-slate-800" title={r.subject}>
              {r.subject || '—'}
            </div>
          </div>
        );
      },
    }),
    columnHelper.accessor((r) => (r.isBatch ? '' : (r.requesterName || '')), {
      id: 'requester',
      header: 'Requester',
      cell: ({ row }) => {
        const r = row.original;
        if (r.isBatch) {
          const uniq = new Set(r.subRows.map((t) => t.requesterName).filter(Boolean));
          return <span className="text-[11px] text-slate-400">{uniq.size || r.count} requester{(uniq.size || r.count) === 1 ? '' : 's'}</span>;
        }
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <PersonAvatar name={r.requesterName} size="h-5 w-5" textSize="text-[9px]" />
            <span className="truncate text-[12px] text-slate-600">{r.requesterName || '—'}</span>
          </span>
        );
      },
    }),
    columnHelper.accessor((r) => (r.isBatch ? r.category : (categoryLabel(r) || '')), {
      id: 'category',
      header: 'Category',
      cell: ({ getValue }) => {
        const v = getValue();
        return v ? (
          <span className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 align-middle text-[10px] text-slate-500" title={v}>
            {v}
          </span>
        ) : <span className="text-[11px] text-slate-300">—</span>;
      },
    }),
    columnHelper.accessor((r) => (r.isBatch ? '' : (r.type || '')), {
      id: 'arrived',
      header: 'How it arrived',
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        if (r.isBatch) return <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-600">Batch</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <ProvenanceChip ticket={r} />
            <TypePill type={r.type} />
          </span>
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
            : <span className="text-[11px] text-slate-500">{closed}/{r.count} closed</span>;
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
            <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-500">
              {fmtWhen(r.startTs, showDate)}{showDate ? '' : ` – ${fmtTime(r.endTs)}`}
            </span>
          );
        }
        return <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-500">{fmtWhen(getValue(), showDate)}</span>;
      },
    }),
  ], [chipKey, showDate]);

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
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      </div>

      {tickets.length === 0 ? (
        <div className="py-12 text-center">
          <Inbox className="mx-auto mb-2 h-8 w-8 text-slate-200" aria-hidden="true" />
          <p className="text-sm text-slate-400">Nothing in this bucket for the selected period.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              <tr>
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
                          className="tp-focus-ring inline-flex items-center gap-1 rounded hover:text-slate-700"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon className={`h-3 w-3 ${dir ? 'text-blue-500' : 'text-slate-300'}`} aria-hidden="true" />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.getRowModel().rows.map((row) => {
                const r = row.original;
                const isBatch = Boolean(r.isBatch);
                const isChild = row.depth > 0;
                return (
                  <tr
                    key={row.id}
                    className={`${isBatch ? 'cursor-pointer bg-sky-50/40 hover:bg-sky-50' : isChild ? 'bg-slate-50/50 hover:bg-slate-50' : 'hover:bg-slate-50'} transition-colors`}
                    onClick={isBatch ? row.getToggleExpandedHandler() : undefined}
                  >
                    <td className="px-2 py-2 align-middle">
                      {isBatch && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
                          aria-expanded={row.getIsExpanded()}
                          aria-label={row.getIsExpanded() ? `Collapse batch of ${r.count}` : `Expand batch of ${r.count}`}
                          className="tp-focus-ring rounded p-0.5 text-slate-400 hover:text-slate-700"
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${row.getIsExpanded() ? 'rotate-90' : ''}`}
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="max-w-[220px] px-3 py-2 align-middle">
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
