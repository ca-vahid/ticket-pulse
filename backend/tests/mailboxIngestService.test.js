import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const holdMock = { holdMessage: jest.fn(), isKnownMessageId: jest.fn(), recordSkipped: jest.fn() };
// Helpdesk profile (12 Oct 2026): dynamic imports on the new-ticket path.
const requesterRepoMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const linkMock = { link: jest.fn() };
const attachmentMock = { isConfigured: jest.fn(() => true), upload: jest.fn() };
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepoMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: attachmentMock }));
const graphMock = {
  isConfigured: jest.fn(() => true),
  getInboxMessagesForIngest: jest.fn(),
  getMessageAttachments: jest.fn(),
};
const ticketServiceMock = { createTicket: jest.fn() };
const mirrorServiceMock = { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn(), getInteractiveClient: jest.fn(async () => null) };
const activityMock = { create: jest.fn() };
// Approvals v3: a reply on <mailbox>+ap<key>@… is an approval answer, not a ticket reply.
const conversationMock = { answer: jest.fn(), plusAddressApprovalKey: jest.fn(() => null) };
jest.unstable_mockModule('../src/services/approvalConversationService.js', () => ({ default: conversationMock, plusAddressApprovalKey: conversationMock.plusAddressApprovalKey }));

// FreshService helpdesk addresses (23 Sep 2026): it@example.com reads FS mail.
const helpdeskMock = { fsHelpdeskAddresses: jest.fn(async () => new Set(['it@example.com'])) };
jest.unstable_mockModule('../src/services/fsHelpdeskAddressService.js', () => {
  const isFreshserviceTenantAddress = (a) => /@[a-z0-9.-]*\.freshservice\.com$/i.test(String(a || ''));
  return {
    fsHelpdeskAddresses: helpdeskMock.fsHelpdeskAddresses,
    isFreshserviceTenantAddress,
    freshserviceWillIngest: async (workspaceId, email) => {
      const recipients = [...(email.to || []), ...(email.cc || [])].map((a) => String(a).toLowerCase());
      if (recipients.some(isFreshserviceTenantAddress)) return true;
      const set = await helpdeskMock.fsHelpdeskAddresses(workspaceId);
      return recipients.some((a) => set.has(a));
    },
  };
});
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
const replyCopyMock = { copyAgentsOnRequesterReply: jest.fn(async () => ({ sent: true })) };
jest.unstable_mockModule('../src/services/requesterReplyCopyService.js', () => ({ default: replyCopyMock, copyAgentsOnRequesterReply: replyCopyMock.copyAgentsOnRequesterReply }));
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
  plusAddressTicketNumbers, plusAddressFsTicketNumbers, mergeInboundCc, MAX_CC_EMAILS,
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
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.requester.findUnique.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  requesterRepoMock.findByEmail.mockResolvedValue(null);
  requesterRepoMock.createNative.mockResolvedValue({ id: 4400 });
  linkMock.link.mockResolvedValue({});
  attachmentMock.upload.mockResolvedValue({});
  attachmentMock.isConfigured.mockReturnValue(true);
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

