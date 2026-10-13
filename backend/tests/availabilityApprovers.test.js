import { jest } from '@jest/globals';

/**
 * Who an Availability request goes to (13 Oct 2026): with no approval group the
 * fallback is the super admins, not every admin of every workspace, and each
 * approver gets their own copy of the notice.
 */

const prismaMock = {
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn() },
  avRequest: { findMany: jest.fn() },
  avPerson: { findMany: jest.fn().mockResolvedValue([]) },
};
const settingsMock = { get: jest.fn() };
const sendEmail = jest.fn();
const warn = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ sendEmail }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: async () => 'https://tp.example' }));

const { default: svc } = await import('../src/services/availability/availabilityService.js');

const group = (approvers) => [{ group: { id: 1, approvers: approvers.map((email) => ({ email, isDelegate: false })) } }];

beforeEach(() => {
  jest.clearAllMocks();
  settingsMock.get.mockResolvedValue('Boss@bgc.ca, second@bgc.ca');
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ id: 9 }); // a workspace admin
  prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'wsadmin@bgc.ca' }, { email: 'other@bgc.ca' }]);
  prismaMock.avRequest.findMany.mockResolvedValue([]);
  sendEmail.mockResolvedValue({ success: true });
});

test('no approval group: the request goes to the super admins only', async () => {
  expect((await svc.approversFor('reza@bgc.ca')).sort()).toEqual(['boss@bgc.ca', 'second@bgc.ca']);
  expect(prismaMock.workspaceAccess.findMany).not.toHaveBeenCalled();
});

test('a super admin asking for leave is not their own approver', async () => {
  expect(await svc.approversFor('BOSS@bgc.ca')).toEqual(['second@bgc.ca']);
});

test('workspace admins are the last resort when no super admin is left', async () => {
  settingsMock.get.mockResolvedValue('boss@bgc.ca');
  expect((await svc.approversFor('boss@bgc.ca')).sort()).toEqual(['other@bgc.ca', 'wsadmin@bgc.ca']);
});

test('a group with approvers never falls back', async () => {
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue(group(['lead@bgc.ca']));
  expect(await svc.approversFor('reza@bgc.ca')).toEqual(['lead@bgc.ca']);
});

test('a workspace admin who is not a named approver cannot decide; a super admin and the approver can', async () => {
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue(group(['lead@bgc.ca']));
  const request = { email: 'reza@bgc.ca' };
  expect(await svc.canDecide({ email: 'wsadmin@bgc.ca', role: 'admin' }, request)).toBe(false);
  expect(await svc.canDecide({ email: 'boss@bgc.ca' }, request)).toBe(true);
  expect(await svc.canDecide({ email: 'lead@bgc.ca' }, request)).toBe(true);
  expect(await svc.canDecide({ email: 'reza@bgc.ca' }, request)).toBe(false);
});

test('the waiting list follows the same rule', async () => {
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue(group(['lead@bgc.ca']));
  prismaMock.avRequest.findMany.mockResolvedValue([{ id: 5, email: 'reza@bgc.ca', status: 'pending', startDate: new Date('2026-11-25'), endDate: new Date('2026-11-25') }]);
  expect(await svc.listPendingFor({ email: 'wsadmin@bgc.ca', role: 'admin' })).toHaveLength(0);
  expect(await svc.listPendingFor({ email: 'boss@bgc.ca' })).toHaveLength(1);
  expect(await svc.listPendingFor({ email: 'lead@bgc.ca' })).toHaveLength(1);
});

test('each approver gets their own copy, and one failed send does not stop the rest', async () => {
  sendEmail.mockRejectedValueOnce(new Error('bounce'));
  const request = { id: 7, startDate: new Date('2026-11-25'), endDate: new Date('2026-11-25'), note: 'Car service.', decision: { reason: 'Vacation needs approval.' } };
  await svc._notifyApprovers(request, { name: 'Vacation' }, { name: 'Reza Zaim' }, ['a@bgc.ca', 'B@bgc.ca', 'a@bgc.ca']);
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual([['a@bgc.ca'], ['b@bgc.ca']]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of 2'));
});
