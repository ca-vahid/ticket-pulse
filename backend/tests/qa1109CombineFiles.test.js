import { jest } from '@jest/globals';

/**
 * QA 11-09 #5: when tickets are combined, the closed ticket's files are copied
 * to the ticket that is kept — automatic grouping, a manual merge, and a reply
 * that arrives on the closed copy. Copies are idempotent (a file the survivor
 * already holds is skipped) and signature logos are left behind.
 */
const model = (...names) => Object.fromEntries(names.map((n) => [n, jest.fn()]));
const prismaMock = {
  ticket: model('findFirst', 'findMany', 'findUnique', 'count', 'update'),
  ticketAttachment: model('findMany', 'updateMany', 'count'),
  ticketLink: model('findFirst', 'findMany', 'upsert', 'update', 'delete', 'deleteMany'),
  ticketThreadEntry: model('findFirst', 'findMany', 'create', 'createMany'),
  ticketActivity: model('create'),
  ticketGroupingEvent: model('findFirst', 'create', 'update'),
  assignmentPipelineRun: model('updateMany'),
  ticketTagLink: model('findMany', 'createMany'),
  ticketTask: model('updateMany'),
  ticketApproval: model('updateMany'),
};
const attachmentServiceMock = { isConfigured: jest.fn(() => true), copyToTicket: jest.fn() };
const recurringMock = { markRecurring: jest.fn(async (_ws, rows) => rows) };
const ticketServiceMock = { addPrivateNote: jest.fn(), addReply: jest.fn(), changeStatus: jest.fn(), updateFsTicket: jest.fn() };
const activityMock = { create: jest.fn(async () => ({})) };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: attachmentServiceMock }));
jest.unstable_mockModule('../src/services/recurringImageService.js', () => ({ ...recurringMock, default: recurringMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueThreadEntry: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(), set: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { carryAttachments, carryAttachmentsWithNote } = await import('../src/services/attachmentCarryService.js');
const { default: grouping } = await import('../src/services/ticketGrouping/groupingService.js');
const { redirectReplyOnClosedDuplicate } = await import('../src/services/duplicateReplyRedirect.js');
const { default: ticketMergeService } = await import('../src/services/ticketMergeService.js');

const SHOT = { id: 1, workspaceId: 1, ticketId: 11, threadEntryId: 4001, fileName: 'Screenshot (1).png', contentType: 'image/png', sizeBytes: 5000, source: 'email', blobName: 'b1' };
const PDF = { id: 2, workspaceId: 1, ticketId: 11, threadEntryId: null, fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 9000, source: 'email', blobName: 'b2' };
const LOGO = { id: 3, workspaceId: 1, ticketId: 11, threadEntryId: 4001, fileName: 'image001.png', contentType: 'image/png', sizeBytes: 39593, source: 'email', blobName: 'b3' };

let nextId = 100;
beforeEach(() => {
  jest.clearAllMocks();
  for (const m of Object.values(prismaMock)) for (const fn of Object.values(m)) fn.mockReset();
  nextId = 100;
  attachmentServiceMock.isConfigured.mockReturnValue(true);
  attachmentServiceMock.copyToTicket.mockImplementation(async (a, { ticketId, threadEntryId }) => ({ id: nextId++, ticketId, threadEntryId, fileName: a.fileName, sizeBytes: a.sizeBytes }));
  recurringMock.markRecurring.mockImplementation(async (_ws, rows) => rows.map((r) => (r.fileName === 'image001.png' ? { ...r, recurring: true } : r)));
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  prismaMock.ticketAttachment.updateMany.mockResolvedValue({ count: 0 });
  ticketServiceMock.addPrivateNote.mockResolvedValue({ entry: { id: 7000 } });
});

describe('carryAttachments', () => {
  test('copies every file the survivor does not hold yet, and leaves the signature logo behind', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 ? [SHOT, PDF, LOGO] : []));
    const out = await carryAttachments({ workspaceId: 1, fromTicketId: 11, toTicketId: 10, uploadedBy: 'x@example.com' });
    expect(out.ran).toBe(true);
    expect(out.copied.map((r) => r.fileName)).toEqual(['Screenshot (1).png', 'quote.pdf']);
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledTimes(2);
    expect(attachmentServiceMock.copyToTicket.mock.calls[0][1]).toEqual({ ticketId: 10, threadEntryId: null, uploadedBy: 'x@example.com' });
  });

  test('a second run copies nothing: same name and size already on the survivor', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11
      ? [SHOT, PDF]
      : [{ fileName: 'screenshot (1).PNG', sizeBytes: 5000 }, { fileName: 'quote.pdf', sizeBytes: 9000 }]));
    const out = await carryAttachments({ workspaceId: 1, fromTicketId: 11, toTicketId: 10 });
    expect(out.copied).toEqual([]);
    expect(out.skipped).toBe(2);
    expect(attachmentServiceMock.copyToTicket).not.toHaveBeenCalled();
  });

  test('no storage, or the survivor cannot be read: nothing is tried (no double copies later)', async () => {
    attachmentServiceMock.isConfigured.mockReturnValue(false);
    expect((await carryAttachments({ workspaceId: 1, fromTicketId: 11, toTicketId: 10 })).ran).toBe(false);
    attachmentServiceMock.isConfigured.mockReturnValue(true);
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => {
      if (where.ticketId === 11) return [SHOT];
      throw new Error('pool timeout');
    });
    const out = await carryAttachments({ workspaceId: 1, fromTicketId: 11, toTicketId: 10 });
    expect(out.ran).toBe(false);
    expect(attachmentServiceMock.copyToTicket).not.toHaveBeenCalled();
  });

  test('a failed file is counted and the rest still copy', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 ? [SHOT, PDF] : []));
    attachmentServiceMock.copyToTicket.mockRejectedValueOnce(new Error('blob gone'));
    const out = await carryAttachments({ workspaceId: 1, fromTicketId: 11, toTicketId: 10 });
    expect(out.failed).toBe(1);
    expect(out.copied.map((r) => r.fileName)).toEqual(['quote.pdf']);
  });

  test('with a note: one note names the files, and the copies are attached to it', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 ? [SHOT, PDF] : []));
    const writeNote = jest.fn(async () => ({ entry: { id: 7000 } }));
    const out = await carryAttachmentsWithNote({ workspaceId: 1, fromTicketId: 11, toTicketId: 10, fromRef: 'TP-11', writeNote });
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(writeNote.mock.calls[0][0]).toBe('Files from TP-11, which was combined into this ticket: Screenshot (1).png, quote.pdf. They are attached to this note; TP-11 keeps its own copies.');
    expect(prismaMock.ticketAttachment.updateMany).toHaveBeenCalledWith({ where: { id: { in: [100, 101] } }, data: { threadEntryId: 7000 } });
    expect(out.entryId).toBe(7000);
  });

  test('with a note but nothing new to copy: no note is written', async () => {
    const writeNote = jest.fn();
    await carryAttachmentsWithNote({ workspaceId: 1, fromTicketId: 11, toTicketId: 10, fromRef: 'TP-11', writeNote });
    expect(writeNote).not.toHaveBeenCalled();
  });
});

