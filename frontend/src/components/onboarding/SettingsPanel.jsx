import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { hrLifecycleAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { PersonAvatar } from '../tickets/ticketUi';
import { SectionTitle, StatusDot } from './onboardingUi';
import { MODE_INFO, changeFieldLabel, changeValueLabel, fmtWhen } from './onboardingFormat';

/**
 * Settings → mode, parent assignee, the three child lists, leave / transfer
 * handling, the detection rules (read-only) and the change history. Every
 * save is audited server-side (who, when, before → after) and the history
 * below shows it — "full transparency" (plans/HR_LIFECYCLE_PLAN.md).
 */

const pick = (s) => ({
  mode: s.mode,
  parentAssigneeTechId: s.parentAssigneeTechId ?? null,
  templates: s.templates,
  leave: s.leave,
  officeChange: s.officeChange,
});

const assigneeValue = (item) => (item.assigneeTechId ? `t:${item.assigneeTechId}` : item.groupId ? `g:${item.groupId}` : '');

function ChildList({ name, label, hint, items, onChange, assigneeOptions }) {
  const update = (i, patch) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i, d) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-subtle" aria-label={label}>
      <SectionTitle hint={hint}>{label}</SectionTitle>
      <div className="hidden grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_5.5rem] gap-2 px-1 pb-1 text-xs text-muted-foreground sm:grid">
        <span>Child ticket</span><span>Due (days after)</span><span>Default assignee</span><span><span className="sr-only">Order</span></span>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={`${name}-${item.key || i}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_5.5rem] sm:items-center">
            <input
              type="text"
              value={item.title}
              onChange={(e) => update(i, { title: e.target.value })}
              aria-label={`${label}: child ${i + 1} title`}
              className="tp-focus-ring h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
            />
            <input
              type="number"
              min={-30}
              max={90}
              value={item.dueOffsetDays}
              onChange={(e) => update(i, { dueOffsetDays: e.target.value === '' ? 0 : Number(e.target.value) })}
              aria-label={`${label}: ${item.title || `child ${i + 1}`} due offset (days)`}
              className="tp-focus-ring h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
            />
            <FancySelect
              value={assigneeValue(item)}
              onChange={(v) => update(i, {
                assigneeTechId: v.startsWith('t:') ? Number(v.slice(2)) : null,
                groupId: v.startsWith('g:') ? Number(v.slice(2)) : null,
              })}
              options={assigneeOptions}
              aria-label={`${label}: ${item.title || `child ${i + 1}`} default assignee`}
            />
            <span className="flex items-center gap-0.5">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${item.title} up`} className="tp-focus-ring rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${item.title} down`} className="tp-focus-ring rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
              <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${item.title}`} className="tp-focus-ring rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600 dark:hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...items, { key: '', title: 'New child', dueOffsetDays: 0, assigneeTechId: null, groupId: null }])}
        className="tp-focus-ring mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-primary hover:bg-muted"
      >
        <Plus className="h-4 w-4" aria-hidden="true" /> Add a child
      </button>
    </section>
  );
}

export default function SettingsPanel({ data, onSaved }) {
  const [saved, setSaved] = useState(() => pick(data.settings));
  const [draft, setDraft] = useState(() => pick(data.settings));
  const [history, setHistory] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const techById = useMemo(() => new Map((data.technicians || []).map((t) => [t.id, t])), [data.technicians]);
  const groupById = useMemo(() => new Map((data.groups || []).map((g) => [g.id, g])), [data.groups]);
  const labels = data.templateLabels || {};
  const names = data.templateNames || Object.keys(draft.templates || {});

  const techOptions = useMemo(() => (data.technicians || []).map((t) => ({
    value: `t:${t.id}`, label: t.name, group: 'Technicians', icon: <PersonAvatar name={t.name} photoUrl={t.photoUrl} size="h-5 w-5" textSize="text-[9px]" />,
  })), [data.technicians]);
  const assigneeOptions = useMemo(() => [
    { value: '', label: 'AI routing (no default)' },
    ...techOptions,
    ...(data.groups || []).map((g) => ({ value: `g:${g.id}`, label: g.name, group: 'Groups' })),
  ], [techOptions, data.groups]);
  const parentOptions = useMemo(() => [{ value: '', label: 'Leave as assigned' }, ...techOptions], [techOptions]);
  const sideOptions = useMemo(() => [{ value: '', label: 'Leave as assigned' }, ...techOptions], [techOptions]);

  const loadHistory = useCallback(() => {
    hrLifecycleAPI.settingsChanges({ limit: 200 })
      .then((res) => setHistory(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setHistory([]));
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await hrLifecycleAPI.updateSettings(draft);
      const next = res?.data?.settings ? pick(res.data.settings) : draft;
      setSaved(next);
      setDraft(next);
      const n = res?.data?.changes?.length || 0;
      setStatus({ ok: true, text: n ? `Saved — ${n} ${n === 1 ? 'change' : 'changes'} recorded below.` : 'Saved.' });
      onSaved?.(res?.data?.settings || draft);
      loadHistory();
    } catch (err) {
      setStatus({ ok: false, text: err?.message || 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  const setSide = (side, patch) => setDraft((d) => ({ ...d, [side]: { ...d[side], ...patch } }));
  const detection = data.detection || {};

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card p-4 shadow-subtle">
        <fieldset>
          <legend className="text-sm font-semibold text-foreground">Mode</legend>
          <p className="mb-3 text-xs text-muted-foreground">Per workspace. Ships off — FreshService stays the live organiser until this is Live.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(data.modes || ['off', 'observe', 'live']).map((m) => (
              <label key={m} className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${draft.mode === m ? 'border-primary bg-primary/[0.05] dark:bg-primary/10' : 'border-border hover:bg-muted/50'}`}>
                <input type="radio" name="hr-mode" value={m} checked={draft.mode === m} onChange={() => setDraft((d) => ({ ...d, mode: m }))} className="mt-0.5 accent-[hsl(var(--primary))]" />
                <span>
                  <StatusDot tone={MODE_INFO[m]?.tone} label={MODE_INFO[m]?.label || m} className="text-sm font-medium" />
                  <span className="mt-0.5 block text-xs text-muted-foreground">{MODE_INFO[m]?.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 grid gap-1.5 sm:max-w-sm">
          <span className="text-sm font-medium text-foreground" id="hr-parent-label">Parent assignee</span>
          <span className="text-xs text-muted-foreground">The HR notice is the parent; it is assigned to this person.</span>
          <FancySelect
            value={draft.parentAssigneeTechId ? `t:${draft.parentAssigneeTechId}` : ''}
            onChange={(v) => setDraft((d) => ({ ...d, parentAssigneeTechId: v ? Number(v.slice(2)) : null }))}
            options={parentOptions}
            aria-label="Parent assignee"
          />
        </div>
      </section>

      {names.map((name) => (
        <ChildList
          key={name}
          name={name}
          label={labels[name] || name}
          hint={{
            offboarding_standard: 'A departure notice that arrives before the last day.',
            offboarding_after_fact: 'Sudden departures: the notice arrives on/after the last day or says "effective immediately".',
            onboarding: 'A BambooHR new-hire notice. Due = start date + offset.',
          }[name]}
          items={draft.templates?.[name] || []}
          onChange={(items) => setDraft((d) => ({ ...d, templates: { ...d.templates, [name]: items } }))}
          assigneeOptions={assigneeOptions}
        />
      ))}

      <section className="rounded-xl border border-border bg-card p-4 shadow-subtle">
        <SectionTitle hint="No new ticket: the notice itself is assigned, given a due date and parked until its lead time.">Leave and transfer notices</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {[['leave', 'Leave'], ['officeChange', 'Transfer']].map(([side, label]) => (
            <div key={side} className="grid gap-1.5">
              <span className="text-sm text-foreground">{label} — assignee</span>
              <FancySelect
                value={draft[side]?.assigneeTechId ? `t:${draft[side].assigneeTechId}` : ''}
                onChange={(v) => setSide(side, { assigneeTechId: v ? Number(v.slice(2)) : null })}
                options={sideOptions}
                aria-label={`${label} assignee`}
              />
              <label className="mt-1 inline-flex items-center gap-2 text-sm text-foreground/85">
                <input type="checkbox" checked={draft[side]?.park !== false} onChange={(e) => setSide(side, { park: e.target.checked })} />
                Park until the date
              </label>
            </div>
          ))}
        </div>
      </section>

      <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-soft backdrop-blur lg:bottom-4">
        {status && (
          <span role="status" className={`mr-auto text-sm ${status.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{status.text}</span>
        )}
        {!status && dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(saved); setStatus(null); }} className="tp-focus-ring rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-40">Discard</button>
        <button type="button" disabled={!dirty || saving} onClick={save} className="tp-focus-ring rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-subtle" aria-label="Detection rules">
        <SectionTitle hint={`Read-only. Senders: ${(detection.senders || []).join(', ') || '—'}`}>Detection rules</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th scope="col" className="py-1.5 pr-3 font-medium">Notice</th><th scope="col" className="py-1.5 pr-3 font-medium">Subject</th><th scope="col" className="py-1.5 font-medium">What happens</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(detection.rules || []).map((r) => (
                <tr key={r.type} className="align-top">
                  <td className="py-2 pr-3 text-foreground">{r.label}<span className="block text-xs text-muted-foreground">{r.sender}</span></td>
                  <td className="py-2 pr-3 font-mono text-xs text-foreground/85">{r.example}</td>
                  <td className="py-2 text-xs text-muted-foreground">{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {['afterTheFact', 'matching', 'recency', 'passwords'].filter((k) => detection[k]).map((k) => <li key={k}>{detection[k]}</li>)}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-subtle" aria-label="Change history">
        <SectionTitle hint="Every settings change: who, when, before → after.">Change history</SectionTitle>
        {history === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !history.length ? (
          <p className="text-sm text-muted-foreground">No changes yet — the settings above are the seeded defaults.</p>
        ) : (
          <ol className="divide-y divide-border" data-testid="hr-change-history">
            {history.map((c) => (
              <li key={c.id} className="grid gap-x-3 gap-y-0.5 py-2 text-sm sm:grid-cols-[8.5rem_10rem_minmax(0,1fr)]">
                <span className="text-xs text-muted-foreground">{fmtWhen(c.createdAt)}</span>
                <span className="truncate text-xs text-foreground/85">{c.changedByName || c.changedBy || 'Unknown'}</span>
                <span className="min-w-0">
                  <span className="text-foreground">{changeFieldLabel(c.field, { templateLabels: labels, templates: draft.templates, item: c.before || c.after })}</span>
                  <span className="text-muted-foreground">: {changeValueLabel(c.field, c.before, { techById, groupById })} → </span>
                  <span className="text-foreground">{changeValueLabel(c.field, c.after, { techById, groupById })}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
