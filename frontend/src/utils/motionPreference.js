import { useEffect, useState } from 'react';

/**
 * Motion preference (16 Sep 2026). Corporate Windows images often ship with
 * "Animation effects" off, which makes Chrome report prefers-reduced-motion:
 * reduce — and every transition in the app vanished on Vahid's machine while
 * looking like a regression. The app now decides for itself:
 *
 *   on      → motion always plays (default)
 *   system  → follow the OS flag (the old behaviour)
 *   off     → no motion
 *
 * The result is stamped on <html data-motion="full|reduce">. CSS reads that
 * attribute (Tailwind's `motion-off:` variant is re-pointed at it in
 * tailwind.config.js, index.css uses html[data-motion="reduce"]) and JS
 * callers use motionReduced() instead of matchMedia.
 */
export const MOTION_KEY = 'tp_motion';
export const MOTION_MODES = ['on', 'system', 'off'];
export const MOTION_LABELS = {
  on: { label: 'On', hint: 'Menus, rails and panels ease open — regardless of the operating system’s reduce-motion setting.' },
  system: { label: 'System', hint: 'Follow the operating system: motion plays unless Windows or macOS asks apps to reduce it.' },
  off: { label: 'Off', hint: 'No transitions or animations anywhere in Ticket Pulse.' },
};
const EVENT = 'tp:motion-changed';

export function readMotionMode() {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return MOTION_MODES.includes(v) ? v : 'on';
  } catch {
    return 'on';
  }
}

function systemReduces() {
  try { return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
}

export function resolveMotion(mode = readMotionMode()) {
  if (mode === 'off') return 'reduce';
  if (mode === 'system') return systemReduces() ? 'reduce' : 'full';
  return 'full';
}

export function applyMotionMode(mode = readMotionMode()) {
  if (typeof document === 'undefined') return 'full';
  const resolved = resolveMotion(mode);
  document.documentElement.dataset.motion = resolved;
  return resolved;
}

export function setMotionMode(mode) {
  const next = MOTION_MODES.includes(mode) ? mode : 'on';
  try { localStorage.setItem(MOTION_KEY, next); } catch { /* private mode */ }
  applyMotionMode(next);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { mode: next } })); } catch { /* no-op */ }
}

/** True when motion is currently reduced (for JS-driven animation decisions). */
export function motionReduced() {
  if (typeof document === 'undefined') return false;
  const stamped = document.documentElement.dataset.motion;
  return stamped ? stamped === 'reduce' : resolveMotion() === 'reduce';
}

/** Boot: stamp once and keep following the OS flag while mode === 'system'. */
export function installMotionPreference() {
  applyMotionMode();
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { if (readMotionMode() === 'system') applyMotionMode('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener?.(onChange);
  } catch { /* no matchMedia */ }
}

export function useMotionMode() {
  const [mode, setModeState] = useState(readMotionMode);
  useEffect(() => {
    const onEvt = (e) => setModeState(e.detail?.mode || readMotionMode());
    window.addEventListener(EVENT, onEvt);
    return () => window.removeEventListener(EVENT, onEvt);
  }, []);
  return { mode, setMode: setMotionMode, labels: MOTION_LABELS };
}
