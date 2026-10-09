// HR notice dates (Parked, plans/PARKED_BUILD_PLAN.md §2.6).
//
// Strict reader for the HR notices IT receives — no guessing, no LLM. Formats
// measured on the 52 open IT notices, 23 Sep 2026:
//   Transfer Notification   … New Transfer Records … Transfer Date … 2026-10-05 …
//   Departure Notification  Departure Date: 2026-10-09
//   On Leave Notification   Expected Return Date: 2026-11-16
//   NH Laptop/Workstation   Start date: 2026-10-19
//   BambooHR "New Hire"     Start Date: Tue October 13        (no year: the weekday fixes it)
//   Start date change       The start date has changed from 2026-07-20 to 2027-03-01
//                           (old order: "has changed to 2027-03-01 from 2026-07-20")
// Added 1 Oct 2026 (plans/HR_LIFECYCLE_RESEARCH.md §4 gaps):
//   Departure date change   The departure date has changed from 2026-05-14 to 2026-05-15
//                           (old: "has changed to 2025-05-02 for …")
//   Contract end change     The contract end date has changed from 2026-10-02 to 2027-02-26
//   On Leave (table)        New Leave Records … 2026-09-21 2027-10-12 Removed Leave Records …
//                           → the leave START (IT's work is at the start: product decision)
//   On Leave (labelled)     Expected Leave Date: … is preferred over Expected Return Date:
//   New-hire office change  … has changed to Vancouver from Fredericton who is due to start on 2026-06-01
// Returns null when the notice is not one of these or the date is not clear.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function fromIso(text) {
  const m = String(text || '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** "Tue October 13" with no year: the year whose date falls on that weekday, nearest after `ref` (within a year). */
export function fromWeekdayMonthDay(weekday, monthName, day, ref, { maxAheadDays = 184 } = {}) {
  const month = MONTHS.indexOf(String(monthName).toLowerCase()) + 1;
  const wd = WEEKDAYS.indexOf(String(weekday).slice(0, 3).toLowerCase());
  if (month < 1 || wd < 0) return null;
  const refYear = new Date(ref).getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1]
    .map((y) => isoDate(y, month, Number(day)))
    .filter(Boolean)
    .filter((iso) => new Date(`${iso}T12:00:00Z`).getUTCDay() === wd);
  // A start notice arrives shortly before the start: from a week before the
  // notice to six months after. Exactly one weekday-consistent date in that
  // window = clear. (A wider window turned stale January notices into next
  // January — the weekday matched, the year was a guess.) Onboarding reads
  // up to a year ahead (interns are announced 7–9 months early; 15 of 194
  // new-hire notices in the year to Oct 2026): the weekday still has to match,
  // and a date before the notice is never accepted.
  const refMs = new Date(ref).getTime();
  const near = candidates.filter((iso) => {
    const t = new Date(`${iso}T12:00:00Z`).getTime();
    return t >= refMs - 7 * 86400e3 && t <= refMs + maxAheadDays * 86400e3;
  });
  return near.length === 1 ? near[0] : null;
}

