import { useCallback, useEffect, useState } from 'react';
import {
  Ban, Bot, CalendarDays, CheckCircle, Loader, Plus, RefreshCw, Save, Trash2, UserPlus,
} from 'lucide-react';
import { calendarLeaveAPI, visualsAPI } from '../../services/api';

const DEFAULT_CONFIG = {
  mailbox: 'accounting@bgcengineering.ca',
  graphGroupId: '1a328f31-4d1d-41fc-afb1-955a7193617d',
  timezone: 'America/Vancouver',
  syncEnabled: true,
  lookbackDays: 7,
  horizonDays: 90,
};

const EMPTY_RULE = {
  name: '',
  priority: 100,
  pattern: '',
  category: 'OFF',
  halfDayPart: '',
  isActive: true,
};

function formatDateTime(value) {
  if (!value) return 'Never';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return 'Unknown';
  }
}

export default function CalendarLeavePanel() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [rules, setRules] = useState([]);
  const [aliases, setAliases] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [newAlias, setNewAlias] = useState({ alias: '', technicianId: '', isIgnored: false });
  const [newRule, setNewRule] = useState(EMPTY_RULE);
  const [preview, setPreview] = useState(null);
  const [lastPreviewMode, setLastPreviewMode] = useState(false);
  const [reviewRows, setReviewRows] = useState([]);
  const [reviewSummary, setReviewSummary] = useState(null);
  const [reviewFilter, setReviewFilter] = useState('review');
  const [reviewSelections, setReviewSelections] = useState({});
  const [reviewEdits, setReviewEdits] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);

  const loadReviewRows = useCallback(async (statusFilter = reviewFilter) => {
    const res = await calendarLeaveAPI.getReviewRows({ status: statusFilter, limit: 250 });
    setReviewRows(res.data || []);
  }, [reviewFilter]);

  const loadReviewSummary = useCallback(async () => {
    const res = await calendarLeaveAPI.getReviewSummary();
    setReviewSummary(res.data || null);
  }, []);

  const refresh = useCallback(async () => {
    const [configRes, rulesRes, aliasesRes, agentsRes, reviewRes, summaryRes] = await Promise.allSettled([
      calendarLeaveAPI.getConfig(),
      calendarLeaveAPI.getRules(),
      calendarLeaveAPI.getAliases(),
      visualsAPI.getAgents({ includeInactive: true }),
      calendarLeaveAPI.getReviewRows({ status: reviewFilter, limit: 250 }),
      calendarLeaveAPI.getReviewSummary(),
    ]);
    if (configRes.status === 'fulfilled' && configRes.value?.data) {
      setConfig({ ...DEFAULT_CONFIG, ...configRes.value.data });
    }
    if (rulesRes.status === 'fulfilled') setRules(rulesRes.value?.data || []);
    if (aliasesRes.status === 'fulfilled') setAliases(aliasesRes.value?.data || []);
    if (agentsRes.status === 'fulfilled') {
      const agents = agentsRes.value?.data?.agents || [];
      setTechnicians(agents.map((t) => ({
        id: t.id,
        name: t.name,
        email: t.email,
        isActive: t.isActive,
      })));
    }
    if (reviewRes.status === 'fulfilled') setReviewRows(reviewRes.value?.data || []);
    if (summaryRes.status === 'fulfilled') setReviewSummary(summaryRes.value?.data || null);
    setLoadingInitial(false);
  }, [reviewFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => { loadReviewRows(reviewFilter).catch(() => {}); }, [loadReviewRows, reviewFilter]);

  const saveConfig = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await calendarLeaveAPI.updateConfig(config);
      await calendarLeaveAPI.seedDefaults();
      await refresh();
      setStatus({ ok: true, text: 'Calendar source saved and defaults seeded' });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const ensureConfigSaved = async () => {
    if (config?.id) return;
    if (!config.mailbox || !config.graphGroupId) {
      throw new Error('Mailbox and Graph Group ID are required');
    }
    await calendarLeaveAPI.updateConfig(config);
    await calendarLeaveAPI.seedDefaults();
    await refresh();
  };

  const saveRule = async (rule) => {
    setBusy(true);
    try {
      await calendarLeaveAPI.saveRule(rule);
      setNewRule(EMPTY_RULE);
      await refresh();
      if (preview) await runPreview(lastPreviewMode);
    } finally {
      setBusy(false);
    }
  };

  const saveAlias = async () => {
    if (!newAlias.alias.trim()) return;
    setBusy(true);
    try {
      await calendarLeaveAPI.saveAlias({
        alias: newAlias.alias.trim(),
        technicianId: newAlias.isIgnored ? null : Number(newAlias.technicianId) || null,
        isIgnored: newAlias.isIgnored,
      });
      setNewAlias({ alias: '', technicianId: '', isIgnored: false });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (useLlm = false) => {
    setBusy(true);
    setStatus(null);
    try {
      await ensureConfigSaved();
      const res = await calendarLeaveAPI.preview({
        useLlm,
        top: 300,
      });
      setPreview(res.data);
      setLastPreviewMode(useLlm);
      await Promise.all([loadReviewRows(reviewFilter), loadReviewSummary()]);
      const llmText = useLlm
        ? `, Haiku: ${res.data.llmFreshCalls || 0} new / ${res.data.llmCacheHits || 0} cached${res.data.llmSkipped ? ` / ${res.data.llmSkipped} skipped` : ''}`
        : '';
      setStatus({ ok: true, text: `Preview loaded: ${res.data.total} events, ${res.data.reviewNeeded} need review${llmText}` });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const saveReviewAlias = async (row, { isIgnored = false } = {}) => {
    const alias = (row.personAlias || row.nameGuess || '').trim();
    if (!alias) return;
    const selectedTechId = reviewSelections[row.eventFingerprint || row.subject];
    if (!isIgnored && !selectedTechId) return;
    setBusy(true);
    setStatus(null);
    try {
      await calendarLeaveAPI.saveAlias({
        alias,
        technicianId: isIgnored ? null : Number(selectedTechId),
        isIgnored,
      });
      await refresh();
      await runPreview(lastPreviewMode);
      setStatus({ ok: true, text: isIgnored ? `Ignored "${alias}" and refreshed preview` : `Mapped "${alias}" and refreshed preview` });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const runSync = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await ensureConfigSaved();
      const res = await calendarLeaveAPI.sync({ useLlm: true });
      setPreview(res.data);
      setLastPreviewMode(true);
      await Promise.all([loadReviewRows(reviewFilter), loadReviewSummary()]);
      setStatus({ ok: true, text: `Sync complete: ${res.data.leaveDaysCreated} leave-days, ${res.data.reviewNeeded} review-needed events. Review list loaded below.` });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const saveManualDecision = async (row, { isIgnored = false } = {}) => {
    const key = row.eventFingerprint || row.subject;
    const rowEdit = reviewEdits[key] || {};
    const selectedTechId = reviewSelections[key] || row.technicianId;
    if (!isIgnored && !selectedTechId) return;
    setBusy(true);
    setStatus(null);
    try {
      const selectedTech = technicians.find((t) => String(t.id) === String(selectedTechId));
      await calendarLeaveAPI.saveReviewDecision({
        eventFingerprint: row.eventFingerprint,
        graphEventId: row.graphEventId,
        subject: row.subject,
        start: row.start,
        end: row.end,
        isAllDay: row.isAllDay,
        nameGuess: row.nameGuess,
        personAlias: row.personAlias,
        technicianId: isIgnored ? null : Number(selectedTechId),
        technicianName: selectedTech?.name || row.technicianName || null,
        category: isIgnored ? 'IGNORED' : (rowEdit.category || row.category || 'OFF'),
        halfDayPart: rowEdit.halfDayPart ?? row.halfDayPart ?? null,
        isIgnored,
      });
      await Promise.all([loadReviewRows(reviewFilter), loadReviewSummary()]);
      if (preview) await runPreview(lastPreviewMode);
      setStatus({ ok: true, text: isIgnored ? `Ignored event "${row.subject}"` : `Approved event "${row.subject}"` });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const visibleRows = preview?.rows?.length ? preview.rows : reviewRows;
  const filterLabel = {
    review: 'review-needed',
    manual: 'manual fixes',
    all: 'recent saved',
  }[reviewFilter] || 'saved';
  const visibleSummary = preview
    ? `${preview.matched || 0} matched · ${preview.reviewNeeded || 0} review · ${preview.ignored || 0} ignored`
    : `${reviewRows.length} ${filterLabel} rows`;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-sky-100 rounded-lg">
          <CalendarDays className="w-5 h-5 text-sky-700" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Shared Calendar Leave</h3>
          <p className="text-sm text-gray-500">Sync Accounting shared mailbox calendar entries into availability.</p>
        </div>
        <button onClick={() => runPreview(false)} disabled={busy} className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm">
          {busy ? <Loader className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Preview
        </button>
        <button onClick={() => runPreview(true)} disabled={busy} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm">
          <Bot className="w-4 h-4" />
          Preview + Haiku
        </button>
        <button onClick={runSync} disabled={busy} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-700 text-white text-sm">
          <Save className="w-4 h-4" />
          Sync
        </button>
      </div>

      {status && (
        <div className={`p-3 rounded-lg border text-sm ${status.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
          {status.text}
        </div>
      )}

      {loadingInitial && (
        <div className="rounded-lg border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-800 flex items-center gap-2">
          <Loader className="h-4 w-4 animate-spin" />
          Loading aliases, detection rules, and saved calendar review history...
        </div>
      )}

      {reviewSummary && (
        <div className="grid gap-3 md:grid-cols-5">
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium text-gray-500">Needs Review</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{reviewSummary.reviewNeeded || 0}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium text-gray-500">Manual Fixes</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{reviewSummary.manual || 0}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium text-gray-500">Saved Events</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{reviewSummary.classificationCount || 0}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium text-gray-500">Aliases / Rules</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{reviewSummary.aliasCount || 0} / {reviewSummary.ruleCount || 0}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium text-gray-500">Last Sync</div>
            <div className="mt-1 text-sm font-semibold text-gray-900">{formatDateTime(reviewSummary.lastSyncAt)}</div>
          </div>
        </div>
      )}

      <div className="bg-white border rounded-lg p-4 grid md:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="block font-medium text-gray-700 mb-1">Mailbox</span>
          <input className="w-full border rounded-lg px-3 py-2" value={config.mailbox || ''} onChange={(e) => setConfig({ ...config, mailbox: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 mb-1">Graph Group ID</span>
          <input className="w-full border rounded-lg px-3 py-2 font-mono text-xs" value={config.graphGroupId || ''} onChange={(e) => setConfig({ ...config, graphGroupId: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 mb-1">Timezone</span>
          <input className="w-full border rounded-lg px-3 py-2" value={config.timezone || ''} onChange={(e) => setConfig({ ...config, timezone: e.target.value })} />
        </label>
        <div className="flex items-end gap-3">
          <label className="text-sm flex-1">
            <span className="block font-medium text-gray-700 mb-1">Window</span>
            <div className="flex gap-2">
              <input type="number" className="w-full border rounded-lg px-3 py-2" value={config.lookbackDays || 7} onChange={(e) => setConfig({ ...config, lookbackDays: Number(e.target.value) })} />
              <input type="number" className="w-full border rounded-lg px-3 py-2" value={config.horizonDays || 90} onChange={(e) => setConfig({ ...config, horizonDays: Number(e.target.value) })} />
            </div>
          </label>
          <button onClick={saveConfig} disabled={busy} className="px-3 py-2 rounded-lg bg-gray-900 text-white text-sm">Save</button>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="bg-white border rounded-lg p-4 space-y-3">
          <h4 className="font-semibold text-gray-900">Aliases</h4>
          <div className="flex gap-2">
            <input className="border rounded-lg px-3 py-2 text-sm flex-1" placeholder="Alias, e.g. Ben" value={newAlias.alias} onChange={(e) => setNewAlias({ ...newAlias, alias: e.target.value })} />
            <select className="border rounded-lg px-2 py-2 text-sm" value={newAlias.technicianId} onChange={(e) => setNewAlias({ ...newAlias, technicianId: e.target.value })} disabled={newAlias.isIgnored}>
              <option value="">Technician</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={newAlias.isIgnored} onChange={(e) => setNewAlias({ ...newAlias, isIgnored: e.target.checked })} />
              Ignore
            </label>
            <button onClick={saveAlias} className="p-2 border rounded-lg"><Plus className="w-4 h-4" /></button>
          </div>
          <div className="max-h-72 overflow-auto divide-y text-sm">
            {aliases.map((a) => (
              <div key={a.id} className="py-2 flex items-center gap-2">
                <span className="font-medium">{a.alias}</span>
                <span className="text-gray-500">{a.isIgnored ? 'ignored' : a.technician?.name || 'unmatched'}</span>
                <button onClick={async () => { await calendarLeaveAPI.deleteAlias(a.id); await refresh(); }} className="ml-auto text-red-500"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border rounded-lg p-4 space-y-3">
          <h4 className="font-semibold text-gray-900">Detection Rules</h4>
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Rule name" value={newRule.name} onChange={(e) => setNewRule({ ...newRule, name: e.target.value })} />
            <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Regex pattern" value={newRule.pattern} onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })} />
            <select className="border rounded-lg px-2 py-2 text-sm" value={newRule.category} onChange={(e) => setNewRule({ ...newRule, category: e.target.value })}>
              <option value="OFF">OFF</option>
              <option value="WFH">WFH</option>
              <option value="OTHER">OTHER</option>
              <option value="IGNORED">IGNORED</option>
            </select>
            <select className="border rounded-lg px-2 py-2 text-sm" value={newRule.halfDayPart || ''} onChange={(e) => setNewRule({ ...newRule, halfDayPart: e.target.value })}>
              <option value="">Full/infer from event</option>
              <option value="INFER">Infer half-day</option>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
            <button onClick={() => saveRule(newRule)} className="col-span-2 px-3 py-2 rounded-lg border text-sm">Add Rule</button>
          </div>
          <div className="max-h-72 overflow-auto divide-y text-sm">
            {rules.map((r) => (
              <div key={r.id} className="py-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{r.category}{r.halfDayPart ? `/${r.halfDayPart}` : ''}</span>
                  <button onClick={async () => { await calendarLeaveAPI.deleteRule(r.id); await refresh(); }} className="ml-auto text-red-500"><Trash2 className="w-4 h-4" /></button>
                </div>
                <code className="text-xs text-gray-500 break-all">{r.pattern}</code>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(visibleRows || []).length === 0 && (
        <div className="bg-white border rounded-lg p-4 text-sm text-gray-600">
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle className="w-4 h-4 text-gray-400" />
            <span className="font-semibold text-gray-800">Review Queue</span>
            <span>
              {reviewFilter === 'review' && 'No unresolved review-needed calendar rows.'}
              {reviewFilter === 'manual' && 'No manual calendar fixes saved yet.'}
              {reviewFilter === 'all' && 'No saved calendar rows yet.'}
            </span>
            <button
              type="button"
              onClick={() => loadReviewRows(reviewFilter)}
              className="ml-auto rounded border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600"
            >
              Refresh Saved Reviews
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Use Preview or Sync to populate the latest result list. Use the filter on saved rows to switch between unresolved review items, manual fixes, and recent history.
          </p>
        </div>
      )}

      {(visibleRows || []).length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b flex flex-wrap items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600" />
            <span className="font-semibold text-sm">{preview ? 'Latest Preview / Sync Result' : 'Saved Review Queue'}</span>
            <span className="text-xs text-gray-500">{visibleSummary}</span>
            {preview?.llmApplied > 0 && (
              <span className="text-xs text-gray-500">
                Haiku {preview.llmFreshCalls || 0} new · {preview.llmCacheHits || 0} cached · {preview.durationMs || 0}ms
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <select
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value)}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs"
              >
                <option value="review">Saved review-needed</option>
                <option value="manual">Saved manual fixes</option>
                <option value="all">Saved all recent</option>
              </select>
              <button
                type="button"
                onClick={() => { setPreview(null); loadReviewRows(reviewFilter); }}
                className="rounded border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600"
              >
                Show Saved
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(visibleRows || []).slice(0, 160).map((row, idx) => {
              const key = row.eventFingerprint || row.subject;
              const rowEdit = reviewEdits[key] || {};
              return (
                <div key={`${key}-${idx}`} className={`px-4 py-2 text-sm ${row.requiresReview ? 'bg-amber-50' : ''}`}>
                  <div className="flex gap-2">
                    <span className="font-medium text-gray-900">{row.subject}</span>
                    <span className="ml-auto text-xs text-gray-500">{row.category}{row.halfDayPart ? `/${row.halfDayPart}` : ''}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {row.start?.dateTime} · {row.technicianName || row.personAlias || row.nameGuess || 'unmatched'}{row.technicianIsActive === false ? ' (inactive)' : ''} · {row.source === 'llm' && row.llmCached ? 'haiku cache' : row.source} · {Math.round((row.confidence || 0) * 100)}% · {row.reason}
                  </div>
                  {row.requiresReview && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-amber-800">Review {row.personAlias || row.nameGuess || 'entry'}</span>
                      <select
                        value={reviewSelections[key] || ''}
                        onChange={(e) => setReviewSelections(prev => ({ ...prev, [key]: e.target.value }))}
                        className="rounded border border-amber-200 bg-white px-2 py-1 text-xs"
                      >
                        <option value="">Map to technician</option>
                        {technicians.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}{t.isActive === false ? ' (inactive)' : ''}
                          </option>
                        ))}
                      </select>
                      <select
                        value={rowEdit.category || row.category || 'OFF'}
                        onChange={(e) => setReviewEdits(prev => ({ ...prev, [key]: { ...prev[key], category: e.target.value } }))}
                        className="rounded border border-gray-200 bg-white px-2 py-1 text-xs"
                      >
                        <option value="OFF">Off</option>
                        <option value="WFH">WFH</option>
                        <option value="OTHER">Other leave</option>
                      </select>
                      <select
                        value={rowEdit.halfDayPart ?? row.halfDayPart ?? ''}
                        onChange={(e) => setReviewEdits(prev => ({ ...prev, [key]: { ...prev[key], halfDayPart: e.target.value || null } }))}
                        className="rounded border border-gray-200 bg-white px-2 py-1 text-xs"
                      >
                        <option value="">Full / infer</option>
                        <option value="AM">AM</option>
                        <option value="PM">PM</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => saveReviewAlias(row)}
                        disabled={busy || !reviewSelections[key]}
                        className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-medium text-emerald-700 disabled:opacity-40"
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                      Map Alias
                      </button>
                      <button
                        type="button"
                        onClick={() => saveManualDecision(row)}
                        disabled={busy || !(reviewSelections[key] || row.technicianId) || row.category === 'IGNORED'}
                        className="inline-flex items-center gap-1 rounded border border-sky-200 bg-white px-2 py-1 text-xs font-medium text-sky-700 disabled:opacity-40"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                      Approve Event
                      </button>
                      <button
                        type="button"
                        onClick={() => saveReviewAlias(row, { isIgnored: true })}
                        disabled={busy || !(row.nameGuess || row.personAlias)}
                        className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 disabled:opacity-40"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      Ignore Name
                      </button>
                      <button
                        type="button"
                        onClick={() => saveManualDecision(row, { isIgnored: true })}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 disabled:opacity-40"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      Ignore Event
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
