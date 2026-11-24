/**
 * Personal API keys (4.4.05): plain-words helpers shared by the owner's
 * section, the admin view and the ticket thread. Pure functions so the copy
 * is tested once.
 */

export const PACIFIC_TZ = 'America/Vancouver';

// The four things a personal key can do, in the words the form shows.
// `read` is always on: a key that cannot read is useless.
export const ABILITIES = [
  { id: 'read', label: 'Read tickets and conversations', hint: 'The tickets you see in the app, with the same private notes.', always: true },
  { id: 'reply', label: 'Reply to requesters and add notes', hint: 'Sent as you, with your signature and the company template.' },
  { id: 'update', label: 'Update tickets', hint: 'Status, priority, assignment and fields: only what your role may change.' },
  { id: 'tasks', label: 'Tasks and time', hint: 'Add and update tasks and time entries.' },
];

const SHORT = {
  read: 'Read tickets',
  reply: 'Reply and add notes',
  update: 'Update tickets',
  tasks: 'Tasks and time',
};

export const EXPIRY_CHOICES = [30, 90, 180, 365];
export const DEFAULT_EXPIRY_DAYS = 90;

/**
 * The abilities of a key, as ability ids in display order. Reads `abilities`
 * (the contract) and falls back to mapping raw `scopes` so a backend that
 * returns scopes still reads right.
 */
export function abilitiesOf(key) {
  const set = new Set();
  for (const a of Array.isArray(key?.abilities) ? key.abilities : []) set.add(String(a));
  for (const s of Array.isArray(key?.scopes) ? key.scopes : []) {
    const scope = String(s);
    if (scope === 'tickets:read' || scope === 'conversations:read') set.add('read');
    else if (scope === 'conversations:write') set.add('reply');
    else if (scope === 'tickets:write') set.add('update');
    else if (scope.startsWith('tasks:') || scope.startsWith('timeentries:')) set.add('tasks');
  }
  set.add('read');
  return ABILITIES.map((a) => a.id).filter((id) => set.has(id));
}

/** "Read tickets · Reply and add notes · Update tickets"; "Read tickets only". */
export function abilitySentence(key) {
  const ids = abilitiesOf(key);
  if (ids.length === 1) return `${SHORT.read} only`;
  return ids.map((id) => SHORT[id]).join(' · ');
}

const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TZ, month: 'short', day: 'numeric', year: 'numeric' });

