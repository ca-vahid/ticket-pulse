import { jest } from '@jest/globals';

// 6 Nov 2026: a Ticket Pulse ticket's FreshService copy replies from its group's support address
// (fs_email_config_by_group_ws<N>), not the workspace default.
const settings = { get: jest.fn() };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settings }));
const { fsEmailConfigIdFor, parseEmailConfigMap, fsEmailConfigSettingKey } = await import('../src/utils/fsEmailConfig.js');

const MAP = JSON.stringify({ 1000209106: 1000018014, 1000210021: 1000018224 });

describe('FreshService support address per group', () => {
  beforeEach(() => settings.get.mockReset());

  test('AP and AR groups map to their own support addresses', async () => {
    settings.get.mockResolvedValue(MAP);
    expect(await fsEmailConfigIdFor(2, 1000209106n)).toBe(1000018014);
    expect(await fsEmailConfigIdFor(2, '1000210021')).toBe(1000018224);
    expect(settings.get).toHaveBeenCalledWith('fs_email_config_by_group_ws2');
  });

  test('no setting, unknown group, no group or a broken value → undefined (FreshService default)', async () => {
    settings.get.mockResolvedValue(null);
    expect(await fsEmailConfigIdFor(1, 1000009787n)).toBeUndefined();
    settings.get.mockResolvedValue(MAP);
    expect(await fsEmailConfigIdFor(2, 999)).toBeUndefined();
    expect(await fsEmailConfigIdFor(2, null)).toBeUndefined();
    settings.get.mockResolvedValue('{not json');
    expect(await fsEmailConfigIdFor(2, 1000209106n)).toBeUndefined();
    settings.get.mockRejectedValue(new Error('db down'));
    expect(await fsEmailConfigIdFor(2, 1000209106n)).toBeUndefined();
  });

  test('parse keeps only numeric group → positive integer pairs', () => {
    const m = parseEmailConfigMap({ 1000209106: 1000018014, abc: 5, 1000210021: -1, 42: '77' });
    expect([...m.entries()]).toEqual([['42', 77], ['1000209106', 1000018014]]);
    expect(parseEmailConfigMap('[1,2]').size).toBe(0);
    expect(fsEmailConfigSettingKey('2')).toBe('fs_email_config_by_group_ws2');
  });
});