describe('approval reply rung (Approvals v3)', () => {
  test('a +ap<key> recipient routes the mail to the approval conversation and never touches the ticket ladder', async () => {
    conversationMock.plusAddressApprovalKey.mockReturnValueOnce('abcdef012345');
    conversationMock.answer.mockResolvedValueOnce({ message: { id: 5 } });
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: Question on Security approval', to: ['helpdesk-pilot+apabcdef012345@example.com'], bodyText: 'DEV only\n\n> quoted',
    });
    expect(outcome).toBe('approval_reply');
    expect(conversationMock.plusAddressApprovalKey).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: Question on Security approval' }), 'helpdesk-pilot@example.com');
    expect(conversationMock.answer).toHaveBeenCalledWith(expect.objectContaining({
      plusKey: 'abcdef012345', senderEmail: 'rita@example.com', senderName: 'Rita Requester', via: 'email', emailMessageId: '<abc-123@example.com>', bodyText: 'DEV only\n\n> quoted',
    }));
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('a bad key falls through to the normal ladder so the mail is not lost', async () => {
    conversationMock.plusAddressApprovalKey.mockReturnValueOnce('deadbeef0000');
    conversationMock.answer.mockRejectedValueOnce(new Error('This reply link is not valid'));
    ticketServiceMock.createTicket.mockResolvedValue({ id: 900, origin: 'ticketpulse' });
    const outcome = await mailboxIngestService.processEmail(connection, { ...baseEmail, to: ['helpdesk-pilot+apdeadbeef0000@example.com'] });
    expect(outcome).not.toBe('approval_reply');
    expect(conversationMock.answer).toHaveBeenCalled();
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

  const FS_TICKET = { id: 900, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: BigInt(224183), nativeNumber: null, status: 'Open', subject: 'VPN issue', requesterFreshserviceId: null };

  test('3a: FreshService #ref is skipped ONLY when the helpdesk address is a recipient (FS ingests it itself)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ ...FS_TICKET });
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: [#224183] VPN issue', to: ['it@example.com', 'helpdesk-pilot@example.com'],
    });
    expect(outcome).toBe('skipped');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    const { ingestSkipCounts } = await import('../src/services/mailboxIngestService.js');
    expect(ingestSkipCounts(1).byReason.freshservice_ref).toBeGreaterThanOrEqual(1);
  });

  test('3b: helpdesk absent → the reply threads onto the FS-born ticket and is written back to FreshService (#242611)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ ...FS_TICKET });
    prismaMock.ticket.findUnique.mockResolvedValue({ ...FS_TICKET });
    const addNote = jest.fn(async () => ({ conversation: { id: 555 } }));
    mirrorServiceMock.getInteractiveClient.mockResolvedValueOnce({ addNote });
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: Approved with condition: VPN issue [#224183]', to: ['helpdesk-pilot@example.com'],
    });
    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ticketId: 900, source: 'email_inbound', eventType: 'reply' }),
    }));
    expect(addNote).toHaveBeenCalledWith(224183, expect.any(String), expect.objectContaining({ incoming: true }));
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('3c: a FreshService tenant address in Cc counts as the helpdesk', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ ...FS_TICKET });
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: [#224183] VPN issue', to: ['helpdesk-pilot@example.com'], cc: ['acme@acme.freshservice.com'],
    });
    expect(outcome).toBe('skipped');
  });

  test('3d: token-stripped subject, "#224183" only in the quoted body → same lane as 3b', async () => {
    // rung 3 sees no token; rung 4/5 find nothing; the body ref then resolves the FS ticket
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(null) // rung 4 sender+recency (TP-born)
      .mockResolvedValueOnce({ ...FS_TICKET }); // rung 3b body ref
    prismaMock.ticket.findMany.mockResolvedValue([]);
    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'RE: your approval', to: ['helpdesk-pilot@example.com'],
      bodyText: 'Thanks, go ahead.\n\nFrom: Ticket Pulse\nSubject: Approved: VPN issue [#224183]',
      bodyHtml: '<p>Thanks, go ahead.</p><p>From: Ticket Pulse<br>Subject: Approved: VPN issue [#224183]</p>',
    });
    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ticketId: 900 }) }));
  });

  test('5: FS-born last rung — requester + normalised subject + open + 30 d → threads; two candidates → held with both', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    const a = { ...FS_TICKET, id: 901, freshserviceTicketId: BigInt(240001), subject: 'Laptop battery swelling', updatedAt: new Date() };
    prismaMock.ticket.findMany.mockResolvedValueOnce([a, { ...FS_TICKET, id: 902, freshserviceTicketId: BigInt(240002), subject: 'Something else', updatedAt: new Date() }]);
    let outcome = await mailboxIngestService.processEmail(connection, { ...baseEmail, subject: 'Re: Laptop battery swelling', to: ['helpdesk-pilot@example.com'] });
    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ticketId: 901 }) }));
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where.origin).toBe('freshservice');
    expect(where.OR[0]).toEqual({ requester: { is: { email: { equals: 'rita@example.com', mode: 'insensitive' } } } });

    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    holdMock.holdMessage.mockResolvedValue({ id: 32 });
    prismaMock.ticket.findMany.mockResolvedValueOnce([a, { ...a, id: 903, freshserviceTicketId: BigInt(240003) }]);
    outcome = await mailboxIngestService.processEmail(connection, { ...baseEmail, subject: 'RE: RE: Laptop battery swelling', to: ['helpdesk-pilot@example.com'], internetMessageId: '<abc-124@example.com>' });
    expect(outcome).toBe('held');
    expect(holdMock.holdMessage).toHaveBeenCalledWith(connection, expect.anything(), expect.objectContaining({
      reason: 'ambiguous_ticket', bestGuessTicketId: 901,
      candidates: { tickets: [expect.objectContaining({ id: 901, displayRef: '#240001' }), expect.objectContaining({ id: 903, displayRef: '#240003' })] },
    }));
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('5: an agent forward on rung 5 matches on the quoted original sender, never the agent', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ ...AGENT, workspaceId: 1 });
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    await mailboxIngestService.processEmail(connection, {
      ...baseEmail, id: 'msg-fw5', from: AGENT.email, fromName: AGENT.name, subject: 'FW: Invoice 4471 still unpaid',
      to: ['helpdesk-pilot@example.com'], bodyHtml: forwardFixture('outlook-owa.html'), bodyText: null,
    });
    const senders = prismaMock.ticket.findMany.mock.calls.map((c) => c[0].where.OR[0].requester.is.email.equals);
    expect(senders.length).toBeGreaterThan(0);
    for (const s of senders) expect(s).toBe(RITA);
  });

  test('normalizeSubjectForMatch strips prefixes, our tokens and verdict prefixes', async () => {
    const { normalizeSubjectForMatch } = await import('../src/services/mailboxIngestService.js');
    expect(normalizeSubjectForMatch('RE: Approved with condition: Microsoft Teams Unified App Management error message [#242611]')).toBe('microsoft teams unified app management error message');
    expect(normalizeSubjectForMatch('FW: RE: Laptop  battery [TP-1042]')).toBe('laptop battery');
    expect(normalizeSubjectForMatch('Ticket #12345 — Printer')).toBe('— printer');
  });

  test('recheckInbox: dry run reports what each message would do and writes nothing; the real run ingests', async () => {
    const svc = mailboxIngestService;
    graphMock.getInboxMessagesForIngest.mockResolvedValue([
      { ...baseEmail, id: 'g1', internetMessageId: '<seen@example.com>', subject: 'already' },
      { ...baseEmail, id: 'g2', internetMessageId: '<new@example.com>', subject: 'RE: [#224183] VPN issue', to: ['helpdesk-pilot@example.com'] },
    ]);
    prismaMock.ticketThreadEntry.findFirst.mockImplementation(async ({ where }) => (where.emailMessageId === '<seen@example.com>' ? { id: 1 } : null));
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET });
    const dry = await svc.recheckInbox(connection, { since: '2026-09-22T00:00:00Z', dryRun: true });
    expect(dry.scanned).toBe(2);
    expect(dry.counts).toEqual({ already_ingested: 1, reply: 1 });
    expect(dry.results[1]).toEqual(expect.objectContaining({ outcome: 'reply', via: 'fs_ref_subject', ticket: '#224183' }));
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();

    const spy = jest.spyOn(svc, 'ingestSingleMessage').mockResolvedValue('reply');
    const real = await svc.recheckInbox(connection, { since: '2026-09-22T00:00:00Z', dryRun: false });
    expect(real.counts).toEqual({ already_ingested: 1, reply: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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
    // The Cc merge must do no address resolution. The one requester read that
    // IS expected here is the FR 09-11 #1 identity check — "is this sender the
    // requester on this ticket?" — which fetches only the e-mail by id.
    expect(prismaMock.requester.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.requester.findUnique).toHaveBeenCalledWith({ where: { id: 55 }, select: { email: true } });
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

  test('the OUTER subject wins — what the agent typed stays, FW: stripped (QA 09-22 #2)', async () => {
    asAgent();
    await mailboxIngestService.processEmail(connection, forwardEmail('outlook-owa.html', { subject: 'FW: Invoice 4471 still unpaid (THIS IS A TEST)' }));
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.subject).toBe('Invoice 4471 still unpaid (THIS IS A TEST)');
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

// --------------------------------------------------------------- FS-born reply loop (17 Sep 2026)
describe('FS-born tickets on the Ticket Pulse reply lane', () => {
  test('plusAddressFsTicketNumbers reads +fs<n>; +tp and +fs never cross', () => {
    expect(plusAddressFsTicketNumbers({ to: ['helpdesk-pilot+fs241459@example.com'] }, connection.address)).toEqual([241459]);
    expect(plusAddressFsTicketNumbers({ to: ['Help <Helpdesk-Pilot+FS241459@Example.com>'] }, connection.address)).toEqual([241459]);
    expect(plusAddressFsTicketNumbers({ to: ['helpdesk-pilot+tp1042@example.com'] }, connection.address)).toEqual([]);
    expect(plusAddressTicketNumbers({ to: ['helpdesk-pilot+fs241459@example.com'] }, connection.address)).toEqual([]);
    expect(plusAddressFsTicketNumbers({ to: ['other+fs241459@example.com'] }, connection.address)).toEqual([]);
  });

  test('1.5b: a reply addressed to mailbox+fs<n>@ threads onto the FS-born ticket and is written back to FreshService as the requester', async () => {
    const fsClient = { addNote: jest.fn(async () => ({ conversation: { id: 555001 } })) };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);
    prismaMock.ticketThreadEntry.update = jest.fn(async () => ({}));
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 44036, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 241459n, requesterFreshserviceId: 1001249103n, ccEmails: [] });

    const outcome = await mailboxIngestService.processEmail(connection, {
      ...baseEmail, subject: 'Re: Field Email Address/Account [#241459]', to: ['helpdesk-pilot+fs241459@example.com'], internetMessageId: '<fs-reply-1@example.com>',
    });

    expect(outcome).toBe('reply');
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith({ where: { workspaceId: 1, freshserviceTicketId: 241459n, origin: 'freshservice' } });
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'requester_reply', details: expect.objectContaining({ via: 'plus_address_fs' }) }));
    expect(fsClient.addNote).toHaveBeenCalledWith(241459, expect.stringContaining('It is jammed again'), expect.objectContaining({ isPrivate: false, incoming: true, userId: 1001249103 }));
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 9001 }, data: expect.objectContaining({ mirrorState: 'mirrored', externalEntryId: 'fs-conversation:555001' }),
    }));
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test('a requester without a FreshService id is written back as a marked incoming note', async () => {
    const fsClient = { addNote: jest.fn(async () => ({ conversation: { id: 555002 } })) };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);
    prismaMock.ticketThreadEntry.update = jest.fn(async () => ({}));
    const ticket = { id: 44037, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 241460n, requesterFreshserviceId: null, ccEmails: [] };
    await mailboxIngestService.ingestReply(connection, ticket, { ...baseEmail, internetMessageId: '<fs-reply-2@example.com>' }, 'plus_address_fs');
    const [, body, opts] = fsClient.addNote.mock.calls[0];
    expect(body).toContain('Rita Requester &lt;rita@example.com&gt; · reply received by e-mail');
    expect(opts).toEqual(expect.objectContaining({ isPrivate: false, incoming: true }));
    expect(opts.userId).toBeUndefined();
  });

  test('a FreshService outage never loses the reply: the row is marked failed', async () => {
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => ({ addNote: jest.fn(async () => { throw new Error('503'); }) }));
    prismaMock.ticketThreadEntry.update = jest.fn(async () => ({}));
    const ticket = { id: 44038, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 241461n, requesterFreshserviceId: 1n, ccEmails: [] };
    const entry = await mailboxIngestService.ingestReply(connection, ticket, { ...baseEmail, internetMessageId: '<fs-reply-3@example.com>' }, 'plus_address_fs');
    expect(entry.id).toBe(9001);
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith({ where: { id: 9001 }, data: { mirrorState: 'failed' } });
  });
});

