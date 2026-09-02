import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const holdMock = { holdMessage: jest.fn(), isKnownMessageId: jest.fn() };
const graphMock = {
  isConfigured: jest.fn(() => true),
  getInboxMessagesForIngest: jest.fn(),
};
const ticketServiceMock = { createTicket: jest.fn() };
const mirrorServiceMock = { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn() };
const activityMock = { create: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
// RL-4 hold queue is built in parallel — mocked virtually against its contract.
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({ default: holdMock }), { virtual: true });
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: mailboxIngestService, looksLikeLoopMail, referencedMessageIds, emailRecipients,
  plusAddressTicketNumbers, mergeInboundCc, MAX_CC_EMAILS,
} = await import('../src/services/mailboxIngestService.js');

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
  prismaMock.requester.findUnique.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  mailboxIngestService._heldMessageIds.clear();
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  mirrorServiceMock.enqueueFieldSync.mockResolvedValue({});
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
    }), expect.objectContaining({ role: 'system' }),
    // Email-born tickets carry their arrival channel (QA 07-07 #1).
    expect.objectContaining({ sourceChannel: 1 }));
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

// QA 08-05 #3 — Cc visibility: graphMailClient already fetches to/cc; ingest
// must PERSIST them (ticket row for creates, rawPayload for thread entries)
// instead of discarding them.
describe('recipient capture', () => {
  test('emailRecipients normalizes, lowercases, dedupes, drops non-addresses, nulls when empty', () => {
    expect(emailRecipients({
      to: ['Helpdesk@Example.com', 'helpdesk@example.com', 'not-an-address'],
      cc: ['Boss@Example.com', ' peer@example.com '],
    })).toEqual({
      to_emails: ['helpdesk@example.com'],
      cc_emails: ['boss@example.com', 'peer@example.com'],
    });
    expect(emailRecipients({ to: [], cc: [] })).toBeNull();
    expect(emailRecipients({})).toBeNull();
    expect(emailRecipients(null)).toBeNull();
  });

  test('created tickets persist To/Cc onto the ticket row and the original-email entry', async () => {
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail,
      to: ['helpdesk-pilot@example.com'],
      cc: ['Boss@Example.com', 'boss@example.com'],
    });

    expect(outcome).toBe('created');
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 700 },
      data: {
        toEmails: ['helpdesk-pilot@example.com'],
        ccEmails: ['boss@example.com'],
      },
    });
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'original_email',
        rawPayload: {
          to_emails: ['helpdesk-pilot@example.com'],
          cc_emails: ['boss@example.com'],
        },
      }),
    }));
  });

  test('created tickets without to/cc touch neither the row nor rawPayload', async () => {
    const outcome = await mailboxIngestService.processEmail(connection, baseEmail);

    expect(outcome).toBe('created');
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.eventType).toBe('original_email');
    expect(data.rawPayload).toBeUndefined();
  });

  test('ingested replies stash {to_emails, cc_emails} in rawPayload', async () => {
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null) // dedupe check
      .mockResolvedValueOnce({ ticketId: 501 }); // header match
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail,
      subject: 'Re: anything at all',
      inReplyTo: '<sent-by-tp@example.com>',
      to: ['helpdesk-pilot@example.com'],
      cc: ['peer@example.com'],
    });

    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'reply',
        rawPayload: {
          to_emails: ['helpdesk-pilot@example.com'],
          cc_emails: ['peer@example.com'],
        },
      }),
    }));
  });

  test('replies without recipients omit rawPayload entirely', async () => {
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ticketId: 501 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: anything at all', inReplyTo: '<sent-by-tp@example.com>',
    });

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toBeUndefined();
  });
});

