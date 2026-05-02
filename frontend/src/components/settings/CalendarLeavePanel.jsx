import { useCallback, useEffect, useState } from 'react';
import {
  Bot, CalendarDays, CheckCircle, Loader, Plus, RefreshCw, Save, Trash2,
} from 'lucide-react';
import { calendarLeaveAPI, dashboardAPI } from '../../services/api';

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

export default function CalendarLeavePanel() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [rules, setRules] = useState([]);
  const [aliases, setAliases] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [newAlias, setNewAlias] = useState({ alias: '', technicianId: '', isIgnored: false });
  const [newRule, setNewRule] = useState(EMPTY_RULE);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [configRes, rulesRes, aliasesRes, dashboardRes] = await Promise.allSettled([
      calendarLeaveAPI.getConfig(),
      calendarLeaveAPI.getRules(),
      calendarLeaveAPI.getAliases(),
      dashboardAPI.getDashboard(),
    ]);
    if (configRes.status === 'fulfilled' && configRes.value?.data) {
      setConfig({ ...DEFAULT_CONFIG, ...configRes.value.data });
    }
    if (rulesRes.status === 'fulfilled') setRules(rulesRes.value?.data || []);
    if (aliasesRes.status === 'fulfilled') setAliases(aliasesRes.value?.data || []);
    if (dashboardRes.status === 'fulfilled') {
      setTechnicians((dashboardRes.value?.data?.technicians || []).map((t) => ({ id: t.id, name: t.name, email: t.email })));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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

  const saveRule = async (rule) => {
    setBusy(true);
    try {
      await calendarLeaveAPI.saveRule(rule);
      setNewRule(EMPTY_RULE);
      await refresh();
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
      const res = await calendarLeaveAPI.preview({ useLlm, top: 300 });
      setPreview(res.data);
      setStatus({ ok: true, text: `Preview loaded: ${res.data.total} events, ${res.data.reviewNeeded} need review` });
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
      const res = await calendarLeaveAPI.sync({ useLlm: true });
      setStatus({ ok: true, text: `Sync complete: ${res.data.leaveDaysCreated} leave-days, ${res.data.reviewNeeded} review-needed events` });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

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

      {preview && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600" />
            <span className="font-semibold text-sm">Preview</span>
            <span className="text-xs text-gray-500">{preview.matched} matched · {preview.reviewNeeded} review · {preview.ignored} ignored</span>
          </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(preview.rows || []).slice(0, 120).map((row, idx) => (
              <div key={`${row.subject}-${idx}`} className={`px-4 py-2 text-sm ${row.requiresReview ? 'bg-amber-50' : ''}`}>
                <div className="flex gap-2">
                  <span className="font-medium text-gray-900">{row.subject}</span>
                  <span className="ml-auto text-xs text-gray-500">{row.category}{row.halfDayPart ? `/${row.halfDayPart}` : ''}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {row.start?.dateTime} · {row.technicianName || row.nameGuess || 'unmatched'} · {row.source} · {Math.round((row.confidence || 0) * 100)}% · {row.reason}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
