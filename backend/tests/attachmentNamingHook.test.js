import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 4.4.08: where e-mail files are stored (mailboxIngestService._captureAttachments)
 * hands each stored row to the naming queue, with the e-mail and the file's
 * inline flag. Mail intake never waits for it, and a naming failure never
 * fails intake.
 */
const prismaMock = { workspace: { findUnique: jest.fn() }, mailboxConnection: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() } };
let nextId = 100;
const upload = jest.fn(async (args) => ({ id: nextId++, source: args.source, fileName: args.fileName, contentType: args.contentType }));
const queueEmailAttachment = jest.fn(() => Promise.resolve(true));

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/agentIntakeService.js', () => ({ default: { resolveAgentSender: jest.fn(), prepareAgentContext: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { isConfigured: () => true, upload } }));
jest.unstable_mockModule('../src/services/attachmentNamingService.js', () => ({ queueEmailAttachment, default: { queueEmailAttachment } }));

const { default: svc } = await import('../src/services/mailboxIngestService.js');

const connection = { id: 1, workspaceId: 2, address: 'ap@ourco.example' };
const email = { id: 'AAMk', subject: 'New Invoice from Acme Supplies', from: 'noreply@getbalance.com', fromName: 'Acme Supplies via Balance', hasAttachments: true };
const flush = () => new Promise((r) => { setTimeout(r, 0); });

beforeEach(() => { jest.clearAllMocks(); });

describe('e-mail attachments go to the naming queue', () => {
  test('each stored file is queued with the e-mail; inline pictures are marked inline', async () => {
    const prefetched = {
      skipped: [],
      files: [
        { name: 'INV-100234.pdf', contentType: 'application/pdf', buffer: Buffer.from('x'), isInline: false },
        { name: 'image001.png', inlineName: 'picture-1-AAMk-image001.png', contentType: 'image/png', buffer: Buffer.from('y'), isInline: true },
      ],
    };
    const notice = await svc._captureAttachments(connection, email, { id: 1042, workspaceId: 2 }, 7, prefetched);
    await flush();
    expect(notice).toBe('');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toMatchObject({ source: 'email', fileName: 'INV-100234.pdf' });
    expect(queueEmailAttachment).toHaveBeenCalledTimes(2);
    expect(queueEmailAttachment.mock.calls[0][0]).toMatchObject({ fileName: 'INV-100234.pdf', source: 'email' });
    expect(queueEmailAttachment.mock.calls[0][1]).toEqual({ email, isInline: false });
    expect(queueEmailAttachment.mock.calls[1][1]).toMatchObject({ isInline: true });
  });

  test('a naming failure never fails intake', async () => {
    queueEmailAttachment.mockImplementationOnce(() => { throw new Error('boom'); });
    const prefetched = { skipped: [], files: [{ name: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('x'), isInline: false }] };
    const notice = await svc._captureAttachments(connection, email, { id: 1042, workspaceId: 2 }, null, prefetched);
    await flush();
    expect(notice).toBe('');
  });
});
