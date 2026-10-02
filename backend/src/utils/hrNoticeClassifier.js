// HR lifecycle notice classifier (Onboarding / Offboarding, plans/HR_LIFECYCLE_PLAN.md).
//
// Strict and deterministic — no LLM, no guessing. Subject patterns and body
// formats come from the production research (plans/HR_LIFECYCLE_RESEARCH.md
// §1–2, IT workspace, 1 Oct 2026). Pure module: no imports beyond the HR date
// reader, so the service, the routes (read-only rules table) and the tests
// share one source of truth.
//
// classifyHrNotice() returns null for anything that is not an HR lifecycle
// ticket (most tickets) and for our own child tickets; otherwise
//   { type, person, employeeId, office, date, ..., effectiveImmediately }
// where `type` is one of NOTICE_TYPES.

import { fromIso, fromWeekdayMonthDay } from './hrNoticeDates.js';

/** Senders whose notices may start or change a family (research §0.1). */
export const HR_SENDERS = Object.freeze([
  'humanresources@bgcengineering.ca',
  'notifications@app.bamboohr.com',
]);

export const NOTICE_TYPES = Object.freeze([
  'departure', 'departure_date_change', 'contract_end_change', 'departure_cancelled',
  'new_hire', 'start_date_change', 'new_hire_office_change', 'new_hire_cancelled',
  'transfer', 'leave', 'leave_change', 'nh_automation',
]);

const ISO = '(20\\d{2}-\\d{2}-\\d{2})';
// "Departure Notification:" with HR's occasional "Copy of " re-send prefix.
const DEP = '^(?:copy of\\s+)?departure notification:\\s*';
const NHN = '^(?:copy of\\s+)?new hire notification:\\s*';

/**
 * The detection rules, in evaluation order. `subject` is the regex source the
 * classifier runs (case-insensitive); `label`/`example`/`action` are what the
 * Settings tab shows read-only ("full transparency").
 */
export const DETECTION_RULES = Object.freeze([
  { type: 'departure_cancelled', label: 'Departure cancelled', sender: 'humanresources@', subject: `${DEP}(.+?)\\s+will no longer be departing`, example: 'Departure Notification: <Name> will no longer be departing', action: 'Close the parent and every open child with a note; the family is cancelled' },
  { type: 'departure_date_change', label: 'Departure date changed', sender: 'humanresources@', subject: `${DEP}(.+?)\\s+departure date has changed`, example: 'Departure Notification: <Name> departure date has changed', action: 'Move the due date of the parent and every open child; note on each' },
  { type: 'contract_end_change', label: 'Contract end date changed', sender: 'humanresources@', subject: `${DEP}(.+?)\\s+contract end date has changed`, example: 'Departure Notification: <Name> Contract End Date has changed to <date>', action: 'Move the due date of the parent and every open child; note on each' },
  { type: 'departure', label: 'Departure', sender: 'humanresources@', subject: `${DEP}(.+?)\\s+from the\\s+(.+?)\\s+office will be departing`, example: 'Departure Notification: <Name> from the <Office> office will be departing', action: 'Offboarding family: parent + children (after-the-fact set when the notice arrives on/after the last day or says "effective immediately")' },
  { type: 'new_hire_cancelled', label: 'New hire cancelled', sender: 'humanresources@', subject: `${NHN}(.+?)\\s+will no longer be starting`, example: 'New Hire Notification: <Name> will no longer be starting', action: 'Close the parent and every open child with a note; the family is cancelled' },
  { type: 'start_date_change', label: 'Start date changed', sender: 'humanresources@', subject: `${NHN}(.+?)\\s+start date has changed`, example: 'New Hire Notification: <Name> start date has changed', action: 'Move the due date of the parent and every open child; note on each' },
  { type: 'new_hire_office_change', label: 'New-hire office changed', sender: 'humanresources@', subject: `${NHN}(.+?)\\s+office location has changed`, example: 'New Hire Notification: <Name> office location has changed', action: 'Note on every open ticket in the family (and move dates when the start date moved)' },
  { type: 'new_hire', label: 'New hire (BambooHR)', sender: 'notifications@app.bamboohr.com', subject: '^new hire(?:\\s+[a-z]+\\.?\\s+\\d{1,2})?:\\s*(.+)$', example: 'New Hire: <Name>', action: 'Onboarding family: the notice is the parent + the onboarding children' },
  { type: 'nh_automation', label: 'NH Laptop / NH Workstation (automation)', sender: 'any', subject: '^NH\\s+(laptop|workstation)\\s*-\\s*(.+?)\\s*-\\s*([a-z]{2})\\s*-\\s*(\\S+)\\s*-\\s*(20\\d{2}-\\d{2}-\\d{2})', example: 'NH Laptop - <Office> - <CC> - <username> - <start>', action: 'Linked to the open onboarding family as related + a note (never a new child)' },
  { type: 'transfer', label: 'Transfer', sender: 'humanresources@', subject: '^transfer notification:\\s*(.+?)(?:\\s+will be transferring from\\s+(.+?)\\s+office to\\s+(.+?)\\s+office|\\s+transfer date has changed.*)?$', example: 'Transfer Notification: <Name>', action: 'The notice is the ticket: assign per settings, due + park on the move date' },
  { type: 'leave_change', label: 'Leave dates changed', sender: 'humanresources@', subject: '^on leave notification:\\s*(.+?)\\s+expected (return|leave) date has changed to\\s+(20\\d{2}-\\d{2}-\\d{2})(?:\\s+in\\s+(.+))?$', example: 'On Leave Notification: <Name> expected return date has changed to <date> in <Office>', action: 'The notice is the ticket: assign per settings, due + park on the new date' },
  { type: 'leave', label: 'On leave', sender: 'humanresources@', subject: '^on leave notification:\\s*(.+?)(?:\\s+will be going on leave)?$', example: 'On Leave Notification: <Name>', action: 'The notice is the ticket: assign per settings, due + park on the leave start' },
]);

