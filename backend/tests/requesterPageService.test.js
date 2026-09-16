import { jest } from '@jest/globals';

/** Search v2 — the requester page payload. */
const prismaMock = {
  requester: { findUnique: jest.fn() },
  ticket: { count: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn(async (_ws, bases) => (bases.includes('Open') ? ['Open', 'Pending'] : ['Resolved', 'Closed'])) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { requesterProfile } = await import('../src/services/requesterPageService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.requester.findUnique.mockResolvedValue({
    id: 9, name: 'Sabina Greer', email: 'sgreer@bgc.ca', jobTitle: 'Office Administrator', entraDepartment: 'Colorado',
    freshserviceId: 1001705014n, isActive: true, createdAt: new Date('2025-02-01T00:00:00Z'),
  });
  prismaMock.ticket.count.mockResolvedValueOnce(12).mockResolvedValueOnce(2).mockResolvedValueOnce(9);
  prismaMock.ticket.findFirst
    .mockResolvedValueOnce({ createdAt: new Date('2025-03-01T00:00:00Z') })
    .mockResolvedValueOnce({ id: 500, createdAt: new Date('2026-09-10T00:00:00Z'), subject: 'Printer', status: 'Open' });
  prismaMock.ticket.findMany.mockResolvedValue([
    { createdAt: new Date('2026-09-01T00:00:00Z'), resolvedAt: new Date('2026-09-01T04:00:00Z') },
    { createdAt: new Date('2026-09-02T00:00:00Z'), resolvedAt: new Date('2026-09-03T00:00:00Z') },
    { createdAt: new Date('2026-09-05T00:00:00Z'), resolvedAt: new Date('2026-09-05T10:00:00Z') },
  ]);
  prismaMock.ticket.groupBy.mockResolvedValue([{ internalCategoryId: 3, _count: { _all: 5 } }, { internalCategoryId: 4, _count: { _all: 2 } }]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 3, name: 'Devices & Hardware' }, { id: 4, name: 'Account & Access' }]);
});

test('returns the person, workspace-scoped counts, first/last ticket, median resolution and top categories', async () => {
  const data = await requesterProfile('9', 1);
  expect(data.requester).toMatchObject({ id: 9, name: 'Sabina Greer', freshserviceId: '1001705014' }); // BigInt → string
  expect(data.stats).toMatchObject({ total: 12, open: 2, resolved: 9, medianResolutionHours: 10, resolutionSample: 3 });
  expect(data.stats.firstTicketAt).toEqual(new Date('2025-03-01T00:00:00Z'));
  expect(data.stats.lastTicket).toEqual({ id: 500, subject: 'Printer', status: 'Open' });
  expect(data.stats.topCategories).toEqual([{ id: 3, name: 'Devices & Hardware', count: 5 }, { id: 4, name: 'Account & Access', count: 2 }]);
  // every count is scoped to the workspace and excludes noise
  for (const call of prismaMock.ticket.count.mock.calls) expect(call[0].where).toMatchObject({ workspaceId: 1, requesterId: 9, isNoise: false });
});

test('unknown / invalid ids', async () => {
  await expect(requesterProfile('abc', 1)).rejects.toThrow(/Invalid requester id/);
  prismaMock.requester.findUnique.mockResolvedValue(null);
  await expect(requesterProfile('9', 1)).rejects.toThrow(/Requester not found/);
});
