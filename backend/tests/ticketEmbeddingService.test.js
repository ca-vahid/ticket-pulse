import { jest } from '@jest/globals';

/** Ticket embeddings (gap plan 2 P5.2): round-trip, dedupe, cosine ranking, backfill. */

const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketEmbedding: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn().mockResolvedValue({}),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: ticketEmbeddingService, cosineSimilarity, EMBEDDING_MODEL } = await import('../src/services/ticketEmbeddingService.js');

const embedMock = jest.fn();
ticketEmbeddingService._setClient({ embeddings: { create: embedMock } });

const vec = (...v) => v;
const embedResponse = (...vectors) => ({
  data: vectors.map((embedding, index) => ({ index, embedding })),
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketEmbedding.upsert.mockResolvedValue({});
});

describe('cosineSimilarity', () => {
  test('identical direction = 1, orthogonal = 0, mismatched dims = 0', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('upsertForTicket', () => {
  test('embeds subject+description and stores the vector', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, subject: 'Printer jam', descriptionText: 'Paper stuck in tray 2' });
    prismaMock.ticketEmbedding.findUnique.mockResolvedValue(null);
    embedMock.mockResolvedValue(embedResponse(vec(0.1, 0.2, 0.3)));

    const result = await ticketEmbeddingService.upsertForTicket(7, 1);
    expect(result).toEqual({ ticketId: 7, dims: 3 });
    expect(embedMock.mock.calls[0][0].input[0]).toContain('Printer jam');
    const upsert = prismaMock.ticketEmbedding.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ ticketId: 7 });
    expect(upsert.create.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(upsert.create.model).toBe(EMBEDDING_MODEL);
    expect(upsert.create.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('unchanged content hash short-circuits (no API call, no write)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, subject: 'Printer jam', descriptionText: 'Paper stuck in tray 2' });
    prismaMock.ticketEmbedding.findUnique.mockResolvedValue(null);
    embedMock.mockResolvedValue(embedResponse(vec(0.1, 0.2, 0.3)));
    await ticketEmbeddingService.upsertForTicket(7, 1);
    const storedHash = prismaMock.ticketEmbedding.upsert.mock.calls[0][0].create.contentHash;

    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, subject: 'Printer jam', descriptionText: 'Paper stuck in tray 2' });
    prismaMock.ticketEmbedding.findUnique.mockResolvedValue({ contentHash: storedHash, model: EMBEDDING_MODEL });
    const result = await ticketEmbeddingService.upsertForTicket(7, 1);
    expect(result).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
    expect(prismaMock.ticketEmbedding.upsert).not.toHaveBeenCalled();
  });

  test('a ticket with no text is skipped', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, subject: null, descriptionText: '' });
    const result = await ticketEmbeddingService.upsertForTicket(7, 1);
    expect(result).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
  });
});

describe('similarByContent', () => {
  test('ranks candidates by cosine, filters below minScore, respects limit', async () => {
    prismaMock.ticketEmbedding.findUnique.mockResolvedValue({ embedding: vec(1, 0), workspaceId: 1 });
    prismaMock.ticketEmbedding.findMany.mockResolvedValue([
      { ticketId: 11, embedding: vec(0.9, 0.1) },   // very similar
      { ticketId: 12, embedding: vec(0, 1) },       // orthogonal — below minScore
      { ticketId: 13, embedding: vec(0.7, 0.4) },   // similar
    ]);
    const result = await ticketEmbeddingService.similarByContent(7, 1, { limit: 5, minScore: 0.5 });
    expect(result.map((r) => r.ticketId)).toEqual([11, 13]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
    // workspace scoping in the candidate query
    const where = prismaMock.ticketEmbedding.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(1);
    expect(where.ticketId).toEqual({ not: 7 });
  });

  test('a cross-workspace embedding row is never used', async () => {
    prismaMock.ticketEmbedding.findUnique.mockResolvedValue({ embedding: vec(1, 0), workspaceId: 2 });
    const result = await ticketEmbeddingService.similarByContent(7, 1);
    expect(result).toEqual([]);
    expect(prismaMock.ticketEmbedding.findMany).not.toHaveBeenCalled();
  });
});

describe('backfillWorkspace', () => {
  test('embeds missing tickets in one batched API call', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 21, subject: 'A', descriptionText: 'aaa' },
      { id: 22, subject: 'B', descriptionText: 'bbb' },
      { id: 23, subject: null, descriptionText: null }, // no text — dropped
    ]);
    embedMock.mockResolvedValue(embedResponse(vec(1, 0), vec(0, 1)));

    const result = await ticketEmbeddingService.backfillWorkspace(1);
    expect(result).toEqual({ embedded: 2, scanned: 3 });
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0][0].input).toHaveLength(2);
    expect(prismaMock.ticketEmbedding.upsert).toHaveBeenCalledTimes(2);
    // only tickets without an embedding row are scanned
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.embedding).toBeNull();
  });
});
