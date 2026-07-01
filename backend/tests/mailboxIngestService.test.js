import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
};
const graphMock = {
  isConfigured: jest.fn(() => true),
  getInboxMessagesForIngest: jest.fn(),
};
const ticketServiceMock = { createTicket: jest.fn() };
const mirrorServiceMock = { enqueueThreadEntry: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: mailboxIngestService, looksLikeLoopMail, referencedMessageIds } =
  await import('../src/services/mailboxIngestService.js');

const connection = { id: 1, workspaceId: 1, address: 'helpdesk-pilot@example.com' };
const baseEmail = {
  id: 'msg-1',
  subject: 'Printer on 3rd floor jammed',
  from: 'rita@example.com',
  fromName: 'Rita Requester',
  receivedAt: new Date(),
  bodyHtml: '<p>It is jammed again</p>',
  bodyText: 'It is jammed again',
  bodyPreview: 'It is jammed again',
  internetMessageId: '<abc-123@example.com>',
  inReplyTo: null,
  references: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.update.mockResolvedValue({});
  ticketServiceMock.createTicket.mockResolvedValue({ id: 700, displayRef: 'TP-1100', workspaceId: 1 });
});

describe('loop protection', () => {
  test('flags self-sends, automated senders, autoreplies, bulk precedence', () => {
    expect(looksLikeLoopMail({ from: 'helpdesk-pilot@example.com', subject: 'x' }, connection.address)).toBe('self_send');
    expect(looksLikeLoopMail({ from: 'no-reply@vendor.com', subject: 'x' }, connection.address)).toBe('automated_sender');
    expect(looksLikeLoopMail({ from: 'MAILER-DAEMON@mx.example.com', subject: 'x' }, connection.address)).toBe('automated_sender');
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'Automatic reply: hi' }, connection.address)).toBe('autoreply_subject');
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'x', autoSubmitted: 'auto-replied' }, connection.address)).toBe('auto_submitted_header');
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'x', precedence: 'bulk' }, connection.address)).toBe('bulk_precedence');
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'Real issue' }, connection.address)).toBeNull();
  });

  test('referencedMessageIds parses In-Reply-To and References', () => {
    expect(referencedMessageIds({ inReplyTo: '<a@x>', references: '<b@x> <c@x>' })).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(referencedMessageIds({})).toEqual([]);
  });
});

describe('matching ladder', () => {
  test('1: threading headers match a stored outbound Message-ID', async () => {
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null) // dedupe check
      .mockResolvedValueOnce({ ticketId: 501 }); // header match
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: anything at all', inReplyTo: '<sent-by-tp@example.com>',
    });

    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'email_inbound',
        authorType: 'requester',
        incoming: true,
        emailMessageId: '<abc-123@example.com>',
        mirrorState: 'pending',
      }),
    }));
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 501, 9001);
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('2: TP-<n> subject ref matches the native ticket', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ id: 502, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: Projector [TP-1042]',
    });

    expect(outcome).toBe('reply');
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ nativeNumber: 1042, origin: 'ticketpulse' }),
    }));
  });

  test('3: FreshService #ref is skipped (FS ingests the same mail itself)', async () => {
    // Subject has no TP ref, so the FIRST ticket.findFirst call is the FS lookup.
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 900 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: [#224183] VPN issue',
    });

    expect(outcome).toBe('skipped');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('4: sender + recency matches an open TP-born ticket', async () => {
    // No TP/FS refs in the subject → the only ticket.findFirst call is sender+recency.
    prismaMock.ticket.findFirst.mockResolvedValueOnce({
      id: 503, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1050, status: 'Open',
    });

    const outcome = await mailboxIngestService.processEmail(connection, { ...baseEmail, subject: 'more info' });
    expect(outcome).toBe('reply');
  });

  test('no match → creates a TP-born ticket with the sender as requester', async () => {
    const outcome = await mailboxIngestService.processEmail(connection, baseEmail);

    expect(outcome).toBe('created');
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({
      subject: 'Printer on 3rd floor jammed',
      requesterEmail: 'rita@example.com',
      requesterName: 'Rita Requester',
      runAiTriage: true,
    }), expect.objectContaining({ role: 'system' }));
    // Original message id remembered for future threading
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ emailMessageId: '<abc-123@example.com>', eventType: 'original_email' }),
    }));
  });

  test('exact message dedupe: an already-ingested internetMessageId is skipped', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce({ id: 1 }); // dedupe hit
    const outcome = await mailboxIngestService.processEmail(connection, baseEmail);
    expect(outcome).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('per-sender create cap prevents runaway loops', async () => {
    const senderCreates = new Map([['rita@example.com', 3]]);
    const outcome = await mailboxIngestService.processEmail(connection, baseEmail, senderCreates);
    expect(outcome).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });
});
