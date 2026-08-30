import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { assignmentAPI } from '../../services/api';
import {
  Activity, Plus, Trash2, Loader2, Search, ChevronDown, ChevronRight, Folder,
  CornerDownRight, Pencil, SlidersHorizontal, Archive, ArchiveRestore, GitMerge,
  Check, X, Sparkles, AlertTriangle, Brain, CheckSquare, Database, Download,
  FileText, Gauge, HelpCircle, RotateCcw, ShieldCheck, Upload, Zap,
} from 'lucide-react';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

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

// ─── Migration-era tools, relocated (Phase 3 surface unification) ────────
// The old "Categories / Subcategories Draft" editor (SkillsMigrationPanel) is
// retired: the tree below is the single editor. The tools that survive all
// operate on the LIVE tree and are flag-gated per workspace (Phase PA split):
// - showMigrationControls (FS_TAXONOMY_SYNC set): FS drift check + FS
//   additive sync + legacy-draft cleanup — FreshService-coupled tools.
// - showReclassifyControls (CANONICAL_CATEGORY set): batch ticket
//   reclassification — canonical-taxonomy-only, works with no FS coupling
//   (Project Accounting gets Reclassify without the FS toolbar).

const RECLASSIFICATION_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', detail: 'Default for bulk cleanup. Lower cost and fast enough for category matching.' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', detail: 'Use only for spot checks or difficult tickets where reasoning quality matters more than cost.' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', detail: 'Previous-generation Sonnet; kept for comparison runs.' },
];

const RECLASSIFICATION_CONCURRENCY_OPTIONS = [5, 10, 20];
const RECLASSIFICATION_BATCH_OPTIONS = [25, 50, 100, 200, 250, 500, 1000, 1500, 2500];
const SERVER_RECLASSIFICATION_BATCH_SIZE = 500;
const APPLY_PREVIEW_CHUNK_SIZE = 75;
const DISPLAY_RECLASSIFICATION_RESULTS_LIMIT = 500;

function mergeReclassificationResults(existing = [], incoming = []) {
  const byTicketId = new Map();
  [...existing, ...incoming].forEach((result) => {
    const ticketId = Number(result?.ticketId);
    if (Number.isInteger(ticketId)) byTicketId.set(ticketId, result);
  });
  return [...byTicketId.values()];
}

function chunkArray(items = [], size = 75) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getOldestCreatedAt(results = []) {
  return results
    .map((result) => result.createdAt)
    .filter(Boolean)
    .sort()[0] || null;
}

