import { jest } from '@jest/globals';

const prismaMock = {
  ticketProposedReply: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};
const addReplyMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({
  default: { addReply: addReplyMock },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: service } = await import('../src/services/ticketProposedReplyService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketProposedReply.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketProposedReply.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, ...data }));
  prismaMock.ticketProposedReply.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  addReplyMock.mockResolvedValue({ entry: { id: 9001 }, email: { sent: true } });
});

describe('ticketProposedReplyService', () => {
  test('create supersedes any open proposal on the same ticket (one draft at a time)', async () => {
    const proposal = await service.create({
      workspaceId: 1, ticketId: 501, workflowRunId: 900,
      bodyHtml: '<p>draft</p>', bodyText: 'draft', confidence: 'medium',
    });
    expect(proposal.id).toBe(77);
    expect(prismaMock.ticketProposedReply.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 501, status: 'proposed' },
      data: expect.objectContaining({ status: 'dismissed', decidedBy: 'superseded' }),
    }));
  });

  test('create rejects an empty draft', async () => {
    await expect(service.create({ workspaceId: 1, ticketId: 501 })).rejects.toThrow(/needs a body/i);
  });

  test('send goes through the normal reply path and audits what actually went out', async () => {
    prismaMock.ticketProposedReply.findFirst.mockResolvedValue({
      id: 77, ticketId: 501, workspaceId: 1, status: 'proposed',
      bodyHtml: '<p>original</p>', bodyText: 'original',
    });

    const result = await service.send(501, 1, 77, { bodyHtml: '<p>edited</p>', bodyText: 'edited' }, { email: 'agent@x.io' });

    expect(addReplyMock).toHaveBeenCalledWith(501, 1, { bodyHtml: '<p>edited</p>', bodyText: 'edited' }, { email: 'agent@x.io' });
    expect(prismaMock.ticketProposedReply.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 77 },
      data: expect.objectContaining({
        status: 'sent',
        decidedBy: 'agent@x.io',
        sentThreadEntryId: 9001,
        bodyHtml: '<p>edited</p>', // the audit keeps the EDITED body
      }),
    }));
    expect(result.reply.entry.id).toBe(9001);
  });

  test('already-decided proposals cannot be re-sent or dismissed', async () => {
    prismaMock.ticketProposedReply.findFirst.mockResolvedValue({ id: 77, ticketId: 501, workspaceId: 1, status: 'sent' });
    await expect(service.send(501, 1, 77, {}, { email: 'a@x.io' })).rejects.toThrow(/already sent/i);
    await expect(service.dismiss(501, 1, 77, { email: 'a@x.io' })).rejects.toThrow(/already sent/i);
  });

  test('dismiss records who declined', async () => {
    prismaMock.ticketProposedReply.findFirst.mockResolvedValue({ id: 77, ticketId: 501, workspaceId: 1, status: 'proposed' });
    await service.dismiss(501, 1, 77, { email: 'agent@x.io' });
    expect(prismaMock.ticketProposedReply.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'dismissed', decidedBy: 'agent@x.io' }),
    }));
  });
});
