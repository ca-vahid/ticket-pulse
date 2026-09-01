import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase AF (AF-B4 / AF-T1) — POST /api/tickets/autofill-extract: multipart
 * caps, mimetype filter, empty-input rejection, native-ticketing gate and the
 * per-actor rate limit. The extraction service itself is mocked.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const extractMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketIntakeExtractService.js', () => ({ default: { extract: extractMock } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { default: ticketsRouter, __resetAutofillRateLimitForTests } = await import('../src/routes/tickets.routes.js');

const AGENT = { email: 'ari@example.com', name: 'Ari Agent', role: 'agent' };

function buildApp(sessionUser = AGENT) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

const RESULT = {
  data: {
    subject: 'Printer jammed',
    description: 'Floor 3 printer jammed.',
    requesterNameOrEmail: null,
    categoryHint: null,
    priorityHint: null,
    typeHint: null,
    peopleMentioned: [],
    sourceSummary: 'Pasted text.',
    confidence: { subject: 0.8, description: 0.7, requester: 0, category: 0, priority: 0, type: 0 },
  },
  meta: { provider: 'anthropic', model: 'claude-sonnet-5', imageCount: 1, textChars: 12 },
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetAutofillRateLimitForTests();
  // Agents (no workspace_access row) get in via an active technician profile.
  prismaMock.technician.findFirst.mockResolvedValue({ id: 3, name: 'Ari Agent' });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: true, defaultTimezone: 'America/Los_Angeles', internalDomains: [] });
  extractMock.mockResolvedValue(RESULT);
});

describe('POST /api/tickets/autofill-extract (Phase AF)', () => {
  test('happy path: text + image reach the service; response is { success, data, meta }', async () => {
    const res = await request(buildApp())
      .post('/api/tickets/autofill-extract')
      .field('text', 'printer jam')
      .attach('images', Buffer.alloc(32, 1), { filename: 'shot.png', contentType: 'image/png' })
      .expect(200);

    expect(res.body).toEqual({ success: true, data: RESULT.data, meta: RESULT.meta });
    expect(extractMock).toHaveBeenCalledTimes(1);
    const args = extractMock.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: 7, text: 'printer jam', actorEmail: 'ari@example.com' });
    expect(args.images).toHaveLength(1);
    expect(args.images[0]).toMatchObject({ mimeType: 'image/png', fileName: 'shot.png' });
    expect(Buffer.isBuffer(args.images[0].buffer)).toBe(true);
    expect(args.images[0].buffer.length).toBe(32);
  });

  test('text-only works; images-only works', async () => {
    await request(buildApp()).post('/api/tickets/autofill-extract').field('text', 'just text').expect(200);
    await request(buildApp()).post('/api/tickets/autofill-extract')
      .attach('images', Buffer.alloc(8), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(extractMock).toHaveBeenCalledTimes(2);
  });

  test('400 when neither text nor images are provided', async () => {
    const res = await request(buildApp()).post('/api/tickets/autofill-extract').field('text', '   ').expect(400);
    expect(res.body.message).toMatch(/Paste some text or add at least one image/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  test('400 when text exceeds 20 000 characters', async () => {
    const res = await request(buildApp()).post('/api/tickets/autofill-extract')
      .field('text', 'a'.repeat(20001)).expect(400);
    expect(res.body.message).toMatch(/20,000 characters/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  test('400 on a non-image upload', async () => {
    const res = await request(buildApp()).post('/api/tickets/autofill-extract')
      .field('text', 'x')
      .attach('images', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(res.body.message).toMatch(/Only JPEG, PNG, GIF or WebP/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  test('400 when a single image exceeds 5 MB', async () => {
    const res = await request(buildApp()).post('/api/tickets/autofill-extract')
      .attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' })
      .expect(400);
    expect(res.body.message).toMatch(/5 MB or smaller/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  test('400 when more than 6 images are sent', async () => {
    let req = request(buildApp()).post('/api/tickets/autofill-extract');
    for (let i = 0; i < 7; i += 1) {
      req = req.attach('images', Buffer.alloc(8), { filename: `s${i}.png`, contentType: 'image/png' });
    }
    const res = await req.expect(400);
    expect(res.body.message).toMatch(/Up to 6 images/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  test('400 when images total more than 20 MB even though each is under 5 MB', async () => {
    let req = request(buildApp()).post('/api/tickets/autofill-extract');
    for (let i = 0; i < 5; i += 1) {
      req = req.attach('images', Buffer.alloc(4.5 * 1024 * 1024), { filename: `s${i}.png`, contentType: 'image/png' });
    }
    const res = await req.expect(400);
    expect(res.body.message).toMatch(/more than 20 MB/);
    expect(extractMock).not.toHaveBeenCalled();
  }, 20000);

  test('400 when native ticketing is off for the workspace', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: false });
    const res = await request(buildApp()).post('/api/tickets/autofill-extract').field('text', 'x').expect(400);
    expect(res.body.message).toMatch(/Native ticketing is not enabled/);
  });

  test('429 with Retry-After after 10 requests in a minute for the same actor; another actor is unaffected', async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/tickets/autofill-extract').field('text', `req ${i}`).expect(200);
    }
    const res = await request(app).post('/api/tickets/autofill-extract').field('text', 'one too many').expect(429);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(res.body.code).toBe('rate_limited');
    expect(extractMock).toHaveBeenCalledTimes(10);

    await request(buildApp({ email: 'bea@example.com', name: 'Bea', role: 'agent' }))
      .post('/api/tickets/autofill-extract').field('text', 'different actor').expect(200);
  });

  test('service errors propagate with their status (503 when no provider is configured)', async () => {
    const { ServiceBusyError } = await import('../src/utils/errors.js');
    extractMock.mockRejectedValue(new ServiceBusyError('No AI provider is configured'));
    const res = await request(buildApp()).post('/api/tickets/autofill-extract').field('text', 'x').expect(503);
    expect(res.body.message).toMatch(/No AI provider/);
  });
});
