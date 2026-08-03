import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ticketRefLabel } from '../tickets/ticketUi';

// ─────────────────────────────────────────────────────────────────────────────
// DayEventStrip — daily view only. A compact horizontal strip of EVENT MARKERS
// (dots positioned by hour on an 8am–6pm axis), deliberately NOT duration bars:
// close timestamps are unreliable (agents batch-close late, low-volume
// workspaces have a handful of tickets a week), so implying elapsed time would
// lie. Hover = ticket + event; click = open the ticket.
//
// Batch clustering: ≥5 same-type events within 15 minutes collapse into one
// bigger "×N" marker so a phishing sweep reads as one moment, not 30 dots.
// ─────────────────────────────────────────────────────────────────────────────

// Day boundaries elsewhere on this page are Pacific — position markers in the
// same timezone so the strip agrees with the date filter.
const APP_TZ = 'America/Los_Angeles';
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, hour: 'numeric', minute: '2-digit', hour12: false,
});
const PT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, hour: 'numeric', minute: '2-digit',
});

const AXIS_START = 8;   // 8 AM
const AXIS_END = 18;    // 6 PM
const CLUSTER_WINDOW_MS = 15 * 60 * 1000;
const CLUSTER_MIN = 5;

const EVENT_STYLES = {
  self: { dot: 'bg-violet-500', label: 'Self-picked' },
  assigned: { dot: 'bg-blue-500', label: 'Assigned' },
  closed: { dot: 'bg-emerald-500', label: 'Closed' },
};

function fractionOfAxis(ts) {
  const parts = HOUR_FMT.format(new Date(ts)).split(':');
  const hour = Number(parts[0]) + Number(parts[1]) / 60;
  const clamped = Math.min(Math.max(hour, AXIS_START), AXIS_END);
  return (clamped - AXIS_START) / (AXIS_END - AXIS_START);
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

export default function DayEventStrip({ ticketsOnDate = [], dayLabel = '', dayIso = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Return address so the ticket page's Back control comes back to this
  // agent page (same period), not the generic queue.
  const openTicket = (ticketId) => {
    if (!ticketId) return;
    navigate(`/tickets/${ticketId}`, { state: { from: `${location.pathname}${location.search}` } });
  };

  const markers = useMemo(
    () => clusterEvents(buildDayEvents({ ticketsOnDate, dayIso })),
    [ticketsOnDate, dayIso],
  );

  if (markers.length === 0) return null;

  const hours = Array.from({ length: AXIS_END - AXIS_START + 1 }, (_, i) => AXIS_START + i);

  return (
    <section className="tp-card rounded-xl p-3" aria-label={`Event strip for ${dayLabel}`}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          The day, hour by hour
        </h3>
        <div className="flex items-center gap-3 text-[9px] text-slate-400">
          {Object.entries(EVENT_STYLES).map(([key, s]) => (
            <span key={key} className="inline-flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div className="relative h-10">
        {/* Axis line */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200" aria-hidden="true" />
        {/* Markers */}
        {markers.map((m) => {
          const left = fractionOfAxis(m.ts) * 100;
          const style = EVENT_STYLES[m.type] || EVENT_STYLES.assigned;
          const time = TIME_LABEL_FMT.format(new Date(m.ts));
          if (m.isCluster) {
            const title = `${style.label} ×${m.events.length} · ${time}–${TIME_LABEL_FMT.format(new Date(m.endTs))}\n${
              m.events.slice(0, 6).map((e) => `${ticketRefLabel(e.ticket)} ${e.ticket.subject || ''}`.trim()).join('\n')
            }${m.events.length > 6 ? `\n…and ${m.events.length - 6} more` : ''}`;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => openTicket(m.events[0].ticket?.id)}
                title={title}
                aria-label={`${style.label} batch of ${m.events.length} around ${time}`}
                className={`tp-focus-ring absolute top-1/2 flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow-sm transition-transform hover:scale-110 motion-reduce:transition-none ${style.dot}`}
                style={{ left: `${left}%` }}
              >
                ×{m.events.length}
              </button>
            );
          }
          const t = m.ticket;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => openTicket(t?.id)}
              title={`${style.label} · ${time}\n${ticketRefLabel(t)} ${t.subject || ''}`}
              aria-label={`${style.label} ${ticketRefLabel(t)} at ${time}`}
              className={`tp-focus-ring absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm transition-transform hover:scale-150 motion-reduce:transition-none ${style.dot}`}
              style={{ left: `${left}%` }}
            />
          );
        })}
      </div>

      {/* Hour labels */}
      <div className="relative mt-0.5 h-3 text-[8px] text-slate-300" aria-hidden="true">
        {hours.filter((h) => h % 2 === 0).map((h) => (
          <span
            key={h}
            className="absolute -translate-x-1/2 tabular-nums"
            style={{ left: `${((h - AXIS_START) / (AXIS_END - AXIS_START)) * 100}%` }}
          >
            {h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
          </span>
        ))}
      </div>
    </section>
  );
}