describe('requester reply copy to agents (17 Sep 2026)', () => {
  test('a requester reply asks the copy service once, with the sender', async () => {
    const ticket = { id: 720, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1120, ccEmails: [] };
    await mailboxIngestService.ingestReply(connection, ticket, { ...baseEmail, internetMessageId: '<copy-1@example.com>' }, 'plus_address');
    expect(replyCopyMock.copyAgentsOnRequesterReply).toHaveBeenCalledTimes(1);
    const [t, entry, meta] = replyCopyMock.copyAgentsOnRequesterReply.mock.calls[0];
    expect(t.id).toBe(720);
    expect(entry.id).toBe(9001);
    expect(meta).toEqual({ fromEmail: 'rita@example.com', fromName: 'Rita Requester' });
  });

  test('an agent\'s own Outlook reply is not copied', async () => {
    const ticket = { id: 721, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1121, ccEmails: [] };
    const agent = { id: 7, name: 'Soheil Nasiri', email: 'soheil@example.com' };
    await mailboxIngestService.ingestReply(connection, ticket, { ...baseEmail, from: 'soheil@example.com', fromName: 'Soheil Nasiri', internetMessageId: '<copy-2@example.com>' }, 'plus_address', { agent });
    expect(replyCopyMock.copyAgentsOnRequesterReply).not.toHaveBeenCalled();
  });
});

