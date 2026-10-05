import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { groupByTrigger, relativeTime, runFailed, workflowState } from './WorkflowIndex';

/**
 * Mail Workflows, the list page (QA 09-29 #2, 30 Sep 2026): the page opens on
 * a full-width list of every workflow, grouped by trigger in a ticket's life
 * order, the way FreshService's Workflow Automator does. Opening one takes
 * the whole page for its editor (the panel's "editor" view) and "All
 * workflows" comes back here — the list no longer shares the screen with the
 * canvas.
 *
 * Columns: name (+ description), state (dot + word), kind (Default /
 * Routed / Variant / Sub-workflow), version, last run. The enable switch
 * stays on the workflow's own page (QA 09-22 #11: too easy to hit in a list).
 */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'on', label: 'Enabled' },
  { key: 'observe', label: 'Shadow' },
  { key: 'failing', label: 'Failing' },
  { key: 'off', label: 'Off' },
];

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function workflowKind(workflow, { isAfterHours = () => false } = {}) {
  const kind = workflow.isDefaultVariant
    ? 'Default'
    : workflow.triggerType === 'manual' ? 'Sub-workflow' : workflow.routingRule ? 'Routed' : 'Variant';
  return isAfterHours(workflow) ? `${kind} · after-hours` : kind;
}

function matchesFilter(workflow, filter) {
  if (filter === 'all') return true;
  const key = workflowState(workflow).key;
  if (filter === 'off') return key === 'off' || key === 'draft';
  return key === filter;
}

