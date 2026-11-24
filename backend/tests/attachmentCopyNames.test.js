import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

/**
 * 4.4.08 review: a merge or split copies an attachment onto another ticket
 * (attachmentService.copyToTicket). The copy keeps the display name, its source
 * and details, so the new ticket shows the same name and a Revert there still
 * gives back the vendor's original file name.
 */
const prismaMock = {
  ticketAttachment: {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(async ({ data }) => ({ id: 900, ...data })),
  },
};
const uploadData = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: () => ({
      getContainerClient: () => ({
        getBlockBlobClient: () => ({
          download: async () => ({ readableStreamBody: Readable.from([Buffer.from('%PDF invented')]) }),
          uploadData,
        }),
      }),
    }),
  },
}));

process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
const { default: attachmentService } = await import('../src/services/attachmentService.js');

const original = {
  id: 501, workspaceId: 2, ticketId: 1042, threadEntryId: null, fileName: 'INV-100234.pdf', contentType: 'application/pdf',
  sizeBytes: 13, blobName: 'ws-2/ticket-1042/abc-INV-100234.pdf', source: 'email', uploadedBy: 'billing@acme.example',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('copyToTicket keeps the display name', () => {
  test('a renamed file\'s copy carries displayName, nameSource, nameDetails', async () => {
    const named = {
      ...original,
      displayName: 'Acme Supplies_INV-100234_2026_11_23.pdf',
      nameSource: 'auto',
      nameDetails: { vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', method: 'rules' },
      namedAt: new Date('2026-11-23T18:05:00Z'),
      namedBy: 'Ticket Pulse',
    };
    await attachmentService.copyToTicket(named, { ticketId: 2001, uploadedBy: 'dana.fox@ourco.example' });
    const { data } = prismaMock.ticketAttachment.create.mock.calls[0][0];
    expect(data).toMatchObject({
      ticketId: 2001,
      fileName: 'INV-100234.pdf',
      source: 'copy',
      displayName: 'Acme Supplies_INV-100234_2026_11_23.pdf',
      nameSource: 'auto',
      nameDetails: { vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', method: 'rules' },
      namedBy: 'Ticket Pulse',
    });
  });

  test('a file that was never named copies with no name fields', async () => {
    await attachmentService.copyToTicket({ ...original, displayName: null, nameSource: null, nameDetails: { outcome: 'no_vendor' } }, { ticketId: 2001 });
    const { data } = prismaMock.ticketAttachment.create.mock.calls[0][0];
    expect(data).not.toHaveProperty('displayName');
    expect(data).not.toHaveProperty('nameSource');
  });

  test('a reverted file\'s copy stays reverted (never auto-named again)', async () => {
    await attachmentService.copyToTicket({ ...original, displayName: null, nameSource: 'reverted', nameDetails: { vendor: 'Acme Supplies' } }, { ticketId: 2001 });
    const { data } = prismaMock.ticketAttachment.create.mock.calls[0][0];
    expect(data).toMatchObject({ displayName: null, nameSource: 'reverted' });
  });
});
