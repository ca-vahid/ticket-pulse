import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, AlertCircle, ArrowRight, ChevronDown, ChevronRight, Layers, Loader2, Repeat, Undo2 } from 'lucide-react';
import { ticketGroupingAPI } from '../../services/api';
import { formatDayTime, timeAgo } from './ticketUi';

const KIND_WORDS = { duplicate: 'Same request', update: 'Follow-up', related: 'Related', repeat: 'Repeat' };
const SENDER_KINDS = [
  { value: 'repeating', label: 'Repeats itself' },
  { value: 'distinct', label: 'Every mail is its own item' },
  { value: 'unsure', label: 'Not sure' },
];
const VIA_WORDS = { requester: 'same requester', relay: 'relayed from the same person', similar: 'similar text' };

const button = 'tp-focus-ring inline-flex items-center gap-1 rounded-lg border border-input bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground/85 transition-colors hover:bg-muted disabled:opacity-50';
const primary = 'tp-focus-ring inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';

function Section({ icon: Icon, title, count, children, note }) {
  return (
    <section className="tp-card overflow-hidden rounded-xl" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/35 px-4 py-2.5">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}{typeof count === 'number' ? ` (${count})` : ''}</h2>
        {note && <span className="text-xs text-muted-foreground/75">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function TicketLine({ ticket, backState, strong = false }) {
  if (!ticket) return null;
  return (
    <span className="min-w-0">
      <Link to={`/tickets/${ticket.id}`} state={backState} className={`tp-focus-ring rounded tabular-nums text-primary hover:underline ${strong ? 'font-semibold' : 'font-medium'}`}>{ticket.ref}</Link>
      <span className="ml-1.5 text-sm text-foreground">{ticket.subject}</span>
      {ticket.requester && <span className="ml-1.5 text-xs text-muted-foreground">{ticket.requester}</span>}
    </span>
  );
}

/** One pair: the newer ticket, the ticket it joins, and why. */
function Pair({ event, backState, children }) {
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid={`grouping-event-${event.id}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <TicketLine ticket={event.ticket} backState={backState} strong />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 translate-y-0.5 text-muted-foreground/75" aria-hidden="true" />
          <TicketLine ticket={event.target} backState={backState} />
          {event.target?.status && <span className="text-xs text-muted-foreground/75">{event.target.status}{event.target.assignee ? `, with ${event.target.assignee}` : ''}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/85">{KIND_WORDS[event.kind] || event.kind}</span>
          {event.reason ? `: ${event.reason}` : ''}
          {event.via && VIA_WORDS[event.via] ? ` (${VIA_WORDS[event.via]})` : ''}
          <span className="text-muted-foreground/75"> · {timeAgo(event.createdAt)}</span>
        </p>
        {event.retraction && <p className="text-xs font-medium text-amber-700 dark:text-amber-300">The requester says it is no longer needed.</p>}
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

/**
 * The "Grouped" view of Tickets (plans/TICKET_GROUPING_PLAN.md): what Ticket
 * Pulse combined on its own, what it only suggests, and the senders it has
 * learned. Everything it did has an Undo; a person never has to hunt for it.
 */
export default function GroupedTicketsPanel() {
  const location = useLocation();
  const backState = { from: `${location.pathname}${location.search}` };
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await ticketGroupingAPI.get();
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.status === 403 ? 'Only coordinators and admins can review grouped tickets.' : (err.response?.data?.message || err.message));
      setData((d) => d || { settings: { mode: 'off', peopleAuto: true }, waiting: [], combined: [], repeats: [], reversed: [], senders: [], canManage: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  };
  const spin = (key) => (busy === key ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null);
  const toggle = (id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (data === null) {
    return (
      <div className="tp-card flex items-center justify-center rounded-xl p-16">
        <Activity className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-300" aria-label="Loading grouped tickets" />
      </div>
    );
  }

  const { settings, waiting, combined, repeats, reversed, senders, canManage } = data;
  const on = settings.mode === 'on';
  const repeatTotal = repeats.reduce((sum, g) => sum + g.count, 0);

  return (
    <div className="space-y-4" data-testid="grouped-tickets">
      {error && (
        <div className="tp-card flex items-start gap-2 rounded-xl p-3" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden="true" />
          <span className="text-sm text-red-700 dark:text-red-200">{error}</span>
        </div>
      )}

      <div className="tp-card rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className={`h-2 w-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
              Grouping is {on ? 'on' : 'off'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One ticket per problem. The same alert again while its ticket is open is closed into that ticket and counted there.
              A second ticket about one request is {settings.peopleAuto ? 'combined when Ticket Pulse is sure and it is the same person; otherwise it is suggested here' : 'suggested here for a person to decide'}.
              Grouped copies are left out of the ticket totals.
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={button} disabled={busy === 'mode'} onClick={() => act('mode', () => ticketGroupingAPI.saveSettings({ mode: on ? 'off' : 'on' }))}>
                {spin('mode')}{on ? 'Turn off' : 'Turn on'}
              </button>
              <button type="button" className={button} disabled={busy === 'people' || !on} onClick={() => act('people', () => ticketGroupingAPI.saveSettings({ peopleAuto: !settings.peopleAuto }))}>
                {spin('people')}{settings.peopleAuto ? 'Only suggest for people' : 'Combine when sure'}
              </button>
            </div>
          )}
        </div>
      </div>

      <Section icon={Layers} title="Waiting for you" count={waiting.length} note="Ticket Pulse was not sure enough, or it is another person's ticket.">
        {waiting.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground/75">Nothing to decide.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {waiting.map((e) => (
              <Pair key={e.id} event={e} backState={backState}>
                <button type="button" className={primary} disabled={busy === `accept:${e.id}`} onClick={() => act(`accept:${e.id}`, () => ticketGroupingAPI.accept(e.id))}>
                  {spin(`accept:${e.id}`)}{e.kind === 'related' ? 'Link' : 'Combine'}
                </button>
                <button type="button" className={button} disabled={busy === `dismiss:${e.id}`} onClick={() => act(`dismiss:${e.id}`, () => ticketGroupingAPI.dismiss(e.id))}>
                  {spin(`dismiss:${e.id}`)}Not related
                </button>
              </Pair>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={Repeat} title="Repeating alerts" count={repeats.length} note={repeatTotal ? `${repeatTotal} repeat${repeatTotal === 1 ? '' : 's'} closed in the last ${data.days} days.` : null}>
        {repeats.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground/75">No alert has repeated in the last {data.days} days.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {repeats.map((g) => {
              const isOpen = open.has(g.target.id);
              return (
                <li key={g.target.id} data-testid={`grouping-repeats-${g.target.id}`}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button type="button" className="tp-focus-ring rounded p-0.5 text-muted-foreground hover:text-foreground" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the repeats of ${g.target.ref}`} onClick={() => toggle(g.target.id)}>
                      {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <TicketLine ticket={g.target} backState={backState} strong />
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-semibold tabular-nums text-foreground/85">{g.count} repeat{g.count === 1 ? '' : 's'} closed</span>
                        {g.target.occurrenceCount > 0 ? `, seen ${g.target.occurrenceCount} times in all` : ''} · latest {formatDayTime(g.latestAt)} · this ticket is {g.target.status}{g.target.assignee ? `, with ${g.target.assignee}` : ', nobody assigned'}
                      </p>
                    </div>
                  </div>
                  {isOpen && (
                    <ul className="border-t border-border/60 bg-muted/25 px-4 py-2 pl-12">
                      {g.events.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
                          <Link to={`/tickets/${r.ticket.id}`} state={backState} className="tp-focus-ring rounded tabular-nums text-primary hover:underline">{r.ticket.ref}</Link>
                          <span className="text-muted-foreground">{formatDayTime(r.ticket.createdAt)}</span>
                          <button type="button" className={`${button} ml-auto`} disabled={busy === `undo:${r.id}`} onClick={() => act(`undo:${r.id}`, () => ticketGroupingAPI.undo(r.id))}>
                            {busy === `undo:${r.id}` ? spin(`undo:${r.id}`) : <Undo2 className="h-3 w-3" aria-hidden="true" />}Undo
                          </button>
                        </li>
                      ))}
                      {g.count > g.events.length && <li className="py-1.5 text-xs text-muted-foreground/75">Showing the latest {g.events.length} of {g.count}.</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section icon={Layers} title="Combined on its own" count={combined.length} note={`Last ${data.days} days.`}>
        {combined.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground/75">Nothing was combined.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {combined.map((e) => (
              <Pair key={e.id} event={e} backState={backState}>
                <button type="button" className={button} disabled={busy === `undo:${e.id}`} onClick={() => act(`undo:${e.id}`, () => ticketGroupingAPI.undo(e.id))}>
                  {busy === `undo:${e.id}` ? spin(`undo:${e.id}`) : <Undo2 className="h-3 w-3" aria-hidden="true" />}Undo
                </button>
              </Pair>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Senders Ticket Pulse has learned" count={senders.length} note="Decided once per sender and subject. Change it here if it is wrong.">
        {senders.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground/75">No sender has sent the same subject twice while the first ticket was open.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {senders.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`grouping-sender-${s.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{s.sender}</p>
                  <p className="truncate text-xs text-muted-foreground" title={s.sampleSubject || s.template}>{s.sampleSubject || s.template}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground/75">
                    {s.reason || 'No reason recorded.'} {s.decidedBy === 'ai' ? 'Decided by Ticket Pulse.' : `Set by ${s.decidedBy}.`}
                    {s.repeatCount > 0 ? ` ${s.repeatCount} repeat${s.repeatCount === 1 ? '' : 's'} closed.` : ''}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="sr-only">What {s.sender} sends</span>
                  <select
                    className="tp-focus-ring rounded-lg border border-input bg-card px-2 py-1.5 text-xs text-foreground"
                    value={s.kind}
                    disabled={!canManage || busy === `sender:${s.id}`}
                    onChange={(ev) => act(`sender:${s.id}`, () => ticketGroupingAPI.updateSender(s.id, { kind: ev.target.value }))}
                  >
                    {SENDER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </label>
                {s.kind === 'repeating' && canManage && (
                  <button type="button" className={button} disabled={busy === `sender:${s.id}`} onClick={() => act(`sender:${s.id}`, () => ticketGroupingAPI.updateSender(s.id, { enabled: !s.enabled }))}>
                    {s.enabled ? 'Stop grouping' : 'Group again'}
                  </button>
                )}
                {s.kind === 'repeating' && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`h-1.5 w-1.5 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                    {s.enabled ? 'Grouped' : 'Paused'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {reversed.length > 0 && (
        <Section title="Undone or dismissed" count={reversed.length}>
          <ul className="divide-y divide-border/60">
            {reversed.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
                <Link to={`/tickets/${e.ticket.id}`} state={backState} className="tp-focus-ring rounded tabular-nums text-primary hover:underline">{e.ticket.ref}</Link>
                <span>{e.state === 'undone' ? 'put back from' : 'not related to'}</span>
                <Link to={`/tickets/${e.target.id}`} state={backState} className="tp-focus-ring rounded tabular-nums text-primary hover:underline">{e.target.ref}</Link>
                <span className="text-muted-foreground/75">{e.decidedBy ? `by ${e.decidedBy}` : ''} {e.decidedAt ? timeAgo(e.decidedAt) : ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
