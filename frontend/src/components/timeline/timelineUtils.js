/**
 * Shared timeline utility functions.
 * Used by both MergedTimelineModal (single-tech) and TimelineExplorer (multi-tech).
 * All functions are pure JS — no React.
 *
 * techConfigs shape:
 *   [{ id, firstName, techStart, techEnd, techTz, tzCity }]
 */

import { getHolidayInfo } from '../../utils/holidays';

// ── Time helpers ──────────────────────────────────────────────────────────────

/** Convert a local time (HH:MM) in a given IANA timezone to a UTC Date for a specific date string */
export function localTimeToUTC(dateStr, timeStr, tz) {
  const [h, m] = timeStr.split(':');
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(probe);
  const tzNamePart = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  const match = tzNamePart.match(/GMT([+-]?\d+)?:?(\d+)?/);
  let offsetMinutes = 0;
  if (match) {
    const hrs = parseInt(match[1] || '0', 10);
    const mins = parseInt(match[2] || '0', 10);
    offsetMinutes = hrs * 60 + (hrs < 0 ? -mins : mins);
  }
  const localMs = new Date(`${dateStr}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`).getTime();
  return new Date(localMs - offsetMinutes * 60000);
}

/** Get PT time-of-day string (HH:MM:SS 24h) from a UTC date string/object */
export function getPTTimeOfDay(utcDateStr) {
  const d = new Date(utcDateStr);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Get PT calendar date string (YYYY-MM-DD) from a UTC date */
export function getPTDateStr(utcDate) {
  return new Date(utcDate).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Return true if the ticket was created before 10 AM UTC on its coverage day (i.e. overnight) */
export function isOvernight(ticket) {
  if (!ticket._day) return true;
  const cutoff = new Date(ticket._day + 'T10:00:00Z');
  return new Date(ticket.createdAt) < cutoff;
}

// ── Marker helpers ────────────────────────────────────────────────────────────

/** Collapse consecutive _marker items into a single _mergedMarkers item to reduce visual clutter */
export function collapseMarkers(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    if (items[i]._marker) {
      const group = [];
      while (i < items.length && items[i]._marker) {
        group.push(items[i]);
        i++;
      }
      if (group.length === 1) {
        result.push(group[0]);
      } else {
        result.push({
          _mergedMarkers: true,
          key: group.map((m) => m.key).join('|'),
          markers: group.map((m) => ({ label: m.label, color: m.color })),
        });
      }
    } else {
      result.push(items[i]);
      i++;
    }
  }
  return result;
}

// ── Data preparation ──────────────────────────────────────────────────────────

/**
 * Merge coverage + extended tickets into a single chronological array.
 * allPicked / allNotPicked already carry _day metadata from CoverageTab.
 */
export function mergeTicketsForTimeline(days, allPicked, allNotPicked) {
  const extendedAll = days.flatMap((d) =>
    (d.extendedTickets || []).map((t) => ({
      ...t, _day: d.date, _picked: t.pickedByTech, _section: 'after9am',
    })),
  );
  const coverageAll = [
    ...allPicked.map((t) => ({ ...t, _picked: true, _section: 'coverage' })),
    ...allNotPicked.map((t) => ({ ...t, _picked: false, _section: 'coverage' })),
  ];
  return [...coverageAll, ...extendedAll].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );
}

// ── Timeline building ─────────────────────────────────────────────────────────

/**
 * Insert timeline markers (agent online/offline, HQ online, date-change lines)
 * for a single coverage day. Supports multiple agents.
 *
 * techConfigs: [{ id, firstName, techStart, techEnd, techTz, tzCity }]
 * days: full days array (used for windowEnd lookup)
 */
/** Shorten a city name for compact display (e.g. "Los Angeles" -> "LA", "Vancouver" -> "Van") */
function shortCity(city) {
  const map = {
    'Los Angeles': 'LA', 'New York': 'NY', 'Vancouver': 'Van',
    'Toronto': 'Tor', 'Edmonton': 'Edm', 'Halifax': 'Hal', 'Montreal': 'Mtl',
    'Chicago': 'Chi', 'Denver': 'Den',
  };
  return map[city] || (city.length > 5 ? city.slice(0, 3) : city);
}