// IT intake plan (12 Oct 2026): a 'helpdesk' mailbox is the team's front door. Six days of real it@
// mail through the old rules: 16 no-reply notices dropped, 32 held only because [INC-n] was not read,
// 3 fresh mails glued onto the sender's open ticket (one of them an onboarding ticket).
describe('helpdesk mailbox profile', () => {
  const front = { id: 9, workspaceId: 1, address: 'helpdesk-pilot@example.com', intakeProfile: 'helpdesk' };

  test('a no-reply sender and an auto-generated notice are tickets; an automatic reply and a bounce are still loop mail', () => {
    const opts = { helpdesk: true };
    expect(looksLikeLoopMail({ from: 'azure-noreply@microsoft.com', subject: 'Budget alert' }, front.address, opts)).toBeNull();
    expect(looksLikeLoopMail({ from: 'no-reply@cira.ca', subject: 'Domain renewal', autoSubmitted: 'auto-generated' }, front.address, opts)).toBeNull();
    expect(looksLikeLoopMail({ from: 'news@vendor.com', subject: 'x', precedence: 'bulk' }, front.address, opts)).toBeNull();
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'x', autoSubmitted: 'auto-replied' }, front.address, opts)).toBe('auto_submitted_header');
    expect(looksLikeLoopMail({ from: 'rita@example.com', subject: 'Automatic reply: away' }, front.address, opts)).toBe('autoreply_subject');
    expect(looksLikeLoopMail({ from: 'postmaster@mx.example.com', subject: 'x' }, front.address, opts)).toBe('automated_sender');
    expect(looksLikeLoopMail({ from: 'helpdesk-pilot@example.com', subject: 'x' }, front.address, opts)).toBe('self_send');
    // A side mailbox keeps the old rule.
    expect(looksLikeLoopMail({ from: 'azure-noreply@microsoft.com', subject: 'x' }, front.address)).toBe('automated_sender');
  });

  test('a fresh mail from someone with an open ticket is a NEW ticket, never a reply on the old one', async () => {
    // On a side mailbox this findFirst is rung 4 and the mail becomes a reply (test "4:" above).
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 503, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1050, status: 'Open' });
    const outcome = await mailboxIngestService.processEmail(front, { ...baseEmail, subject: 'A different problem' });
    expect(outcome).toBe('created');
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test.each([
    ['Re: [INC-243414] GIS Pro licence', 243414],
    ['Re: [#SR-246489] new starter', 246489],
    ['RE: Printer [#246332]', 246332],
  ])('"%s" finds the ticket with that FreshService number, even a Ticket Pulse-born one', async (subject, number) => {
    helpdeskMock.fsHelpdeskAddresses.mockResolvedValueOnce(new Set());
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (
      where.freshserviceTicketId === BigInt(number) && where.origin === undefined
        ? { id: 800, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1900, freshserviceTicketId: BigInt(number), status: 'Open' }
        : null));
    const match = await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject, to: ['helpdesk-pilot@example.com'] }, front.address, { helpdesk: true });
    expect(match).toMatchObject({ via: 'fs_ref_subject', ticket: { id: 800 } });
  });

  test('two different tickets named in one subject are held with both, not guessed', async () => {
    helpdeskMock.fsHelpdeskAddresses.mockResolvedValueOnce(new Set());
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => {
      if (where.freshserviceTicketId === 243414n) return { id: 801, origin: 'freshservice', freshserviceTicketId: 243414n, subject: 'A' };
      if (where.freshserviceTicketId === 246489n) return { id: 802, origin: 'freshservice', freshserviceTicketId: 246489n, subject: 'B' };
      return null;
    });
    const match = await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Fw: [INC-243414] same as [#SR-246489]' }, front.address, { helpdesk: true });
    expect(match).toMatchObject({ hold: true, reason: 'ambiguous_ticket', rule: 'fs_ref_two_tickets' });
    expect(match.candidates.map((c) => c.id)).toEqual([801, 802]);
  });

  test('sender + subject is only tried for mail that is a reply, and then for both origins', async () => {
    // A repeating alert: same subject as an open ticket, but not a reply: no lookup, a new ticket.
    expect(await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Transfer has failed for FILE3' }, front.address, { helpdesk: true })).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    // A real reply with no number: looked up without an origin filter.
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 803, origin: 'ticketpulse', nativeNumber: 1901, subject: 'Laptop will not boot', updatedAt: new Date() }]);
    const match = await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Re: Laptop will not boot', inReplyTo: '<x@fs.mail>' }, front.address, { helpdesk: true });
    expect(match).toMatchObject({ via: 'fs_subject_sender', ticket: { id: 803 } });
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.origin).toBeUndefined();
  });

  test('a burst from one sender is held, not dropped', async () => {
    const senderCreates = new Map([['rita@example.com', 3]]);
    const outcome = await mailboxIngestService.processEmail(front, baseEmail, senderCreates);
    expect(outcome).toBe('held');
    expect(holdMock.holdMessage).toHaveBeenCalledWith(front, expect.anything(), expect.objectContaining({ reason: 'sender_burst' }));
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('a dry run can judge mail as of its arrival, ignoring tickets created afterwards', async () => {
    const receivedAt = new Date('2026-10-09T15:00:00Z');
    await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Re: [INC-243414] x', receivedAt }, front.address, { helpdesk: true, asOf: receivedAt });
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toMatchObject({ freshserviceTicketId: 243414n, createdAt: { lt: receivedAt } });
  });
});

