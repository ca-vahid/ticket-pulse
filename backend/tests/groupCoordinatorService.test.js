import { jest } from '@jest/globals';

/**
 * Group coordinators (QA 10-14): a coordinator and a backup per group, kept in
 * app_settings as JSON per workspace; validation; the audit line; the order
 * the resolver walks (group coordinator at work → backup at work → workspace
 * coordinator → nobody); and "none set" whenever the row is missing or bad.
 */
let stored = {};
const settingsRepoMock = {
  get: jest.fn(async (key) => stored[key] ?? null),
  set: jest.fn(async (key, value) => { stored[key] = value; }),
};
const prismaMock = {
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findMany: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepoMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const {
  default: service, parseStored, validateEntry, pickCoordinator, pickWorkspaceCoordinator, settingsKey,
} = await import('../src/services/groupCoordinatorService.js');

const KEY = settingsKey(1);
const ACTOR = { email: 'vhaeri@example.com', name: 'Dana Whitfield' };
const TEAM = {
  11: { id: 11, name: 'Priya Nair', isActive: true },
  22: { id: 22, name: 'Sam Okafor', isActive: true },
  33: { id: 33, name: 'Dana Whitfield', isActive: true },
  44: { id: 44, name: 'Old Timer', isActive: false },
};
const AT_WORK = { atWork: true, reason: 'at_work' };
const ON_LEAVE = { atWork: false, reason: 'on_leave', nextStartLocal: null };
const LATER = { atWork: false, reason: 'before_shift', nextStartLocal: '13:00' };

beforeEach(() => {
  jest.clearAllMocks();
  stored = {};
  prismaMock.group.findFirst.mockImplementation(async ({ where }) => (where.id === 8 && where.workspaceId === 1 ? { id: 8, name: 'Service Desk' } : null));
  prismaMock.group.findMany.mockResolvedValue([{ id: 8, name: 'Service Desk', isActive: true }]);
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => Object.values(TEAM)
    .filter((t) => where.id.in.includes(t.id) && (where.isActive === undefined || t.isActive === where.isActive))
    .map((t) => ({ ...t })));
});

describe('reading', () => {
  test('a missing row, bad JSON, a non-object or a failing read is "none set"', async () => {
    expect(await service.getAll(1)).toEqual({});
    stored[KEY] = '{not json';
    expect(await service.getAll(1)).toEqual({});
    stored[KEY] = '[1,2]';
    expect(await service.getAll(1)).toEqual({});
    settingsRepoMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await service.getAll(1)).toEqual({});
    expect(await service.getForGroup(1, 8)).toMatchObject({ coordinatorTechnicianId: null, backupTechnicianId: null });
  });

  test('parseStored keeps valid group ids and people only', () => {
    expect(parseStored(JSON.stringify({
      8: { coordinatorTechnicianId: 11, backupTechnicianId: '22' },
      9: { coordinatorTechnicianId: 'x', backupTechnicianId: null },
      abc: { coordinatorTechnicianId: 11 },
      10: null,
    }))).toEqual({ 8: { coordinatorTechnicianId: 11, backupTechnicianId: 22, updatedBy: null, updatedAt: null } });
  });
});

describe('validating', () => {
  const active = new Set([11, 22]);
  test.each([
    [{ coordinatorTechnicianId: 11, backupTechnicianId: 22 }, []],
    [{ coordinatorTechnicianId: null, backupTechnicianId: null }, []],
    [{ coordinatorTechnicianId: 11, backupTechnicianId: 11 }, ['The backup must be a different person from the coordinator']],
    [{ coordinatorTechnicianId: null, backupTechnicianId: 22 }, ['Pick a coordinator before a backup']],
    [{ coordinatorTechnicianId: 44, backupTechnicianId: null }, ['Coordinator: pick an active technician of this workspace']],
    [{ coordinatorTechnicianId: 11, backupTechnicianId: 99 }, ['Backup: pick an active technician of this workspace']],
    [{ coordinatorTechnicianId: 'abc', backupTechnicianId: -1 }, ['The coordinator is not valid', 'The backup is not valid']],
  ])('%j → %j', (input, errors) => {
    expect(validateEntry(input, { activeIds: active })).toEqual(errors);
  });
});

