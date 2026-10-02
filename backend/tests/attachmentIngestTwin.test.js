import { jest } from '@jest/globals';

/**
 * 2 Oct 2026 (ticket 61323): a picture an agent pasted into a note in Ticket
 * Pulse came back from the FreshService conversation sync as a second
 * attachment on the same note. The FS copy is skipped when the entry already
 * has a file with the same name and size.
 */
const prismaMock = {
  ticketAttachment: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 2 }) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: attachmentService } = await import('../src/services/attachmentService.js');
const fsAttachment = { id: 555, name: 'pasted-image-1.png', size: 57829, content_type: 'image/png' };

describe('ingestFreshServiceAttachment — twin of a Ticket Pulse upload', () => {
  beforeEach(() => { prismaMock.ticketAttachment.create.mockClear(); });
  test('same entry + name + size already there → skipped', async () => {
    prismaMock.ticketAttachment.findFirst.mockResolvedValueOnce({ id: 1 });
    const out = await attachmentService.ingestFreshServiceAttachment({ workspaceId: 1, ticketId: 61323, threadEntryId: 3590261, fsAttachment });
    expect(out).toBeNull();
    expect(prismaMock.ticketAttachment.create).not.toHaveBeenCalled();
    expect(prismaMock.ticketAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { threadEntryId: 3590261, fileName: 'pasted-image-1.png', sizeBytes: 57829 } }));
  });
  test('no twin → stored as before', async () => {
    prismaMock.ticketAttachment.findFirst.mockResolvedValueOnce(null);
    await attachmentService.ingestFreshServiceAttachment({ workspaceId: 1, ticketId: 61323, threadEntryId: 3590261, fsAttachment });
    expect(prismaMock.ticketAttachment.create).toHaveBeenCalledTimes(1);
  });
  test('ticket-level files (no entry) are not checked', async () => {
    prismaMock.ticketAttachment.findFirst.mockClear();
    await attachmentService.ingestFreshServiceAttachment({ workspaceId: 1, ticketId: 61323, fsAttachment });
    expect(prismaMock.ticketAttachment.findFirst).not.toHaveBeenCalled();
  });
});