// MB-1c — rung 1.5: the plus-addressed Reply-To (`mailbox+tp<n>@`) comes back
// on the reply's recipients and resolves the ticket without any header or
// subject signal.
describe('plus-address reply token (rung 1.5)', () => {
  test('plusAddressTicketNumbers parses To/Cc/Delivered-To/X-Original-To, requires our mailbox as base', () => {
    expect(plusAddressTicketNumbers({ to: ['helpdesk-pilot+tp1042@example.com'] }, connection.address)).toEqual([1042]);
    expect(plusAddressTicketNumbers({ to: ['Help Desk <Helpdesk-Pilot+TP1042@Example.com>'] }, connection.address)).toEqual([1042]);
    expect(plusAddressTicketNumbers({ to: ['rita@example.com'], cc: ['helpdesk-pilot+tp7@example.com'] }, connection.address)).toEqual([7]);
    expect(plusAddressTicketNumbers({ deliveredTo: 'helpdesk-pilot+tp1042@example.com' }, connection.address)).toEqual([1042]);
    expect(plusAddressTicketNumbers({ xOriginalTo: 'helpdesk-pilot+tp1042@example.com, other@example.com' }, connection.address)).toEqual([1042]);
    // Distinct, encounter order (To before Cc)
    expect(plusAddressTicketNumbers({
      to: ['helpdesk-pilot+tp1042@example.com'], cc: ['helpdesk-pilot+tp1042@example.com', 'helpdesk-pilot+tp9@example.com'],
    }, connection.address)).toEqual([1042, 9]);
    // A tag on someone else's mailbox is not ours; other +tags are not tickets
    expect(plusAddressTicketNumbers({ to: ['other+tp1042@example.com'] }, connection.address)).toEqual([]);
    expect(plusAddressTicketNumbers({ to: ['helpdesk-pilot+tp1042@evil.com'] }, connection.address)).toEqual([]);
    expect(plusAddressTicketNumbers({ to: ['helpdesk-pilot+newsletter@example.com', 'helpdesk-pilot@example.com'] }, connection.address)).toEqual([]);
    expect(plusAddressTicketNumbers({ to: ['helpdesk-pilot+tp0@example.com'] }, connection.address)).toEqual([]);
    // Without a mailbox to anchor on, any +tp tag counts
    expect(plusAddressTicketNumbers({ to: ['whoever+tp55@anywhere.org'] })).toEqual([55]);
    expect(plusAddressTicketNumbers({})).toEqual([]);
  });

  test('1.5: a reply addressed to mailbox+tp<n>@ threads onto TP-<n> with no headers and a free-form subject', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 504, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail,
      subject: 'Re: quick question',
      to: ['helpdesk-pilot+tp1042@example.com'],
    });

    expect(outcome).toBe('reply');
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 1, nativeNumber: 1042, origin: 'ticketpulse' },
    });
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'requester_reply',
      details: expect.objectContaining({ via: 'plus_address' }),
    }));
  });

  test('1.5 sits between the header rung and the subject rung', async () => {
    // Header rung wins when present…
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ticketId: 501 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1 });
    await mailboxIngestService.processEmail(connection, {
      ...baseEmail, inReplyTo: '<sent-by-tp@example.com>', to: ['helpdesk-pilot+tp1042@example.com'], subject: 'Re: x [TP-2000]',
    });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();

    // …and the plus tag beats a conflicting subject token.
    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9002, ...data }));
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 505, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });
    await mailboxIngestService.processEmail(connection, {
      ...baseEmail, to: ['helpdesk-pilot+tp1042@example.com'], subject: 'Re: x [TP-2000]',
    });
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: 1, nativeNumber: 1042, origin: 'ticketpulse' });
  });

  test('a stale plus tag (ticket gone) falls through to the later rungs', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(null) // rung 1.5 — TP-999 no longer exists
      .mockResolvedValueOnce({ id: 506, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 }); // rung 2
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, to: ['helpdesk-pilot+tp999@example.com'], subject: 'Re: printer [TP-1042]',
    });
    expect(outcome).toBe('reply');
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledTimes(2);
  });
});

