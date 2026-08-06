import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { assignmentAPI } from '../../services/api';
import {
  Activity, Plus, Trash2, Loader2, Search, ChevronDown, ChevronRight, Folder,
  CornerDownRight, Pencil, SlidersHorizontal, Archive, ArchiveRestore, GitMerge,
  Check, X, Sparkles, AlertTriangle,
} from 'lucide-react';

/**
 * Categories management tab — full two-level tree editor for competency
 * categories/subcategories (Assignment Review → Competencies → Categories).
 *
 * Reads the `categoriesDetailed` payload from GET /assignment/competencies
 * (all rows including retired ones, with ticket/tech/child counts) and falls
 * back to the legacy `categories`/`categoryTree` fields when the detailed
 * payload isn't available yet.
 */

const extractApiError = (err) =>
  err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Something went wrong';

const prettySource = (source = '') => String(source).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function sortRows(a, b) {
  const orderA = Number.isFinite(a.sortOrder) ? a.sortOrder : 0;
  const orderB = Number.isFinite(b.sortOrder) ? b.sortOrder : 0;
  if (orderA !== orderB) return orderA - orderB;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

/** Build detailed-shaped rows from the legacy payload so the tree still works pre-upgrade. */
function rowsFromLegacyPayload(payload = {}) {
  const categories = payload.categories || [];
  const parentNameById = new Map(categories.filter((c) => !c.parentId).map((c) => [c.id, c.name]));
  return categories.map((category) => ({
    ...category,
    parentName: category.parentId ? parentNameById.get(category.parentId) || null : null,
    isActive: category.isActive !== false,
    source: category.source || 'manual',
    childCount: categories.filter((c) => c.parentId === category.id).length,
  }));
}

function usePopoverDismiss(open, ref, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, ref, onClose]);
}

// ─── Duplicate Detector ──────────────────────────────────────────────────
// Backend groups are parent-aware since the Categories overhaul: labels
// arrive as "Parent > Sub" and different-parent siblings are never paired.

