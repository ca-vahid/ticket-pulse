import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { Switch } from '../../ui/switch';
import { availabilityAPI } from '../../../services/api';
import {
  AVAILABILITY_LABEL, BTN_LINK, BTN_QUIET, COLOR_DOT, COLOR_NAMES, ColorSwatch, ErrorNote, Field, INPUT, SectionTitle, StatusDot, Toggle,
} from '../availabilityUi';
import { Drawer, DrawerSection, SharedNote, TD, TH } from './adminUi';

/**
 * Leave types: the table, and a drawer with every field incl. the balance policy.
 *
 * 26 Nov 2026: the list is shared by every workspace and kept by the super
 * admins. A type can be switched off for one workspace (no row = on):
 *   - super admins edit the list, and in the drawer switch a type per workspace;
 *   - a workspace admin sees the list read-only, with a "Use in <workspace>"
 *     switch per type for each workspace they administer.
 */

const NO_ACCESS = { canEditTypes: true, workspaces: [], toggles: [] };
const keyOf = (typeId, wsId) => `${typeId}:${wsId}`;
const toggleMap = (list) => new Map((list || []).map((t) => [keyOf(t.leaveTypeId, t.workspaceId), t.enabled !== false]));

/** The "Used in" column: "Everywhere" / "All but Project Accounting" (each one switched off, by name) / "Nowhere". */
export function usedInSummary(typeId, workspaces, isOn) {
  const off = workspaces.filter((w) => !isOn(typeId, w.id));
  if (!workspaces.length) return '—';
  if (!off.length) return 'Everywhere';
  if (off.length === workspaces.length) return 'Nowhere';
  return `All but ${off.map((w) => w.name).join(', ')}`;
}