describe('helpdesk mailbox: nothing is lost silently', () => {
  const front = { id: 9, workspaceId: 1, address: 'helpdesk-pilot@example.com', intakeProfile: 'helpdesk' };

  test('a skipped mail leaves a row a person can see; a side mailbox still only logs', async () => {
    const bounce = { ...baseEmail, from: 'postmaster@mx.example.com', subject: 'Undeliverable: hello' };
    expect(await mailboxIngestService.processEmail(front, bounce)).toBe('skipped');
    expect(holdMock.recordSkipped).toHaveBeenCalledWith(front, bounce, 'automated_sender');
    holdMock.recordSkipped.mockClear();
    expect(await mailboxIngestService.processEmail(connection, { ...bounce, internetMessageId: '<other@example.com>' })).toBe('skipped');
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });

  test('a message whose ticket could not be created is held, not forgotten when the cursor moves on', async () => {
    ticketServiceMock.createTicket.mockRejectedValueOnce(new Error('database is busy'));
    const { results } = await mailboxIngestService._ingestBatch(front, [baseEmail], new Date(0));
    expect(results).toMatchObject({ created: 0, held: 1, skipped: 0 });
    expect(holdMock.holdMessage).toHaveBeenCalledWith(front, baseEmail, expect.objectContaining({ reason: 'ingest_error' }));
    // A side mailbox keeps today's behaviour.
    ticketServiceMock.createTicket.mockRejectedValueOnce(new Error('database is busy'));
    const side = await mailboxIngestService._ingestBatch(connection, [{ ...baseEmail, internetMessageId: '<side@example.com>' }], new Date(0));
    expect(side.results).toMatchObject({ held: 0, skipped: 1 });
  });

  test('a sender the directory does not list as a person (a shared mailbox, a device) still gets a ticket', async () => {
    ticketServiceMock.createTicket
      .mockRejectedValueOnce(new Error('scanner@example.com is not a mailbox in this organisation, so no requester was created.'))
      .mockResolvedValueOnce({ id: 701, displayRef: 'TP-1101', workspaceId: 1 });
    const outcome = await mailboxIngestService.processEmail(front, { ...baseEmail, from: 'scanner@example.com', fromName: 'Scanner 3' });
    expect(outcome).toBe('created');
    expect(requesterRepoMock.createNative).toHaveBeenCalledWith({ email: 'scanner@example.com', name: 'Scanner 3', entraMissing: true });
    const retry = ticketServiceMock.createTicket.mock.calls[1][1];
    expect(retry.requesterId).toBe(4400);
    expect(retry.requesterEmail).toBeUndefined();
    // On a side mailbox the refusal stands (it protects against typed guesses).
    ticketServiceMock.createTicket.mockRejectedValueOnce(new Error('x@example.com is not a mailbox in this organisation, so no requester was created.'));
    await expect(mailboxIngestService.processEmail(connection, { ...baseEmail, internetMessageId: '<s2@example.com>' })).rejects.toThrow('not a mailbox');
  });

  test('a body longer than a description holds is trimmed and attached whole, where it used to fail', async () => {
    const big = `<p>${'x'.repeat(120000)}</p>`;
    expect(await mailboxIngestService.processEmail(front, { ...baseEmail, bodyHtml: big })).toBe('created');
    const sent = ticketServiceMock.createTicket.mock.calls[0][1].description;
    expect(sent.length).toBeLessThan(100000);
    expect(sent).toContain('original-message.html');
    expect(attachmentMock.upload).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 700, fileName: 'original-message.html', contentType: 'text/html' }));
    expect(attachmentMock.upload.mock.calls[0][0].buffer.length).toBe(Buffer.byteLength(big));
  });

  test('the people copied are kept without the mailbox itself, the sender or the agents', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Agent@Example.com' }]);
    await mailboxIngestService.processEmail(front, {
      ...baseEmail, to: ['helpdesk-pilot@example.com'],
      cc: ['helpdesk-pilot+tp12@example.com', 'agent@example.com', 'rita@example.com', 'boss@example.com'],
    });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ccEmails: ['boss@example.com'] }) }));
  });

  test('a full first page means there may be more: the whole backlog is read, oldest first', async () => {
    const page = Array.from({ length: 25 }, (_, i) => ({ ...baseEmail, id: `m${i}`, internetMessageId: `<m${i}@example.com>`, receivedAt: new Date(Date.UTC(2026, 9, 12, 12, 59 - i)) }));
    const all = [...page, ...Array.from({ length: 5 }, (_, i) => ({ ...baseEmail, id: `o${i}`, internetMessageId: `<o${i}@example.com>`, receivedAt: new Date(Date.UTC(2026, 9, 12, 11, 59 - i)) }))];
    graphMock.getInboxMessagesForIngest.mockResolvedValueOnce(page).mockResolvedValueOnce(all);
    const seen = [];
    const spy = jest.spyOn(mailboxIngestService, 'ingestSingleMessage').mockImplementation(async (c, e) => { seen.push(e.id); return 'created'; });
    prismaMock.mailboxConnection.update.mockResolvedValue({});
    const results = await mailboxIngestService._pollInbox({ ...front, lastMessageAt: new Date('2026-10-12T10:00:00Z') });
    spy.mockRestore();
    expect(graphMock.getInboxMessagesForIngest.mock.calls.map((c) => c[2])).toEqual([25, 250]);
    expect(results.created).toBe(30);
    expect(seen[0]).toBe('o4');
    expect(seen[seen.length - 1]).toBe('m0');
  });
});

