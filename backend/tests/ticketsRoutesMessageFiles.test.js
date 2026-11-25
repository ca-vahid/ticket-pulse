import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-16: POST /:id/forward takes files (multipart, `to` comma-separated)
 * and the composer HTML as `noteHtml`; a message carries up to 20 files
 * (was 5: 7 of 12 pasted screenshots were lost), and going over is a 400
 * with a plain sentence, not a 500.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketServiceMock = {
  forwardTicket: jest.fn(async () => ({ entry: { id: 1 } })),
  addPrivateNote: jest.fn(async () => ({ entry: { id: 2 }, attachments: [] })),
  addReply: jest.fn(async () => ({ entry: { id: 3 }, attachments: [] })),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
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

const { default: ticketsRouter, MAX_FILES_PER_MESSAGE } = await import('../src/routes/tickets.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' } }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: true, defaultTimezone: 'America/Vancouver', internalDomains: [] });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
});

describe('POST /api/tickets/:id/forward (QA 11-16)', () => {
  test('JSON forward: to, note and noteHtml reach the service, no files', async () => {
    await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['ops@example.com'], note: 'See this', noteHtml: '<p>See <a href="https://x.example.com">this</a></p>' })
      .expect(201);
    const [id, ws, input, , files] = ticketServiceMock.forwardTicket.mock.calls[0];
    expect([id, ws]).toEqual([501, 7]);
    expect(input).toEqual({ to: ['ops@example.com'], note: 'See this', noteHtml: '<p>See <a href="https://x.example.com">this</a></p>' });
    expect(files).toEqual([]);
  });

  test('multipart forward: comma-separated to, and the files', async () => {
    await request(buildApp()).post('/api/tickets/501/forward')
      .field('to', 'ops@example.com, lead@example.com')
      .field('noteHtml', '<p>Quote attached</p>')
      .attach('files', Buffer.from('%PDF-1.4'), 'quote.pdf')
      .attach('files', Buffer.from('png'), 'pasted-image-1.png')
      .expect(201);
    const [, , input, , files] = ticketServiceMock.forwardTicket.mock.calls[0];
    expect(input.to).toEqual(['ops@example.com', 'lead@example.com']);
    expect(input.noteHtml).toBe('<p>Quote attached</p>');
    expect(files.map((f) => f.originalname)).toEqual(['quote.pdf', 'pasted-image-1.png']);
  });

  // QA 11-24 #5: the ticket's own files go along.
  test('includeAttachmentIds reach the service, from JSON and from a form field', async () => {
    await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['eng@example.com'], includeAttachmentIds: [12, 14, 12] })
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[0][2].includeAttachmentIds).toEqual([12, 14]);
    await request(buildApp()).post('/api/tickets/501/forward')
      .field('to', 'eng@example.com')
      .field('includeAttachmentIds', '12,14')
      .attach('files', Buffer.from('%PDF-1.4'), 'quote.pdf')
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[1][2].includeAttachmentIds).toEqual([12, 14]);
  });

  test('includePrivateAttachments rides only when set (JSON true or the form\'s "true"), and only with ids', async () => {
    await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['eng@example.com'], includeAttachmentIds: [12] })
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[0][2]).not.toHaveProperty('includePrivateAttachments');
    await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['eng@example.com'], includeAttachmentIds: [12], includePrivateAttachments: true })
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[1][2].includePrivateAttachments).toBe(true);
    await request(buildApp()).post('/api/tickets/501/forward')
      .field('to', 'eng@example.com').field('includeAttachmentIds', '12').field('includePrivateAttachments', 'true')
      .attach('files', Buffer.from('%PDF-1.4'), 'quote.pdf')
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[2][2].includePrivateAttachments).toBe(true);
    await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['eng@example.com'], includePrivateAttachments: true })
      .expect(201);
    expect(ticketServiceMock.forwardTicket.mock.calls[3][2]).not.toHaveProperty('includePrivateAttachments');
  });

  test('an id that is not a number is a 400, nothing forwarded', async () => {
    const res = await request(buildApp()).post('/api/tickets/501/forward')
      .send({ to: ['eng@example.com'], includeAttachmentIds: ['12', 'abc'] })
      .expect(400);
    expect(res.body.message).toMatch(/list of attachment ids/);
    expect(ticketServiceMock.forwardTicket).not.toHaveBeenCalled();
  });
});

describe('POST /api/tickets/:id/replies to someone who is not the requester (QA 11-24 #7/#8)', () => {
  test('replyToEntryId + replyToEmail ride as an option, never inside the body input', async () => {
    await request(buildApp()).post('/api/tickets/501/replies')
      .send({ bodyText: 'Thanks Tim', replyToEntryId: 88, replyToEmail: 'tim@example.com' })
      .expect(201);
    const [, , input, , files, options] = ticketServiceMock.addReply.mock.calls[0];
    expect(input).toEqual({ bodyText: 'Thanks Tim' });
    expect(files).toEqual([]);
    expect(options).toEqual({ replyToParticipant: { entryId: 88, email: 'tim@example.com' } });
  });

  test('multipart replies carry it too; a plain reply passes no option', async () => {
    await request(buildApp()).post('/api/tickets/501/replies')
      .field('bodyText', 'See attached')
      .field('replyToEntryId', '88')
      .attach('files', Buffer.from('%PDF-1.4'), 'po.pdf')
      .expect(201);
    expect(ticketServiceMock.addReply.mock.calls[0][5]).toEqual({ replyToParticipant: { entryId: 88, email: null } });
    await request(buildApp()).post('/api/tickets/501/replies').send({ bodyText: 'Hello' }).expect(201);
    expect(ticketServiceMock.addReply.mock.calls[1]).toHaveLength(5);
  });
});

describe('files per message (QA 11-16 #3)', () => {
  test('a note with twelve pasted screenshots reaches the service with all twelve', async () => {
    let req = request(buildApp()).post('/api/tickets/601/notes').field('bodyText', 'Screens');
    for (let i = 1; i <= 12; i += 1) req = req.attach('files', Buffer.from(`img${i}`), `pasted-image-${i}.png`);
    await req.expect(201);
    expect(ticketServiceMock.addPrivateNote.mock.calls[0][4]).toHaveLength(12);
  });

  test('more than the limit is a 400 that says the limit', async () => {
    expect(MAX_FILES_PER_MESSAGE).toBe(20);
    let req = request(buildApp()).post('/api/tickets/601/replies').field('bodyText', 'Too many');
    for (let i = 1; i <= MAX_FILES_PER_MESSAGE + 1; i += 1) req = req.attach('files', Buffer.from(`f${i}`), `f${i}.png`);
    const res = await req.expect(400);
    expect(res.body.message).toBe('A message can carry up to 20 files.');
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  });

  test('a message declaring more than 150 MB in all is refused before anything is read (review: memory)', async () => {
    const res = await request(buildApp()).post('/api/tickets/601/replies')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .set('Content-Length', String(151 * 1024 * 1024))
      .send('')
      .catch((err) => err.response);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('One message can carry up to 150 MB of files in all.');
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
  });
});
