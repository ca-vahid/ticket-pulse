import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Plus, Search, X } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';

/**
 * Workflow index (QA 07-07 #8) — the redesigned list rail, extracted from
 * NotificationWorkflowsPanel. Zapier/n8n-style rows: inline enable toggle,
 * last-run health with relative time, search-as-you-type, quick filters and
 * a pinned needs-attention strip. Grouping by trigger (with persisted
 * collapse state) carries over from the old list.
 *
 * Naming/visual conventions stay owned by the panel and arrive as props
 * (getDisplayName, getVisuals, eventLabels, isAfterHours) so the two can't
 * drift apart.
 */

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function relativeTime(value) {
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

function runFailed(status) {
  return /(fail|error|bounce|reject|block)/i.test(String(status || ''));
}

function runChipClass(status) {
  if (runFailed(status)) return 'bg-red-50 text-red-700 ring-red-200';
  if (/(complete|success|sent|deliver|ok)/i.test(String(status || ''))) return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  return 'bg-slate-100 text-slate-600 ring-slate-200';
}

function loadCollapsed(storageKey) {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function groupByTrigger(workflows) {
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
  return groups;
}

function IndexRow({
  workflow, selected, nested, onSelect, onToggleEnabled, toggling,
  getDisplayName, isAfterHours,
}) {
  const isEnabled = !!workflow.isEnabled;
  const isArchived = Boolean(workflow.archivedAt);
  const lastRun = workflow.runs?.[0];
  const failed = lastRun && runFailed(lastRun.status);
  const runs = workflow._count?.runs || 0;
  const version = workflow.publishedVersion || 0;

  // QA 08-02 (Susan): rows were hard to tell apart — each workflow is now a
  // clearly bounded card. The colored left edge keeps the enabled/failed/
  // archived state read; selection promotes to a full blue border.
  return (
    <div
      className={cx(
        'group relative flex w-full items-center gap-2 rounded-lg px-3 py-2.5 transition-[border-color,box-shadow,background-color]',
        nested && 'ml-3',
        selected
          ? 'z-[1] border-2 border-blue-500 bg-blue-50/70 shadow-subtle'
          : cx(
            'border border-l-4 border-slate-200 hover:border-slate-300 hover:shadow-subtle',
            isArchived
              ? 'border-l-slate-300 bg-slate-100'
              : failed && isEnabled
                ? 'border-l-red-400 bg-white hover:bg-red-50/40'
                : isEnabled
                  ? 'border-l-emerald-400 bg-white'
                  : 'border-l-slate-300 bg-slate-50',
          ),
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(workflow.id)}
        aria-current={selected ? 'true' : undefined}
        className="min-w-0 flex-1 self-start text-left"
      >
        <span
          className={cx(
            'block text-sm font-semibold leading-5 line-clamp-2',
            isArchived ? 'text-slate-500' : isEnabled ? 'text-slate-800' : 'text-slate-600',
          )}
          title={workflow.name}
        >
          {getDisplayName(workflow)}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {workflow.isDefaultVariant ? (
            <span className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 ring-1 ring-blue-200">Default</span>
          ) : workflow.triggerType === 'manual' ? (
            <span className="inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">Sub-workflow</span>
          ) : (
            <span className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">Variant</span>
          )}
          {isAfterHours(workflow) && (
            <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">After-hours</span>
          )}
          {version > 0
            ? <span className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">v{version}</span>
            : <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">Draft</span>}
          {isArchived && (
            <span
              className="inline-flex items-center rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-300"
              title={`Archived ${new Date(workflow.archivedAt).toLocaleString()}`}
            >
              archived · {new Date(workflow.archivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
          {lastRun ? (
            <span
              className={cx('inline-flex max-w-[11rem] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1', runChipClass(lastRun.status))}
              title={`Last run: ${lastRun.status} · ${new Date(lastRun.startedAt).toLocaleString()} · ${runs} total`}
            >
              {failed && <AlertTriangle className="h-2.5 w-2.5 shrink-0" />}
              <span className="truncate">{failed ? 'failed' : lastRun.status} · {relativeTime(lastRun.startedAt)}</span>
            </span>
          ) : (
            <span className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">no runs</span>
          )}
        </span>
      </button>

      {/* Inline enable toggle — flipping a workflow on/off shouldn't require
          opening it. Drafts can't enable (nothing published to run). */}
      {!isArchived && (
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${getDisplayName(workflow)}`}
          disabled={toggling === workflow.id || (!isEnabled && version === 0)}
          title={!isEnabled && version === 0 ? 'Publish the workflow before enabling it' : isEnabled ? 'Disable' : 'Enable'}
          onClick={(e) => { e.stopPropagation(); onToggleEnabled(workflow); }}
          className={cx(
            'relative h-5 w-9 shrink-0 self-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            isEnabled ? 'border-emerald-300 bg-emerald-500' : 'border-slate-300 bg-slate-200',
          )}
        >
          {toggling === workflow.id ? (
            <Loader2 className="absolute inset-0 m-auto h-3 w-3 animate-spin text-white" />
          ) : (
            <span
              className={cx(
                'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all',
                isEnabled ? 'left-[18px]' : 'left-0.5',
              )}
            />
          )}
        </button>
      )}
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
  getDisplayName,
  getVisuals,
  eventLabels,
  isAfterHours,
}) {
  const { currentWorkspace } = useWorkspace();
  const storageKey = `tp_wf_collapsed_${currentWorkspace?.id ?? 'all'}`;
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storageKey));
  const [query, setQuery] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [failingOnly, setFailingOnly] = useState(false);

  useEffect(() => {
    setCollapsed(loadCollapsed(storageKey));
  }, [storageKey]);

  const persist = (nextSet) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...nextSet]));
    } catch { /* collapse still works for the session */ }
  };
  const toggleGroup = (triggerType) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(triggerType)) next.delete(triggerType);
      else next.add(triggerType);
      persist(next);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (enabledOnly && !workflow.isEnabled) return false;
      if (failingOnly && !(workflow.runs?.[0] && runFailed(workflow.runs[0].status))) return false;
      if (!q) return true;
      return getDisplayName(workflow).toLowerCase().includes(q)
        || String(workflow.name || '').toLowerCase().includes(q)
        || String(eventLabels[workflow.triggerType] || workflow.triggerType || '').toLowerCase().includes(q);
    });
  }, [workflows, query, enabledOnly, failingOnly, getDisplayName, eventLabels]);

  // Enabled workflows whose last run failed bubble to a pinned strip —
  // failures shouldn't hide inside a collapsed group.
  const needsAttention = useMemo(
    () => workflows.filter((w) => w.isEnabled && !w.archivedAt && w.runs?.[0] && runFailed(w.runs[0].status)),
    [workflows],
  );

  const groups = groupByTrigger(filtered);
  const filtering = Boolean(query.trim()) || enabledOnly || failingOnly;
  // Collapse state is judged (and toggled) against EVERY trigger group, not
  // just the ones surviving the current filter — otherwise the button label
  // flip-flops as filters change and "Collapse all" looks broken.
  const allTriggerTypes = useMemo(
    () => [...new Set(workflows.map((w) => w.triggerType || 'other'))],
    [workflows],
  );
  const allCollapsed = allTriggerTypes.length > 0 && allTriggerTypes.every((type) => collapsed.has(type));
  // A typed search auto-expands so matches are visible; the chip filters keep
  // manual collapse intact.
  const searching = Boolean(query.trim());

  return (
    <div>
      {/* Search + quick filters */}
      <div className="sticky top-0 z-20 space-y-1.5 border-b border-slate-100 bg-white/95 px-2.5 py-2 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search workflows"
            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-7 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={enabledOnly}
            onClick={() => setEnabledOnly((v) => !v)}
            className={cx(
              'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
              enabledOnly ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:border-emerald-200',
            )}
          >
            Enabled
          </button>
          <button
            type="button"
            aria-pressed={failingOnly}
            onClick={() => setFailingOnly((v) => !v)}
            className={cx(
              'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
              failingOnly ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-200 text-slate-500 hover:border-red-200',
            )}
          >
            Failing{needsAttention.length > 0 ? ` (${needsAttention.length})` : ''}
          </button>
          {!searching && (
            <button
              type="button"
              onClick={() => {
                const next = allCollapsed ? new Set() : new Set(allTriggerTypes);
                persist(next);
                setCollapsed(next);
              }}
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50"
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
      </div>

      {/* Needs attention — pinned above the groups */}
      {needsAttention.length > 0 && !failingOnly && (
        <div className="border-b border-red-100 bg-red-50/60 px-2.5 py-1.5">
          <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-red-600">
            <AlertTriangle className="h-3 w-3" /> Needs attention
          </p>
          {needsAttention.slice(0, 3).map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => onSelect(workflow.id)}
              className="mt-1 flex w-full items-center gap-1.5 rounded-md bg-white/80 px-2 py-1 text-left text-xs text-slate-700 ring-1 ring-red-100 hover:bg-white"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{getDisplayName(workflow)}</span>
              <span className="shrink-0 text-[10px] text-red-500">{relativeTime(workflow.runs[0].startedAt)}</span>
            </button>
          ))}
          {needsAttention.length > 3 && (
            <button
              type="button"
              onClick={() => setFailingOnly(true)}
              className="mt-1 text-[10px] font-semibold text-red-600 hover:underline"
            >
              +{needsAttention.length - 3} more failing
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="px-3 py-8 text-center text-xs leading-5 text-slate-500">
          {filtering
            ? 'Nothing matches — clear the search or filters.'
            : 'No workflows yet. Use “New workflow” above to start from a trigger or a template.'}
        </div>
      )}

      <div className="divide-y divide-slate-200">
        {[...groups.entries()].map(([triggerType, bucket]) => {
          const total = (bucket.default ? 1 : 0) + bucket.customs.length;
          const GroupIcon = getVisuals(triggerType).icon;
          const isCollapsed = collapsed.has(triggerType) && !searching;
          // Slate wash behind each group so the white bordered cards pop.
          return (
            <section key={triggerType} className="bg-slate-50/80">
              <div className="sticky top-[76px] z-10 flex w-full items-center border-y border-l-4 border-indigo-100 border-l-indigo-500 bg-indigo-50 transition-colors hover:bg-indigo-100/70">
                <button
                  type="button"
                  onClick={() => toggleGroup(triggerType)}
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                >
                  <ChevronDown className={cx('h-4 w-4 shrink-0 text-indigo-400 transition-transform', isCollapsed && '-rotate-90')} />
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white text-indigo-600 ring-1 ring-indigo-200">
                    <GroupIcon className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold uppercase tracking-wide text-indigo-800">{eventLabels[triggerType] || triggerType}</span>
                  <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 ring-1 ring-indigo-200">{total}</span>
                </button>
                {onCreateForTrigger && (
                  <button
                    type="button"
                    onClick={() => onCreateForTrigger(triggerType)}
                    aria-label={`Create a workflow for ${eventLabels[triggerType] || triggerType}`}
                    title={`Create a workflow for ${eventLabels[triggerType] || triggerType}`}
                    className="mr-2 shrink-0 rounded-md p-1 text-indigo-400 opacity-0 transition-opacity hover:bg-white hover:text-indigo-700 focus:opacity-100 group-hover:opacity-100 [.group:hover_&]:opacity-100 hover:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* gap-1.5 between the bounded cards so each workflow reads as
                  its own item instead of the rows visually merging. */}
              {!isCollapsed && (
                <div className="flex flex-col gap-1.5 px-2 py-2">
                  {bucket.default && (
                    <IndexRow
                      workflow={bucket.default}
                      selected={selectedId === bucket.default.id}
                      nested={false}
                      onSelect={onSelect}
                      onToggleEnabled={onToggleEnabled}
                      toggling={togglingId}
                      getDisplayName={getDisplayName}
                      isAfterHours={isAfterHours}
                    />
                  )}
                  {bucket.customs.map((workflow) => (
                    <IndexRow
                      key={workflow.id}
                      workflow={workflow}
                      selected={selectedId === workflow.id}
                      nested={Boolean(bucket.default)}
                      onSelect={onSelect}
                      onToggleEnabled={onToggleEnabled}
                      toggling={togglingId}
                      getDisplayName={getDisplayName}
                      isAfterHours={isAfterHours}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
