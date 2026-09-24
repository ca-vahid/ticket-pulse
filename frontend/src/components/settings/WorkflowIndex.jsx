import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Search, X } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';

/**
 * Workflow sidebar (Mail Workflows redesign "L2", 22 Sep 2026) — the list
 * rail rebuilt in the shadcn/ui Sidebar shape: a header, a search, a text
 * filter row, collapsible groups per trigger with plain counts, one-line
 * rows (state dot · name · meta) with a hover toggle and a row-action menu,
 * a footer slot (health), and an icon-collapse mode (⌘B) that folds the
 * whole panel to a 56px rail of trigger icons so the canvas gets the width.
 *
 * No pills: state is the dot (green enabled, amber observe-only, red failing,
 * grey off, hollow archived) plus a short muted meta line. Naming and trigger
 * visuals still arrive from the panel as props so the two can't drift.
 */

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function relativeTime(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function runFailed(status) {
  return /(fail|error|bounce|reject|block)/i.test(String(status || ''));
}

function loadCollapsed(storageKey) {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey));
    return Array.isArray(parsed) ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Trigger groups follow a ticket's life (Vahid, 22 Sep 2026): it arrives, gets
 * assigned, people talk, it ages, it closes, then approvals, schedules and
 * anything the list doesn't know about — instead of whatever order the API
 * returned them in.
 */
export const TRIGGER_ORDER = [
  'ticket.created', 'ticket.assigned', 'ticket.reassigned', 'ticket.unassigned_for',
  'ticket.status_changed', 'ticket.fields_updated',
  'ticket.reply_received', 'ticket.public_reply_added', 'ticket.note_added', 'ticket.requester_silent_for',
  'ticket.aging', 'ticket.sla_pre_breach', 'ticket.sla_breach',
  'ticket.categorized', 'ticket.parked', 'ticket.park_due_soon', 'ticket.woke',
  'ticket.reopened', 'ticket.resolved_closed',
  'approval.requested', 'approval.clarification_requested', 'approval.decided',
  'schedule.time', 'manual',
];
const triggerRank = (type) => { const i = TRIGGER_ORDER.indexOf(type); return i === -1 ? TRIGGER_ORDER.length : i; };

function groupByTrigger(workflows, eventLabels = {}) {
  const groups = new Map(); // triggerType -> { default, customs: [] }
  for (const workflow of workflows) {
    const key = workflow.triggerType || 'other';
    if (!groups.has(key)) groups.set(key, { default: null, customs: [] });
    const bucket = groups.get(key);
    if (workflow.isDefaultVariant && !bucket.default) bucket.default = workflow;
    else bucket.customs.push(workflow);
  }
  for (const bucket of groups.values()) {
    bucket.customs.sort((a, b) => (
      Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt))
      || (a.routingPriority || 1) - (b.routingPriority || 1)
      || String(a.name || '').localeCompare(String(b.name || ''))
    ));
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (
    triggerRank(a) - triggerRank(b) || String(eventLabels[a] || a).localeCompare(String(eventLabels[b] || b))
  )));
}

/** The one-word state of a workflow, and the dot that shows it. */
export function workflowState(workflow) {
  if (workflow.archivedAt) return { key: 'archived', label: 'Archived', dot: 'border border-muted-foreground/50 bg-transparent' };
  const lastRun = workflow.runs?.[0];
  if (workflow.isEnabled && lastRun && runFailed(lastRun.status)) return { key: 'failing', label: 'Failing', dot: 'bg-red-500' };
  if (workflow.isEnabled && workflow.mockModeEnabled) return { key: 'observe', label: 'Observe-only', dot: 'bg-amber-500' };
  if (workflow.isEnabled) return { key: 'on', label: 'Enabled', dot: 'bg-emerald-500' };
  if (!(workflow.publishedVersion > 0)) return { key: 'draft', label: 'Draft', dot: 'bg-muted-foreground/40' };
  return { key: 'off', label: 'Off', dot: 'bg-muted-foreground/40' };
}

