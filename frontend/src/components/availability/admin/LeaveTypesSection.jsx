import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { availabilityAPI } from '../../../services/api';
import {
  AVAILABILITY_LABEL, BTN_LINK, BTN_QUIET, COLOR_DOT, COLOR_NAMES, ColorSwatch, Field, INPUT, SectionTitle, StatusDot, Toggle,
} from '../availabilityUi';
import { Drawer, TD, TH } from './adminUi';

/** Leave types: the table, and a drawer with every field incl. the balance policy. */

const BLANK = {
  name: '', icon: '', color: 'emerald', unit: 'day', allowHalfDays: true, requiresApproval: true, availability: 'OFF',
  visibility: 'public', requiresNote: false, allowPastDated: false, tracksBalance: false,
  balancePolicy: { annualDays: 0, tenureTiers: [], prorate: true, eligibleAfterDays: 0 }, vtLeaveTypeNames: [], sortOrder: 100, isActive: true,
};

const VISIBILITY = [
  { value: 'public', label: 'Everyone sees the type' },
  { value: 'away', label: 'Others see “Away” only' },
  { value: 'private', label: 'Hidden from others' },
];

function toDraft(t) {
  const policy = t.balancePolicy || {};
  return {
    ...BLANK,
    ...t,
    balancePolicy: {
      annualDays: policy.annualDays ?? 0,
      tenureTiers: Array.isArray(policy.tenureTiers) ? policy.tenureTiers : [],
      prorate: policy.prorate !== false,
      eligibleAfterDays: policy.eligibleAfterDays ?? 0,
    },
    vtText: (t.vtLeaveTypeNames || []).join(', '),
  };
}

