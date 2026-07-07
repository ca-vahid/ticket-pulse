import { jest } from '@jest/globals';

/** True ticket merge (gap plan P2.1) — semantics, idempotency, origin rules. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketLink: { findFirst: jest.fn(), upsert: jest.fn().mockResolvedValue({}) },
  ticketThreadEntry: { findMany: jest.fn(), createMany: jest.fn() },
  ticketTagLink: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  ticketAttachment: { count: jest.fn().mockResolvedValue(0) },
};
const ticketServiceMock = {
  addPrivateNote: jest.fn().mockResolvedValue({}),
  addReply: jest.fn().mockResolvedValue({}),
  changeStatus: jest.fn().mockResolvedValue({}),
};
const activityMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: ticketMergeService } = await import('../src/services/ticketMergeService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const TP_SOURCE = { id: 10, origin: 'ticketpulse', status: 'Open', subject: 'Src', nativeNumber: 10, workspaceId: 1 };
const FS_SOURCE = { id: 11, origin: 'freshservice', status: 'Open', subject: 'FS Src', freshserviceTicketId: 900n, workspaceId: 1 };
const TARGET = { id: 20, origin: 'ticketpulse', status: 'Open', subject: 'Tgt', nativeNumber: 20, workspaceId: 1 };

const ENTRIES = [
  { id: 101, source: 'ticketpulse_user', eventType: 'reply', actorName: 'A', occurredAt: new Date(), bodyText: 'hello' },
  { id: 102, source: 'email_inbound', eventType: 'reply', actorName: 'R', occurredAt: new Date(), bodyText: 'world' },
];

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue(ENTRIES);
  prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 2 });
  prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tagId: 5 }]);
  prismaMock.ticketAttachment.count.mockResolvedValue(1);
});

describe('ticketMergeService.merge', () => {
  test('TP-born source: copies entries with provenance ids, unions tags, closes source', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);

    const result = await ticketMergeService.merge(10, 1, { targetTicketId: 20, notifyRequester: false }, { email: 'c@bgc.ca', name: 'Coord' });

    expect(result).toMatchObject({ merged: true, copied: 2, sourceClosed: true, requesterNotified: false });
    const copyData = prismaMock.ticketThreadEntry.createMany.mock.calls[0][0];
    expect(copyData.skipDuplicates).toBe(true);
    expect(copyData.data[0].externalEntryId).toBe('merged:10:101');
    expect(copyData.data[0].ticketId).toBe(20);
    expect(copyData.data[0].mirrorState).toBeNull();
    expect(prismaMock.ticketTagLink.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(prismaMock.ticketLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ kind: 'merged_into', ticketId: 10, relatedTicketId: 20 }),
    }));
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(10, 1, 'Closed', expect.anything());
    expect(activityMock.create).toHaveBeenCalledTimes(2);
  });

  test('FS-born source: entries copied but status untouched (FreshService owns it)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(FS_SOURCE)
      .mockResolvedValueOnce(TARGET);
    const result = await ticketMergeService.merge(11, 1, { targetTicketId: 20 }, null);
    expect(result.sourceClosed).toBe(false);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });

  test('notifyRequester sends a public reply on TP-born sources only', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);
    const result = await ticketMergeService.merge(10, 1, { targetTicketId: 20, notifyRequester: true }, null);
    expect(result.requesterNotified).toBe(true);
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(10, 1, expect.objectContaining({
      bodyText: expect.stringContaining('consolidated into TP-20'),
    }), null);
  });

  test('rejects self-merge and circular merges', async () => {
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 10 }, null)).rejects.toThrow(ValidationError);
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);
    prismaMock.ticketLink.findFirst.mockResolvedValue({ id: 1 }); // target already merged into source
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(/already merged/);
  });

  test('rejects merging into a deleted ticket', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce({ ...TARGET, status: 'Deleted' });
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(/deleted/);
  });
});
