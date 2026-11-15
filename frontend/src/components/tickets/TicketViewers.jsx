import { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { motionReduced } from '../../utils/motionPreference';
import { agoWords, formatPacificFull } from '../../utils/ticketDates';
import './TicketViewers.css';

/**
 * Who else is on this ticket (MEGA 11-14 Part K). Replaces the small
 * "also viewing" chip in the badge row: a larger eye with the count in it and
 * the name beside it, at the right end of the header's action row.
 *
 * On a change, and only then, the eye moves once (under a second): it opens
 * when someone arrives and closes when someone leaves, and the line reads
 * "Sam Ortiz left" for a few seconds. With the app's motion setting off the
 * name line gets a short underline + tint instead. A polite live region says
 * the same for screen readers. Nothing renders when you are alone.
 *
 * Presence is live and in memory only (presenceService.js). "Since" here is
 * what this page saw — "Here when you opened it" or "Arrived 5 min ago" —
 * never a stored duration.
 */

export const CHANGE_MS = 1000; // eye move / flash window
export const LEFT_MS = 5000; // how long "Sam left" stays
const INITIAL_GRACE_MS = 4000; // first heartbeat after opening = "already here"

const nameOf = (v) => String(v?.name || v?.email || 'Someone').trim() || 'Someone';
const firstOf = (v) => nameOf(v).split(/\s+/)[0];
const initialsOf = (v) => nameOf(v).split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export const isWriting = (v) => v?.composing === 'reply' || v?.composing === 'note';

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Sam Ortiz is here" · "Sam and Kim are here" · "Sam and 3 others are here". */
export function hereLine(viewers) {
  const n = viewers.length;
  if (n === 0) return '';
  if (n === 1) return `${nameOf(viewers[0])} is here`;
  if (n === 2) return `${firstOf(viewers[0])} and ${firstOf(viewers[1])} are here`;
  return `${firstOf(viewers[0])} and ${n - 1} others are here`;
}

/** "Sam Ortiz left" · "Sam and Kim left" · "3 people left". */
export function leftLine(people) {
  const n = people.length;
  if (n === 1) return `${nameOf(people[0])} left`;
  if (n === 2) return `${firstOf(people[0])} and ${firstOf(people[1])} left`;
  return `${n} people left`;
}

/** Writers first, then the latest arrival. */
export function orderViewers(viewers, since = {}) {
  return [...viewers].sort((a, b) => (Number(isWriting(b)) - Number(isWriting(a)))
    || ((since[b.email]?.at || 0) - (since[a.email]?.at || 0)));
}

function sinceWords(entry, now) {
  if (!entry) return 'Here now';
  if (entry.initial) return 'Here when you opened it';
  return `Arrived ${agoWords(entry.at, now)}`;
}

/** The eye: open with the count in the iris, or shut (a lid with lashes). */
export function EyeMark({ count = 0, closed = false, anim = null }) {
  const label = count > 9 ? '9+' : String(count);
  const showLid = !closed || anim === 'shut';
  return (
    <svg
      viewBox="0 0 48 32"
      width="48"
      height="32"
      aria-hidden="true"
      focusable="false"
      data-eye={closed ? 'closed' : 'open'}
      data-anim={anim || undefined}
      className={`shrink-0 overflow-visible ${anim ? `tp-eye-anim-${anim}` : ''}`}
    >
      {showLid && (
        <g className="tp-eye-lid">
          <path
            d="M2 16 C 10 1.5, 38 1.5, 46 16 C 38 30.5, 10 30.5, 2 16 Z"
            strokeWidth="2"
            strokeLinejoin="round"
            className="fill-violet-50 stroke-violet-500 dark:fill-violet-500/15 dark:stroke-violet-300"
          />
          <circle cx="24" cy="16" r="9.25" className="fill-violet-600 dark:fill-violet-400" />
          {!closed && (
            <g className="tp-eye-count">
              <text
                x="24"
                y="16.25"
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-white dark:fill-violet-950"
                style={{ fontSize: label.length > 1 ? 10.5 : 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
              >
                {label}
              </text>
            </g>
          )}
        </g>
      )}
      {closed && (
        <g className="tp-eye-closed" fill="none" strokeLinecap="round">
          <path d="M5 13 C 13 23, 35 23, 43 13" strokeWidth="2.25" className="stroke-violet-400 dark:stroke-violet-300" />
          <path d="M13.5 19.5 L11 24 M24 21.6 L24 26.6 M34.5 19.5 L37 24" strokeWidth="2" className="stroke-violet-400 dark:stroke-violet-300" />
        </g>
      )}
    </svg>
  );
}

/**
 * Pure view (the harness and tests render it directly).
 * - viewers: the other people, already ordered
 * - since: { [email]: { at, initial } }
 * - departed: people who just left (the "Sam left" state) or null
 * - change: { kind: 'arrive' | 'leave', reduced } while a change shows, else null
 */
export function TicketViewersView({
  viewers = [],
  since = {},
  departed = null,
  change = null,
  open = false,
  now = Date.now(),
  panelId,
  buttonRef,
  buttonProps = {},
  className = '',
  wrapperProps = {},
}) {
  const count = viewers.length;
  if (!count && !departed?.length) return null;

  const leaving = Boolean(departed?.length) && change?.kind !== 'arrive';
  const line = leaving ? leftLine(departed) : hereLine(viewers);
  const writers = viewers.filter(isWriting);
  const closed = count === 0;
  const anim = change && !change.reduced
    ? (change.kind === 'arrive' ? 'open' : (closed ? 'shut' : 'blink'))
    : null;
  const flash = Boolean(change?.reduced);
  const writerLine = writers.length === 1
    ? `${firstOf(writers[0])} is writing ${writers[0].composing === 'note' ? 'a note' : 'a reply'}`
    : writers.length > 1 ? `${writers.length} are writing` : '';

  const body = (
    <>
      <EyeMark count={count} closed={closed} anim={anim} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          data-testid="ticket-viewers-line"
          className={`tp-viewers-line max-w-[15rem] truncate px-0.5 text-sm font-semibold ${
            leaving ? 'text-muted-foreground' : 'text-violet-800 dark:text-violet-200'
          }`}
        >
          {line}
        </span>
        {writerLine && (
          <span className="mt-0.5 inline-flex items-center gap-1 px-0.5 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid="ticket-viewers-writing">
            <Pencil className="h-3 w-3 shrink-0" aria-hidden="true" />
            {writerLine}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div
      {...wrapperProps}
      className={`relative flex items-center ${flash ? 'tp-viewers-flash' : ''} ${className}`}
      data-testid="ticket-viewers"
      data-count={count}
      data-change={change?.kind || undefined}
      data-state={leaving ? 'left' : 'here'}
    >
      {count > 0 ? (
        <button
          type="button"
          ref={buttonRef}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`${line}${writerLine ? `. ${writerLine}` : ''}. Show who is on this ticket`}
          className="tp-focus-ring inline-flex items-center gap-2 rounded-lg py-0.5 pl-0.5 pr-1.5 text-left hover:bg-violet-50/70 dark:hover:bg-violet-500/10"
          data-testid="ticket-viewers-button"
          {...buttonProps}
        >
          {body}
        </button>
      ) : (
        <span className="inline-flex items-center gap-2 py-0.5 pl-0.5 pr-1.5">{body}</span>
      )}

      {open && count > 0 && (
        <div
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label="Who is on this ticket"
          className="tp-card absolute right-0 top-full z-30 mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2 shadow-soft animate-popIn"
          data-testid="ticket-viewers-list"
        >
          <p className="px-2 pb-1 pt-0.5 text-xs font-semibold text-muted-foreground">Here now</p>
          <ul className="flex flex-col">
            {viewers.map((v) => {
              const entry = since[v.email];
              return (
                <li key={v.email} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5" data-testid="ticket-viewer">
                  <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[11px] font-bold text-violet-700 dark:bg-violet-500/20 dark:text-violet-200">
                    {initialsOf(v)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{nameOf(v)}</span>
                    <span className="block text-xs text-muted-foreground" title={entry?.at ? formatPacificFull(entry.at) : undefined}>
                      {sinceWords(entry, now)}
                    </span>
                  </span>
                  {isWriting(v) && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid="ticket-viewer-writing">
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      {v.composing === 'note' ? 'Writing a note' : 'Writing a reply'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 border-t border-border/60 px-2 pt-1.5 text-[11px] text-muted-foreground">Live only. Nothing is recorded.</p>
        </div>
      )}
    </div>
  );
}

/** Stateful wrapper: diffs the viewer list into arrivals and departures. */
export default function TicketViewers({ viewers = [], className = '' }) {
  const mountedAt = useRef(Date.now());
  const prevRef = useRef(null); // Map(email -> viewer) as last seen
  const timers = useRef({});
  const hoverTimer = useRef(null);
  const pointerDown = useRef(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();

  const [since, setSince] = useState({});
  const [change, setChange] = useState(null);
  const [departed, setDeparted] = useState(null);
  const [announce, setAnnounce] = useState('');
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const signature = viewers.map((v) => v.email).sort().join('|');

  useEffect(() => {
    const firstRun = prevRef.current === null;
    const prev = prevRef.current || new Map();
    const cur = new Map(viewers.map((v) => [v.email, v]));
    prevRef.current = cur;
    const arrived = viewers.filter((v) => !prev.has(v.email));
    const left = [...prev.values()].filter((v) => !cur.has(v.email));
    if (!arrived.length && !left.length) return;

    const at = Date.now();
    const initial = firstRun || at - mountedAt.current < INITIAL_GRACE_MS;
    setSince((s) => {
      const next = { ...s };
      for (const v of arrived) next[v.email] = { at, initial };
      for (const v of left) delete next[v.email];
      return next;
    });

    clearTimeout(timers.current.change);
    setChange({ kind: arrived.length ? 'arrive' : 'leave', reduced: motionReduced() });
    timers.current.change = setTimeout(() => setChange(null), CHANGE_MS);

    clearTimeout(timers.current.left);
    if (arrived.length) {
      setDeparted(null);
    } else {
      setDeparted(left);
      timers.current.left = setTimeout(() => setDeparted(null), LEFT_MS);
    }

    const said = [];
    if (arrived.length) {
      const names = joinNames(arrived.map(nameOf));
      said.push(initial
        ? `${names} ${arrived.length === 1 ? 'is' : 'are'} also on this ticket.`
        : `${names} opened this ticket.`);
    }
    if (left.length) said.push(`${joinNames(left.map(nameOf))} left.`);
    setAnnounce(said.join(' '));
    // `viewers` is read through the signature on purpose: a heartbeat that
    // only refreshes the same people is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => () => {
    clearTimeout(timers.current.change);
    clearTimeout(timers.current.left);
    clearTimeout(hoverTimer.current);
  }, []);

  // Nobody left to list: fold the list away.
  useEffect(() => {
    if (!viewers.length) { setOpen(false); setPinned(false); }
  }, [viewers.length]);

  // While the list is open, keep "Arrived 5 min ago" current.
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  // A click outside closes a list opened by click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setPinned(false); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); setPinned(false); };

  const wrapperProps = {
    ref: wrapRef,
    onMouseEnter: () => {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => setOpen(true), 120);
    },
    onMouseLeave: () => {
      clearTimeout(hoverTimer.current);
      if (!pinned) hoverTimer.current = setTimeout(() => setOpen(false), 200);
    },
    onBlur: (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.relatedTarget)) close();
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        close();
        // Focus goes back to the button without re-opening the list.
        pointerDown.current = true;
        buttonRef.current?.focus();
        pointerDown.current = false;
      }
    },
  };

  const buttonProps = {
    onPointerDown: () => { pointerDown.current = true; },
    onFocus: () => {
      if (!pointerDown.current) setOpen(true);
      pointerDown.current = false;
    },
    onClick: () => {
      clearTimeout(hoverTimer.current);
      if (open && pinned) close();
      else { setOpen(true); setPinned(true); }
    },
  };

  return (
    <>
      <TicketViewersView
        viewers={orderViewers(viewers, since)}
        since={since}
        departed={departed}
        change={change}
        open={open}
        now={now}
        panelId={panelId}
        buttonRef={buttonRef}
        buttonProps={buttonProps}
        wrapperProps={wrapperProps}
        className={className}
      />
      <span className="sr-only" role="status" aria-live="polite" data-testid="ticket-viewers-live">{announce}</span>
    </>
  );
}
