// Last known workspace role, remembered per browser so pre-auth code paths can
// avoid requests the role will be refused (17 Sep 2026: a viewer who opens
// /dashboard used to trigger three speculative admin-only fetches, each a 403
// and a warning line in the server log, before the route bounced them).
// A hint only ever SUPPRESSES speculative work — it never grants anything;
// the real role still comes from the session and the server still decides.
const KEY = 'tp_role_hint';

export function readRoleHint() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v || null;
  } catch {
    return null;
  }
}

export function writeRoleHint(role) {
  try {
    if (!role) return;
    if (window.localStorage.getItem(KEY) !== role) window.localStorage.setItem(KEY, role);
  } catch { /* private mode / blocked storage — hint is optional */ }
}

/** Speculative ops-page prefetch is worth it unless we already know the role cannot see those pages. */
export function canPrefetchOps(hint) {
  if (!hint) return true; // unknown → keep the warm cache for admins
  return hint === 'admin' || hint === 'readonly';
}

export default { readRoleHint, writeRoleHint, canPrefetchOps };