function RowMenu({ workflow, name, onRowAction, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const archived = Boolean(workflow.archivedAt);
  const items = [
    { key: 'variant', label: 'New variant…' },
    ...(workflow.isDefaultVariant ? [] : [{ key: archived ? 'restore' : 'archive', label: archived ? 'Restore' : 'Archive' }]),
    ...(archived && !workflow.isDefaultVariant ? [{ key: 'delete', label: 'Delete permanently', danger: true }] : []),
  ];
  return (
    <div ref={ref} role="menu" aria-label={`Actions for ${name}`} className="tp-card absolute right-2 top-full z-30 mt-0.5 w-44 rounded-lg p-1 shadow-soft animate-popIn">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          onClick={() => { onRowAction(workflow, item.key); onClose(); }}
          className={cx('tp-focus-ring flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-muted', item.danger ? 'text-red-700 dark:text-red-300' : 'text-foreground/85')}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ListRow({ workflow, name, onOpen, onRowAction, isAfterHours }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const state = workflowState(workflow);
  const lastRun = workflow.runs?.[0];
  const version = workflow.publishedVersion || 0;
  const muted = state.key === 'off' || state.key === 'draft' || state.key === 'archived';
  return (
    <li className="group/row relative" data-testid="workflow-list-row" data-state={state.key}>
      <button
        type="button"
        onClick={() => onOpen(workflow.id)}
        className="tp-focus-ring grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2.5 pl-10 pr-4 text-left transition-colors hover:bg-muted/60 md:grid-cols-[minmax(0,1fr)_9rem_8rem_4rem_8rem_1.5rem]"
      >
        <span className="min-w-0">
          <span className={cx('block truncate text-sm font-semibold', muted ? 'text-muted-foreground' : 'text-foreground')}>{name}</span>
          {workflow.description && <span className="block truncate text-xs text-muted-foreground">{workflow.description}</span>}
          {/* QA 10-05 #5: workflow watch — say when a workflow quietly stopped doing its job. */}
          {(workflow.watchSignals || []).slice(0, 2).map((signal) => (
            <span key={`${signal.code}-${signal.nodeId || ''}`} data-testid="workflow-watch-signal" className="mt-0.5 flex items-start gap-1 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0">{signal.message}</span>
            </span>
          ))}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-foreground/85">
          <span className={cx('h-2 w-2 flex-shrink-0 rounded-full', state.dot)} aria-hidden="true" />
          {state.label}
        </span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">{workflowKind(workflow, { isAfterHours })}</span>
        <span className="hidden text-xs tabular-nums text-muted-foreground md:block">{version > 0 ? `v${version}` : 'draft'}</span>
        <span className={cx('hidden text-xs md:block', lastRun && runFailed(lastRun.status) ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
          {lastRun ? `${runFailed(lastRun.status) ? 'Failed' : 'Ran'} ${relativeTime(lastRun.startedAt)}` : 'No runs yet'}
        </span>
        <ChevronRight className="hidden h-4 w-4 text-muted-foreground/60 md:block" aria-hidden="true" />
      </button>
      {onRowAction && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`More actions for ${name}`}
          className={cx('tp-focus-ring absolute right-10 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/75 hover:bg-muted hover:text-foreground', menuOpen ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {menuOpen && <RowMenu workflow={workflow} name={name} onRowAction={onRowAction} onClose={() => setMenuOpen(false)} />}
    </li>
  );
}

export default function WorkflowListPage({
  workflows = [],
  onOpen,
  onCreate,
  onCreateForTrigger,
  onRowAction = null,
  getDisplayName = (w) => w.name,
  getVisuals = () => ({}),
  eventLabels = {},
  isAfterHours = () => false,
  showArchived = false,
  archivedCount = 0,
  onShowArchivedChange,
  actions = null,
  footer = null,
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => workflows.filter((w) => (
    matchesFilter(w, showArchived ? 'all' : filter)
    && (!q || [getDisplayName(w), w.description, eventLabels[w.triggerType]].filter(Boolean).join(' ').toLowerCase().includes(q))
  )), [workflows, filter, q, showArchived, getDisplayName, eventLabels]);
  const groups = useMemo(() => groupByTrigger(shown, eventLabels), [shown, eventLabels]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-list-page">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <h2 className="text-base font-bold text-foreground">
          Workflows <span className="ml-1 text-sm font-medium tabular-nums text-muted-foreground">{shown.length}</span>
        </h2>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search workflows"
            className="tp-focus-ring h-9 w-full rounded-md border border-border bg-card pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground/75"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/75 hover:text-foreground">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs" role="group" aria-label="Filter workflows">
          {FILTERS.map((f) => {
            const on = filter === f.key && !showArchived;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => { setFilter(f.key); onShowArchivedChange?.(false); }}
                className={cx('tp-focus-ring rounded font-semibold', on ? 'text-primary underline decoration-2 underline-offset-4' : 'text-muted-foreground hover:text-foreground')}
              >
                {f.label}
              </button>
            );
          })}
          {archivedCount > 0 && (
            <button
              type="button"
              aria-pressed={showArchived}
              onClick={() => onShowArchivedChange?.(!showArchived)}
              className={cx('tp-focus-ring rounded font-semibold', showArchived ? 'text-primary underline decoration-2 underline-offset-4' : 'text-muted-foreground hover:text-foreground')}
            >
              Archived <span className="tabular-nums">{archivedCount}</span>
            </button>
          )}
        </div>
        <span className="flex items-center gap-2 sm:ml-auto">
          {actions}
          {onCreate && (
            <button type="button" onClick={onCreate} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" aria-hidden="true" /> New workflow
            </button>
          )}
        </span>
      </div>

      <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_4rem_8rem_1.5rem] gap-x-4 border-b border-border/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid" aria-hidden="true">
        <span>Name</span><span>State</span><span>Kind</span><span>Version</span><span>Last run</span><span />
      </div>

      <div className="settings-scrollbar min-h-0 flex-1 overflow-y-auto">
        {groups.size === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {q || filter !== 'all' ? 'No workflows match.' : 'No workflows yet. Start with New workflow or a template.'}
          </p>
        )}
        {[...groups.entries()].map(([triggerType, bucket]) => {
          const list = [...(bucket.default ? [bucket.default] : []), ...bucket.customs];
          const visuals = getVisuals(triggerType) || {};
          const GroupIcon = visuals.icon;
          const label = eventLabels[triggerType] || triggerType;
          return (
            <section key={triggerType} aria-label={label} data-testid="workflow-list-group">
              {/* QA 10-01 #2: the header was a full-width grey band — the same
                  look as a hovered or selected row. It is now a title on the
                  page background followed by a hairline rule, and the
                  workflows under it are indented as its members. */}
              <div className="group/grp sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-4 pb-1 pt-4 backdrop-blur-sm" data-testid="workflow-list-group-header">
                {GroupIcon && <GroupIcon className={cx('h-4 w-4 flex-shrink-0', visuals.icon_ || 'text-primary/80')} aria-hidden="true" />}
                <h3 className="min-w-0 max-w-[60%] truncate text-xs font-bold uppercase tracking-[0.06em] text-primary">{label}</h3>
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">{list.length}</span>
                <span className="h-px min-w-[2rem] flex-1 bg-border" aria-hidden="true" />
                {onCreateForTrigger && triggerType !== 'other' && (
                  <button
                    type="button"
                    onClick={() => onCreateForTrigger(triggerType)}
                    aria-label={`New workflow for ${label}`}
                    className="tp-focus-ring rounded p-0.5 text-muted-foreground/75 opacity-0 hover:bg-muted hover:text-foreground group-hover/grp:opacity-100 focus-visible:opacity-100"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              <ul className="divide-y divide-border/60">
                {list.map((workflow) => (
                  <ListRow
                    key={workflow.id}
                    workflow={workflow}
                    name={getDisplayName(workflow)}
                    onOpen={onOpen}
                    onRowAction={onRowAction}
                    isAfterHours={isAfterHours}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {footer && <div className="flex-shrink-0 border-t border-border/60">{footer}</div>}
    </div>
  );
}
