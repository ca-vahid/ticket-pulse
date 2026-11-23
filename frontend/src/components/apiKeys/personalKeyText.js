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

/** "Feb 20, 2027 (in 90 days)" / "Expired Feb 20, 2027". */
export function expiryWords(key, now = Date.now()) {
  if (!key?.expiresAt) return '—';
  const t = new Date(key.expiresAt).getTime();
  if (Number.isNaN(t)) return '—';
  if (key.status === 'expired' || t <= now) return `Expired ${formatDate(key.expiresAt)}`;
  const days = Math.ceil((t - now) / 86400000);
  return `${formatDate(key.expiresAt)} (in ${plural(days, 'day')})`;
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
