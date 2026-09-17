/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { applyMotionMode, motionReduced, readMotionMode, resolveMotion, setMotionMode } from './motionPreference';

function stubReduce(matches) {
  window.matchMedia = vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

describe('motionPreference (16 Sep 2026)', () => {
  beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.motion; });
  afterEach(() => { delete window.matchMedia; });

  test('default is "on": motion plays even when the OS asks to reduce it', () => {
    stubReduce(true);
    expect(readMotionMode()).toBe('on');
    expect(applyMotionMode()).toBe('full');
    expect(document.documentElement.dataset.motion).toBe('full');
    expect(motionReduced()).toBe(false);
  });

  test('"system" follows the OS flag both ways', () => {
    stubReduce(true);
    expect(resolveMotion('system')).toBe('reduce');
    stubReduce(false);
    expect(resolveMotion('system')).toBe('full');
  });

  test('"off" always reduces; setMotionMode persists, stamps and announces', () => {
    stubReduce(false);
    const heard = vi.fn();
    window.addEventListener('tp:motion-changed', heard);
    setMotionMode('off');
    expect(localStorage.getItem('tp_motion')).toBe('off');
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(motionReduced()).toBe(true);
    expect(heard).toHaveBeenCalled();
    setMotionMode('garbage');
    expect(readMotionMode()).toBe('on');
  });
});
