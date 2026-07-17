import { useCallback, useEffect, useState } from 'react';
import {
  BellRing, Loader2, Mail, MessageCircle, MessageSquare, Moon, Phone, Plus, Tag, Trash2, X,
} from 'lucide-react';
import { agentAPI } from '../../services/api';

const PRIORITY_MIN = [
  { value: '', label: 'Any priority' },
  { value: '3', label: 'High and Urgent only' },
  { value: '4', label: 'Urgent only' },
];

const EMPTY_DRAFT = {
  categoryId: '', tagId: '', priorityMin: '',
  onCreated: true, onPriorityRaised: false, onRecategorized: false,
  channelEmail: true, channelSms: false, channelWhatsapp: false, channelPhone: false,
  label: '',
};

/**
 * Custom agent alerts (agent portal). An agent subscribes to a category /
 * subcategory / tag / priority and picks which events fire and which channels
 * deliver. Alerts are coalesced server-side to survive ticket storms.
 */
export default function AgentAlertsPanel({ workspaceId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [subs, setSubs] = useState([]);
  const [quietHours, setQuietHours] = useState({ enabled: false, start: '', end: '', allowUrgent: true });
  const [readiness, setReadiness] = useState({ email: false, phoneVerified: false });
  const [options, setOptions] = useState({ categories: [], tags: [] });
  const [draft, setDraft] = useState(null); // null = form hidden

  const wsParams = workspaceId ? { workspaceId } : {};

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [alertsRes, optsRes] = await Promise.all([
        agentAPI.getAlerts(wsParams),
        agentAPI.getAlertOptions(wsParams),
      ]);
      const d = alertsRes?.data?.data || alertsRes?.data || {};
      setSubs(d.subscriptions || []);
      setQuietHours(d.quietHours || { enabled: false, start: '', end: '', allowUrgent: true });
      setReadiness(d.channelReadiness || { email: false, phoneVerified: false });
      setOptions(optsRes?.data?.data || optsRes?.data || { categories: [], tags: [] });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const payload = { ...draft, workspaceId };
      if (draft.id) await agentAPI.updateAlert(draft.id, payload);
      else await agentAPI.createAlert(payload);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setSaving(false);
  };

  const remove = async (id) => {
    setError(null);
    try { await agentAPI.deleteAlert(id, wsParams); await load(); }
    catch (err) { setError(err.response?.data?.message || err.message); }
  };

  const toggleActive = async (sub) => {
    setError(null);
    try { await agentAPI.updateAlert(sub.id, { isActive: !sub.isActive, workspaceId }); await load(); }
    catch (err) { setError(err.response?.data?.message || err.message); }
  };

  const saveQuiet = async (next) => {
    setQuietHours(next);
    try { await agentAPI.saveAlertQuietHours({ ...next, workspaceId }); }
    catch (err) { setError(err.response?.data?.message || err.message); }
  };

  const scopeText = (sub) => {
    const parts = [];
    if (sub.categoryName) parts.push(sub.categoryName);
    if (sub.tagName) parts.push(`#${sub.tagName}`);
    if (sub.priorityMin === 4) parts.push('Urgent');
    else if (sub.priorityMin === 3) parts.push('High+');
    return parts.join(' · ') || 'All tickets';
  };
  const triggerText = (sub) => [
    sub.onCreated && 'new', sub.onPriorityRaised && 'escalated', sub.onRecategorized && 're-categorized',
  ].filter(Boolean).join(', ');

  const CH = [
    { key: 'channelEmail', Icon: Mail, label: 'Email', ready: readiness.email, blockReason: 'no email on your profile' },
    { key: 'channelSms', Icon: MessageSquare, label: 'SMS', ready: readiness.phoneVerified, blockReason: 'verify a phone in Notifications' },
    { key: 'channelWhatsapp', Icon: MessageCircle, label: 'WhatsApp', ready: readiness.phoneVerified, blockReason: 'verify a phone in Notifications' },
    { key: 'channelPhone', Icon: Phone, label: 'Phone call', ready: readiness.phoneVerified, blockReason: 'verify a phone in Notifications' },
  ];

  if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading your alerts…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><BellRing className="h-4 w-4" aria-hidden="true" /></span>
        <div>
          <h3 className="text-base font-bold text-slate-900">My alerts</h3>
          <p className="text-xs text-slate-500">Get notified when tickets matching a category, tag, or priority come in — or when one escalates or is re-categorized into your scope. Bursts are grouped into one alert.</p>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</div>}

      {/* Subscriptions */}
      <ul className="space-y-2">
        {subs.length === 0 && !draft && (
          <li className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">No alerts yet — add one below.</li>
        )}
        {subs.map((sub) => (
          <li key={sub.id} className={`rounded-xl border px-3.5 py-3 ${sub.isActive ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50/70'}`}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-slate-800">{sub.label || scopeText(sub)}</span>
                  {sub.label && <span className="text-xs text-slate-400">({scopeText(sub)})</span>}
                  {!sub.isActive && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Paused</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span>Alert on: <b className="font-semibold text-slate-600">{triggerText(sub)}</b></span>
                  <span className="flex items-center gap-1.5">
                    {sub.channelEmail && <Mail className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelSms && <MessageSquare className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelWhatsapp && <MessageCircle className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelPhone && <Phone className="h-3 w-3" aria-hidden="true" />}
                  </span>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button onClick={() => toggleActive(sub)} className="tp-focus-ring rounded px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100" title={sub.isActive ? 'Pause' : 'Resume'}>{sub.isActive ? 'Pause' : 'Resume'}</button>
                <button onClick={() => setDraft({ ...EMPTY_DRAFT, ...sub, categoryId: sub.categoryId ?? '', tagId: sub.tagId ?? '', priorityMin: sub.priorityMin ?? '', label: sub.label || '' })} className="tp-focus-ring rounded px-2 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50">Edit</button>
                <button onClick={() => remove(sub.id)} aria-label="Delete alert" className="tp-focus-ring rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Draft form */}
      {draft ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{draft.id ? 'Edit alert' : 'New alert'}</span>
            <button onClick={() => setDraft(null)} aria-label="Cancel" className="tp-focus-ring rounded p-1 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" aria-hidden="true" /></button>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-3">
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-slate-500">Category</span>
              <select value={draft.categoryId} onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                <option value="">Any category</option>
                {options.categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-slate-500">Tag</span>
              <select value={draft.tagId} onChange={(e) => setDraft((d) => ({ ...d, tagId: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                <option value="">Any tag</option>
                {options.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-slate-500">Priority</span>
              <select value={draft.priorityMin} onChange={(e) => setDraft((d) => ({ ...d, priorityMin: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                {PRIORITY_MIN.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>

          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Alert me when a matching ticket…</span>
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onCreated} onChange={(e) => setDraft((d) => ({ ...d, onCreated: e.target.checked }))} className="tp-focus-ring" /> arrives (new)</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onPriorityRaised} onChange={(e) => setDraft((d) => ({ ...d, onPriorityRaised: e.target.checked }))} className="tp-focus-ring" /> is escalated (priority raised)</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onRecategorized} onChange={(e) => setDraft((d) => ({ ...d, onRecategorized: e.target.checked }))} className="tp-focus-ring" /> is re-categorized into scope</label>
            </div>
          </div>

          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Deliver via</span>
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              {CH.map(({ key, Icon, label, ready, blockReason }) => (
                <label key={key} className={`flex items-center gap-1.5 ${!ready ? 'text-slate-300' : ''}`} title={!ready ? `Unavailable — ${blockReason}` : undefined}>
                  <input type="checkbox" checked={draft[key]} disabled={!ready} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} className="tp-focus-ring" />
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
                </label>
              ))}
            </div>
            {!readiness.phoneVerified && (draft.channelSms || draft.channelWhatsapp || draft.channelPhone) && (
              <p className="mt-1 text-[11px] text-amber-600">Verify a phone number in the Notifications tab to use SMS, WhatsApp, or phone-call alerts.</p>
            )}
          </div>

          <label className="mt-3 block">
            <span className="mb-0.5 block text-[11px] font-semibold text-slate-500">Name (optional)</span>
            <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} placeholder="e.g. Licensing escalations" className="tp-focus-ring w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm" />
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={save} disabled={saving} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} {draft.id ? 'Save' : 'Create alert'}
            </button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ ...EMPTY_DRAFT })} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add an alert
        </button>
      )}

      {/* Quiet hours */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={quietHours.enabled} onChange={(e) => saveQuiet({ ...quietHours, enabled: e.target.checked })} className="tp-focus-ring" />
          <Moon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          <span className="text-sm font-semibold text-slate-700">Quiet hours</span>
        </label>
        {quietHours.enabled && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>Mute alerts from</span>
            <input type="time" value={quietHours.start || ''} onChange={(e) => saveQuiet({ ...quietHours, start: e.target.value })} className="tp-focus-ring rounded-lg border border-slate-200 px-2 py-1" />
            <span>to</span>
            <input type="time" value={quietHours.end || ''} onChange={(e) => saveQuiet({ ...quietHours, end: e.target.value })} className="tp-focus-ring rounded-lg border border-slate-200 px-2 py-1" />
            <span className="text-slate-400">(your local time; alerts queue and deliver after)</span>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={quietHours.allowUrgent} onChange={(e) => saveQuiet({ ...quietHours, allowUrgent: e.target.checked })} className="tp-focus-ring" /> let Urgent through</label>
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><Tag className="h-3 w-3" aria-hidden="true" /> Alerts cover any matching ticket in your workspace, not just ones assigned to you.</p>
    </div>
  );
}