describe('automatic grouping carries the files to the kept ticket', () => {
  const links = { link: jest.fn() };
  grouping._links = async () => links;
  grouping._tickets = async () => ticketServiceMock;
  const copy = { id: 11, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 11, subject: 'Monitor flickers', descriptionText: 'See the screenshot', status: 'Open', requester: { name: 'Riley Example', email: 'riley@example.com' }, internalCategoryId: null };
  const keeper = { id: 10, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10, subject: 'Monitor flickering', status: 'Open', internalCategoryId: 4 };

  test('combining writes a "Files from TP-11" note on the keeper holding the copies', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 ? [SHOT] : []));
    await grouping._combine(copy, keeper, { reason: 'Same monitor problem.', relation: 'same_request', retraction: false });
    expect(links.link).toHaveBeenCalledWith(11, 1, { relatedTicketId: 10, kind: 'duplicate_of' }, expect.anything());
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledWith(SHOT, expect.objectContaining({ ticketId: 10 }));
    const fileNote = ticketServiceMock.addPrivateNote.mock.calls.find(([, , body]) => /^Files from TP-11/.test(body.bodyText));
    expect(fileNote[0]).toBe(10);
    expect(fileNote[2].bodyText).toContain('Screenshot (1).png');
    expect(prismaMock.ticketAttachment.updateMany).toHaveBeenCalledWith({ where: { id: { in: [100] } }, data: { threadEntryId: 7000 } });
  });

  test('a copy with no files gets no extra note', async () => {
    await grouping._combine(copy, keeper, { reason: 'Same.', relation: 'same_request', retraction: false });
    expect(ticketServiceMock.addPrivateNote.mock.calls.some(([, , body]) => /^Files from/.test(body.bodyText))).toBe(false);
  });
});