// MB-1d — inbound Cc merge: people the requester loops in mid-thread join
// Ticket.ccEmails (≤10, same normalization as the manual editor), with the
// same cc_changed audit the manual editor writes.
describe('inbound Cc merge (reply path)', () => {
  const replyEmail = (extra) => ({
    ...baseEmail, subject: 'Re: anything at all', inReplyTo: '<sent-by-tp@example.com>', ...extra,
  });
  const matchHeaderRung = (ticket) => {
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null) // dedupe check
      .mockResolvedValueOnce({ ticketId: ticket.id }); // header match
    prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  };

  test('mergeInboundCc: unions To (minus the mailbox) + Cc, skips excludes/dupes/malformed, appends up to the cap', () => {
    const merged = mergeInboundCc(['Existing@Example.com'], {
      to: ['Helpdesk-Pilot@Example.com', 'helpdesk-pilot+tp1042@example.com', 'Rita@Example.com', 'newperson@example.com'],
      cc: ['Boss <boss@example.com>', 'existing@example.com', 'agent@example.com', 'not-an-address', 'newperson@example.com'],
    }, { mailboxAddress: 'helpdesk-pilot@example.com', exclude: ['rita@example.com', 'AGENT@example.com'] });
    expect(merged).toEqual({
      previous: ['existing@example.com'],
      next: ['existing@example.com', 'newperson@example.com', 'boss@example.com'],
      added: ['newperson@example.com', 'boss@example.com'],
      dropped: [],
    });

    const nine = Array.from({ length: 9 }, (_, i) => `p${i}@example.com`);
    const capped = mergeInboundCc(nine, { cc: ['a@example.com', 'b@example.com'] }, { mailboxAddress: 'helpdesk-pilot@example.com' });
    expect(capped.next).toHaveLength(MAX_CC_EMAILS);
    expect(capped.added).toEqual(['a@example.com']);
    expect(capped.dropped).toEqual(['b@example.com']);

    expect(mergeInboundCc([], {}, { mailboxAddress: 'helpdesk-pilot@example.com' })).toEqual({ previous: [], next: [], added: [], dropped: [] });
  });

  test('new Cc on a matched reply lands on the ticket row, audits cc_changed, and re-mirrors', async () => {
    matchHeaderRung({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, requesterId: 55, ccEmails: ['existing@example.com'] });
    prismaMock.requester.findUnique.mockResolvedValue({ email: 'Rita@Example.com' });
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'agent@example.com' }]);

    const outcome = await mailboxIngestService.processEmail(connection, replyEmail({
      to: ['helpdesk-pilot@example.com', 'rita@example.com', 'agent@example.com', 'newperson@example.com'],
      cc: ['Boss@Example.com', 'existing@example.com'],
    }));

    expect(outcome).toBe('reply');
    expect(prismaMock.requester.findUnique).toHaveBeenCalledWith({ where: { id: 55 }, select: { email: true } });
    expect(prismaMock.technician.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, email: { in: ['rita@example.com', 'agent@example.com', 'newperson@example.com', 'boss@example.com'], mode: 'insensitive' } },
      select: { email: true },
    });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({
        ccEmails: ['existing@example.com', 'newperson@example.com', 'boss@example.com'],
        mirrorState: 'pending',
      }),
    }));
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      activityType: 'cc_changed',
      performedBy: 'Ticket Pulse Mail',
      details: expect.objectContaining({
        source: 'email_inbound',
        from: ['existing@example.com'],
        to: ['existing@example.com', 'newperson@example.com', 'boss@example.com'],
        added: ['newperson@example.com', 'boss@example.com'],
        replyFrom: 'rita@example.com',
      }),
    }));
    expect(mirrorServiceMock.enqueueFieldSync).toHaveBeenCalledWith(1, 501);
  });

  test('nothing new (only mailbox/existing addressed) → no cc write, no audit, no lookups', async () => {
    matchHeaderRung({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, requesterId: 55, ccEmails: ['peer@example.com'] });

    await mailboxIngestService.processEmail(connection, replyEmail({
      to: ['helpdesk-pilot+tp1042@example.com'],
      cc: ['peer@example.com'],
    }));

    const { data } = prismaMock.ticket.update.mock.calls[0][0];
    expect(data.ccEmails).toBeUndefined();
    expect(data.mirrorState).toBeUndefined();
    expect(prismaMock.requester.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'cc_changed' }));
    expect(mirrorServiceMock.enqueueFieldSync).not.toHaveBeenCalled();
  });

  test('the ≤10 cap holds: a 9-list accepts one and audits the overflow; a full list accepts nothing', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `p${i}@example.com`);
    matchHeaderRung({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, ccEmails: nine });

    await mailboxIngestService.processEmail(connection, replyEmail({ cc: ['a@example.com', 'b@example.com'] }));

    const { data } = prismaMock.ticket.update.mock.calls[0][0];
    expect(data.ccEmails).toEqual([...nine, 'a@example.com']);
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'cc_changed',
      details: expect.objectContaining({ added: ['a@example.com'], droppedOverCap: ['b@example.com'] }),
    }));

    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data: d }) => Promise.resolve({ id: 9003, ...d }));
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.requester.findUnique.mockResolvedValue(null);
    prismaMock.technician.findMany.mockResolvedValue([]);
    matchHeaderRung({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, ccEmails: [...nine, 'p9@example.com'] });
    await mailboxIngestService.processEmail(connection, replyEmail({ cc: ['a@example.com'] }));
    expect(prismaMock.ticket.update.mock.calls[0][0].data.ccEmails).toBeUndefined();
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'cc_changed' }));
  });

  test('FS-born tickets never get their FreshService-owned ccEmails touched', async () => {
    matchHeaderRung({ id: 801, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 224183n, ccEmails: [] });

    await mailboxIngestService.processEmail(connection, replyEmail({ cc: ['newperson@example.com'] }));

    expect(prismaMock.ticket.update.mock.calls[0][0].data.ccEmails).toBeUndefined();
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'cc_changed' }));
  });

  test('a merge lookup failure is non-fatal — the reply still lands', async () => {
    matchHeaderRung({ id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, requesterId: 55, ccEmails: [] });
    prismaMock.requester.findUnique.mockRejectedValue(new Error('db down'));

    const outcome = await mailboxIngestService.processEmail(connection, replyEmail({ cc: ['newperson@example.com'] }));

    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalled();
    expect(prismaMock.ticket.update.mock.calls[0][0].data.ccEmails).toBeUndefined();
  });
});

