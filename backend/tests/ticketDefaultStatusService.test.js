import { jest } from '@jest/globals';

/**
 * QA 09-23 #4: Project Accounting opens the list on Open + Pending; IT on
 * every status. Stored per workspace; [] = every status.
 */
const store = new Map();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    get: jest.fn(async (k) => store.get(k) ?? null),
    set: jest.fn(async (k, v) => { store.set(k, v); }),
  },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    listStatuses: jest.fn(async () => ['Open', 'Pending', 'Pending Response', 'Resolved', 'Closed'].map((name) => ({ name }))),
  },
}));

const { default: svc, defaultStatusesKey } = await import('../src/services/ticketDefaultStatusService.js');

describe('ticketDefaultStatusService', () => {
  beforeEach(() => store.clear());

  test('absent = every status', async () => {
    await expect(svc.get(5)).resolves.toEqual([]);
  });

  test('Project Accounting: Open + Pending round-trips', async () => {
    await expect(svc.set(5, ['Open', 'Pending'])).resolves.toEqual(['Open', 'Pending']);
    expect(store.get(defaultStatusesKey(5))).toBe('["Open","Pending"]');
    await expect(svc.get(5)).resolves.toEqual(['Open', 'Pending']);
  });

  test('every status ticked is stored as [] so new statuses show up too', async () => {
    await expect(svc.set(1, ['Open', 'Pending', 'Pending Response', 'Resolved', 'Closed'])).resolves.toEqual([]);
  });

  test('unknown statuses are refused; retired names drop out on read', async () => {
    await expect(svc.set(5, ['Open', 'Waiting on vendor'])).rejects.toThrow(/Unknown status/);
    store.set(defaultStatusesKey(5), '["Open","Gone"]');
    await expect(svc.get(5)).resolves.toEqual(['Open']);
  });
});