/** Format 24h time compactly: "08:00" -> "8am", "16:00" -> "4pm", "09:30" -> "9:30am" */
function shortTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function insertMarkersForDay(tickets, dateStr, techConfigs, days) {
  const hqOnlineTime = new Date(
    days.find((d) => d.date === dateStr)?.windowEnd || `${dateStr}T17:00:00Z`,
  );

  const agents = techConfigs.map((tc) => ({
    ...tc,
    agentStart: localTimeToUTC(dateStr, tc.techStart, tc.techTz),
    agentEnd: localTimeToUTC(dateStr, tc.techEnd, tc.techTz),
    sI: false,
    eI: false,
    shortLabel: shortCity(tc.tzCity),
  }));

  const items = [];
  let hI = false;
  let lastPTDate = null;

  for (const ticket of tickets) {
    const created = new Date(ticket.createdAt);
    const ptDate = getPTDateStr(created);

    if (lastPTDate && ptDate !== lastPTDate) {
      const d2 = new Date(created);
      const isWkend = d2.getDay() === 0 || d2.getDay() === 6;
      const label = d2.toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
      });
      const hInfo = getHolidayInfo(ptDate);
      const holidayLabel = hInfo.isCanadian
        ? ` — 🍁 ${hInfo.canadianName}`
        : hInfo.isUS ? ` — 🇺🇸 ${hInfo.usName}` : '';
      items.push({
        _marker: true, key: `daychange-${ptDate}`,
        label: `${label}${isWkend ? ' (Weekend)' : ''}${holidayLabel}`,
        color: isWkend
          ? 'bg-slate-400'
          : hInfo.isCanadian ? 'bg-rose-400' : hInfo.isUS ? 'bg-indigo-400' : 'bg-indigo-300',
      });
    }
    lastPTDate = ptDate;

    for (const agent of agents) {
      if (!agent.sI && created >= agent.agentStart) {
        items.push({ _marker: true, key: `start-${dateStr}-${agent.id}`, label: `${agent.firstName} on · ${shortTime(agent.techStart)} ${agent.shortLabel}`, color: 'bg-emerald-400' });
        agent.sI = true;
      }
    }
    if (!hI && created >= hqOnlineTime) {
      items.push({ _marker: true, key: `hq-${dateStr}`, label: 'HQ on · 9am PT', color: 'bg-blue-400' });
      hI = true;
    }
    for (const agent of agents) {
      if (!agent.eI && created >= agent.agentEnd) {
        items.push({ _marker: true, key: `end-${dateStr}-${agent.id}`, label: `${agent.firstName} off · ${shortTime(agent.techEnd)} ${agent.shortLabel}`, color: 'bg-red-400' });
        agent.eI = true;
      }
    }

    items.push(ticket);
  }

  // Collect remaining markers, sort by UTC time, then append
  const remaining = [];
  for (const agent of agents) {
    if (!agent.sI) remaining.push({ _marker: true, key: `start-${dateStr}-${agent.id}`, label: `${agent.firstName} on · ${shortTime(agent.techStart)} ${agent.shortLabel}`, color: 'bg-emerald-400', _time: agent.agentStart });
    if (!agent.eI) remaining.push({ _marker: true, key: `end-${dateStr}-${agent.id}`, label: `${agent.firstName} off · ${shortTime(agent.techEnd)} ${agent.shortLabel}`, color: 'bg-red-400', _time: agent.agentEnd });
  }
  if (!hI) remaining.push({ _marker: true, key: `hq-${dateStr}`, label: 'HQ on · 9am PT', color: 'bg-blue-400', _time: hqOnlineTime });

  remaining.sort((a, b) => a._time - b._time);
  for (const m of remaining) {
    delete m._time;
    items.push(m);
  }

  return items;
}

/**
 * Build a "combined" (all days collapsed to time-of-day) timeline.
 * Useful for weekly/monthly views to see patterns across multiple days.
 */
