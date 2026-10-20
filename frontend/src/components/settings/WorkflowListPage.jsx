import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { relativeTime, runFailed, workflowState } from './WorkflowIndex';
import { WORKFLOW_STAGES, groupWorkflowsByStage, listWatchSignals, stageForTrigger } from '../../utils/workflowStages';
import { motionReduced } from '../../utils/motionPreference';

/**
 * Mail Workflows, the list page.
 *
 * QA 09-29 #2 (30 Sep 2026): the page opens on a full-width list of every
 * workflow; opening one takes the whole page for its editor and "All
 * workflows" comes back here.
 *
 * QA 10-19 #2/#4 (19 Oct 2026): the list is grouped by ticket lifecycle stage
 * (utils/workflowStages.js — the Audit picker uses the same map), then by
 * trigger ("When Ticket arrived"), with variants indented under their
 * default. A "Ticket lifecycle" navigation on the left jumps to a trigger and
 * follows the scroll. Filter tabs carry counts.
 *
 * QA 10-19 #3: the "Skip noise tickets" watch signal (noise_check_replaced)
 * is not shown on the list; the workflow's own page still shows it.
 *
 * QA 10-19 #5: every row is a real link (?wf=<id>), so right-click → Open in
 * new tab and Ctrl/⌘-click work; a plain click still opens it in place.
 *
 * Columns: name (+ description), mode (dot + word, never a pill), routing
 * (Default / Routed / Variant / Sub-workflow, + after-hours), version and last
 * run. The enable switch stays on the workflow's own page (QA 09-22 #11).
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

/** "Ticket updated (fields)" → "Ticket updated" for the narrow navigation. */
function shortLabel(label) {
  return String(label || '').replace(/\s*\([^)]*\)\s*$/, '') || String(label || '');
}

