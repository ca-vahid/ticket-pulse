import { jest } from '@jest/globals';

const settingsStore = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => settingsStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { settingsStore.set(key, value); }),
};
const prismaMock = {};
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: service, settingsKey } = await import('../src/services/assignmentLevelMatch/levelMatchService.js');
const { levelNum } = await import('../src/services/assignmentLevelMatch/rules.js');

const person = (techId, techName, level, today, open, rank) => ({
  techId, techName, rank, today, open, skill: { level, num: levelNum(level), priority: 2 },
  onLeave: false, onShift: true, rejectedThisTicket: false, routingNote: null,
});
const CANDIDATES = [person(4, 'Alexey Lavrenyuk', 'expert', 6, 20, 1), person(56, 'Soheil Nasiri', 'advanced', 1, 15, 2)];
const REC = { requiredLevel: 'basic', requiredLevelReason: 'Add a Claude seat', recommendations: [{ rank: 1, techId: 4 }, { rank: 2, techId: 56 }] };

beforeEach(() => {
  jest.restoreAllMocks();
  settingsStore.clear();
  service._reset();
  jest.spyOn(service, 'loadCandidates').mockResolvedValue(CANDIDATES);
});

const run = (over = {}) => service.guard({ workspaceId: 1, ticketId: 900, runId: 1, techId: 4, decision: 'auto_assigned', recommendation: REC, ...over });

test('IT starts in Shadow: records who it would pick, changes nothing', async () => {
  const out = await run();
  expect(out).toMatchObject({ techId: 4, applied: false, moved: false, sentence: null });
  expect(out.record).toMatchObject({ mode: 'shadow', outcome: 'moved', requiredLevel: 'basic', requiredLevelReason: 'Add a Claude seat', to: { techId: 56 } });
  expect(out.step).toMatchObject({ stepName: 'level_match', output: { kind: 'level_match' } });
});

test('Live gives the ticket to the qualified person with the lighter day', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const out = await run();
  expect(out).toMatchObject({ techId: 56, applied: true, moved: true });
  expect(out.sentence).toMatch(/Soheil Nasiri/);
});

test('Live still never moves a locked pick, a suggest-only decision, or a dry-run pipeline', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  expect((await run({ locked: true })).applied).toBe(false);
  expect((await run({ decision: 'pending_review' })).applied).toBe(false);
  const dry = await run({ dryRun: true });
  expect(dry).toMatchObject({ applied: false, techId: 4 });
  expect(dry.record.mode).toBe('shadow');
});

test('off, sandboxes and other decisions: nothing at all', async () => {
  expect(await run({ workspaceId: 2 })).toBeNull();
  expect(await run({ workspaceId: 7 })).toBeNull();
  expect(await run({ decision: 'noise_dismissed' })).toBeNull();
});

test('no level from the AI: recorded as no_level, nobody loaded', async () => {
  const out = await run({ recommendation: { ...REC, requiredLevel: undefined } });
  expect(out.record.outcome).toBe('no_level');
  expect(service.loadCandidates).not.toHaveBeenCalled();
  expect(out.step).toBeNull();
});

test('any error leaves the assignment alone', async () => {
  service.loadCandidates.mockRejectedValue(new Error('db down'));
  expect(await run()).toBeNull();
});

test('unreadable settings count as off, never as the IT default', async () => {
  settingsRepositoryMock.get.mockRejectedValueOnce(new Error('db down'));
  expect(await run()).toBeNull();
});

test('saveSettings validates and keeps a history line', async () => {
  const bad = await service.saveSettings(1, { mode: 'maybe' }, { by: 'Vahid' });
  expect(bad.errors.length).toBe(1);
  const ok = await service.saveSettings(1, { mode: 'live' }, { by: 'Vahid' });
  expect(ok.settings.mode).toBe('live');
  expect(JSON.parse(settingsStore.get(settingsKey(1))).history[0]).toMatchObject({ by: 'Vahid' });
  expect(await service.isActive(1)).toBe(true);
  expect(await service.isActive(8)).toBe(false);
});