function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function ConfirmDialog({ open, title, body, confirmLabel, tone = 'blue', busy = false, onConfirm, onCancel }) {
  if (!open) return null;
  const toneClass = tone === 'amber' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 dark:bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-2xl">
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`tp-focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${toneClass}`}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Updated "?" help — no draft/publish/mapping steps anymore. */
function HierarchyToolsHelpModal({ onClose }) {
  const controls = [
    {
      icon: FileText,
      title: 'Check drift',
      tone: 'text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/15 border-amber-100 dark:border-amber-500/20',
      body: 'Compares the live Ticket Pulse category tree against Freshservice lookup object records. Missing means Freshservice lacks a value Ticket Pulse expects. Extra means Freshservice has a value Ticket Pulse no longer uses.',
      safety: 'Read-only check. Safe to press any time.',
    },
    {
      icon: Upload,
      title: 'Sync to FreshService',
      tone: 'text-indigo-700 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-500/15 border-indigo-100 dark:border-indigo-500/20',
      body: 'Creates any missing Freshservice custom object records for the live categories and subcategories, and repairs subcategory parent links. Extra records are only reported by drift.',
      safety: 'Create-and-repair only. It never deletes, never edits ticket history, and never assigns tickets.',
    },
    {
      icon: Brain,
      title: 'Dry Run Batch',
      tone: 'text-purple-700 dark:text-purple-200 bg-purple-50 dark:bg-purple-500/15 border-purple-100 dark:border-purple-500/20',
      body: 'Selects the next unclassified or review-needed IT tickets and asks the selected LLM model to map each ticket to the live Ticket Pulse category/subcategory list. It returns a preview.',
      safety: 'No ticket fields are saved. No Freshservice ticket is modified.',
    },
    {
      icon: ChevronRight,
      title: 'Next Batch',
      tone: 'text-cyan-700 dark:text-cyan-200 bg-cyan-50 dark:bg-cyan-500/15 border-cyan-100 dark:border-cyan-500/20',
      body: 'Moves the dry-run cursor older than the last preview and analyzes the next set of matching tickets. The new results are added to the pending preview queue.',
      safety: 'Dry-run only. It does not save classifications until Apply Preview is pressed.',
    },
    {
      icon: CheckSquare,
      title: 'Apply Preview',
      tone: 'text-orange-700 dark:text-orange-200 bg-orange-50 dark:bg-orange-500/15 border-orange-100 dark:border-orange-500/20',
      body: 'Saves the accumulated pending preview queue to Ticket Pulse local fields. This is what makes those tickets usable as canonical category/subcategory evidence.',
      safety: 'Ticket Pulse local fields only. It does not write historical category changes back to Freshservice.',
    },
    {
      icon: RotateCcw,
      title: 'Rollback',
      tone: 'text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-500/15 border-red-100 dark:border-red-500/20',
      body: 'Restores the saved pre-run Ticket Pulse category fields for an applied reclassification run.',
      safety: 'Only available for completed apply runs that have not already been rolled back.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 dark:bg-black/70 px-4 py-8">
      <div className="w-full max-w-5xl rounded-xl bg-card shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-card px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-foreground">Category Tools</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The tree on this tab is the single category editor. These tools keep the Freshservice mirror and local ticket classifications in step with it.
            </p>
          </div>
          <button type="button" onClick={onClose} className="tp-focus-ring rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted/50" aria-label="Close help">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-emerald-100 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/15 p-4">
              <ShieldCheck className="h-6 w-6 text-emerald-700 dark:text-emerald-200" />
              <p className="mt-2 text-sm font-bold text-emerald-900 dark:text-emerald-200">Safe boundary</p>
              <p className="mt-1 text-xs leading-5 text-emerald-800 dark:text-emerald-200">Sync only creates or repairs Freshservice lookup records — it never deletes. Reclassification updates Ticket Pulse local category fields only; historical Freshservice tickets are not rewritten, and apply runs can be rolled back.</p>
            </div>
            <div className="rounded-lg border border-purple-100 dark:border-purple-500/20 bg-purple-50 dark:bg-purple-500/15 p-4">
              <Gauge className="h-6 w-6 text-purple-700 dark:text-purple-200" />
              <p className="mt-2 text-sm font-bold text-purple-900 dark:text-purple-200">Batch vs parallel</p>
              <p className="mt-1 text-xs leading-5 text-purple-800 dark:text-purple-200">Batch size is how many tickets are selected. Parallel is how many LLM calls run at the same time. Larger batches cost more because every dry-run ticket is one LLM classification.</p>
            </div>
            <div className="rounded-lg border border-blue-100 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/15 p-4">
              <Zap className="h-6 w-6 text-blue-700 dark:text-blue-200" />
              <p className="mt-2 text-sm font-bold text-blue-900 dark:text-blue-200">Default model</p>
              <p className="mt-1 text-xs leading-5 text-blue-800 dark:text-blue-200">Bulk reclassification defaults to Haiku 4.5. Sonnet is available only when you intentionally choose the higher-cost option.</p>
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <div className="grid grid-cols-4 border-b border-border bg-muted/50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              <span>Flow</span>
              <span className="col-span-3">What happens</span>
            </div>
            <div className="grid grid-cols-4 gap-3 px-4 py-4 text-sm">
              <div className="font-semibold text-foreground">1. Edit the tree</div>
              <div className="col-span-3 text-muted-foreground">Rename, add, retire, merge and reorder categories directly in this tab. Changes are live immediately — there is no draft or publish step anymore.</div>
              <div className="font-semibold text-foreground">2. Check drift</div>
              <div className="col-span-3 text-muted-foreground">After tree edits, run Check drift to compare with Freshservice. It is read-only and safe to run any time.</div>
              <div className="font-semibold text-foreground">3. Sync to FreshService</div>
              <div className="col-span-3 text-muted-foreground">If drift shows missing records or broken parent links, run Sync to FreshService. It creates missing records and repairs parent links; it never deletes.</div>
              <div className="font-semibold text-foreground">4. Classify tickets</div>
              <div className="col-span-3 text-muted-foreground">Run Dry Run Batch, optionally add older tickets with Next Batch, review the pending preview queue, then Apply Preview. Apply Preview saves that queue without asking the LLM again, and completed apply runs can be rolled back.</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {controls.map(({ icon: Icon, title, tone, body, safety }) => (
              <div key={title} className={`rounded-lg border p-4 ${tone}`}>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5" />
                  <p className="text-sm font-bold">{title}</p>
                </div>
                <p className="mt-2 text-xs leading-5">{body}</p>
                <p className="mt-2 rounded-md bg-card/70 px-2 py-1 text-[11px] font-semibold leading-5">{safety}</p>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-blue-100 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/15 p-4">
            <p className="text-sm font-bold text-blue-900 dark:text-blue-200">Which workspaces sync to Freshservice?</p>
            <p className="mt-1 text-xs leading-5 text-blue-800 dark:text-blue-200">
              Freshservice category sync applies only to skill-hierarchy workspaces (currently IT and Accounting). Other workspaces keep a Ticket Pulse-only taxonomy — their Freshservice mirror tickets carry no Ticket Pulse category fields, and these tools are hidden there.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FreshserviceToolsMenu({ busy, onCheckDrift, onSyncRequest }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  usePopoverDismiss(open, ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        className="tp-focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-muted/50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
        FreshService
        <ChevronDown className={`h-3 w-3 text-muted-foreground/75 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" aria-label="FreshService tools" className="absolute right-0 top-full z-40 mt-1 w-72 rounded-xl border border-border bg-card p-1.5 shadow-soft">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onCheckDrift(); }}
            className="tp-focus-ring flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted/50"
          >
            <FileText aria-hidden className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
            <span>
              <span className="block text-xs font-semibold text-foreground">Check drift</span>
              <span className="block text-[10px] text-muted-foreground/75">Read-only compare against FreshService</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onSyncRequest(); }}
            className="tp-focus-ring mt-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted/50"
          >
            <Upload aria-hidden className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-indigo-600 dark:text-indigo-300" />
            <span>
              <span className="block text-xs font-semibold text-foreground">Sync to FreshService</span>
              <span className="block text-[10px] text-muted-foreground/75">Creates missing records; never deletes</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Drift report — rendering moved from the retired SkillsMigrationPanel, plus CSV/text exports. */
function DriftReportSection({ drift, busy, onRefresh, onClose }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <FileText aria-hidden className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" /> Freshservice drift report
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => downloadTextFile('ticket-pulse-categories.csv', drift.exports?.skillCsv || '', 'text/csv')}
            className="tp-focus-ring flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
          >
            <Download className="h-3 w-3" /> Categories CSV
          </button>
          <button
            type="button"
            onClick={() => downloadTextFile('ticket-pulse-subcategories.csv', drift.exports?.subskillCsv || '', 'text/csv')}
            className="tp-focus-ring flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
          >
            <Download className="h-3 w-3" /> Subcategories CSV
          </button>
          <button
            type="button"
            onClick={() => downloadTextFile('ticket-pulse-hierarchy.txt', drift.exports?.hierarchyText || '', 'text/plain')}
            className="tp-focus-ring flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
          >
            <Download className="h-3 w-3" /> Hierarchy text
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="tp-focus-ring rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            Refresh
          </button>
          <button type="button" onClick={onClose} aria-label="Close drift report" className="tp-focus-ring rounded-md p-1 text-muted-foreground/75 hover:bg-card hover:text-muted-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-3 text-xs">
          <p className="font-semibold text-foreground/85">Freshservice lookup object drift</p>
          <p className="mt-1 text-muted-foreground">Category field: {drift.configured?.tpSkillCustomField}; Subcategory field: {drift.configured?.tpSubskillCustomField}</p>
          <p className="mt-1 text-muted-foreground">Object records: {drift.objectRecords?.skills || 0} categories; {drift.objectRecords?.subskills || 0} subcategories</p>
          <p className="mt-2 text-amber-700 dark:text-amber-200">Missing categories: {drift.skillDrift?.missing?.length || 0}; extra categories: {drift.skillDrift?.extra?.length || 0}</p>
          <p className="text-amber-700 dark:text-amber-200">Missing subcategories: {drift.subskillDrift?.missing?.length || 0}; extra subcategories: {drift.subskillDrift?.extra?.length || 0}</p>
          {(drift.subskillParentDrift?.missingParent?.length || drift.subskillParentDrift?.wrongParent?.length) ? (
            <p className="mt-1 text-amber-700 dark:text-amber-200">
              Parent links to repair: {(drift.subskillParentDrift?.missingParent?.length || 0) + (drift.subskillParentDrift?.wrongParent?.length || 0)}
            </p>
          ) : null}
        </div>
        <textarea readOnly aria-label="Hierarchy export" value={drift.exports?.hierarchyText || ''} className="min-h-[140px] rounded-lg border bg-card p-3 font-mono text-xs text-foreground/85" />
      </div>
    </div>
  );
}

/** Batch reclassify UI — state + JSX moved verbatim from the retired
 *  SkillsMigrationPanel; API calls are identical. */
function ReclassifyTicketsSection({ onClose }) {
  const [reclassification, setReclassification] = useState(null);
  const [pendingReclassificationResults, setPendingReclassificationResults] = useState([]);
  const [reclassificationLimit, setReclassificationLimit] = useState(25);
  const [reclassificationModel, setReclassificationModel] = useState(RECLASSIFICATION_MODELS[0].value);
  const [reclassificationConcurrency, setReclassificationConcurrency] = useState(10);
  const [reclassificationCursor, setReclassificationCursor] = useState(null);
  const [reclassificationRuns, setReclassificationRuns] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const loadReclassificationRuns = useCallback(async () => {
    try {
      const res = await assignmentAPI.getReclassificationRuns({ limit: 5 });
      setReclassificationRuns(res?.data || []);
    } catch {
      setReclassificationRuns([]);
    }
  }, []);

  useEffect(() => { loadReclassificationRuns(); }, [loadReclassificationRuns]);

  const reclassificationModelLabel = RECLASSIFICATION_MODELS.find((model) => model.value === reclassificationModel)?.label || reclassificationModel;

  const reclassifyTickets = async ({ apply = false, nextBatch = false } = {}) => {
    const selectedLimit = Number(reclassificationLimit) || 25;
    const serverChunks = chunkArray(Array.from({ length: selectedLimit }), SERVER_RECLASSIFICATION_BATCH_SIZE);
    if (!apply && selectedLimit >= 250 && !confirm(`Dry run up to ${selectedLimit} tickets with ${reclassificationModelLabel} in ${serverChunks.length} server batch${serverChunks.length === 1 ? '' : 'es'}. This sends one LLM classification request per ticket and may take several minutes. Continue?`)) return;
    const previewResults = pendingReclassificationResults
      .filter((result) => result.classification && !result.error)
      .map((result) => ({
        ticketId: Number(result.ticketId),
        freshserviceTicketId: result.freshserviceTicketId,
        model: result.model || reclassification?.model || reclassificationModel,
        classification: result.classification,
      }))
      .filter((result) => Number.isInteger(result.ticketId));
    const pendingCount = previewResults.length;
    const previewChunks = chunkArray(previewResults, APPLY_PREVIEW_CHUNK_SIZE);
    if (apply && !confirm(`Apply ${pendingCount} pending preview classification${pendingCount === 1 ? '' : 's'} to IT tickets in ${previewChunks.length} request${previewChunks.length === 1 ? '' : 's'}? This saves the displayed preview queue to Ticket Pulse without calling the LLM again. Freshservice ticket history is not modified.`)) return;
    try {
      setSaving(true);
      setError(null);
      setMessage(`${apply ? 'Applying preview' : 'Dry run running'} with ${reclassificationModelLabel}, ${reclassificationConcurrency} parallel LLM call${reclassificationConcurrency === 1 ? '' : 's'}...`);

      if (apply) {
        const aggregate = {
          scanned: 0,
          classified: 0,
          reviewNeeded: 0,
          failed: 0,
          results: [],
          runIds: [],
          dryRun: false,
          model: reclassificationModel,
          concurrency: Number(reclassificationConcurrency) || 10,
        };
        let latestRun = null;

        for (const [index, chunk] of previewChunks.entries()) {
          const previewTicketIds = chunk
            .map((result) => Number(result.ticketId))
            .filter(Number.isInteger);
          setMessage(`Applying preview chunk ${index + 1}/${previewChunks.length}: ${chunk.length} tickets. No LLM calls are being made.`);
          const res = await assignmentAPI.reclassifyTickets({
            apply: true,
            days: 180,
            limit: chunk.length,
            model: reclassificationModel,
            concurrency: Number(reclassificationConcurrency) || 10,
            onlyNeedsReview: true,
            unclassifiedOnly: true,
            ticketIds: previewTicketIds,
            previewResults: chunk,
          });
          const data = res?.data || {};
          latestRun = data;
          aggregate.scanned += data.scanned || 0;
          aggregate.classified += data.classified || 0;
          aggregate.reviewNeeded += data.reviewNeeded || 0;
          aggregate.failed += data.failed || 0;
          aggregate.results = mergeReclassificationResults(aggregate.results, data.results || []);
          if (data.id) aggregate.runIds.push(data.id);
          const appliedIds = new Set(previewTicketIds);
          setPendingReclassificationResults((prev) => prev.filter((result) => !appliedIds.has(Number(result.ticketId))));
        }

        const appliedData = {
          ...(latestRun || {}),
          ...aggregate,
          id: latestRun?.id,
          chunkedApply: previewChunks.length > 1,
        };
        setReclassification(appliedData);
        setMessage(`Applied preview in ${previewChunks.length} request${previewChunks.length === 1 ? '' : 's'}: ${aggregate.classified} local Ticket Pulse classifications saved, ${aggregate.reviewNeeded} marked for review, ${aggregate.failed} failed. No Freshservice tickets were modified and no extra LLM calls were made.`);
        await loadReclassificationRuns();
        return;
      }

      if (selectedLimit > SERVER_RECLASSIFICATION_BATCH_SIZE) {
        const aggregate = {
          dryRun: true,
          applied: false,
          scanned: 0,
          classified: 0,
          reviewNeeded: 0,
          failed: 0,
          results: [],
          runIds: [],
          model: reclassificationModel,
          concurrency: Number(reclassificationConcurrency) || 10,
        };
        let localCursor = nextBatch ? reclassificationCursor : null;
        let latestRun = null;
        let remaining = selectedLimit;
        const totalChunks = Math.ceil(selectedLimit / SERVER_RECLASSIFICATION_BATCH_SIZE);

        for (let chunkIndex = 0; chunkIndex < totalChunks && remaining > 0; chunkIndex += 1) {
          const chunkLimit = Math.min(SERVER_RECLASSIFICATION_BATCH_SIZE, remaining);
          setMessage(`Dry run server batch ${chunkIndex + 1}/${totalChunks}: analyzing up to ${chunkLimit} tickets with ${reclassificationModelLabel}, ${reclassificationConcurrency} parallel LLM calls...`);
          const res = await assignmentAPI.reclassifyTickets({
            apply: false,
            days: 180,
            limit: chunkLimit,
            model: reclassificationModel,
            concurrency: Number(reclassificationConcurrency) || 10,
            onlyNeedsReview: true,
            unclassifiedOnly: true,
            ...(localCursor ? { createdBefore: localCursor } : {}),
          });
          const data = res?.data || {};
          latestRun = data;
          aggregate.scanned += data.scanned || 0;
          aggregate.classified += data.classified || 0;
          aggregate.reviewNeeded += data.reviewNeeded || 0;
          aggregate.failed += data.failed || 0;
          aggregate.results = mergeReclassificationResults(aggregate.results, data.results || []);
          if (data.id) aggregate.runIds.push(data.id);
          remaining -= chunkLimit;
          localCursor = getOldestCreatedAt(data.results || []) || localCursor;
          const pendingSoFar = nextBatch
            ? mergeReclassificationResults(pendingReclassificationResults, aggregate.results).length
            : aggregate.results.length;
          setPendingReclassificationResults((prev) => (nextBatch
            ? mergeReclassificationResults(prev, data.results || [])
            : mergeReclassificationResults(aggregate.results, [])));
          setMessage(`Dry run server batch ${chunkIndex + 1}/${totalChunks} complete. Pending preview queue: ${pendingSoFar}.`);
          if ((data.scanned || 0) < chunkLimit) break;
        }

        const aggregateData = {
          ...(latestRun || {}),
          ...aggregate,
          id: latestRun?.id,
          chunkedDryRun: true,
        };
        setReclassification(aggregateData);
        if (localCursor) setReclassificationCursor(localCursor);
        const totalPending = nextBatch
          ? mergeReclassificationResults(pendingReclassificationResults, aggregate.results).length
          : aggregate.results.length;
        setMessage(`Dry run complete with ${reclassificationModelLabel}, ${aggregate.concurrency} parallel: ${aggregate.classified} classified, ${aggregate.reviewNeeded} needing review, ${aggregate.failed} failed across ${aggregate.runIds.length} server batch${aggregate.runIds.length === 1 ? '' : 'es'}. Pending preview queue: ${totalPending}.`);
        await loadReclassificationRuns();
        return;
      }

      const res = await assignmentAPI.reclassifyTickets({
        apply,
        days: 180,
        limit: selectedLimit,
        model: reclassificationModel,
        concurrency: Number(reclassificationConcurrency) || 10,
        onlyNeedsReview: true,
        unclassifiedOnly: true,
        ...(!apply && nextBatch && reclassificationCursor ? { createdBefore: reclassificationCursor } : {}),
      });
      const data = res?.data || {};
      setReclassification(data);
      setPendingReclassificationResults((prev) => (nextBatch
        ? mergeReclassificationResults(prev, data.results || [])
        : (data.results || [])));
      const oldestCreatedAt = getOldestCreatedAt(data.results || []);
      if (!apply && oldestCreatedAt) setReclassificationCursor(oldestCreatedAt);
      const usedModel = RECLASSIFICATION_MODELS.find((model) => model.value === data.model)?.label || data.model || reclassificationModelLabel;
      const totalPending = nextBatch
        ? mergeReclassificationResults(pendingReclassificationResults, data.results || []).length
        : (data.results || []).length;
      setMessage(`Dry run complete with ${usedModel}, ${data.concurrency || reclassificationConcurrency} parallel: ${data.classified || 0} classified, ${data.reviewNeeded || 0} needing review, ${data.failed || 0} failed. Pending preview queue: ${totalPending}.`);
      await loadReclassificationRuns();
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const rollbackReclassificationRun = async (runId) => {
    if (!confirm(`Rollback reclassification run #${runId}? This restores the saved pre-run Ticket Pulse category fields for the affected tickets.`)) return;
    try {
      setSaving(true);
      setError(null);
      const res = await assignmentAPI.rollbackReclassificationRun(runId);
      setMessage(`Rolled back run #${runId}. Restored ${res?.data?.restoredCount || 0} tickets.`);
      await loadReclassificationRuns();
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const displayReclassificationResults = pendingReclassificationResults.length
    ? pendingReclassificationResults
    : (reclassification?.results || []);
  const visibleReclassificationResults = displayReclassificationResults.slice(0, DISPLAY_RECLASSIFICATION_RESULTS_LIMIT);
  const hiddenReclassificationResultCount = Math.max(0, displayReclassificationResults.length - visibleReclassificationResults.length);
  const pendingClassifiableCount = pendingReclassificationResults.filter((result) => result.classification && !result.error).length;
  const pendingReviewNeededCount = pendingReclassificationResults.filter((result) => result.classification?.taxonomyReviewNeeded).length;
  const pendingFailedCount = pendingReclassificationResults.filter((result) => result.error).length;

  return (
    <div className="mt-3 rounded-xl border border-purple-200 dark:border-purple-500/30 bg-purple-50/40 dark:bg-purple-500/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Brain aria-hidden className="h-3.5 w-3.5 text-purple-600 dark:text-purple-300" /> Reclassify tickets
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 rounded-lg border bg-card px-2 py-1.5 text-xs text-muted-foreground">
            <span className="font-semibold">Batch</span>
            <select value={reclassificationLimit} onChange={(event) => setReclassificationLimit(Number(event.target.value))} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_BATCH_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 rounded-lg border bg-card px-2 py-1.5 text-xs text-muted-foreground" title="Number of ticket classifications sent to the LLM at the same time.">
            <span className="font-semibold">Parallel</span>
            <select value={reclassificationConcurrency} onChange={(event) => setReclassificationConcurrency(Number(event.target.value))} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 rounded-lg border bg-card px-2 py-1.5 text-xs text-muted-foreground" title="Model used for dry-run/apply reclassification.">
            <span className="font-semibold">Model</span>
            <select value={reclassificationModel} onChange={(event) => setReclassificationModel(event.target.value)} disabled={saving} className="bg-transparent text-xs outline-none">
              {RECLASSIFICATION_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </label>
          <button onClick={() => { setReclassificationCursor(null); reclassifyTickets({ apply: false }); }} disabled={saving} className="tp-focus-ring flex items-center gap-1 rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"><Brain className="h-3.5 w-3.5" /> Dry Run Batch</button>
          <button onClick={() => reclassifyTickets({ apply: false, nextBatch: true })} disabled={saving || !reclassificationCursor} className="tp-focus-ring flex items-center gap-1 rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"><ChevronRight className="h-3.5 w-3.5" /> Next Batch</button>
          <button onClick={() => reclassifyTickets({ apply: true })} disabled={saving || !pendingClassifiableCount} className="tp-focus-ring flex items-center gap-1 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/20 disabled:opacity-50"><CheckSquare className="h-3.5 w-3.5" /> Apply Preview</button>
          <button type="button" onClick={onClose} aria-label="Close reclassify panel" className="tp-focus-ring rounded-md p-1 text-muted-foreground/75 hover:bg-card hover:text-muted-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 space-y-3">
        {error && <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs text-red-700 dark:text-red-200">{error}</div>}
        {message && <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-200">{message}</div>}
        {reclassificationLimit >= 250 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Large batch selected. Dry run cost and time scale with ticket count. Values above 500 run as multiple 500-ticket server batches, then accumulate into one pending preview queue. Apply Preview does not call the LLM again.
          </div>
        )}
        {reclassification && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground/85">
            <p>
              Internal reclassification run #{reclassification.id} {reclassification.dryRun ? 'dry run' : 'apply'} scanned {reclassification.scanned || 0} tickets
              {reclassification.model ? ` with ${RECLASSIFICATION_MODELS.find((model) => model.value === reclassification.model)?.label || reclassification.model}` : ''}
              {reclassification.concurrency ? ` at ${reclassification.concurrency} parallel calls` : ''}. Freshservice ticket history was not modified.
            </p>
            {pendingReclassificationResults.length > 0 && (
              <p className="rounded-md border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2 py-1 font-semibold text-blue-800 dark:text-blue-200">
                Pending preview queue: {pendingReclassificationResults.length} tickets ({pendingClassifiableCount} applyable, {pendingReviewNeededCount} review-needed, {pendingFailedCount} failed). Next Batch adds to this queue; Apply Preview saves the queue.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-card px-2 py-1 ring-1 ring-border"><span className="font-semibold">{reclassification.scanned || 0}</span> scanned</div>
              <div className="rounded-md bg-card px-2 py-1 ring-1 ring-border"><span className="font-semibold text-emerald-700 dark:text-emerald-200">{reclassification.classified || 0}</span> classified</div>
              <div className="rounded-md bg-card px-2 py-1 ring-1 ring-border"><span className="font-semibold text-amber-700 dark:text-amber-200">{reclassification.reviewNeeded || 0}</span> review-needed</div>
              <div className="rounded-md bg-card px-2 py-1 ring-1 ring-border"><span className="font-semibold text-red-700 dark:text-red-200">{reclassification.failed || 0}</span> failed</div>
            </div>
            {!reclassification.dryRun && (
              <p className="rounded-md border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-2 py-1 font-semibold text-emerald-800 dark:text-emerald-200">
                Saved to Ticket Pulse local category fields. This apply run can be rolled back from Recent Reclassification Runs.
              </p>
            )}
            {displayReclassificationResults.length > 0 && (
              <div className="max-h-96 overflow-y-auto rounded border border-border bg-card">
                {hiddenReclassificationResultCount > 0 && (
                  <div className="border-b border-blue-100 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/15 px-2 py-1.5 text-blue-800 dark:text-blue-200">
                    Showing first {DISPLAY_RECLASSIFICATION_RESULTS_LIMIT} of {displayReclassificationResults.length} preview rows. Apply Preview still saves the full pending queue.
                  </div>
                )}
                {visibleReclassificationResults.map((result) => (
                  <div key={result.ticketId} className="grid gap-1 border-b border-border/60 px-2 py-1.5 last:border-b-0 md:grid-cols-[110px_1fr_220px]">
                    <span className="font-mono text-muted-foreground">FS-{result.freshserviceTicketId}</span>
                    <span className="truncate">{result.subject}</span>
                    <span className={result.error ? 'text-red-600 dark:text-red-300' : result.classification?.taxonomyReviewNeeded ? 'text-amber-700 dark:text-amber-200' : 'text-emerald-700 dark:text-emerald-200'}>
                      {result.error || `${result.classification?.categoryName || 'Unmapped'}${result.classification?.subcategoryName ? ` / ${result.classification.subcategoryName}` : ''}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {reclassificationRuns.length > 0 && (
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
              <h5 className="text-xs font-semibold text-foreground/85">Recent Reclassification Runs</h5>
              <button onClick={loadReclassificationRuns} disabled={saving} className="text-xs text-purple-600 dark:text-purple-300 hover:underline disabled:opacity-50">Refresh</button>
            </div>
            <div className="divide-y divide-border/60">
              {reclassificationRuns.map((run) => (
                <div key={run.id} className="grid gap-2 px-3 py-2 text-xs text-muted-foreground md:grid-cols-[90px_90px_1fr_120px] md:items-center">
                  <div className="font-mono">TR-{run.id}</div>
                  <div className={run.status === 'completed' ? 'text-emerald-700 dark:text-emerald-200' : run.status === 'failed' ? 'text-red-700 dark:text-red-200' : 'text-amber-700 dark:text-amber-200'}>
                    {run.mode} / {run.status}
                  </div>
                  <div>
                    <span>{formatDateTimeInTimezone(run.createdAt, 'America/Los_Angeles')}</span>
                    <span className="ml-2 text-muted-foreground/75">
                      scanned {run.summary?.scanned || 0}, classified {run.summary?.classified || 0}, failed {run.summary?.failed || 0}
                      {run.summary?.model ? `, ${RECLASSIFICATION_MODELS.find((model) => model.value === run.summary.model)?.label || run.summary.model}` : ''}
                      {run.summary?.concurrency ? `, ${run.summary.concurrency} parallel` : ''}
                      {run.summary?.applyFromPreview ? ', preview apply' : ''}
                    </span>
                    {run.rolledBackAt && <span className="ml-2 text-red-600 dark:text-red-300">rolled back</span>}
                  </div>
                  <div className="flex justify-end">
                    {run.mode === 'apply' && run.status === 'completed' && !run.rolledBackAt && (
                      <button onClick={() => rollbackReclassificationRun(run.id)} disabled={saving} className="rounded border border-red-200 dark:border-red-500/30 px-2 py-1 text-red-700 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-500/15 disabled:opacity-50">Rollback</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
        {scanned && groups.length === 0 && <span className="text-xs text-emerald-600 dark:text-emerald-300">No duplicates found</span>}
        {msg && <span className="text-xs text-emerald-600 dark:text-emerald-300">{msg}</span>}
        <button
          onClick={handleDetect}
          disabled={loading}
          className="tp-focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-muted/50 disabled:opacity-50"
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
              <div key={group.keepId} className="flex items-start justify-between rounded-lg border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 p-3">
                <div>
                  <p className="text-sm font-medium text-orange-800 dark:text-orange-200">Keep: <span className="font-bold">{keepLabel}</span></p>
                  {group.duplicates.map((dup) => (
                    <p key={dup.id} className="text-xs text-orange-700 dark:text-orange-200">Merge: {dup.label || dup.name} ({Math.round(dup.score * 100)}%)</p>
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
        className="tp-focus-ring flex h-full min-h-[34px] w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-left text-xs text-foreground/85 hover:bg-muted/50"
      >
        <span className="truncate">{selected ? selected.name : 'Top-level category'}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/75 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-2 shadow-soft">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/75" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter parent categories..."
              className="w-full rounded-lg border border-border bg-muted/50 py-2 pl-8 pr-2 text-xs outline-none focus:border-blue-300 dark:focus:border-blue-500/40 focus:bg-card"
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
                !value ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted/50'
              }`}
            >
              <span>Top-level category</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">none</span>
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
                  String(value) === String(category.id) ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted/50'
                }`}
              >
                <span className="truncate font-medium">{category.name}</span>
                <span className="flex-shrink-0 rounded bg-emerald-50 dark:bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-200">parent</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-4 text-center text-xs text-muted-foreground/75">No matching categories</div>
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
      className="absolute right-0 top-full z-40 mt-1 w-72 rounded-xl border border-border bg-card p-3 shadow-soft"
    >
      {children}
    </div>
  );
}

function ConfirmRetirePopover({ row, busy, onConfirm, onClose }) {
  return (
    <RowPopover onClose={onClose} labelledBy={`retire-title-${row.id}`}>
      <p id={`retire-title-${row.id}`} className="text-xs font-semibold text-foreground">Retire &ldquo;{row.name}&rdquo;?</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Tickets keep their history; it can&rsquo;t be chosen for new tickets. You can reactivate it anytime.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
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
      <p id={`edit-title-${row.id}`} className="text-xs font-semibold text-foreground">Edit &ldquo;{row.name}&rdquo;</p>
      <label className="mt-2 block text-[11px] font-medium text-muted-foreground" htmlFor={`edit-desc-${row.id}`}>Description</label>
      <textarea
        id={`edit-desc-${row.id}`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="What belongs in this category?"
        className="mt-1 w-full resize-none rounded-lg border border-border bg-muted/50 px-2.5 py-2 text-xs outline-none focus:border-blue-300 dark:focus:border-blue-500/40 focus:bg-card"
      />
      <label className="mt-2 block text-[11px] font-medium text-muted-foreground" htmlFor={`edit-sort-${row.id}`}>Sort order</label>
      <input
        id={`edit-sort-${row.id}`}
        type="number"
        value={sortOrder}
        onChange={(e) => setSortOrder(e.target.value)}
        className="mt-1 w-24 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-xs outline-none focus:border-blue-300 dark:focus:border-blue-500/40 focus:bg-card"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
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
      <p id={`merge-title-${row.id}`} className="text-xs font-semibold text-foreground">Merge &ldquo;{row.name}&rdquo; into…</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Its tickets and technician skills move to the target{row.parentName ? ` (same parent: ${row.parentName})` : ''}, then this one is removed.
      </p>
      {candidates.length === 0 ? (
        <p className="mt-3 rounded-lg bg-muted/50 px-2.5 py-3 text-center text-xs text-muted-foreground/75">No same-level candidates to merge into</p>
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
                targetId === candidate.id ? 'bg-blue-50 dark:bg-blue-500/15 font-semibold text-blue-700 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted/50'
              }`}
            >
              <span className="truncate">{candidate.name}</span>
              {Number.isFinite(candidate.ticketCount) && (
                <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/75">{candidate.ticketCount} tickets</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
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

// ─── Inline add row (header "+ New category" & per-category "+") ─────────

function InlineAddRow({
  isSub = false, parentName = null,
  name, description, onNameChange, onDescriptionChange,
  busy, error, onSubmit, onCancel,
}) {
  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <div className={`rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-500/10 px-2.5 py-2 ${isSub ? 'ml-9 mt-0.5' : 'mb-2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {isSub && <CornerDownRight aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" />}
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={isSub ? `New subcategory name under ${parentName}` : 'New category name'}
          placeholder={isSub ? 'Subcategory name' : 'Category name'}
          className="w-44 min-w-0 flex-shrink rounded-lg border border-blue-200 dark:border-blue-500/30 bg-card px-2.5 py-1.5 text-xs outline-none focus:border-blue-400"
        />
        <input
          type="text"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={isSub ? `New subcategory description under ${parentName}` : 'New category description'}
          placeholder="Description (optional)"
          className="min-w-0 flex-1 basis-40 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none focus:border-blue-300 dark:focus:border-blue-500/40"
        />
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            onClick={onSubmit}
            disabled={busy || !name.trim()}
            className="tp-focus-ring flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Add
          </button>
          <button
            onClick={onCancel}
            className="tp-focus-ring rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50"
          >
            Cancel
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 flex items-start gap-1 text-xs font-medium text-red-600 dark:text-red-300">
          <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 flex-shrink-0" /> {error}
        </p>
      )}
    </div>
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
  onAddChild = null, addOpen = false,
}) {
  const isSub = depth > 0;
  const deleteBlocked = effectiveChildCount > 0;
  const sourceChip = row.source && row.source !== 'manual' ? prettySource(row.source) : null;

  return (
    <div className={`relative ${isSub ? 'pl-9' : ''}`}>
      <div
        className={`group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/40 ${
          row.isActive ? '' : 'opacity-75'
        }`}
      >
        {/* Expander / indent guide */}
        {isSub ? (
          <CornerDownRight aria-hidden className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
        ) : hasChildren ? (
          <button
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.name}`}
            className="tp-focus-ring mt-0.5 rounded p-0.5 text-muted-foreground/75 hover:bg-muted hover:text-muted-foreground"
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
                className="w-full max-w-xs rounded-lg border border-blue-300 dark:border-blue-500/40 bg-card px-2 py-1 text-sm text-foreground outline-none ring-2 ring-blue-100 dark:ring-blue-500/30"
              />
              <button onClick={onRenameCommit} disabled={busy} aria-label="Save name" className="tp-focus-ring rounded-md p-1 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/15 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
              <button onClick={onRenameCancel} aria-label="Cancel rename" className="tp-focus-ring rounded-md p-1 text-muted-foreground/75 hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`truncate text-sm ${isSub ? 'font-medium text-foreground/85' : 'font-semibold text-foreground'} ${row.isActive ? '' : 'text-muted-foreground'}`}>
                {row.name}
              </span>
              {(Number.isFinite(row.ticketCount) || Number.isFinite(row.techCount)) && (
                <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {row.ticketCount ?? 0} tickets · {row.techCount ?? 0} techs
                </span>
              )}
              {sourceChip && (
                <span className="flex-shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">{sourceChip}</span>
              )}
              {row.isSystemSuggested && (
                <span className="flex-shrink-0 items-center gap-0.5 rounded-full bg-purple-50 dark:bg-purple-500/15 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-300 inline-flex">
                  <Sparkles className="h-2.5 w-2.5" /> AI suggested
                </span>
              )}
              {!row.isActive && (
                <span className="flex-shrink-0 rounded-full bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-200">Retired</span>
              )}
            </div>
          )}
          {!renaming && row.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground/75">{row.description}</p>
          )}
          {rowError && (
            <p role="alert" className="mt-1 flex items-start gap-1 text-xs font-medium text-red-600 dark:text-red-300">
              <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span>{rowError}</span>
              <button onClick={onDismissError} className="tp-focus-ring ml-1 underline decoration-red-300 hover:text-red-700 dark:hover:text-red-200">Dismiss</button>
            </p>
          )}
        </div>

        {/* Actions — revealed on hover/focus (always visible on touch widths) */}
        {!renaming && (
          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            {row.isActive ? (
              <>
                {onAddChild && (
                  <button
                    onClick={(event) => onAddChild(event.currentTarget)}
                    aria-expanded={addOpen}
                    aria-label={`Add subcategory to ${row.name}`}
                    title="Add subcategory"
                    className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-blue-50 dark:hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-300"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
                <button onClick={onStartRename} aria-label={`Rename ${row.name}`} title="Rename" className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground/85">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('edit')} aria-label={`Edit ${row.name}`} title="Edit description & sort order" className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground/85">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('merge')} aria-label={`Merge ${row.name} into another`} title="Merge into…" className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-muted hover:text-foreground/85">
                  <GitMerge className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onOpenPopover('retire')} aria-label={`Retire ${row.name}`} title="Retire (keep history)" className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-600 dark:hover:text-amber-300">
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                onClick={onReactivate}
                disabled={busy}
                aria-label={`Reactivate ${row.name}`}
                className="tp-focus-ring flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-card disabled:opacity-50"
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
                className="tp-focus-ring rounded-md p-1.5 text-muted-foreground/75 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/75"
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

export default function CategoriesManagementTab({ showMigrationControls = false, showReclassifyControls = showMigrationControls }) {
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

  // Inline add rows (header "+ New category" and per-category "+")
  const [addTarget, setAddTarget] = useState(null); // { parentId: number|null }
  const [addName, setAddName] = useState('');
  const [addDesc, setAddDesc] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState(null);
  const addTriggerRef = useRef(null); // element to restore focus to on close

  // Migration-era tools (flag-gated: skill-hierarchy workspaces only)
  const [helpOpen, setHelpOpen] = useState(false);
  const [drift, setDrift] = useState(null);
  const [driftOpen, setDriftOpen] = useState(false);
  const [driftBusy, setDriftBusy] = useState(false);
  const [toolsError, setToolsError] = useState(null);
  const [toolsMessage, setToolsMessage] = useState(null);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [reclassifyOpen, setReclassifyOpen] = useState(false);
  const [legacyDraft, setLegacyDraft] = useState(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  // Post-edit sync nudge — session-dismissable (component state, not persisted)
  const [syncNudge, setSyncNudge] = useState(false);
  const nudgeDismissedRef = useRef(false);

  const markTreeChanged = () => {
    if (!showMigrationControls || nudgeDismissedRef.current) return;
    setSyncNudge(true);
  };

  // Migration notice: an unpublished draft left over from the retired
  // migration editor gets a one-time banner with an admin discard action.
  useEffect(() => {
    if (!showMigrationControls) return undefined;
    let cancelled = false;
    assignmentAPI.getSkillDraft()
      .then((res) => { if (!cancelled) setLegacyDraft(res?.data?.draft || null); })
      .catch(() => { /* banner is best-effort */ });
    return () => { cancelled = true; };
  }, [showMigrationControls]);

  const loadDrift = async () => {
    try {
      setDriftBusy(true);
      setToolsError(null);
      const res = await assignmentAPI.getFreshserviceSkillDrift();
      setDrift(res?.data || null);
      setDriftOpen(true);
    } catch (err) {
      setToolsError(extractApiError(err));
    } finally {
      setDriftBusy(false);
    }
  };

  const runFreshserviceSync = async () => {
    try {
      setSyncBusy(true);
      setToolsError(null);
      const res = await assignmentAPI.syncFreshserviceSkillObjects();
      const created = res?.data?.created || {};
      const repairedParents = res?.data?.updated?.subskillParents?.length || 0;
      setSyncConfirmOpen(false);
      setToolsMessage(`Freshservice objects synced. Created ${created.skills?.length || 0} categories and ${created.subskills?.length || 0} subcategories${repairedParents ? `, repaired ${repairedParents} parent link${repairedParents === 1 ? '' : 's'}` : ''}.`);
      setSyncNudge(false);
      if (driftOpen) await loadDrift();
    } catch (err) {
      setSyncConfirmOpen(false);
      setToolsError(extractApiError(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const discardLegacyDraft = async () => {
    try {
      setDiscardBusy(true);
      setToolsError(null);
      await assignmentAPI.discardSkillDraft();
      setLegacyDraft(null);
      setDiscardConfirmOpen(false);
      setToolsMessage('Legacy migration draft discarded. The tree below stays the single source of truth.');
    } catch (err) {
      setDiscardConfirmOpen(false);
      setToolsError(extractApiError(err));
    } finally {
      setDiscardBusy(false);
    }
  };

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
    if (ok) {
      setRenaming(null);
      markTreeChanged();
    }
  };

  const handleSaveDetails = (row, patch) =>
    runRowAction(row.id, patch, () => assignmentAPI.updateCategory(row.id, patch));

  const handleSetActive = async (row, isActive) => {
    const ok = await runRowAction(row.id, { isActive }, () => assignmentAPI.updateCategory(row.id, { isActive }));
    if (ok) markTreeChanged();
    return ok;
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete "${row.name}" permanently? Only possible when no tickets reference it — otherwise deactivate or merge.`)) return;
    const ok = await runRowAction(row.id, null, () => assignmentAPI.deleteCategory(row.id));
    if (ok) markTreeChanged();
  };

  const handleMerge = async (row, target) => {
    const ok = await runRowAction(row.id, null, () => assignmentAPI.mergeCategories({ keepId: target.id, mergeIds: [row.id] }));
    if (ok) markTreeChanged();
    return ok;
  };

  const closeAddRow = () => {
    setAddTarget(null);
    setAddName('');
    setAddDesc('');
    setAddError(null);
    const trigger = addTriggerRef.current;
    addTriggerRef.current = null;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  };

  /** Toggle the inline add row for `parentId` (null = top-level, from the header/empty-state button). */
  const toggleAddRow = (parentId, triggerEl) => {
    const openHere = addTarget && (addTarget.parentId ?? null) === (parentId ?? null);
    if (openHere) {
      closeAddRow();
      return;
    }
    setAddTarget({ parentId: parentId ?? null });
    setAddName('');
    setAddDesc('');
    setAddError(null);
    addTriggerRef.current = triggerEl || null;
    // Adding a subcategory: make sure the parent is expanded so the row lands under its children.
    if (parentId != null) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
  };

  const handleInlineCreate = async () => {
    if (!addTarget || !addName.trim() || addBusy) return;
    try {
      setAddBusy(true);
      setAddError(null);
      await assignmentAPI.createCategory({
        name: addName.trim(),
        description: addDesc.trim() || null,
        parentId: addTarget.parentId,
      });
      await fetchData();
      closeAddRow();
      markTreeChanged();
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
        <Activity className="h-6 w-6 animate-spin text-blue-600 dark:text-blue-300" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 p-3 text-sm text-red-700 dark:text-red-200">
          {error} <button onClick={() => { setError(null); setLoading(true); fetchData(); }} className="ml-2 underline">Retry</button>
        </div>
      )}

      {(showMigrationControls || showReclassifyControls) && helpOpen && <HierarchyToolsHelpModal onClose={() => setHelpOpen(false)} />}
      <ConfirmDialog
        open={syncConfirmOpen}
        title="Sync to FreshService?"
        body="Creates missing records and repairs parent links in FreshService. Never deletes. Continue?"
        confirmLabel="Sync to FreshService"
        busy={syncBusy}
        onConfirm={runFreshserviceSync}
        onCancel={() => setSyncConfirmOpen(false)}
      />
      <ConfirmDialog
        open={discardConfirmOpen}
        tone="amber"
        title="Discard legacy draft?"
        body="Discards the unpublished draft left over from the retired migration editor. The live category tree is not affected."
        confirmLabel="Discard draft"
        busy={discardBusy}
        onConfirm={discardLegacyDraft}
        onCancel={() => setDiscardConfirmOpen(false)}
      />

      {showMigrationControls && legacyDraft && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2.5">
          <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>A legacy draft from the migration editor exists and is no longer editable here. The tree below is the single source of truth.</span>
          </div>
          <button
            type="button"
            onClick={() => setDiscardConfirmOpen(true)}
            className="tp-focus-ring flex items-center gap-1 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-card px-2.5 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/20"
          >
            <Trash2 className="h-3 w-3" /> Discard draft
          </button>
        </div>
      )}

      <div className="tp-card p-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Categories &amp; subcategories</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {activeParents.length} categor{activeParents.length === 1 ? 'y' : 'ies'} · {activeSubCount} subcategor{activeSubCount === 1 ? 'y' : 'ies'} · {retiredRows.length} retired
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <button
              onClick={(event) => toggleAddRow(null, event.currentTarget)}
              aria-expanded={addTarget?.parentId === null}
              className="tp-focus-ring flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" /> New category
            </button>
            <DuplicateDetector onMerged={() => { fetchData(); markTreeChanged(); }} />
            {showMigrationControls && (
              <FreshserviceToolsMenu
                busy={driftBusy || syncBusy}
                onCheckDrift={loadDrift}
                onSyncRequest={() => setSyncConfirmOpen(true)}
              />
            )}
            {showReclassifyControls && (
              <button
                type="button"
                onClick={() => setReclassifyOpen((prev) => !prev)}
                aria-expanded={reclassifyOpen}
                className={`tp-focus-ring flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  reclassifyOpen ? 'border-purple-300 dark:border-purple-500/40 bg-purple-50 dark:bg-purple-500/15 text-purple-700 dark:text-purple-200' : 'border-border bg-card text-foreground/85 hover:bg-muted/50'
                }`}
              >
                <Brain className="h-3 w-3" /> Reclassify
              </button>
            )}
            {(showMigrationControls || showReclassifyControls) && (
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                aria-label="Category tools help"
                title="Category tools help"
                className="tp-focus-ring rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 p-1.5 text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-500/20"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {showMigrationControls && (toolsError || toolsMessage) && (
          <div className={`mt-3 flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
            toolsError ? 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200' : 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
          }`}
          >
            <span>{toolsError || toolsMessage}</span>
            <button
              type="button"
              onClick={() => { setToolsError(null); setToolsMessage(null); }}
              aria-label="Dismiss message"
              className="tp-focus-ring rounded p-0.5 hover:bg-card/70"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {showMigrationControls && syncNudge && (
          <div role="status" className="mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-3 py-2 text-xs text-blue-800 dark:text-blue-200">
            <Database aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
            <span>FreshService objects may be out of date —</span>
            <button
              type="button"
              onClick={loadDrift}
              className="tp-focus-ring font-semibold underline decoration-blue-300 hover:text-blue-900 dark:hover:text-blue-200"
            >
              Check drift
            </button>
            <button
              type="button"
              onClick={() => { setSyncNudge(false); nudgeDismissedRef.current = true; }}
              aria-label="Dismiss sync reminder"
              className="tp-focus-ring ml-auto rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-500/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {showMigrationControls && driftOpen && drift && (
          <DriftReportSection drift={drift} busy={driftBusy} onRefresh={loadDrift} onClose={() => setDriftOpen(false)} />
        )}
        {showReclassifyControls && reclassifyOpen && (
          <ReclassifyTicketsSection onClose={() => setReclassifyOpen(false)} />
        )}

        {/* Search */}
        <div className="relative mt-3 max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/75" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search categories"
            placeholder="Search categories…"
            className="w-full rounded-lg border border-border bg-muted/50 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-blue-300 dark:focus:border-blue-500/40 focus:bg-card"
          />
        </div>

        {/* Tree */}
        <div className="mt-3">
          {/* Top-level inline add row, pinned above the tree */}
          {addTarget && addTarget.parentId === null && (
            <InlineAddRow
              name={addName}
              description={addDesc}
              onNameChange={(value) => { setAddName(value); if (addError) setAddError(null); }}
              onDescriptionChange={setAddDesc}
              busy={addBusy}
              error={addError}
              onSubmit={handleInlineCreate}
              onCancel={closeAddRow}
            />
          )}
          {activeParents.length === 0 && retiredRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
              <Folder aria-hidden className="h-6 w-6 text-muted-foreground/50" />
              <p className="text-sm font-medium text-muted-foreground">No categories yet</p>
              <p className="max-w-xs text-xs text-muted-foreground/75">Create your first category — subcategories can be nested under it once it exists.</p>
              <button
                onClick={(event) => toggleAddRow(null, event.currentTarget)}
                aria-expanded={addTarget?.parentId === null}
                className="tp-focus-ring mt-1 flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" /> New category
              </button>
            </div>
          ) : visibleTree.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground/75">
              No categories match &ldquo;{search.trim()}&rdquo;
            </p>
          ) : (
            <div className="divide-y divide-border/60">
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
                      onAddChild={(triggerEl) => toggleAddRow(parent.id, triggerEl)}
                      addOpen={addTarget?.parentId === parent.id}
                    />
                    {expanded && visibleChildren.map((child) => (
                      <CategoryRow key={child.id} {...rowProps(child)} depth={1} hasChildren={false} expanded={false} onToggleExpand={() => {}} />
                    ))}
                    {/* Subcategory inline add row — under the last child (or right under the row when collapsed/childless) */}
                    {addTarget?.parentId === parent.id && (
                      <InlineAddRow
                        isSub
                        parentName={parent.name}
                        name={addName}
                        description={addDesc}
                        onNameChange={(value) => { setAddName(value); if (addError) setAddError(null); }}
                        onDescriptionChange={setAddDesc}
                        busy={addBusy}
                        error={addError}
                        onSubmit={handleInlineCreate}
                        onCancel={closeAddRow}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Retired */}
        {retiredRows.length > 0 && (
          <div className="mt-4 rounded-xl border border-border bg-muted/30">
            <button
              onClick={() => setRetiredOpen((prev) => !prev)}
              aria-expanded={retiredOpen}
              className="tp-focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground hover:bg-muted/70"
            >
              {retiredOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/75" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/75" />}
              <Archive aria-hidden className="h-3.5 w-3.5 text-muted-foreground/75" />
              Retired ({retiredRows.length})
            </button>
            {retiredOpen && (
              <div className="border-t border-border px-2 py-1.5">
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
      </div>
    </div>
  );
}
