import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, CloudDownload, Search } from 'lucide-react';
import { knowledgeConfluenceAPI } from '../../services/api';
import { Switch } from '../ui';
import { timeAgo } from '../tickets/ticketUi';
import { SettingsRow, SettingsSection, inputClass, labelClass } from './knowledgeUi';
import {
  IMPORT_ACTIVE, LABEL_WORDS, RUN_KIND_WORDS, RUN_STATUS_WORDS, countPicked, emptySelection, importLine, isPicked,
  money, nodeStats, normalizeSelection, parentMap, runCounts, sameSelection, selectionLine, toggleNode,
} from './confluenceFormat';

/**
 * Knowledge -> Settings -> Confluence (QA 10-23 #4), its own card:
 *   Connection        site address, a service account's e-mail and API token
 *                     (the token is never shown again), test, disconnect
 *   Pages to bring in pick spaces, look at their page trees (counts, and the
 *                     AI's include / skip suggestion per section), tick
 *                     sections; a ticked section brings what is under it, a
 *                     child can be unticked
 *   One-time import   straight into the library as "Not checked yet"
 *   Nightly check     off by default; changed / new / deleted pages become
 *                     Inbox suggestions, nothing changes until someone accepts
 *   Run history       the last runs with their counts and errors
 * People who can't manage Knowledge see it read-only (no Confluence calls).
 */

const btn = 'tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50';
const primaryBtn = 'tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
const checkbox = 'tp-focus-ring mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input accent-[hsl(var(--primary))]';

function LabelLine({ label }) {
  if (!label?.label) return null;
  const skip = label.suggestion === 'skip';
  return (
    <span className={`block text-[11px] leading-snug ${skip ? 'text-muted-foreground/75' : 'text-primary'}`}>
      {label.by === 'model' ? 'AI: ' : ''}{LABEL_WORDS[label.label] || label.label}, {skip ? 'skip' : 'bring in'}{label.reason ? `. ${label.reason}` : ''}
    </span>
  );
}

