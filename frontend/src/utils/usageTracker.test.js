import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../services/api', () => ({ API_BASE_URL: 'http://x/api', getAuthToken: () => 't', getWorkspaceId: () => 1 }));

const {
  createUsageTracker, resolvePage, pageLabel, viewportBand, TRACKED_ROUTES,
  VISIT_IDLE_MS, VISIT_CAP_MS, INPUT_WINDOW_MS,
} = await import('./usageTracker');

/**
 * Site stats, browser side (8 Oct 2026). What must hold for the numbers to be
 * honest: only page names leave the browser, a tab left open does not count as
 * someone working, and a visit ends after 30 minutes without input.
 */

describe('resolvePage', () => {
  test.each([
    ['/tickets', '', '', 'tickets.list', ''],
    ['/tickets', '', '?peek=62371&view=mine', 'tickets.list', 'peek'],
    ['/tickets/new', '', '', 'tickets.new', ''],
    ['/tickets/62371', '', '', 'tickets.detail', ''],
    ['/settings', '#site-stats', '', 'settings', 'site-stats'],
    ['/settings', '', '', 'settings', ''],
    ['/assignments/history', '', '', 'assignments', 'history'],
    ['/assignments/run/28885', '', '', 'assignments.run', ''],
    ['/knowledge/solutions/412', '', '', 'knowledge', 'solutions'],
    ['/availability', '', '', 'availability', ''],
    ['/analytics/category-map', '', '', 'analytics.category-map', ''],
  ])('%s%s%s is %s / "%s"', (pathname, hash, search, key, section) => {
    expect(resolvePage({ pathname, hash, search })).toEqual({ key, section });
  });

  test('public token pages and unknown paths are not tracked', () => {
    expect(resolvePage({ pathname: '/approval/AbC123tokenXYZ456' })).toBeNull();
    expect(resolvePage({ pathname: '/ticket-status/9f8e7d6c5b4a' })).toBeNull();
    expect(resolvePage({ pathname: '/login' })).toBeNull();
    expect(resolvePage({ pathname: '/nope' })).toBeNull();
  });

  test('a section that is not a plain word is dropped, never stored', () => {
    expect(resolvePage({ pathname: '/settings', hash: '#<script>alert(1)' })).toEqual({ key: 'settings', section: '' });
    expect(resolvePage({ pathname: '/assignments/a b' })).toEqual({ key: 'assignments', section: '' });
  });

  test('every signed-in route in App.jsx has a name', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8');
    const paths = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(30);
    const untracked = new Set([
      '/', '*', '/login', '/auth/callback', '/notifications',
      '/summit/vote/:token', '/summit/report/:token', '/ticket-status/:token', '/ticket-escalation/:token',
      '/ticket-urgency/:token', '/feedback/:token', '/approval/:token', '/approval-reply/:token',
    ]);
    const sample = (path) => path.replace(/\/:[A-Za-z]+\?/g, '').replace(/:[A-Za-z]+/g, 'x1');
    const missing = paths.filter((p) => !untracked.has(p) && !resolvePage({ pathname: sample(p) }));
    expect(missing).toEqual([]);
  });

  test('stored names fit the server rule (lower-case words joined by dots)', () => {
    for (const route of TRACKED_ROUTES) expect(route.key).toMatch(/^[a-z][a-z0-9]*(\.[a-z0-9-]+){0,3}$/);
  });
});

test('labels and window sizes', () => {
  expect(pageLabel('tickets.detail')).toBe('Ticket');
  expect(pageLabel('assignments', 'history')).toBe('Assignment review: history');
  expect(pageLabel('something.new')).toBe('something.new');
  expect([500, 800, 1280, 1600, 2560].map(viewportBand)).toEqual(['phone', 'tablet', 'laptop', 'desktop', 'wide']);
});

function harness() {
  const state = { t: 1_000_000, visible: true, stored: null, sent: [] };
  const tracker = createUsageTracker({
    now: () => state.t,
    visible: () => state.visible,
    width: () => 1280,
    workspace: () => 3,
    storage: { get: () => state.stored, set: (v) => { state.stored = { ...v }; } },
    send: (body) => state.sent.push(JSON.parse(JSON.stringify(body))),
  });
  // Time moves in 5-second ticks like the real timer.
  const run = (ms, { input = false } = {}) => {
    for (let left = ms; left > 0; left -= 5000) {
      state.t += Math.min(5000, left);
      if (input) tracker.input();
      tracker.tick();
    }
  };
  return { state, tracker, run };
}

