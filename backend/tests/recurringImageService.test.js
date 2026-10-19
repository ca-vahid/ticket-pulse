import { jest } from '@jest/globals';

/** Signature logos (19 Oct 2026): an image that arrives by mail on many tickets is not a file of the ticket. */

const prismaMock = { $queryRaw: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { markRecurring, recurringImageKeys, resetRecurringImageCache } = await import('../src/services/recurringImageService.js');

beforeEach(() => {
  resetRecurringImageCache();
  prismaMock.$queryRaw.mockReset();
});

describe('recurring images', () => {
  test('the logo seen on many tickets is marked; a pasted upload of the same size and other files are not', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ content_type: 'image/png', size_bytes: 39593 }]);
    const rows = await markRecurring(1, [
      { id: 1, fileName: 'picture-1-9Z0AAA-image001.png', contentType: 'image/png', sizeBytes: 39593, source: 'email' },
      { id: 2, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 39593, source: 'upload' },
      { id: 3, fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 39593, source: 'email' },
      { id: 4, fileName: 'screenshot.png', contentType: 'image/png', sizeBytes: 120000, source: 'freshservice' },
    ]);
    expect(rows.map((r) => Boolean(r.recurring))).toEqual([true, false, false, false]);
  });

  test('the lookup is cached per workspace and a failure leaves nothing marked', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await recurringImageKeys(1);
    await recurringImageKeys(1);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    prismaMock.$queryRaw.mockRejectedValue(new Error('db down'));
    const rows = await markRecurring(2, [{ id: 1, contentType: 'image/png', sizeBytes: 5, source: 'email' }]);
    expect(rows[0].recurring).toBeUndefined();
  });

  test('no rows, no query', async () => {
    expect(await markRecurring(1, [])).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