// Rung 1b — workflow acknowledgement emails have no thread entry; their
// Message-ID lives in notification_deliveries.provider_message_id.
describe('notification-delivery Message-ID (rung 1b)', () => {
  test('a reply to a ticket.created ack matches through notification_deliveries', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null); // dedupe miss + rung 1 miss
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({ ticketId: 601 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 601, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1200 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail,
      subject: 'Re: We received your request',
      inReplyTo: '<ack-42@mailbox.example>',
      references: '<older@x>',
    });

    expect(outcome).toBe('reply');
    // RL-5: one OR query over provider_message_id + message_id (the RFC id
    // the SendGrid lane stores); falls back to provider-only pre-migration.
    const ids = ['<ack-42@mailbox.example>', '<older@x>', 'ack-42@mailbox.example', 'older@x'];
    expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 1, OR: [{ providerMessageId: { in: ids } }, { messageId: { in: ids } }] },
      select: { ticketId: true },
      orderBy: { id: 'desc' },
    });
    expect(prismaMock.ticket.findUnique).toHaveBeenCalledWith({ where: { id: 601 } });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled(); // never reached 1.5/2
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'requester_reply', details: expect.objectContaining({ via: 'notification_delivery' }),
    }));
  });

  test('no delivery match falls through to rung 1.5 / rung 2; no headers → no delivery query at all', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce(null);
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 602, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, inReplyTo: '<unknown@elsewhere>', to: ['helpdesk-pilot+tp1042@example.com'], subject: 'Re: hi',
    });
    expect(outcome).toBe('reply');
    expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: 1, nativeNumber: 1042, origin: 'ticketpulse' });
    // the matcher's bare lookup never ran (downstream notify hooks do their own include/select reads)
    expect(prismaMock.ticket.findUnique.mock.calls.some((c) => !c[0].include && !c[0].select)).toBe(false);

    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9004, ...data }));
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 603, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042 });
    await mailboxIngestService.processEmail(connection, { ...baseEmail, subject: 'RE: Projector [TP-1042]' });
    expect(prismaMock.notificationDelivery.findFirst).not.toHaveBeenCalled();
  });
});

// Mega 09-01 Phase FW (agent forwards keep the original requester) + RL-3
// (agent-Cc intake carve-out, reply-evidence hold) — ingest half.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'forwards');
const forwardFixture = (name) => readFileSync(path.join(fixturesDir, name), 'utf8');
const AGENT = { id: 7, name: 'Alex Agent', email: 'alex.agent@bgcengineering.ca' };
const RITA = 'rita.requester@customer.example';

