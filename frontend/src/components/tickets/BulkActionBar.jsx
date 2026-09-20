import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Check, ChevronUp, FolderTree, GitMerge, Loader2, PanelRight, Search, Tag as TagIcon, UserRound, Workflow, X,
} from 'lucide-react';

/**
 * The floating bulk bar for the queue (QA 09-18 #3). Replaces two native
 * <select>s with proper pickers, adds Merge and a Details side panel, and
 * makes tags / category available for a hand-picked page selection — not
 * only for "everything matching this filter".
 *
 * Three states, mutually exclusive: result → confirm → idle (pickers).
 * Everything is a controlled prop; the page owns selection and the calls.
 */

function useOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    const onKey = (e) => { if (e.key === 'Escape') onOutside(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [ref, onOutside, active]);
}

/** A bar button that opens a menu ABOVE the bar (the bar sits at the bottom). */
export function MenuButton({ label, ariaLabel, icon: Icon, options, onPick, searchable = false, disabled = false, title, testId, tone = 'default' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => String(o.label).toLowerCase().includes(needle)) : options;
  }, [options, q]);
  const groups = useMemo(() => {
    const out = new Map();
    for (const o of shown) {
      const g = o.group || '';
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(o);
    }
    return [...out.entries()];
  }, [shown]);
  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel || label}
        title={title}
        data-testid={testId}
        className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          tone === 'accent'
            ? 'text-violet-700 hover:bg-violet-50 dark:text-violet-200 dark:hover:bg-violet-500/15'
            : 'text-foreground/85 hover:bg-muted'
        } ${open ? 'bg-muted' : ''}`}
      >
        {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
        <span>{label}</span>
        <ChevronUp className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? '' : 'rotate-180'}`} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel || label}
          className="absolute bottom-full left-0 z-50 mb-2 w-64 max-w-[90vw] overflow-hidden rounded-xl border border-border bg-card shadow-soft motion-on:animate-scaleIn"
        >
          {searchable && (
            <div className="border-b border-border/60 p-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Type to filter…"
                  aria-label={`Filter ${label.toLowerCase()} options`}
                  className="tp-focus-ring w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-xs text-foreground"
                />
              </div>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto settings-scrollbar py-1">
            {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Nothing matches.</p>}
            {groups.map(([group, items]) => (
              <div key={group || '_'}>
                {group && <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{group}</p>}
                {items.map((o) => (
                  <button
                    key={`${o.group || ''}:${o.value}`}
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onPick(o); }}
                    className="tp-focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground/85 hover:bg-muted"
                  >
                    {o.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${o.dot}`} aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="shrink-0 text-[11px] text-muted-foreground/70">{o.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

export default function BulkActionBar({
  selectedCount = 0,
  editableCount = 0,
  skipCount = 0,
  queryScope = null,
  total = 0,
  pageFullySelected = false,
  onSelectAllMatching,
  onBackToPage,
  technicians = [],
  statuses = [],
  tags = [],
  categories = [],
  canEdit = true,
  onAction,
  mergeBlockedReason = null,
  onMerge,
  onOpenDetails,
  detailsOpen = false,
  onClear,
  bulkAction = null,
  bulkBusy = false,
  onConfirm,
  onCancel,
  bulkResult = null,
  onDismissResult,
}) {
  const scopeCount = queryScope ? queryScope.editable : editableCount;
  const scopeSkipped = queryScope ? queryScope.skippedFsBorn : skipCount;

  const techOptions = useMemo(() => [
    { value: 'unassign', label: 'Unassigned', hint: 'release' },
    ...technicians.map((t) => ({ value: String(t.id), label: t.name })),
  ], [technicians]);
  const statusOptions = useMemo(() => statuses.map((s) => ({ value: s, label: s })), [statuses]);
  const tagOptions = useMemo(() => [
    ...tags.map((t) => ({ value: `add:${t.id}`, label: t.name, group: 'Add tag' })),
    ...tags.map((t) => ({ value: `rm:${t.id}`, label: t.name, group: 'Remove tag' })),
  ], [tags]);
  const categoryOptions = useMemo(() => [
    { value: 'none', label: 'Uncategorized' },
    ...categories.map((c) => ({ value: String(c.id), label: c.name })),
  ], [categories]);

  const verb = bulkAction?.type === 'assign' ? 'Assign' : bulkAction?.type === 'add_tags' ? 'Tag' : bulkAction?.type === 'remove_tags' ? 'Untag' : bulkAction?.type === 'set_category' ? 'Categorize' : 'Set';
  const noun = (n) => `${n} ticket${n === 1 ? '' : 's'}`;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      data-testid="bulk-action-bar"
      className="fixed bottom-6 left-1/2 z-40 w-max max-w-[94vw] -translate-x-1/2 animate-fadeIn rounded-2xl border border-border bg-card/95 shadow-soft backdrop-blur supports-[backdrop-filter]:bg-card/85"
    >
      {bulkResult ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {bulkResult.failed.length === 0
              ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
              : <AlertCircle className="h-4 w-4 text-amber-500" aria-hidden="true" />}
            {bulkResult.ok} updated ({bulkResult.label})
          </span>
          {bulkResult.skipped > 0 && (
            <span className="text-xs text-muted-foreground">{bulkResult.skipped} FS-born skipped (read-only)</span>
          )}
          {bulkResult.failed.length > 0 && (
            <span className="max-w-xs truncate text-xs text-red-600 dark:text-red-300" title={bulkResult.failed.map((f) => `${f.ref}: ${f.message}`).join('\n')}>
              {bulkResult.failed.length} failed — {bulkResult.failed.slice(0, 3).map((f) => f.ref).join(', ')}{bulkResult.failed.length > 3 ? '…' : ''}
            </span>
          )}
          <button onClick={onDismissResult} aria-label="Dismiss result" className="tp-focus-ring rounded-lg p-1 text-muted-foreground/75 hover:bg-muted hover:text-muted-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : bulkAction ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="text-sm text-foreground/85">
            {verb} <strong>{noun(scopeCount)}</strong>{queryScope ? ' (everything matching this filter)' : ''}
            {bulkAction.type === 'assign' ? ' to ' : bulkAction.type === 'status' ? ' to ' : ' → '}<strong>{bulkAction.label}</strong>?
            {scopeSkipped > 0 && <span className="text-xs text-muted-foreground/75"> ({scopeSkipped} FS-born skipped)</span>}
          </span>
          <button
            onClick={onConfirm}
            disabled={bulkBusy || scopeCount === 0}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Confirm
          </button>
          <button onClick={onCancel} disabled={bulkBusy} className="tp-focus-ring rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:border-input">
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 sm:gap-1.5 sm:px-3">
          {/* Count block */}
          <div className="mr-1 flex items-center gap-2.5 pl-1 pr-2">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-primary dark:bg-primary/20" aria-hidden="true">
              <Check className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-sm font-semibold text-foreground">
                {queryScope ? `All ${queryScope.total} matching` : `${selectedCount} selected`}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {queryScope
                  ? <button onClick={onBackToPage} className="tp-focus-ring rounded hover:text-foreground">Back to page selection</button>
                  : skipCount > 0
                    ? <span title="FreshService-born tickets are mirrors and stay read-only here">{skipCount} FS-born read-only</span>
                    : pageFullySelected && total > selectedCount
                      ? <button onClick={onSelectAllMatching} className="tp-focus-ring rounded font-semibold text-primary hover:underline">Select all {total} matching</button>
                      : 'Choose an action'}
                {!queryScope && skipCount > 0 && pageFullySelected && total > selectedCount && (
                  <> · <button onClick={onSelectAllMatching} className="tp-focus-ring rounded font-semibold text-primary hover:underline">Select all {total} matching</button></>
                )}
              </span>
            </span>
          </div>
          <span className="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />

          <MenuButton
            label="Assign"
            ariaLabel="Bulk assign"
            icon={UserRound}
            options={techOptions}
            searchable={technicians.length > 6}
            testId="bulk-assign"
            onPick={(o) => onAction({ type: 'assign', value: o.value === 'unassign' ? null : Number(o.value), label: o.label })}
          />
          <MenuButton
            label="Status"
            ariaLabel="Bulk status"
            icon={Workflow}
            options={statusOptions}
            testId="bulk-status"
            onPick={(o) => onAction({ type: 'status', value: o.value, label: o.label })}
          />
          {canEdit && tags.length > 0 && (
            <MenuButton
              label="Tags"
              ariaLabel="Bulk tag"
              icon={TagIcon}
              options={tagOptions}
              searchable={tags.length > 8}
              testId="bulk-tag"
              onPick={(o) => {
                const [op, id] = o.value.split(':');
                onAction({ type: op === 'add' ? 'add_tags' : 'remove_tags', value: [Number(id)], label: `${op === 'add' ? 'tag +' : 'tag −'} ${o.label}` });
              }}
            />
          )}
          {canEdit && categories.length > 0 && (
            <MenuButton
              label="Category"
              ariaLabel="Bulk category"
              icon={FolderTree}
              options={categoryOptions}
              searchable={categories.length > 8}
              testId="bulk-category"
              onPick={(o) => onAction({ type: 'set_category', value: o.value === 'none' ? null : Number(o.value), label: `category → ${o.label}` })}
            />
          )}
          {canEdit && !queryScope && (
            <>
              <span className="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                onClick={onMerge}
                disabled={Boolean(mergeBlockedReason)}
                title={mergeBlockedReason || 'Fold these tickets into one — the oldest Ticket Pulse ticket survives, the rest are closed with a pointer note'}
                aria-label="Merge selected tickets"
                data-testid="bulk-merge"
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-violet-700 transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-violet-200 dark:hover:bg-violet-500/15"
              >
                <GitMerge className="h-4 w-4" aria-hidden="true" />
                Merge
              </button>
            </>
          )}
          {!queryScope && (
            <button
              type="button"
              onClick={onOpenDetails}
              aria-pressed={detailsOpen}
              aria-label="Show the selected tickets"
              title="See what is selected, drop tickets from the selection, and act from there"
              data-testid="bulk-details"
              className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${detailsOpen ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted'}`}
            >
              <PanelRight className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Details</span>
            </button>
          )}
          <button onClick={onClear} aria-label="Clear selection" className="tp-focus-ring ml-0.5 rounded-lg p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-muted-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
