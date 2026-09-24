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
// Returns null when the notice is not one of these or the date is not clear.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function fromIso(text) {
  const m = String(text || '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** "Tue October 13" with no year: the year whose date falls on that weekday, nearest after `ref` (within a year). */
function fromWeekdayMonthDay(weekday, monthName, day, ref) {
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
  // January — the weekday matched, the year was a guess.)
  const refMs = new Date(ref).getTime();
  const near = candidates.filter((iso) => {
    const t = new Date(`${iso}T12:00:00Z`).getTime();
    return t >= refMs - 7 * 86400e3 && t <= refMs + 184 * 86400e3;
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
    const iso = /transfer date/i.test(section) ? fromIso(section) : null;
    return iso ? { kind: 'transfer', date: iso, reason: `Transfer effective ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/^departure notification\b/i.test(subj) || /departure notification:/i.test(subj)) {
    const m = body.match(/departure date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'departure', date: iso, reason: `Last day ${label(iso)} — offboarding (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/on leave notification\b/i.test(subj)) {
    const m = body.match(/expected return date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'leave', date: iso, reason: `On leave until ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/start date has changed/i.test(body)) {
    const m = body.match(/start date has changed from\s+20\d{2}-\d{2}-\d{2}\s+to\s+(20\d{2}-\d{2}-\d{2})/i);
    const iso = m ? fromIso(m[1]) : null;
    return iso ? { kind: 'start_change', date: iso, reason: `New start date ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  if (/^NH\s/i.test(subj) || /^new hire\b/i.test(subj)) {
    const isoM = body.match(/start date\s*:\s*(20\d{2}-\d{2}-\d{2})/i);
    if (isoM) {
      const iso = fromIso(isoM[1]);
      return iso ? { kind: 'new_hire', date: iso, reason: `Starts ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
    }
    const wm = body.match(/start date\s*:\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+([a-z]+)\s+(\d{1,2})\b/i);
    const iso = wm ? fromWeekdayMonthDay(wm[1], wm[2], wm[3], createdAt) : null;
    return iso ? { kind: 'new_hire', date: iso, reason: `Starts ${label(iso)} (from the HR notice)`, source: 'hr_notice' } : null;
  }
  return null;
}
