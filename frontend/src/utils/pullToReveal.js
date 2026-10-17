/**
 * Pull past the top to bring back the tucked filters (Vahid, 17 Oct 2026).
 *
 * Arriving at the top of the list is not asking for the filters — you may
 * just be browsing up. A NEW upward scroll once you are already at the top
 * is: the wheel stream that carried you there (a trackpad's momentum
 * included) has to pause first (PAUSE_MS), then PULL_PX of further upward
 * scrolling reveals. A pause longer than RESET_MS starts the count again.
 *
 * Pure: the caller keeps `state` (start with initialPull()) and feeds every
 * wheel event; touch drags feed `touchPull` with the distance pulled down.
 */
export const PULL_PX = 240;
export const PAUSE_MS = 250;
export const RESET_MS = 700;
export const TOUCH_PULL_PX = 120;

export function initialPull() {
  return { armed: false, acc: 0, lastAt: -Infinity };
}

/**
 * One wheel event. `atTop`: the list was already at its top when the event
 * fired. Returns { state, progress (0..1), reveal (true once) }.
 */
export function stepPull(state, { deltaY, deltaMode = 0, atTop, now }) {
  const gap = now - state.lastAt;
  const next = { ...state, lastAt: now };
  if (!atTop || deltaY >= 0) return { state: { ...next, armed: false, acc: 0 }, progress: 0, reveal: false };
  if (!next.armed) {
    // Still the stream (or the momentum) that brought you to the top.
    if (gap < PAUSE_MS) return { state: next, progress: 0, reveal: false };
    next.armed = true;
    next.acc = 0;
  } else if (gap > RESET_MS) {
    next.acc = 0;
  }
  // deltaMode 1 = lines (Firefox mouse wheels): roughly 40 px a line.
  next.acc += Math.abs(deltaY) * (deltaMode === 1 ? 40 : 1);
  if (next.acc >= PULL_PX) return { state: { ...next, armed: false, acc: 0 }, progress: 0, reveal: true };
  return { state: next, progress: next.acc / PULL_PX, reveal: false };
}

/** A touch drag down at the top, `pulled` px so far: { progress, reveal }. */
export function touchPull(pulled) {
  const p = Math.max(0, pulled) / TOUCH_PULL_PX;
  return p >= 1 ? { progress: 0, reveal: true } : { progress: p, reveal: false };
}
