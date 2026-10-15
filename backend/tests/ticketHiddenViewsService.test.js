import { jest } from '@jest/globals';

/**
 * QA 10-14 #1: an admin hides Verified solutions, Scheduled, Grouped, Parked
 * and Auto-help waiting per workspace. Stored per workspace; [] = every view.
 */
const store = new Map();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    get: jest.fn(async (k) => store.get(k) ?? null),
    set: jest.fn(async (k, v) => { store.set(k, v); }),
  },
}));

const { default: svc, hiddenViewsKey, HIDEABLE_VIEWS } = await import('../src/services/ticketHiddenViewsService.js');

describe('ticketHiddenViewsService', () => {
  beforeEach(() => store.clear());

  test('absent = every view shows', async () => {
    await expect(svc.get(5)).resolves.toEqual([]);
  });

  test('round-trips per workspace, in the rail order, without repeats', async () => {
    await expect(svc.set(5, ['parked', 'solutions', 'parked'])).resolves.toEqual(['solutions', 'parked']);
    await expect(svc.get(5)).resolves.toEqual(['solutions', 'parked']);
    await expect(svc.get(1)).resolves.toEqual([]);
    expect(store.get(hiddenViewsKey(5))).toBe('["solutions","parked"]');
  });

  test('only the five feature views can be hidden', async () => {
    expect(HIDEABLE_VIEWS).toEqual(['solutions', 'scheduled', 'grouped', 'parked', 'auto_help_waiting']);
    await expect(svc.set(5, ['all'])).rejects.toThrow(/cannot be hidden: all/);
    await expect(svc.set(5, 'parked')).rejects.toThrow(/array/);
  });

  test('bad stored JSON or an unknown key reads as nothing hidden, never throws', async () => {
    store.set(hiddenViewsKey(5), '{not json');
    await expect(svc.get(5)).resolves.toEqual([]);
    store.set(hiddenViewsKey(5), '["grouped","mine"]');
    await expect(svc.get(5)).resolves.toEqual(['grouped']);
  });
});
