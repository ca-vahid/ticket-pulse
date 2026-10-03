import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { PersonAvatar } from '../../tickets/ticketUi';
import { availabilityAPI } from '../../../services/api';
import { BTN_LINK, INPUT, SectionTitle, WEEKDAYS } from '../availabilityUi';
import { TD, TH } from './adminUi';

/**
 * People: office, start date (drives tenure and proration), working days and
 * daily hours. Each change saves on its own (PATCH per person).
 */

function PersonRow({ p, officeOptions, onSave }) {
  const [busy, setBusy] = useState(false);
  const workdays = Array.isArray(p.workdays) && p.workdays.length ? p.workdays.map(Number) : [1, 2, 3, 4, 5];
  const save = async (patch) => {
    setBusy(true);
    try { await onSave(p, patch); } finally { setBusy(false); }
  };
  return (
    <tr>
      <td className={TD}>
        <span className="flex items-center gap-2">
          <PersonAvatar name={p.name} size="h-6 w-6" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-foreground">{p.name || p.email}</span>
            <span className="block truncate text-xs text-muted-foreground">{p.email}</span>
          </span>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
        </span>
      </td>
      <td className={TD}>
        <FancySelect value={p.officeId == null ? '' : String(p.officeId)} onChange={(v) => save({ officeId: v ? Number(v) : null })} options={officeOptions} aria-label={`${p.name || p.email} office`} className="w-40" />
      </td>
      <td className={TD}>
        <input type="date" className={`${INPUT} w-36`} defaultValue={p.startDate ? String(p.startDate).slice(0, 10) : ''} onBlur={(e) => { const v = e.target.value || null; if (v !== (p.startDate ? String(p.startDate).slice(0, 10) : null)) save({ startDate: v }); }} aria-label={`${p.name || p.email} start date`} />
      </td>
      <td className={TD}>
        <span className="flex gap-0.5" role="group" aria-label={`${p.name || p.email} working days`}>
          {WEEKDAYS.map((d) => {
            const on = workdays.includes(d.n);
            return (
              <button
                key={d.n}
                type="button"
                aria-pressed={on}
                aria-label={d.label}
                title={d.label}
                onClick={() => save({ workdays: on ? workdays.filter((x) => x !== d.n) : [...workdays, d.n].sort() })}
                className={`tp-focus-ring h-7 w-7 rounded-md text-xs font-medium ${on ? 'bg-primary/10 text-primary dark:bg-primary/20' : 'text-muted-foreground/75 hover:bg-muted'}`}
              >
                {d.short}
              </button>
            );
          })}
        </span>
      </td>
      <td className={TD}>
        <input type="number" min={1} max={24} step="0.25" className={`${INPUT} w-20`} defaultValue={p.dailyHours ?? 8} onBlur={(e) => { const v = Number(e.target.value); if (v && v !== Number(p.dailyHours)) save({ dailyHours: v }); }} aria-label={`${p.name || p.email} daily hours`} />
      </td>
    </tr>
  );
}

export default function PeopleSection({ config, reload, toast }) {
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const officeOptions = [{ value: '', label: 'No office' }, ...(config.offices || []).map((o) => ({ value: String(o.id), label: o.name }))];
  const people = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = [...(config.people || [])].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    return term ? all.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(term)) : all;
  }, [config.people, q]);

  const savePerson = async (p, patch) => {
    try {
      await availabilityAPI.updatePerson(p.id, patch);
      toast(`${p.name || p.email} updated`);
      reload();
    } catch (err) {
      toast(err?.message || 'Could not save', 'red');
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await availabilityAPI.syncPeople();
      const d = res?.data || {};
      toast(d.created != null ? `People refreshed — ${d.created} added` : 'People refreshed');
      reload();
    } catch (err) {
      toast(err?.message || 'Could not refresh people', 'red');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section aria-label="People">
      <SectionTitle
        hint="Start date drives tenure steps and first-year proration. Working days decide which days a request counts."
        action={(
          <button type="button" className={BTN_LINK} onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Refresh from Ticket Pulse users
          </button>
        )}
      >
        People
      </SectionTitle>
      <div className="relative mb-2 max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input type="search" className={`${INPUT} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead><tr><th className={TH}>Person</th><th className={TH}>Office</th><th className={TH}>Start date</th><th className={TH}>Working days</th><th className={TH}>Hours/day</th></tr></thead>
          <tbody className="divide-y divide-border">
            {people.map((p) => <PersonRow key={p.id} p={p} officeOptions={officeOptions} onSave={savePerson} />)}
          </tbody>
        </table>
      </div>
      {!people.length && <p className="py-4 text-sm text-muted-foreground">{q ? 'Nobody matches.' : 'No people yet — refresh from Ticket Pulse users.'}</p>}
    </section>
  );
}
