import { jest } from '@jest/globals';

/**
 * QA 11-23 items 1–3 through the Level match service: the shared "today"
 * count reaches the rule, the skill name reaches the sentence, and a kept
 * pick records why (`recommendation.levelMatch.skipReason`).
 */
const settingsStore = new Map();
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  competencyCategory: { findUnique: jest.fn(), findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  ticket: { groupBy: jest.fn(), findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => settingsStore.get(k) ?? null), set: jest.fn() },
}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({ openWorkloadStatuses: jest.fn(async () => ['Open', 'Pending']) }));

const { default: service, settingsKey } = await import('../src/services/assignmentLevelMatch/levelMatchService.js');

const DANA = 11;
const ELI = 12;
const NOW = new Date('2026-11-23T17:47:00.000Z'); // 9:47 AM Pacific, a Monday
const at = (hhmm) => new Date(`2026-11-23T${hhmm}:00.000-08:00`);
const REC = {
  requiredLevel: 'basic', internalCategoryId: 10, internalSubcategoryId: 101,
  recommendations: [{ rank: 1, techId: DANA, techName: 'Dana Fox', score: 0.8 }, { rank: 4, techId: ELI, techName: 'Eli Park', score: 0.68 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  settingsStore.clear();
  service._reset();
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 10, name: 'Collaboration' }, { id: 101, name: 'Teams' }]);
  prismaMock.technician.findMany.mockResolvedValue([
    { id: DANA, name: 'Dana Fox', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '17:00' },
    { id: ELI, name: 'Eli Park', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '17:00' },
  ]);
  prismaMock.technicianCompetency.findMany.mockResolvedValue([
    { technicianId: DANA, competencyCategoryId: 101, proficiencyLevel: 'advanced' },
    { technicianId: ELI, competencyCategoryId: 101, proficiencyLevel: 'advanced' },
  ]);
  // Today: Dana 4 tickets (one came back twice), Eli 3. The rejections query (endMethod) gets none.
  prismaMock.ticketAssignmentEpisode.findMany.mockImplementation(async ({ where }) => (where?.startedAt ? [
    { technicianId: DANA, ticketId: 1, startedAt: at('08:01') },
    { technicianId: DANA, ticketId: 2, startedAt: at('08:20') },
    { technicianId: DANA, ticketId: 2, startedAt: at('09:00') },
    { technicianId: DANA, ticketId: 3, startedAt: at('09:10') },
    { technicianId: DANA, ticketId: 4, startedAt: at('09:30') },
    { technicianId: ELI, ticketId: 5, startedAt: at('08:05') },
    { technicianId: ELI, ticketId: 6, startedAt: at('08:40') },
    { technicianId: ELI, ticketId: 7, startedAt: at('09:20') },
  ] : []));
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.groupBy.mockResolvedValue([{ assignedTechId: DANA, _count: { _all: 13 } }, { assignedTechId: ELI, _count: { _all: 22 } }]);
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
});

test('loadCandidates: "today" is tickets given today, once each; the skill carries its name', async () => {
  const list = await service.loadCandidates({ workspaceId: 1, ticketId: 900, recommendation: REC, now: NOW });
  const byId = new Map(list.map((c) => [c.techId, c]));
  expect(byId.get(DANA)).toMatchObject({ today: 4, open: 13, skill: { level: 'advanced', name: 'Teams', priority: 2 } });
  expect(byId.get(ELI)).toMatchObject({ today: 3, open: 22 });
});

test('a site visit (OTHER, "Site visit") is not away; physio still is (25 Nov 2026)', async () => {
  prismaMock.technicianLeave.findMany.mockResolvedValue([
    { technicianId: DANA, category: 'OTHER', leaveTypeName: 'Site Visit' },
    { technicianId: ELI, category: 'OTHER', leaveTypeName: 'Physio' },
  ]);
  const list = await service.loadCandidates({ workspaceId: 1, ticketId: 900, recommendation: REC, now: NOW });
  const byId = new Map(list.map((c) => [c.techId, c]));
  expect(byId.get(DANA).onLeave).toBe(false);
  expect(byId.get(ELI).onLeave).toBe(true);
  expect(prismaMock.technicianLeave.findMany.mock.calls[0][0].select).toMatchObject({ category: true, leaveTypeName: true });
});

test('the TP-1042 shape is kept with the AI pick and the run says why', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  const out = await service.guard({ workspaceId: 1, ticketId: 900, runId: 1, techId: DANA, decision: 'auto_assigned', recommendation: REC, now: NOW });
  expect(out).toMatchObject({ techId: DANA, applied: false, moved: false, step: null });
  expect(out.record).toMatchObject({
    outcome: 'kept',
    skipReason: 'kept: Eli Park has 9 more open tickets and only 1 fewer today',
    skipped: [expect.objectContaining({ techId: ELI, openMore: 9, todayFewer: 1 })],
    sentence: 'Needs basic; kept with Dana Fox: Eli Park has 9 more open tickets and only 1 fewer today.',
  });
});

test('a move records its real reason and sentence', async () => {
  settingsStore.set(settingsKey(1), JSON.stringify({ mode: 'live' }));
  prismaMock.ticket.groupBy.mockResolvedValue([{ assignedTechId: DANA, _count: { _all: 13 } }, { assignedTechId: ELI, _count: { _all: 15 } }]);
  const out = await service.guard({ workspaceId: 1, ticketId: 900, runId: 1, techId: DANA, decision: 'auto_assigned', recommendation: REC, now: NOW });
  expect(out).toMatchObject({ techId: ELI, applied: true });
  expect(out.record).toMatchObject({ outcome: 'moved', moveReason: 'lighter_day', skipReason: null });
  expect(out.sentence).toBe('Lighter day: Eli Park (3 today) instead of Dana Fox (4 today). Both advanced in Teams; Eli Park has 15 open, Dana Fox 13.');
  expect(out.step.output).toMatchObject({ kind: 'level_match', moveReason: 'lighter_day', sentence: out.sentence });
});