describe('helpdesk mailbox: the ticket behind a FreshService number', () => {
  const front = { id: 9, workspaceId: 1, address: 'helpdesk-pilot@example.com', intakeProfile: 'helpdesk' };
  const opts = { helpdesk: true };
  const long = new Date(Date.now() - 40 * 86400000);

  test('a deleted ticket is never threaded onto: a person decides', async () => {
    helpdeskMock.fsHelpdeskAddresses.mockResolvedValue(new Set());
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 810, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 243414n, status: 'Deleted', subject: 'x' });
    const match = await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Re: [INC-243414] x' }, front.address, opts);
    expect(match).toMatchObject({ hold: true, rule: 'fs_ref_deleted_ticket', bestGuessTicketId: 810 });
  });

  test('a merged ticket hands the reply to the ticket that survived', async () => {
    helpdeskMock.fsHelpdeskAddresses.mockResolvedValue(new Set());
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 811, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 243414n, status: 'Closed', closedAt: new Date() });
    prismaMock.ticketLink.findFirst.mockResolvedValue({ relatedTicketId: 812 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 812, workspaceId: 1, origin: 'freshservice', status: 'Open' });
    const match = await mailboxIngestService.matchEmailToTicket(1, { ...baseEmail, subject: 'Re: [INC-243414] x', inReplyTo: '<a@fs.mail>' }, front.address, opts);
    expect(match).toMatchObject({ via: 'fs_ref_subject', ticket: { id: 812 } });
  });

  test('a fresh mail that only mentions a ticket closed long ago is a new ticket, linked to it; a real reply still threads', async () => {
    helpdeskMock.fsHelpdeskAddresses.mockResolvedValue(new Set());
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 813, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 243414n, status: 'Closed', closedAt: long });
    const fresh = { ...baseEmail, subject: 'Same problem as [INC-243414] again' };
    expect(await mailboxIngestService.matchEmailToTicket(1, fresh, front.address, opts)).toEqual({ relatedTicketId: 813, via: 'fs_ref_old_closed' });
    const reply = { ...baseEmail, subject: 'Re: [INC-243414] printer', inReplyTo: '<a@fs.mail>' };
    expect(await mailboxIngestService.matchEmailToTicket(1, reply, front.address, opts)).toMatchObject({ via: 'fs_ref_subject', ticket: { id: 813 } });
    // End to end: the new ticket carries the link.
    expect(await mailboxIngestService.processEmail(front, { ...fresh, internetMessageId: '<again@example.com>' })).toBe('created');
    expect(linkMock.link).toHaveBeenCalledWith(700, 1, { relatedTicketId: 813, kind: 'related_to' }, expect.anything());
  });
});

