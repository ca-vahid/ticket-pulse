import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, AlertTriangle, ArchiveRestore, Calendar, Check, CheckCircle2,
  ChevronDown, ChevronRight, Clock, DatabaseBackup, Download, Globe, Loader,
  Loader2, Plus, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { backupAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { formatDayTime, timeAgo, formatBytes } from '../tickets/ticketUi';

/**
 * Backup & Restore (Settings → Sync & Data). Three layers from
 * plans/BACKUP_RESTORE_PLAN.md surface here:
 *  - Protection status header (platform PITR + last snapshot + schedules).
 *  - Snapshot timeline: on-demand "Snapshot now" (workspace or full site),
 *    download / restore / delete, 4s polling while a snapshot is running.
 *  - Restore wizard: scope → server dry-run diff → typed confirmation.
 *    Merge never deletes; Replace makes the module exactly the snapshot.
 * Data-tier (TP-native ticket data) modules are export-only in v1 — in-place
 * ticket restoration stays a platform (PITR) operation.
 */

const MODULE_LABELS = {
  noiseRules: 'Noise rules',
  slaPolicies: 'SLA policies',
  macros: 'Macros',
  customFields: 'Custom fields',
  ticketTypes: 'Ticket types',
  taxonomy: 'Categories & skills',
  businessHours: 'Business hours',
  trustedDomains: 'Trusted domains',
  workflows: 'Mail workflows',
};

// TP-native data modules (Tier B) are export-only — never restorable in-app.
const DATA_MODULE_KEYS = new Set([
  'tickets', 'ticketThreads', 'threads', 'conversations', 'tags', 'ticketTags',
  'ticketLinks', 'links', 'feedback', 'episodes', 'assignmentEpisodes',
  'attachments', 'attachmentsMeta',
]);

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'workspace', label: 'This workspace' },
  { key: 'site', label: 'Site' },
  { key: 'manual', label: 'Manual' },
  { key: 'scheduled', label: 'Scheduled' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function moduleLabel(key) {
  if (MODULE_LABELS[key]) return MODULE_LABELS[key];
  // Fall back to a humanized camelCase key so unknown modules still render.
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Unwrap `{ data: [...] }` bodies (the axios interceptor already returns response.data). */
function unwrapList(res) {
  if (Array.isArray(res)) return res;
  return res?.data || [];
}

function unwrapItem(res) {
  return res?.data ?? res ?? null;
}

/** Parse a manifest counts key — site snapshots use 'ws<id>:<module>'. */
function parseCountKey(rawKey) {
  const m = /^ws(\d+):(.+)$/.exec(rawKey);
  return m ? { workspaceId: Number(m[1]), module: m[2] } : { workspaceId: null, module: rawKey };
}

function isRestorable(manifest, rawKey, moduleKey) {
  const meta = manifest?.modules?.[rawKey] ?? manifest?.modules?.[moduleKey];
  if (meta && typeof meta === 'object' && 'restorable' in meta) return meta.restorable !== false;
  return !DATA_MODULE_KEYS.has(moduleKey);
}

function localHourLabel(hourUtc) {
  const d = new Date();
  d.setUTCHours(Number(hourUtc) || 0, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatCreated(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------- chips

function ScopeChip({ snapshot, workspaceName }) {
  if (snapshot.scope === 'site') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border border-violet-200 dark:border-violet-500/30 whitespace-nowrap">
        <Globe className="w-3 h-3" aria-hidden="true" /> Site
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-200 dark:border-blue-500/30 whitespace-nowrap">
      {workspaceName || `Workspace ${snapshot.workspaceId ?? '?'}`}
    </span>
  );
}

function TierChip({ tier }) {
  return tier === 'config_data' ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200 border border-sky-200 dark:border-sky-500/30 whitespace-nowrap">
      Config + data
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-muted/50 text-muted-foreground border border-border whitespace-nowrap">
      Config
    </span>
  );
}

function StatusCell({ snapshot }) {
  if (snapshot.status === 'pending' || snapshot.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-300">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Running…
      </span>
    );
  }
  if (snapshot.status === 'failed') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-300 cursor-help"
        title={snapshot.error || 'Snapshot failed'}
      >
        <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-200">
      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Completed
    </span>
  );
}

const ACTION_PILLS = {
  create: { label: 'Add', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30' },
  update: { label: 'Update', cls: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30' },
  skip: { label: 'Skip', cls: 'bg-muted/50 text-muted-foreground border-border' },
  conflict: { label: 'Conflict', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30' },
  delete: { label: 'Remove', cls: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30' },
};

function ActionPill({ action }) {
  const info = ACTION_PILLS[action] || ACTION_PILLS.skip;
  return (
    <span className={`inline-flex items-center px-1.5 py-px rounded-full text-[10px] font-semibold border ${info.cls}`}>
      {info.label}
    </span>
  );
}

// ------------------------------------------------------------- restore wizard

function normalizeDryRunModule(m) {
  const c = m.counts || m;
  return {
    module: m.module || m.key || 'unknown',
    create: Number(c.create) || 0,
    update: Number(c.update) || 0,
    skip: Number(c.skip) || 0,
    conflict: Number(c.conflict) || 0,
    deletes: Number(c.delete ?? c.deletes ?? c.remove) || 0,
    items: Array.isArray(m.items) ? m.items : [],
  };
}

function DiffCount({ value, label, cls }) {
  return (
    <span className={`inline-flex items-baseline gap-1 tabular-nums text-xs ${value > 0 ? cls : 'text-muted-foreground/50'}`}>
      <span className="font-bold">{value}</span>{label}
    </span>
  );
}

function DryRunModuleRow({ row }) {
  const [open, setOpen] = useState(false);
  const hasItems = row.items.length > 0;
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => hasItems && setOpen((v) => !v)}
        aria-expanded={hasItems ? open : undefined}
        className={`tp-focus-ring w-full flex items-center gap-2 px-3 py-2 text-left bg-card ${hasItems ? 'hover:bg-muted/50' : 'cursor-default'}`}
      >
        {hasItems
          ? (open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/75 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/75 shrink-0" aria-hidden="true" />)
          : <span className="w-3.5" aria-hidden="true" />}
        <span className="text-sm font-medium text-foreground flex-1 min-w-0 truncate">{moduleLabel(row.module)}</span>
        <span className="flex items-center gap-3 shrink-0">
          <DiffCount value={row.create} label="add" cls="text-emerald-600 dark:text-emerald-300" />
          <DiffCount value={row.update} label="update" cls="text-blue-600 dark:text-blue-300" />
          <DiffCount value={row.skip} label="skip" cls="text-muted-foreground/75" />
          <DiffCount value={row.conflict} label="conflict" cls="text-amber-600 dark:text-amber-300" />
          {row.deletes > 0 && <DiffCount value={row.deletes} label="remove" cls="text-red-600 dark:text-red-300" />}
        </span>
      </button>
      {open && hasItems && (
        <ul className="border-t border-border/60 bg-muted/30 max-h-44 overflow-y-auto settings-scrollbar divide-y divide-border/60">
          {row.items.map((item, i) => (
            <li key={`${item.key || i}`} className="flex items-center gap-2 px-3 py-1.5">
              <code className="text-[11px] font-mono text-muted-foreground flex-1 min-w-0 truncate">{item.key || item.name || `item ${i + 1}`}</code>
              <ActionPill action={item.action} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RestoreWizard({ snapshot, currentWorkspace, workspaces, onClose, onRestored }) {
  const manifest = useMemo(() => snapshot.manifest || {}, [snapshot.manifest]);
  const counts = useMemo(() => manifest.counts || {}, [manifest]);
  const isSite = snapshot.scope === 'site';

  const workspaceName = useCallback((id) => (
    workspaces?.find((w) => w.id === Number(id))?.name
    || manifest.workspaceNames?.[id]
    || `Workspace ${id}`
  ), [workspaces, manifest.workspaceNames]);

  // Site snapshots hold every workspace's modules — pick the source first.
  const sourceWorkspaces = useMemo(() => {
    if (!isSite) return [];
    const ids = [...new Set(Object.keys(counts).map((k) => parseCountKey(k).workspaceId).filter((v) => v !== null))];
    return ids.sort((a, b) => a - b).map((id) => ({ id, name: workspaceName(id) }));
  }, [isSite, counts, workspaceName]);

  const [sourceWorkspaceId, setSourceWorkspaceId] = useState(() => {
    if (!isSite) return snapshot.workspaceId ?? null;
    const ids = [...new Set(Object.keys(counts).map((k) => parseCountKey(k).workspaceId).filter((v) => v !== null))];
    return ids.includes(currentWorkspace?.id) ? currentWorkspace.id : (ids[0] ?? null);
  });

  const moduleEntries = useMemo(() => {
    const entries = [];
    for (const [rawKey, count] of Object.entries(counts)) {
      const { workspaceId, module } = parseCountKey(rawKey);
      if (isSite && workspaceId !== Number(sourceWorkspaceId)) continue;
      entries.push({ key: module, count: Number(count) || 0, restorable: isRestorable(manifest, rawKey, module) });
    }
    return entries.sort((a, b) => (a.restorable === b.restorable
      ? moduleLabel(a.key).localeCompare(moduleLabel(b.key))
      : (a.restorable ? -1 : 1)));
  }, [counts, isSite, sourceWorkspaceId, manifest]);

  const [selected, setSelected] = useState(() => new Set());
  const [mode, setMode] = useState('merge');
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dryRunRows, setDryRunRows] = useState([]);
  const [applied, setApplied] = useState(null);
  const [confirmText, setConfirmText] = useState('');

  // Changing source workspace invalidates the module selection.
  useEffect(() => { setSelected(new Set()); }, [sourceWorkspaceId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const toggleModule = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const crossWorkspace = sourceWorkspaceId !== null && currentWorkspace?.id != null
    && Number(sourceWorkspaceId) !== Number(currentWorkspace.id);

  const restoreBody = () => ({
    targetWorkspaceId: currentWorkspace?.id,
    modules: [...selected],
    ...(isSite ? { sourceWorkspaceId: Number(sourceWorkspaceId) } : {}),
    mode,
  });

  const runDryRun = async () => {
    setBusy(true); setError(null);
    try {
      const res = await backupAPI.dryRun(snapshot.id, restoreBody());
      const body = unwrapItem(res) || {};
      const rows = (Array.isArray(body.modules) ? body.modules : Array.isArray(body) ? body : [])
        .map(normalizeDryRunModule);
      setDryRunRows(rows);
      setStep(2);
    } catch (err) {
      setError(err.message || 'Dry run failed');
    } finally { setBusy(false); }
  };

  const totals = useMemo(() => dryRunRows.reduce((acc, r) => ({
    create: acc.create + r.create,
    update: acc.update + r.update,
    skip: acc.skip + r.skip,
    conflict: acc.conflict + r.conflict,
    deletes: acc.deletes + r.deletes,
  }), { create: 0, update: 0, skip: 0, conflict: 0, deletes: 0 }), [dryRunRows]);

  const totalChanges = totals.create + totals.update + totals.deletes;
  const needsTypedConfirm = mode === 'replace' || totalChanges > 20;
  const confirmOk = !needsTypedConfirm || confirmText.trim() === 'RESTORE';

  const runRestore = async () => {
    setBusy(true); setError(null);
    try {
      const res = await backupAPI.restore(snapshot.id, restoreBody());
      const body = unwrapItem(res) || {};
      const rawApplied = body.applied || body.modules || null;
      let rows = null;
      if (Array.isArray(rawApplied)) rows = rawApplied.map(normalizeDryRunModule);
      else if (rawApplied && typeof rawApplied === 'object') {
        rows = Object.entries(rawApplied).map(([module, c]) => normalizeDryRunModule({ module, counts: c }));
      }
      setApplied(rows);
      setStep(4);
      onRestored?.();
    } catch (err) {
      setError(err.message || 'Restore failed');
    } finally { setBusy(false); }
  };

  const stepTitle = step === 1 ? 'Choose what to restore'
    : step === 2 ? 'Review changes (dry run)'
      : step === 3 ? 'Confirm restore' : 'Restore complete';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="restore-wizard-title">
      <div className="absolute inset-0 bg-slate-900/40 dark:bg-black/70 backdrop-blur-[2px]" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative w-full max-w-2xl tp-card rounded-2xl overflow-hidden shadow-soft animate-scaleIn flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/60 flex items-start gap-3">
          <span className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 flex items-center justify-center shrink-0">
            <ArchiveRestore className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="restore-wizard-title" className="text-sm font-bold text-foreground">{stepTitle}</h2>
            <p className="text-xs text-muted-foreground/75 mt-0.5">
              Snapshot from {formatCreated(snapshot.completedAt || snapshot.createdAt)} · <ScopeChip snapshot={snapshot} workspaceName={workspaceName(snapshot.workspaceId)} /> <TierChip tier={snapshot.tier} />
            </p>
          </div>
          {step < 4 && (
            <span className="text-[11px] font-semibold text-muted-foreground/75 shrink-0 mt-1" aria-label={`Step ${step} of 3`}>Step {step} / 3</span>
          )}
          <button onClick={onClose} disabled={busy} aria-label="Close restore wizard" className="tp-focus-ring p-1 rounded-lg text-muted-foreground/75 hover:text-foreground/85 hover:bg-muted">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto settings-scrollbar flex-1 space-y-3">
          {error && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 text-xs text-red-700 dark:text-red-200" role="alert">
              <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" /> {error}
            </div>
          )}

          {/* --- Step 1: scope --- */}
          {step === 1 && (
            <>
              {isSite && (
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">Restore configuration from</span>
                  <select
                    value={sourceWorkspaceId ?? ''}
                    onChange={(e) => setSourceWorkspaceId(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 border border-input rounded-lg text-sm bg-card tp-focus-ring"
                  >
                    {sourceWorkspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>{ws.name}</option>
                    ))}
                  </select>
                </label>
              )}

              {crossWorkspace && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 text-xs text-blue-700 dark:text-blue-200">
                  <Globe className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
                  <span>
                    Copying configuration from <strong>{workspaceName(sourceWorkspaceId)}</strong> into{' '}
                    <strong>{currentWorkspace?.name}</strong>. Nothing changes in the source workspace.
                  </span>
                </div>
              )}

              <fieldset>
                <legend className="text-xs font-semibold text-muted-foreground mb-1.5">Modules</legend>
                {moduleEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground/75 italic">This snapshot holds no modules for the selected workspace.</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {moduleEntries.map((m) => (
                    <label
                      key={m.key}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-sm ${
                        m.restorable
                          ? (selected.has(m.key) ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:border-input cursor-pointer')
                          : 'border-border/60 bg-muted/30 opacity-70'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="tp-focus-ring rounded accent-blue-600"
                        checked={selected.has(m.key)}
                        disabled={!m.restorable}
                        onChange={() => toggleModule(m.key)}
                        aria-label={`${moduleLabel(m.key)} (${m.count} items)`}
                      />
                      <span className={`flex-1 min-w-0 truncate ${m.restorable ? 'text-foreground' : 'text-muted-foreground/75'}`}>{moduleLabel(m.key)}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground/75 shrink-0">{m.count}</span>
                      {!m.restorable && (
                        <span className="text-[10px] font-semibold text-muted-foreground/75 border border-border rounded-full px-1.5 py-px shrink-0">export-only</span>
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-xs font-semibold text-muted-foreground mb-1.5">Apply mode</legend>
                <div className="space-y-1.5">
                  <label className={`flex items-start gap-2 px-2.5 py-2 rounded-lg border cursor-pointer ${mode === 'merge' ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10' : 'border-border bg-card hover:border-input'}`}>
                    <input type="radio" name="restore-mode" value="merge" checked={mode === 'merge'} onChange={() => setMode('merge')} className="mt-0.5 accent-blue-600 tp-focus-ring" />
                    <span className="text-sm">
                      <span className="font-semibold text-foreground">Merge</span>
                      <span className="block text-xs text-muted-foreground">Adds & updates, never deletes.</span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2 px-2.5 py-2 rounded-lg border cursor-pointer ${mode === 'replace' ? 'border-amber-300 dark:border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/10' : 'border-border bg-card hover:border-input'}`}>
                    <input type="radio" name="restore-mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-0.5 accent-amber-600 tp-focus-ring" />
                    <span className="text-sm">
                      <span className="font-semibold text-foreground">Replace</span>
                      <span className="block text-xs text-muted-foreground">Module becomes exactly the snapshot — removes items not in it.</span>
                    </span>
                  </label>
                </div>
              </fieldset>
            </>
          )}

          {/* --- Step 2: dry-run diff --- */}
          {step === 2 && (
            <>
              {mode === 'replace' && totals.deletes > 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-300 dark:border-amber-500/40 text-xs text-amber-800 dark:text-amber-200" role="alert">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
                  <span>Replace mode will <strong>delete {totals.deletes} item{totals.deletes === 1 ? '' : 's'}</strong> not present in this snapshot.</span>
                </div>
              )}
              {dryRunRows.length === 0 ? (
                <p className="text-sm text-muted-foreground/75 italic py-4 text-center">The dry run found nothing to change.</p>
              ) : (
                <div className="space-y-1.5">
                  {dryRunRows.map((row) => <DryRunModuleRow key={row.module} row={row} />)}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground/75">
                Dry run only — nothing has been written yet. {totals.conflict > 0 && `${totals.conflict} conflict${totals.conflict === 1 ? '' : 's'} will keep the existing item unless you chose Replace.`}
              </p>
            </>
          )}

          {/* --- Step 3: confirm --- */}
          {step === 3 && (
            <>
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground/85 space-y-1">
                <p>
                  Restoring <strong>{selected.size} module{selected.size === 1 ? '' : 's'}</strong> into{' '}
                  <strong>{currentWorkspace?.name}</strong> in <strong>{mode === 'replace' ? 'Replace' : 'Merge'}</strong> mode.
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {totals.create} added · {totals.update} updated · {totals.skip} unchanged
                  {totals.deletes > 0 && <span className="text-red-600 dark:text-red-300 font-semibold"> · {totals.deletes} removed</span>}
                </p>
              </div>
              {needsTypedConfirm && (
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Type <code className="font-mono text-red-600 dark:text-red-300">RESTORE</code> to confirm
                    {mode === 'replace' ? ' — Replace mode removes items' : ` — this changes ${totalChanges} items`}.
                  </span>
                  <input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder="RESTORE"
                    aria-label="Type RESTORE to confirm"
                    className="mt-1 w-full px-3 py-2 border border-input rounded-lg text-sm font-mono tp-focus-ring"
                    autoFocus
                  />
                </label>
              )}
              <p className="text-[11px] text-muted-foreground/75">Every restore is audited (who, what, scope, counts).</p>
            </>
          )}

          {/* --- Step 4: success --- */}
          {step === 4 && (
            <div className="py-2 space-y-3">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-200">
                <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                <span className="text-sm font-semibold">Restore applied to {currentWorkspace?.name}.</span>
              </div>
              <div className="space-y-1">
                {(applied || dryRunRows).map((row) => (
                  <div key={row.module} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Check className="w-3 h-3 text-emerald-500 shrink-0" aria-hidden="true" />
                    <span className="font-medium">{moduleLabel(row.module)}</span>
                    <span className="text-muted-foreground/75 tabular-nums">
                      {row.create} added · {row.update} updated{row.deletes > 0 ? ` · ${row.deletes} removed` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-border/60 bg-muted/30 flex items-center justify-end gap-2">
          {step === 1 && (
            <>
              <button onClick={onClose} className="tp-focus-ring px-3.5 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50">Cancel</button>
              <button
                onClick={runDryRun}
                disabled={busy || selected.size === 0}
                className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                {busy ? 'Computing diff…' : 'Preview changes'}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button onClick={() => setStep(1)} disabled={busy} className="tp-focus-ring px-3.5 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50">Back</button>
              <button
                onClick={() => { setConfirmText(''); setStep(3); }}
                disabled={busy || totalChanges === 0}
                className="tp-focus-ring px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Continue
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button onClick={() => setStep(2)} disabled={busy} className="tp-focus-ring px-3.5 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50">Back</button>
              <button
                onClick={runRestore}
                disabled={busy || !confirmOk}
                className={`tp-focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50 ${mode === 'replace' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ArchiveRestore className="w-4 h-4" aria-hidden="true" />}
                {busy ? 'Restoring…' : 'Restore now'}
              </button>
            </>
          )}
          {step === 4 && (
            <button onClick={onClose} className="tp-focus-ring px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700">Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- schedules

const EMPTY_SCHEDULE = { scope: 'workspace', tier: 'config', frequency: 'daily', weekday: 1, hourUtc: 6, retention: 14, enabled: true };

function scheduleSummary(s) {
  const when = s.frequency === 'weekly' ? `Weekly ${WEEKDAYS[s.weekday ?? 1]?.slice(0, 3) || 'Mon'}` : 'Daily';
  return `${when} ${String(s.hourUtc ?? 0).padStart(2, '0')}:00 UTC`;
}

function ScheduleCard({ schedules, isGlobalAdmin, currentWorkspace, onChanged, onError }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_SCHEDULE);
  const [busyId, setBusyId] = useState(null); // schedule id, or 'new'

  const save = async () => {
    setBusyId('new'); onError?.(null);
    try {
      await backupAPI.saveSchedule({
        ...form,
        weekday: form.frequency === 'weekly' ? Number(form.weekday) : undefined,
        hourUtc: Number(form.hourUtc),
        retention: Math.max(1, Number(form.retention) || 1),
      });
      setAdding(false);
      setForm(EMPTY_SCHEDULE);
      await onChanged?.();
    } catch (err) { onError?.(err.message || 'Failed to save schedule'); }
    finally { setBusyId(null); }
  };

  const toggle = async (s) => {
    setBusyId(s.id); onError?.(null);
    try {
      await backupAPI.saveSchedule({ ...s, enabled: !s.enabled });
      await onChanged?.();
    } catch (err) { onError?.(err.message || 'Failed to update schedule'); }
    finally { setBusyId(null); }
  };

  const remove = async (s) => {
    setBusyId(s.id); onError?.(null);
    try {
      await backupAPI.deleteSchedule(s.id);
      await onChanged?.();
    } catch (err) { onError?.(err.message || 'Failed to delete schedule'); }
    finally { setBusyId(null); }
  };

  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Calendar className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">Scheduled backups</h3>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 hover:bg-blue-100 dark:hover:bg-blue-500/20"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add schedule
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">Automatic snapshots on a fixed cadence, keeping the most recent N per schedule.</p>

      {(schedules || []).length === 0 && !adding && (
        <p className="text-sm text-muted-foreground/75 italic">No schedules yet — nightly config snapshots are a good default.</p>
      )}

      <div className="space-y-1.5">
        {(schedules || []).map((s) => (
          <div key={s.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border ${s.enabled ? 'border-border bg-card' : 'border-border/60 bg-muted/35 opacity-70'}`}>
            <button
              role="switch"
              aria-checked={!!s.enabled}
              aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${scheduleSummary(s)} schedule`}
              onClick={() => toggle(s)}
              disabled={busyId === s.id}
              className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${s.enabled ? 'bg-blue-600' : 'bg-muted-foreground/40'}`}
            >
              <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform" style={{ transform: s.enabled ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
            </button>
            {s.scope === 'site'
              ? <ScopeChip snapshot={{ scope: 'site' }} />
              : <ScopeChip snapshot={{ scope: 'workspace', workspaceId: s.workspaceId ?? currentWorkspace?.id }} workspaceName={currentWorkspace?.name} />}
            <TierChip tier={s.tier} />
            <span className="text-sm text-foreground/85 font-medium">{scheduleSummary(s)}</span>
            <span className="text-xs text-muted-foreground/75">({localHourLabel(s.hourUtc)} local)</span>
            <span className="text-xs text-muted-foreground/75 ml-auto">keep last {s.retention ?? '—'}</span>
            <button
              onClick={() => remove(s)}
              disabled={busyId === s.id}
              aria-label={`Delete ${scheduleSummary(s)} schedule`}
              className="tp-focus-ring p-1 rounded text-muted-foreground/50 hover:text-red-500"
            >
              {busyId === s.id ? <Loader className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="mt-2 p-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/10 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            <span className="block font-semibold mb-0.5">Scope</span>
            <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))} className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring">
              <option value="workspace">This workspace</option>
              {isGlobalAdmin && <option value="site">Full site</option>}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="block font-semibold mb-0.5">Tier</span>
            <select value={form.tier} onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value }))} className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring">
              <option value="config">Configuration</option>
              <option value="config_data">Configuration + data</option>
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="block font-semibold mb-0.5">Frequency</span>
            <select value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))} className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          {form.frequency === 'weekly' && (
            <label className="text-xs text-muted-foreground">
              <span className="block font-semibold mb-0.5">Weekday</span>
              <select value={form.weekday} onChange={(e) => setForm((f) => ({ ...f, weekday: Number(e.target.value) }))} className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring">
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs text-muted-foreground">
            <span className="block font-semibold mb-0.5">Hour (UTC)</span>
            <select value={form.hourUtc} onChange={(e) => setForm((f) => ({ ...f, hourUtc: Number(e.target.value) }))} className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </label>
          <span className="text-xs text-muted-foreground/75 pb-2">= {localHourLabel(form.hourUtc)} local</span>
          <label className="text-xs text-muted-foreground">
            <span className="block font-semibold mb-0.5">Keep last</span>
            <input
              type="number" min="1" max="90" value={form.retention}
              onChange={(e) => setForm((f) => ({ ...f, retention: e.target.value }))}
              className="w-20 px-2 py-1.5 border border-input rounded-lg text-sm tp-focus-ring tabular-nums"
            />
          </label>
          <div className="flex items-center gap-1.5 ml-auto pb-0.5">
            <button
              onClick={save}
              disabled={busyId === 'new'}
              className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {busyId === 'new' ? <Loader className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />} Save schedule
            </button>
            <button onClick={() => { setAdding(false); setForm(EMPTY_SCHEDULE); }} className="tp-focus-ring px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------- panel

function StatCard({ dotClass, title, children }) {
  return (
    <div className="tp-card rounded-xl p-3.5">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground/75">{title}</span>
      </div>
      {children}
    </div>
  );
}

export default function BackupRestorePanel() {
  const { currentWorkspace, availableWorkspaces } = useWorkspace();
  const { user } = useAuth();
  const isGlobalAdmin = user?.role === 'admin';

  const [snapshots, setSnapshots] = useState(null);
  const [schedules, setSchedules] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [filter, setFilter] = useState('all');

  const [scope, setScope] = useState('workspace');
  const [tier, setTier] = useState('config');
  const [creating, setCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [busySnapshotId, setBusySnapshotId] = useState(null);
  const [restoreSnap, setRestoreSnap] = useState(null);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const refreshSnapshots = useCallback(async () => {
    const res = await backupAPI.list();
    setSnapshots(unwrapList(res));
  }, []);

  const refreshSchedules = useCallback(async () => {
    const res = await backupAPI.getSchedules();
    setSchedules(unwrapList(res));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await Promise.all([refreshSnapshots(), refreshSchedules()]);
    } catch (err) {
      setError(err.message || 'Failed to load backups');
    } finally { setLoading(false); }
  }, [refreshSnapshots, refreshSchedules]);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  // Poll while any snapshot is still being produced so the running row
  // resolves without a manual refresh.
  const hasActive = (snapshots || []).some((s) => s.status === 'pending' || s.status === 'running');
  useEffect(() => {
    if (!hasActive) return undefined;
    const t = setInterval(() => { refreshSnapshots().catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [hasActive, refreshSnapshots]);

  const workspaceName = useCallback((id) => (
    availableWorkspaces?.find((w) => w.id === Number(id))?.name || (id != null ? `Workspace ${id}` : null)
  ), [availableWorkspaces]);

  const counts = useMemo(() => {
    const list = snapshots || [];
    return {
      all: list.length,
      workspace: list.filter((s) => s.scope === 'workspace' && Number(s.workspaceId) === Number(currentWorkspace?.id)).length,
      site: list.filter((s) => s.scope === 'site').length,
      manual: list.filter((s) => s.trigger === 'manual').length,
      scheduled: list.filter((s) => s.trigger && s.trigger !== 'manual').length,
    };
  }, [snapshots, currentWorkspace?.id]);

  const rows = useMemo(() => {
    let list = snapshots || [];
    if (filter === 'workspace') list = list.filter((s) => s.scope === 'workspace' && Number(s.workspaceId) === Number(currentWorkspace?.id));
    else if (filter === 'site') list = list.filter((s) => s.scope === 'site');
    else if (filter === 'manual') list = list.filter((s) => s.trigger === 'manual');
    else if (filter === 'scheduled') list = list.filter((s) => s.trigger && s.trigger !== 'manual');
    return [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [snapshots, filter, currentWorkspace?.id]);

  const lastCompleted = useMemo(() => (
    (snapshots || [])
      .filter((s) => s.status === 'completed')
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))[0] || null
  ), [snapshots]);

  const lastSnapshotStale = !lastCompleted
    || (Date.now() - new Date(lastCompleted.completedAt || lastCompleted.createdAt).getTime()) > 7 * 24 * 3600 * 1000;

  const enabledSchedules = (schedules || []).filter((s) => s.enabled);

  const createSnapshot = async () => {
    setCreating(true); setError(null);
    try {
      await backupAPI.create({ scope, tier });
      flash('Snapshot started — it will appear below as it runs.');
      await refreshSnapshots();
    } catch (err) {
      setError(err.message || 'Failed to start snapshot');
    } finally { setCreating(false); }
  };

  const download = async (s) => {
    setBusySnapshotId(s.id); setError(null);
    try {
      const stamp = (s.completedAt || s.createdAt || '').slice(0, 10) || 'snapshot';
      await backupAPI.download(s.id, `tp-${s.scope}-${s.tier}-${stamp}.zip`);
    } catch (err) {
      setError(err.message || 'Download failed');
    } finally { setBusySnapshotId(null); }
  };

  const remove = async (s) => {
    setBusySnapshotId(s.id); setError(null);
    try {
      await backupAPI.remove(s.id);
      setConfirmDeleteId(null);
      flash('Snapshot deleted.');
      await refreshSnapshots();
    } catch (err) {
      setError(err.message || 'Failed to delete snapshot');
    } finally { setBusySnapshotId(null); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-500/20 rounded-lg">
          <DatabaseBackup className="w-5 h-5 text-blue-600 dark:text-blue-300" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Backup & Restore</h3>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Point-in-time snapshots of Ticket Pulse configuration{isGlobalAdmin ? ' — per workspace or the full site' : ''}.
            Restore into this workspace with a reviewed dry-run, or download the archive.
          </p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-sm text-red-700 dark:text-red-200" role="alert">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /><span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg text-sm text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /><span>{successMsg}</span>
        </div>
      )}

      {/* Protection status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard dotClass="bg-emerald-500" title="Platform recovery">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">Azure point-in-time restore + vaulted long-term backups</p>
          </div>
        </StatCard>
        <StatCard dotClass={lastSnapshotStale ? 'bg-amber-400' : 'bg-emerald-500'} title="Last snapshot">
          {lastCompleted ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`text-sm font-semibold ${lastSnapshotStale ? 'text-amber-700 dark:text-amber-200' : 'text-foreground'}`}>
                {formatDayTime(lastCompleted.completedAt || lastCompleted.createdAt)}
                <span className="font-normal text-muted-foreground/75"> · {timeAgo(lastCompleted.completedAt || lastCompleted.createdAt)}</span>
              </span>
              <ScopeChip snapshot={lastCompleted} workspaceName={workspaceName(lastCompleted.workspaceId)} />
              <TierChip tier={lastCompleted.tier} />
            </div>
          ) : (
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-200">None yet — take one now</p>
          )}
        </StatCard>
        <StatCard dotClass={enabledSchedules.length ? 'bg-emerald-500' : 'bg-amber-400'} title="Scheduled backups">
          {enabledSchedules.length ? (
            <p className="text-xs text-muted-foreground">
              <span className="text-sm font-semibold text-foreground">{enabledSchedules.length} enabled</span>
              {' — '}{enabledSchedules.slice(0, 2).map(scheduleSummary).join(' · ')}
              {enabledSchedules.length > 2 ? ` · +${enabledSchedules.length - 2} more` : ''}
            </p>
          ) : (
            <p className="text-sm font-semibold text-muted-foreground">None — set one below</p>
          )}
        </StatCard>
      </div>

      {/* Snapshot-now toolbar */}
      <div className="tp-card rounded-xl p-3.5 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground flex items-center gap-1.5">
          <span className="font-semibold">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Snapshot scope"
            className="px-2 py-1.5 border border-input rounded-lg text-sm bg-card tp-focus-ring"
          >
            <option value="workspace">This workspace</option>
            {isGlobalAdmin && <option value="site">Full site</option>}
          </select>
        </label>
        <div className="flex items-center rounded-lg border border-border overflow-hidden" role="group" aria-label="Snapshot tier">
          <button
            onClick={() => setTier('config')}
            aria-pressed={tier === 'config'}
            className={`tp-focus-ring px-2.5 py-1.5 text-xs font-semibold ${tier === 'config' ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted/50'}`}
          >
            Configuration
          </button>
          <button
            onClick={() => setTier('config_data')}
            aria-pressed={tier === 'config_data'}
            className={`tp-focus-ring px-2.5 py-1.5 text-xs font-semibold border-l border-border ${tier === 'config_data' ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted/50'}`}
          >
            Configuration + data
          </button>
        </div>
        {tier === 'config_data' && (
          <span className="text-[11px] text-muted-foreground/75">Ticket data is export-only — it downloads but restores via platform recovery.</span>
        )}
        <button
          onClick={createSnapshot}
          disabled={creating}
          className="tp-focus-ring ml-auto inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {creating ? <Loader className="w-4 h-4 animate-spin" aria-hidden="true" /> : <DatabaseBackup className="w-4 h-4" aria-hidden="true" />}
          Snapshot now
        </button>
      </div>

      {/* Snapshot timeline */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground/75">
          <Loader className="w-5 h-5 animate-spin mr-2" aria-hidden="true" /> Loading snapshots…
        </div>
      ) : (
        <div className="tp-card rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter snapshots">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                  className={`tp-focus-ring px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    filter === key
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-card text-muted-foreground border-border hover:border-input hover:bg-muted/50'
                  }`}
                >
                  {label} <span className={filter === key ? 'opacity-80' : 'text-muted-foreground/75'}>{counts[key]}</span>
                </button>
              ))}
            </div>
            <span className="ml-auto hidden md:inline text-xs text-muted-foreground/75">{rows.length} shown</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2 hidden sm:table-cell">Tier</th>
                  <th className="px-3 py-2 hidden md:table-cell">Size</th>
                  <th className="px-3 py-2 hidden lg:table-cell">By</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60 bg-card">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground/75">
                      {counts.all === 0
                        ? 'No snapshots yet — take your first one with “Snapshot now” above.'
                        : 'No snapshots in this filter.'}
                    </td>
                  </tr>
                )}
                {rows.map((s) => {
                  const completed = s.status === 'completed';
                  const busy = busySnapshotId === s.id;
                  return (
                    <tr key={s.id} className="transition-colors hover:bg-muted/35">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-sm text-foreground">{formatCreated(s.createdAt)}</div>
                        <div className="text-[11px] text-muted-foreground/75">{timeAgo(s.createdAt)}</div>
                      </td>
                      <td className="px-3 py-2"><ScopeChip snapshot={s} workspaceName={s.manifest?.workspaceName || workspaceName(s.workspaceId)} /></td>
                      <td className="px-3 py-2 hidden sm:table-cell"><TierChip tier={s.tier} /></td>
                      <td className="px-3 py-2 hidden md:table-cell text-xs text-muted-foreground tabular-nums">{s.sizeBytes != null ? formatBytes(s.sizeBytes) : '—'}</td>
                      <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground truncate max-w-[160px]" title={s.createdByEmail || ''}>
                        {s.trigger && s.trigger !== 'manual' ? 'Scheduled' : (s.createdByEmail || '—')}
                      </td>
                      <td className="px-3 py-2"><StatusCell snapshot={s} /></td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            onClick={() => download(s)}
                            disabled={!completed || busy}
                            title="Download archive"
                            aria-label={`Download snapshot from ${formatCreated(s.createdAt)}`}
                            className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 disabled:opacity-40 disabled:hover:text-muted-foreground/75"
                          >
                            {busy ? <Loader className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
                          </button>
                          <button
                            onClick={() => setRestoreSnap(s)}
                            disabled={!completed}
                            title="Restore…"
                            aria-label={`Restore snapshot from ${formatCreated(s.createdAt)}`}
                            className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 disabled:opacity-40 disabled:hover:text-muted-foreground/75"
                          >
                            <ArchiveRestore className="w-4 h-4" aria-hidden="true" />
                          </button>
                          {confirmDeleteId === s.id ? (
                            <span className="inline-flex items-center gap-1">
                              <button
                                onClick={() => remove(s)}
                                disabled={busy}
                                className="tp-focus-ring px-2 py-1 rounded-lg text-[11px] font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                              >
                                {busy ? 'Deleting…' : 'Delete?'}
                              </button>
                              <button onClick={() => setConfirmDeleteId(null)} aria-label="Cancel delete" className="tp-focus-ring p-1 rounded text-muted-foreground/75 hover:text-foreground/85">
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteId(s.id)}
                              disabled={s.status === 'running' || s.status === 'pending'}
                              title="Delete snapshot"
                              aria-label={`Delete snapshot from ${formatCreated(s.createdAt)}`}
                              className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 disabled:opacity-40 disabled:hover:text-muted-foreground/75"
                            >
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Schedules */}
      <ScheduleCard
        schedules={schedules}
        isGlobalAdmin={isGlobalAdmin}
        currentWorkspace={currentWorkspace}
        onChanged={refreshSchedules}
        onError={setError}
      />

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/75">
        <Clock className="w-3 h-3" aria-hidden="true" />
        Snapshots cover Ticket Pulse–owned configuration. FreshService-born tickets re-sync from FreshService; attachments are protected by blob versioning.
      </p>

      {restoreSnap && (
        <RestoreWizard
          snapshot={restoreSnap}
          currentWorkspace={currentWorkspace}
          workspaces={availableWorkspaces}
          onClose={() => setRestoreSnap(null)}
          onRestored={() => { refreshSnapshots().catch(() => {}); }}
        />
      )}
    </div>
  );
}