export function DuplicateDetector({ onMerged }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [merging, setMerging] = useState(null);
  const [msg, setMsg] = useState(null);

  const handleDetect = async () => {
    try {
      setLoading(true);
      const res = await assignmentAPI.detectDuplicateCategories();
      setGroups(res?.data || []);
      setScanned(true);
    } catch (err) {
      console.error('Failed to detect duplicates:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async (keepId, mergeIds, keepLabel) => {
    try {
      setMerging(keepId);
      await assignmentAPI.mergeCategories({ keepId, mergeIds });
      setMsg(`Merged into "${keepLabel}"`);
      setGroups((prev) => prev.filter((g) => g.keepId !== keepId));
      onMerged?.();
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      console.error('Merge failed:', err);
    } finally {
      setMerging(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-2">
        {scanned && groups.length === 0 && <span className="text-xs text-emerald-600">No duplicates found</span>}
        {msg && <span className="text-xs text-emerald-600">{msg}</span>}
        <button
          onClick={handleDetect}
          disabled={loading}
          className="tp-focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
          Detect Duplicates
        </button>
      </div>
      {groups.length > 0 && (
        <div className="mt-3 space-y-2">
          {groups.map((group) => {
            const keepLabel = group.keepLabel || group.keepName;
            return (
              <div key={group.keepId} className="flex items-start justify-between rounded-lg border border-orange-200 bg-orange-50 p-3">
                <div>
                  <p className="text-sm font-medium text-orange-800">Keep: <span className="font-bold">{keepLabel}</span></p>
                  {group.duplicates.map((dup) => (
                    <p key={dup.id} className="text-xs text-orange-700">Merge: {dup.label || dup.name} ({Math.round(dup.score * 100)}%)</p>
                  ))}
                </div>
                <button
                  onClick={() => handleMerge(group.keepId, group.duplicates.map((d) => d.id), keepLabel)}
                  disabled={merging === group.keepId}
                  className="tp-focus-ring flex-shrink-0 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  {merging === group.keepId ? 'Merging...' : 'Merge'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Parent picker (shared with the suggestion review flow) ──────────────

export function ParentCategoryPicker({ value, categories, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  usePopoverDismiss(open, ref, useCallback(() => setOpen(false), []));

  const selected = categories.find((category) => String(category.id) === String(value));
  const filtered = categories.filter((category) => (
    !query.trim() || category.name.toLowerCase().includes(query.trim().toLowerCase())
  ));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery('');
        }}
        className="tp-focus-ring flex h-full min-h-[34px] w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
      >
        <span className="truncate">{selected ? selected.name : 'Top-level category'}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-2 shadow-soft">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter parent categories..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-2 text-xs outline-none focus:border-blue-300 focus:bg-white"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-semibold ${
                !value ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span>Top-level category</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">none</span>
            </button>
            {filtered.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  onChange(String(category.id));
                  setOpen(false);
                }}
                className={`mt-1 flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs ${
                  String(value) === String(category.id) ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="truncate font-medium">{category.name}</span>
                <span className="flex-shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">parent</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-4 text-center text-xs text-slate-400">No matching categories</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small popovers ──────────────────────────────────────────────────────

function RowPopover({ onClose, children, labelledBy }) {
  const ref = useRef(null);
  usePopoverDismiss(true, ref, onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={labelledBy}
      className="absolute right-0 top-full z-40 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-soft"
    >
      {children}
    </div>
  );
}

function ConfirmRetirePopover({ row, busy, onConfirm, onClose }) {
  return (
    <RowPopover onClose={onClose} labelledBy={`retire-title-${row.id}`}>
      <p id={`retire-title-${row.id}`} className="text-xs font-semibold text-slate-800">Retire &ldquo;{row.name}&rdquo;?</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        Tickets keep their history; it can&rsquo;t be chosen for new tickets. You can reactivate it anytime.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="tp-focus-ring flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />} Retire
        </button>
      </div>
    </RowPopover>
  );
}

function EditDetailsPopover({ row, busy, onSave, onClose }) {
  const [description, setDescription] = useState(row.description || '');
  const [sortOrder, setSortOrder] = useState(Number.isFinite(row.sortOrder) ? String(row.sortOrder) : '0');
  return (
    <RowPopover onClose={onClose} labelledBy={`edit-title-${row.id}`}>
      <p id={`edit-title-${row.id}`} className="text-xs font-semibold text-slate-800">Edit &ldquo;{row.name}&rdquo;</p>
      <label className="mt-2 block text-[11px] font-medium text-slate-500" htmlFor={`edit-desc-${row.id}`}>Description</label>
      <textarea
        id={`edit-desc-${row.id}`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="What belongs in this category?"
        className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs outline-none focus:border-blue-300 focus:bg-white"
      />
      <label className="mt-2 block text-[11px] font-medium text-slate-500" htmlFor={`edit-sort-${row.id}`}>Sort order</label>
      <input
        id={`edit-sort-${row.id}`}
        type="number"
        value={sortOrder}
        onChange={(e) => setSortOrder(e.target.value)}
        className="mt-1 w-24 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs outline-none focus:border-blue-300 focus:bg-white"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
        <button
          onClick={() => onSave({ description: description.trim() || null, sortOrder: Number(sortOrder) || 0 })}
          disabled={busy}
          className="tp-focus-ring flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
        </button>
      </div>
    </RowPopover>
  );
}

function MergePickerPopover({ row, candidates, busy, onMerge, onClose }) {
  const [targetId, setTargetId] = useState(null);
  const target = candidates.find((c) => c.id === targetId);
  return (
    <RowPopover onClose={onClose} labelledBy={`merge-title-${row.id}`}>
      <p id={`merge-title-${row.id}`} className="text-xs font-semibold text-slate-800">Merge &ldquo;{row.name}&rdquo; into…</p>
      <p className="mt-1 text-xs text-slate-500">
        Its tickets and technician skills move to the target{row.parentName ? ` (same parent: ${row.parentName})` : ''}, then this one is removed.
      </p>
      {candidates.length === 0 ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-2.5 py-3 text-center text-xs text-slate-400">No same-level candidates to merge into</p>
      ) : (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto" role="listbox" aria-label="Merge target">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={targetId === candidate.id}
              onClick={() => setTargetId(candidate.id)}
              className={`tp-focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
                targetId === candidate.id ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span className="truncate">{candidate.name}</span>
              {Number.isFinite(candidate.ticketCount) && (
                <span className="flex-shrink-0 text-[10px] tabular-nums text-slate-400">{candidate.ticketCount} tickets</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
        <button
          onClick={() => target && onMerge(target)}
          disabled={!target || busy}
          className="tp-focus-ring flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
          {target ? `Merge into "${target.name}"` : 'Merge'}
        </button>
      </div>
    </RowPopover>
  );
}

// ─── Tree row ────────────────────────────────────────────────────────────

function CategoryRow({
  row, depth, effectiveChildCount, hasChildren, expanded, onToggleExpand,
  renaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel, onStartRename,
  popover, onOpenPopover, onClosePopover,
  busy, rowError, onDismissError,
  mergeCandidates,
  onSaveDetails, onRetire, onReactivate, onDelete, onMerge,
}) {
  const isSub = depth > 0;
  const deleteBlocked = effectiveChildCount > 0;
  const sourceChip = row.source && row.source !== 'manual' ? prettySource(row.source) : null;

  return (
    <div className={`relative ${isSub ? 'pl-9' : ''}`}>
      <div
        className={`group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-slate-50/80 focus-within:bg-slate-50/80 ${
          row.isActive ? '' : 'opacity-75'
        }`}
      >
        {/* Expander / indent guide */}
        {isSub ? (
          <CornerDownRight aria-hidden className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-slate-300" />
        ) : hasChildren ? (
          <button
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.name}`}
            className="tp-focus-ring mt-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span aria-hidden className="mt-0.5 h-5 w-5 flex-shrink-0" />
        )}

        {!isSub && <Folder aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500/70" />}

        {/* Name + meta */}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={renameValue}
                aria-label={`New name for ${row.name}`}
                onChange={(e) => onRenameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRenameCommit();
                  if (e.key === 'Escape') onRenameCancel();
                }}
                className="w-full max-w-xs rounded-lg border border-blue-300 bg-white px-2 py-1 text-sm text-slate-800 outline-none ring-2 ring-blue-100"
              />
              <button onClick={onRenameCommit} disabled={busy} aria-label="Save name" className="tp-focus-ring rounded-md p-1 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
              <button onClick={onRenameCancel} aria-label="Cancel rename" className="tp-focus-ring rounded-md p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`truncate text-sm ${isSub ? 'font-medium text-slate-700' : 'font-semibold text-slate-800'} ${row.isActive ? '' : 'text-slate-500'}`}>
                {row.name}
              </span>
              {(Number.isFinite(row.ticketCount) || Number.isFinite(row.techCount)) && (
                <span className="flex-shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium tabular-nums text-slate-500">
                  {row.ticketCount ?? 0} tickets · {row.techCount ?? 0} techs
                </span>
              )}
              {sourceChip && (
                <span className="flex-shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-600">{sourceChip}</span>
              )}
              {row.isSystemSuggested && (
                <span className="flex-shrink-0 items-center gap-0.5 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-600 inline-flex">
                  <Sparkles className="h-2.5 w-2.5" /> AI suggested
                </span>
              )}
              {!row.isActive && (
                <span className="flex-shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Retired</span>
              )}
            </div>
          )}
          {!renaming && row.description && (
            <p className="mt-0.5 truncate text-xs text-slate-400">{row.description}</p>
          )}
          {rowError && (
            <p role="alert" className="mt-1 flex items-start gap-1 text-xs font-medium text-red-600">
              <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>{rowError}</span>
              <button onClick={onDismissError} className="tp-focus-ring ml-1 underline decoration-red-300 hover:text-red-700">Dismiss</button>
            </p>
          )}
        </div>

        {/* Actions — revealed on hover/focus (always visible on touch widths) */}
        {!renaming && (
          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            {row.isActive ? (
              <>
                <button onClick={onStartRename} aria-label={`Rename ${row.name}`} title="Rename" className="tp-focus-ring rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('edit')} aria-label={`Edit ${row.name}`} title="Edit description & sort order" className="tp-focus-ring rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('merge')} aria-label={`Merge ${row.name} into another`} title="Merge into…" className="tp-focus-ring rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <GitMerge className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('retire')} aria-label={`Retire ${row.name}`} title="Retire (keep history)" className="tp-focus-ring rounded-md p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600">
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                onClick={onReactivate}
                disabled={busy}
                aria-label={`Reactivate ${row.name}`}
                className="tp-focus-ring flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveRestore className="h-3 w-3" />} Reactivate
              </button>
            )}
            <span title={deleteBlocked ? 'Has subcategories — remove or merge them first' : undefined}>
              <button
                onClick={onDelete}
                disabled={deleteBlocked || busy}
                aria-label={`Delete ${row.name}`}
                title={deleteBlocked ? 'Has subcategories — remove or merge them first' : 'Delete permanently'}
                className="tp-focus-ring rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}
      </div>

      {popover === 'retire' && (
        <ConfirmRetirePopover row={row} busy={busy} onConfirm={onRetire} onClose={onClosePopover} />
      )}
      {popover === 'edit' && (
        <EditDetailsPopover row={row} busy={busy} onSave={onSaveDetails} onClose={onClosePopover} />
      )}
      {popover === 'merge' && (
        <MergePickerPopover row={row} candidates={mergeCandidates} busy={busy} onMerge={onMerge} onClose={onClosePopover} />
      )}
    </div>
  );
}

// ─── Main tab ────────────────────────────────────────────────────────────

export default function CategoriesManagementTab({ showMigrationControls = false, MigrationPanel = null }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [retiredOpen, setRetiredOpen] = useState(false);

  // Per-row interaction state
  const [renaming, setRenaming] = useState(null); // { id, value }
  const [popover, setPopover] = useState(null); // { id, kind }
  const [busyId, setBusyId] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  // Add flow
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [newCatParentId, setNewCatParentId] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const compRes = await assignmentAPI.getCompetencies();
      const payload = compRes?.data || {};
      const detailed = Array.isArray(payload.categoriesDetailed) ? payload.categoriesDetailed : null;
      setRows(detailed && detailed.length ? detailed : rowsFromLegacyPayload(payload));
      setError(null);
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const setRowError = (id, message) => setRowErrors((prev) => ({ ...prev, [id]: message }));
  const clearRowError = (id) => setRowErrors((prev) => {
    const next = { ...prev };
    delete next[id];
    return next;
  });

  /**
   * Optimistically patch local rows, run the API call, then refetch so the
   * Skill Matrix (same payload) stays consistent. Reverts + surfaces an
   * inline row error on failure.
   */
  const runRowAction = async (id, optimisticPatch, apiCall, { keepRenaming = false } = {}) => {
    const previousRows = rows;
    clearRowError(id);
    setBusyId(id);
    if (optimisticPatch) {
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...optimisticPatch } : row)));
    }
    try {
      await apiCall();
      setPopover(null);
      if (!keepRenaming) setRenaming(null);
      await fetchData();
      return true;
    } catch (err) {
      setRows(previousRows);
      setRowError(id, extractApiError(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleRenameCommit = async () => {
    if (!renaming) return;
    const row = rows.find((r) => r.id === renaming.id);
    const nextName = renaming.value.trim();
    if (!row || !nextName || nextName === row.name) {
      setRenaming(null);
      return;
    }
    const ok = await runRowAction(
      row.id,
      { name: nextName },
      () => assignmentAPI.updateCategory(row.id, { name: nextName }),
      { keepRenaming: true },
    );
    if (ok) setRenaming(null);
  };

  const handleSaveDetails = (row, patch) =>
    runRowAction(row.id, patch, () => assignmentAPI.updateCategory(row.id, patch));

  const handleSetActive = (row, isActive) =>
    runRowAction(row.id, { isActive }, () => assignmentAPI.updateCategory(row.id, { isActive }));

  const handleDelete = (row) => {
    if (!window.confirm(`Delete "${row.name}" permanently? Only possible when no tickets reference it — otherwise deactivate or merge.`)) return;
    runRowAction(row.id, null, () => assignmentAPI.deleteCategory(row.id));
  };

  const handleMerge = (row, target) =>
    runRowAction(row.id, null, () => assignmentAPI.mergeCategories({ keepId: target.id, mergeIds: [row.id] }));

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      setAddBusy(true);
      setAddError(null);
      await assignmentAPI.createCategory({
        name: newCatName.trim(),
        description: newCatDesc.trim() || null,
        parentId: newCatParentId ? Number(newCatParentId) : null,
      });
      setNewCatName('');
      setNewCatDesc('');
      setNewCatParentId('');
      await fetchData();
    } catch (err) {
      setAddError(extractApiError(err));
    } finally {
      setAddBusy(false);
    }
  };

  // ── Derived tree ──────────────────────────────────────────────────────
  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      if (!row.parentId) continue;
      if (!map.has(row.parentId)) map.set(row.parentId, []);
      map.get(row.parentId).push(row);
    }
    for (const list of map.values()) list.sort(sortRows);
    return map;
  }, [rows]);

  const activeParents = useMemo(
    () => rows.filter((row) => !row.parentId && row.isActive !== false).sort(sortRows),
    [rows],
  );
  const retiredRows = useMemo(
    () => rows.filter((row) => row.isActive === false).sort(sortRows),
    [rows],
  );

  const activeSubCount = rows.filter((row) => row.parentId && row.isActive !== false).length;
  const normalizedSearch = search.trim().toLowerCase();
  const searching = normalizedSearch.length > 0;

  const matches = (row, parent = null) =>
    `${row.name || ''} ${row.description || ''} ${parent?.name || ''}`.toLowerCase().includes(normalizedSearch);

  const visibleTree = activeParents.flatMap((parent) => {
    const children = (childrenByParent.get(parent.id) || []).filter((child) => child.isActive !== false);
    const parentMatches = !searching || matches(parent);
    const visibleChildren = parentMatches ? children : children.filter((child) => matches(child, parent));
    if (searching && !parentMatches && visibleChildren.length === 0) return [];
    return [{ parent, children, visibleChildren }];
  });

  const effectiveChildCount = (row) =>
    Math.max(Number.isFinite(row.childCount) ? row.childCount : 0, (childrenByParent.get(row.id) || []).length);

  const mergeCandidatesFor = (row) =>
    rows
      .filter((candidate) => (
        candidate.id !== row.id
        && candidate.isActive !== false
        && (candidate.parentId ?? null) === (row.parentId ?? null)
      ))
      .sort(sortRows);

  const toggleExpand = (id) => setCollapsedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const rowProps = (row) => ({
    row,
    renaming: renaming?.id === row.id,
    renameValue: renaming?.id === row.id ? renaming.value : '',
    onRenameChange: (value) => setRenaming({ id: row.id, value }),
    onRenameCommit: handleRenameCommit,
    onRenameCancel: () => { setRenaming(null); clearRowError(row.id); },
    onStartRename: () => { setPopover(null); clearRowError(row.id); setRenaming({ id: row.id, value: row.name }); },
    popover: popover?.id === row.id ? popover.kind : null,
    onOpenPopover: (kind) => { setRenaming(null); clearRowError(row.id); setPopover({ id: row.id, kind }); },
    onClosePopover: () => setPopover(null),
    busy: busyId === row.id,
    rowError: rowErrors[row.id] || null,
    onDismissError: () => clearRowError(row.id),
    mergeCandidates: mergeCandidatesFor(row),
    onSaveDetails: (patch) => handleSaveDetails(row, patch),
    onRetire: () => handleSetActive(row, false),
    onReactivate: () => handleSetActive(row, true),
    onDelete: () => handleDelete(row),
    onMerge: (target) => handleMerge(row, target),
    effectiveChildCount: effectiveChildCount(row),
  });

  if (loading) {
    return (
      <div className="flex justify-center p-8" role="status" aria-label="Loading categories">
        <Activity className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error} <button onClick={() => { setError(null); setLoading(true); fetchData(); }} className="ml-2 underline">Retry</button>
        </div>
      )}

      {showMigrationControls && MigrationPanel && <MigrationPanel onPublished={fetchData} />}

      <div className="tp-card p-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Categories &amp; subcategories</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {activeParents.length} categor{activeParents.length === 1 ? 'y' : 'ies'} · {activeSubCount} subcategor{activeSubCount === 1 ? 'y' : 'ies'} · {retiredRows.length} retired
            </p>
          </div>
          <DuplicateDetector onMerged={fetchData} />
        </div>

        {/* Search */}
        <div className="relative mt-3 max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search categories"
            placeholder="Search categories…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-blue-300 focus:bg-white"
          />
        </div>

        {/* Tree */}
        <div className="mt-3">
          {activeParents.length === 0 && retiredRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 py-10 text-center">
              <Folder aria-hidden className="h-6 w-6 text-slate-300" />
              <p className="text-sm font-medium text-slate-600">No categories yet</p>
              <p className="max-w-xs text-xs text-slate-400">Add your first category below — subcategories can be nested under it once it exists.</p>
            </div>
          ) : visibleTree.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">
              No categories match &ldquo;{search.trim()}&rdquo;
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {visibleTree.map(({ parent, children, visibleChildren }) => {
                const expanded = searching || !collapsedIds.has(parent.id);
                return (
                  <div key={parent.id} className="py-0.5">
                    <CategoryRow
                      {...rowProps(parent)}
                      depth={0}
                      hasChildren={children.length > 0}
                      expanded={expanded}
                      onToggleExpand={() => toggleExpand(parent.id)}
                    />
                    {expanded && visibleChildren.map((child) => (
                      <CategoryRow key={child.id} {...rowProps(child)} depth={1} hasChildren={false} expanded={false} onToggleExpand={() => {}} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Retired */}
        {retiredRows.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60">
            <button
              onClick={() => setRetiredOpen((prev) => !prev)}
              aria-expanded={retiredOpen}
              className="tp-focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-slate-600 hover:bg-slate-100/70"
            >
              {retiredOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
              <Archive aria-hidden className="h-3.5 w-3.5 text-slate-400" />
              Retired ({retiredRows.length})
            </button>
            {retiredOpen && (
              <div className="border-t border-slate-200 px-2 py-1.5">
                {retiredRows.map((row) => (
                  <CategoryRow
                    key={row.id}
                    {...rowProps(row)}
                    row={{ ...row, name: row.parentName ? `${row.parentName} > ${row.name}` : row.name }}
                    depth={0}
                    hasChildren={false}
                    expanded={false}
                    onToggleExpand={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Add flow */}
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Add category or subcategory</p>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_220px_auto]">
            <input
              type="text"
              value={newCatName}
              onChange={(e) => { setNewCatName(e.target.value); setAddError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCategory(); }}
              aria-label="New category name"
              placeholder="Name"
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-blue-300"
            />
            <input
              type="text"
              value={newCatDesc}
              onChange={(e) => setNewCatDesc(e.target.value)}
              aria-label="New category description"
              placeholder="Description (optional)"
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-blue-300"
            />
            <ParentCategoryPicker value={newCatParentId} categories={activeParents} onChange={setNewCatParentId} />
            <button
              onClick={handleCreateCategory}
              disabled={addBusy || !newCatName.trim()}
              className="tp-focus-ring flex items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {addBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
            </button>
          </div>
          {addError && (
            <p role="alert" className="mt-2 flex items-start gap-1 text-xs font-medium text-red-600">
              <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 flex-shrink-0" /> {addError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
