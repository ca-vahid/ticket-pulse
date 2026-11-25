import { jest } from '@jest/globals';

/**
 * FreshService switch (FreshService exit A1, 25 Nov 2026): the per-workspace
 * mode service every FreshService call site asks. Connected is the default,
 * Shadow behaves as Connected but counts, Off refuses; a workspace with FS id 0
 * is "never connected"; a read error is never a silent Off.
 */

const store = new Map();
const settingsMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, String(value)); return { key, value }; }),
};
const prismaMock = { workspace: { findUnique: jest.fn() } };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const fsMode = await import('../src/services/fsModeService.js');
const {
  getMode, getModeRecord, isFreshServiceOff, fsGate, setMode, onModeChange,
  getShadowReport, flushShadow, modeSettingKey, shadowSettingKey, _resetFsModeCache,
} = fsMode;

const LINKED = 5;
const NATIVE = 10;

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  _resetFsModeCache();
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => (
    where.id === NATIVE ? { id: NATIVE, freshserviceWorkspaceId: 0n } : { id: where.id, freshserviceWorkspaceId: 1000208182n }
  ));
});

describe('mode default and parse', () => {
  test('a linked workspace with no setting is connected', async () => {
    await expect(getMode(LINKED)).resolves.toBe('connected');
    await expect(isFreshServiceOff(LINKED)).resolves.toBe(false);
    await expect(fsGate(LINKED, 'sync')).resolves.toBe(true);
  });

  test('a stored record is parsed; junk or an unknown mode reads as connected', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'off', changedBy: 'admin@example.com' }));
    await expect(getMode(LINKED)).resolves.toBe('off');
    await expect(getModeRecord(LINKED)).resolves.toMatchObject({ mode: 'off', changedBy: 'admin@example.com' });

    _resetFsModeCache();
    store.set(modeSettingKey(LINKED), '{not json');
    await expect(getMode(LINKED)).resolves.toBe('connected');

    _resetFsModeCache();
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'paused' }));
    await expect(getMode(LINKED)).resolves.toBe('connected');
  });

  test('the record is cached: a second read does not touch the settings', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'shadow' }));
    await getMode(LINKED);
    const reads = settingsMock.get.mock.calls.length;
    await getMode(LINKED);
    expect(settingsMock.get.mock.calls.length).toBe(reads);
  });

  test('no workspace (null, 0) is global behaviour, with no lookup', async () => {
    await expect(getMode(null)).resolves.toBe('connected');
    await expect(getMode(0)).resolves.toBe('connected');
    await expect(fsGate(null, 'sync')).resolves.toBe(true);
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });
});

describe('never connected (FS id 0)', () => {
  test('reads never_connected, is off, and the gate refuses', async () => {
    await expect(getMode(NATIVE)).resolves.toBe('never_connected');
    await expect(isFreshServiceOff(NATIVE)).resolves.toBe(true);
    await expect(fsGate(NATIVE, 'mirror')).resolves.toBe(false);
  });

  test('a row that says it has no link is off without a lookup', async () => {
    await expect(isFreshServiceOff({ id: 77, freshserviceWorkspaceId: 0 })).resolves.toBe(true);
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  test('setMode refuses it', async () => {
    await expect(setMode(NATIVE, 'shadow')).rejects.toThrow(/never connected/);
    expect(store.has(modeSettingKey(NATIVE))).toBe(false);
  });
});

describe('fsGate', () => {
  test('Shadow lets the call through and counts it by purpose', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'shadow' }));
    await expect(fsGate(LINKED, 'sync')).resolves.toBe(true);
    await expect(fsGate(LINKED, 'sync')).resolves.toBe(true);
    await expect(fsGate(LINKED, 'mirror')).resolves.toBe(true);
    await expect(fsGate(LINKED, 'something-new')).resolves.toBe(true); // unknown purpose -> 'other'
    const report = await getShadowReport(LINKED);
    expect(report.counts.sync.n).toBe(2);
    expect(report.counts.mirror.n).toBe(1);
    expect(report.counts.other.n).toBe(1);
    expect(report.total).toBe(4);
    expect(report.counts.sync.first).toEqual(expect.any(String));
  });

  test('Connected never counts', async () => {
    await fsGate(LINKED, 'sync');
    expect((await getShadowReport(LINKED)).total).toBe(0);
  });

  test('Off refuses and does not count', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'off' }));
    await expect(fsGate(LINKED, 'webhook')).resolves.toBe(false);
    await expect(isFreshServiceOff(LINKED)).resolves.toBe(true);
    expect((await getShadowReport(LINKED)).total).toBe(0);
  });
});

