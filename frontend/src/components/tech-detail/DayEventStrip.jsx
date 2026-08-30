import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ticketRefLabel } from '../tickets/ticketUi';

// ─────────────────────────────────────────────────────────────────────────────
// DayEventStrip — daily view only. A compact horizontal strip of EVENT MARKERS
// (dots positioned by hour), deliberately NOT duration bars: close timestamps
// are unreliable (agents batch-close late, low-volume workspaces have a
// handful of tickets a week), so implying elapsed time would lie.
//
// No-hidden-events invariant: every event is individually visible. Markers
// that collide in x stack vertically into up to MAX_LANES sub-rows; when a
// column is denser than that, the remainder collapses into an "×N" overflow
// chip. Batch clustering (≥5 same-type events within 15 min) still collapses
// a phishing sweep into one "×N" moment. Sum of visible dots + chip counts
// always equals the (filter-visible) event count.
//
// Hover/focus = tooltip (chips list their members); click = open the ticket
// (dots) or pin an interactive member popover (chips / hour bars).
// Views: Dots (beeswarm) | Hourly (per-hour stacked count histogram — counts,
// never durations). Legend doubles as per-type filter chips. Nothing persists.
// ─────────────────────────────────────────────────────────────────────────────

// Day boundaries elsewhere on this page are Pacific — position markers in the
// same timezone so the strip agrees with the date filter.
const APP_TZ = 'America/Los_Angeles';
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});
const PT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, hour: 'numeric', minute: '2-digit',
});

const AXIS_START = 8;   // 8 AM — default working window…
const AXIS_END = 18;    // 6 PM — …auto-extends so no event is ever clipped.
const CLUSTER_WINDOW_MS = 15 * 60 * 1000;
const CLUSTER_MIN = 5;
const MAX_LANES = 4;    // beeswarm sub-rows before overflowing into a chip
const COLLIDE_GAP_PCT = 1.8; // minimum collision gap (fraction of the axis)
const COLLIDE_GAP_PX = 26;   // ~one "×NN" chip — narrow strips merge columns sooner

const EVENT_STYLES = {
  self: { dot: 'bg-violet-500', bar: 'bg-violet-400', label: 'Self-picked' },
  assigned: { dot: 'bg-blue-500', bar: 'bg-blue-400', label: 'Assigned' },
  closed: { dot: 'bg-emerald-500', bar: 'bg-emerald-400', label: 'Closed' },
};
const TYPE_ORDER = ['self', 'assigned', 'closed'];

/** Fractional hour-of-day of a timestamp in the app (Pacific) timezone. */
export function hourOf(ts) {
  const parts = HOUR_FMT.format(new Date(ts)).split(':');
  return Number(parts[0]) + Number(parts[1]) / 60;
}

/** Axis hours: the 8a–6p window, stretched (never shrunk) to include every event. */
export function computeAxis(events) {
  let start = AXIS_START;
  let end = AXIS_END;
  for (const e of events) {
    const h = hourOf(e.ts);
    if (h < start) start = Math.floor(h);
    if (h > end) end = Math.min(Math.ceil(h), 24);
  }
  return { start, end };
}

function xPct(ts, axis) {
  const h = Math.min(Math.max(hourOf(ts), axis.start), axis.end);
  return ((h - axis.start) / (axis.end - axis.start)) * 100;
}

/**
 * Build the day's events from the period-scoped ticket lists.
 * Arrivals use firstAssignedAt||createdAt (the same convention as the counts);
 * closes only get a marker when a real close timestamp exists — we never
 * fabricate one.
 */
