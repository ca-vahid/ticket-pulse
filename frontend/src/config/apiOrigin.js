/**
 * Which API host the app talks to (25 Nov 2026: ticketpulse.bgcsi.com became the
 * main address; ticketpulse.bgcsaas.com forwards there from index.html).
 *
 * The session cookie is set by the API host, so the web page must call an API on
 * the SAME site to keep that cookie first-party: the bgcsi.com page calls
 * api.ticketpulse.bgcsi.com. Every other host (localhost, the azurestaticapps
 * preview host, the old address before its forward runs) keeps the build-time
 * VITE_API_URL, so one bundle serves both addresses.
 *
 * `resolveApiOrigin` is pure (pass the hostname in to test); `currentApiOrigin`
 * reads the browser's hostname and the build's VITE_API_URL.
 */
export const PRIMARY_WEB_HOST = 'ticketpulse.bgcsi.com';
export const PRIMARY_API_ORIGIN = 'https://api.ticketpulse.bgcsi.com';
export const LOCAL_API_ORIGIN = 'http://localhost:3000';

const clean = (value) => String(value || '').trim().replace(/\/+$/, '');

/** The API origin (no trailing slash, no /api) for a page served at `hostname`. */
export function resolveApiOrigin({ hostname = '', envUrl = '', fallback = LOCAL_API_ORIGIN } = {}) {
  if (String(hostname || '').trim().toLowerCase() === PRIMARY_WEB_HOST) return PRIMARY_API_ORIGIN;
  return clean(envUrl) || clean(fallback);
}

/** The API origin for this page. `fallback` applies when VITE_API_URL is not set. */
export function currentApiOrigin({ fallback = LOCAL_API_ORIGIN } = {}) {
  const hostname = typeof window !== 'undefined' ? window.location?.hostname || '' : '';
  return resolveApiOrigin({ hostname, envUrl: import.meta.env.VITE_API_URL, fallback });
}

export default currentApiOrigin;
