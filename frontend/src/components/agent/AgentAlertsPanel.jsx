import { useCallback, useEffect, useState } from 'react';
import {
  BellRing, Flame, Loader2, Mail, MessageCircle, MessageSquare, Moon, Phone, Plus, Tag, TrendingUp, Trash2, X,
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

// One-click starter templates — they open the form pre-filled so the empty
// state teaches the feature and uses the space (QA 07-21 #5).
const PRESETS = [
  { key: 'urgent', Icon: Flame, tone: 'text-rose-500', label: 'Urgent tickets', desc: 'Any category · Urgent', draft: { ...EMPTY_DRAFT, priorityMin: '4', onCreated: true, label: 'Urgent tickets' } },
  { key: 'escalations', Icon: TrendingUp, tone: 'text-amber-500', label: 'Escalations', desc: 'When a ticket is escalated', draft: { ...EMPTY_DRAFT, onCreated: false, onPriorityRaised: true, label: 'Escalations' } },
  { key: 'category', Icon: Tag, tone: 'text-blue-500', label: 'A category', desc: 'Watch a category you own', draft: { ...EMPTY_DRAFT, onCreated: true } },
];

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

  if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground/75"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading your alerts…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300"><BellRing className="h-4 w-4" aria-hidden="true" /></span>
        <div>
          <h3 className="text-base font-bold text-foreground">My alerts</h3>
          <p className="text-xs text-muted-foreground">Get notified when tickets matching a category, tag, or priority come in — or when one escalates or is re-categorized into your scope. Bursts are grouped into one alert.</p>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2 text-xs text-red-700 dark:text-red-200" role="alert">{error}</div>}

      {/* Empty state with one-click starter templates */}
      {subs.length === 0 && !draft && (
        <div className="rounded-2xl border border-border bg-gradient-to-b from-muted/50 to-card p-5 text-center">
          <span className="mx-auto mb-2 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-500/15 text-blue-500"><BellRing className="h-5 w-5" aria-hidden="true" /></span>
          <p className="text-sm font-semibold text-foreground/85">No alerts yet</p>
          <p className="mx-auto mt-0.5 max-w-sm text-xs text-muted-foreground/75">Get a heads-up the moment tickets you care about arrive or change. Start from a template:</p>
          <div className="mx-auto mt-3 grid max-w-lg gap-2 sm:grid-cols-3">
            {PRESETS.map(({ key, Icon, tone, label, desc, draft: preset }) => (
              <button
                key={key}
                type="button"
                onClick={() => setDraft({ ...preset })}
                className="tp-focus-ring group flex flex-col items-center gap-1 rounded-xl border border-border bg-card px-3 py-3 text-center transition hover:-translate-y-0.5 hover:border-blue-200 dark:hover:border-blue-500/30 hover:shadow-sm"
              >
                <Icon className={`h-5 w-5 ${tone}`} aria-hidden="true" />
                <span className="text-xs font-semibold text-foreground/85">{label}</span>
                <span className="text-[11px] leading-tight text-muted-foreground/75">{desc}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setDraft({ ...EMPTY_DRAFT })} className="tp-focus-ring mt-3 text-xs font-semibold text-blue-600 dark:text-blue-300 hover:underline">
            or build one from scratch →
          </button>
        </div>
      )}

      {/* Subscriptions */}
      <ul className={subs.length ? 'space-y-2' : 'hidden'}>
        {subs.map((sub) => (
          <li key={sub.id} className={`rounded-xl border px-3.5 py-3 ${sub.isActive ? 'border-border bg-card' : 'border-border bg-muted/35'}`}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-foreground">{sub.label || scopeText(sub)}</span>
                  {sub.label && <span className="text-xs text-muted-foreground/75">({scopeText(sub)})</span>}
                  {!sub.isActive && <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">Paused</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>Alert on: <b className="font-semibold text-muted-foreground">{triggerText(sub)}</b></span>
                  <span className="flex items-center gap-1.5">
                    {sub.channelEmail && <Mail className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelSms && <MessageSquare className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelWhatsapp && <MessageCircle className="h-3 w-3" aria-hidden="true" />}
                    {sub.channelPhone && <Phone className="h-3 w-3" aria-hidden="true" />}
                  </span>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button onClick={() => toggleActive(sub)} className="tp-focus-ring rounded px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted" title={sub.isActive ? 'Pause' : 'Resume'}>{sub.isActive ? 'Pause' : 'Resume'}</button>
                <button onClick={() => setDraft({ ...EMPTY_DRAFT, ...sub, categoryId: sub.categoryId ?? '', tagId: sub.tagId ?? '', priorityMin: sub.priorityMin ?? '', label: sub.label || '' })} className="tp-focus-ring rounded px-2 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15">Edit</button>
                <button onClick={() => remove(sub.id)} aria-label="Delete alert" className="tp-focus-ring rounded p-1 text-muted-foreground/50 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Draft form */}
      {draft ? (
        <div className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/10 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{draft.id ? 'Edit alert' : 'New alert'}</span>
            <button onClick={() => setDraft(null)} aria-label="Cancel" className="tp-focus-ring rounded p-1 text-muted-foreground/75 hover:text-muted-foreground"><X className="h-4 w-4" aria-hidden="true" /></button>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-3">
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-muted-foreground">Category</span>
              <select value={draft.categoryId} onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm">
                <option value="">Any category</option>
                {options.categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-muted-foreground">Tag</span>
              <select value={draft.tagId} onChange={(e) => setDraft((d) => ({ ...d, tagId: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm">
                <option value="">Any tag</option>
                {options.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-semibold text-muted-foreground">Priority</span>
              <select value={draft.priorityMin} onChange={(e) => setDraft((d) => ({ ...d, priorityMin: e.target.value }))} className="tp-focus-ring w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm">
                {PRIORITY_MIN.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>

          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Alert me when a matching ticket…</span>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onCreated} onChange={(e) => setDraft((d) => ({ ...d, onCreated: e.target.checked }))} className="tp-focus-ring" /> arrives (new)</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onPriorityRaised} onChange={(e) => setDraft((d) => ({ ...d, onPriorityRaised: e.target.checked }))} className="tp-focus-ring" /> is escalated (priority raised)</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.onRecategorized} onChange={(e) => setDraft((d) => ({ ...d, onRecategorized: e.target.checked }))} className="tp-focus-ring" /> is re-categorized into scope</label>
            </div>
          </div>

          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Deliver via</span>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {CH.map(({ key, Icon, label, ready, blockReason }) => (
                <label key={key} className={`flex items-center gap-1.5 ${!ready ? 'text-muted-foreground/50' : ''}`} title={!ready ? `Unavailable — ${blockReason}` : undefined}>
                  <input type="checkbox" checked={draft[key]} disabled={!ready} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} className="tp-focus-ring" />
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
                </label>
              ))}
            </div>
            {!readiness.phoneVerified && (draft.channelSms || draft.channelWhatsapp || draft.channelPhone) && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">Verify a phone number in the Notifications tab to use SMS, WhatsApp, or phone-call alerts.</p>
            )}
          </div>

          <label className="mt-3 block">
            <span className="mb-0.5 block text-[11px] font-semibold text-muted-foreground">Name (optional)</span>
            <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} placeholder="e.g. Licensing escalations" className="tp-focus-ring w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm" />
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={save} disabled={saving} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} {draft.id ? 'Save' : 'Create alert'}
            </button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
          </div>
        </div>
      ) : subs.length > 0 ? (
        <button onClick={() => setDraft({ ...EMPTY_DRAFT })} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add an alert
        </button>
      ) : null}

      {/* Quiet hours */}
      <div className="rounded-xl border border-border bg-card p-3.5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={quietHours.enabled} onChange={(e) => saveQuiet({ ...quietHours, enabled: e.target.checked })} className="tp-focus-ring" />
          <Moon className="h-3.5 w-3.5 text-muted-foreground/75" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground/85">Quiet hours</span>
        </label>
        {quietHours.enabled && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Mute alerts from</span>
            <input type="time" value={quietHours.start || ''} onChange={(e) => saveQuiet({ ...quietHours, start: e.target.value })} className="tp-focus-ring rounded-lg border border-border px-2 py-1" />
            <span>to</span>
            <input type="time" value={quietHours.end || ''} onChange={(e) => saveQuiet({ ...quietHours, end: e.target.value })} className="tp-focus-ring rounded-lg border border-border px-2 py-1" />
            <span className="text-muted-foreground/75">(your local time; alerts queue and deliver after)</span>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={quietHours.allowUrgent} onChange={(e) => saveQuiet({ ...quietHours, allowUrgent: e.target.checked })} className="tp-focus-ring" /> let Urgent through</label>
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/75"><Tag className="h-3 w-3" aria-hidden="true" /> Alerts cover any matching ticket in your workspace, not just ones assigned to you.</p>
    </div>
  );
}