function TreeNode({ node, depth, spaceId, sel, parents, labels, expanded, onExpand, onToggle }) {
  const hasChildren = node.children?.length > 0;
  const open = expanded.has(node.id);
  const picked = isPicked(node.id, parents, sel, spaceId);
  return (
    <li>
      <div className="flex items-start gap-1.5 rounded py-1 pr-1 hover:bg-muted/50" style={{ paddingLeft: `${depth * 16}px` }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onExpand(node.id)}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} pages under ${node.title}`}
            className="tp-focus-ring mt-0.5 rounded text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          </button>
        ) : <span className="w-4 flex-shrink-0" aria-hidden="true" />}
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-sm text-foreground/85">
          <input type="checkbox" checked={picked} onChange={() => onToggle(node, spaceId)} className={checkbox} />
          <span className="min-w-0">
            <span className="block truncate">{node.title}</span>
            <span className="block text-[11px] text-muted-foreground/75">{nodeStats(node)}</span>
            <LabelLine label={labels[node.id] || node.label} />
          </span>
        </label>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} spaceId={spaceId} sel={sel} parents={parents} labels={labels} expanded={expanded} onExpand={onExpand} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RunHistory({ runs }) {
  if (!runs?.length) return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  return (
    <ul className="divide-y divide-border" data-testid="confluence-runs">
      {runs.map((r) => {
        const cost = money(r.costUsd);
        return (
          <li key={r.id} className="py-2">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium text-foreground">{RUN_KIND_WORDS[r.kind] || r.kind}</span>
              <span className={`text-xs ${r.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{RUN_STATUS_WORDS[r.status] || r.status}</span>
              <span className="text-xs text-muted-foreground/75">{timeAgo(r.startedAt)}{r.triggeredBy && r.triggeredBy !== 'nightly' ? ` by ${r.triggeredBy}` : ''}</span>
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-foreground/85">{runCounts(r)}</p>
            {r.error && <p className="mt-0.5 text-xs text-destructive">{r.error}</p>}
            {(r.model || cost) && <p className="mt-0.5 text-[11px] text-muted-foreground/75">{[r.model, cost].filter(Boolean).join(' · ')}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function ConfluenceSettings({ canManage = true }) {
  const [view, setView] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState({ siteUrl: '', email: '', apiToken: '' });
  const [spaces, setSpaces] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [withModel, setWithModel] = useState(true);
  const [sel, setSel] = useState(emptySelection());
  const [expanded, setExpanded] = useState(() => new Set());
  const pollRef = useRef(null);

  const loadRuns = useCallback(() => knowledgeConfluenceAPI.runs().then((res) => setRuns(res?.data || [])).catch(() => {}), []);
  const applyView = useCallback((data) => {
    if (!data) return;
    setView(data);
    setSel(normalizeSelection(data.selection));
    setForm((f) => ({ siteUrl: data.siteUrl || f.siteUrl, email: data.email || f.email, apiToken: '' }));
  }, []);

  const stopPolling = useCallback(() => { if (pollRef.current) clearTimeout(pollRef.current); pollRef.current = null; }, []);
  const pollImport = useCallback(() => {
    stopPolling();
    const tick = async () => {
      try {
        const res = await knowledgeConfluenceAPI.importStatus();
        const state = res?.data || null;
        setView((v) => (v ? { ...v, importState: state, ...(state?.status === 'done' ? { importedAt: state.at } : {}) } : v));
        if (state && IMPORT_ACTIVE.has(state.status)) { pollRef.current = setTimeout(tick, 2000); return; }
        loadRuns();
      } catch (err) {
        setError(err?.message || 'Could not read the import progress');
      }
    };
    pollRef.current = setTimeout(tick, 1000);
  }, [stopPolling, loadRuns]);
  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let cancelled = false;
    knowledgeConfluenceAPI.get()
      .then((res) => {
        if (cancelled) return;
        applyView(res?.data || null);
        if (canManage && IMPORT_ACTIVE.has(res?.data?.importState?.status)) pollImport();
      })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the Confluence settings'); });
    loadRuns();
    return () => { cancelled = true; };
  }, [applyView, loadRuns, pollImport, canManage]);

  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      return await fn();
    } catch (err) {
      setError(err?.message || 'That did not work');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const saveConnection = () => run('connect', async () => {
    const res = await knowledgeConfluenceAPI.saveConnection({ siteUrl: form.siteUrl, email: form.email, ...(form.apiToken ? { apiToken: form.apiToken } : {}) });
    applyView(res?.data);
    setMessage('Connection saved.');
  });
  const testConnection = () => run('test', async () => {
    const res = await knowledgeConfluenceAPI.test();
    const d = res?.data || {};
    setMessage(d.ok ? `Connected. The account can read ${d.spaces} space${d.spaces === 1 ? '' : 's'}.` : `Not connected: ${d.message}`);
  });
  const disconnect = () => run('disconnect', async () => {
    const res = await knowledgeConfluenceAPI.clearConnection();
    applyView(res?.data);
    setSpaces(null);
    setAnalysis(null);
    setMessage('Disconnected. The nightly check is off.');
  });
  const loadSpaces = () => run('spaces', async () => {
    const res = await knowledgeConfluenceAPI.spaces();
    setSpaces(res?.data?.spaces || []);
  });
  const analyze = () => run('analyze', async () => {
    const res = await knowledgeConfluenceAPI.analyze({ spaceIds: sel.spaces.map((s) => s.id), withModel });
    const data = res?.data || null;
    setAnalysis(data);
    // Show each space's sections; deeper levels open on request.
    const open = new Set();
    for (const s of data?.spaces || []) for (const r of s.tree || []) open.add(r.id);
    setExpanded(open);
    setView((v) => (v ? { ...v, labels: data?.labels || v.labels } : v));
    loadRuns();
  });
  const saveSelection = () => run('selection', async () => {
    const res = await knowledgeConfluenceAPI.saveSelection(sel);
    applyView(res?.data);
    setMessage('Picked pages saved.');
  });
  const importNow = () => run('import', async () => {
    const res = await knowledgeConfluenceAPI.importNow();
    const d = res?.data || {};
    setView((v) => ({ ...v, importState: { jobId: d.jobId, status: d.status || 'queued' } }));
    pollImport();
  });
  const setNightly = (enabled) => run('nightly', async () => {
    const res = await knowledgeConfluenceAPI.setNightly(enabled);
    applyView(res?.data);
  });

  const toggleSpace = (space) => setSel((s) => {
    const on = s.spaces.some((x) => x.id === space.id);
    return on
      ? { ...s, spaces: s.spaces.filter((x) => x.id !== space.id), wholeSpaces: s.wholeSpaces.filter((x) => x !== space.id) }
      : { ...s, spaces: [...s.spaces, { id: space.id, key: space.key, name: space.name }] };
  });
  const toggleWhole = (spaceId) => setSel((s) => ({ ...s, wholeSpaces: s.wholeSpaces.includes(spaceId) ? s.wholeSpaces.filter((x) => x !== spaceId) : [...s.wholeSpaces, spaceId] }));
  const parents = useMemo(() => parentMap(analysis?.spaces || []), [analysis]);
  const onToggle = useCallback((node, spaceId) => setSel((s) => toggleNode(s, node, parents, spaceId)), [parents]);
  const onExpand = useCallback((id) => setExpanded((e) => { const n = new Set(e); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  const dirty = view ? !sameSelection(sel, view.selection) : false;
  const picked = analysis ? countPicked(analysis.spaces, sel) : null;
  const labels = view?.labels || {};
  const importing = IMPORT_ACTIVE.has(view?.importState?.status);
  const savedSel = normalizeSelection(view?.selection);
  const hasSaved = savedSel.wholeSpaces.length > 0 || savedSel.include.length > 0;
  const spaceList = spaces || sel.spaces;

  return (
    <SettingsSection
      id="kh-settings-confluence"
      title="Confluence"
      hint="Bring Confluence pages into Knowledge: a one-time import first, then, if you want, a nightly check that only suggests changes."
      testId="knowledge-confluence"
    >
      {!view && !error ? (
        <SettingsRow>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
        </SettingsRow>
      ) : view && (
        <>
          {/* Connection */}
          <SettingsRow>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Connection</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground" data-testid="confluence-connection">
                {view.configured
                  ? `Connected to ${view.siteUrl}${view.email ? ` as ${view.email}` : ''}. Read-only: Ticket Pulse never changes Confluence.`
                  : 'Not connected. Use a dedicated read-only service account that can read the spaces you want, and an Atlassian API token for it. The token is kept on the server, never shown again.'}
              </p>
              {canManage && (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="cf-site" className={labelClass}>Site address</label>
                    <input id="cf-site" className={inputClass} placeholder="https://example.atlassian.net" value={form.siteUrl} onChange={(e) => setForm({ ...form, siteUrl: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="cf-email" className={labelClass}>Account e-mail</label>
                    <input id="cf-email" type="email" className={inputClass} placeholder="svc-confluence@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="cf-token" className={labelClass}>API token</label>
                    <input id="cf-token" type="password" autoComplete="off" className={inputClass} placeholder={view.tokenSet ? 'Saved. Leave blank to keep it' : 'Paste the token'} value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
                    <button type="button" className={primaryBtn} disabled={busy !== null || !form.siteUrl || !form.email || (!form.apiToken && !view.tokenSet)} onClick={saveConnection}>
                      {busy === 'connect' ? 'Saving…' : 'Save connection'}
                    </button>
                    <button type="button" className={btn} disabled={busy !== null || !view.configured} onClick={testConnection}>
                      {busy === 'test' ? 'Testing…' : 'Test connection'}
                    </button>
                    {view.configured && <button type="button" className={btn} disabled={busy !== null} onClick={disconnect}>Disconnect</button>}
                  </div>
                </div>
              )}
              {!view.callsAllowed && (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/75">This environment never calls Confluence: looking at pages and importing only run in production.</p>
              )}
            </div>
          </SettingsRow>

          {/* Pages to bring in */}
          <SettingsRow>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Pages to bring in</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Pick spaces, then look at their pages. Tick a section to bring in everything under it; untick a page inside it to leave that one out.
              </p>
              {!canManage || !view.configured ? (
                <p className="mt-2 text-xs text-foreground/85" data-testid="confluence-selection-readonly">{selectionLine(view.selection)}</p>
              ) : (
                <div className="mt-3 space-y-3">
                  <div>
                    <div className="mb-1.5 flex items-center gap-2">
                      <p className="text-xs font-medium text-foreground/85">Spaces</p>
                      <button type="button" className="tp-focus-ring rounded text-xs font-medium text-primary hover:underline disabled:opacity-50" disabled={busy !== null} onClick={loadSpaces}>
                        {busy === 'spaces' ? 'Listing…' : spaces ? 'List again' : 'List spaces'}
                      </button>
                    </div>
                    {spaceList.length ? (
                      <div className="settings-scrollbar flex max-h-40 flex-col overflow-y-auto" data-testid="confluence-spaces">
                        {spaceList.map((s) => (
                          <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm text-foreground/85 hover:bg-muted/50">
                            <input type="checkbox" className={checkbox} checked={sel.spaces.some((x) => x.id === s.id)} onChange={() => toggleSpace(s)} />
                            <span>{s.name}{s.key ? <span className="text-muted-foreground/75"> ({s.key})</span> : null}</span>
                          </label>
                        ))}
                      </div>
                    ) : <p className="text-xs text-muted-foreground">No spaces listed yet.</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" className={btn} disabled={busy !== null || !sel.spaces.length} onClick={analyze}>
                      {busy === 'analyze' ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
                      {busy === 'analyze' ? 'Reading the pages…' : 'Look at the pages'}
                    </button>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/85">
                      <input type="checkbox" className={checkbox} checked={withModel} onChange={(e) => setWithModel(e.target.checked)} />
                      Ask the AI which sections to bring in
                    </label>
                  </div>
                  {analysis?.spaces?.map((space) => (
                    <div key={space.id} data-testid={`confluence-tree-${space.id}`}>
                      <label className="flex cursor-pointer items-start gap-2 text-sm font-medium text-foreground">
                        <input type="checkbox" className={checkbox} checked={sel.wholeSpaces.includes(space.id)} onChange={() => toggleWhole(space.id)} />
                        <span>
                          {space.name}: the whole space
                          <span className="block text-[11px] font-normal text-muted-foreground/75">
                            {nodeStats({ pages: space.pages, subtreeWords: space.words, lastUpdated: space.lastUpdated })}{space.complete ? '' : ' (Confluence listed only part of it)'}
                          </span>
                        </span>
                      </label>
                      <ul className="settings-scrollbar mt-1 max-h-96 overflow-y-auto">
                        {space.tree.map((n) => (
                          <TreeNode key={n.id} node={n} depth={0} spaceId={space.id} sel={sel} parents={parents} labels={labels} expanded={expanded} onExpand={onExpand} onToggle={onToggle} />
                        ))}
                      </ul>
                    </div>
                  ))}
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground/85">
                    <input type="checkbox" className={checkbox} checked={!sel.includeRestricted} onChange={(e) => setSel((s) => ({ ...s, includeRestricted: !e.target.checked }))} />
                    <span>Skip pages with view limits in Confluence. Knowledge rights are by skill, not per page, so limited pages would be readable by everyone here.</span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={primaryBtn} disabled={busy !== null || !dirty} onClick={saveSelection}>
                      {busy === 'selection' ? 'Saving…' : 'Save picked pages'}
                    </button>
                    {picked !== null && <span className="text-xs text-foreground/85" data-testid="confluence-picked">{picked} page{picked === 1 ? '' : 's'} picked</span>}
                    {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
                  </div>
                </div>
              )}
            </div>
          </SettingsRow>

          {/* One-time import */}
          <SettingsRow>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">One-time import</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Copies the picked pages into the library as published, &ldquo;Not checked yet&rdquo; articles, filed by the AI at its most careful setting. A page that repeats an existing article becomes a merge suggestion instead. Pages already imported are skipped, so you can run it again after picking more.
              </p>
              <p className="mt-2 text-xs text-foreground/85" data-testid="confluence-import-state" aria-live="polite">{importLine(view.importState)}</p>
            </div>
            {canManage && (
              <button type="button" className={`${btn} shrink-0`} disabled={busy !== null || importing || !view.configured || !hasSaved || dirty} onClick={importNow}>
                {importing ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CloudDownload className="h-4 w-4" aria-hidden="true" />}
                {importing ? 'Importing…' : 'Run import now'}
              </button>
            )}
          </SettingsRow>

          {/* Nightly check */}
          <SettingsRow>
            <Switch
              id="cf-nightly"
              checked={view.enabled}
              disabled={!canManage || busy !== null || (!view.enabled && (!view.configured || !view.importedAt))}
              onCheckedChange={setNightly}
              aria-label="Check Confluence every night"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="cf-nightly" className="block cursor-pointer">
                <span className="block text-sm font-medium text-foreground">Check Confluence every night</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  Changed, new and deleted pages in the picked sections become suggestions in the Inbox for people with the skill. Nothing changes until someone accepts. When an article was edited here, Ticket Pulse wins and the suggestion says so.
                </span>
              </label>
              <p className="mt-2 text-xs text-foreground/85" data-testid="confluence-nightly-state">
                {view.waiting ? `${view.waiting} from Confluence waiting in the Inbox. ` : ''}
                {view.lastNightly?.at ? `Last check ${timeAgo(view.lastNightly.at)}${view.lastNightly.error ? `: ${view.lastNightly.error}` : `: ${runCounts({ kind: 'nightly', counts: view.lastNightly.counts })}`}` : (view.importedAt ? 'Not checked yet.' : 'Run the one-time import first.')}
              </p>
            </div>
            <span className={`hidden shrink-0 text-xs font-medium sm:block ${view.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>{view.enabled ? 'On' : 'Off'}</span>
          </SettingsRow>

          {/* Run history */}
          <SettingsRow>
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-sm font-medium text-foreground">Run history</p>
              <RunHistory runs={runs} />
            </div>
          </SettingsRow>
        </>
      )}
      {(error || message) && (
        <SettingsRow>
          {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : <p className="text-xs text-foreground/85" role="status">{message}</p>}
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

export default ConfluenceSettings;