export default function LeaveTypesSection({ config, reload, toast }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const types = [...(config.leaveTypes || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setPolicy = (patch) => setDraft((d) => ({ ...d, balancePolicy: { ...d.balancePolicy, ...patch } }));

  const save = async () => {
    if (!draft.name.trim()) { setError('Give the type a name'); return; }
    setSaving(true);
    setError(null);
    const { vtText, ...rest } = draft;
    try {
      await availabilityAPI.saveLeaveType({
        ...rest,
        name: rest.name.trim(),
        sortOrder: Number(rest.sortOrder) || 0,
        balancePolicy: {
          annualDays: Number(rest.balancePolicy.annualDays) || 0,
          tenureTiers: rest.balancePolicy.tenureTiers.map((t) => ({ afterYears: Number(t.afterYears) || 0, days: Number(t.days) || 0 })),
          prorate: Boolean(rest.balancePolicy.prorate),
          eligibleAfterDays: Number(rest.balancePolicy.eligibleAfterDays) || 0,
        },
        vtLeaveTypeNames: String(vtText || '').split(',').map((s) => s.trim()).filter(Boolean),
      });
      toast(`${rest.name.trim()} saved`);
      setDraft(null);
      reload();
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const tiers = draft?.balancePolicy.tenureTiers || [];

  return (
    <section aria-label="Leave types">
      <SectionTitle
        hint="What people can book. Availability decides how a type shows on the dashboards; visibility what colleagues see."
        action={<button type="button" className={BTN_LINK} onClick={() => { setDraft(toDraft(BLANK)); setError(null); }}><Plus className="h-4 w-4" aria-hidden="true" />New type</button>}
      >
        Leave types
      </SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead><tr><th className={TH}>Type</th><th className={TH}>Shows as</th><th className={TH}>Approval</th><th className={TH}>Balance</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Edit</span></th></tr></thead>
          <tbody className="divide-y divide-border">
            {types.map((t) => (
              <tr key={t.id}>
                <td className={TD}><span className="flex items-center gap-2 text-foreground"><ColorSwatch color={t.color} />{t.name}</span><span className="block pl-[18px] text-xs text-muted-foreground">{t.unit === 'hour' ? 'Hours' : t.allowHalfDays ? 'Days, half days' : 'Whole days'}</span></td>
                <td className={`${TD} text-foreground/85`}>{AVAILABILITY_LABEL[t.availability] || t.availability}</td>
                <td className={`${TD} text-foreground/85`}>{t.requiresApproval ? 'Needs approval' : 'Automatic'}</td>
                <td className={`${TD} text-foreground/85`}>{t.tracksBalance ? `${t.balancePolicy?.annualDays ?? 0} days/yr` : '—'}</td>
                <td className={TD}><StatusDot tone={t.isActive === false ? 'grey' : 'green'} label={t.isActive === false ? 'Retired' : 'Active'} /></td>
                <td className={`${TD} text-right`}>
                  <button type="button" className={BTN_QUIET} onClick={() => { setDraft(toDraft(t)); setError(null); }} aria-label={`Edit ${t.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={Boolean(draft)} title={draft?.id ? `Edit ${draft.name}` : 'New leave type'} onClose={() => setDraft(null)} onSave={save} saving={saving} error={error}>
        {draft && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-label="Type name" /></Field>
              <Field label="Icon (lucide name)"><input className={INPUT} value={draft.icon || ''} onChange={(e) => set({ icon: e.target.value })} placeholder="palmtree" aria-label="Icon" /></Field>
              <Field label="Colour">
                <FancySelect value={draft.color} onChange={(v) => set({ color: v })} options={COLOR_NAMES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1), dot: COLOR_DOT[c] }))} aria-label="Colour" />
              </Field>
              <Field label="Booked in">
                <FancySelect value={draft.unit} onChange={(v) => set({ unit: v })} options={[{ value: 'day', label: 'Days' }, { value: 'hour', label: 'Hours' }]} aria-label="Unit" />
              </Field>
              <Field label="Shows as">
                <FancySelect value={draft.availability} onChange={(v) => set({ availability: v })} options={Object.entries(AVAILABILITY_LABEL).map(([value, label]) => ({ value, label }))} aria-label="Shows as" />
              </Field>
              <Field label="Colleagues see">
                <FancySelect value={draft.visibility} onChange={(v) => set({ visibility: v })} options={VISIBILITY} aria-label="Visibility" />
              </Field>
              <Field label="Sort order"><input type="number" className={INPUT} value={draft.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} aria-label="Sort order" /></Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle checked={draft.allowHalfDays} onChange={(v) => set({ allowHalfDays: v })} label="Half days allowed" disabled={draft.unit === 'hour'} />
              <Toggle checked={draft.requiresApproval} onChange={(v) => set({ requiresApproval: v })} label="Needs approval" />
              <Toggle checked={draft.requiresNote} onChange={(v) => set({ requiresNote: v })} label="Note required" />
              <Toggle checked={draft.allowPastDated} onChange={(v) => set({ allowPastDated: v })} label="Can be booked after the fact" />
              <Toggle checked={draft.isActive !== false} onChange={(v) => set({ isActive: v })} label="Active" />
              <Toggle checked={draft.tracksBalance} onChange={(v) => set({ tracksBalance: v })} label="Tracks a balance" />
            </div>
            {draft.tracksBalance && (
              <fieldset className="space-y-3 border-t border-border pt-3">
                <legend className="text-xs font-semibold text-foreground">Balance policy</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Days per year"><input type="number" step="0.5" className={INPUT} value={draft.balancePolicy.annualDays} onChange={(e) => setPolicy({ annualDays: e.target.value })} aria-label="Annual days" /></Field>
                  <Field label="Eligible after (days employed)"><input type="number" className={INPUT} value={draft.balancePolicy.eligibleAfterDays} onChange={(e) => setPolicy({ eligibleAfterDays: e.target.value })} aria-label="Eligible after days" /></Field>
                </div>
                {/* 7 Oct 2026: per-person allowances exist (People) but nothing here said so. */}
                <p className="text-xs text-muted-foreground" data-testid="per-person-hint">
                  This is the default for everyone. For people with a different allowance (15, 20, 25 days&hellip;), type their number under <strong className="font-semibold text-foreground/85">People</strong>, in the &ldquo;{draft.name || 'this type'} days/yr&rdquo; column. It replaces the default and the tenure steps for that person.
                </p>
                <Toggle checked={draft.balancePolicy.prorate} onChange={(v) => setPolicy({ prorate: v })} label="Prorate in the first year" />
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Tenure steps</p>
                  {tiers.map((t, i) => (
                    <div key={i} className="mb-1.5 flex items-center gap-2 text-sm text-foreground/85">
                      After
                      <input type="number" className={`${INPUT} w-20`} value={t.afterYears} onChange={(e) => setPolicy({ tenureTiers: tiers.map((x, j) => (j === i ? { ...x, afterYears: e.target.value } : x)) })} aria-label={`Tier ${i + 1} years`} />
                      years:
                      <input type="number" step="0.5" className={`${INPUT} w-20`} value={t.days} onChange={(e) => setPolicy({ tenureTiers: tiers.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)) })} aria-label={`Tier ${i + 1} days`} />
                      days
                      <button type="button" className={BTN_QUIET} onClick={() => setPolicy({ tenureTiers: tiers.filter((_, j) => j !== i) })} aria-label={`Remove tier ${i + 1}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                    </div>
                  ))}
                  <button type="button" className={BTN_LINK} onClick={() => setPolicy({ tenureTiers: [...tiers, { afterYears: 5, days: 20 }] })}><Plus className="h-4 w-4" aria-hidden="true" />Add a step</button>
                </div>
              </fieldset>
            )}
            <Field label="Vacation Tracker type names" hint="Comma-separated; used by the import and the opening-balance CSV.">
              <input className={INPUT} value={draft.vtText} onChange={(e) => set({ vtText: e.target.value })} aria-label="Vacation Tracker type names" />
            </Field>
          </>
        )}
      </Drawer>
    </section>
  );
}
