import { jest } from '@jest/globals';

/**
 * Phase MR6 (QA 08-26 #3) — the per-workspace "Also notify additional
 * requesters" toggle: app_settings-backed (workspace-scoped key, no
 * migration), cached, fails CLOSED, and the cc helper that lifecycle mails
 * use (ticket.ccEmails minus anything already in To).
 */

const settingsMock = { get: jest.fn(), set: jest.fn() };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  alsoForNotifySettingKey,
  isAlsoForNotifyEnabled,
  setAlsoForNotifyEnabled,
  invalidateAlsoForNotifyCache,
  additionalRequesterCc,
} = await import('../src/services/alsoForNotifyService.js');

beforeEach(() => {
  jest.clearAllMocks();
  invalidateAlsoForNotifyCache();
  settingsMock.set.mockResolvedValue({});
});

describe('alsoForNotifyService toggle', () => {
  test('key is workspace-scoped in the existing app_settings table', () => {
    expect(alsoForNotifySettingKey(3)).toBe('also_notify_additional_requesters_ws3');
  });

  test('default OFF (no row) and truthy spellings turn it on', async () => {
    settingsMock.get.mockResolvedValue(null);
    expect(await isAlsoForNotifyEnabled(1)).toBe(false);
    invalidateAlsoForNotifyCache(1);
    settingsMock.get.mockResolvedValue('1');
    expect(await isAlsoForNotifyEnabled(1)).toBe(true);
    invalidateAlsoForNotifyCache(1);
    settingsMock.get.mockResolvedValue('true');
    expect(await isAlsoForNotifyEnabled(1)).toBe(true);
    invalidateAlsoForNotifyCache(1);
    settingsMock.get.mockResolvedValue('0');
    expect(await isAlsoForNotifyEnabled(1)).toBe(false);
  });

  test('reads are cached per workspace; set() writes "1"/"0" and refreshes the cache', async () => {
    settingsMock.get.mockResolvedValue('1');
    expect(await isAlsoForNotifyEnabled(2)).toBe(true);
    expect(await isAlsoForNotifyEnabled(2)).toBe(true);
    expect(settingsMock.get).toHaveBeenCalledTimes(1);

    expect(await setAlsoForNotifyEnabled(2, false)).toBe(false);
    expect(settingsMock.set).toHaveBeenCalledWith('also_notify_additional_requesters_ws2', '0');
    expect(await isAlsoForNotifyEnabled(2)).toBe(false); // cache updated, no extra read
    expect(settingsMock.get).toHaveBeenCalledTimes(1);
  });

  test('a settings read failure fails CLOSED (off) instead of widening a delivery', async () => {
    settingsMock.get.mockRejectedValue(new Error('db down'));
    expect(await isAlsoForNotifyEnabled(4)).toBe(false);
    expect(await isAlsoForNotifyEnabled(0)).toBe(false);
    expect(await isAlsoForNotifyEnabled(null)).toBe(false);
  });
});

describe('additionalRequesterCc', () => {
  test('off → [] even when the ticket carries a list', async () => {
    settingsMock.get.mockResolvedValue('0');
    expect(await additionalRequesterCc(1, { ccEmails: ['manager@example.com'] }, ['rita@example.com'])).toEqual([]);
  });

  test('on → ticket.ccEmails minus To (case-insensitive), deduped, lowercased', async () => {
    settingsMock.get.mockResolvedValue('1');
    const cc = await additionalRequesterCc(
      1,
      { ccEmails: ['Manager@Example.com', 'rita@example.com', 'manager@example.com', 'assistant@example.com'] },
      ['RITA@example.com'],
    );
    expect(cc).toEqual(['manager@example.com', 'assistant@example.com']);
  });

  test('works with the workflow eventContext.ticket shape and tolerates missing lists', async () => {
    settingsMock.get.mockResolvedValue('1');
    expect(await additionalRequesterCc(1, { id: 100 }, ['rita@example.com'])).toEqual([]);
    expect(await additionalRequesterCc(1, null, [])).toEqual([]);
  });
});
