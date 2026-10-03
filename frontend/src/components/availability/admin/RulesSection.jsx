import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { availabilityAPI } from '../../../services/api';
import { BTN_LINK, BTN_QUIET, Field, INPUT, SectionTitle, StatusDot, Toggle, nameFromEmail } from '../availabilityUi';
import { Drawer, MultiCheck } from './adminUi';

/**
 * Rules: evaluated in priority order (lowest number first) for every request.
 * Each rule = who it applies to (scope), which types, a condition, and what
 * happens when the condition matches.
 */

export const CONDITION_KINDS = [
  { value: 'always', label: 'Always' },
  { value: 'advance_notice', label: 'Notice period' },
  { value: 'capacity', label: 'Too many away at once' },
  { value: 'booking_window', label: 'Booked too far ahead (weeks)' },
  { value: 'per_person', label: 'Too many days per person' },
  { value: 'duration', label: 'Longer than' },
  { value: 'blackout', label: 'Blackout dates' },
  { value: 'balance', label: 'Not enough balance' },
  { value: 'past_dated', label: 'Booked after the fact' },
];

export const OUTCOMES = [
  { value: 'auto_approve', label: 'Approve automatically', tone: 'green' },
  { value: 'needs_approval', label: 'Send to approvers', tone: 'amber' },
  { value: 'refuse', label: 'Refuse', tone: 'red' },
  { value: 'warn', label: 'Warn only', tone: 'blue' },
];

const SCOPES = [
  { value: 'company', label: 'Everyone' },
  { value: 'office', label: 'An office' },
  { value: 'group', label: 'An approval group' },
  { value: 'person', label: 'One person' },
];

const DEFAULT_CONDITION = {
  always: {},
  advance_notice: { minDaysAhead: 14 },
  capacity: { window: 'day', max: 2, scope: 'office' },
  booking_window: { weeksAhead: 1 },
  per_person: { window: 'week', maxDays: 1 },
  duration: { maxDays: 10 },
  blackout: { from: '', to: '', label: '' },
  balance: { allowNegativeDays: 0 },
  past_dated: {},
};

const BLANK = { name: '', scopeType: 'company', scopeRef: null, leaveTypeIds: null, condition: { kind: 'always' }, outcome: 'needs_approval', message: '', priority: 100, isActive: true };

export function describeCondition(c = {}) {
  switch (c.kind) {
  case 'always': return 'always';
  case 'advance_notice': return [c.minDaysAhead != null && `less than ${c.minDaysAhead} days' notice`, c.maxDaysAhead != null && `more than ${c.maxDaysAhead} days ahead`].filter(Boolean).join(' or ') || 'notice period';
  case 'capacity': {
    const extra = c.officeMax && Object.keys(c.officeMax).length ? ` (${Object.keys(c.officeMax).length} office${Object.keys(c.officeMax).length === 1 ? '' : 's'} with their own limit)` : '';
    return `more than ${c.max} away per ${c.window === 'week' ? 'week' : 'day'} in the ${c.scope || 'office'}${extra}`;
  }
  case 'booking_window': {
    const n = Number(c.weeksAhead ?? 1);
    return n === 0 ? 'booked beyond this week' : n === 1 ? 'booked beyond this week and next' : `booked beyond this week and the next ${n} weeks`;
  }
  case 'per_person': return `more than ${c.maxDays} day${Number(c.maxDays) === 1 ? '' : 's'} per ${c.window === 'day' ? 'day' : 'week'} for one person`;
  case 'duration': return `longer than ${c.maxDays} working days`;
  case 'blackout': return `overlaps ${c.from || '?'} – ${c.to || '?'}${c.label ? ` (${c.label})` : ''}`;
  case 'balance': return c.allowNegativeDays ? `balance would go below −${c.allowNegativeDays}` : 'balance would go negative';
  case 'past_dated': return 'starts in the past';
  default: return c.kind || '—';
  }
}

