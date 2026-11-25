import { jest } from '@jest/globals';

// 25 Nov 2026: removing an attachment deletes the stored file and its row, and now
// leaves a History line and a live refresh. The extras are best-effort.

const prismaMock = {
  ticketAttachment: { findFirst: jest.fn(), delete: jest.fn() },
  ticketActivity: { create: jest.fn() },
};
const deleteIfExists = jest.fn();
const broadcast = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast } }));

const { default: attachmentService } = await import('../src/services/attachmentService.js');

const ROW = { id: 76995, ticketId: 122363, workspaceId: 1, fileName: 'teams-picture-1.png', displayName: null, sizeBytes: 111381, blobName: 'ws1/t122363/abc', uploadedBy: 'v@x.ca' };
const ME = { email: 'v@x.ca', name: 'Vahid Haeri', role: 'agent', workspaceRole: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  attachmentService._containerClient = { getBlockBlobClient: () => ({ deleteIfExists }) };
  prismaMock.ticketAttachment.findFirst.mockResolvedValue(ROW);
  prismaMock.ticketAttachment.delete.mockResolvedValue(ROW);
  prismaMock.ticketActivity.create.mockResolvedValue({ id: 1 });
});

test('removing a file writes an attachment_removed History row with who and which file', async () => {
  await expect(attachmentService.remove(76995, 122363, 1, ME)).resolves.toEqual({ removed: true });
  expect(deleteIfExists).toHaveBeenCalled();
  expect(prismaMock.ticketAttachment.delete).toHaveBeenCalledWith({ where: { id: 76995 } });
  const row = prismaMock.ticketActivity.create.mock.calls[0][0].data;
  expect(row).toMatchObject({ ticketId: 122363, activityType: 'attachment_removed', performedBy: 'Vahid Haeri' });
  expect(row.details).toMatchObject({ attachmentId: 76995, fileName: 'teams-picture-1.png', actorEmail: 'v@x.ca', actorKind: 'human' });
  expect(broadcast).toHaveBeenCalledWith('ticket-change', expect.objectContaining({ action: 'attachment_removed', ticketId: 122363 }), 1);
});

test('a failed History row never fails the removal', async () => {
  prismaMock.ticketActivity.create.mockRejectedValue(new Error('db hiccup'));
  await expect(attachmentService.remove(76995, 122363, 1, ME)).resolves.toEqual({ removed: true });
  expect(prismaMock.ticketAttachment.delete).toHaveBeenCalled();
});

test('someone who is neither the uploader nor an admin is refused, and nothing is written', async () => {
  await expect(attachmentService.remove(76995, 122363, 1, { email: 'other@x.ca', name: 'Other', role: 'agent', workspaceRole: 'member' }))
    .rejects.toThrow('Only the uploader or an admin can remove an attachment');
  expect(deleteIfExists).not.toHaveBeenCalled();
  expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
});
