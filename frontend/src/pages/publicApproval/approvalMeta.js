/**
 * Pure presentation maps + helpers for the public approval page. Accent tints
 * follow the design-system convention: light tint + `dark:` twin at ~10–20%.
 */

export const STATUS_CHIP = {
  pending: { label: 'Awaiting your decision', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200' },
  info_requested: { label: 'Question sent', className: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200' },
  approved: { label: 'Approved', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' },
  rejected: { label: 'Not approved', className: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-200' },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
  expired: { label: 'Expired', className: 'bg-muted text-muted-foreground' },
  escalated: { label: 'Escalated', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200' },
  forwarded: { label: 'Forwarded', className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200' },
};

/**
 * The big status badge in the page header (top right) and the matching card
 * stripe. Strong tints on purpose: an approver opening a cancelled or decided
 * request must see it before reading anything else.
 */
export const STATUS_BADGE = {
  pending: {
    label: 'Awaiting your decision',
    badge: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/20 dark:text-amber-100 dark:border-amber-500/40',
    stripe: 'border-t-amber-400',
  },
  info_requested: {
    label: 'Question sent',
    badge: 'bg-violet-100 text-violet-900 border-violet-300 dark:bg-violet-500/20 dark:text-violet-100 dark:border-violet-500/40',
    stripe: 'border-t-violet-400',
  },
  approved: {
    label: 'Approved',
    badge: 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-100 dark:border-emerald-500/40',
    stripe: 'border-t-emerald-500',
  },
  rejected: {
    label: 'Not approved',
    badge: 'bg-red-100 text-red-900 border-red-300 dark:bg-red-500/20 dark:text-red-100 dark:border-red-500/40',
    stripe: 'border-t-red-500',
  },
  cancelled: {
    label: 'Cancelled',
    badge: 'bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-500/20 dark:text-orange-100 dark:border-orange-500/40',
    stripe: 'border-t-orange-500',
  },
  expired: {
    label: 'Expired',
    badge: 'bg-secondary text-foreground border-input',
    stripe: 'border-t-muted-foreground/40',
  },
  escalated: {
    label: 'Escalated',
    badge: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/20 dark:text-amber-100 dark:border-amber-500/40',
    stripe: 'border-t-amber-500',
  },
  forwarded: {
    label: 'Forwarded',
    badge: 'bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-500/20 dark:text-blue-100 dark:border-blue-500/40',
    stripe: 'border-t-blue-500',
  },
};

export const APPROVER_DOT = {
  pending: 'bg-amber-500',
  approved: 'bg-emerald-500',
  rejected: 'bg-red-500',
  cancelled: 'bg-muted-foreground/40',
  superseded: 'bg-muted-foreground/40',
  escalated: 'bg-amber-500',
  forwarded: 'bg-blue-500',
};

export function approverStatusLabel(approver, supersededBy) {
  switch (approver?.status) {
  case 'approved': return 'approved';
  case 'rejected': return 'rejected';
  case 'cancelled': return 'cancelled';
  case 'escalated': return 'escalated';
  case 'forwarded': return 'forwarded';
  case 'superseded': return supersededBy?.name ? `superseded by ${supersededBy.name}` : 'superseded';
  case 'pending':
  default: return 'pending';
  }
}

/** "You" first, then the rest in server order. */
export function sortApprovers(list) {
  const rows = Array.isArray(list) ? list : [];
  return [...rows.filter((a) => a?.isYou), ...rows.filter((a) => !a?.isYou)];
}

export function isOpenForDecision(status) {
  return status === 'pending' || status === 'info_requested';
}

/**
 * Turn a failed GET into one of three page states. 404 = the token never
 * existed; 400/410 (or an "expired" message) = it did, but is past its date.
 * `requestedByName` is only known when the error body carries it.
 */
export function classifyLoadError(err) {
  // services/api.js rewrites failures into `Error { status, message, code }`;
  // a raw axios error (tests, other clients) still carries `.response`.
  const status = err?.status ?? err?.response?.status;
  const data = err?.response?.data || {};
  const message = data.message || data.error || err?.message || '';
  if (status === 404) return { kind: 'invalid', message };
  if (status === 410 || /expired/i.test(message)) {
    return { kind: 'expired', message, requestedByName: data.requestedByName || null };
  }
  if (status === 400) return { kind: 'invalid', message };
  return { kind: 'error', message: message || 'We couldn\'t load this approval. Check your connection and try again.' };
}

export function isPastDate(value) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t < Date.now();
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// The API returns token-scoped photo URLs as app-relative paths (`/api/ticket-approvals/public/…`). The
// public page is served from the SWA host, which does not proxy /api, so make them absolute against the
// configured API origin (same-origin in dev, the App Service host in prod).
const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
export function absoluteApiUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return url.startsWith('/') ? `${API_ORIGIN}${url}` : url;
}

// Directory records often repeat the office in several fields ("Vancouver" as department AND location, or a
// title that already ends in ", Vancouver"). Build the rail lines without repeating a word the reader saw.
export function personMetaLines({ title, location, department } = {}) {
  const norm = (v) => (v || '').trim().toLowerCase();
  const seen = (v, ...others) => norm(v) && others.some((o) => norm(o).includes(norm(v)));
  const first = [title, seen(location, title) ? null : location].filter(Boolean).join(' · ');
  const second = seen(department, title, location) ? '' : (department || '').trim();
  return [first, second].filter(Boolean);
}
