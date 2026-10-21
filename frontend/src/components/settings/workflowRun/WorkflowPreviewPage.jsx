// Mail Workflows → Preview, as a page (18 Oct 2026; was a pop-up).
//
// Back returns to the workflow it came from; the draft stays in the panel, so
// unsaved edits survive the trip. The ticket list is a dense table with a Run
// button on every row and one row of icon filters; once a run starts the list
// folds into a strip and the run (live pipeline, e-mail, LLM output) takes
// the page.
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Flag,
  GitBranch,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  UserCheck,
  VolumeX,
  FlaskConical,
  AlertCircle,
} from 'lucide-react';
import RunResultView from './RunResultView';

function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

export const PREVIEW_FILTER_DEFAULTS = {
  search: '',
  priority: 'all',
  status: 'all',
  origin: 'all',
  assigned: 'all',
  created: 'all',
  noise: 'all',
};

// The default option carries the field's name, so the row reads like a set
// of column headings until something is picked.
const FILTERS = [
  {
    key: 'priority',
    label: 'Priority',
    Icon: Flag,
    options: [['all', 'Priority'], ['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']],
  },
  {
    key: 'status',
    label: 'Status',
    Icon: CircleDot,
    options: [['all', 'Status'], ['Open', 'Open'], ['Pending', 'Pending'], ['Resolved', 'Resolved'], ['Closed', 'Closed']],
  },
  {
    key: 'origin',
    label: 'Where the ticket was born',
    Icon: GitBranch,
    options: [['all', 'Origin'], ['ticketpulse', 'Ticket Pulse'], ['freshservice', 'FreshService']],
  },
  {
    key: 'assigned',
    label: 'Owner',
    Icon: UserCheck,
    options: [['all', 'Owner'], ['assigned', 'Assigned'], ['unassigned', 'Unassigned']],
  },
  {
    key: 'created',
    label: 'Created',
    Icon: CalendarClock,
    options: [['all', 'Created'], ['24h', 'Last 24 h'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']],
  },
  {
    key: 'noise',
    label: 'Noise',
    Icon: VolumeX,
    options: [['all', 'Noise'], ['hide', 'Hide noise'], ['only', 'Noise only']],
  },
];

function activePreviewFilterCount(filters = {}) {
  return FILTERS.filter((filter) => (filters[filter.key] || 'all') !== 'all').length + (String(filters.search || '').trim() ? 1 : 0);
}

// A select that shows an icon and its current value; tinted once it is set
// to anything but its default. Shared with the Workflow Audit toolbar.
export function IconSelect({
  label,
  ariaLabel,
  Icon,
  options,
  value,
  defaultValue = 'all',
  onChange,
  maxWidthClass = 'max-w-[180px]',
}) {
  const current = value ?? defaultValue;
  const active = current !== defaultValue;
  return (
    <label className="relative inline-flex shrink-0 items-center" title={label}>
      <Icon
        className={cls('pointer-events-none absolute left-2 h-3.5 w-3.5', active ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <select
        aria-label={ariaLabel || label}
        value={current}
        onChange={(event) => onChange(event.target.value)}
        className={cls(
          'tp-focus-ring h-8 cursor-pointer appearance-none truncate rounded-md border pl-7 pr-6 text-xs font-semibold',
          maxWidthClass,
          active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border bg-card text-muted-foreground hover:text-foreground',
        )}
      >
        {/* An entry is [value, label], or { group, options } for an <optgroup>. */}
        {options.map((entry) => (Array.isArray(entry) ? (
          <option key={entry[0]} value={entry[0]}>{entry[1]}</option>
        ) : (
          <optgroup key={`group:${entry.group}`} label={entry.group}>
            {entry.options.map(([optionValue, optionLabel]) => (
              <option key={optionValue} value={optionValue}>{optionLabel}</option>
            ))}
          </optgroup>
        )))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground/75" aria-hidden="true" />
    </label>
  );
}

export function relativeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

const PRIORITY_DOT = {
  Urgent: 'bg-red-500',
  High: 'bg-amber-500',
  Medium: 'bg-blue-500',
  Low: 'bg-muted-foreground/50',
};

export function ticketRef(ticket) {
  if (!ticket) return '';
  if (ticket.displayRef) return ticket.displayRef;
  if (ticket.origin === 'ticketpulse' && ticket.nativeNumber) return `TP-${ticket.nativeNumber}`;
  return ticket.freshserviceTicketId ? `#${ticket.freshserviceTicketId}` : `ID ${ticket.id}`;
}

function ticketCategory(ticket) {
  return [
    ticket.internalCategory?.name || ticket.category,
    ticket.internalSubcategory?.name || ticket.subCategory,
  ].filter(Boolean).join(' › ');
}

// QA 10-20 #6: the columns grow with the window. The subject used to take every
// spare pixel (a wide empty middle on a big screen) while requester, owner and
// category stayed at fixed widths and cut their text short. Now the text
// columns share the width in proportion; only the small ones stay fixed.
function TicketTable({ items, loading, runningTicketId, lastTicketId, running, onRun }) {
  return (
    <div className="settings-scrollbar min-h-0 flex-1 overflow-auto" data-testid="preview-ticket-table">
      <table className="w-full table-fixed border-separate border-spacing-0 text-xs">
        <colgroup>
          <col className="w-[64px]" />
          <col className="w-[92px]" />
          <col data-testid="preview-col-subject" />
          <col className="hidden w-[16%] md:table-column" />
          <col className="w-[15%]" />
          <col className="w-[84px]" />
          <col className="w-[9%]" />
          <col className="hidden w-[20%] xl:table-column" />
          <col className="w-[56px]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="border-b border-border px-3 py-2"><span className="sr-only">Run</span></th>
            <th className="border-b border-border px-2 py-2">Ticket</th>
            <th className="border-b border-border px-2 py-2">Subject</th>
            <th className="hidden border-b border-border px-2 py-2 md:table-cell">Requester</th>
            <th className="border-b border-border px-2 py-2">Owner</th>
            <th className="border-b border-border px-2 py-2">Priority</th>
            <th className="border-b border-border px-2 py-2">Status</th>
            <th className="hidden border-b border-border px-2 py-2 xl:table-cell">Category</th>
            <th className="border-b border-border px-2 py-2 text-right">Age</th>
          </tr>
        </thead>
        <tbody className={cls(loading && items.length > 0 && 'opacity-60')}>
          {loading && items.length === 0 && (
            <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">
              <RefreshCw className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading tickets
            </td></tr>
          )}
          {!loading && items.length === 0 && (
            <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">No tickets match. Try fewer filters.</td></tr>
          )}
          {items.map((ticket) => {
            const isRunning = running && runningTicketId === ticket.id;
            const isLast = lastTicketId === ticket.id;
            const requester = ticket.requester?.name || ticket.requester?.email || '';
            const category = ticketCategory(ticket);
            return (
              <tr
                key={ticket.id}
                className={cls('group h-9 hover:bg-muted/60', isLast && 'bg-primary/5')}
                data-testid={`preview-ticket-${ticket.id}`}
              >
                <td className={cls('border-b border-border/60 px-2', isLast && 'shadow-[inset_3px_0_0_hsl(var(--primary))]')}>
                  <button
                    type="button"
                    onClick={() => onRun(ticket)}
                    disabled={running}
                    aria-label={`Run preview on ${ticketRef(ticket)}`}
                    title={`Run this workflow on ${ticketRef(ticket)}`}
                    className="tp-focus-ring inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />}
                    Run
                  </button>
                </td>
                <td className="truncate border-b border-border/60 px-2 font-mono text-[11px] font-semibold text-muted-foreground">{ticketRef(ticket)}</td>
                <td className="border-b border-border/60 px-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-foreground" title={ticket.subject}>{ticket.subject || 'No subject'}</span>
                    {ticket.isNoise && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-200">Noise</span>}
                  </div>
                </td>
                <td className="hidden truncate border-b border-border/60 px-2 text-foreground/85 md:table-cell" title={ticket.requester?.email || requester}>{requester || '—'}</td>
                <td className="truncate border-b border-border/60 px-2">
                  {ticket.assignedAgent?.name
                    ? <span className="text-foreground/85">{ticket.assignedAgent.name}</span>
                    : <span className="font-semibold text-amber-700 dark:text-amber-200">Unassigned</span>}
                </td>
                <td className="border-b border-border/60 px-2">
                  <span className="inline-flex items-center gap-1.5 text-foreground/85">
                    <span className={cls('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[ticket.priorityLabel] || 'bg-muted-foreground/40')} aria-hidden="true" />
                    {ticket.priorityLabel || '—'}
                  </span>
                </td>
                <td className="truncate border-b border-border/60 px-2 text-foreground/85">{ticket.status || '—'}</td>
                <td className="hidden truncate border-b border-border/60 px-2 text-muted-foreground xl:table-cell" title={category}>{category || '—'}</td>
                <td className="border-b border-border/60 px-2 text-right font-mono text-[11px] text-muted-foreground" title={ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : ''}>
                  {relativeTime(ticket.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FilterRow({ filters, onFiltersChange, tickets, page, pageSize, loading, onPageChange, onPageSizeChange }) {
  const [searchText, setSearchText] = useState(filters.search || '');
  useEffect(() => { setSearchText(filters.search || ''); }, [filters.search]);
  useEffect(() => {
    if (searchText === (filters.search || '')) return undefined;
    const handle = window.setTimeout(() => onFiltersChange({ search: searchText }), 250);
    return () => window.clearTimeout(handle);
    // onFiltersChange is recreated by the parent each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  const total = tickets?.total || 0;
  const totalPages = tickets?.totalPages || 1;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const activeCount = activePreviewFilterCount(filters);
  return (
    <div className="settings-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 py-2" data-testid="preview-filters">
      <label className="relative min-w-[220px] flex-1">
        <span className="sr-only">Search preview tickets</span>
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="TP-1042, #247711, subject, person, category, department…"
          className="tp-focus-ring h-8 w-full rounded-md border border-border bg-card pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground/75"
        />
      </label>
      {FILTERS.map((filter) => (
        <IconSelect
          key={filter.key}
          label={filter.label}
          ariaLabel={`Filter preview tickets by ${filter.label.toLowerCase()}`}
          Icon={filter.Icon}
          options={filter.options}
          value={filters[filter.key]}
          onChange={(value) => onFiltersChange({ [filter.key]: value })}
        />
      ))}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={() => { setSearchText(''); onFiltersChange({ ...PREVIEW_FILTER_DEFAULTS }); }}
          className="tp-focus-ring inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Clear filters"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {activeCount}
        </button>
      )}
      <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      <label className="relative inline-flex shrink-0 items-center" title="Tickets per page">
        <select
          aria-label="Tickets per page"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="tp-focus-ring h-8 cursor-pointer appearance-none rounded-md border border-border bg-card pl-2 pr-6 text-xs font-semibold text-muted-foreground"
        >
          {[25, 50].map((size) => <option key={size} value={size}>{size} / page</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground/75" aria-hidden="true" />
      </label>
      <span className="shrink-0 whitespace-nowrap px-1 font-mono text-[11px] text-muted-foreground" data-testid="preview-range">
        {from}–{to} of {total.toLocaleString()}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1 || loading}
        aria-label="Previous page"
        className="tp-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages || loading}
        aria-label="Next page"
        className="tp-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function WorkflowPreviewPage({
  workflowName,
  onBack,
  tickets,
  ticketsLoading = false,
  filters = PREVIEW_FILTER_DEFAULTS,
  onFiltersChange,
  page = 1,
  onPageChange,
  pageSize = 25,
  onPageSizeChange,
  runTicket = null,
  running = false,
  hasRun = false,
  error = null,
  onRun,
  model = null,
  onSendTest,
  testSending = false,
  testResult = null,
  signalLabel,
}) {
  const [pickerOpen, setPickerOpen] = useState(!hasRun && !running);
  // A new run folds the list away; the strip brings it back.
  useEffect(() => {
    if (running) setPickerOpen(false);
  }, [running]);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      onBack?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const items = tickets?.items || [];
  const showRun = hasRun || running;
  const showPicker = pickerOpen || !showRun;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workflow-preview-page">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="tp-focus-ring inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground/85 hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Back to {workflowName || 'workflow'}</span>
        </button>
        <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        <h2 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <FlaskConical className="h-4 w-4 text-primary" aria-hidden="true" />
          Preview
        </h2>
        <p className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          Runs your unsaved edits on a real ticket with the real LLM. Nothing is sent; every action block shows so you can check it.
        </p>
      </header>

      {showRun && !showPicker && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-xs" data-testid="preview-ticket-strip">
          <span className="text-muted-foreground">Ticket</span>
          <span className="font-mono font-semibold text-foreground/85">{ticketRef(runTicket)}</span>
          <span className="min-w-0 truncate text-foreground/85">{runTicket?.subject}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => runTicket && onRun(runTicket)}
              disabled={running || !runTicket}
              className="tp-focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 font-semibold text-primary hover:bg-primary/10 disabled:opacity-40"
            >
              {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
              Run again
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="tp-focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 font-semibold text-foreground/85 hover:bg-muted"
            >
              Choose another ticket
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
      )}

      {showPicker && (
        <div className={cls('flex min-h-0 flex-col border-b border-border', showRun ? 'max-h-[45%] shrink-0' : 'flex-1')}>
          <FilterRow
            filters={filters}
            onFiltersChange={onFiltersChange}
            tickets={tickets}
            page={page}
            pageSize={pageSize}
            loading={ticketsLoading}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
          <TicketTable
            items={items}
            loading={ticketsLoading}
            running={running}
            runningTicketId={runTicket?.id}
            lastTicketId={showRun ? runTicket?.id : null}
            onRun={(ticket) => { setPickerOpen(false); onRun(ticket); }}
          />
          {showRun && (
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="tp-focus-ring flex shrink-0 items-center justify-center gap-1 border-t border-border/60 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted"
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-180" aria-hidden="true" />
              Hide ticket list
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2 text-xs font-semibold text-red-700 dark:text-red-200" role="alert">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {error}
        </div>
      )}

      {showRun && (
        <RunResultView
          model={model}
          running={running}
          onRunAnyway={runTicket ? () => onRun(runTicket, { ignoreRouting: true }) : null}
          onSendTest={onSendTest}
          testSending={testSending}
          testResult={testResult}
          signalLabel={signalLabel}
        />
      )}
    </div>
  );
}