/** "Accounting" / "Accounting or IT": the workspaces a workspace admin's switches act on. */
const namesOr = (workspaces) => {
  const names = workspaces.map((w) => w.name);
  return names.length <= 1 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

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
  const [switchError, setSwitchError] = useState(null);
  const [busy, setBusy] = useState(null); // the switch being saved ("typeId:wsId")
  const access = config.typeAccess || NO_ACCESS;
  const canEdit = access.canEditTypes !== false;
  const workspaces = access.workspaces || [];
  // The switches, kept here so a change shows at once (the server is the truth on reload).
  const [toggles, setToggles] = useState(() => toggleMap(access.toggles));
  useEffect(() => { setToggles(toggleMap(config.typeAccess?.toggles)); }, [config.typeAccess]);
  const isOn = (typeId, wsId) => toggles.get(keyOf(typeId, wsId)) !== false;
  const types = [...(config.leaveTypes || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setPolicy = (patch) => setDraft((d) => ({ ...d, balancePolicy: { ...d.balancePolicy, ...patch } }));

  const openDraft = (t) => {
    setDraft({ ...toDraft(t), wsOn: Object.fromEntries(workspaces.map((w) => [w.id, t.id ? isOn(t.id, w.id) : true])) });
    setError(null);
  };

  /** A workspace admin's (or a super admin's) one switch: saved at once. */
  const flip = async (t, ws, enabled) => {
    const k = keyOf(t.id, ws.id);
    setSwitchError(null);
    setBusy(k);
    setToggles((m) => new Map(m).set(k, enabled));
    try {
      await availabilityAPI.setLeaveTypeWorkspace(t.id, ws.id, enabled);
      toast(`${t.name} turned ${enabled ? 'on' : 'off'} for ${ws.name}`);
    } catch (err) {
      setToggles((m) => new Map(m).set(k, !enabled));
      setSwitchError(err?.message || 'Could not change that');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) { setError('Give the type a name'); return; }
    setSaving(true);
    setError(null);
    const { vtText, wsOn = {}, ...rest } = draft;
    try {
      const res = await availabilityAPI.saveLeaveType({
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
      // The per-workspace switches that changed in the drawer, one call each.
      const typeId = rest.id || res?.data?.id;
      if (typeId) {
        for (const w of workspaces) {
          const want = wsOn[w.id] !== false;
          if (want === isOn(typeId, w.id)) continue;
          await availabilityAPI.setLeaveTypeWorkspace(typeId, w.id, want);
          setToggles((m) => new Map(m).set(keyOf(typeId, w.id), want));
        }
      }
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
        hint={canEdit
          ? <>What people can book. &ldquo;Shows as&rdquo; decides how a type shows on the dashboards; visibility what colleagues see. Open a type to choose where it is used.</>
          : <>What people can book.</>}
        action={canEdit ? <button type="button" className={BTN_LINK} onClick={() => openDraft(BLANK)}><Plus className="h-4 w-4" aria-hidden="true" />New type</button> : null}
      >
        Leave types
      </SectionTitle>
      {!canEdit && <SharedNote />}
      {!canEdit && workspaces.length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="ws-switch-hint">
          Switching a type off here hides it only for {namesOr(workspaces)}. People there can still see and cancel what they already booked.
        </p>
      )}
      <ErrorNote>{switchError}</ErrorNote>
      {/* relative: the table's sr-only labels are absolutely positioned and, without a
          positioned box here, escaped the scroller and widened the whole page on a phone. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr>
              <th className={TH}>Type</th><th className={TH}>Shows as</th><th className={TH}>Approval</th><th className={TH}>Balance</th><th className={TH}>Status</th>
              {canEdit && workspaces.length > 0 && <th className={TH}>Used in</th>}
              {!canEdit && workspaces.map((w) => <th key={w.id} className={TH}>Use in {w.name}</th>)}
              {canEdit && <th className={TH}><span className="sr-only">Edit</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {types.map((t) => (
              <tr key={t.id}>
                <td className={TD}><span className="flex items-center gap-2 text-foreground"><ColorSwatch color={t.color} />{t.name}</span><span className="block pl-[18px] text-xs text-muted-foreground">{t.unit === 'hour' ? 'Hours' : t.allowHalfDays ? 'Days, half days' : 'Whole days'}</span></td>
                <td className={`${TD} text-foreground/85`}>{AVAILABILITY_LABEL[t.availability] || t.availability}</td>
                <td className={`${TD} text-foreground/85`}>{t.requiresApproval ? 'Needs approval' : 'Automatic'}</td>
                <td className={`${TD} text-foreground/85`}>{t.tracksBalance ? `${t.balancePolicy?.annualDays ?? 0} days/yr` : '—'}</td>
                <td className={TD}><StatusDot tone={t.isActive === false ? 'grey' : 'green'} label={t.isActive === false ? 'Retired' : 'Active'} /></td>
                {canEdit && workspaces.length > 0 && (
                  <td className={`${TD} text-foreground/85`} data-testid={`used-in-${t.id}`}>{t.isActive === false ? '—' : usedInSummary(t.id, workspaces, isOn)}</td>
                )}
                {!canEdit && workspaces.map((w) => (
                  <td key={w.id} className={TD}>
                    {t.isActive === false ? <span className="text-muted-foreground">—</span> : (
                      <Switch
                        checked={isOn(t.id, w.id)}
                        disabled={busy === keyOf(t.id, w.id)}
                        onCheckedChange={(v) => flip(t, w, v === true)}
                        aria-label={`Use ${t.name} in ${w.name}`}
                      />
                    )}
                  </td>
                ))}
                {canEdit && (
                  <td className={`${TD} text-right`}>
                    <button type="button" className={BTN_QUIET} onClick={() => openDraft(t)} aria-label={`Edit ${t.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></button>
                  </td>
                )}
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
            {workspaces.length > 0 && (
              <DrawerSection title="Used in" hint="Switching one off hides this type only there. People there keep what they already booked.">
                <div className="grid gap-2 sm:grid-cols-2" data-testid="type-used-in">
                  {workspaces.map((w) => (
                    <Toggle
                      key={w.id}
                      checked={draft.wsOn?.[w.id] !== false}
                      onChange={(v) => setDraft((d) => ({ ...d, wsOn: { ...(d.wsOn || {}), [w.id]: v } }))}
                      label={w.name}
                    />
                  ))}
                </div>
              </DrawerSection>
            )}
          </>
        )}
      </Drawer>
    </section>
  );
}
