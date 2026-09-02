/**
 * Pure presentation maps + helpers for the public approval page. Accent tints
 * follow the design-system convention: light tint + `dark:` twin at ~10–20%.
 */

export const STATUS_CHIP = {
  pending: { label: 'Awaiting your decision', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200' },
  info_requested: { label: 'Question sent', className: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200' },
  approved: { label: 'Approved', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' },
  rejected: { label: 'Rejected', className: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-200' },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
  expired: { label: 'Expired', className: 'bg-muted text-muted-foreground' },
};

export const APPROVER_DOT = {
  pending: 'bg-amber-500',
  approved: 'bg-emerald-500',
  rejected: 'bg-red-500',
  cancelled: 'bg-muted-foreground/40',
  superseded: 'bg-muted-foreground/40',
};

export function approverStatusLabel(approver, supersededBy) {
  switch (approver?.status) {
  case 'approved': return 'approved';
  case 'rejected': return 'rejected';
  case 'cancelled': return 'cancelled';
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