describe('helpdesk mailbox: pictures pasted into the mail', () => {
  const front = { id: 9, workspaceId: 1, address: 'helpdesk-pilot@example.com', intakeProfile: 'helpdesk' };
  const big = Buffer.alloc(20 * 1024, 1);
  const files = () => [
    { name: 'image001.png', contentType: 'image/png', sizeBytes: big.length, buffer: big, contentId: 'img1@01DC', isInline: true },
    { name: 'logo.png', contentType: 'image/png', sizeBytes: 900, buffer: Buffer.alloc(900), contentId: 'logo@01DC', isInline: true },
    { name: 'orphan.png', contentType: 'image/png', sizeBytes: big.length, buffer: big, contentId: 'unused@01DC', isInline: true },
    { name: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 5000, buffer: Buffer.alloc(5000), contentId: null, isInline: false },
  ];
  const body = '<p>See the error:</p><img width="600" src="cid:img1@01DC" alt="x"><p>Thanks</p><img src="cid:logo@01DC">';

  test('a new ticket keeps the screenshot as a named picture where it was, and drops the logo', async () => {
    graphMock.getMessageAttachments.mockResolvedValue({ files: files(), skipped: [] });
    // hasAttachments is false on purpose: a mail whose only attachments are inline used to lose them.
    expect(await mailboxIngestService.processEmail(front, { ...baseEmail, id: 'AAMkAD-xyz987', bodyHtml: body, hasAttachments: false })).toBe('created');
    const description = ticketServiceMock.createTicket.mock.calls[0][1].description;
    expect(description).toContain('<p><em>[Image: picture-1-xyz987-image001.png]</em></p>');
    expect(description).not.toContain('cid:');
    expect(graphMock.getMessageAttachments).toHaveBeenCalledTimes(1);
    const uploaded = attachmentMock.upload.mock.calls.map((c) => c[0].fileName);
    expect(uploaded).toEqual(['picture-1-xyz987-image001.png', 'invoice.pdf']);
  });

  test('a side mailbox is untouched: the body is stored as it arrived', async () => {
    graphMock.getMessageAttachments.mockResolvedValue({ files: files(), skipped: [] });
    await mailboxIngestService.processEmail(connection, { ...baseEmail, bodyHtml: body, hasAttachments: false });
    expect(ticketServiceMock.createTicket.mock.calls[0][1].description).toBe(body);
    expect(graphMock.getMessageAttachments).not.toHaveBeenCalled();
  });

  test('a reply resolves the pictures the person wrote, and the hourly line counts every outcome', async () => {
    graphMock.getMessageAttachments.mockResolvedValue({ files: files(), skipped: [] });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 800, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1900, status: 'Open', ccEmails: [] });
    mailboxIngestService._hourly?.clear();
    expect(await mailboxIngestService.processEmail(front, { ...baseEmail, id: 'AAMk-r1', subject: 'Re: thing TP-1900', bodyHtml: body, hasAttachments: true })).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyHtml).toContain('[Image: picture-1-AAMkr1-image001.png]');
    expect(mailboxIngestService._hourly.get(9)).toMatchObject({ read: 1, reply: 1, created: 0 });
  });
});

// 12 Oct 2026, minutes after IT's cut-over: TP-1870 came from a plain-text mail and had no description.
describe('a plain-text mail', () => {
  test('becomes a ticket whose description is the text, on any mailbox', async () => {
    const mail = { ...baseEmail, bodyHtml: null, bodyText: 'Backup failed on FILE3.\nPlease check <the job> & retry.', bodyPreview: 'Backup failed on FILE3.' };
    expect(await mailboxIngestService.processEmail(connection, mail)).toBe('created');
    const description = ticketServiceMock.createTicket.mock.calls[0][1].description;
    expect(description).toContain('Backup failed on FILE3.');
    expect(description).toContain('&lt;the job&gt; &amp; retry');
    expect(description).not.toContain('<the job>');
  });

  test('a mail with no body at all still creates the ticket, with no description', async () => {
    expect(await mailboxIngestService.processEmail(connection, { ...baseEmail, bodyHtml: null, bodyText: '   ', bodyPreview: '' })).toBe('created');
    expect(ticketServiceMock.createTicket.mock.calls[0][1].description).toBeNull();
  });
});
