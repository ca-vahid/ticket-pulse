import { jest } from '@jest/globals';

/**
 * Workspace coordinators (QA 10-15, item 9): up to three people and how they
 * are used, kept in app_settings as JSON per workspace. Validation (repeats
 * dropped, at most three, active technicians of the workspace only), the old
 * single coordinator as the fallback, and "never saved" whenever the row is
 * missing or bad.
 */
let stored = {};
let legacyRow = null;
const settingsRepoMock = {
  get: jest.fn(async (key) => stored[key] ?? null),
  set: jest.fn(async (key, value) => { stored[key] = value; }),
};
const prismaMock = {
  technician: { findMany: jest.fn() },
  urgentResponseSettings: {
    findUnique: jest.fn(async () => legacyRow),
    updateMany: jest.fn(async ({ data }) => { if (legacyRow) Object.assign(legacyRow, data); return { count: legacyRow ? 1 : 0 }; }),
  },
  urgentResponseSettingsChange: { create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepoMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const {
  default: service, parseStored, validateCoordinators, settingsKey, MAX_COORDINATORS,
} = await import('../src/services/workspaceCoordinatorService.js');

const KEY = settingsKey(1);
const ACTOR = { email: 'dana@example.com', name: 'Dana Whitfield' };
// Priya (11), Sam (22) and Dana (33) are active in workspace 1; 44 left; 55 is another workspace's.
const TEAM = [
  { id: 11, workspaceId: 1, isActive: true },
  { id: 22, workspaceId: 1, isActive: true },
  { id: 33, workspaceId: 1, isActive: true },
  { id: 44, workspaceId: 1, isActive: false },
  { id: 55, workspaceId: 2, isActive: true },
  { id: 66, workspaceId: 1, isActive: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  stored = {};
  legacyRow = null;
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => TEAM
    .filter((t) => where.id.in.includes(t.id) && t.workspaceId === where.workspaceId && t.isActive === where.isActive)
    .map(({ id }) => ({ id })));
});

describe('reading', () => {
  test('a missing row, bad JSON, a non-object or a failing read is "never saved"', async () => {
    expect(await service.get(1)).toBeNull();
    stored[KEY] = '{not json';
    expect(await service.get(1)).toBeNull();
    stored[KEY] = '[1,2]';
    expect(await service.get(1)).toBeNull();
    settingsRepoMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await service.get(1)).toBeNull();
  });

  test('parseStored keeps valid ids only, once each, at most three, and a known mode', () => {
    expect(parseStored(JSON.stringify({ technicianIds: [11, '22', 11, 'x', -1, 33, 66], mode: 'loud' }))).toEqual({
      technicianIds: [11, 22, 33], mode: 'first_available', updatedBy: null, updatedAt: null,
    });
    expect(parseStored({ technicianIds: [22], mode: 'all', updatedBy: 'dana@example.com' })).toMatchObject({ technicianIds: [22], mode: 'all', updatedBy: 'dana@example.com' });
  });

  test('nothing saved: the old single coordinator is the list, so nothing is lost', async () => {
    legacyRow = { coordinatorTechnicianId: 33 };
    expect(await service.getEffective(1)).toMatchObject({ technicianIds: [33], mode: 'first_available', fromLegacy: true, saved: false });
    // The engine passes the value it already has.
    expect(await service.getEffective(1, { legacyId: 22 })).toMatchObject({ technicianIds: [22], fromLegacy: true });
    expect(prismaMock.urgentResponseSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(await service.getEffective(1, { legacyId: null })).toMatchObject({ technicianIds: [], fromLegacy: false });
  });

  test('a saved list wins over the old coordinator; a missing settings table reads as none', async () => {
    stored[KEY] = JSON.stringify({ technicianIds: [22, 11], mode: 'all' });
    legacyRow = { coordinatorTechnicianId: 33 };
    expect(await service.getEffective(1)).toMatchObject({ technicianIds: [22, 11], mode: 'all', fromLegacy: false, saved: true });
    stored[KEY] = null;
    prismaMock.urgentResponseSettings.findUnique.mockRejectedValueOnce(new Error('relation does not exist'));
    expect(await service.getEffective(1)).toMatchObject({ technicianIds: [], fromLegacy: false, saved: false });
  });
});

describe('validating', () => {
  const active = new Set([11, 22, 33, 66]);
  test.each([
    [{ technicianIds: [11, 22], mode: 'all' }, { technicianIds: [11, 22], mode: 'all' }, []],
    [{ technicianIds: [] }, { technicianIds: [], mode: 'first_available' }, []],
    [{}, { technicianIds: [], mode: 'first_available' }, []],
    [{ technicianIds: [22, 11, 22, '11'] }, { technicianIds: [22, 11], mode: 'first_available' }, []],
    [{ technicianIds: [11, 22, 33, 66] }, { technicianIds: [11, 22, 33, 66], mode: 'first_available' }, ['Pick at most three coordinators']],
    [{ technicianIds: [11, 44] }, { technicianIds: [11, 44], mode: 'first_available' }, ['Coordinators: pick active technicians of this workspace']],
    [{ technicianIds: [11, 'abc'] }, { technicianIds: [11], mode: 'first_available' }, ['A coordinator is not valid']],
    [{ technicianIds: 11 }, { technicianIds: [], mode: 'first_available' }, ['The coordinators must be a list of people']],
    [{ technicianIds: [11], mode: 'loud' }, { technicianIds: [11], mode: 'loud' }, ['Pick how the coordinators are used']],
  ])('%j → %j %j', (input, value, errors) => {
    expect(validateCoordinators(input, { activeIds: active })).toEqual({ value, errors });
  });

  test('three is the most', () => {
    expect(MAX_COORDINATORS).toBe(3);
  });
});

describe('saving', () => {
  test('saves the list with who and when, one change row and one audit line', async () => {
    const now = new Date('2026-10-15T17:00:00Z');
    const out = await service.set(1, { technicianIds: [22, 11, 22], mode: 'all' }, ACTOR, { now });
    expect(out).toMatchObject({ technicianIds: [22, 11], mode: 'all', changed: true, fromLegacy: false, saved: true });
    expect(JSON.parse(stored[KEY])).toEqual({ technicianIds: [22, 11], mode: 'all', updatedBy: 'dana@example.com', updatedAt: now.toISOString() });
    expect(prismaMock.urgentResponseSettingsChange.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 1, changedBy: 'dana@example.com', changedByName: 'Dana Whitfield', field: 'coordinators',
        before: { technicianIds: [], mode: 'first_available' }, after: { technicianIds: [22, 11], mode: 'all' },
      },
    });
    expect(loggerMock.info).toHaveBeenCalledWith('Workspace coordinators ws 1 changed by dana@example.com: [none] first_available → [22, 11] all', expect.anything());
  });

  test('the same list again changes nothing', async () => {
    stored[KEY] = JSON.stringify({ technicianIds: [11], mode: 'first_available' });
    expect((await service.set(1, { technicianIds: [11] }, ACTOR)).changed).toBe(false);
    expect(settingsRepoMock.set).not.toHaveBeenCalled();
  });

  test('inactive people, people of another workspace, more than three: refused, nothing written', async () => {
    await expect(service.set(1, { technicianIds: [11, 44] }, ACTOR)).rejects.toMatchObject({ statusCode: 400, message: 'Coordinators: pick active technicians of this workspace' });
    await expect(service.set(1, { technicianIds: [55] }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.set(1, { technicianIds: [11, 22, 33, 66] }, ACTOR)).rejects.toMatchObject({ statusCode: 400, message: 'Pick at most three coordinators' });
    await expect(service.set(1, { technicianIds: [11], mode: 'sometimes' }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    expect(settingsRepoMock.set).not.toHaveBeenCalled();
  });

  test('saving the old coordinator as a list keeps the old column; clearing the list clears it too', async () => {
    legacyRow = { coordinatorTechnicianId: 33 };
    await service.set(1, { technicianIds: [33, 11] }, ACTOR);
    expect(legacyRow.coordinatorTechnicianId).toBe(33);
    expect(await service.getEffective(1)).toMatchObject({ technicianIds: [33, 11], fromLegacy: false });

    stored[KEY] = null;
    await service.set(1, { technicianIds: [] }, ACTOR);
    expect(legacyRow.coordinatorTechnicianId).toBeNull();
    expect(await service.getEffective(1)).toMatchObject({ technicianIds: [], fromLegacy: false, saved: true });
  });
});