function label(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${SHORT_MONTHS[m - 1]} ${d}`;
}

/**
 * @param {{ subject?: string, text?: string, createdAt?: Date|string }} notice
 * @returns {null | { kind, date: 'YYYY-MM-DD', reason: string, source: 'hr_notice' }}
 */
export function readHrNoticeDate({ subject = '', text = '', createdAt = new Date() } = {}) {
  const subj = String(subject || '');
  const body = String(text || '').replace(/\s+/g, ' ');
  if (!body) return null;

  if (/^transfer notification\b/i.test(subj)) {
    const section = (body.split(/new transfer records/i)[1] || '').split(/removed transfer records/i)[0];
    // Older one-line format (12 of 34 in the year to Oct 2026):
    // "<Name> will be transferring from X office to Y office on 2026-10-05."
    const line = body.match(/will be transferring from\s+.+?\s+office to\s+.+?\s+office on\s+(20\d{2}-\d{2}-\d{2})/i);
    const iso = /transfer date/i.test(section) ? fromIso(section) : (line ? fromIso(line[1]) : null);
    return iso ? { kind: 'transfer', date: iso, reason: `Transfer effective ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/^departure notification\b/i.test(subj) || /departure notification:/i.test(subj)) {
    if (/will no longer be departing/i.test(`${subj} ${body}`)) return null; // a cancellation has no date
    const m = body.match(/departure date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    if (iso) return { kind: 'departure', date: iso, reason: `Last day ${label(iso)} — offboarding (from the HR notice)`, source: 'hr_notice' };
    // "departure / contract end date has changed (from X) to Y" → Y.
    const changed = body.match(/(departure|contract end) date has changed (?:from\s+20\d{2}-\d{2}-\d{2}\s+)?to\s+(20\d{2}-\d{2}-\d{2})/i)
      || subj.match(/(contract end) date has changed to\s+(20\d{2}-\d{2}-\d{2})/i);
    const moved = changed ? fromIso(changed[2]) : null;
    if (!moved) return null;
    const what = /contract/i.test(changed[1]) ? 'Contract end' : 'Last day';
    return { kind: 'departure', date: moved, reason: `${what} moved to ${label(moved)} — offboarding (from the HR notice)`, source: 'hr_notice' };
  }
  if (/on leave notification\b/i.test(subj)) {
    // Current table format (since Mar 2026): the first two ISO dates of the
    // NEW records are the leave start and the expected return.
    if (/new leave records/i.test(body)) {
      const section = (body.split(/new leave records/i)[1] || '').split(/removed leave records/i)[0];
      const dates = [...section.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((x) => fromIso(x[1])).filter(Boolean);
      if (!dates.length) return null;
      const back = dates[1] ? ` (back ${label(dates[1])})` : '';
      return { kind: 'leave', date: dates[0], reason: `Leave starts ${label(dates[0])}${back} (from the HR notice)`, source: 'hr_notice' };
    }
    // Old labelled format: the leave start when it is stated, else the return.
    const start = body.match(/expected leave date\s*:\s*(20\d{2}-\d{2}-\d{2})/i)
      || `${subj} ${body}`.match(/expected leave date has changed to\s+(20\d{2}-\d{2}-\d{2})/i);
    const startIso = start ? fromIso(start[1]) : null;
    if (startIso) return { kind: 'leave', date: startIso, reason: `Leave starts ${label(startIso)} (from the HR notice)`, source: 'hr_notice' };
    const m = body.match(/expected return date\s*:\s*(20\d{2}-\d{2}-\d{2})/i)
      || `${subj} ${body}`.match(/expected return date has changed to\s+(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'leave', date: iso, reason: `On leave until ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/start date has changed/i.test(body)) {
    // New order "from X to Y", old order "to Y from X": Y either way.
    const m = body.match(/start date has changed from\s+20\d{2}-\d{2}-\d{2}\s+to\s+(20\d{2}-\d{2}-\d{2})/i)
      || body.match(/start date has changed to\s+(20\d{2}-\d{2}-\d{2})\s+from\s+20\d{2}-\d{2}-\d{2}/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'start_change', date: iso, reason: `New start date ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/office location for .+ has changed/i.test(body)) {
    const m = body.match(/due to start on\s+(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'start_change', date: iso, reason: `Starts ${label(iso)} — office changed (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/^NH\s/i.test(subj) || /^new hire\b/i.test(subj)) {
    const isoM = body.match(/start date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
    if (isoM) {
      const iso = fromIso(isoM[1]);
      return iso ? { kind: 'new_hire', date: iso, reason: `Starts ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
    }
    const wm = body.match(/start date\s*:\s*(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?,?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})(?!\d)/i);
    const iso = wm ? fromWeekdayMonthDay(wm[1], wm[2], wm[3], createdAt) : null;
    return iso ? { kind: 'new_hire', date: iso, reason: `Starts ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  return null;
}

/**
 * Lead time for HR parks (Vahid, 25 Sep 2026): a notice wakes ahead of its date
 * so the work is ready on the day, not started on it.
 *   new hire / start change  21 days before the start   (8 Oct 2026; was 14)
 *   departure                14 days before the last day (8 Oct 2026; was the Monday of that week)
 *   leave                    the Monday of the week of the date
 *   transfer                 2 business days before the effective date
 * A wake that lands on a non-business day moves back to the business day
 * before it. `isBusinessDay(iso)` defaults to Monday–Friday.
 * @returns {string} YYYY-MM-DD
 */
export function hrWakeDate(kind, dateIso, { isBusinessDay = null } = {}) {
  const biz = typeof isBusinessDay === 'function'
    ? isBusinessDay
    : (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5; };
  const shift = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  let wake = dateIso;
  if (kind === 'new_hire' || kind === 'start_change') {
    wake = shift(dateIso, -21);
  } else if (kind === 'departure') {
    wake = shift(dateIso, -14);
  } else if (kind === 'leave') {
    const dow = new Date(`${dateIso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    wake = shift(dateIso, -((dow + 6) % 7));
  } else if (kind === 'transfer') {
    let left = 2;
    wake = dateIso;
    for (let i = 0; i < 60 && left > 0; i++) {
      wake = shift(wake, -1);
      if (biz(wake)) left -= 1;
    }
  }
  for (let i = 0; i < 30 && !biz(wake); i++) wake = shift(wake, -1);
  return wake;
}
