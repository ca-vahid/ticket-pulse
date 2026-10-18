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

describe('merged content arrives as full messages (18 Oct 2026; was a quoted description, QA 09-21 #3)', () => {
  test('an FS-born source opening e-mail is copied as a rich message from its sender, marked with where it came from', async () => {
    prismaMock.technician = { findFirst: jest.fn().mockResolvedValue({ id: 7 }) };
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 1 });
    const html = '<p>Hi Richard, I checked the machine and it is working for me. Are you on VPN?</p><p>Thanks,<br>Mehdi</p>';
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where.id === 11
      ? { ...FS_SOURCE, subject: 'Re: anyone working today?', description: html, descriptionText: 'Hi Richard, I checked the machine…', createdAt: new Date('2026-10-17T15:10:00Z'), requester: { name: 'Mehdi Abbaspour', email: 'mabbaspour@bgc.ca' } }
      : TARGET));
    await ticketMergeService.merge(11, 1, { targetTicketId: 20 }, { email: 'c@bgc.ca', name: 'Coord' });

    const [copy] = prismaMock.ticketThreadEntry.createMany.mock.calls[0][0].data;
    expect(copy).toEqual(expect.objectContaining({
      ticketId: 20,
      externalEntryId: 'merged:11:description',
      eventType: 'reply',
      bodyHtml: html,
      actorName: 'Mehdi Abbaspour',
      actorEmail: 'mabbaspour@bgc.ca',
      authorType: 'agent',
      occurredAt: new Date('2026-10-17T15:10:00Z'),
      mirrorState: null,
    }));
    expect(copy.rawPayload.mergedFrom).toEqual(expect.objectContaining({ ticketId: 11, ref: '#900', part: 'opening_email' }));

    // The note says what happened and links back; it no longer quotes the body.
    const note = ticketServiceMock.addPrivateNote.mock.calls.find(([id]) => id === 20)?.[2] || {};
    expect(note.bodyText).toMatch(/^Merged #900 "Re: anyone working today\?" into this ticket\./);
    expect(note.bodyText).toMatch(/Its opening e-mail is now in this conversation, marked "Merged from #900"\./);
    expect(note.bodyText).toMatch(/1 attachment stays on #900\./);
    expect(note.bodyText).not.toMatch(/Description of/);
    expect(note.bodyHtml).toContain('<a href="/tickets/11">#900</a>');

    const fromRow = activityMock.create.mock.calls.find(([row]) => row.activityType === 'merged_from')[0];
    expect(fromRow.details).toEqual(expect.objectContaining({ srcRef: '#900', sourceSubject: 'Re: anyone working today?', descriptionCopied: true, attachmentsLeft: 1, actorName: 'Coord' }));
    delete prismaMock.technician;
  });

  test('a TP-born source opening e-mail entry becomes a plain message with the full body', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { id: 100, source: 'email_inbound', eventType: 'original_email', actorName: 'R', occurredAt: new Date(), bodyText: 'short preview', bodyHtml: null },
      ...ENTRIES,
    ]);
    prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 3 });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where.id === 10
      ? { ...TP_SOURCE, description: '<p>The <b>full</b> opening mail</p>', descriptionText: 'The full opening mail' }
      : TARGET));
    const result = await ticketMergeService.merge(10, 1, { targetTicketId: 20 }, { email: 'c@bgc.ca', name: 'Coord' });
    const data = prismaMock.ticketThreadEntry.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(3);
    expect(data[0]).toEqual(expect.objectContaining({ eventType: 'reply', bodyHtml: '<p>The <b>full</b> opening mail</p>', bodyText: 'The full opening mail' }));
    expect(data.every((row) => row.rawPayload?.mergedFrom?.ref === 'TP-10')).toBe(true);
    expect(data.some((row) => row.externalEntryId === 'merged:10:description')).toBe(false);
    expect(result.copied).toBe(3);
  });
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
    // Since Simorgh Phase B the merged source closes as a duplicate with a note naming the survivor.
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(10, 1, 'Closed', expect.anything(), { resolutionReason: 'duplicate', resolutionNote: 'Merged into TP-20' });
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