/** The default address of a workflow's own page (the panel reads ?wf= on load). */
function workflowHref(id) {
  return `?wf=${encodeURIComponent(id)}`;
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
    // A default is never archived here; one retired by Ticket Ops → When a
    // requester replies can still be restored.
    ...(workflow.isDefaultVariant && !archived ? [] : [{ key: archived ? 'restore' : 'archive', label: archived ? 'Restore' : 'Archive' }]),
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

function ListRow({ workflow, name, href, onOpen, onRowAction, isAfterHours, variant = false, lastVariant = false, last = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const state = workflowState(workflow);
  const lastRun = workflow.runs?.[0];
  const failed = Boolean(lastRun && runFailed(lastRun.status));
  const version = workflow.publishedVersion || 0;
  const muted = state.key === 'off' || state.key === 'draft' || state.key === 'archived';
  const kind = workflowKind(workflow, { isAfterHours });
  const versionText = version > 0 ? `v${version}` : 'draft';
  const runText = lastRun ? `${failed ? 'Failed' : 'Ran'} ${relativeTime(lastRun.startedAt)}` : 'No runs yet';
  const signals = listWatchSignals(workflow);

  // A plain left click stays in the app; modified and middle clicks fall
  // through to the browser so the link opens in a new tab or window.
  const handleClick = (event) => {
    if (!onOpen || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(workflow.id);
  };

  return (
    <li className="group/row relative" data-testid="workflow-list-row" data-state={state.key} data-variant={variant ? 'true' : undefined}>
      {/* The elbow: a variant hangs off its default. */}
      {variant && (
        <>
          <span aria-hidden="true" className={cx('pointer-events-none absolute left-6 top-0 w-2.5 border-l border-border', lastVariant ? 'h-5 rounded-bl-md border-b' : 'h-full')} />
          {!lastVariant && <span aria-hidden="true" className="pointer-events-none absolute left-6 top-5 w-2.5 border-t border-border" />}
        </>
      )}
      <a
        href={href}
        onClick={handleClick}
        className={cx(
          'tp-focus-ring grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2.5 pr-4 text-left transition-colors hover:bg-muted/60 focus-visible:ring-inset focus-visible:ring-offset-0',
          'md:grid-cols-[minmax(0,1fr)_5.5rem_9.5rem_9rem_1rem]',
          variant ? 'pl-11' : 'pl-4',
          last && 'rounded-b-xl',
        )}
      >
        <span className="min-w-0">
          <span className={cx('block truncate text-sm font-semibold', muted ? 'text-muted-foreground' : 'text-foreground')}>{name}</span>
          {workflow.description && <span className="block truncate text-xs text-muted-foreground">{workflow.description}</span>}
          <span className="block truncate text-xs text-muted-foreground/75 md:hidden">{kind} · {versionText} · {runText}</span>
          {/* QA 10-05 #5: workflow watch — say when a workflow quietly stopped doing its job. */}
          {signals.slice(0, 2).map((signal) => (
            <span key={`${signal.code}-${signal.nodeId || ''}`} data-testid="workflow-watch-signal" className="mt-0.5 flex items-start gap-1 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0">{signal.message}</span>
            </span>
          ))}
        </span>
        <span className="flex items-center gap-1.5 self-start pt-0.5 text-xs text-foreground/85 md:self-center md:pt-0">
          <span className={cx('h-2 w-2 flex-shrink-0 rounded-full', state.dot)} aria-hidden="true" />
          {state.label}
        </span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">{kind}</span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">
          <span className="tabular-nums">{versionText}</span>
          <span aria-hidden="true"> · </span>
          <span className={failed ? 'text-red-700 dark:text-red-300' : undefined}>{runText}</span>
        </span>
        <ChevronRight className="hidden h-4 w-4 text-muted-foreground/60 md:block" aria-hidden="true" />
      </a>
      {onRowAction && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`More actions for ${name}`}
          className={cx('tp-focus-ring absolute right-9 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/75 hover:bg-muted hover:text-foreground', menuOpen ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {menuOpen && <RowMenu workflow={workflow} name={name} onRowAction={onRowAction} onClose={() => setMenuOpen(false)} />}
    </li>
  );
}

function TriggerCard({ group, cardRef, getVisuals, getDisplayName, getHref, onOpen, onRowAction, onAdd, isAfterHours }) {
  const { triggerType, label, parent, workflows } = group;
  const visuals = getVisuals(triggerType) || {};
  const GroupIcon = visuals.icon;
  const lastVariantId = parent && workflows.length > 1 ? workflows[workflows.length - 1].id : null;
  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-label={label}
      data-testid="workflow-list-group"
      data-trigger={triggerType}
      className="scroll-mt-3 rounded-xl border border-border/70 bg-card outline-none"
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-3" data-testid="workflow-list-group-header">
        {GroupIcon && <GroupIcon className={cx('h-3.5 w-3.5 flex-shrink-0', visuals.icon_ || 'text-primary/80')} aria-hidden="true" />}
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground">When</span>
        <h4 className="min-w-0 truncate text-sm font-semibold text-foreground">{label}</h4>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">{workflows.length}</span>
        {onAdd && (
          <button
            type="button"
            onClick={() => onAdd(triggerType)}
            aria-label={`Add a workflow for ${label}`}
            className="tp-focus-ring ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add
          </button>
        )}
      </div>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {workflows.map((workflow, index) => (
          <ListRow
            key={workflow.id}
            workflow={workflow}
            name={getDisplayName(workflow)}
            href={getHref(workflow.id)}
            onOpen={onOpen}
            onRowAction={onRowAction}
            isAfterHours={isAfterHours}
            variant={Boolean(parent) && workflow !== parent}
            lastVariant={workflow.id === lastVariantId}
            last={index === workflows.length - 1}
          />
        ))}
      </ul>
    </section>
  );
}

function LifecycleNav({ stages, activeTrigger, onJump }) {
  const byKey = new Map(stages.map((entry) => [entry.stage.key, entry]));
  return (
    <nav aria-label="Ticket lifecycle" className="rounded-xl border border-border/70 bg-card p-3" data-testid="workflow-lifecycle-nav">
      <p className="text-sm font-semibold text-foreground">Ticket lifecycle</p>
      <p className="mt-0.5 text-xs leading-4 text-muted-foreground">Jump to workflows by the stage that triggers them</p>
      <ol className="mt-3 space-y-3">
        {WORKFLOW_STAGES.map((stage) => {
          const entry = byKey.get(stage.key);
          if (!entry && stage.key === 'other') return null;
          return (
            <li key={stage.key} data-testid="workflow-lifecycle-stage" data-stage={stage.key}>
              <p className={cx('flex items-baseline gap-2 px-2 text-xs', entry ? 'text-foreground/85' : 'text-muted-foreground/60')}>
                <span className="tabular-nums font-semibold text-muted-foreground/75">{stage.number}</span>
                <span className="font-semibold uppercase tracking-[0.06em]">{stage.label}</span>
              </p>
              {entry && (
                <ul className="mt-1 space-y-px">
                  {entry.triggers.map((group) => {
                    const active = activeTrigger === group.triggerType;
                    const warnings = group.workflows.filter((w) => listWatchSignals(w).length > 0).length;
                    return (
                      <li key={group.triggerType}>
                        <button
                          type="button"
                          onClick={() => onJump(group.triggerType)}
                          aria-current={active ? 'true' : undefined}
                          title={group.label}
                          className={cx(
                            'tp-focus-ring flex w-full items-center gap-2 rounded-md py-1 pl-7 pr-2 text-left text-[13px] transition-colors',
                            active ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground/85 hover:bg-muted',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{shortLabel(group.label)}</span>
                          {warnings > 0 && (
                            <>
                              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-500" aria-hidden="true" data-testid="workflow-lifecycle-warning" />
                              <span className="sr-only">, {warnings} with warnings,</span>
                            </>
                          )}
                          <span className={cx('text-xs tabular-nums', active ? 'text-primary' : 'text-muted-foreground')}>{group.count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
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
  getHref = workflowHref,
  eventLabels = {},
  isAfterHours = () => false,
  showArchived = false,
  archivedCount = null,
  onShowArchivedChange,
  stats = null,
  actions = null,
  footer = null,
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  // Archived is the parent's state when it manages it (it keeps the selection
  // in step); otherwise the page keeps it.
  const [localArchived, setLocalArchived] = useState(false);
  const archivedOn = onShowArchivedChange ? showArchived : localArchived;
  const setArchivedOn = (next) => (onShowArchivedChange ? onShowArchivedChange(next) : setLocalArchived(next));

  const active = useMemo(() => workflows.filter((w) => !w.archivedAt), [workflows]);
  const archived = useMemo(() => workflows.filter((w) => w.archivedAt), [workflows]);
  const archivedTotal = archived.length || archivedCount || 0;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, active.filter((w) => matchesFilter(w, f.key)).length])), [active]);
  const enabledCount = useMemo(() => active.filter((w) => w.isEnabled).length, [active]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (archivedOn ? archived : active).filter((w) => (
    (archivedOn || matchesFilter(w, filter))
    && (!q || [getDisplayName(w), w.name, w.description, eventLabels[w.triggerType], stageForTrigger(w.triggerType).label]
      .filter(Boolean).join(' ').toLowerCase().includes(q))
  )), [active, archived, archivedOn, filter, q, getDisplayName, eventLabels]);
  const stages = useMemo(() => groupWorkflowsByStage(shown, eventLabels), [shown, eventLabels]);
  const order = useMemo(() => stages.flatMap((entry) => entry.triggers.map((t) => t.triggerType)), [stages]);

  // ---- scroll-spy: the navigation follows the list ----
  const scrollRef = useRef(null);
  const cardRefs = useRef(new Map());
  const pinnedUntil = useRef(0);
  const [activeTrigger, setActiveTrigger] = useState(null);
  const updateActive = useCallback(() => {
    if (Date.now() < pinnedUntil.current) return;
    const root = scrollRef.current;
    if (!root || order.length === 0) { setActiveTrigger(null); return; }
    const top = root.getBoundingClientRect().top;
    let current = order[0];
    for (const key of order) {
      const el = cardRefs.current.get(key);
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= 72) current = key;
      else break;
    }
    if (root.scrollHeight > root.clientHeight && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = order[order.length - 1];
    setActiveTrigger(current);
  }, [order]);
  useEffect(() => { updateActive(); }, [updateActive]);

  const jumpTo = (triggerType) => {
    const el = cardRefs.current.get(triggerType);
    setActiveTrigger(triggerType);
    pinnedUntil.current = Date.now() + 900;
    if (!el) return;
    el.scrollIntoView?.({ block: 'start', behavior: motionReduced() ? 'auto' : 'smooth' });
    try { el.focus({ preventScroll: true }); } catch { /* focus is a nicety */ }
  };

  const onAdd = (onCreateForTrigger || onCreate)
    ? (triggerType) => (onCreateForTrigger && triggerType !== 'other' ? onCreateForTrigger(triggerType) : onCreate?.())
    : null;

  const auditRuns = stats ? (stats.workflowAuditRuns7d ?? stats.mockRuns7d ?? null) : null;
  const statsLine = [
    `${enabledCount} enabled`,
    stats && stats.failedEmailDeliveries24h != null ? `${stats.failedEmailDeliveries24h} failed e-mails in 24h` : null,
    auditRuns != null ? `${auditRuns} audit runs in 7d` : null,
  ].filter(Boolean);

  const tabClass = (on) => cx(
    'tp-focus-ring inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-sm border-b-2 pb-1 font-semibold',
    on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row" data-testid="workflow-list-page">
      <aside className="order-last flex flex-shrink-0 flex-col lg:order-first lg:w-64 lg:border-r lg:border-border/70 xl:w-72">
        <div className="settings-scrollbar hidden min-h-0 flex-1 overflow-y-auto p-3 lg:block">
          <LifecycleNav stages={stages} activeTrigger={activeTrigger} onJump={jumpTo} />
        </div>
        {footer && <div className="flex-shrink-0 border-t border-border/60 lg:border-t-0 lg:px-1 lg:pb-2">{footer}</div>}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex-shrink-0 space-y-3 border-b border-border px-4 pb-2.5 pt-4 sm:px-5">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-foreground">
                Workflows <span className="ml-1 text-sm font-medium tabular-nums text-muted-foreground">{active.length}</span>
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="workflow-list-stats">{statsLine.join(' · ')}</p>
            </div>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {actions}
              {onCreate && (
                <button type="button" onClick={onCreate} className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                  <Plus className="h-4 w-4" aria-hidden="true" /> New workflow
                </button>
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="settings-scrollbar -mx-1 flex max-w-full items-center gap-4 overflow-x-auto px-1 pt-1 text-[13px]" role="group" aria-label="Filter workflows">
              {FILTERS.map((f) => {
                const on = filter === f.key && !archivedOn;
                const failing = f.key === 'failing' && counts.failing > 0;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => { setFilter(f.key); setArchivedOn(false); }}
                    className={tabClass(on)}
                  >
                    {f.label}
                    <span className={cx('text-xs font-medium tabular-nums', failing ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>{counts[f.key]}</span>
                  </button>
                );
              })}
              <button type="button" aria-pressed={archivedOn} onClick={() => setArchivedOn(!archivedOn)} className={tabClass(archivedOn)}>
                Archived
                <span className="text-xs font-medium tabular-nums text-muted-foreground">{archivedTotal}</span>
              </button>
            </div>
            <div className="relative w-full pb-1 sm:ml-auto sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-[calc(50%-2px)] h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name or trigger"
                aria-label="Filter by name or trigger"
                className="tp-focus-ring h-8 w-full rounded-md border border-border bg-card pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground/75"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear filter" className="tp-focus-ring absolute right-2 top-[calc(50%-2px)] -translate-y-1/2 rounded p-0.5 text-muted-foreground/75 hover:text-foreground">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </header>

        <div ref={scrollRef} onScroll={updateActive} className="settings-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-10 sm:px-5" data-testid="workflow-list-scroll">
          {stages.length === 0 && (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {q || filter !== 'all' || archivedOn ? 'No workflows match.' : 'No workflows yet. Start with New workflow or a template.'}
            </p>
          )}
          {stages.map(({ stage, triggers }) => (
            <section key={stage.key} aria-labelledby={`wf-stage-${stage.key}`} data-testid="workflow-stage" data-stage={stage.key} className="pt-5">
              <h3 id={`wf-stage-${stage.key}`} className="flex flex-wrap items-baseline gap-x-2 px-1 text-sm">
                <span className="text-xs font-semibold tabular-nums text-muted-foreground/75">{stage.number}</span>
                <span className="font-semibold text-foreground">{stage.label}</span>
                <span className="text-muted-foreground">— {stage.blurb}</span>
              </h3>
              <div className="mt-2 space-y-3">
                {triggers.map((group) => (
                  <TriggerCard
                    key={group.triggerType}
                    group={group}
                    cardRef={(el) => { if (el) cardRefs.current.set(group.triggerType, el); else cardRefs.current.delete(group.triggerType); }}
                    getVisuals={getVisuals}
                    getDisplayName={getDisplayName}
                    getHref={getHref}
                    onOpen={onOpen}
                    onRowAction={onRowAction}
                    onAdd={onAdd}
                    isAfterHours={isAfterHours}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
