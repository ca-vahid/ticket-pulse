import { jest } from '@jest/globals';

/**
 * Assetron review (25 Sep 2026): GET /tickets/{ref}/approval WITHOUT a category
 * must be the HARDWARE verdict — an approved licence on the same ticket must
 * never open the laptop gate. `category=any` stays the ticket-wide opt-in.
 */
const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketApproval: { findMany: jest.fn() },
};
const verdictAsset = jest.fn(async () => null);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/fsApprovalRefreshService.js', () => ({ refreshFsApprovalStatus: jest.fn(async () => {}) }));
jest.unstable_mockModule('../src/services/assetronReservationService.js', () => ({ default: { verdictAsset } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: svc } = await import('../src/services/approvalVerdictService.js');

const TICKET = { id: 44, workspaceId: 1, subject: 'Better laptop for Peter', status: 'Open', ticketType: 'Service Request', origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 243696n, createdAt: new Date(), updatedAt: new Date(), fsApprovalStatus: null, fsApprovalStatusName: null, requester: { name: 'Peter', email: 'p@bgc.ca' } };
const LICENCE_APPROVED = { id: 1, status: 'approved', approverEmail: 'n@bgc.ca', approverName: 'N', decidedAt: new Date(), decidedVia: 'app', expiresAt: null, createdAt: new Date(), requestGroupId: 'g-lic', approvalCategory: { id: 10, name: 'AI Premium License Request' } };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
});

test('no category → only hardware-flagged categories are read', async () => {
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  const v = await svc.verdict(44, 1, {});
  expect(prismaMock.ticketApproval.findMany.mock.calls[0][0].where).toMatchObject({ ticketId: 44, workspaceId: 1, approvalCategory: { gatesHardware: true } });
  expect(v.approval).toMatchObject({ state: 'NOT_REQUESTED', isApproved: false, scope: 'hardware' });
});

test('an approved licence does not open the laptop gate (it is filtered out), but category=any sees it', async () => {
  prismaMock.ticketApproval.findMany.mockImplementation(async ({ where }) => (where.approvalCategory?.gatesHardware ? [] : [LICENCE_APPROVED]));
  const hardware = await svc.verdict(44, 1, {});
  expect(hardware.approval.isApproved).toBe(false);
  const any = await svc.verdict(44, 1, { scope: 'any' });
  expect(prismaMock.ticketApproval.findMany.mock.calls[1][0].where.approvalCategory).toBeUndefined();
  expect(any.approval).toMatchObject({ isApproved: true, scope: 'ticket' });
});

test('a named category scopes to it', async () => {
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  const v = await svc.verdict(44, 1, { category: { id: 4, name: 'New Computer Upgrade' } });
  expect(prismaMock.ticketApproval.findMany.mock.calls[0][0].where).toMatchObject({ approvalCategoryId: 4 });
  expect(v.approval.scope).toBe('category');
});

test('`asset` carries the Assetron laptop when there is one, else null', async () => {
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  expect((await svc.verdict(44, 1, {})).asset).toBeNull();
  verdictAsset.mockResolvedValueOnce({ system: 'ASSETRON', assetId: 'a1', state: 'ASSIGNED' });
  expect((await svc.verdict(44, 1, {})).asset).toMatchObject({ system: 'ASSETRON', state: 'ASSIGNED' });
});
