import { jest } from '@jest/globals';

/** True ticket merge (gap plan P2.1) — semantics, idempotency, origin rules. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketLink: {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  ticketThreadEntry: { findMany: jest.fn(), createMany: jest.fn() },
  ticketTagLink: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  ticketAttachment: { count: jest.fn().mockResolvedValue(0) },
  ticketTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  ticketApproval: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
};
const ticketServiceMock = {
  addPrivateNote: jest.fn().mockResolvedValue({}),
  addReply: jest.fn().mockResolvedValue({}),
  changeStatus: jest.fn().mockResolvedValue({}),
  updateFsTicket: jest.fn().mockResolvedValue({}),
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
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.ticketLink.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue(ENTRIES);
  prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 2 });
  prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tagId: 5 }]);
  prismaMock.ticketAttachment.count.mockResolvedValue(1);
  prismaMock.ticketTask.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 0 });
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

  test('FS-born source: entries copied and the FS ticket is closed via writeback, not changeStatus (QA 07-16 #5)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(FS_SOURCE)
      .mockResolvedValueOnce(TARGET);
    const result = await ticketMergeService.merge(11, 1, { targetTicketId: 20 }, null);
    // Conversation still copied into the TP-born target.
    expect(prismaMock.ticketThreadEntry.createMany).toHaveBeenCalled();
    // FS-born sources close through the origin-aware FS writeback path, never
    // the TP-only changeStatus.
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledWith(11, 1, { status: 'Closed' }, null);
    expect(result.sourceClosed).toBe(true);
  });

  test('notifyRequester sends a public reply on TP-born and FS-born sources (QA 07-16 #5)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);
    const tp = await ticketMergeService.merge(10, 1, { targetTicketId: 20, notifyRequester: true }, null);
    expect(tp.requesterNotified).toBe(true);
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(10, 1, expect.objectContaining({
      bodyText: expect.stringContaining('consolidated into TP-20'),
    }), null);

    // FS-born source: addReply routes the reply through FreshService (emailing
    // the requester); notification still fires.
    jest.clearAllMocks();
    prismaMock.ticketLink.findFirst.mockResolvedValue(null);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue(ENTRIES);
    prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 2 });
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(FS_SOURCE)
      .mockResolvedValueOnce(TARGET);
    const fs = await ticketMergeService.merge(11, 1, { targetTicketId: 20, notifyRequester: true }, null);
    expect(fs.requesterNotified).toBe(true);
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(11, 1, expect.any(Object), null);
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

  test('survivor gate: refuses an FS-born target (would strand messages in a TP shadow)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce({ ...TARGET, origin: 'freshservice', freshserviceTicketId: 5n });
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(/Ticket Pulse–born/);
    expect(prismaMock.ticketThreadEntry.createMany).not.toHaveBeenCalled();
  });

  test('survivor gate: refuses a Resolved/Closed target husk', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce({ ...TARGET, status: 'Closed' });
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(/Open or Pending/);
  });

  test('refuses a chained merge into a ticket already merged away', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);
    // circular check returns null, then the merged-away check returns a link.
    prismaMock.ticketLink.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 7, kind: 'merged_into' });
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(/surviving ticket/);
  });

  test('reconciles the source: moves open tasks, re-parents children, cancels pending approvals', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(TP_SOURCE)
      .mockResolvedValueOnce(TARGET);
    prismaMock.ticketTask.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.ticketLink.findMany.mockResolvedValue([
      { id: 51, ticketId: 10, relatedTicketId: 30, kind: 'parent_of' },
      { id: 52, ticketId: 10, relatedTicketId: 20, kind: 'parent_of' }, // child == survivor → dropped
    ]);

    const result = await ticketMergeService.merge(10, 1, { targetTicketId: 20 }, { email: 'c@bgc.ca' });

    // Open TP-born tasks move to the survivor.
    expect(prismaMock.ticketTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ticketId: 10, origin: 'ticketpulse', status: { not: 'done' } }),
      data: { ticketId: 20 },
    }));
    // The non-self child link is re-parented; the self-referential one is deleted.
    expect(prismaMock.ticketLink.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 51 }, data: { ticketId: 20 } }));
    expect(prismaMock.ticketLink.delete).toHaveBeenCalledWith({ where: { id: 52 } });
    // Pending approvals on the husk are cancelled.
    expect(prismaMock.ticketApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ticketId: 10, status: { in: ['pending', 'info_requested'] } }),
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
    expect(result.swept).toEqual({ tasks: 3, children: 1, approvals: 2 });
  });
});

describe('ticketMergeService — terminal sources (Phase MB2/MB6)', () => {
  test('a Resolved TP-born source merges (only Deleted/Spam are refused): entries copied, source re-closed', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ ...TP_SOURCE, status: 'Resolved' })
      .mockResolvedValueOnce(TARGET);
    const result = await ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null);
    expect(result.merged).toBe(true);
    expect(prismaMock.ticketThreadEntry.createMany).toHaveBeenCalled();
    // Already terminal → folded in as-is, no second close (sourceClosed false).
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(result.sourceClosed).toBe(false);
  });

  test('a Closed FS-born source merges too (folded in as-is — no FS status write)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ ...FS_SOURCE, status: 'Closed' })
      .mockResolvedValueOnce(TARGET);
    const result = await ticketMergeService.merge(11, 1, { targetTicketId: 20 }, null);
    expect(result.merged).toBe(true);
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
    expect(result.sourceClosed).toBe(false);
  });

  test('a Spam source is still refused', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ ...TP_SOURCE, status: 'Spam' })
      .mockResolvedValueOnce(TARGET);
    await expect(ticketMergeService.merge(10, 1, { targetTicketId: 20 }, null)).rejects.toThrow(ValidationError);
  });
});