/** "Feb 20, 2027" in Pacific time; '—' for nothing. */
export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return dateFmt.format(d);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", then the date. */
export function agoWords(value, now = Date.now()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${plural(days, 'day')} ago`;
  return `on ${formatDate(value)}`;
}

/** "2 hours ago from 10.1.2.3" / "Not used yet". */
export function lastUsedWords(key, now = Date.now()) {
  const ago = agoWords(key?.lastUsedAt, now);
  if (!ago) return 'Not used yet';
  return key?.lastUsedIp ? `${ago} from ${key.lastUsedIp}` : ago;
}

/**
 * Last use in two whole phrases, for a table cell that puts each on its own
 * line: { when: '2 hours ago' | 'Oct 9, 2026' | 'Not used yet', from: 'from 10.1.2.3' | null }.
 */
export function lastUsedParts(key, now = Date.now()) {
  const ago = agoWords(key?.lastUsedAt, now);
  if (!ago) return { when: 'Not used yet', from: null };
  return { when: ago.replace(/^on /, ''), from: key?.lastUsedIp ? `from ${key.lastUsedIp}` : null };
}

/** "Last used 2 hours ago from 10.1.2.3" / "Last used Oct 9, 2026" / "Not used yet" — a whole phrase. */
export function lastUsedPhrase(key, now = Date.now()) {
  const { when, from } = lastUsedParts(key, now);
  if (!agoWords(key?.lastUsedAt, now)) return when;
  return `Last used ${when}${from ? ` ${from}` : ''}`;
}

const DAY = 86400000;

/** The whole phrase: "Expires Feb 20, 2027 (in 90 days)" / "Expired Feb 20, 2027". */
export function expiryWords(key, now = Date.now()) {
  if (!key?.expiresAt) return 'No end date';
  const t = new Date(key.expiresAt).getTime();
  if (Number.isNaN(t)) return 'No end date';
  if (key.status === 'expired' || t <= now) return `Expired ${formatDate(key.expiresAt)}`;
  const days = Math.ceil((t - now) / DAY);
  return `Expires ${formatDate(key.expiresAt)} (in ${plural(days, 'day')})`;
}

/** Short end date for a stacked line: "Expires Feb 20, 2027" / "Expired Feb 20, 2027". */
export function expiryShort(key, now = Date.now()) {
  if (!key?.expiresAt) return 'No end date';
  const t = new Date(key.expiresAt).getTime();
  if (Number.isNaN(t)) return 'No end date';
  return `${key.status === 'expired' || t <= now ? 'Expired' : 'Expires'} ${formatDate(key.expiresAt)}`;
}

/**
 * The end date for a column headed "Expires": the date alone, then a quieter
 * note on its own line. { date: 'Feb 20, 2027', note: 'in 90 days' }; an
 * expired or revoked key gives the date only (the status says the rest); a
 * switched-off key past its date notes 'Expired'.
 */
export function expiryParts(key, now = Date.now()) {
  if (!key?.expiresAt) return { date: 'No end date', note: null };
  const t = new Date(key.expiresAt).getTime();
  if (Number.isNaN(t)) return { date: 'No end date', note: null };
  const date = formatDate(key.expiresAt);
  if (key.status === 'expired' || key.status === 'revoked') return { date, note: null };
  if (t <= now) return { date, note: 'Expired' };
  return { date, note: `in ${plural(Math.ceil((t - now) / DAY), 'day')}` };
}

const shortFmt =new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TZ, month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TZ, year: 'numeric' });

/** "Nov 22" this year (Pacific), "Nov 22, 2025" otherwise. */
export function formatDayShort(value, now = Date.now()) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return yearFmt.format(d) === yearFmt.format(new Date(now)) ? shortFmt.format(d) : formatDate(d);
}

/**
 * Rotating restarts the expiry from today with the same length (final
 * contract). The length is the key's own lifetime, created → expires, in days.
 */
export function rotationExpiry(key, now = Date.now()) {
  const created = new Date(key?.createdAt).getTime();
  const expires = new Date(key?.expiresAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(expires) || expires <= created) return null;
  const days = Math.max(1, Math.round((expires - created) / DAY));
  return { days, until: formatDate(now + days * DAY) };
}

export const STATUS_WORDS = {
  active: 'On',
  disabled: 'Switched off',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const STATUS_TONE = {
  active: 'text-emerald-700 dark:text-emerald-300',
  disabled: 'text-amber-700 dark:text-amber-300',
  expired: 'text-muted-foreground',
  revoked: 'text-muted-foreground',
};

/**
 * One status line for a stacked key, each word said once:
 * "On · Expires Feb 18, 2027 · Last used 2 hours ago from 10.1.2.3",
 * "Expired Oct 24, 2026 · Last used Oct 9, 2026 from 10.1.2.3",
 * "Revoked Nov 2, 2026 · Not used yet". When the date phrase already says
 * Expired or Revoked, the separate status word is dropped.
 */
export function keySummaryLine(key, now = Date.now()) {
  const { text, from } = keySummaryParts(key, now);
  return from ? `${text} ${from}` : text;
}

/**
 * The same line in two parts, so "from 10.1.2.3" can be kept whole when the
 * line wraps at phone width: { text: 'On · Expires … · Last used 2 hours ago',
 * from: 'from 10.1.2.3' | null }.
 */
export function keySummaryParts(key, now = Date.now()) {
  let lead;
  if (key?.status === 'revoked') {
    lead = key.revokedAt && formatDate(key.revokedAt) !== '—' ? `Revoked ${formatDate(key.revokedAt)}` : 'Revoked';
  } else if (key?.status === 'expired') {
    const end = expiryShort(key, now);
    lead = end.startsWith('Expired') ? end : 'Expired';
  } else {
    lead = `${STATUS_WORDS[key?.status] || key?.status || '—'} · ${expiryShort(key, now)}`;
  }
  if (!agoWords(key?.lastUsedAt, now)) return { text: `${lead} · ${lastUsedPhrase(key, now)}`, from: null };
  const { when, from } = lastUsedParts(key, now);
  return { text: `${lead} · Last used ${when}`, from };
}

/** A key still holding the person's one slot (on, or switched off by an admin). */
export const isLiveKey = (key) => key?.status === 'active' || key?.status === 'disabled';

/** Split the IP box: one per line (commas tolerated), blanks dropped. */
export function parseIpList(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The message of an API error in plain words. */
export function errorText(err, fallback) {
  return err?.data?.detail || err?.response?.data?.detail || err?.response?.data?.message || err?.message || fallback;
}

/**
 * The name of the personal key a thread entry was sent with, or null.
 * The backend stores `entry.rawPayload.sentWithApiKey = { id, name }` (final
 * contract); a `via: { kind: 'personal_key', keyName }` object on the entry
 * or its rawPayload is read too.
 */
export function personalKeyNameOf(entry) {
  const sent = entry?.rawPayload?.sentWithApiKey;
  if (sent && typeof sent === 'object' && String(sent.name || '').trim()) return String(sent.name).trim();
  const via = entry?.via || entry?.rawPayload?.via || null;
  if (!via || typeof via !== 'object') return null;
  if (via.kind && via.kind !== 'personal_key') return null;
  const name = String(via.keyName || '').trim();
  return name || null;
}
