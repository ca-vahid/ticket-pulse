import { jest } from '@jest/globals';

/** Bulk edit by query (gap plan P2.2): preview, staleness guard, cap, origin skip. */

const prismaMock = {
  ticket: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  ticketTagLink: { findMany: jest.fn().mockResolvedValue([]) },
};
const activityMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: jest.fn() } }));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const mkTicket = (id, origin = 'ticketpulse') => ({ id, origin, status: 'Open', nativeNumber: origin === 'ticketpulse' ? id : null, freshserviceTicketId: origin === 'freshservice' ? BigInt(id) : null });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketTagLink.findMany.mockResolvedValue([]);
});

describe('ticketService.bulkByQuery', () => {
  test('preview returns counts with FS-born split for field actions', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1), mkTicket(2, 'freshservice'), mkTicket(3)]);
    const result = await ticketService.bulkByQuery(1, {
      query: { status: 'Open' }, action: { type: 'status', value: 'Resolved' }, preview: true,
    }, { email: 'c@bgc.ca' });
    expect(result).toEqual({ preview: true, total: 3, editable: 2, skippedFsBorn: 1 });
  });

  test('tags action treats both origins as editable', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1), mkTicket(2, 'freshservice')]);
    const result = await ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'add_tags', value: [7] }, preview: true,
    }, null);
    expect(result.editable).toBe(2);
    expect(result.skippedFsBorn).toBe(0);
  });

  test('rejects when the filter matches more than the cap', async () => {
    prismaMock.ticket.findMany.mockResolvedValue(Array.from({ length: 501 }, (_, i) => mkTicket(i + 1)));
    await expect(ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'status', value: 'Closed' }, preview: true,
    }, null)).rejects.toThrow(/more than 500/);
  });

  test('rejects a stale confirmation (expectedTotal mismatch)', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1), mkTicket(2)]);
    await expect(ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'status', value: 'Closed' }, expectedTotal: 5,
    }, null)).rejects.toThrow(/queue changed/);
  });

  test('applies per ticket through changeStatus and reports failures individually', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1), mkTicket(2)]);
    const changeStatus = jest.spyOn(ticketService, 'changeStatus')
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('locked'));
    const result = await ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'status', value: 'Closed' }, expectedTotal: 2,
    }, { email: 'c@bgc.ca' });
    expect(result).toMatchObject({ total: 2, applied: 1, skippedFsBorn: 0 });
    expect(result.failed).toEqual([{ ref: 'TP-2', message: 'locked' }]);
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'bulk_edit' }));
    changeStatus.mockRestore();
  });

  test('rejects unknown action types', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1)]);
    await expect(ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'delete' }, preview: true,
    }, null)).rejects.toThrow(ValidationError);
  });

  test('remove_tags computes the set difference through setTags', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1)]);
    prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tagId: 5 }, { tagId: 7 }]);
    const setTags = jest.spyOn(ticketService, 'setTags').mockResolvedValue({ changed: true });
    const result = await ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'remove_tags', value: [7] }, expectedTotal: 1,
    }, null);
    expect(result.applied).toBe(1);
    expect(setTags).toHaveBeenCalledWith(1, 1, [5], null);
    setTags.mockRestore();
  });

  test('set_category routes through updateTicketFields (TP-born only)', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([mkTicket(1), mkTicket(2, 'freshservice')]);
    const upd = jest.spyOn(ticketService, 'updateTicketFields').mockResolvedValue({});
    const result = await ticketService.bulkByQuery(1, {
      query: {}, action: { type: 'set_category', value: 42 }, expectedTotal: 2,
    }, null);
    expect(result.applied).toBe(1);
    expect(result.skippedFsBorn).toBe(1);
    expect(upd).toHaveBeenCalledWith(1, 1, { internalCategoryId: 42 }, null);
    upd.mockRestore();
  });
});
