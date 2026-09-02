import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase AP (09-02) — the public approval magic-link router
 * (/api/ticket-approvals/public/:token): payload passthrough, the new photo
 * route (address resolved server-side, binary response, 404 when none), the
 * decide response shape, and the per-IP-per-token rate limit.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const approvalServiceMock = {
  getByToken: jest.fn(),
  decideByToken: jest.fn(),
  photoSubjectEmail: jest.fn(),
};
const azureAdMock = { isConfigured: jest.fn(() => true), getUserPhoto: jest.fn(), getUserProfile: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
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
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketApprovalService.js', () => ({ default: approvalServiceMock }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { ticketApprovalPublicRouter, resetPublicApprovalRateLimit, PUBLIC_APPROVAL_RATE_LIMIT, decodePhotoDataUri } = await import('../src/routes/tickets.routes.js');

const TOKEN = 'a'.repeat(43);
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ticket-approvals/public', ticketApprovalPublicRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPublicApprovalRateLimit();
  approvalServiceMock.getByToken.mockResolvedValue({
    approval: { id: 2, status: 'pending', approverEmail: 'bob@x.io' },
    ticket: { id: 501, displayRef: 'TP-77' },
    approvers: [{ name: 'Bob', status: 'pending', isYou: true, decidedAt: null }],
    meta: { viewedAt: '2026-09-02T00:00:00.000Z' },
  });
  azureAdMock.getUserPhoto.mockResolvedValue(null);
});

describe('GET /api/ticket-approvals/public/:token', () => {
  test('returns the service payload, never cached', async () => {
    const res = await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}`).expect(200);
    expect(approvalServiceMock.getByToken).toHaveBeenCalledWith(TOKEN);
    expect(res.body.data.approvers).toEqual([{ name: 'Bob', status: 'pending', isYou: true, decidedAt: null }]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('service errors keep their status (invalid link → 404)', async () => {
    const err = new Error('This approval link is not valid');
    err.statusCode = 404;
    approvalServiceMock.getByToken.mockRejectedValue(err);
    const res = await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}`).expect(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/ticket-approvals/public/:token/photo', () => {
  test('streams the directory photo for the address the ROW resolves — a query email is ignored', async () => {
    approvalServiceMock.photoSubjectEmail.mockResolvedValue('jane@x.io');
    azureAdMock.getUserPhoto.mockResolvedValue(`data:image/png;base64,${PNG_1X1}`);

    const res = await request(buildApp())
      .get(`/api/ticket-approvals/public/${TOKEN}/photo?who=requestedBy&email=attacker@evil.io`)
      .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
      .expect(200);

    expect(approvalServiceMock.photoSubjectEmail).toHaveBeenCalledWith(TOKEN, 'requestedBy');
    expect(azureAdMock.getUserPhoto).toHaveBeenCalledTimes(1);
    expect(azureAdMock.getUserPhoto).toHaveBeenCalledWith('jane@x.io');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(Buffer.from(PNG_1X1, 'base64'))).toBe(true);
  });

  test('404 when the person has no photo (and the null is cached)', async () => {
    approvalServiceMock.photoSubjectEmail.mockResolvedValue('nophoto@x.io');
    azureAdMock.getUserPhoto.mockResolvedValue(null);
    await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}/photo?who=requester`).expect(404);
    await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}/photo?who=requester`).expect(404);
    expect(azureAdMock.getUserPhoto).toHaveBeenCalledTimes(1);
  });

  test('404 when the row has no usable address for that person', async () => {
    approvalServiceMock.photoSubjectEmail.mockResolvedValue(null);
    await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}/photo?who=requester`).expect(404);
    expect(azureAdMock.getUserPhoto).not.toHaveBeenCalled();
  });

  test('rejects an unknown `who` (no email lookup ever happens)', async () => {
    const res = await request(buildApp()).get(`/api/ticket-approvals/public/${TOKEN}/photo?who=someone@x.io`).expect(400);
    expect(res.body.message).toMatch(/who must be/);
    expect(approvalServiceMock.photoSubjectEmail).not.toHaveBeenCalled();
  });

  test('decodePhotoDataUri only accepts image data URIs', () => {
    expect(decodePhotoDataUri(`data:image/jpeg;base64,${PNG_1X1}`)?.contentType).toBe('image/jpeg');
    expect(decodePhotoDataUri('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(decodePhotoDataUri('https://x/y.png')).toBeNull();
    expect(decodePhotoDataUri(null)).toBeNull();
  });
});

describe('POST /api/ticket-approvals/public/:token/decide', () => {
  test('returns status, decidedAt and the resolved approverName', async () => {
    approvalServiceMock.decideByToken.mockResolvedValue({ status: 'approved', decidedAt: '2026-09-02T01:00:00.000Z', approverName: 'Bob Builder', tokenHash: 'never' });
    const res = await request(buildApp()).post(`/api/ticket-approvals/public/${TOKEN}/decide`).send({ decision: 'approved' }).expect(200);
    expect(approvalServiceMock.decideByToken).toHaveBeenCalledWith(TOKEN, 'approved', null, null);
    expect(res.body.data).toEqual({ status: 'approved', decidedAt: '2026-09-02T01:00:00.000Z', approverName: 'Bob Builder' });
  });

  test('a rejection without a reason surfaces the service 400', async () => {
    const err = new Error('Add a reason for rejecting');
    err.statusCode = 400;
    approvalServiceMock.decideByToken.mockRejectedValue(err);
    const res = await request(buildApp()).post(`/api/ticket-approvals/public/${TOKEN}/decide`).send({ decision: 'rejected' }).expect(400);
    expect(res.body.message).toBe('Add a reason for rejecting');
  });
});

describe('rate limit (60/min per IP per token prefix)', () => {
  test('the 61st request in a minute is a problem-style 429 with Retry-After', async () => {
    const app = buildApp();
    for (let i = 0; i < PUBLIC_APPROVAL_RATE_LIMIT.max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/api/ticket-approvals/public/${TOKEN}`).expect(200);
    }
    const res = await request(app).get(`/api/ticket-approvals/public/${TOKEN}`).expect(429);
    expect(res.body).toMatchObject({ success: false, title: 'Too many requests', status: 429, error: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    // The service is not hit once the limit trips.
    expect(approvalServiceMock.getByToken).toHaveBeenCalledTimes(PUBLIC_APPROVAL_RATE_LIMIT.max);
  });

  test('a different token has its own budget', async () => {
    const app = buildApp();
    for (let i = 0; i <= PUBLIC_APPROVAL_RATE_LIMIT.max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/api/ticket-approvals/public/${TOKEN}`);
    }
    await request(app).get(`/api/ticket-approvals/public/${'z'.repeat(43)}`).expect(200);
  });

  test('the photo and decide routes share the token budget', async () => {
    const app = buildApp();
    approvalServiceMock.photoSubjectEmail.mockResolvedValue(null);
    for (let i = 0; i < PUBLIC_APPROVAL_RATE_LIMIT.max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/api/ticket-approvals/public/${TOKEN}/photo?who=requester`).expect(404);
    }
    await request(app).post(`/api/ticket-approvals/public/${TOKEN}/decide`).send({ decision: 'approved' }).expect(429);
    expect(approvalServiceMock.decideByToken).not.toHaveBeenCalled();
  });
});
