import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, Pencil, Plus, Play, Radar, RefreshCw, Sparkles, TestTube, Trash2 } from 'lucide-react';
import { alertCorrelationAPI } from '../../services/api';

/**
 * Settings → Alert correlation (20 Sep 2026). Pair rules ("server down" ↔
 * "server up") and storm grouping for machine alerts, so they never wait for
 * a person or an AI run. Rules are regexes with a `(?<key>…)` group naming
 * the instance; the engine runs at arrival, every five minutes, and on demand.
 */

const EMPTY = {
  name: '', description: '', senderPattern: '', firedPattern: '', clearedPattern: '', followupPattern: '',
  pairWindowMinutes: 360, pairAction: 'resolve', orphanClearedAction: 'resolve',
  stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3, resolutionReason: 'benign_expected', skipAi: true, isEnabled: true,
};
const REASONS = [
  ['benign_expected', 'Benign / expected'],
  ['no_action_required', 'No action required'],
  ['false_positive', 'False positive'],
  ['other', 'Other'],
];

function Field({ label, hint, children, mono = false }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className={`mt-1 ${mono ? 'font-mono' : ''}`}>{children}</div>
      {hint && <span className="mt-0.5 block text-[10.5px] text-muted-foreground/75">{hint}</span>}
    </label>
  );
}
const inputCls = 'tp-focus-ring w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground';

function RuleForm({ initial, onSave, onCancel, busy, error }) {
  const [draft, setDraft] = useState({ ...EMPTY, ...initial, clearedPattern: initial?.clearedPattern || '', followupPattern: initial?.followupPattern || '', description: initial?.description || '' });
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave({ ...draft, clearedPattern: draft.clearedPattern.trim() || null, followupPattern: draft.followupPattern.trim() || null, pairWindowMinutes: Number(draft.pairWindowMinutes), stormWindowMinutes: Number(draft.stormWindowMinutes), stormMinCount: Number(draft.stormMinCount) }); }}
      className="space-y-3 rounded-xl border border-border bg-muted/30 p-3.5"
      data-testid="alert-rule-form"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input value={draft.name} onChange={set('name')} required maxLength={160} className={inputCls} aria-label="Rule name" /></Field>
        <Field label="Sender (regex on the requester e-mail)" hint="Required — a person forwarding an alert never matches." mono>
          <input value={draft.senderPattern} onChange={set('senderPattern')} required className={inputCls} aria-label="Sender pattern" placeholder="^azure-noreply@microsoft\.com$" />
        </Field>
      </div>
      <Field label="Description"><input value={draft.description} onChange={set('description')} className={inputCls} aria-label="Description" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fired subject (regex)" hint="Name the instance with (?<key>…) — e.g. the VM or host. (?<family>…) groups a storm." mono>
          <input value={draft.firedPattern} onChange={set('firedPattern')} required className={inputCls} aria-label="Fired pattern" placeholder="^Fired:Sev\d+ Azure Monitor Alert (?<key>.+?) \(" />
        </Field>
        <Field label="Cleared subject (regex, optional)" hint="Same (?<key>…). Leave empty for a storm-only rule." mono>
          <input value={draft.clearedPattern} onChange={set('clearedPattern')} className={inputCls} aria-label="Cleared pattern" placeholder="^Resolved:Sev\d+ Azure Monitor Alert (?<key>.+?) \(" />
        </Field>
      </div>
      <Field label="Follow-up subject (regex, optional)" hint="A report that follows the alert (RCA); attached to it and resolved." mono>
        <input value={draft.followupPattern} onChange={set('followupPattern')} className={inputCls} aria-label="Follow-up pattern" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Pair window (minutes)"><input type="number" min={1} value={draft.pairWindowMinutes} onChange={set('pairWindowMinutes')} className={inputCls} aria-label="Pair window minutes" /></Field>
        <Field label="When a pair is found">
          <select value={draft.pairAction} onChange={set('pairAction')} className={inputCls} aria-label="Pair action">
            <option value="resolve">Resolve both</option>
            <option value="link_only">Link only</option>
          </select>
        </Field>
        <Field label="Clear notice with no alert">
          <select value={draft.orphanClearedAction} onChange={set('orphanClearedAction')} className={inputCls} aria-label="Orphan action">
            <option value="resolve">Resolve it</option>
            <option value="leave">Leave it open</option>
          </select>
        </Field>
        <Field label="Resolution reason">
          <select value={draft.resolutionReason} onChange={set('resolutionReason')} className={inputCls} aria-label="Resolution reason">
            {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="flex items-center gap-2 text-sm text-foreground/85 sm:col-span-1">
          <input type="checkbox" checked={draft.stormEnabled} onChange={set('stormEnabled')} className="tp-focus-ring rounded border-input" aria-label="Group storms" /> Group storms
        </label>
        <Field label="Storm window (minutes)"><input type="number" min={1} value={draft.stormWindowMinutes} onChange={set('stormWindowMinutes')} disabled={!draft.stormEnabled} className={inputCls} aria-label="Storm window minutes" /></Field>
        <Field label="Alerts to make a storm"><input type="number" min={2} value={draft.stormMinCount} onChange={set('stormMinCount')} disabled={!draft.stormEnabled} className={inputCls} aria-label="Storm minimum count" /></Field>
        <label className="flex items-center gap-2 text-sm text-foreground/85">
          <input type="checkbox" checked={draft.skipAi} onChange={set('skipAi')} className="tp-focus-ring rounded border-input" aria-label="Skip the AI run" /> Skip the AI run
        </label>
      </div>
      {error && <p role="alert" className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-200"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />} Save rule
        </button>
        <button type="button" onClick={onCancel} className="tp-focus-ring rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
      </div>
    </form>
  );
}

