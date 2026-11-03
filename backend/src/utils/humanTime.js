/**
 * Readable timestamps for workflow e-mails and notes (QA 11-02 #2).
 *
 * `{{ ticket.createdAt }}` used to print the machine form
 * ("2026-10-28T19:34:41.799Z"). In text people read it now prints
 * "Wed 28 Oct 2026, 12:34 PM PT" on the workspace clock. The value itself is
 * unchanged, so conditions, webhooks and custom fields still get ISO.
 */

export const DEFAULT_ZONE = 'America/Vancouver';

// A whole ISO-8601 timestamp with a time part and an offset — never a bare
// date ("2026-10-28") and never text that merely contains one.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

// Intl's short names for BC shift with the tzdata version ("PST", "PDT",
// "GMT-7"); people here say Pacific time, so the common Canadian zones get
// the label people use.
const ZONE_LABELS = {
  'America/Vancouver': 'PT',
  'America/Los_Angeles': 'PT',
  'America/Edmonton': 'MT',
  'America/Calgary': 'MT',
  'America/Regina': 'CST',
  'America/Winnipeg': 'CT',
  'America/Toronto': 'ET',
  'America/Montreal': 'ET',
  'America/Halifax': 'AT',
  'America/Moncton': 'AT',
  'America/St_Johns': 'NT',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

export function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value.trim());
}

function validZone(zone) {
  if (!zone || typeof zone !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "Wed 28 Oct 2026, 12:34 PM PT", or null when the value is not a time. */
export function formatHumanTime(value, zone) {
  const date = value instanceof Date ? value : (isIsoTimestamp(value) ? new Date(value.trim()) : null);
  if (!date || Number.isNaN(date.getTime())) return null;
  const tz = validZone(zone) || DEFAULT_ZONE;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const label = ZONE_LABELS[tz] || parts.timeZoneName || tz;
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${label}`;
}
