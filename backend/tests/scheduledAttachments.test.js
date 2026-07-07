import { jest } from '@jest/globals';

/** Scheduled-ticket attachments (gap plan 2 P2): adopt-on-activate + cleanup. */

const prismaMock = {
  scheduledTicketAttachment: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  ticketAttachment: { create: jest.fn(), count: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: attachmentService } = await import('../src/services/attachmentService.js');

const deleteIfExists = jest.fn().mockResolvedValue({});
attachmentService._containerClient = { getBlockBlobClient: () => ({ deleteIfExists }) };

const STAGED = [
  { id: 1, workspaceId: 1, scheduledTicketId: 9, fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 100, blobName: 'ws-1/scheduled-9/x-quote.pdf', uploadedBy: 'a@b.c' },
  { id: 2, workspaceId: 1, scheduledTicketId: 9, fileName: 'photo.png', contentType: 'image/png', sizeBytes: 200, blobName: 'ws-1/scheduled-9/y-photo.png', uploadedBy: 'a@b.c' },
];

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.scheduledTicketAttachment.deleteMany.mockResolvedValue({ count: STAGED.length });
});

describe('attachmentService staged lifecycle', () => {
  test('adoptStaged creates real attachment rows on the SAME blobs and clears staging', async () => {
    prismaMock.scheduledTicketAttachment.findMany.mockResolvedValue(STAGED);
    prismaMock.ticketAttachment.create
      .mockResolvedValueOnce({ id: 11 })
      .mockResolvedValueOnce({ id: 12 });

    const adopted = await attachmentService.adoptStaged(9, 42, 1);

    expect(adopted).toHaveLength(2);
    expect(prismaMock.ticketAttachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ticketId: 42,
        blobName: 'ws-1/scheduled-9/x-quote.pdf', // same blob, no re-upload
        source: 'scheduled',
      }),
    }));
    expect(prismaMock.scheduledTicketAttachment.deleteMany).toHaveBeenCalledWith({ where: { scheduledTicketId: 9 } });
    expect(deleteIfExists).not.toHaveBeenCalled(); // blobs adopted, never deleted
  });

  test('adoptStaged with nothing staged is a no-op', async () => {
    prismaMock.scheduledTicketAttachment.findMany.mockResolvedValue([]);
    const adopted = await attachmentService.adoptStaged(9, 42, 1);
    expect(adopted).toEqual([]);
    expect(prismaMock.scheduledTicketAttachment.deleteMany).not.toHaveBeenCalled();
  });

  test('discardStaged deletes blobs and rows', async () => {
    prismaMock.scheduledTicketAttachment.findMany.mockResolvedValue(STAGED);
    const result = await attachmentService.discardStaged(9, 1);
    expect(result.discarded).toBe(2);
    expect(deleteIfExists).toHaveBeenCalledTimes(2);
    expect(prismaMock.scheduledTicketAttachment.deleteMany).toHaveBeenCalled();
  });

  test('removeStaged rejects rows outside the schedule/workspace scope', async () => {
    prismaMock.scheduledTicketAttachment.findFirst.mockResolvedValue(null);
    await expect(attachmentService.removeStaged(1, 999, 1)).rejects.toThrow(/not found/i);
  });
});