describe('agent forwards (Phase FW)', () => {
  const asAgent = () => prismaMock.technician.findFirst.mockResolvedValue(AGENT);
  const forwardEmail = (fixture, extra = {}) => ({
    ...baseEmail,
    id: 'msg-fw',
    subject: 'FW: Invoice 4471 still unpaid',
    from: AGENT.email,
    fromName: AGENT.name,
    to: ['helpdesk-pilot@example.com'],
    cc: [],
    bodyHtml: forwardFixture(fixture),
    bodyText: null,
    bodyPreview: 'Hi team, please open a ticket for Rita',
    internetMessageId: '<fwd-1@bgcengineering.ca>',
    ...extra,
  });

  test('agent + Outlook forward → original sender is the requester, description is the sliced original', async () => {
    asAgent();
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html'));

    expect(outcome).toBe('created');
    const [ws, input, actor, options] = ticketServiceMock.createTicket.mock.calls[0];
    expect(ws).toBe(1);
    expect(actor).toEqual(expect.objectContaining({ role: 'system' }));
    expect(options).toEqual({ sourceChannel: 1, createdVia: 'forward' });
    expect(input.requesterEmail).toBe(RITA);
    expect(input.requesterName).toBe('Rita Requester');
    expect(input.subject).toBe('Invoice 4471 still unpaid'); // the original subject, no FW:
    expect(input.description).toMatch(/Invoice <b>4471<\/b> from July/);
    expect(input.description).not.toMatch(/divRplyFwdMsg|<b>From:<\/b>|please open a ticket/);
    expect(input.ccEmails).toBeUndefined(); // agents are never Cc'd

    // Original-email entry: actor = the requester, occurredAt = the quoted date, Message-ID kept.
    const original = prismaMock.ticketThreadEntry.create.mock.calls.map((c) => c[0].data).find((d) => d.eventType === 'original_email');
    expect(original).toEqual(expect.objectContaining({
      actorEmail: RITA, actorName: 'Rita Requester', authorType: 'requester', incoming: true,
      emailMessageId: '<fwd-1@bgcengineering.ca>', externalEntryId: 'graph-msg-fw',
    }));
    expect(original.occurredAt.toISOString()).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(original.rawPayload.forwarded).toEqual(expect.objectContaining({
      kind: 'forward', byEmail: AGENT.email, byName: AGENT.name, byTechnicianId: 7,
      originalFrom: RITA, originalSubject: 'Invoice 4471 still unpaid', client: 'outlook_owa', sliced: true, parser: 'v1',
      originalTo: ['alex.agent@bgcengineering.ca'], originalCc: ['boss@customer.example', 'pat.peer@customer.example'],
    }));
    expect(original.rawPayload.cc_emails).toEqual(['boss@customer.example', 'pat.peer@customer.example']);

    // The agent's covering note → PRIVATE agent entry.
    const note = prismaMock.ticketThreadEntry.create.mock.calls.map((c) => c[0].data).find((d) => d.eventType === 'note');
    expect(note).toEqual(expect.objectContaining({
      actorEmail: AGENT.email, authorType: 'agent', isPrivate: true, visibility: 'private', incoming: false, mirrorState: 'pending',
    }));
    expect(note.bodyText).toMatch(/^Hi team, please open a ticket for Rita/);
    expect(note.bodyText).not.toMatch(/Invoice 4471 from July/);

    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 700,
      activityType: 'forwarded_intake',
      performedBy: 'Ticket Pulse Mail',
      details: expect.objectContaining({ byEmail: AGENT.email, byTechnicianId: 7, originalFrom: RITA, client: 'outlook_owa', sliced: true, entryId: 9001 }),
    }));
    // Rung 4 never ran against the agent (no sender+recency lookup for alex@).
    const recencyCalls = prismaMock.ticket.findFirst.mock.calls.filter((c) => c[0].where?.requester);
    for (const call of recencyCalls) expect(call[0].where.requester.is.email.equals).toBe(RITA);
  });

  test('non-agent FW: → unchanged (sender is the requester, no forwarded meta)', async () => {
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html', { from: 'someone@customer.example', fromName: 'Some One' }));
    expect(outcome).toBe('created');
    const [, input, , options] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.requesterEmail).toBe('someone@customer.example');
    expect(input.subject).toBe('FW: Invoice 4471 still unpaid');
    expect(options).toEqual({ sourceChannel: 1, createdVia: 'email' });
    const original = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(original.rawPayload?.forwarded).toBeUndefined();
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'forwarded_intake' }));
  });

  test('agent + unparseable forward → unchanged + system note + forwarded_intake_unparsed', async () => {
    asAgent();
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('signature-with-From-line.html', { subject: 'FW: September close date?' }));
    expect(outcome).toBe('created');
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.requesterEmail).toBe(AGENT.email);
    expect(input.subject).toBe('FW: September close date?');
    const note = prismaMock.ticketThreadEntry.create.mock.calls.map((c) => c[0].data).find((d) => d.eventType === 'note');
    expect(note).toEqual(expect.objectContaining({ isPrivate: true, authorType: 'system' }));
    expect(note.bodyText).toMatch(/could not identify the original sender \(no header block\)/);
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'forwarded_intake_unparsed',
      details: expect.objectContaining({ byEmail: AGENT.email, reason: 'no_header_block' }),
    }));
  });

  test('original sender == the agent → unchanged (agent is the requester) + unparsed note', async () => {
    asAgent();
    const html = forwardFixture('outlook-owa.html').replace(/Rita Requester &lt;rita\.requester@customer\.example&gt;/, 'Alex Agent &lt;alex.agent@bgcengineering.ca&gt;');
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html', { bodyHtml: html }));
    expect(outcome).toBe('created');
    expect(ticketServiceMock.createTicket.mock.calls[0][1].requesterEmail).toBe(AGENT.email);
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'forwarded_intake_unparsed', details: expect.objectContaining({ reason: 'original_is_agent' }),
    }));
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'forwarded_intake' }));
  });

  test('agent forward with a TP-<n> subject → ingestReply with forwarded meta (prefix stripped for rung 2)', async () => {
    asAgent();
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 610, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1204, ccEmails: [] });
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html', { subject: 'FW: Invoice 4471 still unpaid [TP-1204]' }));

    expect(outcome).toBe('reply');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: 1, nativeNumber: 1204, origin: 'ticketpulse' });
    const entry = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(entry).toEqual(expect.objectContaining({
      ticketId: 610, eventType: 'reply', actorEmail: AGENT.email, authorType: 'agent', incoming: true, isPrivate: false,
      emailMessageId: '<fwd-1@bgcengineering.ca>',
    }));
    expect(entry.rawPayload.forwarded).toEqual(expect.objectContaining({ kind: 'forward', byTechnicianId: 7, originalFrom: RITA, sliced: false }));
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'requester_reply', details: expect.objectContaining({ via: 'tp_ref', forwardedBy: AGENT.email, originalFrom: RITA }),
    }));
  });

  test('rung 4 for an agent forward runs against the ORIGINAL sender, never the agent', async () => {
    asAgent();
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 611, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1300, status: 'Open', ccEmails: [] });
    const outcome = await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html'));
    expect(outcome).toBe('reply');
    const recency = prismaMock.ticket.findFirst.mock.calls.find((c) => c[0].where?.requester);
    expect(recency[0].where.requester.is.email.equals).toBe(RITA);
    expect(prismaMock.ticket.findFirst.mock.calls.some((c) => c[0].where?.requester?.is?.email?.equals === AGENT.email)).toBe(false);
  });
});