const num = (v) => (v === '' || v == null ? null : Number(v));

function OfficeLimits({ value = {}, offices = [], onChange }) {
  const rows = Object.entries(value || {});
  const used = new Set(rows.map(([k]) => k));
  const free = offices.filter((o) => !used.has(String(o.id)));
  const nameOf = (id) => offices.find((o) => String(o.id) === String(id))?.name || `Office ${id}`;
  const setRow = (id, v) => onChange({ ...value, [id]: v });
  const drop = (id) => { const next = { ...value }; delete next[id]; onChange(next); };
  return (
    <div className="space-y-2" data-testid="office-limits">
      <p className="text-xs text-muted-foreground">Offices with their own limit (everyone else uses the number above).</p>
      {rows.map(([id, v]) => (
        <div key={id} className="flex items-center gap-2 text-sm">
          <span className="w-40 truncate text-foreground">{nameOf(id)}</span>
          <input type="number" min={0} className={`${INPUT} w-24`} value={v ?? ''} onChange={(e) => setRow(id, num(e.target.value))} aria-label={`${nameOf(id)} limit`} />
          <button type="button" className={BTN_QUIET} onClick={() => drop(id)}>Remove</button>
        </div>
      ))}
      {free.length > 0 && (
        <div className="w-56">
          <FancySelect value="" onChange={(id) => id && setRow(id, 1)} options={[{ value: '', label: 'Add an office…' }, ...free.map((o) => ({ value: String(o.id), label: o.name }))]} aria-label="Add an office limit" />
        </div>
      )}
    </div>
  );
}

function ConditionFields({ condition, onChange, offices = [] }) {
  const c = condition || {};
  const set = (patch) => onChange({ ...c, ...patch });
  switch (c.kind) {
  case 'advance_notice':
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Needs at least (days' notice)"><input type="number" className={INPUT} value={c.minDaysAhead ?? ''} onChange={(e) => set({ minDaysAhead: num(e.target.value) })} aria-label="Minimum days ahead" /></Field>
        <Field label="No more than (days ahead)"><input type="number" className={INPUT} value={c.maxDaysAhead ?? ''} onChange={(e) => set({ maxDaysAhead: num(e.target.value) })} aria-label="Maximum days ahead" /></Field>
      </div>
    );
  case 'capacity':
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="At most"><input type="number" min={0} className={INPUT} value={c.max ?? ''} onChange={(e) => set({ max: num(e.target.value) })} aria-label="Maximum away" /></Field>
        <Field label="Per">
          <FancySelect value={c.window || 'day'} onChange={(v) => set({ window: v })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} aria-label="Capacity window" />
        </Field>
        <Field label="Counted across">
          <FancySelect value={c.scope || 'office'} onChange={(v) => set({ scope: v })} options={[{ value: 'office', label: 'Their office' }, { value: 'group', label: 'Their group' }, { value: 'company', label: 'The company' }]} aria-label="Capacity scope" />
        </Field>
        {(c.scope || 'office') === 'office' && (
          <div className="sm:col-span-3">
            <OfficeLimits value={c.officeMax || {}} offices={offices} onChange={(officeMax) => set({ officeMax })} />
          </div>
        )}
      </div>
    );
  case 'booking_window':
    return (
      <Field label="Weeks ahead after this week (1 = this week and next)">
        <input type="number" min={0} className={`${INPUT} w-28`} value={c.weeksAhead ?? 1} onChange={(e) => set({ weeksAhead: num(e.target.value) ?? 0 })} aria-label="Weeks ahead" />
      </Field>
    );
  case 'per_person':
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="At most (days)"><input type="number" min={0} step="0.5" className={INPUT} value={c.maxDays ?? ''} onChange={(e) => set({ maxDays: num(e.target.value) })} aria-label="Maximum days per person" /></Field>
        <Field label="Per">
          <FancySelect value={c.window || 'week'} onChange={(v) => set({ window: v })} options={[{ value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }]} aria-label="Per person window" />
        </Field>
      </div>
    );
  case 'duration':
    return <Field label="Longer than (working days)"><input type="number" min={0} className={INPUT} value={c.maxDays ?? ''} onChange={(e) => set({ maxDays: num(e.target.value) })} aria-label="Maximum days" /></Field>;
  case 'blackout':
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From"><input type="date" className={INPUT} value={c.from || ''} onChange={(e) => set({ from: e.target.value })} aria-label="Blackout from" /></Field>
        <Field label="To"><input type="date" className={INPUT} value={c.to || ''} onChange={(e) => set({ to: e.target.value })} aria-label="Blackout to" /></Field>
        <Field label="Label"><input className={INPUT} value={c.label || ''} onChange={(e) => set({ label: e.target.value })} aria-label="Blackout label" /></Field>
      </div>
    );
  case 'balance':
    return <Field label="Allow going negative by (days)"><input type="number" min={0} step="0.5" className={INPUT} value={c.allowNegativeDays ?? 0} onChange={(e) => set({ allowNegativeDays: num(e.target.value) ?? 0 })} aria-label="Allow negative days" /></Field>;
  default:
    return null;
  }
}

