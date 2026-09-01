import { jest } from '@jest/globals';

/**
 * MB-1e — subject-token guard, end to end at the unit level:
 *   agent edits the reply subject (Phase SN4) → the backend send path
 *   (effectiveReplySubject, used by _emailRequesterReply) re-appends `[TP-n]`
 *   when it was removed → the requester's mail client prefixes "Re:" →
 *   mailboxIngestService rung 2 matches the ticket again.
 *
 * Both sides are the REAL modules (ticketService's helper + the ingest
 * service); only I/O is mocked.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
  ticketActivity: { findMany: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  workspaceEmailIdentity: { findUnique: jest.fn(), upsert: jest.fn() },
  mailboxConnection: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  userEmailSignature: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const activityMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(), set: jest.fn(), getSendGridConfig: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({}), emitTicketEvent: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueThreadEntry: jest.fn().mockResolvedValue({}), enqueueFieldSync: jest.fn().mockResolvedValue({}), getClient: jest.fn(), getInteractiveClient: jest.fn() },
}));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { isConfigured: jest.fn(() => false), validateUpload: jest.fn(), upload: jest.fn(), ingestForFsTicket: jest.fn() },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({ default: { notify: jest.fn().mockResolvedValue(undefined) } }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: { isConfigured: jest.fn(() => true), getInboxMessagesForIngest: jest.fn(), getMessageAttachments: jest.fn() },
}));

const { effectiveReplySubject, replySubjectDefault } = await import('../src/services/ticketService.js');
const { default: mailboxIngestService } = await import('../src/services/mailboxIngestService.js');

const connection = { id: 5, workspaceId: 5, address: 'patickets@bgcengineering.ca' };
const ticket = {
  id: 9001, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1042, subject: 'Invoice 4471 not paid', ccEmails: [],
  requester: { email: 'rita@example.com' },
};

/** What the requester's client sends back: "Re: " + the subject they received. */
function requesterReply(outboundSubject, extra = {}) {
  return {
    id: 'graph-reply-1',
    subject: `Re: ${outboundSubject}`,
    from: 'rita@example.com',
    fromName: 'Rita Requester',
    receivedAt: new Date(),
    bodyText: 'Thanks — attached the remittance.',
    bodyPreview: 'Thanks — attached the remittance.',
    internetMessageId: '<reply-from-rita@example.com>',
    inReplyTo: null, // client dropped the header (SendGrid-era ack, or a forward) — only the subject remains
    references: null,
    ...extra,
  };
}

function resetIo() {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.findFirst.mockImplementation(({ where }) => Promise.resolve(
    where?.nativeNumber === 1042 && where?.origin === 'ticketpulse' && where?.workspaceId === 5 ? ticket : null,
  ));
  prismaMock.requester.findUnique.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  activityMock.create.mockResolvedValue({});
}

beforeEach(resetIo);

async function ingest(email) {
  const outcome = await mailboxIngestService.processEmail(connection, email);
  const lookups = prismaMock.ticket.findFirst.mock.calls.map((c) => c[0].where);
  return { outcome, lookups };
}

describe('subject-token round trip (MB-1e)', () => {
  test('default subject carries the token and the requester reply matches rung 2', async () => {
    const outbound = replySubjectDefault(ticket);
    expect(outbound).toBe('Re: Invoice 4471 not paid [TP-1042]');

    const { outcome, lookups } = await ingest(requesterReply(outbound));
    expect(outcome).toBe('reply');
    expect(lookups[0]).toEqual({ workspaceId: 5, nativeNumber: 1042, origin: 'ticketpulse' });
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'requester_reply', details: expect.objectContaining({ via: 'tp_ref' }),
    }));
  });

  test('agent rewrites the subject and drops the token → send path re-appends it → reply still matches', async () => {
    const outbound = effectiveReplySubject(ticket, 'Quick follow-up on your remittance');
    expect(outbound).toBe('Quick follow-up on your remittance [TP-1042]');

    const { outcome, lookups } = await ingest(requesterReply(outbound));
    expect(outcome).toBe('reply');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({ nativeNumber: 1042 });
  });

  test('agent keeps the token mid-subject → untouched, never doubled → still matches', async () => {
    const outbound = effectiveReplySubject(ticket, 'Update [TP-1042] — payment released');
    expect(outbound).toBe('Update [TP-1042] — payment released');
    expect((outbound.match(/\[TP-1042\]/g) || []).length).toBe(1);

    const { outcome } = await ingest(requesterReply(outbound));
    expect(outcome).toBe('reply');
  });

  test('CR/LF-injected or blank overrides are cleaned and still tokenized', () => {
    expect(effectiveReplySubject(ticket, 'Line one\r\nBcc: attacker@example.com')).toBe('Line one Bcc: attacker@example.com [TP-1042]');
    expect(effectiveReplySubject(ticket, '   ')).toBe('Re: Invoice 4471 not paid [TP-1042]');
    expect(effectiveReplySubject(ticket, null)).toBe('Re: Invoice 4471 not paid [TP-1042]');
  });

  test('rung 2 tolerates client-side mangling: RE:/AW: stacking, trailing text, lowercase tp, FS-looking refs', async () => {
    const outbound = effectiveReplySubject(ticket, 'Quick follow-up on your remittance');
    for (const subject of [
      `RE: RE: ${outbound}`,
      `AW: ${outbound}`,
      `Re: ${outbound} (see attached)`,
      'Re: quick follow-up [tp-1042]',
      `Re: ${outbound} #224183`, // TP token wins over an FS-looking ref (rung 2 before rung 3)
    ]) {
      resetIo();
      const { outcome, lookups } = await ingest(requesterReply(subject.replace(/^Re: /, '')));
      expect({ subject, outcome }).toEqual({ subject, outcome: 'reply' });
      expect(lookups[0]).toMatchObject({ nativeNumber: 1042, origin: 'ticketpulse' });
    }
  });

  test('a subject with the token stripped by the requester falls off rung 2 (no false match on TP-1042)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null); // rung 4 finds nothing either
    const match = await mailboxIngestService.matchEmailToTicket(5, requesterReply('Quick follow-up on your remittance'), connection.address);
    expect(match).toBeNull();
    const lookups = prismaMock.ticket.findFirst.mock.calls.map((c) => c[0].where);
    expect(lookups.some((w) => w?.nativeNumber === 1042)).toBe(false);
  });
});
