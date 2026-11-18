import { jest } from '@jest/globals';

// QA 11-17 item 1: Time-zone fit's guard — settings, Shadow vs Live, locks.
const settingsStore = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => settingsStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { settingsStore.set(key, value); }),
};
const prismaMock = { ticket: { findUnique: jest.fn() } };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: service, settingsKey } = await import('../src/services/assignmentTimezoneFit/timezoneFitService.js');
const { levelNum } = await import('../src/services/assignmentLevelMatch/rules.js');

const NOW = new Date('2026-11-17T13:14:00Z');
const person = (techId, techName, timezone, level, score, rank) => ({
  techId, techName, timezone, rank, score, skill: { level, num: levelNum(level), priority: 2 },
  onLeave: false, onShift: false, rejectedThisTicket: false, routingNote: null, assignableOnly: false,
});
const CANDIDATES = [
  person(10, 'Eli Park', 'America/Vancouver', 'advanced', 0.8, 1),
  person(11, 'Priya Nair', 'America/Edmonton', 'advanced', 0.78, 2),
  person(14, 'Dana Fox', 'America/Toronto', 'intermediate', 0.66, 3),
];
const REC = { recommendations: [{ rank: 1, techId: 10 }, { rank: 2, techId: 11 }, { rank: 3, techId: 14 }] };
const SANTIAGO_REQUESTER = { requester: { entraCity: 'Santiago', entraCountry: 'Chile', entraState: null, entraOfficeLocation: null, timeZone: 'Pacific Time (US & Canada)' } };

beforeEach(() => {
  jest.restoreAllMocks();
  settingsStore.clear();
  service._reset();
  prismaMock.ticket.findUnique.mockResolvedValue(SANTIAGO_REQUESTER);
  jest.spyOn(service, 'loadCandidates').mockResolvedValue(CANDIDATES);
});

const run = (over = {}) => service.guard({ workspaceId: 1, ticketId: 900, runId: 1, techId: 10, decision: 'auto_assigned', recommendation: REC, now: NOW, ...over });

test('off by default: nothing at all', async () => {
  expect(settingsKey(1)).toBe('assignment_timezone_fit_ws1');
  expect(await run()).toBeNull();
  expect(service.loadCandidates).not.toHaveBeenCalled();
});

test('Shadow records the step and the sentence and keeps the assignee', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'shadow' }));
  const out = await run();
  expect(out).toMatchObject({ techId: 10, applied: false, moved: false, sentence: null });
  expect(out.record).toMatchObject({ mode: 'shadow', outcome: 'moved', from: { techId: 10 }, to: { techId: 14, techName: 'Dana Fox' } });
  expect(out.record.sentence).toMatch(/Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana would be put first/);
  expect(out.step).toMatchObject({ stepName: 'timezone_fit', output: { kind: 'timezone_fit', outcome: 'moved' } });
});

test('Live moves an automatic assignment to the closer person', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const out = await run();
  expect(out).toMatchObject({ techId: 14, applied: true, moved: true });
  expect(out.sentence).toMatch(/so Dana was put first\.$/);
});

test('Live never moves a locked pick, a suggest-only decision, or a dry-run pipeline', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const locked = await run({ locked: true });
  expect(locked).toMatchObject({ techId: 10, applied: false });
  expect(locked.record).toMatchObject({ mode: 'live', locked: true, notAppliedReason: 'an earlier rule chose the person' });
  const review = await run({ decision: 'pending_review' });
  expect(review.applied).toBe(false);
  expect(review.record).toMatchObject({ mode: 'live', notAppliedReason: 'the run waits for a person to decide' });
  const dry = await run({ dryRun: true });
  expect(dry).toMatchObject({ applied: false, techId: 10 });
  expect(dry.record).toMatchObject({ mode: 'shadow', notAppliedReason: null });
});

test('results: Live counts only the moves it made; Shadow days stay would-moves', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const row = (id, fit) => ({ run_id: id, ticket_id: id, created_at: NOW, timezone_fit: fit, subject: 'Blue screen', native_number: id, fs_id: null, origin: 'ticketpulse' });
  prismaMock.$queryRaw = jest.fn().mockResolvedValue([
    row(1, { mode: 'live', outcome: 'moved', applied: true, sentence: 'a' }),
    row(2, { mode: 'live', outcome: 'moved', applied: false, notAppliedReason: 'an earlier rule chose the person', sentence: 'b' }),
    row(3, { mode: 'shadow', outcome: 'moved', applied: false, sentence: 'c' }),
    row(4, { mode: 'live', outcome: 'close_enough', applied: false }),
  ]);
  const out = await service.results(1);
  expect(out.tally).toEqual({ total: 4, moved: 3, applied: 1 });
  expect(out.recentMoves.map((m) => [m.ref, m.mode, m.applied, m.notAppliedReason])).toEqual([
    ['TP-1', 'live', true, null],
    ['TP-2', 'live', false, 'an earlier rule chose the person'],
    ['TP-3', 'shadow', false, null],
  ]);
});

test('site work and the Pacific default never load anyone', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const site = await run({ siteBound: true });
  expect(site.record.outcome).toBe('site_bound');
  expect(site.step).toBeNull();
  prismaMock.ticket.findUnique.mockResolvedValue({ requester: { timeZone: 'Pacific Time (US & Canada)' } });
  const pacific = await run();
  expect(pacific.record.outcome).toBe('no_timezone');
  expect(service.loadCandidates).not.toHaveBeenCalled();
});

test('sandboxes and other decisions: nothing at all', async () => {
  settingsStore.set(settingsKey(7), JSON.stringify({ mode: 'live' }));
  expect(await run({ workspaceId: 7 })).toBeNull();
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  expect(await run({ decision: 'noise_dismissed' })).toBeNull();
});

test('any error leaves the assignment alone; unreadable settings count as off', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  service.loadCandidates.mockRejectedValue(new Error('db down'));
  expect(await run()).toBeNull();
  service._reset();
  settingsRepositoryMock.get.mockRejectedValueOnce(new Error('db down'));
  expect(await run()).toBeNull();
});

test('a requester lookup that fails is "no time zone", not an error', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'shadow' }));
  prismaMock.ticket.findUnique.mockRejectedValue(new Error('db down'));
  expect((await run()).record.outcome).toBe('no_timezone');
});

test('saveSettings validates and keeps a history line', async () => {
  const bad = await service.saveSettings(1, { mode: 'maybe' }, { by: 'Dana Fox' });
  expect(bad.errors.length).toBe(1);
  const ok = await service.saveSettings(1, { mode: 'shadow' }, { by: 'Dana Fox' });
  expect(ok.settings.mode).toBe('shadow');
  expect(JSON.parse(settingsStore.get('assignment_timezone_fit_ws1')).history[0]).toMatchObject({ by: 'Dana Fox' });
});