export default function RulesSection({ config, reload, toast }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const rules = [...(config.rules || [])].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id - b.id);
  const types = (config.leaveTypes || []).filter((t) => t.isActive !== false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const scopeLabel = (r) => {
    if (r.scopeType === 'office') return (config.offices || []).find((o) => String(o.id) === String(r.scopeRef))?.name || 'An office';
    if (r.scopeType === 'group') return (config.groups || []).find((g) => String(g.id) === String(r.scopeRef))?.name || 'A group';
    if (r.scopeType === 'person') return (config.people || []).find((p) => p.email === r.scopeRef)?.name || nameFromEmail(r.scopeRef);
    return 'Everyone';
  };
  const typesLabel = (r) => (Array.isArray(r.leaveTypeIds) && r.leaveTypeIds.length
    ? r.leaveTypeIds.map((id) => (config.leaveTypes || []).find((t) => t.id === id)?.name).filter(Boolean).join(', ')
    : 'all types');

  const refOptions = draft?.scopeType === 'office'
    ? (config.offices || []).map((o) => ({ value: String(o.id), label: o.name }))
    : draft?.scopeType === 'group'
      ? (config.groups || []).map((g) => ({ value: String(g.id), label: g.name }))
      : draft?.scopeType === 'person'
        ? (config.people || []).map((p) => ({ value: p.email, label: p.name || p.email }))
        : [];

  const save = async () => {
    if (!draft.name.trim()) { setError('Give the rule a name'); return; }
    if (draft.scopeType !== 'company' && !draft.scopeRef) { setError('Pick who the rule applies to'); return; }
    setSaving(true);
    setError(null);
    try {
      await availabilityAPI.saveRule({
        id: draft.id,
        name: draft.name.trim(),
        scopeType: draft.scopeType,
        scopeRef: draft.scopeType === 'company' ? null : draft.scopeRef,
        leaveTypeIds: draft.leaveTypeIds && draft.leaveTypeIds.length ? draft.leaveTypeIds : null,
        condition: draft.condition,
        outcome: draft.outcome,
        message: draft.message || '',
        priority: Number(draft.priority) || 0,
        isActive: draft.isActive !== false,
      });
      toast(`${draft.name.trim()} saved`);
      setDraft(null);
      reload();
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete the rule "${r.name}"?`)) return;
    try {
      await availabilityAPI.deleteRule(r.id);
      toast(`${r.name} deleted`);
      reload();
    } catch (err) {
      toast(err?.message || 'Could not delete', 'red');
    }
  };

  return (
    <section aria-label="Rules">
      <SectionTitle
        hint="Checked top to bottom on every request. Refuse beats send-to-approvers beats approve; warnings never block."
        action={<button type="button" className={BTN_LINK} onClick={() => { setDraft({ ...BLANK }); setError(null); }}><Plus className="h-4 w-4" aria-hidden="true" />New rule</button>}
      >
        Rules
      </SectionTitle>
      {!rules.length && <p className="py-4 text-sm text-muted-foreground">No rules — every request follows its leave type&apos;s approval setting.</p>}
      <ol className="divide-y divide-border">
        {rules.map((r) => {
          const outcome = OUTCOMES.find((o) => o.value === r.outcome) || OUTCOMES[1];
          return (
            <li key={r.id} className={`flex flex-wrap items-start gap-x-4 gap-y-1 py-3 ${r.isActive === false ? 'opacity-60' : ''}`}>
              <span className="w-8 pt-0.5 text-xs tabular-nums text-muted-foreground" title="Priority">{r.priority}</span>
              <div className="min-w-[14rem] flex-1">
                <p className="text-sm font-medium text-foreground">{r.name}</p>
                <p className="text-xs text-muted-foreground">{scopeLabel(r)} · {typesLabel(r)} · when {describeCondition(r.condition)}</p>
                {r.message && <p className="text-xs italic text-muted-foreground">“{r.message}”</p>}
              </div>
              <StatusDot tone={r.isActive === false ? 'grey' : outcome.tone} label={r.isActive === false ? 'Off' : outcome.label} />
              <span className="flex gap-1">
                <button type="button" className={BTN_QUIET} onClick={() => { setDraft({ ...BLANK, ...r, condition: r.condition || { kind: 'always' } }); setError(null); }} aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></button>
                <button type="button" className={BTN_QUIET} onClick={() => remove(r)} aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
              </span>
            </li>
          );
        })}
      </ol>

      <Drawer open={Boolean(draft)} title={draft?.id ? `Edit ${draft.name}` : 'New rule'} onClose={() => setDraft(null)} onSave={save} saving={saving} error={error}>
        {draft && (
          <>
            <Field label="Name"><input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-label="Rule name" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Applies to">
                <FancySelect value={draft.scopeType} onChange={(v) => set({ scopeType: v, scopeRef: null })} options={SCOPES} aria-label="Scope" />
              </Field>
              {draft.scopeType !== 'company' && (
                <Field label="Which">
                  <FancySelect value={draft.scopeRef == null ? '' : String(draft.scopeRef)} onChange={(v) => set({ scopeRef: v })} options={refOptions} placeholder="Pick…" aria-label="Scope target" />
                </Field>
              )}
            </div>
            <MultiCheck
              label="Leave types (none ticked = all types)"
              options={types.map((t) => ({ value: t.id, label: t.name }))}
              value={draft.leaveTypeIds || []}
              onChange={(v) => set({ leaveTypeIds: v })}
            />
            <Field label="When">
              <FancySelect value={draft.condition?.kind || 'always'} onChange={(v) => set({ condition: { kind: v, ...DEFAULT_CONDITION[v] } })} options={CONDITION_KINDS} aria-label="Condition" />
            </Field>
            <ConditionFields condition={draft.condition} offices={config.offices || []} onChange={(condition) => set({ condition })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Then">
                <FancySelect value={draft.outcome} onChange={(v) => set({ outcome: v })} options={OUTCOMES.map(({ value, label }) => ({ value, label }))} aria-label="Outcome" />
              </Field>
              <Field label="Priority" hint="Lower runs first.">
                <input type="number" className={INPUT} value={draft.priority} onChange={(e) => set({ priority: e.target.value })} aria-label="Priority" />
              </Field>
            </div>
            <Field label="Message to the requester" hint="Optional; shown with the verdict.">
              <input className={INPUT} value={draft.message || ''} onChange={(e) => set({ message: e.target.value })} aria-label="Message" />
            </Field>
            <Toggle checked={draft.isActive !== false} onChange={(v) => set({ isActive: v })} label="Active" />
          </>
        )}
      </Drawer>
    </section>
  );
}