describe('setMode', () => {
  test('writes the record with history, updates the cache and runs the listeners', async () => {
    const seen = [];
    const off = onModeChange(async (ws, mode, prev) => { seen.push([ws, mode, prev]); });
    const record = await setMode(LINKED, 'off', { actorEmail: 'admin@example.com', note: 'test' });
    off();
    expect(record).toMatchObject({ mode: 'off', changedBy: 'admin@example.com', note: 'test' });
    expect(record.history).toEqual([expect.objectContaining({ from: 'connected', to: 'off', by: 'admin@example.com' })]);
    expect(JSON.parse(store.get(modeSettingKey(LINKED))).mode).toBe('off');
    expect(seen).toEqual([[LINKED, 'off', 'connected']]);
    // The cache already answers 'off' (no 30 s wait for the flip).
    settingsMock.get.mockClear();
    await expect(getMode(LINKED)).resolves.toBe('off');
    expect(settingsMock.get).not.toHaveBeenCalled();
  });

  test('a failing listener is logged, never thrown, and the others still run', async () => {
    const second = jest.fn();
    const a = onModeChange(() => { throw new Error('boom'); });
    const b = onModeChange(second);
    await expect(setMode(LINKED, 'shadow')).resolves.toMatchObject({ mode: 'shadow' });
    a(); b();
    expect(second).toHaveBeenCalledWith(LINKED, 'shadow', 'connected');
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('listener failed'));
  });

  test('entering Shadow resets the counts (memory and stored)', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'shadow' }));
    store.set(shadowSettingKey(LINKED), JSON.stringify({ since: '2026-11-01T00:00:00.000Z', counts: { sync: { n: 9, first: 'a', last: 'b' } } }));
    await fsGate(LINKED, 'sync');
    expect((await getShadowReport(LINKED)).total).toBe(10);

    await setMode(LINKED, 'connected');
    await setMode(LINKED, 'shadow');
    const report = await getShadowReport(LINKED);
    expect(report.total).toBe(0);
    expect(report.since).toEqual(expect.any(String));
    expect(report.since).not.toBe('2026-11-01T00:00:00.000Z');
  });

  test('staying in Shadow does not reset the counts', async () => {
    await setMode(LINKED, 'shadow');
    await fsGate(LINKED, 'sync');
    await setMode(LINKED, 'shadow', { note: 'again' });
    expect((await getShadowReport(LINKED)).counts.sync.n).toBe(1);
  });

  test('an unknown mode is refused', async () => {
    await expect(setMode(LINKED, 'paused')).rejects.toThrow(/Unknown FreshService mode/);
  });
});

describe('flushShadow', () => {
  test('merges the window into the stored counts and empties memory', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'shadow' }));
    store.set(shadowSettingKey(LINKED), JSON.stringify({
      since: '2026-11-25T08:00:00.000Z',
      counts: { sync: { n: 3, first: '2026-11-25T08:01:00.000Z', last: '2026-11-25T08:05:00.000Z' } },
    }));
    await fsGate(LINKED, 'sync');
    await fsGate(LINKED, 'deleted_check');
    await flushShadow();

    const stored = JSON.parse(store.get(shadowSettingKey(LINKED)));
    expect(stored.since).toBe('2026-11-25T08:00:00.000Z');
    expect(stored.counts.sync.n).toBe(4);
    expect(stored.counts.sync.first).toBe('2026-11-25T08:01:00.000Z'); // the first sighting is kept
    expect(stored.counts.sync.last).not.toBe('2026-11-25T08:05:00.000Z');
    expect(stored.counts.deleted_check.n).toBe(1);
    // Memory was emptied: the report is the stored numbers, not double.
    expect((await getShadowReport(LINKED)).total).toBe(5);
  });

  test('a write failure is logged, not thrown', async () => {
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'shadow' }));
    await fsGate(LINKED, 'sync');
    settingsMock.set.mockRejectedValueOnce(new Error('db down'));
    await expect(flushShadow()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Shadow flush failed'));
  });
});

describe('read errors fall back to connected', () => {
  test('a settings read error means connected, and is not cached', async () => {
    settingsMock.get.mockRejectedValueOnce(new Error('pool timeout'));
    settingsMock.get.mockRejectedValueOnce(new Error('pool timeout'));
    await expect(getMode(LINKED)).resolves.toBe('connected');
    await expect(fsGate(LINKED, 'sync')).resolves.toBe(true);
    expect((await getShadowReport(LINKED).catch(() => ({ total: 0 }))).total).toBe(0);
    // Next read sees the stored Off: the failure was not cached as connected.
    store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'off' }));
    await expect(getMode(LINKED)).resolves.toBe('off');
  });

  test('after a mode WAS read, a read error keeps it, even past the 30 s cache (logged)', async () => {
    const realNow = Date.now;
    let now = realNow();
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'off' }));
      await expect(getMode(LINKED)).resolves.toBe('off');
      now += 5 * 60 * 1000; // cache long expired
      settingsMock.get.mockRejectedValueOnce(new Error('pool timeout'));
      await expect(getMode(LINKED)).resolves.toBe('off');
      await expect(fsGate(LINKED, 'sync')).resolves.toBe(false);
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("kept the last mode read ('off')"));
    } finally {
      spy.mockRestore();
    }
  });

  test('a stored value that cannot be read keeps the last mode too', async () => {
    const realNow = Date.now;
    let now = realNow();
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'off' }));
      await getMode(LINKED);
      now += 60 * 1000;
      store.set(modeSettingKey(LINKED), '{half-written');
      await expect(getMode(LINKED)).resolves.toBe('off');
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
      // Once readable again (after the kept value's 30 s), the new value wins.
      now += 60 * 1000;
      store.set(modeSettingKey(LINKED), JSON.stringify({ mode: 'connected' }));
      await expect(getMode(LINKED)).resolves.toBe('connected');
    } finally {
      spy.mockRestore();
    }
  });

  test('a workspace-link read error keeps the last link answer (never connected stays off)', async () => {
    const realNow = Date.now;
    let now = realNow();
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(getMode(NATIVE)).resolves.toBe('never_connected');
      now += 5 * 60 * 1000;
      prismaMock.workspace.findUnique.mockRejectedValueOnce(new Error('pool timeout'));
      await expect(isFreshServiceOff(NATIVE)).resolves.toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('a workspace lookup error means linked (never "never connected")', async () => {
    prismaMock.workspace.findUnique.mockRejectedValue(new Error('pool timeout'));
    await expect(getMode(NATIVE)).resolves.toBe('connected');
    await expect(isFreshServiceOff(NATIVE)).resolves.toBe(false);
  });
});
