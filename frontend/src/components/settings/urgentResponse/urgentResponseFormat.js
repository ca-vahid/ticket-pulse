import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

// Urgent response: labels, validation and formatters shared by the tabs
// (plans/URGENT_RESPONSE_PLAN.md). Times are shown in the workspace time zone.

export const MODE_INFO = {
  off: { tone: 'grey', label: 'Off', hint: 'Nothing happens.' },
  // The stored value is 'observe'; the word people see is Shadow (2 Oct 2026).
  observe: { tone: 'amber', label: 'Shadow', hint: 'Every rule is worked out and recorded in the Log. No ticket moves and nobody is told.' },
  live: { tone: 'green', label: 'Live', hint: 'Tickets are redirected, moved and people are told.' },
};
export const MODES = ['off', 'observe', 'live'];

export const PRIORITY_LABEL = { 4: 'Urgent', 3: 'High' };

export const LAYER_LABEL = {
  assign: 'When assigning',
  raise: 'When it becomes urgent',
  clock: 'If nobody touches it',
  on_call: 'On-call',
  undo: 'Undo',
};

/** The 30-day counts under the step that made them, in the order a ticket meets them. */
export const STAT_GROUPS = [
  { layer: 'assign', label: LAYER_LABEL.assign, rows: [
    ['redirected', 'Given to someone at work instead'],
    ['held', 'Left because nobody was at work'],
  ] },
  { layer: 'raise', label: LAYER_LABEL.raise, rows: [
    ['raiseMoved', 'Moved to someone at work'],
    ['toldOwnerAway', 'Owner away, people told'],
  ] },
  { layer: 'clock', label: LAYER_LABEL.clock, rows: [
    ['teamTold', 'People told'],
    ['clockMoved', 'Moved to someone at work'],
    ['coordinator', 'Sent to the coordinator'],
  ] },
  { layer: 'other', label: 'Also', rows: [
    ['onCallAssigned', 'Given to the on-call person'],
    ['undone', 'Undone'],
  ] },
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** How the next owner is picked: fixed, shown read-only. */
export const PICK_STEPS = [
  'At work now and not on leave.',
  'Has the skill for the ticket’s category: the subcategory first, then the category.',
  'Has the fewest open tickets.',
  'Was given a ticket least recently.',
];

// ---------------------------------------------------------------- rules draft

export const RULE_KEYS = [
  'assignEnabled', 'assignPriorities', 'assignGraceMinutes',
  'raiseEnabled', 'raisePriorities', 'raiseManualAction',
  'clockEnabled', 'clockPriorities', 'clockNotifyMinutes', 'clockMoveMinutes',
  'notifyAudience', 'notifyTechnicianIds', 'notifyChannels',
  'nobodyMode', 'nobodyContactTechnicianId',
  'coordinatorTechnicianId', 'maxMoves',
];

const sortedPriorities = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter((p) => PRIORITY_LABEL[p]).sort((a, b) => b - a);

/** The part of the settings the Rules tab edits, in a stable shape so drafts compare cleanly. */
export function pickRules(s = {}) {
  return {
    assignEnabled: s.assignEnabled !== false,
    assignPriorities: sortedPriorities(s.assignPriorities ?? [4, 3]),
    assignGraceMinutes: s.assignGraceMinutes ?? 30,
    raiseEnabled: s.raiseEnabled !== false,
    raisePriorities: sortedPriorities(s.raisePriorities ?? [4]),
    raiseManualAction: s.raiseManualAction === 'move' ? 'move' : 'notify',
    clockEnabled: s.clockEnabled !== false,
    clockPriorities: sortedPriorities(s.clockPriorities ?? [4]),
    clockNotifyMinutes: s.clockNotifyMinutes ?? 15,
    clockMoveMinutes: s.clockMoveMinutes ?? 30,
    notifyAudience: ['on_shift', 'group', 'named'].includes(s.notifyAudience) ? s.notifyAudience : 'on_shift',
    notifyTechnicianIds: [...new Set((s.notifyTechnicianIds || []).map(Number))],
    notifyChannels: ['teams', 'email'].filter((c) => (s.notifyChannels ?? ['teams', 'email']).includes(c)),
    nobodyMode: s.nobodyMode === 'on_call' ? 'on_call' : 'hold',
    nobodyContactTechnicianId: s.nobodyContactTechnicianId ?? null,
    coordinatorTechnicianId: s.coordinatorTechnicianId ?? null,
    maxMoves: s.maxMoves ?? 2,
  };
}

export function togglePriority(list, priority, on) {
  return sortedPriorities(on ? [...list, priority] : list.filter((p) => p !== priority));
}

/** Only what changed: the PUT is partial and every field sent is a change row. */
export function diffPatch(draft, saved) {
  const patch = {};
  Object.keys(draft).forEach((key) => {
    if (JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) patch[key] = draft[key];
  });
  return patch;
}

const whole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Plain-word problems that block Save. Empty = good to save. */
export function validateRules(d) {
  const problems = [];
  if (!whole(d.assignGraceMinutes, 0, 480)) problems.push('“Starts within” needs a whole number of minutes from 0 to 480.');
  const notifyOk = whole(d.clockNotifyMinutes, 1, 480);
  const moveOk = whole(d.clockMoveMinutes, 1, 480);
  if (!notifyOk) problems.push('The minutes before people are told need a whole number from 1 to 480.');
  if (!moveOk) problems.push('The minutes before the ticket moves need a whole number from 1 to 480.');
  if (notifyOk && moveOk && d.clockMoveMinutes < d.clockNotifyMinutes) {
    problems.push('The ticket cannot move before people are told: make the move minutes the same as or more than the tell minutes.');
  }
  [['assign', 'When assigning'], ['raise', 'When it becomes urgent'], ['clock', 'If nobody touches it']].forEach(([key, label]) => {
    if (d[`${key}Enabled`] && !d[`${key}Priorities`].length) problems.push(`“${label}” is on but applies to nothing: tick Urgent or High, or switch it off.`);
  });
  if (d.notifyAudience === 'named' && !d.notifyTechnicianIds.length) problems.push('“Named people” needs at least one person.');
  if (!whole(d.maxMoves, 0, 10)) problems.push('The number of moves needs a whole number from 0 to 10.');
  return problems;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "With these settings, the last 30 days would have had 12 redirected, 3 moved … (estimate)." */
export function previewSentence(p) {
  if (!p) return '';
  const parts = [
    [p.assign?.redirected, (n) => `${n} redirected`],
    [p.assign?.held, (n) => `${n} left for review`],
    [p.raise?.moved, (n) => `${n} moved`],
    [p.raise?.told, (n) => count(n, 'owner-away notice', 'owner-away notices')],
    [p.clock?.teamTold, (n) => count(n, 'team notice', 'team notices')],
    [p.clock?.moved, (n) => count(n, 'clock move', 'clock moves')],
    [p.clock?.coordinator, (n) => `${n} sent to the coordinator`],
  ].filter(([n]) => Number(n) > 0).map(([n, say]) => say(Number(n)));
  const days = p.days || 30;
  if (!parts.length) return `With these settings, nothing would have happened in the last ${days} days (estimate).`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `With these settings, the last ${days} days would have had ${list} (estimate).`;
}

// ---------------------------------------------------------------- dates

const zoneOf = (tz) => tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const valid = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; };

/** "Oct 9, 5:00 PM" in the workspace time zone. */
export function fmtWhen(value, tz) {
  const d = value ? valid(value) : null;
  return d ? formatInTimeZone(d, zoneOf(tz), 'MMM d, h:mm a') : '—';
}

/** "Mon 19 Oct, 17:00" in the workspace time zone. */
export function fmtUntil(value, tz) {
  const d = value ? valid(value) : null;
  return d ? formatInTimeZone(d, zoneOf(tz), 'EEE d MMM, HH:mm') : '—';
}

/**
 * "Thu 15 – Mon 19 Oct" (or "Mon 26 Oct – Mon 2 Nov"). An end at midnight
 * belongs to the day before: a cover "to the end of Monday" reads Monday.
 */
export function fmtRange(startsAt, endsAt, tz) {
  const zone = zoneOf(tz);
  const start = valid(startsAt);
  let end = valid(endsAt);
  if (!start || !end) return '—';
  if (formatInTimeZone(end, zone, 'HH:mm') === '00:00' && end > start) end = new Date(end.getTime() - 1);
  const sameMonth = formatInTimeZone(start, zone, 'yyyy-MM') === formatInTimeZone(end, zone, 'yyyy-MM');
  return `${formatInTimeZone(start, zone, sameMonth ? 'EEE d' : 'EEE d MMM')} – ${formatInTimeZone(end, zone, 'EEE d MMM')}`;
}

/** Leave days ('yyyy-MM-dd') as "Thu 15 Oct, Fri 16 Oct" or "Thu 15 Oct – Wed 21 Oct (5 days)". */
export function fmtLeaveDays(days = []) {
  const say = (day) => formatInTimeZone(new Date(`${day}T12:00:00Z`), 'UTC', 'EEE d MMM');
  if (!days.length) return '';
  if (days.length <= 3) return days.map(say).join(', ');
  return `${say(days[0])} – ${say(days[days.length - 1])} (${days.length} days)`;
}

/** An instant as the value of a datetime-local input, in the workspace time zone. */
export function toZonedInput(value, tz) {
  const d = value ? valid(value) : null;
  return d ? formatInTimeZone(d, zoneOf(tz), "yyyy-MM-dd'T'HH:mm") : '';
}

/** A datetime-local value read as workspace time, back to an ISO instant ('' when unreadable). */
export function fromZonedInput(text, tz) {
  if (!text) return '';
  const d = fromZonedTime(text, zoneOf(tz));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * The window a cover (or a request for one) starts with: the leave days when
 * there are any, else the whole week; never before now for a week under way.
 */
export function defaultCoverWindow(week, tz, now = new Date()) {
  const zone = zoneOf(tz);
  let start = valid(week.startsAt);
  let end = valid(week.endsAt);
  const days = week.leaveDays || [];
  if (days.length) {
    const first = fromZonedTime(`${days[0]}T00:00`, zone);
    const lastDay = new Date(`${days[days.length - 1]}T12:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() + 1);
    const afterLast = fromZonedTime(`${lastDay.toISOString().slice(0, 10)}T00:00`, zone);
    if (first > start) start = first;
    if (afterLast < end) end = afterLast;
  }
  if (now > start && now < end) start = new Date(Math.floor(now.getTime() / 60000) * 60000);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

// ---------------------------------------------------------------- change history labels

const FIELD_LABEL = {
  mode: 'Mode',
  assignEnabled: 'When assigning',
  assignPriorities: 'When assigning: applies to',
  assignGraceMinutes: 'When assigning: starts within',
  raiseEnabled: 'When it becomes urgent',
  raisePriorities: 'When it becomes urgent: applies to',
  raiseManualAction: 'When it becomes urgent: assigned by hand',
  clockEnabled: 'If nobody touches it',
  clockPriorities: 'If nobody touches it: applies to',
  clockNotifyMinutes: 'If nobody touches it: tell people after',
  clockMoveMinutes: 'If nobody touches it: move after',
  notifyAudience: 'Who is told',
  notifyTechnicianIds: 'Who is told: named people',
  notifyChannels: 'Who is told: how',
  nobodyMode: 'Nobody at work',
  nobodyContactTechnicianId: 'Nobody at work: person told',
  coordinatorTechnicianId: 'Coordinator',
  maxMoves: 'Most moves',
  onCallOrder: 'On-call order',
  onCallHandoverDay: 'On-call handover day',
  onCallHandoverTime: 'On-call handover time',
  onCallAnchorDate: 'On-call start date',
};

const VALUE_LABEL = {
  raiseManualAction: { notify: 'tell people only', move: 'move it too' },
  notifyAudience: { on_shift: 'everyone at work', group: 'the ticket’s group', named: 'named people' },
  nobodyMode: { hold: 'leave it and tell a person', on_call: 'give it to the on-call person' },
};
const CHANNEL_LABEL = { teams: 'Teams', email: 'E-mail' };

export function changeFieldLabel(field) {
  return FIELD_LABEL[field] || field;
}

export function changeValueLabel(field, value, { techById = new Map() } = {}) {
  const person = (id) => techById.get(Number(id))?.name || `Person ${id}`;
  if (/TechnicianIds$|^onCallOrder$/.test(field)) {
    const ids = Array.isArray(value) ? value : [];
    return ids.length ? ids.map(person).join(', ') : 'nobody';
  }
  if (/TechnicianId$/.test(field)) return value === null || value === undefined ? 'nobody' : person(value);
  if (/Priorities$/.test(field)) return (Array.isArray(value) ? value : []).map((p) => PRIORITY_LABEL[p] || p).join(' and ') || 'nothing';
  if (field === 'notifyChannels') return (Array.isArray(value) ? value : []).map((c) => CHANNEL_LABEL[c] || c).join(' and ') || 'nothing';
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'mode') return MODE_INFO[value]?.label || String(value);
  if (/Enabled$/.test(field)) return value ? 'on' : 'off';
  if (/Minutes$/.test(field)) return `${value} min`;
  if (field === 'onCallHandoverDay') return WEEKDAYS[Number(value)] || String(value);
  if (VALUE_LABEL[field]) return VALUE_LABEL[field][value] || String(value);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The server's lists arrive bare or as { items }. */
export const listOf = (data) => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []);
