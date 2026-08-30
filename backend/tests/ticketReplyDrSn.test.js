import { jest } from '@jest/globals';

/**
 * Mega 08-30 — Phase DR (DR3 idempotency, DR4 FS actor attribution flag) and
 * Phase SN (agent sender name on requester replies, editable reply subject)
 * through ticketService.addReply / addPrivateNote.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  workspaceEmailIdentity: { findUnique: jest.fn(), upsert: jest.fn() },
  mailboxConnection: { findFirst: jest.fn() },
  userEmailSignature: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const settingsRepositoryMock = {
  get: jest.fn(),
  set: jest.fn(),
  getSendGridConfig: jest.fn(),
};
const sendgridMock = { sendEmail: jest.fn() };
const fsClientMock = { createReply: jest.fn(), addNote: jest.fn() };
const mirrorServiceMock = {
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
};
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({}), emitTicketEvent: emitTicketEventMock },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { isConfigured: jest.fn(() => true), validateUpload: jest.fn(), upload: jest.fn(), ingestForFsTicket: jest.fn() },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService, effectiveReplySubject, replySubjectDefault, cleanReplySubject } = await import('../src/services/ticketService.js');
const { clearSenderIdentityCache } = await import('../src/services/workspaceEmailIdentityService.js');
const { invalidateFsReplyAsAgentCache } = await import('../src/services/fsReplyAsAgentService.js');
const { formatSender } = await import('../src/utils/emailSender.js');
const { ValidationError } = await import('../src/utils/errors.js');

const agent = { email: 'soheil@example.com', name: 'Soheil Nasiri', role: 'viewer', workspaceRole: 'member', technicianId: 7, kind: 'member' };

const nativeTicket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Laptop will not boot',
  status: 'Open',
  priority: 3,
  createdAt: new Date('2026-07-01T10:00:00Z'),
  assignedTechId: null,
  firstPublicAgentReplyAt: null,
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
};
const fsTicket = { ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(239470) };

let nextEntryId;
beforeEach(() => {
  jest.clearAllMocks();
  clearSenderIdentityCache();
  invalidateFsReplyAsAgentCache();
  nextEntryId = 9001;
  prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: nextEntryId++, ...data }));
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.create.mockResolvedValue({});
  prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue(null);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Soheil Nasiri', freshserviceId: BigInt(1002090731) });
  settingsRepositoryMock.get.mockResolvedValue(null);
  settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ fromEmail: 'ticketpulse@bgcengineering.ca', fromName: 'Ticket Pulse IT' });
  sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
  fsClientMock.createReply.mockResolvedValue({ conversation: { id: 1042916725 } });
  fsClientMock.addNote.mockResolvedValue({ conversation: { id: 1042916726 } });
});

// --------------------------------------------------------------- Phase SN
describe('agent sender name on requester replies (SN1/SN3)', () => {
  test('fromName = the replying agent\'s name; replyTo stays undefined', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const call = sendgridMock.sendEmail.mock.calls[0][0];
    expect(call.fromName).toBe('Soheil Nasiri');
    expect(call.replyTo).toBeUndefined();
    expect(formatSender({ name: call.fromName, email: 'ticketpulse@bgcengineering.ca' }))
      .toBe('"Soheil Nasiri" <ticketpulse@bgcengineering.ca>');
  });

  test('toggle off → the workspace identity; replyTo still undefined', async () => {
    prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue({ fromName: 'Ticket Pulse IT', replyUsesAgentName: false });

    await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);

    const call = sendgridMock.sendEmail.mock.calls[0][0];
    expect(call.fromName).toBe('Ticket Pulse IT');
    expect(call.replyTo).toBeUndefined();
  });

  test('actor without a usable name → workspace identity fallback', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'hi' }, { email: 'coord@example.com', name: null, role: 'viewer' });
    expect(sendgridMock.sendEmail.mock.calls[0][0].fromName).toBe('Ticket Pulse IT');
  });

  test('CRLF / angle-bracket injection in the actor name is neutralised on the wire', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'hi' }, { ...agent, name: 'Evil\r\nBcc: victim@example.com <spoof>' });
    const call = sendgridMock.sendEmail.mock.calls[0][0];
    expect(call.fromName).not.toMatch(/[\r\n<>]/);
    expect(formatSender({ name: call.fromName, email: 'ticketpulse@bgcengineering.ca' }))
      .toBe('"Evil Bcc: victim@example.com spoof" <ticketpulse@bgcengineering.ca>');
  });
});

// --------------------------------------------------------------- Phase SN4
describe('editable reply subject (SN4/SN6)', () => {
  test('no override → the default `Re: <subject> [TP-n]`, no subject in rawPayload', async () => {
    const { entry } = await ticketService.addReply(501, 1, { bodyText: 'hi', cc: ['boss@example.com'] }, agent);
    expect(sendgridMock.sendEmail.mock.calls[0][0].subject).toBe('Re: Laptop will not boot [TP-1042]');
    expect(entry.rawPayload).toEqual({ to_emails: ['rita@example.com'], cc_emails: ['boss@example.com'] });
  });

  test('override without the token → token appended; persisted merged with to/cc', async () => {
    const { entry } = await ticketService.addReply(501, 1, {
      bodyText: 'hi', cc: ['boss@example.com'], subject: 'Your laptop is ready for pickup',
    }, agent);
    expect(sendgridMock.sendEmail.mock.calls[0][0].subject).toBe('Your laptop is ready for pickup [TP-1042]');
    expect(entry.rawPayload).toEqual({
      to_emails: ['rita@example.com'],
      cc_emails: ['boss@example.com'],
      subject: 'Your laptop is ready for pickup [TP-1042]',
    });
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: 'Your laptop is ready for pickup [TP-1042]' }),
    }));
  });

  test('override that already carries the token is not doubled', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'hi', subject: 'Re: Laptop will not boot [TP-1042] — update' }, agent);
    expect(sendgridMock.sendEmail.mock.calls[0][0].subject).toBe('Re: Laptop will not boot [TP-1042] — update');
  });

  test('CR/LF in the subject is stripped (header injection guard)', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'hi', subject: 'Pickup\r\nBcc: victim@example.com' }, agent);
    const subject = sendgridMock.sendEmail.mock.calls[0][0].subject;
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe('Pickup Bcc: victim@example.com [TP-1042]');
  });

  test('a subject over 255 characters is rejected', async () => {
    await expect(ticketService.addReply(501, 1, { bodyText: 'hi', subject: 'x'.repeat(256) }, agent))
      .rejects.toThrow(ValidationError);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('FS-born + subject → ValidationError, createReply never called, nothing stored', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    await expect(ticketService.addReply(501, 1, { bodyText: 'hi', subject: 'Custom' }, agent))
      .rejects.toThrow(/FreshService composes the subject/);
    expect(fsClientMock.createReply).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('a subject on an internal note is rejected too (never silently dropped)', async () => {
    await expect(ticketService.addPrivateNote(501, 1, { bodyText: 'hi', subject: 'Custom' }, agent))
      .rejects.toThrow(ValidationError);
  });

  test('helpers: default / effective / clean', () => {
    expect(replySubjectDefault(nativeTicket)).toBe('Re: Laptop will not boot [TP-1042]');
    expect(replySubjectDefault(fsTicket)).toBeNull();
    expect(effectiveReplySubject(nativeTicket, '  ')).toBe('Re: Laptop will not boot [TP-1042]');
    expect(effectiveReplySubject(nativeTicket, 'Done [TP-1042]')).toBe('Done [TP-1042]');
    expect(cleanReplySubject(' a\r\n b  c ')).toBe('a b c');
  });
});

// --------------------------------------------------------------- Phase DR3
describe('POST idempotency (DR3/DR5)', () => {
  test('a replay with the same Idempotency-Key returns the existing entry and sends nothing', async () => {
    const first = await ticketService.addReply(501, 1, { bodyText: 'We are on it!', idempotencyKey: 'k-123' }, agent);
    expect(first.deduped).toBeUndefined();
    expect(first.entry.rawPayload).toEqual({ to_emails: ['rita@example.com'], idempotencyKey: 'k-123' });
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);

    // The "DB" now holds the first entry (occurredAt = just now).
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ...first.entry }]);
    const replay = await ticketService.addReply(501, 1, { bodyText: 'We are on it!', idempotencyKey: 'k-123' }, agent);

    expect(replay.deduped).toBe(true);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.email).toEqual({ sent: false, deduped: true });
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        ticketId: 501, workspaceId: 1, source: 'ticketpulse_user', eventType: 'reply', actorEmail: 'soheil@example.com',
        occurredAt: { gte: expect.any(Date) },
      }),
    }));
  });

  test('the same body within the window dedupes even WITHOUT a key (double-click)', async () => {
    const first = await ticketService.addReply(501, 1, { bodyText: 'Same words' }, agent);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ...first.entry }]);
    const replay = await ticketService.addReply(501, 1, { bodyText: 'Same  words ' }, agent);
    expect(replay.deduped).toBe(true);
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('a different body is a new reply', async () => {
    const first = await ticketService.addReply(501, 1, { bodyText: 'First' }, agent);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ...first.entry }]);
    const second = await ticketService.addReply(501, 1, { bodyText: 'Second' }, agent);
    expect(second.deduped).toBeUndefined();
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(2);
  });

  test('FS-born replay: createReply is called once, the twin is returned', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    const first = await ticketService.addReply(501, 1, { bodyText: 'hello from TP', idempotencyKey: 'k-fs' }, agent);
    expect(first.entry.externalEntryId).toBe('fs-conversation:1042916725');
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ...first.entry }]);

    const replay = await ticketService.addReply(501, 1, { bodyText: 'hello from TP', idempotencyKey: 'k-fs' }, agent);

    expect(replay.deduped).toBe(true);
    expect(fsClientMock.createReply).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
  });

  test('notes dedupe on their own kind — a note never collides with a reply of the same text', async () => {
    const reply = await ticketService.addReply(501, 1, { bodyText: 'Same text' }, agent);
    // The lookup for a NOTE filters eventType:'note' — the reply row is not returned.
    prismaMock.ticketThreadEntry.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.eventType === 'reply' ? [{ ...reply.entry }] : [],
    ));
    const note = await ticketService.addPrivateNote(501, 1, { bodyText: 'Same text' }, agent);
    expect(note.deduped).toBeUndefined();
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(2);

    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ...note.entry }]);
    const noteReplay = await ticketService.addPrivateNote(501, 1, { bodyText: 'Same text' }, agent);
    expect(noteReplay.deduped).toBe(true);
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(2);
  });

  test('a failed dedupe lookup never blocks the send (fail-open)', async () => {
    prismaMock.ticketThreadEntry.findMany.mockRejectedValue(new Error('db hiccup'));
    const result = await ticketService.addReply(501, 1, { bodyText: 'still goes' }, agent);
    expect(result.deduped).toBeUndefined();
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------- Phase DR4
describe('FS reply-as-agent flag (DR4, default OFF)', () => {
  test('flag off (default): createReply gets NO user_id', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    await ticketService.addReply(501, 1, { bodyText: 'hi' }, agent);
    expect(fsClientMock.createReply).toHaveBeenCalledWith(239470, expect.any(String), { ccEmails: [], attachments: [] });
    expect(prismaMock.technician.findFirst).not.toHaveBeenCalled();
  });

  test('flag on: the acting technician\'s FS id rides as userId on replies AND notes', async () => {
    settingsRepositoryMock.get.mockImplementation(async (key) => (key === 'fs_reply_as_agent_ws1' ? '1' : null));
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });

    await ticketService.addReply(501, 1, { bodyText: 'hi' }, agent);
    expect(fsClientMock.createReply).toHaveBeenCalledWith(239470, expect.any(String), { ccEmails: [], attachments: [], userId: 1002090731 });

    await ticketService.addPrivateNote(501, 1, { bodyText: 'note' }, agent);
    expect(fsClientMock.addNote).toHaveBeenCalledWith(239470, expect.any(String), { isPrivate: true, attachments: [], userId: 1002090731 });
  });

  test('flag on but the actor is a local (non-FS) agent → no user_id', async () => {
    settingsRepositoryMock.get.mockResolvedValue('1');
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, freshserviceId: null });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    await ticketService.addReply(501, 1, { bodyText: 'hi' }, agent);
    expect(fsClientMock.createReply).toHaveBeenCalledWith(239470, expect.any(String), { ccEmails: [], attachments: [] });
  });

  test('flag on, actor without a technician mapping → no user_id', async () => {
    settingsRepositoryMock.get.mockResolvedValue('1');
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    await ticketService.addReply(501, 1, { bodyText: 'hi' }, { ...agent, technicianId: null });
    expect(fsClientMock.createReply).toHaveBeenCalledWith(239470, expect.any(String), { ccEmails: [], attachments: [] });
  });
});