describe('a reply redirected from the closed copy brings its files', () => {
  const dup = { id: 11, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 11, requester: { name: 'Riley Example' } };
  const survivor = { id: 10, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10, subject: 'Monitor' };

  beforeEach(() => {
    prismaMock.ticketLink.findFirst.mockResolvedValue({ relatedTicketId: 10, kind: 'duplicate_of' });
    prismaMock.ticket.findUnique.mockResolvedValue(survivor);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ id: 4001, actorName: 'Riley Example', bodyText: 'Here it is again', occurredAt: new Date('2026-11-09T17:00:00Z') });
    prismaMock.ticketThreadEntry.create.mockImplementation(async ({ data }) => ({ id: 5001, ...data }));
  });

  test('the reply\'s files are copied onto the note on the surviving ticket', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 && where.threadEntryId === 4001 ? [SHOT] : []));
    const moved = await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: { entryId: 4001 }, dedupeStamp: 'reply:4001' });
    expect(moved.targetId).toBe(10);
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledWith(SHOT, expect.objectContaining({ ticketId: 10, threadEntryId: 5001 }));
    const toRow = activityMock.create.mock.calls.map(([row]) => row).find((row) => row.ticketId === 10);
    expect(toRow.details).toMatchObject({ filesCarried: 1, note: 'Reply on TP-11 added here as a note with its file.' });
  });

  test('a reply without files changes nothing about the redirect', async () => {
    const moved = await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: { entryId: 4001 }, dedupeStamp: 'reply:4001' });
    expect(moved.targetId).toBe(10);
    expect(attachmentServiceMock.copyToTicket).not.toHaveBeenCalled();
  });
});

describe('a manual merge copies the files onto the merged messages', () => {
  const SRC = { id: 11, origin: 'ticketpulse', status: 'Open', subject: 'Src', nativeNumber: 11, workspaceId: 1, requester: null };
  const TGT = { id: 10, origin: 'ticketpulse', status: 'Open', subject: 'Tgt', nativeNumber: 10, workspaceId: 1 };

  beforeEach(() => {
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where.id === 11 ? SRC : TGT));
    prismaMock.ticketLink.findFirst.mockResolvedValue(null);
    prismaMock.ticketLink.findMany.mockResolvedValue([]);
    prismaMock.ticketLink.upsert.mockResolvedValue({});
    prismaMock.ticketLink.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.ticketThreadEntry.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11
      ? [{ id: 4001, source: 'email_inbound', eventType: 'reply', occurredAt: new Date(), bodyText: 'hi' }]
      : [{ id: 8001, externalEntryId: 'merged:11:4001' }]));
    prismaMock.ticketThreadEntry.createMany.mockResolvedValue({ count: 1 });
    prismaMock.ticketTagLink.findMany.mockResolvedValue([]);
    prismaMock.ticketTask.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ticketAttachment.count.mockResolvedValue(2);
    ticketServiceMock.changeStatus.mockResolvedValue({});
  });

  test('a message\'s file lands on its merged copy; a ticket-level file on the ticket; the note says they were copied', async () => {
    prismaMock.ticketAttachment.findMany.mockImplementation(async ({ where }) => (where.ticketId === 11 ? [SHOT, PDF] : []));
    await ticketMergeService.merge(11, 1, { targetTicketId: 10 }, { email: 'coord@example.com', name: 'Coord' });
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledWith(SHOT, expect.objectContaining({ ticketId: 10, threadEntryId: 8001 }));
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledWith(PDF, expect.objectContaining({ ticketId: 10, threadEntryId: null }));
    const note = ticketServiceMock.addPrivateNote.mock.calls.find(([id]) => id === 10)[2];
    expect(note.bodyText).toContain('2 attachments copied to this ticket.');
    expect(note.bodyText).not.toMatch(/stay on/);
  });

  test('without attachment storage the note still says where the files are', async () => {
    attachmentServiceMock.isConfigured.mockReturnValue(false);
    await ticketMergeService.merge(11, 1, { targetTicketId: 10 }, { email: 'coord@example.com', name: 'Coord' });
    const note = ticketServiceMock.addPrivateNote.mock.calls.find(([id]) => id === 10)[2];
    expect(note.bodyText).toContain('2 attachments stay on TP-11.');
  });
});
