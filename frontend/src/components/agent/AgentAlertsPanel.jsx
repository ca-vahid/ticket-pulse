import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing, Check, ChevronDown, Flame, Layers, Loader2, Mail, MessageCircle, MessageSquare, MessagesSquare, Moon, Pencil, Phone, Plus, Trash2, TrendingUp,
} from 'lucide-react';
import { agentAPI } from '../../services/api';
import AlertCategoryTree from './AlertCategoryTree';
import {
  PRIORITY_CHOICES, alertSentence, autoAlertName, categorySummary, draftProblem, indexCategoryTree, tidyCategoryIds,
} from './alertText';

/**
 * My alerts (Mail & alerts). An agent picks which tickets (several categories,
 * a whole top category, a priority, optionally a tag), when (new, priority
 * up, moved into these categories) and how (Teams, e-mail, SMS, WhatsApp,
 * phone). Bursts are grouped server-side into one message.
 */

const EMPTY_OPTIONS = { categories: [], tree: [], tags: [], teams: { available: false, connected: false }, mine: [] };

function Switch({ id, checked, onChange, disabled = false, label, labelledBy, small = false }) {
  const size = small ? 'h-5 w-9' : 'h-6 w-11';
  const knob = small ? 'h-4 w-4' : 'h-5 w-5';
  const shift = small ? 'translate-x-[18px]' : 'translate-x-[22px]';
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`tp-focus-ring relative inline-flex ${size} flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className={`inline-block ${knob} rounded-full bg-card shadow transition-transform ${checked ? shift : 'translate-x-0.5'}`} />
    </button>
  );
}

function newDraft(teamsReady, extra = {}) {
  return {
    id: null, label: '', categoryIds: [], tagId: '', priorityMin: '',
    onCreated: true, onPriorityRaised: false, onRecategorized: false,
    channelTeams: teamsReady, channelEmail: !teamsReady, channelSms: false, channelWhatsapp: false, channelPhone: false,
    isActive: true,
    ...extra,
  };
}

function draftFromSub(sub) {
  return {
    id: sub.id,
    label: sub.label || '',
    categoryIds: sub.categoryIds || (sub.categoryId ? [sub.categoryId] : []),
    tagId: sub.tagId ? String(sub.tagId) : '',
    priorityMin: sub.priorityMin ? String(sub.priorityMin) : '',
    onCreated: !!sub.onCreated,
    onPriorityRaised: !!sub.onPriorityRaised,
    onRecategorized: !!sub.onRecategorized,
    channelTeams: !!sub.channelTeams,
    channelEmail: !!sub.channelEmail,
    channelSms: !!sub.channelSms,
    channelWhatsapp: !!sub.channelWhatsapp,
    channelPhone: !!sub.channelPhone,
    isActive: sub.isActive !== false,
  };
}

const errText = (err) => err?.response?.data?.message || err?.message || 'Something went wrong';

export default function AgentAlertsPanel({ workspaceId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [subs, setSubs] = useState([]);
  const [quietHours, setQuietHours] = useState({ enabled: false, start: '', end: '', allowUrgent: true });
  const [readiness, setReadiness] = useState({ email: false, phoneVerified: false });
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [draft, setDraft] = useState(null); // null = editor closed
  const [editorError, setEditorError] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);

  const wsParams = workspaceId ? { workspaceId } : {};
  const index = useMemo(() => indexCategoryTree(options.tree), [options.tree]);
  const teamsReady = !!(options.teams?.available && options.teams?.connected);

  const loadOptions = useCallback(async () => {
    const res = await agentAPI.getAlertOptions(wsParams);
    const o = res?.data?.data || res?.data || {};
    setOptions({ ...EMPTY_OPTIONS, ...o, teams: o.teams || EMPTY_OPTIONS.teams, tree: o.tree || [], mine: o.mine || [] });
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wsParams is derived from workspaceId
  }, [workspaceId]);

  const loadAlerts = useCallback(async () => {
    const res = await agentAPI.getAlerts(wsParams);
    const d = res?.data?.data || res?.data || {};
    setSubs(d.subscriptions || []);
    setQuietHours(d.quietHours || { enabled: false, start: '', end: '', allowUrgent: true });
    setReadiness(d.channelReadiness || { email: false, phoneVerified: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wsParams is derived from workspaceId
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true); setError(null);
      try { await Promise.all([loadAlerts(), loadOptions()]); } catch (err) { if (live) setError(errText(err)); }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [loadAlerts, loadOptions]);

  /** Open the editor; refresh options so a Teams connection made above counts. */
  const openEditor = (next) => {
    setEditorError(null);
    setConfirmingId(null);
    setDraft(next);
    loadOptions().catch(() => {});
  };

  const startNew = (extra = {}) => openEditor(newDraft(teamsReady, extra));

  const STARTERS = [
    { key: 'urgent', Icon: Flame, label: 'Urgent tickets anywhere', extra: { priorityMin: '4' } },
    { key: 'escalated', Icon: TrendingUp, label: 'A ticket is escalated to High or Urgent', extra: { priorityMin: '3', onCreated: false, onPriorityRaised: true } },
    { key: 'mine', Icon: Layers, label: 'New tickets in my categories', extra: { categoryIds: tidyCategoryIds(options.mine, index) } },
  ];

  const save = async () => {
    const problem = draftProblem(draft);
    if (problem) { setEditorError(problem); return; }
    setSaving(true); setEditorError(null);
    const hasCats = draft.categoryIds.length > 0;
    const payload = {
      workspaceId,
      label: draft.label.trim() || null,
      categoryIds: draft.categoryIds,
      tagId: draft.tagId ? Number(draft.tagId) : null,
      priorityMin: draft.priorityMin ? Number(draft.priorityMin) : null,
      onCreated: draft.onCreated,
      onPriorityRaised: draft.onPriorityRaised,
      onRecategorized: hasCats && draft.onRecategorized,
      channelTeams: draft.channelTeams,
      channelEmail: draft.channelEmail,
      channelSms: draft.channelSms,
      channelWhatsapp: draft.channelWhatsapp,
      channelPhone: draft.channelPhone,
    };
    try {
      if (draft.id) await agentAPI.updateAlert(draft.id, payload);
      else await agentAPI.createAlert(payload);
      setDraft(null);
      await loadAlerts();
    } catch (err) {
      setEditorError(errText(err));
    }
    setSaving(false);
  };

  const remove = async (id) => {
    setError(null);
    try { await agentAPI.deleteAlert(id, wsParams); setConfirmingId(null); await loadAlerts(); } catch (err) { setError(errText(err)); }
  };

  const toggleActive = async (sub) => {
    setError(null);
    setSubs((list) => list.map((s) => (s.id === sub.id ? { ...s, isActive: !sub.isActive } : s)));
    try { await agentAPI.updateAlert(sub.id, { isActive: !sub.isActive, workspaceId }); await loadAlerts(); } catch (err) {
      setSubs((list) => list.map((s) => (s.id === sub.id ? { ...s, isActive: sub.isActive } : s)));
      setError(errText(err));
    }
  };

  const saveQuiet = async (next) => {
    setQuietHours(next);
    try { await agentAPI.saveAlertQuietHours({ ...next, workspaceId }); } catch (err) { setError(errText(err)); }
  };

  if (loading) {
    return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading your alerts…</div>;
  }

  const editor = draft && (
    <AlertEditor
      draft={draft}
      setDraft={setDraft}
      options={options}
      index={index}
      readiness={readiness}
      saving={saving}
      error={editorError}
      onSave={save}
      onCancel={() => { setDraft(null); setEditorError(null); }}
    />
  );

  return (
    <section className="tp-card rounded-xl border border-border p-4 sm:p-5" aria-labelledby="my-alerts-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300"><BellRing className="h-4 w-4" aria-hidden="true" /></span>
          <div>
            <h3 id="my-alerts-heading" className="text-base font-bold text-foreground">My alerts</h3>
            <p className="text-xs text-muted-foreground">Hear about tickets in the categories you care about, anywhere in your workspace. A burst arrives as one message.</p>
          </div>
        </div>
        {subs.length > 0 && !(draft && !draft.id) && (
          <button type="button" onClick={() => startNew()} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New alert
          </button>
        )}
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200" role="alert">{error}</div>}

      {/* A new alert opens at the top. */}
      {draft && !draft.id && <div className="mt-4">{editor}</div>}

      {subs.length === 0 && !draft && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">You have no alerts yet.</p>
          <button type="button" onClick={() => startNew()} className="tp-focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            <Plus className="h-4 w-4" aria-hidden="true" /> New alert
          </button>
          <p className="mt-4 text-xs text-muted-foreground">Or start from one of these:</p>
          <ul className="mt-1 space-y-0.5">
            {STARTERS.map(({ key, Icon, label, extra }) => (
              <li key={key}>
                <button type="button" onClick={() => startNew(extra)} className="tp-focus-ring inline-flex items-center gap-2 rounded px-1 py-1 text-sm text-primary hover:underline">
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {subs.length > 0 && (
        <ul className="mt-4 divide-y divide-border border-y border-border" aria-label="Your alerts">
          {subs.map((sub) => {
            if (draft?.id === sub.id) return <li key={sub.id} className="py-3">{editor}</li>;
            const sentence = alertSentence(sub, index);
            const labelId = `alert-${sub.id}-text`;
            return (
              <li key={sub.id} className="flex items-start gap-3 py-3">
                <div className="pt-0.5">
                  <Switch small checked={sub.isActive !== false} onChange={() => toggleActive(sub)} label={sub.isActive !== false ? 'Alert on — switch off to pause' : 'Alert paused — switch on to resume'} />
                </div>
                <div id={labelId} className={`min-w-0 flex-1 ${sub.isActive === false ? 'text-muted-foreground' : ''}`}>
                  {sub.label && <div className={`text-sm font-semibold ${sub.isActive === false ? '' : 'text-foreground'}`}>{sub.label}</div>}
                  <p className={sub.label ? 'text-xs text-muted-foreground' : `text-sm ${sub.isActive === false ? '' : 'text-foreground'}`}>{sentence}</p>
                </div>
                {confirmingId === sub.id ? (
                  <div className="flex flex-shrink-0 items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                    <span className="text-muted-foreground">Delete this alert?</span>
                    <button type="button" onClick={() => remove(sub.id)} className="tp-focus-ring rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700">Delete</button>
                    <button type="button" onClick={() => setConfirmingId(null)} className="tp-focus-ring rounded-md px-2 py-1 font-semibold text-muted-foreground hover:bg-muted">Keep</button>
                  </div>
                ) : (
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    <button type="button" onClick={() => openEditor(draftFromSub(sub))} aria-label="Edit alert" aria-describedby={labelId} className="tp-focus-ring rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button type="button" onClick={() => setConfirmingId(sub.id)} aria-label="Delete alert" aria-describedby={labelId} className="tp-focus-ring rounded-md p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Quiet hours */}
      <div className="mt-5 space-y-2.5">
        <div className="flex items-center gap-3">
          <Switch id="alerts-quiet" small checked={!!quietHours.enabled} onChange={(on) => saveQuiet({ ...quietHours, enabled: on })} labelledBy="alerts-quiet-label" />
          <span id="alerts-quiet-label" className="flex items-center gap-1.5 text-sm text-foreground">
            <Moon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> Quiet hours
          </span>
        </div>
        {quietHours.enabled && (
          <div className="space-y-2.5 pl-12">
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <span>Mute alerts from</span>
              <input type="time" aria-label="Quiet from" value={quietHours.start || ''} onChange={(e) => saveQuiet({ ...quietHours, start: e.target.value })} className="tp-focus-ring rounded-lg border border-input bg-card px-2 py-1 text-sm" />
              <span>to</span>
              <input type="time" aria-label="Quiet until" value={quietHours.end || ''} onChange={(e) => saveQuiet({ ...quietHours, end: e.target.value })} className="tp-focus-ring rounded-lg border border-input bg-card px-2 py-1 text-sm" />
            </div>
            <p className="text-xs text-muted-foreground">Your local time. Muted alerts arrive when quiet hours end. While you&rsquo;re on call, quiet hours are paused and everything comes through.</p>
            <div className="flex items-center gap-3">
              <Switch small checked={quietHours.allowUrgent !== false} onChange={(on) => saveQuiet({ ...quietHours, allowUrgent: on })} labelledBy="alerts-urgent-label" />
              <span id="alerts-urgent-label" className="text-sm text-foreground">Let Urgent through</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const CHANNELS = [
  { key: 'channelTeams', Icon: MessagesSquare, label: 'Teams' },
  { key: 'channelEmail', Icon: Mail, label: 'E-mail' },
  { key: 'channelSms', Icon: MessageSquare, label: 'SMS' },
  { key: 'channelWhatsapp', Icon: MessageCircle, label: 'WhatsApp' },
  { key: 'channelPhone', Icon: Phone, label: 'Phone call' },
];

function channelBlock(key, { teams, readiness }) {
  if (key === 'channelTeams') {
    if (!teams?.available) return 'Teams is not on in this workspace';
    if (!teams?.connected) return 'Connect Teams above';
    return null;
  }
  if (key === 'channelEmail') return readiness.email ? null : 'No e-mail on your profile';
  return readiness.phoneVerified ? null : 'Verify a phone first';
}

function AlertEditor({ draft, setDraft, options, index, readiness, saving, error, onSave, onCancel }) {
  const [moreOpen, setMoreOpen] = useState(!!draft.tagId);
  const [renaming, setRenaming] = useState(false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const hasCats = draft.categoryIds.length > 0;
  const tagName = options.tags.find((t) => String(t.id) === String(draft.tagId))?.name || null;
  const name = draft.label.trim() || autoAlertName({ ...draft, tagName }, index);
  const problem = draftProblem(draft);
  const headingId = `alert-editor-${draft.id || 'new'}`;

  const sectionTitle = 'text-sm font-semibold text-foreground';
  const whenRows = [
    { key: 'onCreated', text: 'A new ticket arrives' },
    { key: 'onPriorityRaised', text: 'Its priority goes up' },
    { key: 'onRecategorized', text: 'It is moved into these categories', disabled: !hasCats, hint: 'Pick categories first.' },
  ];

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-4" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-bold text-foreground">{draft.id ? 'Edit alert' : 'New alert'}</h4>

      {/* 1. Which tickets */}
      <div className="mt-3">
        <div className={sectionTitle}>Which tickets</div>
        <div className="mt-2">
          <AlertCategoryTree
            tree={options.tree}
            value={draft.categoryIds}
            onChange={(ids) => set({ categoryIds: tidyCategoryIds(ids, index) })}
            idPrefix={`alert-${draft.id || 'new'}-cat`}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-foreground" data-testid="alert-category-summary">{categorySummary(draft.categoryIds, index)}</span>
          {hasCats && <button type="button" onClick={() => set({ categoryIds: [], onRecategorized: false })} className="tp-focus-ring rounded text-primary hover:underline">Clear</button>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div role="radiogroup" aria-label="Priority" className="inline-flex rounded-lg border border-input bg-card p-0.5">
            {PRIORITY_CHOICES.map((p) => {
              const on = String(draft.priorityMin || '') === p.value;
              return (
                <button
                  key={p.value || 'any'}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ priorityMin: p.value })}
                  className={`tp-focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen} className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs text-primary hover:underline">
            More <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>
        {moreOpen && (
          <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span>Only tickets tagged</span>
            <select value={draft.tagId} onChange={(e) => set({ tagId: e.target.value })} className="tp-focus-ring rounded-lg border border-input bg-card px-2 py-1 text-sm">
              <option value="">Any tag</option>
              {options.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* 2. When */}
      <div className="mt-5">
        <div className={sectionTitle}>When</div>
        <ul className="mt-2 space-y-2">
          {whenRows.map(({ key, text, disabled, hint }) => {
            const id = `${headingId}-${key}`;
            return (
              <li key={key} className="flex items-center gap-3">
                <Switch id={id} small checked={!disabled && !!draft[key]} disabled={disabled} onChange={(on) => set({ [key]: on })} labelledBy={`${id}-label`} />
                <span id={`${id}-label`} className={`text-sm ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{text}</span>
                {disabled && hint && <span className="text-xs text-muted-foreground">{hint}</span>}
              </li>
            );
          })}
        </ul>
      </div>

      {/* 3. How */}
      <div className="mt-5">
        <div className={sectionTitle} id={`${headingId}-how`}>How</div>
        <div role="group" aria-labelledby={`${headingId}-how`} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {CHANNELS.map(({ key, Icon, label }) => {
            const on = !!draft[key];
            const reason = channelBlock(key, { teams: options.teams, readiness });
            const disabled = !!reason && !on; // an unavailable channel can still be switched off
            return (
              <div key={key}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => set({ [key]: !on })}
                  aria-describedby={reason ? `${headingId}-${key}-why` : undefined}
                  className={`tp-focus-ring relative flex w-full flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {on && <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-primary" aria-hidden="true" />}
                  <Icon className={`h-4 w-4 ${on ? 'text-primary' : ''}`} aria-hidden="true" />
                  {label}
                </button>
                {reason && <p id={`${headingId}-${key}-why`} className="mt-1 text-center text-[11px] leading-tight text-muted-foreground">{reason}</p>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Name + actions */}
      <div className="mt-5 text-xs text-muted-foreground">
        {renaming ? (
          <label className="flex flex-wrap items-center gap-2">
            <span>Name</span>
            <input
              value={draft.label}
              onChange={(e) => set({ label: e.target.value })}
              maxLength={120}
              placeholder={autoAlertName({ ...draft, tagName }, index)}
              className="tp-focus-ring min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 py-1 text-sm text-foreground"
              autoFocus
            />
            {draft.label && <button type="button" onClick={() => set({ label: '' })} className="tp-focus-ring rounded text-primary hover:underline">Use the automatic name</button>}
          </label>
        ) : (
          <span>
            Name: <span className="text-foreground">{name}</span>{' '}
            <button type="button" onClick={() => setRenaming(true)} className="tp-focus-ring rounded text-primary hover:underline">Rename</button>
          </span>
        )}
      </div>

      {(error || problem) && (
        <p className={`mt-3 text-xs ${error ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}`} role={error ? 'alert' : undefined}>{error || problem}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={onSave} disabled={saving || !!problem} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} {draft.id ? 'Save' : 'Create alert'}
        </button>
        <button type="button" onClick={onCancel} className="tp-focus-ring rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Cancel</button>
      </div>
    </div>
  );
}
