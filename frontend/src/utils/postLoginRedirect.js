/**
 * Remember where a signed-out visitor was heading so sign-in can return them
 * there (14 Sep 2026). A ticket link from Simorgh, e-mail or chat used to end
 * on the role home after SSO because the guards bounced to /login with no
 * memory of the path and the MSAL redirect lands on /auth/callback.
 *
 * sessionStorage on purpose: it is per tab, survives the SSO round trip
 * (same origin), and dies with the tab, so a stale destination never leaks
 * into a later session. Every access is wrapped — private windows can throw.
 */

export const POST_LOGIN_PATH_KEY = 'tp_postLoginPath';

// Paths that are never a useful destination in their own right.
const NEVER_REMEMBER = new Set(['/', '/login', '/auth/callback', '/workspace']);

/** Only same-app paths: starts with a single "/", no scheme, no "//host". */
export function isSafeInternalPath(path) {
  if (typeof path !== 'string' || path.length < 2 || path.length > 2000) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  if (/[\r\n\t]/.test(path) || /^\/[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}

export function pathFromLocation(location) {
  if (!location) return null;
  return `${location.pathname || ''}${location.search || ''}${location.hash || ''}`;
}

/** Store the destination unless it is one of the bounce targets themselves. */
export function rememberPostLoginPath(location) {
  const path = typeof location === 'string' ? location : pathFromLocation(location);
  if (!isSafeInternalPath(path)) return false;
  const pathname = path.split(/[?#]/)[0];
  if (NEVER_REMEMBER.has(pathname)) return false;
  try {
    window.sessionStorage.setItem(POST_LOGIN_PATH_KEY, path);
    return true;
  } catch {
    return false;
  }
}

export function peekPostLoginPath() {
  try {
    const raw = window.sessionStorage.getItem(POST_LOGIN_PATH_KEY);
    return isSafeInternalPath(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read and clear. The first landing point that runs wins; the rest fall back to home. */
export function consumePostLoginPath() {
  const path = peekPostLoginPath();
  try { window.sessionStorage.removeItem(POST_LOGIN_PATH_KEY); } catch { /* no-op */ }
  return path;
}