describe('agent Cc intake + hold decisions (Phase RL-3)', () => {
  const asAgent = () => prismaMock.technician.findFirst.mockResolvedValue(AGENT);
  const agentReply = (extra = {}) => ({
    ...baseEmail,
    id: 'msg-cc',
    subject: 'RE: Invoice 4471 still unpaid',
    from: AGENT.email,
    fromName: AGENT.name,
    to: [RITA],
    cc: ['helpdesk-pilot@example.com'],
    // The agent's Outlook reply quotes Rita's original mail underneath.
    bodyHtml: forwardFixture('reply-not-forward.html')
      .replace('Ticket Pulse &lt;patickets@bgcengineering.ca&gt;', 'Rita Requester &lt;rita.requester@customer.example&gt;')
      .replace('<b>To:</b> Rita Requester &lt;rita.requester@customer.example&gt;', '<b>To:</b> Alex Agent &lt;alex.agent@bgcengineering.ca&gt;'),
    bodyText: null,
    bodyPreview: 'Thanks — attached is the remittance.',
    internetMessageId: '<agent-reply-1@bgcengineering.ca>',
    inReplyTo: '<never-seen@customer.example>',
    references: '<never-seen@customer.example>',
    ...extra,
  });

  test('agent From + external To + mailbox Cc + unknown References → ticket for the requester, agent text = public agent entry, assigned, ack suppressed', async () => {
    asAgent();
    const outcome = await mailboxIngestService.processEmail(connection, agentReply());

    expect(outcome).toBe('created');
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    const [, input, actor, options] = ticketServiceMock.createTicket.mock.calls[0];
    expect(actor).toEqual(expect.objectContaining({ role: 'system' }));
    expect(options).toEqual({ sourceChannel: 1, createdVia: 'agent_cc' });
    expect(input).toEqual(expect.objectContaining({
      requesterEmail: RITA,
      requesterName: 'Rita Requester', // from the quoted From: block
      subject: 'Invoice 4471 still unpaid',
      assignedTechId: 7,
      aiClassifyOnly: true,
      runAiTriage: false,
      notifyRequester: true, suppressRequesterAck: true,
    }));
    expect(input.description).toMatch(/we are looking into invoice 4471/); // the quoted original
    expect(input.description).not.toMatch(/attached is the remittance/);

    const entries = prismaMock.ticketThreadEntry.create.mock.calls.map((c) => c[0].data);
    const original = entries.find((d) => d.eventType === 'original_email');
    expect(original).toEqual(expect.objectContaining({ actorEmail: RITA, authorType: 'requester', incoming: true }));
    expect(original.emailMessageId).toBeUndefined();
    const agentEntry = entries.find((d) => d.eventType === 'reply');
    expect(agentEntry).toEqual(expect.objectContaining({
      actorEmail: AGENT.email, actorName: AGENT.name, authorType: 'agent', incoming: false, isPrivate: false, visibility: 'public',
      emailMessageId: '<agent-reply-1@bgcengineering.ca>', externalEntryId: 'graph-msg-cc', mirrorState: 'pending',
    }));
    expect(agentEntry.bodyText).toMatch(/^Thanks — attached is the remittance/);
    expect(agentEntry.rawPayload).toEqual(expect.objectContaining({
      deliveryState: 'external',
      to_emails: [RITA], cc_emails: ['helpdesk-pilot@example.com'],
      agentIntake: expect.objectContaining({ kind: 'agent_cc', technicianId: 7, requester: RITA }),
    }));
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'agent_cc_intake',
      details: expect.objectContaining({ byTechnicianId: 7, requester: RITA, assigned: true, requesterAckSuppressed: true, viaQuotedFrom: true }),
    }));
    // Rung 4 ran against the external recipient, never the agent.
    const recency = prismaMock.ticket.findFirst.mock.calls.find((c) => c[0].where?.requester);
    expect(recency[0].where.requester.is.email.equals).toBe(RITA);
  });

  test('the requester\'s later reply-all (In-Reply-To = the agent mail\'s Message-ID) threads via rung 1', async () => {
    prismaMock.ticketThreadEntry.findFirst
      .mockResolvedValueOnce(null) // dedupe
      .mockResolvedValueOnce({ ticketId: 700 }); // rung 1 hit on the agent entry's emailMessageId
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 700, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1100, ccEmails: [] });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, id: 'msg-rr', from: RITA, fromName: 'Rita Requester', subject: 'RE: Invoice 4471 still unpaid',
      to: [AGENT.email], cc: ['helpdesk-pilot@example.com'], inReplyTo: '<agent-reply-1@bgcengineering.ca>',
      internetMessageId: '<rita-2@customer.example>',
    });
    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.findFirst.mock.calls[1][0].where.emailMessageId).toEqual({ in: ['<agent-reply-1@bgcengineering.ca>'] });
    const entry = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(entry).toEqual(expect.objectContaining({ ticketId: 700, authorType: 'requester', incoming: true, actorEmail: RITA }));
  });

  test('agentCcIntake=false → rule 2 is OFF: held with the address chooser instead', async () => {
    asAgent();
    const outcome = await mailboxIngestService.processEmail({ ...connection, agentCcIntake: false }, agentReply());
    expect(outcome).toBe('held');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(holdMock.holdMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 'msg-cc' }), expect.objectContaining({
      reason: 'agent_reply_no_requester', candidates: [{ email: RITA }], decision: expect.objectContaining({ rule: 'agent_cc_intake_disabled' }),
    }));
  });

  test('agent Bcc (mailbox absent from To/Cc) → held agent_reply_no_requester with the external addresses', async () => {
    asAgent();
    const outcome = await mailboxIngestService.processEmail(connection, agentReply({ cc: [] }));
    expect(outcome).toBe('held');
    expect(holdMock.holdMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      reason: 'agent_reply_no_requester', candidates: [{ email: RITA }], decision: expect.objectContaining({ rule: 'agent_bcc_mailbox' }),
    }));
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    // Re-seen by the delta poller → skipped without another hold call.
    expect(await mailboxIngestService.processEmail(connection, agentReply({ cc: [] }))).toBe('skipped');
    expect(holdMock.holdMessage).toHaveBeenCalledTimes(1);
  });

  test('agents-only To (+ mailbox Cc) with reply evidence → held agent_reply_no_requester', async () => {
    asAgent();
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'bob.middle@bgcengineering.ca' }]);
    const outcome = await mailboxIngestService.processEmail(connection, agentReply({ to: ['bob.middle@bgcengineering.ca'], bodyHtml: '<p>Bob, can you take this?</p>' }));
    expect(outcome).toBe('held');
    expect(holdMock.holdMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      reason: 'agent_reply_no_requester', decision: expect.objectContaining({ rule: 'agent_reply_no_requester' }),
    }));
  });

  test('external sender + unknown reference → held unknown_reference (with a sender best-guess ticket)', async () => {
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(null) // rung 4 (3-day cap)
      .mockResolvedValueOnce({ id: 655 }); // best guess, no cap
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: quick question', inReplyTo: '<gone@elsewhere.example>', internetMessageId: '<ext-1@example.com>',
    });
    expect(outcome).toBe('held');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(holdMock.holdMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ internetMessageId: '<ext-1@example.com>' }), expect.objectContaining({
      reason: 'unknown_reference', bestGuessTicketId: 655,
      decision: expect.objectContaining({ rule: 'external_reply_unknown', details: expect.objectContaining({ evidence: ['threading_headers', 'subject_prefix'] }) }),
    }));
  });

  test('a token-stripped "Re:" with the TP ref still in the quoted body threads via the body scan', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 660, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1204, ccEmails: [] });
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: Invoice', bodyText: 'Any news?\n\nFrom: Ticket Pulse\nSubject: Re: Invoice [TP-1204]\n', internetMessageId: '<ext-2@example.com>',
    });
    expect(outcome).toBe('reply');
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'requester_reply', details: expect.objectContaining({ via: 'body_ref' }) }));
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
  });

  test('newTicketPolicy=create → created despite reply evidence', async () => {
    const outcome = await mailboxIngestService.processEmail({ ...connection, newTicketPolicy: 'create' }, {
      ...baseEmail, subject: 'Re: quick question', inReplyTo: '<gone@elsewhere.example>',
    });
    expect(outcome).toBe('created');
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({ requesterEmail: 'rita@example.com' }), expect.anything(), { sourceChannel: 1, createdVia: 'email' });
  });

  test('newTicketPolicy=replies_only → fresh external mail is held, not created', async () => {
    const outcome = await mailboxIngestService.processEmail({ ...connection, newTicketPolicy: 'replies_only' }, baseEmail);
    expect(outcome).toBe('held');
    expect(holdMock.holdMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      reason: 'unknown_reference', decision: expect.objectContaining({ rule: 'policy_replies_only' }),
    }));
  });

  test('hold service failure: policy=create falls back to creating; default policy skips and remembers the id', async () => {
    holdMock.holdMessage.mockRejectedValue(new Error('table missing'));
    const reply = { ...baseEmail, subject: 'Re: quick question', inReplyTo: '<gone@elsewhere.example>', internetMessageId: '<ext-3@example.com>' };
    expect(await mailboxIngestService.processEmail({ ...connection, newTicketPolicy: 'create' }, reply)).toBe('created');
    jest.clearAllMocks();
    holdMock.holdMessage.mockRejectedValue(new Error('table missing'));
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
    expect(await mailboxIngestService.processEmail(connection, reply)).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(mailboxIngestService._heldMessageIds.has('<ext-3@example.com>')).toBe(true);
  });

  test('a subsequent agent reply from Outlook (known reference) threads as an agent entry that is never re-sent', async () => {
    asAgent();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ticketId: 700 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 700, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1100, ccEmails: [] });
    const outcome = await mailboxIngestService.processEmail(connection, agentReply({ inReplyTo: '<rita-2@customer.example>', references: '<agent-reply-1@bgcengineering.ca> <rita-2@customer.example>', internetMessageId: '<agent-reply-2@bgcengineering.ca>' }));
    expect(outcome).toBe('reply');
    const entry = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(entry).toEqual(expect.objectContaining({ authorType: 'agent', incoming: false, actorEmail: AGENT.email, emailMessageId: '<agent-reply-2@bgcengineering.ca>' }));
    expect(entry.rawPayload).toEqual(expect.objectContaining({ deliveryState: 'external' }));
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'agent_reply', details: expect.objectContaining({ deliveryState: 'external', technicianId: 7 }) }));
    expect(activityMock.create).not.toHaveBeenCalledWith(expect.objectContaining({ activityType: 'requester_reply' }));
  });
});