function Count({ n, label }) {
  return <span className="inline-flex items-baseline gap-1"><span className="text-lg font-bold tabular-nums text-foreground">{n}</span><span className="text-[11px] text-muted-foreground">{label}</span></span>;
}

export default function AlertCorrelationPanel() {
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | rule
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewDays, setPreviewDays] = useState(30);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [activity, setActivity] = useState(null);
  const [toast, setToast] = useState(null);
  const [showActivity, setShowActivity] = useState(false);

  const load = useCallback(() => {
    alertCorrelationAPI.listRules().then((r) => setRules(r.data?.data || r.data || [])).catch(() => setRules([]));
    alertCorrelationAPI.suggestions().then((r) => setSuggestions(r.data?.data || r.data || [])).catch(() => setSuggestions([]));
    alertCorrelationAPI.activity(30).then((r) => setActivity(r.data?.data || r.data || [])).catch(() => setActivity([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const say = (text) => { setToast(text); setTimeout(() => setToast(null), 4000); };

  const save = async (data) => {
    setBusy(true); setFormError(null);
    try {
      if (editing && editing !== 'new') await alertCorrelationAPI.updateRule(editing.id, data);
      else await alertCorrelationAPI.createRule(data);
      setEditing(null); load(); say('Rule saved');
    } catch (e) { setFormError(e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const toggle = async (rule) => { await alertCorrelationAPI.updateRule(rule.id, { isEnabled: !rule.isEnabled }).catch(() => {}); load(); };
  const remove = async (rule) => { await alertCorrelationAPI.deleteRule(rule.id).catch(() => {}); load(); say(`Removed “${rule.name}”`); };
  const installStarter = async () => {
    setBusy(true);
    try { const r = await alertCorrelationAPI.installStarter(); const d = r.data?.data || r.data; say(`${d.installed.length} starter rule${d.installed.length === 1 ? '' : 's'} installed`); load(); } catch (e) { say(e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const runPreview = async () => {
    setPreviewBusy(true);
    try { const r = await alertCorrelationAPI.preview(previewDays); setPreview(r.data?.data || r.data); } catch (e) { say(e.response?.data?.message || e.message); }
    setPreviewBusy(false);
  };
  const runApply = async () => {
    setApplyBusy(true); setConfirmApply(false);
    try { const r = await alertCorrelationAPI.apply(30); setApplyResult(r.data?.data || r.data); load(); } catch (e) { say(e.response?.data?.message || e.message); }
    setApplyBusy(false);
  };

  const enabledCount = useMemo(() => (rules || []).filter((r) => r.isEnabled).length, [rules]);

  return (
    <div className="space-y-4 animate-fadeIn" data-testid="alert-correlation-panel">
      <section className="tp-card rounded-xl p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Radar className="w-4 h-4 text-blue-500" aria-hidden="true" />
              <h3 className="text-sm font-bold text-foreground">Alert correlation</h3>
            </div>
            <p className="text-xs text-muted-foreground/75">
              Machine alerts that come in pairs (“server down” then “server up”) are matched the moment the second one arrives and both are resolved with a note — no person, no AI run, at any hour.
              A burst of the same alert across many hosts is folded under one parent ticket. Rules run at arrival, every five minutes, and on demand below. A ticket a person has touched is never resolved by a rule.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={installStarter} disabled={busy} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground/85 hover:bg-muted disabled:opacity-50" title="Adds the ready-made rules for senders seen in this workspace in the last 180 days (Azure Monitor, Site24x7, Cambio Earth, Rapid Recovery)">
              <Sparkles className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" /> Install starter rules
            </button>
            <button onClick={() => { setEditing('new'); setFormError(null); }} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New rule
            </button>
          </div>
        </div>
        {toast && <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{toast}</p>}

        {editing === 'new' && <div className="mt-3"><RuleForm initial={EMPTY} onSave={save} onCancel={() => setEditing(null)} busy={busy} error={formError} /></div>}

        <ul className="mt-3 divide-y divide-border/60 rounded-xl border border-border" data-testid="alert-rules">
          {rules === null && <li className="px-3 py-3 text-xs text-muted-foreground">Loading…</li>}
          {rules?.length === 0 && <li className="px-3 py-4 text-xs text-muted-foreground">No rules yet. Install the starter rules or add one.</li>}
          {(rules || []).map((rule) => (
            <li key={rule.id} className="px-3 py-2.5">
              {editing && editing !== 'new' && editing.id === rule.id ? (
                <RuleForm initial={rule} onSave={save} onCancel={() => setEditing(null)} busy={busy} error={formError} />
              ) : (
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    type="button" role="switch" aria-checked={rule.isEnabled} aria-label={`${rule.isEnabled ? 'Disable' : 'Enable'} ${rule.name}`}
                    onClick={() => toggle(rule)}
                    className={`tp-focus-ring relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${rule.isEnabled ? 'bg-primary' : 'bg-muted-foreground/40'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform ${rule.isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{rule.name}</p>
                    {rule.description && <p className="text-[11.5px] text-muted-foreground">{rule.description}</p>}
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span><span className="font-medium text-foreground/70">from</span> <code className="font-mono">{rule.senderPattern}</code></span>
                      <span><span className="font-medium text-foreground/70">fired</span> <code className="font-mono">{rule.firedPattern}</code></span>
                      {rule.clearedPattern && <span><span className="font-medium text-foreground/70">cleared</span> <code className="font-mono">{rule.clearedPattern}</code></span>}
                      {rule.followupPattern && <span><span className="font-medium text-foreground/70">follow-up</span> <code className="font-mono">{rule.followupPattern}</code></span>}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground/75">
                      {rule.clearedPattern ? `pair within ${rule.pairWindowMinutes} min · ${rule.pairAction === 'resolve' ? 'resolve both' : 'link only'} · orphan clears ${rule.orphanClearedAction === 'resolve' ? 'resolved' : 'left open'}` : 'no cleared pattern (storm only)'}
                      {rule.stormEnabled ? ` · storm: ${rule.stormMinCount}+ in ${rule.stormWindowMinutes} min` : ' · storms off'}
                      {rule.skipAi ? ' · skips the AI' : ''}
                      {` · matched ${rule.matchCount} time${rule.matchCount === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setEditing(rule); setFormError(null); }} aria-label={`Edit ${rule.name}`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button onClick={() => remove(rule)} aria-label={`Delete ${rule.name}`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="tp-card rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-bold text-foreground">Test and apply</h4>
            <p className="text-xs text-muted-foreground/75">A test is a dry run over history — nothing is written. Apply runs the enabled rules over today’s open tickets for real.</p>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">last
            <input type="number" min={1} max={365} value={previewDays} onChange={(e) => setPreviewDays(Number(e.target.value) || 30)} className="tp-focus-ring w-16 rounded-md border border-input bg-card px-2 py-1 text-xs text-foreground" aria-label="Days to test" /> days
          </label>
          <button onClick={runPreview} disabled={previewBusy || !enabledCount} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground/85 hover:bg-muted disabled:opacity-50">
            {previewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <TestTube className="h-3.5 w-3.5" aria-hidden="true" />} Test on history
          </button>
          {confirmApply ? (
            <span className="inline-flex items-center gap-1.5 text-xs">
              Resolve and link open tickets now?
              <button onClick={runApply} className="tp-focus-ring rounded-md bg-primary px-2 py-1 font-semibold text-primary-foreground">Yes, apply</button>
              <button onClick={() => setConfirmApply(false)} className="tp-focus-ring rounded-md px-2 py-1 text-muted-foreground hover:bg-muted">No</button>
            </span>
          ) : (
            <button onClick={() => setConfirmApply(true)} disabled={applyBusy || !enabledCount} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50" data-testid="alert-apply">
              {applyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />} Apply to open tickets
            </button>
          )}
        </div>
        {preview && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="alert-preview">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <Count n={preview.candidates} label="alert tickets" />
              <Count n={preview.summary.pairs} label="pairs" />
              <Count n={preview.summary.storms} label="storm children" />
              <Count n={preview.summary.orphans} label="orphan clears" />
              <Count n={preview.summary.followups} label="follow-ups" />
              <Count n={preview.summary.unmatchedFired} label="alerts that never cleared" />
              {preview.summary.vetoed > 0 && <Count n={preview.summary.vetoed} label="vetoed" />}
            </div>
            {preview.pairs.length > 0 && (
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto settings-scrollbar text-[11.5px] text-foreground/85">
                {preview.pairs.slice(0, 40).map((p) => (
                  <li key={`${p.firedId}-${p.clearedId}`}><span className="font-mono">{p.firedRef}</span> cleared by <span className="font-mono">{p.clearedRef}</span> after {p.gapMinutes} min{p.touched ? ' · a person is on it (left alone)' : ''}{p.firedTerminal ? ' · already closed by a person' : ''}</li>
                ))}
                {preview.pairs.length > 40 && <li className="text-muted-foreground">…and {preview.pairs.length - 40} more</li>}
              </ul>
            )}
            {preview.unmatchedFired.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">Never cleared (a person needed): {preview.unmatchedFired.slice(0, 8).map((u) => u.ref).join(', ')}{preview.unmatchedFired.length > 8 ? '…' : ''}</p>
            )}
          </div>
        )}
        {applyResult && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs dark:border-emerald-500/30 dark:bg-emerald-500/10" data-testid="alert-apply-result">
            <p className="font-semibold text-emerald-800 dark:text-emerald-200">{applyResult.handled.length} of {applyResult.evaluated} open alert tickets handled</p>
            <ul className="mt-1 space-y-0.5 text-foreground/85">
              {applyResult.handled.slice(0, 40).map((h) => <li key={h.id}><span className="font-mono">{h.ref}</span> · {h.kind} · {h.subject}</li>)}
            </ul>
            {applyResult.untouched.length > 0 && <p className="mt-1 text-muted-foreground">Left for people: {applyResult.untouched.map((u) => u.ref).join(', ')}</p>}
          </div>
        )}
      </section>

      {suggestions && suggestions.length > 0 && (
        <section className="tp-card rounded-xl p-4">
          <h4 className="text-sm font-bold text-foreground">Suggested rules</h4>
          <p className="text-xs text-muted-foreground/75">Senders whose subjects fire and clear (or repeat in bursts) with no rule yet. Add one, then Test on history to check the key.</p>
          <ul className="mt-2 divide-y divide-border/60 rounded-xl border border-border">
            {suggestions.map((s) => (
              <li key={s.sender} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{s.sender} <span className="text-[11px] text-muted-foreground">· {s.tickets} tickets · {s.kind === 'pair' ? `${s.pairsSeen} pairs seen` : `busiest: ${s.busiestTemplate?.count} alike`}</span></p>
                  <p className="truncate text-[11px] text-muted-foreground">{s.sampleFired}{s.sampleCleared ? ` → ${s.sampleCleared}` : ''}</p>
                </div>
                <button onClick={() => { setEditing('new'); setFormError(null); setTimeout(() => setEditing({ ...s.proposal, id: undefined }), 0); }} className="tp-focus-ring inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground/85 hover:bg-muted"><Plus className="h-3 w-3" aria-hidden="true" /> Add rule</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tp-card rounded-xl p-4">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowActivity((v) => !v)} className="tp-focus-ring flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={showActivity}>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showActivity ? '' : '-rotate-90'}`} aria-hidden="true" />
            <h4 className="text-sm font-bold text-foreground">What the rules did (30 days)</h4>
            <span className="text-xs text-muted-foreground">{activity ? `${activity.length} action${activity.length === 1 ? '' : 's'}` : ''}</span>
          </button>
          <button onClick={load} aria-label="Refresh" className="tp-focus-ring ml-auto rounded p-1 text-muted-foreground hover:bg-muted"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
        {showActivity && (
          <ul className="mt-2 max-h-72 divide-y divide-border/60 overflow-y-auto settings-scrollbar text-[11.5px]">
            {(activity || []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="text-muted-foreground/75">{new Date(a.at).toLocaleString()}</span>
                <span className="font-mono text-foreground/85">{a.ref}</span>
                <span className="text-foreground/85">{a.kind}{a.otherRef ? ` ↔ ${a.otherRef}` : ''}{a.resolved ? ' · resolved' : a.touched ? ' · left to a person' : a.firedTerminal ? ' · already closed' : ''}</span>
                <span className="truncate text-muted-foreground">{a.subject}</span>
              </li>
            ))}
            {activity?.length === 0 && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
