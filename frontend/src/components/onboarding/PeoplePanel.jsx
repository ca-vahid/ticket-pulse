import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, UserRoundMinus, UserRoundPlus } from 'lucide-react';
import { hrLifecycleAPI, ticketsAPI } from '../../services/api';
import { ConfirmDialog, EmptyState, Loading } from '../knowledge/knowledgeUi';
import AssigneePicker from '../tickets/AssigneePicker';
import { AvatarStack, NoticePerson, Person, SectionTitle, StatusDot, TicketRef } from './onboardingUi';
import { FAMILY_STATUS, KIND_LABEL, fmtDate, ticketTone } from './onboardingFormat';

const KINDS = [
  { id: 'all', label: 'Everyone' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'offboarding', label: 'Offboarding' },
];

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

/**
 * Live: open departure / new-hire notices that have no family yet (they
 * arrived before Live). Organise takes in the tickets that already exist and
 * creates only the missing ones.
 */
function NotOrganised({ onDone, kind = 'all' }) {
  const [rows, setRows] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(() => {
    hrLifecycleAPI.candidates()
      .then((res) => setRows(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const organise = async () => {
    const c = confirm;
    setBusy(true);
    setMessage(null);
    try {
      const res = await hrLifecycleAPI.organise(c.ticketId);
      const n = res?.data?.warnings?.length || 0;
      setMessage(n
        ? { ok: false, text: `${c.personName}: organised with ${n} ${n === 1 ? 'warning' : 'warnings'} — see Activity.` }
        : { ok: true, text: `${c.personName}: organised.` });
      load();
      onDone?.();
    } catch (err) {
      setMessage({ ok: false, text: err?.message || 'Could not organise' });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const shown = (rows || []).filter((c) => kind === 'all' || c.kind === kind);
  if (!shown.length && !message) return null;
  return (
    <section className="mb-6" aria-label="Not organised yet">
      {shown.length > 0 && (
        <SectionTitle hint="These notices arrived before Live. Organise takes in the tickets that already exist and creates only the missing ones.">
          Not organised yet
        </SectionTitle>
      )}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={`mb-2 text-sm ${message.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{message.text}</p>
      )}
      {shown.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-subtle">
          {shown.map((c) => (
            <li key={c.ticketId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
              <NoticePerson name={c.personName} email={c.personEmail} sub={`${KIND_LABEL[c.kind] || c.kind} · ${fmtDate(c.effectiveDate, { withYear: true })}${c.afterTheFact ? ' · after the fact' : ''}`} />
              <span className="order-last col-span-2 min-w-0 text-xs text-muted-foreground md:order-none md:col-span-1">
                <span className="block truncate">
                  Notice <TicketRef ticket={c.parent} />
                  {c.parent?.assignee?.name ? ` · ${c.parent.assignee.name}` : ''}
                  {c.existing.length > 0 && ` · has ${c.existing.map((x) => `${x.title} ${x.ref}`).join(', ')}`}
                </span>
                <span className="block truncate text-foreground/85">
                  {c.toCreate.length ? `Will create ${c.toCreate.map((x) => x.title).join(', ')}` : 'Nothing to create'}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm(c)}
                aria-label={`Organise ${c.personName}`}
                className="tp-focus-ring rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
              >
                Organise
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={`Organise ${confirm?.personName || 'this person'}?`}
        confirmLabel={busy ? 'Organising…' : 'Organise'}
        onCancel={() => setConfirm(null)}
        onConfirm={organise}
      >
        {confirm?.existing?.length
          ? `${confirm.existing.length} existing ${confirm.existing.length === 1 ? 'ticket joins' : 'tickets join'} the family as they are. `
          : ''}
        {confirm?.toCreate?.length
          ? `Ticket Pulse creates ${confirm.toCreate.map((x) => x.title).join(', ')}.`
          : 'No new ticket is created.'}
        {' '}The notice keeps its owner if it has one.
      </ConfirmDialog>
    </section>
  );
}

/** A family Shadow recorded: the children Live would create (2 Oct 2026). */
function ShadowFamilyDetail({ family }) {
  return (
    <div className="px-4 pb-4 pt-1" data-testid="shadow-family-detail">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Parent <TicketRef ticket={family.parent} /></span>
        {family.parentAssignee && <span>would be assigned to {family.parentAssignee}</span>}
        {family.employeeId && <span>BambooHR #{family.employeeId}</span>}
        {family.dateMoved && <span>date changed by a later notice</span>}
        {family.linked > 0 && <span>{family.linked} NH {family.linked === 1 ? 'ticket' : 'tickets'} would be linked</span>}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">Shadow: nothing below exists yet. Live would create these child tickets.</p>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {(family.plannedChildren || []).map((c) => (
          <li key={c.title} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
            <span className="min-w-[10rem] font-medium text-foreground">{c.title}</span>
            <span className="text-muted-foreground">{c.dueDate ? `due ${fmtDate(c.dueDate, { withYear: true })}` : 'no date'}</span>
            <span className="text-muted-foreground">{c.assignee || 'AI routing'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One family's members: the children, the linked NH tickets and the re-sent / change notices. */
function FamilyDetail({ familyId, onChanged, techById = new Map() }) {
  const [family, setFamily] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [noteBad, setNoteBad] = useState(false);
  const say = (text, bad = false) => { setNote(text); setNoteBad(bad); };
  const technicians = useMemo(() => [...techById.values()], [techById]);

  const reroute = async () => {
    setBusy(true);
    say(null);
    try {
      const res = await hrLifecycleAPI.rerouteFamily(familyId);
      const d = res?.data || {};
      const n = d.moved?.length || 0;
      say(n ? `${n} ${n === 1 ? 'ticket' : 'tickets'} assigned to ${d.assignee?.name} (${d.office}).` : `Nothing to move: the open tickets are already with the ${d.office} people.`);
      load();
      onChanged?.();
    } catch (err) {
      say(err?.message || 'Could not reassign', true);
    } finally {
      setBusy(false);
    }
  };

  const park = async () => {
    setBusy(true);
    say(null);
    try {
      const res = await hrLifecycleAPI.parkFamily(familyId);
      const d = res?.data || {};
      const n = d.parked?.length || 0;
      say(n ? `${n} ${n === 1 ? 'ticket sleeps' : 'tickets sleep'} until ${fmtDate(d.until, { withYear: true })} with no owner; the owner is chosen that day.` : 'Nothing to park: the work is due to start, or the tickets are already asleep with no owner.');
      load();
      onChanged?.();
    } catch (err) {
      say(err?.message || 'Could not park', true);
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(() => {
    hrLifecycleAPI.family(familyId)
      .then((res) => setFamily(res?.data || null))
      .catch((err) => setError(err?.message || 'Could not load this family'));
  }, [familyId]);
  useEffect(() => { load(); }, [load]);

  /**
   * Change who holds one open child, in place (QA 10-09 #1). A Ticket Pulse
   * ticket is assigned here; a FreshService ticket is written to FreshService
   * first and only then changes here. The picker shows its own spinner; a
   * refusal lands in the note line and the row keeps its owner.
   */
  const assignChild = (ticket) => async (techId, extra = null) => {
    const fsBorn = ticket.origin === 'freshservice';
    setBusy(true);
    say(fsBorn ? `Writing ${ticket.ref} to FreshService…` : null);
    try {
      const res = fsBorn
        ? await ticketsAPI.fsUpdate(ticket.id, { assignedTechId: techId, ...(extra?.handBack ? { handBack: extra.handBack } : {}) })
        : await ticketsAPI.assign(ticket.id, techId, extra || {});
      say(techId == null
        ? `${ticket.ref} has no owner now.`
        : `${ticket.ref} assigned to ${techById.get(techId)?.name || 'the chosen person'}${fsBorn ? ' in FreshService' : ''}.`);
      return res;
    } catch (err) {
      say(err?.response?.data?.message || err?.message || 'Could not assign', true);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const switchAfterFact = async () => {
    setBusy(true);
    try {
      await hrLifecycleAPI.switchToAfterTheFact(familyId);
      setConfirm(false);
      say(null);
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
  // Offered only while the switch would close something: an open child the after-the-fact list does not have.
  const switchCloses = family.kind === 'offboarding' && family.status === 'open' && !family.afterTheFact ? (family.afterTheFactCloses || []) : [];
  const canSwitch = switchCloses.length > 0;
  // Offered while a child is awake or still has an owner; inside the lead time the server leaves everything as it is.
  const canPark = family.status === 'open' && family.effectiveDate && family.members.some((m) => m.role === 'child' && !m.closed && (!m.ticket?.parkedUntil || m.ticket?.assignee));
  const role = { child: 'Child', linked: 'Linked', notice: 'Notice' };

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Parent <TicketRef ticket={family.parent} /></span>
        {family.employeeId && <span>BambooHR #{family.employeeId}</span>}
        {family.details?.title && <span>{family.details.title}</span>}
        {family.details?.manager && <span>Reports to {family.details.manager}</span>}
        {canPark && (
          <button
            type="button"
            disabled={busy}
            onClick={park}
            title="Open tickets sleep with no owner until the lead time before the date (new hire: 21 days; departure: 14 days); the owner is chosen when they wake"
            className="tp-focus-ring ml-auto rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
          >
            Park until needed
          </button>
        )}
        {family.kind === 'onboarding' && family.status === 'open' && family.members.some((m) => m.role === 'child' && !m.closed && !m.ticket?.parkedUntil) && (
          <button
            type="button"
            disabled={busy}
            onClick={reroute}
            title={`Open tickets held outside the ${family.officeList || 'office'} list move to one person on it`}
            className={`tp-focus-ring ${canPark ? '' : 'ml-auto '}rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40`}
          >
            {busy ? 'Working…' : 'Reassign by office'}
          </button>
        )}
      </div>
      {note && <p role={noteBad ? 'alert' : 'status'} className={`mb-2 text-xs ${noteBad ? 'text-red-700 dark:text-red-300' : 'text-foreground/85'}`}>{note}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {family.members.map((m) => (
          <li key={`${m.role}-${m.ticket?.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[5.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem_7rem]">
            <span className="text-xs text-muted-foreground">{role[m.role] || m.role}</span>
            <span className="min-w-0 truncate text-sm text-foreground">
              <TicketRef ticket={m.ticket} className="mr-2" />
              {m.title || m.ticket?.subject}
            </span>
            <span className="hidden min-w-0 sm:block">
              {m.closed || !m.ticket ? (
                <Person name={m.ticket?.assignee?.name} photoUrl={m.ticket?.assignee?.photoUrl || techById.get(m.ticket?.assignee?.id)?.photoUrl || null} size="h-5 w-5" />
              ) : (
                <>
                  <AssigneePicker
                    ticketId={m.ticket.id}
                    value={m.ticket.assignee?.id ?? null}
                    technicians={technicians}
                    currentTech={m.ticket.assignee ? { ...m.ticket.assignee, photoUrl: m.ticket.assignee.photoUrl || techById.get(m.ticket.assignee.id)?.photoUrl || null } : null}
                    ticketOrigin={m.ticket.origin || null}
                    assignFn={assignChild(m.ticket)}
                    onAssigned={() => { load(); onChanged?.(); }}
                    disabled={busy}
                    size="sm"
                    showAi={false}
                  />
                  {!m.ticket.assignee && m.ticket.parkedUntil && <span className="block pl-1.5 text-xs text-muted-foreground">Assigned when it wakes</span>}
                </>
              )}
            </span>
            <span className="hidden text-xs text-muted-foreground sm:block">
              {m.ticket?.dueBy ? `Due ${fmtDate(m.ticket.dueBy)}` : 'No due date'}
              {m.ticket?.parkedUntil && !m.closed && <span className="block">Parked to {fmtDate(m.ticket.parkedUntil)}</span>}
            </span>
            <StatusDot tone={ticketTone(m.ticket?.status)} label={m.ticket?.status || '—'} />
          </li>
        ))}
        {!family.members.length && <li className="px-3 py-3 text-sm text-muted-foreground">No children yet.</li>}
      </ul>
      {canSwitch && (
        <p className="mt-2 text-xs text-muted-foreground">
          Account already handled before the notice?{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm(true)}
            className="tp-focus-ring rounded font-medium text-primary hover:underline disabled:opacity-40"
          >
            Switch to after the fact
          </button>
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title="Switch to after the fact?"
        confirmLabel={busy ? 'Switching…' : 'Switch and close extras'}
        onCancel={() => setConfirm(false)}
        onConfirm={switchAfterFact}
      >
        The account was handled before the notice. This closes{' '}
        {switchCloses.map((c) => `${c.title || 'a ticket'} (${c.ref})`).join(', ')} with a note. Every other ticket stays as it is.
      </ConfirmDialog>
    </div>
  );
}

export default function PeoplePanel({ mode = null, techById = new Map() }) {
  const [filter, setFilter] = useState('open');
  const [kind, setKind] = useState('all');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    hrLifecycleAPI.families({ ...(filter === 'all' ? {} : { status: filter }), ...(kind === 'all' ? {} : { kind }) })
      .then((res) => setRows(Array.isArray(res?.data) ? res.data : []))
      .catch((err) => { setRows([]); setError(err?.message || 'Could not load people'); });
  }, [filter, kind]);
  useEffect(() => { setRows(null); load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-1" role="group" aria-label="Onboarding or offboarding">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={`tp-focus-ring rounded-md px-2.5 py-1 text-sm ${kind === k.id ? 'bg-primary/10 font-medium text-primary dark:bg-primary/20' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show families">
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
      </div>
      {error && <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {mode === 'live' && (filter === 'open' || filter === 'all') && <NotOrganised onDone={load} kind={kind} />}
      {rows === null ? <Loading label="Loading people…" /> : !rows.length ? (
        <EmptyState icon={UserRoundPlus} title="No families here">
          A family appears when an HR departure or new-hire notice arrives. In Shadow it is listed
          here with the child tickets Live would create; nothing is created until Live.
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
                <th scope="col" className="hidden px-2 py-2 font-medium lg:table-cell">With</th>
                <th scope="col" className="px-2 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((f) => {
                const open = openId === f.id;
                const pct = f.progress.total ? Math.round((f.progress.done / f.progress.total) * 100) : 0;
                const status = f.shadow
                  ? { tone: 'amber', label: f.status === 'cancelled' ? 'Shadow · cancelled' : 'Shadow' }
                  : (FAMILY_STATUS[f.status] || FAMILY_STATUS.open);
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
                      <td className="px-2 py-2"><NoticePerson name={f.personName} email={f.personEmail} sub={f.office} /></td>
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
                          <span className="text-xs text-muted-foreground">{f.shadow ? `${f.progress.total} would be created` : `${f.progress.done}/${f.progress.total} closed`}{f.linked ? ` · ${f.linked} linked` : ''}</span>
                        </div>
                      </td>
                      <td className="hidden px-2 py-2 lg:table-cell">
                        {f.shadow ? <span className="text-xs text-muted-foreground">—</span> : (
                          <AvatarStack people={(f.assignees || []).map((a) => ({ ...a, photoUrl: techById.get(a.id)?.photoUrl || null }))} empty={f.asleep ? 'Asleep, no owner yet' : 'Nobody yet'} />
                        )}
                      </td>
                      <td className="px-2 py-2"><StatusDot tone={status.tone} label={status.label} /></td>
                    </tr>
                    {open && (
                      <tr className="bg-muted/30">
                        <td colSpan={7}>{f.shadow ? <ShadowFamilyDetail family={f} /> : <FamilyDetail familyId={f.id} onChanged={load} techById={techById} />}</td>
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
