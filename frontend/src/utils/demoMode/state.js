// Demo mode runtime state.
//
// - The on/off flag lives in localStorage (persists across page reloads).
// - The session seed lives in sessionStorage (a brand new tab / recording
//   session gets a fresh random seed, so different recordings show different
//   fake identities, but a single recording session is internally consistent).
// - A small pub/sub lets React components re-render when the state flips.

const LS_KEY_ENABLED = 'tp_demoMode';
const LS_KEY_PHOTOS = 'tp_demoPhotosEnabled';
const SS_KEY_SEED = 'tp_demoSeed';

const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (_) { /* ignore listener errors */ }
  }
}

function safeRead(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function safeWrite(storage, key, value) {
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch { /* ignore */ }
}

export function isDemoMode() {
  return safeRead(localStorage, LS_KEY_ENABLED) === 'true';
}

export function arePhotosEnabled() {
  // Default true: when demo mode is on, replace photos.
  const v = safeRead(localStorage, LS_KEY_PHOTOS);
  return v == null ? true : v === 'true';
}

export function setPhotosEnabled(value) {
  safeWrite(localStorage, LS_KEY_PHOTOS, value ? 'true' : 'false');
  notify();
}

function generateSeed() {
  // 32-bit unsigned random seed. crypto.getRandomValues is available in all
  // modern browsers; fall back to Math.random just in case.
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  } catch {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
}

export function getDemoSeed() {
  let raw = safeRead(sessionStorage, SS_KEY_SEED);
  let seed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(seed)) {
    seed = generateSeed();
    safeWrite(sessionStorage, SS_KEY_SEED, String(seed));
  }
  return seed >>> 0;
}

export function reshuffleIdentities() {
  const seed = generateSeed();
  safeWrite(sessionStorage, SS_KEY_SEED, String(seed));
  // The identity caches are seeded from this value, so they must be cleared
  // too. We do that lazily via a callback registered by mappings.js, to
  // avoid a circular import.
  for (const fn of resetCallbacks) {
    try { fn(); } catch (_) { /* ignore */ }
  }
  notify();
  return seed;
}

const resetCallbacks = new Set();
export function onSeedReset(fn) {
  resetCallbacks.add(fn);
  return () => resetCallbacks.delete(fn);
}

export function setDemoMode(value) {
  safeWrite(localStorage, LS_KEY_ENABLED, value ? 'true' : 'false');
  if (value) {
    // Make sure a seed exists for the session the moment demo mode flips on.
    getDemoSeed();
  }
  notify();
}

export function subscribeDemoMode(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
