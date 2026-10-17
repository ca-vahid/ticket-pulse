import { describe, expect, test } from 'vitest';
import { PULL_PX, initialPull, stepPull, touchPull } from './pullToReveal';

// Pull past the top (17 Oct 2026): arriving at the top never reveals; a new
// upward scroll once there does.
const run = (events) => {
  let state = initialPull();
  const out = [];
  for (const e of events) {
    const r = stepPull(state, e);
    state = r.state;
    out.push(r);
  }
  return out;
};

describe('stepPull', () => {
  test('scrolling up to the top in one stream (with momentum after) never reveals', () => {
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push({ deltaY: -100, atTop: false, now: i * 40 });
    for (let i = 10; i < 40; i += 1) events.push({ deltaY: -60, atTop: true, now: i * 40 }); // momentum at the top
    expect(run(events).some((r) => r.reveal || r.progress > 0)).toBe(false);
  });

  test('after a pause at the top, scrolling up again fills the pull and reveals once', () => {
    const events = [
      { deltaY: -100, atTop: false, now: 0 },
      { deltaY: -100, atTop: true, now: 30 },
      // pause, then a deliberate pull: three mouse-wheel notches
      { deltaY: -100, atTop: true, now: 600 },
      { deltaY: -100, atTop: true, now: 700 },
      { deltaY: -100, atTop: true, now: 800 },
    ];
    const out = run(events);
    expect(out[2].progress).toBeCloseTo(100 / PULL_PX);
    expect(out[3].progress).toBeCloseTo(200 / PULL_PX);
    expect(out[4].reveal).toBe(true);
    expect(out.filter((r) => r.reveal)).toHaveLength(1);
  });

  test('scrolling down, or leaving the top, cancels the pull; a long pause starts it again', () => {
    const out = run([
      { deltaY: -100, atTop: true, now: 1000 },
      { deltaY: 50, atTop: true, now: 1100 },
      { deltaY: -100, atTop: true, now: 1150 }, // straight after: not armed again yet
      { deltaY: -100, atTop: true, now: 2000 }, // re-armed after a pause
      { deltaY: -100, atTop: true, now: 3000 }, // more than RESET_MS later: counts from zero
    ]);
    expect(out[1].progress).toBe(0);
    expect(out[2].progress).toBe(0);
    expect(out[3].progress).toBeCloseTo(100 / PULL_PX);
    expect(out[4].progress).toBeCloseTo(100 / PULL_PX);
  });

  test('line-mode wheels (Firefox) count about 40 px a line', () => {
    const out = run([{ deltaY: -3, deltaMode: 1, atTop: true, now: 1000 }, { deltaY: -3, deltaMode: 1, atTop: true, now: 1100 }]);
    expect(out[0].progress).toBeCloseTo(120 / PULL_PX);
    expect(out[1].reveal).toBe(true);
  });
});

describe('touchPull', () => {
  test('a drag down at the top fills, then reveals', () => {
    expect(touchPull(60)).toEqual({ progress: 0.5, reveal: false });
    expect(touchPull(130).reveal).toBe(true);
    expect(touchPull(-20).progress).toBe(0);
  });
});
