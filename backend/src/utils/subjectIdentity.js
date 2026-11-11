/**
 * Long numbers in a subject are an identity, not a counter (11 Nov 2026).
 *
 * The look-alike cap compared subjects with every digit run masked, so five
 * invoices from one vendor that differ only by invoice number were "the same
 * mail" and the fourth and fifth were held. A number of six or more digits that
 * stands on its own (an invoice, a PO, an order) names one thing. Short numbers
 * ("70 Days", "Drive 12"), numbers glued to a word (FILE1, INC0012345), dates
 * and clock stamps stay masked, so a repeating alert is still one key.
 *
 * Pure. Nothing here touches the database.
 */

export const LONG_NUMBER_MIN_DIGITS = 6;

// A current Unix time, in seconds or milliseconds: a stamp, not an identity.
const STAMP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function validYmd(y, m, d) {
  return y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** 20261111, 202611110914, 20261111091455: a date written without separators. */
function looksLikeCompactDate(run) {
  if (![8, 12, 14].includes(run.length)) return false;
  const ymd = validYmd(Number(run.slice(0, 4)), Number(run.slice(4, 6)), Number(run.slice(6, 8)));
  if (!ymd) return false;
  if (run.length === 8) return true;
  const hh = Number(run.slice(8, 10));
  const mm = Number(run.slice(10, 12));
  const ss = run.length === 14 ? Number(run.slice(12, 14)) : 0;
  return hh <= 23 && mm <= 59 && ss <= 59;
}

function looksLikeCurrentStamp(run, now) {
  if (run.length !== 10 && run.length !== 13) return false;
  const ms = run.length === 10 ? Number(run) * 1000 : Number(run);
  return Math.abs(ms - now) <= STAMP_WINDOW_MS;
}

/**
 * Is this digit run an identity? `before` / `after` are the characters next to
 * it in the subject ('' at either end).
 */
export function isIdentityRun(run, before = '', after = '', now = Date.now()) {
  if (run.length < LONG_NUMBER_MIN_DIGITS) return false;
  if (/\p{L}/u.test(before) || /\p{L}/u.test(after)) return false;
  if (looksLikeCompactDate(run)) return false;
  if (looksLikeCurrentStamp(run, now)) return false;
  return true;
}

/** `subject` with each digit run passed to `fn(run, isIdentity)`. */
function mapDigitRuns(subject, now, fn) {
  const s = String(subject || '');
  return s.replace(/\d+/g, (run, offset) => fn(run, isIdentityRun(run, s[offset - 1] || '', s[offset + run.length] || '', now)));
}

/** The distinct long numbers a subject carries, in order. */
export function longNumbers(subject, { now = Date.now() } = {}) {
  const found = [];
  mapDigitRuns(subject, now, (run, identity) => {
    if (identity && !found.includes(run)) found.push(run);
    return run;
  });
  return found;
}

/** Every digit run masked as '#', except long numbers, which stay. */
export function maskCounters(subject, { now = Date.now() } = {}) {
  return mapDigitRuns(subject, now, (run, identity) => (identity ? run : '#'));
}

/**
 * Both subjects carry long numbers and share none: they are about different
 * things (two invoices), however alike the words are. False when either has none.
 */
export function longNumbersDiffer(a, b, opts = {}) {
  const x = longNumbers(a, opts);
  const y = longNumbers(b, opts);
  if (!x.length || !y.length) return false;
  return !x.some((n) => y.includes(n));
}
