import { jest } from '@jest/globals';

/**
 * Which addresses FreshService reads for a workspace (23 Sep 2026): the setting
 * wins, else learned from outgoing FS conversations, else nothing (= ingest).
 */
const prismaMock = { $queryRaw: jest.fn() };
const settingsMock = { get: jest.fn(), set: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const svc = await import('../src/services/fsHelpdeskAddressService.js');

beforeEach(() => {
  jest.clearAllMocks();
  svc.invalidateFsHelpdeskCache();
});

test('the setting wins when set; learned otherwise (≥ 5 rows); a failure means the empty set', async () => {
  settingsMock.get.mockResolvedValue('IT@BGCengineering.ca, other@bgc.ca');
  expect([...await svc.fsHelpdeskAddresses(1)]).toEqual(['it@bgcengineering.ca', 'other@bgc.ca']);

  svc.invalidateFsHelpdeskCache();
  settingsMock.get.mockResolvedValue('');
  prismaMock.$queryRaw.mockResolvedValue([{ address: 'it@bgcengineering.ca', n: 505 }, { address: 'rare@bgc.ca', n: 2 }]);
  expect([...await svc.fsHelpdeskAddresses(1)]).toEqual(['it@bgcengineering.ca']);

  svc.invalidateFsHelpdeskCache();
  settingsMock.get.mockRejectedValue(new Error('db down'));
  expect((await svc.fsHelpdeskAddresses(1)).size).toBe(0);
});

test('freshserviceWillIngest: helpdesk or a *.freshservice.com tenant address among the recipients', async () => {
  settingsMock.get.mockResolvedValue('it@bgcengineering.ca');
  expect(await svc.freshserviceWillIngest(1, { to: ['ticketpulse@bgcengineering.ca'], cc: ['IT@bgcengineering.ca'] })).toBe(true);
  expect(await svc.freshserviceWillIngest(1, { to: ['ticketpulse@bgcengineering.ca'], cc: [] })).toBe(false);
  expect(await svc.freshserviceWillIngest(1, { to: ['ticketpulse@bgcengineering.ca'], cc: ['bgcengineeringcait@efusion.freshservice.com'] })).toBe(true);
  expect(await svc.freshserviceWillIngest(1, { to: [], cc: [] })).toBe(false);
});

test('setFsHelpdeskAddresses normalises and stores; the cache is dropped', async () => {
  settingsMock.set.mockResolvedValue(undefined);
  expect(await svc.setFsHelpdeskAddresses(1, ' A@x.io; b@x.io, a@x.io ')).toEqual(['a@x.io', 'b@x.io']);
  expect(settingsMock.set).toHaveBeenCalledWith('fs_helpdesk_emails_ws1', 'a@x.io, b@x.io');
});