// RL-4 hand-off: the hold queue's "Create ticket (for <address>)" and
// "Attach" actions call back into this service with the contract below.
describe('hold-queue callbacks (RL-4 contract)', () => {
  test('createTicketFromEmail({kind:fresh, forcedRequester, createdVia:held_reply, heldMessageId, resolvedBy}) → forced requester + createdVia', async () => {
    const email = { ...baseEmail, id: 'msg-held', internetMessageId: '<held-1@example.com>', to: ['helpdesk-pilot@example.com'] };
    await mailboxIngestService.createTicketFromEmail(connection, email, {
      kind: 'fresh', forcedRequester: 'Chosen.Person@Customer.example', createdVia: 'held_reply', heldMessageId: 31, resolvedBy: 'Kirsten (coordinator)',
    });
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({
      requesterEmail: 'chosen.person@customer.example', requesterName: null, subject: 'Printer on 3rd floor jammed',
    }), expect.objectContaining({ role: 'system' }), { sourceChannel: 1, createdVia: 'held_reply' });
    const original = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(original).toEqual(expect.objectContaining({ eventType: 'original_email', actorEmail: 'rita@example.com', emailMessageId: '<held-1@example.com>' }));
    expect(original.rawPayload).toEqual({
      to_emails: ['helpdesk-pilot@example.com'], cc_emails: [],
      heldReply: { heldMessageId: 31, resolvedBy: 'Kirsten (coordinator)', forcedRequester: 'chosen.person@customer.example' },
    });
  });

  test('no forcedRequester → email.from; no createdVia → email', async () => {
    await mailboxIngestService.createTicketFromEmail(connection, baseEmail, { kind: 'fresh', heldMessageId: 32, resolvedBy: 'x' });
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({ requesterEmail: 'rita@example.com', requesterName: 'Rita Requester' }), expect.anything(), { sourceChannel: 1, createdVia: 'email' });
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload).toEqual({ heldReply: { heldMessageId: 32, resolvedBy: 'x' } });
  });

  test('attach → ingestReply(connection, ticket, email, held_reply_attach) with no 5th argument', async () => {
    const ticket = { id: 720, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1120, ccEmails: [] };
    const entry = await mailboxIngestService.ingestReply(connection, ticket, { ...baseEmail, internetMessageId: '<held-2@example.com>' }, 'held_reply_attach');
    expect(entry).toEqual(expect.objectContaining({ id: 9001, ticketId: 720, authorType: 'requester', incoming: true, emailMessageId: '<held-2@example.com>' }));
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'requester_reply', details: expect.objectContaining({ via: 'held_reply_attach' }) }));
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 720, 9001);
  });
});