describe('saving', () => {
  test('saves the entry as JSON with who and when, and writes one audit line', async () => {
    const now = new Date('2026-10-14T17:00:00Z');
    const out = await service.setForGroup(1, 8, { coordinatorTechnicianId: 11, backupTechnicianId: 22 }, ACTOR, { now });
    expect(out).toEqual({ groupId: 8, coordinatorTechnicianId: 11, backupTechnicianId: 22, changed: true });
    expect(JSON.parse(stored[KEY])).toEqual({ 8: { coordinatorTechnicianId: 11, backupTechnicianId: 22, updatedBy: 'vhaeri@example.com', updatedAt: now.toISOString() } });
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Group coordinators ws 1 changed by vhaeri@example.com: group 8 (Service Desk) coordinator none → 11, backup none → 22',
      expect.objectContaining({ workspaceId: 1, groupId: 8, after: { coordinatorTechnicianId: 11, backupTechnicianId: 22 } }),
    );
    expect(await service.getForGroup(1, 8)).toMatchObject({ coordinatorTechnicianId: 11, backupTechnicianId: 22 });
  });

  test('saving the same again changes nothing; clearing both removes the group', async () => {
    stored[KEY] = JSON.stringify({ 8: { coordinatorTechnicianId: 11, backupTechnicianId: null }, 9: { coordinatorTechnicianId: 22, backupTechnicianId: null } });
    expect((await service.setForGroup(1, 8, { coordinatorTechnicianId: 11 }, ACTOR)).changed).toBe(false);
    expect(settingsRepoMock.set).not.toHaveBeenCalled();
    await service.setForGroup(1, 8, { coordinatorTechnicianId: null, backupTechnicianId: null }, ACTOR);
    expect(Object.keys(JSON.parse(stored[KEY]))).toEqual(['9']);
  });

  test('a group of another workspace is not found; people must be active technicians here; nothing is written', async () => {
    await expect(service.setForGroup(2, 8, { coordinatorTechnicianId: 11 }, ACTOR)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.setForGroup(1, 8, { coordinatorTechnicianId: 44 }, ACTOR)).rejects.toMatchObject({ statusCode: 400, message: 'Coordinator: pick an active technician of this workspace' });
    await expect(service.setForGroup(1, 8, { coordinatorTechnicianId: 11, backupTechnicianId: 11 }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.setForGroup(1, 'x', { coordinatorTechnicianId: 11 }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    expect(settingsRepoMock.set).not.toHaveBeenCalled();
  });

  test('listWithNames: the groups with somebody set, with names; a gone group is left out', async () => {
    stored[KEY] = JSON.stringify({ 8: { coordinatorTechnicianId: 11, backupTechnicianId: 22 }, 99: { coordinatorTechnicianId: 33 } });
    expect(await service.listWithNames(1)).toEqual([{
      groupId: 8,
      groupName: 'Service Desk',
      groupActive: true,
      coordinator: { id: 11, name: 'Priya Nair', isActive: true },
      backup: { id: 22, name: 'Sam Okafor', isActive: true },
    }]);
    stored[KEY] = null;
    expect(await service.listWithNames(1)).toEqual([]);
  });
});

describe('who is the coordinator', () => {
  const GROUP = { id: 8, name: 'Service Desk' };
  const resolve = (states, { entry = { coordinatorTechnicianId: 11, backupTechnicianId: 22 }, workspaceCoordinatorId = 33, groupId = 8 } = {}) => {
    stored[KEY] = JSON.stringify(entry ? { 8: entry } : {});
    return service.resolveCoordinator({
      workspaceId: 1,
      groupId,
      at: new Date('2026-10-14T17:00:00Z'),
      personOf: async (id) => (TEAM[id] ? { ...TEAM[id] } : null),
      stateOf: (person) => states[person.id] || AT_WORK,
      workspaceCoordinatorId,
    });
  };

  test('the group coordinator, when at work', async () => {
    expect(await resolve({})).toMatchObject({ technicianId: 11, source: 'group', groupId: 8, groupName: 'Service Desk', awayNote: null, reason: "Priya Nair is the Service Desk group's coordinator and is at work" });
  });

  test('coordinator away → the backup, with why', async () => {
    expect(await resolve({ 11: ON_LEAVE })).toMatchObject({ technicianId: 22, source: 'group_backup', awayNote: 'Priya is on leave' });
    expect((await resolve({ 11: LATER })).awayNote).toBe('Priya starts at 13:00');
  });

  test('both away → the workspace coordinator (who need not be at work)', async () => {
    const out = await resolve({ 11: ON_LEAVE, 22: LATER, 33: ON_LEAVE });
    expect(out).toMatchObject({ technicianId: 33, source: 'workspace', awayNote: 'Priya and Sam are away' });
    expect(out.reason).toContain('the workspace coordinator Dana Whitfield is used');
  });

  test('both away and no workspace coordinator → nobody', async () => {
    expect(await resolve({ 11: ON_LEAVE, 22: ON_LEAVE }, { workspaceCoordinatorId: null })).toMatchObject({ technicianId: null, source: null, awayNote: 'Priya and Sam are away' });
  });

  test('nothing set anywhere → nobody; no group → the workspace coordinator', async () => {
    expect(await resolve({}, { entry: null, workspaceCoordinatorId: null })).toMatchObject({ technicianId: null, source: null, awayNote: null });
    expect(await resolve({}, { groupId: null })).toMatchObject({ technicianId: 33, source: 'workspace', awayNote: null, reason: 'the ticket has no group; the workspace coordinator Dana Whitfield is used' });
  });

  test('an inactive group coordinator is passed over; an inactive workspace coordinator is not used', async () => {
    expect(await resolve({}, { entry: { coordinatorTechnicianId: 44, backupTechnicianId: 22 } })).toMatchObject({ technicianId: 22, source: 'group_backup', awayNote: 'Old is not at work' });
    expect(await resolve({}, { entry: null, workspaceCoordinatorId: 44 })).toMatchObject({ technicianId: null, source: null });
  });

  test('a failing read never throws: nobody, and a warning', async () => {
    stored[KEY] = JSON.stringify({ 8: { coordinatorTechnicianId: 11 } });
    const out = await service.resolveCoordinator({
      workspaceId: 1, groupId: 8, personOf: async () => { throw new Error('boom'); }, stateOf: () => AT_WORK, workspaceCoordinatorId: 33, group: GROUP,
    });
    expect(out).toMatchObject({ technicianId: null, source: null });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  describe('workspace coordinators (QA 10-15): up to three, in order', () => {
    const list = (states, technicianIds, { mode = 'first_available', entry = null, groupId = 8 } = {}) => {
      stored[KEY] = JSON.stringify(entry ? { 8: entry } : {});
      return service.resolveCoordinator({
        workspaceId: 1,
        groupId,
        at: new Date('2026-10-15T17:00:00Z'),
        personOf: async (id) => (TEAM[id] ? { ...TEAM[id] } : null),
        stateOf: (person) => states[person.id] || AT_WORK,
        workspaceCoordinators: { technicianIds, mode },
      });
    };

    test('first available: the first one in list order who is at work owns it, and only they are told', async () => {
      const out = await list({ 11: ON_LEAVE }, [11, 22, 33]);
      expect(out).toMatchObject({ technicianId: 22, source: 'workspace', notify: [22], ownerAway: false, mode: 'first_available' });
      expect(out.reason).toContain('the workspace coordinator Sam Okafor is used');
      expect(out.reason).toContain('Priya is on leave (passed over)');
      expect((await list({}, [33, 11])).technicianId).toBe(33);
    });

    test('nobody on the list is at work: the first active one still owns it, marked away', async () => {
      const out = await list({ 11: ON_LEAVE, 22: LATER, 33: ON_LEAVE }, [44, 11, 22]);
      expect(out).toMatchObject({ technicianId: 11, source: 'workspace', notify: [11], ownerAway: true });
      expect(out.reason).toContain('nobody on the list is at work, so the first one still owns it: Priya is on leave');
    });

    test('all: everyone active on the list is told; the first one at work owns it', async () => {
      const out = await list({ 11: LATER }, [11, 44, 22, 33], { mode: 'all' });
      expect(out).toMatchObject({ technicianId: 22, notify: [22, 11, 33], ownerAway: false, mode: 'all' });
      expect(out.reason).toContain('all 3 workspace coordinators are told');
      // Nobody at work: the first active one owns it, everyone is still told.
      expect(await list({ 11: ON_LEAVE, 22: ON_LEAVE }, [11, 22], { mode: 'all' })).toMatchObject({ technicianId: 11, notify: [11, 22], ownerAway: true });
    });

    test("the group's own coordinator or backup at work still wins, and only they are told", async () => {
      expect(await list({}, [33], { mode: 'all', entry: { coordinatorTechnicianId: 11, backupTechnicianId: 22 } }))
        .toMatchObject({ technicianId: 11, source: 'group', notify: [11], ownerAway: false });
      expect(await list({ 11: ON_LEAVE }, [33], { mode: 'all', entry: { coordinatorTechnicianId: 11, backupTechnicianId: 22 } }))
        .toMatchObject({ technicianId: 22, source: 'group_backup', notify: [22] });
      expect(await list({ 11: ON_LEAVE, 22: ON_LEAVE }, [33, 11], { mode: 'all', entry: { coordinatorTechnicianId: 11, backupTechnicianId: 22 } }))
        .toMatchObject({ technicianId: 33, source: 'workspace', awayNote: 'Priya and Sam are away', notify: [33, 11] });
    });

    test('an empty or all-inactive list is nobody', async () => {
      expect(await list({}, [])).toMatchObject({ technicianId: null, source: null, notify: [] });
      expect(await list({}, [44])).toMatchObject({ technicianId: null, reason: expect.stringContaining('the workspace coordinator is not active') });
      expect(await list({}, [99])).toMatchObject({ technicianId: null, reason: expect.stringContaining('no workspace coordinator is set') });
    });

    test('the old single coordinator id still works as a one-person list', async () => {
      stored[KEY] = JSON.stringify({});
      const out = await service.resolveCoordinator({
        workspaceId: 1, groupId: null, personOf: async (id) => ({ ...TEAM[id] }), stateOf: () => LATER, workspaceCoordinatorId: 33,
      });
      expect(out).toMatchObject({ technicianId: 33, source: 'workspace', notify: [33], ownerAway: true });
    });

    test('pickWorkspaceCoordinator is pure; a person with no state counts as at work', () => {
      expect(pickWorkspaceCoordinator([{ person: TEAM[22], state: null }, { person: TEAM[11], state: AT_WORK }], 'all'))
        .toMatchObject({ person: TEAM[22], notify: [22, 11], ownerAway: false });
      expect(pickWorkspaceCoordinator([], 'all')).toBeNull();
    });
  });

  test('pickCoordinator is pure: the same answer from the same facts', () => {
    const facts = {
      entry: { coordinatorTechnicianId: 11, backupTechnicianId: 22 }, group: GROUP, coordinator: TEAM[11], coordinatorState: ON_LEAVE, backup: TEAM[22], backupState: AT_WORK, workspaceCoordinator: TEAM[33],
    };
    expect(pickCoordinator(facts)).toEqual(pickCoordinator(facts));
    expect(pickCoordinator(facts).source).toBe('group_backup');
  });
});