/** "Default · v17 · ran 6h ago" — the one muted line under a name. */
export function workflowMeta(workflow, { isAfterHours = () => false } = {}) {
  const parts = [];
  if (workflow.isDefaultVariant) parts.push('Default');
  else if (workflow.triggerType === 'manual') parts.push('Sub-workflow');
  else if (workflow.routingRule) parts.push('Routed');
  else parts.push('Variant');
  if (isAfterHours(workflow)) parts.push('After-hours');
  const version = workflow.publishedVersion || 0;
  parts.push(version > 0 ? `v${version}` : 'draft');
  const lastRun = workflow.runs?.[0];
  if (lastRun) parts.push(`${runFailed(lastRun.status) ? 'failed' : 'ran'} ${relativeTime(lastRun.startedAt)}`);
  else parts.push('no runs');
  return parts.join(' · ');
}

function RowMenu({ workflow, displayName, onRowAction, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const isArchived = Boolean(workflow.archivedAt);
  const items = [
    { key: 'variant', label: 'New variant…' },
    ...(workflow.isDefaultVariant ? [] : [{ key: isArchived ? 'restore' : 'archive', label: isArchived ? 'Restore' : 'Archive' }]),
    ...(isArchived && !workflow.isDefaultVariant ? [{ key: 'delete', label: 'Delete permanently', danger: true }] : []),
  ];
  return (
    <div ref={ref} role="menu" aria-label={`Actions for ${displayName}`} className="tp-card absolute right-2 top-full z-30 mt-0.5 w-44 rounded-lg p-1 shadow-soft animate-popIn">
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

function IndexRow({
  workflow, selected, onSelect,
  getDisplayName, isAfterHours, onRowAction,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isEnabled = !!workflow.isEnabled;
  const isArchived = Boolean(workflow.archivedAt);
  const version = workflow.publishedVersion || 0;
  const state = workflowState(workflow);
  const name = getDisplayName(workflow);
  const meta = workflowMeta(workflow, { isAfterHours });
  return (
    <div
      data-testid="workflow-row"
      data-state={state.key}
      className={cx(
        'group/row relative flex items-center gap-2 pl-3 pr-2 transition-colors',
        selected ? 'bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-muted/70',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(workflow.id)}
        aria-current={selected ? 'true' : undefined}
        title={`${name} — ${state.label} · ${meta}`}
        className="tp-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 text-left"
      >
        <span className={cx('h-2 w-2 flex-shrink-0 rounded-full', state.dot)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[13px] leading-4', selected ? 'font-semibold text-foreground' : isArchived || !isEnabled ? 'font-medium text-muted-foreground' : 'font-medium text-foreground/90')}>
            {name}
          </span>
          <span className="block truncate text-[10.5px] leading-3.5 text-muted-foreground/75">{meta}</span>
        </span>
      </button>
      {/* The enable switch moved to the workflow's own header (QA 09-22 #11):
          in the sidebar it was too easy to hit. The state stays readable. */}
      {!isArchived && (
        <span
          className={cx(
            'flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide',
            isEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground/70',
          )}
          aria-label={`${name} is ${isEnabled ? 'on' : version === 0 ? 'a draft' : 'off'}`}
        >
          {isEnabled ? 'On' : version === 0 ? 'Draft' : 'Off'}
        </span>
      )}
      {onRowAction && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`More actions for ${name}`}
          className={cx('tp-focus-ring flex-shrink-0 rounded p-0.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground', menuOpen ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      {menuOpen && <RowMenu workflow={workflow} displayName={name} onRowAction={onRowAction} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

export default function WorkflowIndex({
  workflows,
  selectedId,
  onSelect,
  onToggleEnabled,
  togglingId = null,
  onCreateForTrigger,
  onCreate = null,
  getDisplayName,
  getVisuals,
  eventLabels,
  isAfterHours,
  onRowAction = null,
  collapsed = false,
  onToggleCollapsed = null,
  showArchived = false,
  archivedCount = 0,
  onShowArchivedChange = null,
  footer = null,
}) {
  const { currentWorkspace } = useWorkspace();
  const storageKey = `tp_wf_collapsed_${currentWorkspace?.id ?? 'all'}`;
  // null = no saved choice → open folded, except the group holding the selected workflow (Vahid, 22 Sep 2026).
  const [savedCollapsed, setSavedCollapsed] = useState(() => loadCollapsed(storageKey));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // all | enabled | failing

  useEffect(() => {
    setSavedCollapsed(loadCollapsed(storageKey));
  }, [storageKey]);
  const allTriggerTypes = useMemo(() => [...groupByTrigger(workflows, eventLabels).keys()], [workflows, eventLabels]);
  const selectedTriggerType = workflows.find((w) => w.id === selectedId)?.triggerType || null;
  const groupsCollapsed = useMemo(
    () => savedCollapsed ?? new Set(allTriggerTypes.filter((type) => type !== selectedTriggerType)),
    [savedCollapsed, allTriggerTypes, selectedTriggerType],
  );
  const allCollapsed = allTriggerTypes.length > 0 && allTriggerTypes.every((type) => groupsCollapsed.has(type));
  const setAllCollapsed = (fold) => {
    const next = fold ? new Set(allTriggerTypes) : new Set();
    persist(next);
    setSavedCollapsed(next);
  };

  const persist = (nextSet) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...nextSet]));
    } catch { /* collapse still works for the session */ }
  };
  const toggleGroup = (triggerType) => {
    const next = new Set(groupsCollapsed);
    if (next.has(triggerType)) next.delete(triggerType);
    else next.add(triggerType);
    persist(next);
    setSavedCollapsed(next);
  };

  const failingCount = useMemo(
    () => workflows.filter((w) => w.isEnabled && !w.archivedAt && w.runs?.[0] && runFailed(w.runs[0].status)).length,
    [workflows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (filter === 'enabled' && !workflow.isEnabled) return false;
      if (filter === 'failing' && !(workflow.runs?.[0] && runFailed(workflow.runs[0].status))) return false;
      if (!q) return true;
      return getDisplayName(workflow).toLowerCase().includes(q)
        || String(workflow.name || '').toLowerCase().includes(q)
        || String(eventLabels[workflow.triggerType] || workflow.triggerType || '').toLowerCase().includes(q);
    });
  }, [workflows, query, filter, getDisplayName, eventLabels]);

  const groups = groupByTrigger(filtered, eventLabels);
  const allGroups = groupByTrigger(workflows, eventLabels);
  const searching = Boolean(query.trim());
  const filtering = searching || filter !== 'all' || showArchived;
  const selectedTrigger = selectedTriggerType;

  // ---- icon-collapse mode: a 56px rail of trigger icons ----
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 py-2" data-testid="workflow-sidebar-rail">
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand workflows (Ctrl+B)"
            title="Expand workflows (Ctrl+B)"
            className="tp-focus-ring mb-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {[...allGroups.entries()].map(([triggerType, bucket]) => {
          const GroupIcon = getVisuals(triggerType).icon;
          const total = (bucket.default ? 1 : 0) + bucket.customs.length;
          const active = selectedTrigger === triggerType;
          return (
            <button
              key={triggerType}
              type="button"
              onClick={onToggleCollapsed || undefined}
              title={`${eventLabels[triggerType] || triggerType} · ${total}`}
              aria-label={`${eventLabels[triggerType] || triggerType}, ${total} workflows`}
              className={cx('tp-focus-ring relative inline-flex h-9 w-9 items-center justify-center rounded-lg', active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <GroupIcon className="h-4 w-4" aria-hidden="true" />
              <span className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-card px-1 text-[9px] font-semibold leading-[14px] text-muted-foreground ring-1 ring-border">{total}</span>
            </button>
          );
        })}
        <div className="mt-auto">{footer}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-sidebar">
      {/* Header */}
      <div className="flex items-center gap-1 px-3 pb-1 pt-2.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Workflows</span>
        <span className="ml-auto flex items-center gap-0.5">
          {onCreate && (
            <button type="button" onClick={onCreate} className="tp-focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-primary hover:bg-primary/10">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New
            </button>
          )}
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse workflows (Ctrl+B)"
              title="Collapse workflows (Ctrl+B)"
              className="tp-focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/75 hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>

      {/* Search */}
      <div className="relative px-2.5 pb-1.5">
        <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-[60%] text-muted-foreground/75" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workflows…"
          aria-label="Search workflows"
          className="tp-focus-ring h-8 w-full rounded-md border border-border bg-card pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground/75"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-4 top-1/2 -translate-y-[60%] rounded p-0.5 text-muted-foreground/75 hover:text-foreground">
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Filters — text, not chips */}
      <div className="flex items-center gap-3 border-b border-border/60 px-3 pb-1.5 text-[11px]" role="group" aria-label="Filter workflows">
        {[
          { key: 'all', label: 'All' },
          { key: 'enabled', label: 'Enabled' },
          { key: 'failing', label: failingCount ? `Failing ${failingCount}` : 'Failing' },
        ].map((f) => {
          const on = filter === f.key && !showArchived;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => { setFilter(f.key); onShowArchivedChange?.(false); }}
              className={cx('tp-focus-ring rounded-sm border-b-2 pb-0.5 font-medium', on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/85', f.key === 'failing' && failingCount && !on ? 'text-red-600 dark:text-red-300' : '')}
            >
              {f.label}
            </button>
          );
        })}
        {onShowArchivedChange && archivedCount > 0 && (
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => onShowArchivedChange(!showArchived)}
            className={cx('tp-focus-ring ml-auto rounded-sm border-b-2 pb-0.5 font-medium', showArchived ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/85')}
          >
            Archived {archivedCount}
          </button>
        )}
        {!searching && allTriggerTypes.length > 0 && (
          <button
            type="button"
            onClick={() => setAllCollapsed(!allCollapsed)}
            className={cx('tp-focus-ring rounded-sm border-b-2 border-transparent pb-0.5 font-medium text-muted-foreground hover:text-foreground/85', !(onShowArchivedChange && archivedCount > 0) && 'ml-auto')}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      {/* Groups */}
      <div className="settings-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
            {filtering ? 'Nothing matches — clear the search or filters.' : 'No workflows yet. Use “New” to start from a trigger or a template.'}
          </div>
        )}
        {[...groups.entries()].map(([triggerType, bucket]) => {
          const total = (bucket.default ? 1 : 0) + bucket.customs.length;
          const GroupIcon = getVisuals(triggerType).icon;
          const isCollapsed = groupsCollapsed.has(triggerType) && !searching;
          const label = eventLabels[triggerType] || triggerType;
          return (
            <section key={triggerType} className={cx('group/grp', !isCollapsed && 'mb-1 border-b border-border')}>
              {/* Group title reads as a heading, not a row (Vahid, 23 Sep 2026): small caps on a tinted band. */}
              <div className="flex items-center border-y border-border/70 bg-muted/70 pr-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(triggerType)}
                  aria-expanded={!isCollapsed}
                  className="tp-focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left"
                >
                  <ChevronDown className={cx('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50 transition-transform', isCollapsed && '-rotate-90')} aria-hidden="true" />
                  <GroupIcon className="h-3.5 w-3.5 flex-shrink-0 text-primary/80" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[10.5px] font-bold uppercase tracking-[0.08em] text-foreground/75">{label}</span>
                  <span className="flex-shrink-0 pr-1 text-[10.5px] font-semibold tabular-nums text-muted-foreground" aria-label={`${total} workflows`}>{total}</span>
                </button>
                {onCreateForTrigger && (
                  <button
                    type="button"
                    onClick={() => onCreateForTrigger(triggerType)}
                    aria-label={`Create a workflow for ${label}`}
                    title={`Create a workflow for ${label}`}
                    className="tp-focus-ring flex-shrink-0 rounded p-0.5 text-muted-foreground/75 opacity-0 hover:bg-muted hover:text-foreground group-hover/grp:opacity-100 focus-visible:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="divide-y divide-border/60">
                  {bucket.default && (
                    <IndexRow
                      workflow={bucket.default}
                      selected={selectedId === bucket.default.id}
                      onSelect={onSelect}
                      onToggleEnabled={onToggleEnabled}
                      toggling={togglingId}
                      getDisplayName={getDisplayName}
                      isAfterHours={isAfterHours}
                      onRowAction={onRowAction}
                    />
                  )}
                  {bucket.customs.map((workflow) => (
                    <IndexRow
                      key={workflow.id}
                      workflow={workflow}
                      selected={selectedId === workflow.id}
                      onSelect={onSelect}
                      onToggleEnabled={onToggleEnabled}
                      toggling={togglingId}
                      getDisplayName={getDisplayName}
                      isAfterHours={isAfterHours}
                      onRowAction={onRowAction}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {footer && <div className="flex-shrink-0 border-t border-border/60">{footer}</div>}
    </div>
  );
}