export function buildCombinedTimeline(tickets, techConfigs, days) {
  const refDate = days[0]?.date || '2026-01-05';
  const items = [];

  const agentMarkers = techConfigs.map((tc) => {
    const startUTC = localTimeToUTC(refDate, tc.techStart, tc.techTz);
    const endUTC = localTimeToUTC(refDate, tc.techEnd, tc.techTz);
    const sLabel = shortCity(tc.tzCity);
    return {
      ...tc,
      startUTC,
      endUTC,
      agentStartPT: getPTTimeOfDay(startUTC.toISOString()),
      agentEndPT: getPTTimeOfDay(endUTC.toISOString()),
      startInserted: false,
      endInserted: false,
      shortLabel: sLabel,
    };
  });

  const hqOnlinePT = '09:00:00';
  const sorted = [...tickets].sort((a, b) =>
    getPTTimeOfDay(a.createdAt).localeCompare(getPTTimeOfDay(b.createdAt)),
  );
  let lastHour = null;
  let hqInserted = false;

  for (const ticket of sorted) {
    const ptTime = getPTTimeOfDay(ticket.createdAt);
    const hour = parseInt(ptTime.split(':')[0], 10);

    if (hour !== lastHour) {
      const h12 = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`;
      items.push({
        _marker: true, key: `hour-${hour}`, label: h12,
        color: hour < 9 ? 'bg-slate-300' : hour < 17 ? 'bg-indigo-300' : 'bg-slate-300',
      });
      lastHour = hour;
    }

    for (const am of agentMarkers) {
      if (!am.startInserted && ptTime >= am.agentStartPT) {
        items.push({ _marker: true, key: `combined-start-${am.id}`, label: `${am.firstName} on · ${shortTime(am.techStart)} ${am.shortLabel}`, color: 'bg-emerald-400' });
        am.startInserted = true;
      }
    }

    if (!hqInserted && ptTime >= hqOnlinePT) {
      items.push({ _marker: true, key: 'combined-hq-online', label: 'HQ on · 9am PT', color: 'bg-blue-400' });
      hqInserted = true;
    }

    for (const am of agentMarkers) {
      if (!am.endInserted && ptTime >= am.agentEndPT) {
        items.push({ _marker: true, key: `combined-end-${am.id}`, label: `${am.firstName} off · ${shortTime(am.techEnd)} ${am.shortLabel}`, color: 'bg-red-400' });
        am.endInserted = true;
      }
    }

    items.push(ticket);
  }

  // Sort remaining markers by their UTC time
  const remaining = [];
  for (const am of agentMarkers) {
    if (!am.startInserted) remaining.push({ _marker: true, key: `combined-start-${am.id}`, label: `${am.firstName} on · ${shortTime(am.techStart)} ${am.shortLabel}`, color: 'bg-emerald-400', _time: am.startUTC });
    if (!am.endInserted) remaining.push({ _marker: true, key: `combined-end-${am.id}`, label: `${am.firstName} off · ${shortTime(am.techEnd)} ${am.shortLabel}`, color: 'bg-red-400', _time: am.endUTC });
  }
  if (!hqInserted) remaining.push({ _marker: true, key: 'combined-hq-online', label: 'HQ on · 9am PT', color: 'bg-blue-400', _time: new Date(`${refDate}T17:00:00Z`) });
  remaining.sort((a, b) => a._time - b._time);
  for (const m of remaining) { delete m._time; items.push(m); }

  return items;
}

/**
 * Orchestrate the full timeline build.
 * @param {Array} days  - avoidance days array (with date, windowEnd)
 * @param {Array} mergedFiltered - filtered tickets with _day, _picked, _section metadata
 * @param {string} mergedViewMode - 'rolling' | 'combined'
 * @param {Array} techConfigs - [{ id, firstName, techStart, techEnd, techTz, tzCity }]
 */
export function buildTimeline(days, mergedFiltered, mergedViewMode, techConfigs) {
  const isMultiDay = days.length > 1;
  if (!isMultiDay) {
    return insertMarkersForDay(mergedFiltered, days[0]?.date || '', techConfigs, days);
  }
  if (mergedViewMode === 'combined') {
    return buildCombinedTimeline(mergedFiltered, techConfigs, days);
  }

  // Rolling (day-by-day) mode — collapse consecutive empty days into _emptyDayGap
  const result = [];
  const emptyBuffer = []; // dates of consecutive empty days

  const flushEmpty = () => {
    if (emptyBuffer.length === 0) return;
    result.push({
      _emptyDayGap: true,
      key: `gap-${emptyBuffer[0]}-${emptyBuffer[emptyBuffer.length - 1]}`,
      startDate: emptyBuffer[0],
      endDate: emptyBuffer[emptyBuffer.length - 1],
      count: emptyBuffer.length,
    });
    emptyBuffer.length = 0;
  };

  for (const day of days) {
    const dayTickets = mergedFiltered.filter((t) => t._day === day.date);
    if (dayTickets.length === 0) {
      emptyBuffer.push(day.date);
      continue;
    }
    flushEmpty();
    const dayPicked = dayTickets.filter((t) => t._picked).length;
    const dayTotal = dayTickets.length;
    result.push({
      _dayHeader: true,
      key: `dh-${day.date}`,
      dateStr: day.date,
      dayPicked,
      dayNotPicked: dayTotal - dayPicked,
      dayTotal,
    });
    result.push(...insertMarkersForDay(dayTickets, day.date, techConfigs, days));
  }
  flushEmpty();
  return result;
}

/**
 * Build a techConfigs array from a single technician object (for modal usage).
 */
export function techConfigsFromTechnician(technician) {
  const techTz = technician.timezone || 'America/Los_Angeles';
  return [{
    id: technician.id,
    firstName: technician.name?.split(' ')[0] || 'Agent',
    techStart: technician.workStartTime || '09:00',
    techEnd: technician.workEndTime || '17:00',
    techTz,
    tzCity: techTz.split('/').pop().replace(/_/g, ' '),
  }];
}