describe('time on a page', () => {
  test('open time needs a visible tab; engaged time also needs input in the last minute', () => {
    const { state, tracker, run } = harness();
    tracker.pageView({ key: 'tickets.detail' });
    run(30_000, { input: true }); // working
    run(120_000); // reading, then idle: one more minute counts as engaged
    state.visible = false;
    run(600_000); // tab hidden: nothing accrues
    tracker.flush();
    const [event] = state.sent[0].events;
    expect(event).toMatchObject({ kind: 'page', key: 'tickets.detail', ws: 3 });
    expect(event.open).toBe(150);
    expect(event.eng).toBe(30 + INPUT_WINDOW_MS / 1000);
  });

  test('a laptop that slept is not credited for the gap', () => {
    const { state, tracker } = harness();
    tracker.pageView({ key: 'dashboard' });
    state.t += 8 * 3600 * 1000;
    tracker.tick();
    tracker.flush();
    expect(state.sent[0].events[0].open).toBeLessThanOrEqual(10);
  });

  test('the open page is re-sent with the same id and larger counters; an idle hidden tab sends nothing', () => {
    const { state, tracker, run } = harness();
    tracker.pageView({ key: 'tickets.list' });
    run(10_000, { input: true });
    tracker.flush();
    run(10_000, { input: true });
    tracker.flush();
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1].events[0].id).toBe(state.sent[0].events[0].id);
    expect(state.sent[1].events[0].open).toBe(20);
    state.visible = false;
    run(60_000);
    expect(tracker.flush()).toBe(0);
    expect(state.sent).toHaveLength(2);
  });

  test('a filter change on the same page is not a new view; another page is', () => {
    const { state, tracker } = harness();
    tracker.pageView({ key: 'tickets.list', identity: '/tickets|' });
    tracker.pageView({ key: 'tickets.list', identity: '/tickets|' });
    tracker.pageView({ key: 'tickets.detail', identity: '/tickets/1|' });
    tracker.pageView({ key: 'tickets.detail', identity: '/tickets/2|' });
    tracker.flush();
    expect(state.sent[0].events.map((e) => e.key)).toEqual(['tickets.list', 'tickets.detail', 'tickets.detail']);
    expect(new Set(state.sent[0].events.map((e) => e.id)).size).toBe(3);
  });

  test('the batch carries the visit, the version and the window size, and no URL', () => {
    const { state, tracker } = harness();
    tracker.pageView({ key: 'settings', section: 'site-stats' });
    tracker.flush();
    const body = state.sent[0];
    expect(Object.keys(body).sort()).toEqual(['appVersion', 'events', 'sentAt', 'viewport', 'visitId']);
    expect(body.viewport).toBe('laptop');
    expect(Object.keys(body.events[0]).sort()).toEqual(['eng', 'id', 'key', 'kind', 'open', 'section', 't', 'ws']);
  });
});

describe('visits', () => {
  test('one visit while input keeps coming, shared through storage with other tabs', () => {
    const a = harness();
    a.tracker.pageView({ key: 'dashboard' });
    a.run(20 * 60 * 1000, { input: true });
    a.tracker.flush();
    const other = createUsageTracker({
      now: () => a.state.t, visible: () => true, width: () => 1280, workspace: () => 3,
      storage: { get: () => a.state.stored, set: (v) => { a.state.stored = { ...v }; } },
      send: (body) => a.state.sent.push(body),
    });
    other.pageView({ key: 'tickets.list' });
    other.flush();
    expect(a.state.sent[1].visitId).toBe(a.state.sent[0].visitId);
  });

  test('back after more than 30 minutes without input: a new visit and a fresh page view', () => {
    const { state, tracker, run } = harness();
    tracker.pageView({ key: 'dashboard' });
    run(10_000, { input: true });
    tracker.flush();
    run(VISIT_IDLE_MS + 60_000); // tab stays open and visible, nobody there
    tracker.input();
    tracker.flush();
    const first = state.sent[0];
    const last = state.sent[state.sent.length - 1];
    expect(last.visitId).not.toBe(first.visitId);
    const ids = last.events.map((e) => e.id);
    expect(ids).toHaveLength(2); // the old view closed, the new one opened
    expect(ids[0]).toBe(first.events[0].id);
    expect(ids[1]).not.toBe(ids[0]);
  });

  test('a visit never runs past 24 hours even with constant input', () => {
    const { state, tracker, run } = harness();
    tracker.pageView({ key: 'dashboard' });
    const started = state.stored.id;
    run(VISIT_CAP_MS + 60_000, { input: true });
    expect(state.stored.id).not.toBe(started);
  });
});