export function buildDayEvents({ ticketsOnDate = [], dayIso = null }) {
  const events = [];
  for (const t of ticketsOnDate) {
    const arrival = t.firstAssignedAt || t.createdAt;
    if (arrival) {
      events.push({
        id: `arrive-${t.id}`,
        type: t.isSelfPicked ? 'self' : 'assigned',
        ts: new Date(arrival).getTime(),
        ticket: t,
      });
    }
    const closedTs = t.closedAt || t.resolvedAt;
    if (closedTs && ['Resolved', 'Closed'].includes(t.status)) {
      const d = new Date(closedTs);
      // Only mark the close if it really happened on the viewed (PT) day —
      // we never fabricate a close time from other fields.
      if (!Number.isNaN(d.getTime()) && (dayIso == null || PT_DAY_FMT.format(d) === dayIso)) {
        events.push({ id: `close-${t.id}`, type: 'closed', ts: d.getTime(), ticket: t });
      }
    }
  }
  return events
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
}

/** ≥CLUSTER_MIN same-type events within CLUSTER_WINDOW_MS collapse into one marker. */
export function clusterEvents(events) {
  const out = [];
  let i = 0;
  while (i < events.length) {
    const run = [events[i]];
    let j = i + 1;
    while (
      j < events.length &&
      events[j].type === events[i].type &&
      events[j].ts - run[0].ts <= CLUSTER_WINDOW_MS
    ) {
      run.push(events[j]);
      j += 1;
    }
    if (run.length >= CLUSTER_MIN) {
      out.push({
        id: `cluster-${run[0].id}`,
        type: run[0].type,
        ts: run[0].ts,
        endTs: run[run.length - 1].ts,
        events: run,
        isCluster: true,
      });
      i = j;
    } else {
      out.push(events[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Beeswarm layout: group ts-sorted markers into x-collision columns, stack
 * each column into vertical lanes (center-out), and collapse anything past
 * MAX_LANES into a mixed "overflow" chip. Every input marker lands in exactly
 * one output unit, so Σ(unit.count) === Σ(events represented by markers).
 */
export function layoutMarkers(markers, axis, { gapPct = COLLIDE_GAP_PCT, maxLanes = MAX_LANES } = {}) {
  const cols = [];
  for (const m of markers) {
    const x = xPct(m.ts, axis);
    const last = cols[cols.length - 1];
    if (last && x - last.anchorX <= gapPct) last.items.push({ m, x });
    else cols.push({ anchorX: x, items: [{ m, x }] });
  }

  const placed = [];
  cols.forEach((col, colIdx) => {
    const chips = col.items.filter(({ m }) => m.isCluster);
    const singles = col.items.filter(({ m }) => !m.isCluster);
    const lanesForSingles = Math.max(maxLanes - chips.length, 1);
    let visible = singles;
    let overflow = [];
    if (singles.length > lanesForSingles) {
      // Reserve the last lane for the "×N" chip that absorbs the rest.
      const keep = Math.max(lanesForSingles - 1, 0);
      visible = singles.slice(0, keep);
      overflow = singles.slice(keep);
    }
    // All units in a column share the column's anchor x — this guarantees
    // neighbouring columns stay ≥gapPct apart so chips can't overlap in x.
    const units = [
      ...chips.map(({ m }) => ({ kind: 'batch', marker: m, x: col.anchorX, count: m.events.length, events: m.events })),
      ...visible.map(({ m }) => ({ kind: 'dot', marker: m, x: col.anchorX, count: 1, events: [m] })),
    ];
    if (overflow.length > 0) {
      units.push({
        kind: 'overflow',
        x: col.anchorX,
        count: overflow.length,
        events: overflow.map(({ m }) => m),
      });
    }
    // Alternate lane order per column so adjacent columns' wide "×N" chips
    // land in different lanes and never clip each other's digits.
    if (colIdx % 2 === 1) units.reverse();
    const n = units.length;
    const spread = Math.min(38, (n - 1) * 14); // % from the vertical center
    units.forEach((u, i) => {
      u.top = n === 1 ? 50 : 50 - spread + (2 * spread * i) / (n - 1);
      u.lanes = n;
      u.key = u.kind === 'overflow' ? `ovf-${u.events[0].id}` : u.marker.id;
      placed.push(u);
    });
  });
  return placed;
}

/** Per-hour stacked counts for the Hourly view (counts, never durations). */
export function bucketByHour(events, axis) {
  const buckets = Array.from({ length: axis.end - axis.start }, (_, i) => ({
    hour: axis.start + i,
    counts: { self: 0, assigned: 0, closed: 0 },
    total: 0,
    events: [],
  }));
  for (const e of events) {
    const idx = Math.min(
      Math.max(Math.floor(hourOf(e.ts)) - axis.start, 0),
      buckets.length - 1,
    );
    buckets[idx].counts[e.type] += 1;
    buckets[idx].total += 1;
    buckets[idx].events.push(e);
  }
  return buckets;
}

function hourLabel(h) {
  const hh = h % 24;
  if (hh === 0) return '12a';
  if (hh < 12) return `${hh}a`;
  if (hh === 12) return '12p';
  return `${hh - 12}p`;
}

function fmtTime(ts) {
  return TIME_LABEL_FMT.format(new Date(ts));
}

// ── Tooltip / popover content ────────────────────────────────────────────────

const MEMBER_LIST_MAX = 8;

function MemberRow({ event, interactive, onOpen }) {
  const style = EVENT_STYLES[event.type] || EVENT_STYLES.assigned;
  const body = (
    <>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
      <span className="flex-shrink-0 font-mono text-white/55">{ticketRefLabel(event.ticket)}</span>
      <span className="min-w-0 flex-1 truncate">{event.ticket?.subject || '(no subject)'}</span>
      <span className="flex-shrink-0 tabular-nums text-white/70">{fmtTime(event.ts)}</span>
    </>
  );
  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onOpen(event.ticket?.id)}
        className="tp-focus-ring flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/10"
      >
        {body}
      </button>
    );
  }
  return <div className="flex items-center gap-1.5 px-1 py-0.5">{body}</div>;
}

function UnitTipContent({ unit, interactive, onOpen }) {
  if (unit.kind === 'dot') {
    const e = unit.events[0];
    const style = EVENT_STYLES[e.type] || EVENT_STYLES.assigned;
    return (
      <>
        <div className="flex items-center gap-1.5 font-semibold">
          <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
          <span>{style.label}</span>
          <span className="font-normal tabular-nums text-white/70">· {fmtTime(e.ts)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-white/55">
          <span className="flex-shrink-0 font-mono">{ticketRefLabel(e.ticket)}</span>
          <span className="min-w-0 truncate">{e.ticket?.subject || '(no subject)'}</span>
        </div>
      </>
    );
  }
  const first = unit.events[0];
  const last = unit.events[unit.events.length - 1];
  const header = unit.kind === 'batch'
    ? `${(EVENT_STYLES[unit.marker.type] || EVENT_STYLES.assigned).label} ×${unit.count}`
    : unit.kind === 'hour'
      ? `${hourLabel(unit.hour)}–${hourLabel(unit.hour + 1)} · ${unit.count} event${unit.count === 1 ? '' : 's'}`
      : `×${unit.count} around ${fmtTime(first.ts)}`;
  const shown = unit.events.slice(0, MEMBER_LIST_MAX);
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 font-semibold">
        <span>{header}</span>
        {unit.kind !== 'hour' && (
          <span className="font-normal tabular-nums text-white/70">
            {fmtTime(first.ts)}{unit.count > 1 ? `–${fmtTime(last.ts)}` : ''}
          </span>
        )}
      </div>
      <div className={`mt-1 space-y-px ${interactive ? 'settings-scrollbar max-h-40 overflow-y-auto' : ''}`}>
        {(interactive ? unit.events : shown).map((e) => (
          <MemberRow key={e.id} event={e} interactive={interactive} onOpen={onOpen} />
        ))}
        {!interactive && unit.events.length > MEMBER_LIST_MAX && (
          <div className="px-1 pt-0.5 text-white/70">…and {unit.events.length - MEMBER_LIST_MAX} more — click to browse</div>
        )}
        {!interactive && unit.events.length > 1 && (
          <div className="px-1 pt-0.5 text-[9px] uppercase tracking-wide text-white/60">Click to browse tickets</div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DayEventStrip({ ticketsOnDate = [], dayLabel = '', dayIso = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  const [stripWidth, setStripWidth] = useState(0);

  // Track the strip's real width so the x-collision gap reflects pixels
  // (a "×NN" chip), not a fixed fraction — narrow strips cluster sooner.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setStripWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // View options — deliberately not persisted: defaults on every mount.
  const [view, setView] = useState('dots');       // 'dots' | 'hourly'
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set());
  const [hovered, setHovered] = useState(null);   // { unit }
  const [pinned, setPinned] = useState(null);     // { unit } — interactive popover

  // Return address so the ticket page's Back control comes back to this
  // agent page (same period), not the generic queue.
  const openTicket = (ticketId) => {
    if (!ticketId) return;
    navigate(`/tickets/${ticketId}`, { state: { from: `${location.pathname}${location.search}` } });
  };

  const allEvents = useMemo(
    () => buildDayEvents({ ticketsOnDate, dayIso }),
    [ticketsOnDate, dayIso],
  );
  const typeCounts = useMemo(() => {
    const c = { self: 0, assigned: 0, closed: 0 };
    for (const e of allEvents) c[e.type] += 1;
    return c;
  }, [allEvents]);
  const visibleEvents = useMemo(
    () => allEvents.filter((e) => !hiddenTypes.has(e.type)),
    [allEvents, hiddenTypes],
  );
  // Axis is computed from ALL events so toggling a type never reshapes time.
  const axis = useMemo(() => computeAxis(allEvents), [allEvents]);
  const gapPct = stripWidth > 0
    ? Math.max((COLLIDE_GAP_PX / stripWidth) * 100, COLLIDE_GAP_PCT)
    : COLLIDE_GAP_PCT;
  const placed = useMemo(
    () => layoutMarkers(clusterEvents(visibleEvents), axis, { gapPct }),
    [visibleEvents, axis, gapPct],
  );
  const buckets = useMemo(() => bucketByHour(visibleEvents, axis), [visibleEvents, axis]);

  // Day changed → drop any transient tooltip/popover state.
  useEffect(() => { setHovered(null); setPinned(null); }, [dayIso]);

  // Pinned popover: dismiss on Escape or click outside the strip.
  useEffect(() => {
    if (!pinned) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setPinned(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPinned(null); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  if (allEvents.length === 0) return null;

  const span = axis.end - axis.start;
  const hours = Array.from({ length: span + 1 }, (_, i) => axis.start + i);
  const labelStep = span <= 12 ? 1 : 2;
  const maxLanes = placed.reduce((m, u) => Math.max(m, u.lanes), 1);
  const stripH = view === 'hourly' ? 'h-24' : maxLanes >= 3 ? 'h-20' : maxLanes === 2 ? 'h-14' : 'h-12';
  const maxBucket = buckets.reduce((m, b) => Math.max(m, b.total), 0);
  const allHidden = visibleEvents.length === 0;

  const toggleType = (type) => {
    setPinned(null);
    setHovered(null);
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const pinUnit = (unit) => {
    setHovered(null);
    setPinned((prev) => (prev && prev.unit.key === unit.key ? null : { unit }));
  };

  // Clamp the floating tip so it never runs off the card edges.
  const tipTransform = (x) => (x < 14 ? 'translateX(0)' : x > 86 ? 'translateX(-100%)' : 'translateX(-50%)');
  const floating = pinned || hovered;

  return (
    <section ref={rootRef} className="tp-card rounded-xl p-3" aria-label={`Event strip for ${dayLabel}`}>
      {/* Header: title + options row (legend filter chips, view toggle) */}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/75">
          The day, hour by hour
          <span className="ml-1.5 font-medium normal-case tracking-normal text-muted-foreground/50">
            · {allEvents.length} event{allEvents.length === 1 ? '' : 's'}
          </span>
        </h3>
        <div className="flex items-center gap-2">
          {/* Legend = per-type filter chips */}
          <div className="flex items-center gap-1" role="group" aria-label="Filter event types">
            {TYPE_ORDER.map((key) => {
              const s = EVENT_STYLES[key];
              const off = hiddenTypes.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleType(key)}
                  aria-pressed={!off}
                  aria-label={`${s.label}: ${typeCounts[key]} event${typeCounts[key] === 1 ? '' : 's'}${off ? ' (hidden)' : ''}`}
                  className={`tp-focus-ring inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium transition-colors motion-reduce:transition-none ${
                    off
                      ? 'border-transparent bg-muted/50 text-muted-foreground/50'
                      : 'border-border bg-card text-muted-foreground hover:border-input'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${s.dot} ${off ? 'opacity-30' : ''}`} aria-hidden="true" />
                  <span className={off ? 'line-through' : ''}>{s.label}</span>
                  <span className="tabular-nums text-muted-foreground/75">{typeCounts[key]}</span>
                </button>
              );
            })}
          </div>
          {/* View toggle */}
          <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label="Strip view">
            {[['dots', 'Dots'], ['hourly', 'Hourly']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setView(key); setPinned(null); setHovered(null); }}
                aria-pressed={view === key}
                className={`tp-focus-ring rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide transition-colors motion-reduce:transition-none ${
                  view === key ? 'bg-card text-foreground/85 shadow-subtle' : 'text-muted-foreground/75 hover:text-muted-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Strip body */}
      <div ref={bodyRef} className={`relative ${stripH}`}>
        {/* Alternating hour banding (even hours) */}
        {hours.slice(0, -1).map((h) => (
          h % 2 === 0 ? (
            <div
              key={`band-${h}`}
              className="absolute inset-y-0 rounded-sm bg-muted/40"
              style={{ left: `${((h - axis.start) / span) * 100}%`, width: `${(1 / span) * 100}%` }}
              aria-hidden="true"
            />
          ) : null
        ))}
        {/* Hour hairline gridlines — noon slightly stronger */}
        {hours.map((h) => (
          <div
            key={`grid-${h}`}
            className={`absolute inset-y-0 w-px ${h === 12 ? 'bg-muted-foreground/40' : 'bg-secondary/80'}`}
            style={{ left: `${((h - axis.start) / span) * 100}%` }}
            aria-hidden="true"
          />
        ))}

        {allHidden ? (
          <p className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/75">
            All event types hidden — click a legend chip to bring them back.
          </p>
        ) : view === 'dots' ? (
          <>
            {/* Center guide line only when the swarm is a single lane */}
            {maxLanes === 1 && (
              <div className="absolute inset-x-0 top-1/2 h-px bg-secondary" aria-hidden="true" />
            )}
            {placed.map((u) => {
              const common = {
                onMouseEnter: () => setHovered({ unit: u }),
                onMouseLeave: () => setHovered(null),
                onFocus: () => setHovered({ unit: u }),
                onBlur: () => setHovered(null),
              };
              if (u.kind === 'dot') {
                const e = u.events[0];
                const style = EVENT_STYLES[e.type] || EVENT_STYLES.assigned;
                return (
                  <button
                    key={u.key}
                    type="button"
                    data-evcount={1}
                    onClick={() => openTicket(e.ticket?.id)}
                    aria-label={`${style.label} ${ticketRefLabel(e.ticket)} at ${fmtTime(e.ts)}`}
                    className={`tp-focus-ring absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm transition-transform hover:scale-150 motion-reduce:transition-none ${style.dot}`}
                    style={{ left: `${u.x}%`, top: `${u.top}%` }}
                    {...common}
                  />
                );
              }
              const isBatch = u.kind === 'batch';
              const chipStyle = isBatch
                ? (EVENT_STYLES[u.marker.type] || EVENT_STYLES.assigned).dot
                : 'bg-slate-500';
              const label = isBatch
                ? `${(EVENT_STYLES[u.marker.type] || EVENT_STYLES.assigned).label} batch of ${u.count} around ${fmtTime(u.events[0].ts)}`
                : `${u.count} overlapping events around ${fmtTime(u.events[0].ts)}`;
              return (
                <button
                  key={u.key}
                  type="button"
                  data-evcount={u.count}
                  onClick={() => pinUnit(u)}
                  aria-label={label}
                  aria-expanded={pinned?.unit.key === u.key}
                  className={`tp-focus-ring absolute z-10 flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow-sm transition-transform hover:scale-110 motion-reduce:transition-none ${chipStyle}`}
                  style={{ left: `${u.x}%`, top: `${u.top}%` }}
                  {...common}
                >
                  ×{u.count}
                </button>
              );
            })}
          </>
        ) : (
          /* Hourly histogram — stacked COUNTS per hour bucket (never durations) */
          <div className="absolute inset-0 flex items-end" role="group" aria-label="Hourly event histogram">
            {buckets.map((b) => {
              if (b.total === 0) {
                return <div key={`hb-${b.hour}`} className="h-full flex-1" aria-hidden="true" />;
              }
              const unit = {
                kind: 'hour', hour: b.hour, count: b.total, events: b.events,
                key: `hour-${b.hour}`, x: ((b.hour - axis.start + 0.5) / span) * 100,
              };
              const parts = TYPE_ORDER
                .filter((k) => b.counts[k] > 0)
                .map((k) => `${b.counts[k]} ${EVENT_STYLES[k].label.toLowerCase()}`)
                .join(', ');
              return (
                <button
                  key={`hb-${b.hour}`}
                  type="button"
                  data-evcount={b.total}
                  onClick={() => pinUnit(unit)}
                  onMouseEnter={() => setHovered({ unit })}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered({ unit })}
                  onBlur={() => setHovered(null)}
                  aria-label={`${hourLabel(b.hour)} to ${hourLabel(b.hour + 1)}: ${parts}`}
                  aria-expanded={pinned?.unit.key === unit.key}
                  className="tp-focus-ring group flex h-full flex-1 flex-col items-center justify-end rounded-sm pb-px hover:bg-muted/70"
                >
                  <span className="mb-0.5 text-[9px] font-semibold tabular-nums text-muted-foreground/75 group-hover:text-muted-foreground">
                    {b.total}
                  </span>
                  <span
                    className="flex w-3/5 max-w-6 flex-col-reverse overflow-hidden rounded-t-sm"
                    style={{ height: `${Math.max((b.total / maxBucket) * 72, 6)}%` }}
                    aria-hidden="true"
                  >
                    {TYPE_ORDER.map((k) => (
                      b.counts[k] > 0 ? (
                        <span
                          key={k}
                          className={`w-full ${EVENT_STYLES[k].bar}`}
                          style={{ flexGrow: b.counts[k], minHeight: 3 }}
                        />
                      ) : null
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Floating tooltip / pinned popover (shared anchor, clamped to edges) */}
        {floating && (
          <div
            role="tooltip"
            className={`absolute bottom-full z-20 mb-1.5 w-max max-w-[320px] rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-soft dark:bg-slate-700 dark:ring-1 dark:ring-white/10 ${
              pinned ? '' : 'pointer-events-none'
            }`}
            style={{ left: `${floating.unit.x}%`, transform: tipTransform(floating.unit.x) }}
          >
            <UnitTipContent
              unit={floating.unit}
              interactive={Boolean(pinned)}
              onOpen={openTicket}
            />
          </div>
        )}
      </div>

      {/* Hour tick labels */}
      <div className="relative mt-1 h-3 border-t border-border text-[9px] font-medium text-muted-foreground/75" aria-hidden="true">
        {hours.filter((h) => (h - axis.start) % labelStep === 0 || h === axis.end).map((h) => (
          <span
            key={h}
            className="absolute top-0.5 -translate-x-1/2 tabular-nums"
            style={{ left: `${((h - axis.start) / span) * 100}%` }}
          >
            {hourLabel(h)}
          </span>
        ))}
      </div>
    </section>
  );
}
