import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: { group: { findMany: jest.fn().mockResolvedValue([]) } },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { getFsGroups, pickHomeGroup, homeGroupsByTech, _resetFsGroupCache } = await import('../src/services/fsHomeGroupService.js');

const g = (fsId, name, members, active = true) => ({ fsId, name, active, members: new Set(members.map(String)) });
const GROUPS = [
  g('1', 'Everyone IT', [1, 2, 3, 4, 5, 6, 7, 8]),
  g('2', 'Coreshack', [50, 51, 52]),
  g('3', 'Digital', [50, 51, 52, 60, 61]),
  g('4', 'Retired', [50], false),
];

describe('pickHomeGroup', () => {
  test('outside the ticket group → their smallest active group', () => {
    expect(pickHomeGroup(GROUPS, 50, '1')).toEqual({ fsId: '2', name: 'Coreshack' });
  });
  test('already a member of the ticket group → no move', () => {
    expect(pickHomeGroup(GROUPS, 50, '3')).toBeNull();
  });
  test('no group on the ticket → no move', () => {
    expect(pickHomeGroup(GROUPS, 50, null)).toBeNull();
  });
  test('in no group at all, or no data → null', () => {
    expect(pickHomeGroup(GROUPS, 999, '1')).toBeNull();
    expect(pickHomeGroup(null, 50, '1')).toBeNull();
  });
});

describe('homeGroupsByTech', () => {
  test('maps technician id → group, skipping people without one', () => {
    const out = homeGroupsByTech(GROUPS, [{ id: 40, freshserviceId: BigInt(50) }, { id: 41, freshserviceId: 999 }, { id: 42 }]);
    expect(out).toEqual({ 40: { id: '2', name: 'Coreshack', memberOf: ['2', '3'] } });
  });
});

describe('getFsGroups', () => {
  beforeEach(() => _resetFsGroupCache());
  test('one FreshService call, then cached', async () => {
    const client = { listGroups: jest.fn().mockResolvedValue([{ id: 2, name: 'Coreshack', members: [50] }]) };
    const a = await getFsGroups(1, client);
    const b = await getFsGroups(1, client);
    expect(client.listGroups).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect([...a[0].members]).toEqual(['50']);
  });
  test('wait:false never blocks on a cold cache, and warms it', async () => {
    let release;
    const client = { listGroups: jest.fn(() => new Promise((r) => { release = r; })) };
    expect(await getFsGroups(1, client, { wait: false })).toBeNull();
    release([{ id: 2, name: 'Coreshack', members: [50] }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await getFsGroups(1, client, { wait: false })).toHaveLength(1);
  });
  test('a failure returns null instead of throwing', async () => {
    const client = { listGroups: jest.fn().mockRejectedValue(new Error('down')) };
    await expect(getFsGroups(1, client)).resolves.toBeNull();
  });
});
