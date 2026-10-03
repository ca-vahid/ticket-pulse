import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { availabilityAPI } from '../../../services/api';
import { BTN_LINK, BTN_QUIET, Field, INPUT, SectionTitle, StatusDot, Toggle } from '../availabilityUi';
import { Drawer, TD, TH } from './adminUi';

/** Offices: the province picks the statutory holidays; the time zone the day boundaries. */

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const ZONES = ['America/Vancouver', 'America/Edmonton', 'America/Regina', 'America/Winnipeg', 'America/Toronto', 'America/Halifax', 'America/St_Johns', 'Europe/London', 'Australia/Sydney', 'UTC'];
const BLANK = { name: '', province: 'BC', timezone: 'America/Vancouver', isActive: true };

export default function OfficesSection({ config, reload, toast }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const peopleIn = (id) => (config.people || []).filter((p) => p.officeId === id).length;

  const save = async () => {
    if (!draft.name.trim()) { setError('Give the office a name'); return; }
    setSaving(true);
    setError(null);
    try {
      await availabilityAPI.saveOffice({ id: draft.id, name: draft.name.trim(), province: draft.province || null, timezone: draft.timezone, isActive: draft.isActive !== false });
      toast(`${draft.name.trim()} saved`);
      setDraft(null);
      reload();
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const zoneOptions = [...new Set([...ZONES, draft?.timezone].filter(Boolean))].map((z) => ({ value: z, label: z.replace('_', ' ') }));

  return (
    <section aria-label="Offices">
      <SectionTitle
        hint="The province decides which statutory holidays are skipped."
        action={<button type="button" className={BTN_LINK} onClick={() => { setDraft({ ...BLANK }); setError(null); }}><Plus className="h-4 w-4" aria-hidden="true" />New office</button>}
      >
        Offices
      </SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead><tr><th className={TH}>Office</th><th className={TH}>Province</th><th className={TH}>Time zone</th><th className={TH}>People</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Edit</span></th></tr></thead>
          <tbody className="divide-y divide-border">
            {(config.offices || []).map((o) => (
              <tr key={o.id}>
                <td className={`${TD} text-foreground`}>{o.name}</td>
                <td className={`${TD} text-foreground/85`}>{o.province || '—'}</td>
                <td className={`${TD} text-foreground/85`}>{o.timezone || '—'}</td>
                <td className={`${TD} tabular-nums text-foreground/85`}>{peopleIn(o.id)}</td>
                <td className={TD}><StatusDot tone={o.isActive === false ? 'grey' : 'green'} label={o.isActive === false ? 'Closed' : 'Open'} /></td>
                <td className={`${TD} text-right`}><button type="button" className={BTN_QUIET} onClick={() => { setDraft({ ...BLANK, ...o }); setError(null); }} aria-label={`Edit ${o.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={Boolean(draft)} title={draft?.id ? `Edit ${draft.name}` : 'New office'} onClose={() => setDraft(null)} onSave={save} saving={saving} error={error}>
        {draft && (
          <>
            <Field label="Name"><input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-label="Office name" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Province">
                <FancySelect value={draft.province || ''} onChange={(v) => set({ province: v || null })} options={[{ value: '', label: 'None' }, ...PROVINCES.map((p) => ({ value: p, label: p }))]} aria-label="Province" />
              </Field>
              <Field label="Time zone">
                <FancySelect value={draft.timezone} onChange={(v) => set({ timezone: v })} options={zoneOptions} aria-label="Time zone" />
              </Field>
            </div>
            <Toggle checked={draft.isActive !== false} onChange={(v) => set({ isActive: v })} label="Open" />
          </>
        )}
      </Drawer>
    </section>
  );
}
