import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, UserRoundMinus, UserRoundPlus } from 'lucide-react';
import { hrLifecycleAPI } from '../../services/api';
import { ConfirmDialog, EmptyState, Loading } from '../knowledge/knowledgeUi';
import { Person, StatusDot, TicketRef } from './onboardingUi';
import { FAMILY_STATUS, KIND_LABEL, fmtDate, ticketTone } from './onboardingFormat';

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

/** One family's members: the children, the linked NH tickets and the re-sent / change notices. */
function FamilyDetail({ familyId, onChanged }) {
  const [family, setFamily] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    hrLifecycleAPI.family(familyId)
      .then((res) => setFamily(res?.data || null))
      .catch((err) => setError(err?.message || 'Could not load this family'));
  }, [familyId]);
  useEffect(() => { load(); }, [load]);

  const switchAfterFact = async () => {
    setBusy(true);
    try {
      await hrLifecycleAPI.switchToAfterTheFact(familyId);
      setConfirm(false);
      load();
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not switch');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!family) return <Loading label="Loading family…" className="py-6" />;
  const canSwitch = family.kind === 'offboarding' && family.status === 'open' && !family.afterTheFact;
  const role = { child: 'Child', linked: 'Linked', notice: 'Notice' };

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Parent <TicketRef ticket={family.parent} /></span>
        {family.employeeId && <span>BambooHR #{family.employeeId}</span>}
        {family.details?.title && <span>{family.details.title}</span>}
        {family.details?.manager && <span>Reports to {family.details.manager}</span>}
        {canSwitch && (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="tp-focus-ring ml-auto rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            Switch to after the fact
          </button>
        )}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {family.members.map((m) => (
          <li key={`${m.role}-${m.ticket?.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[5.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem_7rem]">
            <span className="text-xs text-muted-foreground">{role[m.role] || m.role}</span>
            <span className="min-w-0 truncate text-sm text-foreground">
              <TicketRef ticket={m.ticket} className="mr-2" />
              {m.title || m.ticket?.subject}
            </span>
            <span className="hidden sm:block"><Person name={m.ticket?.assignee?.name} photoUrl={m.ticket?.assignee?.photoUrl} size="h-5 w-5" /></span>
            <span className="hidden text-xs text-muted-foreground sm:block">{m.ticket?.dueBy ? `Due ${fmtDate(m.ticket.dueBy)}` : 'No due date'}</span>
            <StatusDot tone={ticketTone(m.ticket?.status)} label={m.ticket?.status || '—'} />
          </li>
        ))}
        {!family.members.length && <li className="px-3 py-3 text-sm text-muted-foreground">No children yet.</li>}
      </ul>
      <ConfirmDialog
        open={confirm}
        title="Switch to after the fact?"
        confirmLabel={busy ? 'Switching…' : 'Switch and close extras'}
        onCancel={() => setConfirm(false)}
        onConfirm={switchAfterFact}
      >
        The account was handled before the notice. Children that are not in the after-the-fact list (by default
        Disable Account and Decommissioning Account) are closed with a note. Devices stay open.
      </ConfirmDialog>
    </div>
  );
}

export default function PeoplePanel() {
  const [filter, setFilter] = useState('open');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    hrLifecycleAPI.families(filter === 'all' ? {} : { status: filter })
      .then((res) => setRows(Array.isArray(res?.data) ? res.data : []))
      .catch((err) => { setRows([]); setError(err?.message || 'Could not load people'); });
  }, [filter]);
  useEffect(() => { setRows(null); load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="Show families">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`tp-focus-ring rounded-md px-2.5 py-1 text-sm ${filter === f.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {rows === null ? <Loading label="Loading people…" /> : !rows.length ? (
        <EmptyState icon={UserRoundPlus} title="No families here">
          A family appears when an HR departure or new-hire notice arrives while the section is live.
          In Shadow the would-be families are under Activity.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-subtle">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Expand</span></th>
                <th scope="col" className="px-2 py-2 font-medium">Person</th>
                <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">Type</th>
                <th scope="col" className="px-2 py-2 font-medium">Date</th>
                <th scope="col" className="hidden px-2 py-2 font-medium md:table-cell">Children</th>
                <th scope="col" className="px-2 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((f) => {
                const open = openId === f.id;
                const pct = f.progress.total ? Math.round((f.progress.done / f.progress.total) * 100) : 0;
                const status = FAMILY_STATUS[f.status] || FAMILY_STATUS.open;
                const KindIcon = f.kind === 'offboarding' ? UserRoundMinus : UserRoundPlus;
                return (
                  <Fragment key={f.id}>
                    <tr className="cursor-pointer hover:bg-muted/50" onClick={() => setOpenId(open ? null : f.id)}>
                      <td className="px-2 py-2 align-middle">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} ${f.personName}'s tickets`}
                          onClick={(e) => { e.stopPropagation(); setOpenId(open ? null : f.id); }}
                          className="tp-focus-ring rounded p-0.5 text-muted-foreground hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="px-2 py-2"><Person name={f.personName} sub={f.office} /></td>
                      <td className="hidden px-2 py-2 sm:table-cell">
                        <span className="inline-flex items-center gap-1.5 text-foreground/85">
                          <KindIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                          {KIND_LABEL[f.kind] || f.kind}
                        </span>
                        {f.afterTheFact && <span className="block text-xs text-muted-foreground">after the fact</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-foreground/85">{fmtDate(f.effectiveDate, { withYear: true })}</td>
                      <td className="hidden px-2 py-2 md:table-cell">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="text-xs text-muted-foreground">{f.progress.done}/{f.progress.total} closed{f.linked ? ` · ${f.linked} linked` : ''}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2"><StatusDot tone={status.tone} label={status.label} /></td>
                    </tr>
                    {open && (
                      <tr className="bg-muted/30">
                        <td colSpan={6}><FamilyDetail familyId={f.id} onChanged={load} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
