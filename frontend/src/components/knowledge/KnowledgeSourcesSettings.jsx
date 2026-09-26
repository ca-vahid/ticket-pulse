import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CloudDownload } from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import { Switch } from '../ui';
import { timeAgo } from '../tickets/ticketUi';
import { SettingsRow, SettingsSection } from './knowledgeUi';
import { IMPORT_ACTIVE, importSummary } from './knowledgeGrowthFormat';

/**
 * Knowledge → Settings, the "Knowledge that grows" half (Auto-help P1; moved
 * out of the Articles tab's Sources drawer on 26 Sep 2026):
 *   Knowledge sources   the FreshService solution import (off by default; pick
 *                       folders, published articles only, read-only here)
 *   Reviews             the Monday "review due" e-mail to article owners
 * People who can't manage Knowledge see both read-only: no folder list and no
 * import status calls (those endpoints are manager-only).
 */

/** Folder picker: FreshService categories (small headers) with their folders as checkboxes. */
function FolderPicker({ categories, selected, onToggle }) {
  return (
    <div className="settings-scrollbar max-h-72 space-y-3 overflow-y-auto pr-1" data-testid="fs-folder-picker">
      {categories.map((c) => (
        <fieldset key={c.id}>
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">{c.name}</legend>
          {c.folders.length === 0 && <p className="text-xs text-muted-foreground/75">No folders</p>}
          {c.folders.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm text-foreground/85 hover:bg-muted/50">
              <input
                type="checkbox"
                checked={selected.includes(f.id)}
                onChange={() => onToggle(f.id)}
                className="tp-focus-ring mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input accent-[hsl(var(--primary))]"
              />
              <span className="min-w-0">
                <span className="block">{f.name}</span>
                {f.description && <span className="block truncate text-[11px] text-muted-foreground/75">{f.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function KnowledgeSources({ canManage = true }) {
  const [settings, setSettings] = useState(null);
  const [folders, setFolders] = useState(null);
  const [foldersError, setFoldersError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // "Import now" runs in the background: poll its job until it ends.
  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);
  const pollJob = useCallback((jobId) => {
    stopPolling();
    const tick = async () => {
      try {
        const res = jobId ? await knowledgeGrowthAPI.fsImportJob(jobId) : await knowledgeGrowthAPI.fsImportStatus();
        const state = res?.data?.status === 'unknown' ? (res?.data?.current || null) : (res?.data || null);
        if (state) setSettings((s) => (s ? { ...s, fsImportState: state, ...(state.status === 'done' ? { fsImportedAt: state.at } : {}) } : s));
        if (state && IMPORT_ACTIVE.has(state.status)) {
          pollRef.current = setTimeout(tick, 2000);
          return;
        }
        setImporting(false);
        if (state) setMessage(importSummary(state));
      } catch (err) {
        setImporting(false);
        setError(err?.message || 'Could not read the import progress');
      }
    };
    setImporting(true);
    pollRef.current = setTimeout(tick, 1000);
  }, [stopPolling]);
  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let cancelled = false;
    knowledgeGrowthAPI.getSettings()
      .then((res) => {
        if (cancelled) return;
        setSettings(res?.data || null);
        setSelected(res?.data?.fsFolderIds || []);
        // An import already running (started here or by someone else): follow it.
        if (canManage && IMPORT_ACTIVE.has(res?.data?.fsImportState?.status)) pollJob(res.data.fsImportState.jobId || null);
      })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the settings'); });
    return () => { cancelled = true; };
  }, [pollJob, canManage]);

  const loadFolders = useCallback(async (refresh = false) => {
    setFoldersError(null);
    try {
      const res = await knowledgeGrowthAPI.fsFolders(refresh ? { refresh: 1 } : {});
      setFolders(res?.data?.categories || []);
    } catch (err) {
      setFolders(null);
      setFoldersError(err?.message || 'Could not list the FreshService folders');
    }
  }, []);
  useEffect(() => { if (canManage) loadFolders(); }, [loadFolders, canManage]);

  const dirty = useMemo(() => {
    const a = [...(settings?.fsFolderIds || [])].sort().join(',');
    return a !== [...selected].sort().join(',');
  }, [settings, selected]);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await knowledgeGrowthAPI.updateSettings(patch);
      setSettings(res?.data || null);
      setSelected(res?.data?.fsFolderIds || []);
      return true;
    } catch (err) {
      setError(err?.message || 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await knowledgeGrowthAPI.fsImportNow();
      const d = res?.data || {};
      if (d.jobId) {
        setSettings((s) => ({ ...s, fsImportState: { jobId: d.jobId, status: d.status || 'queued' } }));
        pollJob(d.jobId);
        return;
      }
      setImporting(false);
      if (d.dryRun) setMessage('Dry run only: this environment never calls FreshService. In production the import would read the picked folders now.');
      else if (d.skipped) setMessage(d.skipped === 'running' ? 'An import is already running.' : 'Nothing to import — pick folders first.');
    } catch (err) {
      setImporting(false);
      setError(err?.message || 'The import did not start');
    }
  };

  const toggle = (id) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const pickedCount = settings?.fsFolderIds?.length || 0;

  return (
    <>
      <SettingsSection
        id="kh-settings-sources"
        title="Knowledge sources"
        hint="Where articles come from besides the ones your team writes here."
        testId="knowledge-sources"
      >
        {!settings && !error ? (
          <SettingsRow>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
          </SettingsRow>
        ) : settings && (
          <SettingsRow>
            <Switch
              id="kg-fs-import"
              checked={settings.fsImportEnabled}
              disabled={!canManage || busy || (!settings.fsImportEnabled && !selected.length)}
              onCheckedChange={(v) => save({ fsImportEnabled: v, fsFolderIds: selected })}
              aria-label="Import FreshService solution articles"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="kg-fs-import" className="block cursor-pointer">
                <span className="block text-sm font-medium text-foreground">Import FreshService solution articles</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  Published articles from the folders you pick, every night. They are read-only here (edit them in FreshService) and Auto-help can quote them like any published article.
                </span>
              </label>

              {canManage ? (
                <div className="mt-3">
                  <p className="mb-1.5 text-xs font-medium text-foreground/85">Folders</p>
                  {folders ? (
                    folders.length ? <FolderPicker categories={folders} selected={selected} onToggle={toggle} /> : <p className="text-xs text-muted-foreground">FreshService has no solution folders in this workspace.</p>
                  ) : foldersError ? (
                    <p className="text-xs text-muted-foreground" role="status">
                      {foldersError}{' '}
                      <button type="button" onClick={() => loadFolders(true)} className="tp-focus-ring rounded font-medium text-primary hover:underline">Try again</button>
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Listing FreshService folders…</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => save({ fsFolderIds: selected, ...(selected.length ? {} : { fsImportEnabled: false }) })}
                      disabled={busy || !dirty}
                      className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : `Save ${selected.length} folder${selected.length === 1 ? '' : 's'}`}
                    </button>
                    <button
                      type="button"
                      onClick={importNow}
                      disabled={importing || !settings.fsFolderIds?.length || dirty}
                      className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50"
                    >
                      {importing ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CloudDownload className="h-4 w-4" aria-hidden="true" />}
                      {importing ? 'Importing…' : 'Import now'}
                    </button>
                    {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved folder changes</span>}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-foreground/85" data-testid="fs-import-readonly">
                  {pickedCount ? `${pickedCount} folder${pickedCount === 1 ? '' : 's'} picked.` : 'No folders picked.'}
                </p>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/75" data-testid="fs-import-state" aria-live="polite">{importSummary(settings.fsImportState)}</p>
              {!settings.fsCallsAllowed && (
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">This environment never calls FreshService: the folder list and the import only run in production.</p>
              )}
              {message && <p className="mt-2 text-xs text-foreground/85" role="status">{message}</p>}
            </div>
          </SettingsRow>
        )}
        {error && (
          <SettingsRow>
            <p className="text-xs text-destructive" role="alert">{error}</p>
          </SettingsRow>
        )}
      </SettingsSection>

      {settings && (
        <SettingsSection id="kh-settings-reviews" title="Reviews" hint="Keeping articles true once they are published." testId="knowledge-reviews">
          <SettingsRow>
            <Switch
              id="kg-digest"
              checked={settings.reviewDigestEnabled}
              disabled={!canManage || busy}
              onCheckedChange={(v) => save({ reviewDigestEnabled: v })}
              aria-label="Weekly review e-mail to article owners"
            />
            <label htmlFor="kg-digest" className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm font-medium text-foreground">Monday review e-mail to article owners</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                At 08:00 on Mondays each owner gets one e-mail listing their articles that are due for an accuracy check, grouped by category.
                {settings.reviewDigestSentAt ? ` Last sent ${timeAgo(settings.reviewDigestSentAt)}.` : ''} Owners always see their own list on the Articles tab.
              </span>
            </label>
            <span className={`hidden shrink-0 text-xs font-medium sm:block ${settings.reviewDigestEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
              {settings.reviewDigestEnabled ? 'On' : 'Off'}
            </span>
          </SettingsRow>
        </SettingsSection>
      )}
    </>
  );
}

export default KnowledgeSources;