const COMPILED = DETECTION_RULES.map((r) => ({ ...r, re: new RegExp(r.subject, 'i') }));

/** "Ticket Pulse made it": our own children (and FS's) never start anything. */
const OWN_CHILD = /^child ticket\b/i;

const clean = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};

/** Lower-case, accents off, single spaces — the name half of the person key. */
export function normalizePersonName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- secrets

const SECRET_WORD = '(?:(?:initial|temporary|temp|default|one[- ]time)\\s+)?(?:password|passcode|passwd|pwd)';
const SECRET_LINE = new RegExp(`\\b${SECRET_WORD}\\b`, 'i');
// The label and its value, up to the next "Label:" (flattened bodies) or the end.
const SECRET_PAIR = new RegExp(`\\b${SECRET_WORD}\\b\\s*[:=-]?\\s*.*?(?=\\s+[A-Z][A-Za-z]+(?:\\s[A-Za-z]+)?\\s?:\\s|$)`, 'gi');

/**
 * Remove every password-labelled line / field (research §0.6 security flag:
 * NH Laptop bodies carry the new user's initial password in plain text).
 * Anything Ticket Pulse writes from a notice — child descriptions, notes,
 * event summaries — goes through here first.
 */
export function stripSecrets(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let dropNext = false;
  for (const line of lines) {
    if (dropNext) { dropNext = false; if (line.trim()) continue; }
    if (!SECRET_LINE.test(line)) { out.push(line); continue; }
    // A label alone on its line ("Password:") — the value is on the next line.
    if (new RegExp(`^\\s*${SECRET_WORD}\\s*[:=-]?\\s*$`, 'i').test(line)) { dropNext = true; continue; }
    const cleaned = line.replace(SECRET_PAIR, '').replace(/\s{2,}/g, ' ').trim();
    if (cleaned && !SECRET_LINE.test(cleaned)) out.push(cleaned);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- body fields

const after = (body, re) => {
  const m = body.match(re);
  return m ? clean(m[1]) : null;
};

function departureBody(body) {
  return {
    person: after(body, /\bName:\s*(.+?)\s+Office:/i),
    office: after(body, /\bOffice:\s*(.+?)\s+Departure Date:/i),
    date: fromIso(after(body, /Departure Date:\s*(20\d{2}-\d{2}-\d{2})/i)),
    employeeId: after(body, /employee\.php\?id=(\d+)/i),
  };
}

/** "(from X) to Y" in the new order, "to Y from X" in the old: { from, to }. */
function changedDates(body, what) {
  const re1 = new RegExp(`${what} has changed from\\s+${ISO}\\s+to\\s+${ISO}`, 'i');
  const re2 = new RegExp(`${what} has changed to\\s+${ISO}(?:\\s+from\\s+${ISO})?`, 'i');
  let m = body.match(re1);
  if (m) return { from: fromIso(m[1]), to: fromIso(m[2]) };
  m = body.match(re2);
  if (m) return { from: m[2] ? fromIso(m[2]) : null, to: fromIso(m[1]) };
  return { from: null, to: null };
}

function newHireStart(body, createdAt) {
  const iso = body.match(/start date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
  if (iso) return fromIso(iso[1]);
  // Current BambooHR format has no year ("Mon November 02"); the old one does.
  const withYear = body.match(/start date\s*:\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+([a-z]+)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (withYear) {
    const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(withYear[1].toLowerCase()) + 1;
    if (month > 0) return fromIso(`${withYear[3]}-${String(month).padStart(2, '0')}-${String(withYear[2]).padStart(2, '0')}`);
  }
  const wm = body.match(/start date\s*:\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+([a-z]+)\s+(\d{1,2})\b/i);
  return wm ? fromWeekdayMonthDay(wm[1], wm[2], wm[3], createdAt) : null;
}

function firstIsoIn(section) {
  const m = String(section || '').match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? fromIso(m[1]) : null;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at, timeZone = 'America/Los_Angeles') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * @param {{ subject?: string, text?: string, requesterEmail?: string|null, createdAt?: Date|string, timeZone?: string }} notice
 * @returns {null | object}
 */
export function classifyHrNotice({ subject = '', text = '', requesterEmail = null, createdAt = new Date(), timeZone = 'America/Los_Angeles' } = {}) {
  const subj = clean(subject) || '';
  if (!subj || OWN_CHILD.test(subj)) return null;
  const body = String(text || '').replace(/\s+/g, ' ');
  const sender = String(requesterEmail || '').trim().toLowerCase();
  const fromHr = HR_SENDERS.includes(sender);

  const rule = COMPILED.find((r) => r.re.test(subj));
  if (!rule) return null;
  // Only HR's own senders start or change a family; the NH automation files
  // its tickets under the new hire (or the Ticket Pulse FS agent).
  if (rule.type !== 'nh_automation' && !fromHr) return null;
  const m = subj.match(rule.re);
  const effectiveImmediately = /effective immediately/i.test(`${subj} ${body}`);
  const base = { type: rule.type, label: rule.label, rule: rule.type, subject: subj, effectiveImmediately, noticeDate: localDate(createdAt, timeZone) };

  switch (rule.type) {
  case 'departure': {
    const b = departureBody(body);
    return { ...base, person: b.person || clean(m[1]), office: b.office || clean(m[2]), date: b.date, employeeId: b.employeeId };
  }
  case 'departure_date_change': {
    const d = changedDates(body, 'departure date');
    return { ...base, person: clean(m[1]), date: d.to, fromDate: d.from, office: after(body, /in the\s+(.+?)\s+office/i), employeeId: after(body, /employee\.php\?id=(\d+)/i) };
  }
  case 'contract_end_change': {
    const d = changedDates(body, 'contract end date');
    const subjDate = fromIso((subj.match(new RegExp(`has changed to\\s+${ISO}`, 'i')) || [])[1]);
    return { ...base, person: clean(m[1]), date: d.to || subjDate, fromDate: d.from, employeeId: after(body, /employee\.php\?id=(\d+)/i) };
  }
  case 'departure_cancelled':
  case 'new_hire_cancelled':
    return { ...base, person: clean(m[1]), date: null, employeeId: after(body, /employee\.php\?id=(\d+)/i) };
  case 'new_hire':
    return {
      ...base,
      person: clean(m[1]),
      date: newHireStart(body, createdAt),
      employeeId: after(body, /Employee #:\s*(\d+)/i),
      title: after(body, /Position:\s*(.+?)\s+Employee Status:/i),
      office: after(body, /Location:\s*(.+?)\s+Reports To:/i),
      manager: after(body, /Reports To:\s*(.+?)(?:\s+View Employee Record|$)/i),
    };
  case 'start_date_change': {
    const d = changedDates(body, 'start date');
    return { ...base, person: clean(m[1]), date: d.to, fromDate: d.from, office: after(body, /in the\s+(.+?)\s+office/i) };
  }
  case 'new_hire_office_change':
    return {
      ...base,
      person: clean(m[1]),
      office: after(body, /has changed to\s+(.+?)\s+from\s+/i),
      fromOffice: after(body, /has changed to\s+.+?\s+from\s+(.+?)\s+who is due/i),
      date: fromIso(after(body, /due to start on\s+(20\d{2}-\d{2}-\d{2})/i)),
    };
  case 'nh_automation':
    return {
      ...base,
      nhKind: m[1].toLowerCase(),
      office: clean(m[2]),
      username: clean(m[4]),
      date: fromIso(m[5]) || fromIso(after(body, /Start Date:\s*(20\d{2}-\d{2}-\d{2})/i)),
      employeeId: after(body, /\bID:\s*(\d+)/),
      person: after(body, /Full Name:\s*(.+?)\s+(?:ID|Email|Location):/i),
    };
  case 'transfer': {
    const section = (body.split(/new transfer records/i)[1] || '').split(/removed transfer records/i)[0];
    const date = (section ? firstIsoIn(section) : null)
        || changedDates(body, 'transfer date').to
        || fromIso(after(body, /Transfer Date:\s*(20\d{2}-\d{2}-\d{2})/i));
    return {
      ...base,
      person: clean(m[1]),
      date,
      employeeId: after(section, /Comments\s+(\d+)\s/i),
      fromOffice: clean(m[2]) || after(section, /20\d{2}-\d{2}-\d{2}\s+(.+?)\s+\S+\s+(?:N\/A|\S)/i),
      office: clean(m[3]) || after(section, /20\d{2}-\d{2}-\d{2}\s+\S+\s+(\S+)\s/i),
    };
  }
  case 'leave_change':
    return { ...base, person: clean(m[1]), changed: m[2].toLowerCase(), date: fromIso(m[3]), office: clean(m[4]) };
  case 'leave': {
    let leaveStart = null;
    let returnDate = null;
    let employeeId = null;
    if (/new leave records/i.test(body)) {
      const section = (body.split(/new leave records/i)[1] || '').split(/removed leave records/i)[0];
      const dates = [...section.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((x) => fromIso(x[1])).filter(Boolean);
      [leaveStart = null, returnDate = null] = dates;
      employeeId = after(section, /Expected Return Date\s+(\d+)\s/i);
    } else {
      leaveStart = fromIso(after(body, /Expected Leave Date:\s*(20\d{2}-\d{2}-\d{2})/i));
      returnDate = fromIso(after(body, /Expected Return Date:\s*(20\d{2}-\d{2}-\d{2})/i));
    }
    return { ...base, person: clean(m[1]), date: leaveStart || returnDate, leaveStart, returnDate, employeeId, leaveType: after(body, /Leave Type:\s*(.+?)\s+Expected/i) };
  }
  default:
    return null;
  }
}

/** Which family a notice type belongs to, and what it does to it. */
export const NOTICE_EFFECT = Object.freeze({
  departure: { family: 'offboarding', effect: 'create' },
  departure_date_change: { family: 'offboarding', effect: 'move' },
  contract_end_change: { family: 'offboarding', effect: 'move' },
  departure_cancelled: { family: 'offboarding', effect: 'cancel' },
  new_hire: { family: 'onboarding', effect: 'create' },
  start_date_change: { family: 'onboarding', effect: 'move' },
  new_hire_office_change: { family: 'onboarding', effect: 'office' },
  new_hire_cancelled: { family: 'onboarding', effect: 'cancel' },
  nh_automation: { family: 'onboarding', effect: 'link' },
  transfer: { family: 'office_change', effect: 'notice' },
  leave: { family: 'leave', effect: 'notice' },
  leave_change: { family: 'leave', effect: 'notice' },
});
