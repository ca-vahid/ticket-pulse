import { jest } from '@jest/globals';

/**
 * QA 11-24.
 *  #5   Forward with the ticket's own files ("Include the original attachments").
 *  #7/8 "Reply to <name>": an answer to the person a ticket was forwarded to,
 *       addressed to them only, never swapped for the requester.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  ticketAttachment: { findMany: jest.fn(), count: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  mailboxConnection: { findFirst: jest.fn(), findMany: jest.fn() },
  userEmailSignature: { findUnique: jest.fn() },
  ticketActivity: { create: jest.fn(), findMany: jest.fn() },
  appSettings: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
// The mail-loop guard's own-mailbox list (review, 24 Nov 2026).
const ownMock = { list: [], fail: null };
const fsLaneMock = { enabled: false };
const ticketThreadRepositoryMock = { listForTicket: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn(), emitTicketEvent: jest.fn().mockResolvedValue({ status: 'completed' }) };
const sendgridMock = { sendEmail: jest.fn() };
const graphMailClientMock = { isConfigured: jest.fn(() => false), sendMailAsMailbox: jest.fn() };
const mirrorServiceMock = {
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn(),
  getInteractiveClient: jest.fn(),
};
const attachmentServiceMock = {
  isConfigured: jest.fn(() => true),
  validateUpload: jest.fn(),
  upload: jest.fn(async ({ fileName, contentType }) => ({ id: 900, fileName, contentType })),
  bufferFor: jest.fn(),
  maxAttachmentsPerTicket: 100,
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: ticketThreadRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMailClientMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: attachmentServiceMock,
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 100,
}));

jest.unstable_mockModule('../src/services/originalRecipientsService.js', () => ({
  ownMailboxAddresses: jest.fn(async () => { if (ownMock.fail) throw ownMock.fail; return ownMock.list; }),
  isOwnAddress: (address, own) => {
    const a = String(address || '').toLowerCase();
    return (own || []).some((b) => a === b || a.replace(/\+[^@]*@/, '@') === b);
  },
  bareAddress: (v) => String(v || '').trim().toLowerCase(),
}));
jest.unstable_mockModule('../src/services/fsBornReplyLaneService.js', () => ({
  fsBornReplyLaneSettingKey: (id) => `fs_born_reply_lane_ws${id}`,
  isFsBornRepliesViaTicketPulseEnabled: jest.fn(async () => fsLaneMock.enabled),
  setFsBornRepliesViaTicketPulseEnabled: jest.fn(),
  invalidateFsBornReplyLaneCache: jest.fn(),
  default: {},
}));

const { default: ticketService, participantQuote, withTicketToken, MAIL_FILE_BYTES } = await import('../src/services/ticketService.js');
const { invalidateMachineSenderCache, machineSenderSettingKey } = await import('../src/services/machineSenderService.js');

const actor = { email: 'ada@example.com', name: 'Ada Agent', role: 'viewer', technicianId: null, kind: 'member' };
const ticket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'Invoice 4471 for approval', status: 'Open', priority: 2, descriptionText: 'Please approve',
  ccEmails: ['also@example.com'], replyCcEmails: [],
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null, internalCategory: null, internalSubcategory: null,
};
const row = (id, over = {}) => ({
  id, ticketId: 501, threadEntryId: null, fileName: `file-${id}.pdf`, contentType: 'application/pdf',
  sizeBytes: 1000, blobName: `t/501/${id}`, source: 'email', displayName: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue({ ...ticket });
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9101, ...data }));
  prismaMock.ticketThreadEntry.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketAttachment.count.mockResolvedValue(3);
  prismaMock.notificationDelivery.create.mockResolvedValue({});
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.mailboxConnection.findMany.mockResolvedValue([]);
  prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT' });
  ticketThreadRepositoryMock.listForTicket.mockResolvedValue([]);
  graphMailClientMock.isConfigured.mockReturnValue(false);
  sendgridMock.sendEmail.mockResolvedValue({ status: 'ok', messageId: '<sg-1@example.com>', provider: 'sendgrid' });
  attachmentServiceMock.isConfigured.mockReturnValue(true);
  attachmentServiceMock.bufferFor.mockImplementation(async (r) => Buffer.from(`bytes-of-${r.id}`));
  prismaMock.appSettings.findUnique.mockResolvedValue(null);
  invalidateMachineSenderCache();
  ownMock.list = ['it@example.com', 'ticketpulse@example.com'];
  ownMock.fail = null;
  fsLaneMock.enabled = false;
});

describe('forwardTicket with the ticket\'s own files (QA 11-24 #5)', () => {
  test('the ticked files are read from storage and mailed first, under their shown name; new files follow', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([
      row(12, { displayName: 'Acme Supplies_INV-4471_2026_11_20.pdf', fileName: 'scan0001.pdf' }),
      row(14, { fileName: 'po.pdf' }),
    ]);
    const upload = { originalname: 'note.txt', mimetype: 'text/plain', size: 2, buffer: Buffer.from('hi') };
    const res = await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], note: 'Please approve', includeAttachmentIds: [14, 12] }, actor, [upload]);

    // Scoped to this ticket and workspace.
    expect(prismaMock.ticketAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [14, 12] }, ticketId: 501, workspaceId: 1 },
    }));
    const mail = sendgridMock.sendEmail.mock.calls[0][0];
    expect(mail.attachments.map((a) => a.name)).toEqual(['po.pdf', 'Acme Supplies_INV-4471_2026_11_20.pdf', 'note.txt']);
    expect(mail.attachments[1].contentBytes).toBe(Buffer.from('bytes-of-12').toString('base64'));

    // The entry records which of the ticket's files went (the new file is stored on it as before).
    const stored = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(stored.rawPayload).toEqual({
      forwardTo: ['eng@example.com'],
      forwardedAttachments: [
        { id: 14, name: 'po.pdf', sizeBytes: 1000 },
        { id: 12, name: 'Acme Supplies_INV-4471_2026_11_20.pdf', sizeBytes: 1000 },
      ],
    });
    expect(stored.bodyText).toBe('Forwarded to eng@example.com (with po.pdf, Acme Supplies_INV-4471_2026_11_20.pdf) — Please approve');
    expect(res.included.map((a) => a.id)).toEqual([14, 12]);
    // The originals are not copied onto the forward; only the new file is stored.
    expect(attachmentServiceMock.upload.mock.calls.map(([a]) => a.fileName)).toEqual(['note.txt']);
  });

  test('the Graph lane carries them too', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 2, address: 'it@example.com', mode: 'both', isEnabled: true, isPrimary: true });
    graphMailClientMock.isConfigured.mockReturnValue(true);
    graphMailClientMock.sendMailAsMailbox.mockResolvedValue({ internetMessageId: '<g-1@example.com>' });
    prismaMock.ticketAttachment.findMany.mockResolvedValue([row(12)]);
    await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12] }, actor);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    const [, mail] = graphMailClientMock.sendMailAsMailbox.mock.calls[0];
    expect(mail.attachments.map((a) => a.name)).toEqual(['file-12.pdf']);
  });

  test('a file that is not on this ticket (or workspace) is a 400 and nothing is sent', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([row(12)]);
    await expect(ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12, 99] }, actor))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not on this ticket/) });
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('a file over 3 MB is a 400 that names it, before any download', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([row(12), row(13, { fileName: 'drawings.pdf', sizeBytes: MAIL_FILE_BYTES + 1 })]);
    await expect(ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12, 13] }, actor))
      .rejects.toThrow(/"drawings\.pdf" is over 3 MB, too big to send by e-mail .* Untick it/);
    expect(attachmentServiceMock.bufferFor).not.toHaveBeenCalled();
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('over the message cap together: the 400 names the biggest files to untick', async () => {
    const mb = 1024 * 1024;
    const rows = Array.from({ length: 9 }, (_, i) => row(20 + i, { fileName: `page-${i + 1}.pdf`, sizeBytes: Math.round(2.9 * mb) - i }));
    prismaMock.ticketAttachment.findMany.mockResolvedValue(rows);
    const err = await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: rows.map((r) => r.id) }, actor)
      .catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/too big for one e-mail together/);
    // 9 × 2.9 MB is ~34.8 MB of base64 (each ~3.87 MB); six fit under 25 MB,
    // so the three biggest are named.
    expect(err.message).toContain('Untick "page-1.pdf", "page-2.pdf" and "page-3.pdf", then forward again.');
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('a file whose bytes cannot be read is a 400 that names it', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([row(12, { displayName: 'Invoice.pdf' })]);
    attachmentServiceMock.bufferFor.mockResolvedValue(null);
    await expect(ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12] }, actor))
      .rejects.toThrow(/"Invoice\.pdf" could not be read from storage/);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('without includeAttachmentIds the forward is exactly as before', async () => {
    await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], note: 'FYI' }, actor);
    expect(prismaMock.ticketAttachment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload).toEqual({ forwardTo: ['eng@example.com'] });
  });

  // Review 24 Nov 2026: an internal note's screenshot must never reach an outside address by default.
  describe('files of private entries (internal notes, forwards, "Reply to")', () => {
    const entries = [
      { id: 60, isPrivate: false, eventType: 'original_email', visibility: 'public' },
      { id: 61, isPrivate: true, eventType: 'note', visibility: 'private' },
      { id: 62, isPrivate: true, eventType: 'forward', visibility: 'private' },
    ];
    beforeEach(() => {
      prismaMock.ticketThreadEntry.findMany.mockImplementation(async ({ where } = {}) => (
        where?.id?.in ? entries.filter((e) => where.id.in.includes(e.id)) : []
      ));
    });

    test('a note\'s file is refused unless includePrivateAttachments is set, and nothing is sent', async () => {
      prismaMock.ticketAttachment.findMany.mockResolvedValue([
        row(12, { threadEntryId: 60, fileName: 'invoice.pdf' }),
        row(13, { threadEntryId: 61, fileName: 'internal-screenshot.png' }),
      ]);
      const err = await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12, 13] }, actor).catch((e) => e);
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/"internal-screenshot\.png" comes from an internal note.* "From internal notes"/);
      // The privacy lookup is scoped to this ticket and workspace.
      expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: [60, 61] }, ticketId: 501, workspaceId: 1 },
      }));
      expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
      expect(attachmentServiceMock.bufferFor).not.toHaveBeenCalled();
    });

    test('an earlier forward\'s file counts as private too; an entry that cannot be found counts as private', async () => {
      prismaMock.ticketAttachment.findMany.mockResolvedValue([row(14, { threadEntryId: 62 }), row(15, { threadEntryId: 999 })]);
      const err = await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [14, 15] }, actor).catch((e) => e);
      expect(err.message).toMatch(/"file-14\.pdf" and "file-15\.pdf" come from an internal note/);
    });

    test('a failed privacy lookup counts every entry file as private (fail safe)', async () => {
      prismaMock.ticketThreadEntry.findMany.mockRejectedValue(new Error('db down'));
      prismaMock.ticketAttachment.findMany.mockResolvedValue([row(12, { threadEntryId: 60 })]);
      await expect(ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [12] }, actor))
        .rejects.toThrow(/internal note/);
    });

    test('ticked on purpose (includePrivateAttachments): sent, and the entry marks it as from an internal note', async () => {
      prismaMock.ticketAttachment.findMany.mockResolvedValue([
        row(12, { threadEntryId: 60, fileName: 'invoice.pdf' }),
        row(13, { threadEntryId: 61, fileName: 'internal-screenshot.png' }),
      ]);
      await ticketService.forwardTicket(501, 1, {
        to: ['eng@example.com'], includeAttachmentIds: [12, 13], includePrivateAttachments: true,
      }, actor);
      expect(sendgridMock.sendEmail.mock.calls[0][0].attachments.map((a) => a.name)).toEqual(['invoice.pdf', 'internal-screenshot.png']);
      expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload.forwardedAttachments).toEqual([
        { id: 12, name: 'invoice.pdf', sizeBytes: 1000 },
        { id: 13, name: 'internal-screenshot.png', sizeBytes: 1000, fromInternalNote: true },
      ]);
    });

    test('public files (the description\'s, a public message\'s) need no flag', async () => {
      prismaMock.ticketAttachment.findMany.mockResolvedValue([row(11), row(12, { threadEntryId: 60 })]);
      await ticketService.forwardTicket(501, 1, { to: ['eng@example.com'], includeAttachmentIds: [11, 12] }, actor);
      expect(sendgridMock.sendEmail.mock.calls[0][0].attachments).toHaveLength(2);
    });
  });
});

describe('addReply to someone who is not the requester (QA 11-24 #7/#8)', () => {
  const forwardeeMessage = {
    id: 88, actorName: 'Tim Example', actorEmail: 'Tim@Example.com', authorType: 'requester', incoming: true,
    emailMessageId: '<tim-1@example.com>', bodyHtml: '<p>There was no attachment to the email.</p>',
    bodyText: 'There was no attachment to the email.', content: null, occurredAt: '2026-11-23T18:00:00Z', rawPayload: { to_emails: ['it@example.com'] },
  };
  const forwards = [{ rawPayload: { forwardTo: ['tim@example.com'] } }];
  const armThread = (source = forwardeeMessage, forwardRows = forwards) => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(source);
    prismaMock.ticketThreadEntry.findMany.mockImplementation(async ({ where } = {}) => {
      if (where?.occurredAt) return []; // replay guard
      if (where?.emailMessageId) return [{ emailMessageId: '<tim-1@example.com>' }, { emailMessageId: '<fw-1@example.com>' }];
      if (where?.eventType === 'forward') return forwardRows;
      return [];
    });
  };
  const send = (over = {}, files = []) => ticketService.addReply(
    501, 1, { bodyText: 'Here it is, attached.', ...over }, actor, files,
    { replyToParticipant: { entryId: 88, email: 'tim@example.com' } },
  );

  test('goes to that person only, Re: their forward subject, threaded under their message', async () => {
    armThread();
    const res = await send();
    const mail = sendgridMock.sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['tim@example.com']);
    expect(mail.cc).toEqual([]);
    expect(mail.subject).toBe('Re: FW: Invoice 4471 for approval [TP-1042]');
    expect(mail.inReplyTo).toBe('<tim-1@example.com>');
    expect(mail.references[mail.references.length - 1]).toBe('<tim-1@example.com>');
    // Their message is quoted; the requester's conversation is not.
    expect(mail.html).toContain('There was no attachment to the email.');
    expect(mail.html).toContain('Tim Example &lt;Tim@Example.com&gt; wrote:');
    expect(res.to).toBe('tim@example.com');
    expect(res.email.sent).toBe(true);
    expect(prismaMock.notificationDelivery.create.mock.calls[0][0].data).toMatchObject({
      notificationType: 'native_reply_to_participant', recipient: 'tim@example.com',
    });
  });

  test('is kept private and is not a requester reply: no reply event, no first-response stamp', async () => {
    armThread();
    await send();
    const stored = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ eventType: 'forward', isPrivate: true, visibility: 'private', authorType: 'agent', mirrorState: 'pending' });
    expect(stored.rawPayload).toMatchObject({
      to_emails: ['tim@example.com'],
      directReply: { entryId: 88, email: 'tim@example.com', name: 'Tim Example', wasForwardedTo: true },
      subject: 'Re: FW: Invoice 4471 for approval [TP-1042]',
    });
    expect(stored.rawPayload.forwardTo).toBeUndefined();
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
    const patch = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(patch.firstPublicAgentReplyAt).toBeUndefined();
    expect(patch.status).toBeUndefined();
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 501, 9101);
  });

  test('the Cc is only what the agent typed, never the ticket\'s "Also for" list', async () => {
    armThread();
    await send({ cc: ['lead@example.com', 'tim@example.com'] });
    const mail = sendgridMock.sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['tim@example.com']);
    expect(mail.cc).toEqual(['lead@example.com']);
  });

  test('the Graph lane threads under their message too', async () => {
    armThread();
    // The ticket's mailbox (pickOutboundMailboxForTicket reads the list).
    prismaMock.mailboxConnection.findMany.mockResolvedValue([{ id: 2, address: 'it@example.com', mode: 'both', isEnabled: true, isPrimary: true }]);
    graphMailClientMock.isConfigured.mockReturnValue(true);
    graphMailClientMock.sendMailAsMailbox.mockResolvedValue({ internetMessageId: '<g-2@example.com>' });
    const files = [{ originalname: 'invoice.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('%PDF') }];
    await send({}, files);
    const [mailbox, mail] = graphMailClientMock.sendMailAsMailbox.mock.calls[0];
    expect(mailbox).toBe('it@example.com');
    expect(mail.to).toEqual(['tim@example.com']);
    expect(mail.inReplyTo).toBe('<tim-1@example.com>');
    expect(mail.attachments.map((a) => a.name)).toEqual(['invoice.pdf']);
  });

  test('someone who was never forwarded the ticket gets the ticket\'s own reply subject', async () => {
    armThread({ ...forwardeeMessage, actorEmail: 'cc-person@example.com', actorName: 'Casey Cc' }, []);
    await ticketService.addReply(501, 1, { bodyText: 'Noted' }, actor, [], { replyToParticipant: { entryId: 88 } });
    const mail = sendgridMock.sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['cc-person@example.com']);
    expect(mail.subject).toBe('Re: Invoice 4471 for approval [TP-1042]');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload.directReply.wasForwardedTo).toBe(false);
  });

  test('a message from the requester is refused: Reply to requester is the path for that', async () => {
    armThread({ ...forwardeeMessage, actorEmail: 'RITA@example.com' });
    await expect(ticketService.addReply(501, 1, { bodyText: 'x' }, actor, [], { replyToParticipant: { entryId: 88 } }))
      .rejects.toThrow(/from the requester/);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('a recipient that is not that message\'s sender is refused (the requester is never swapped in)', async () => {
    armThread();
    await expect(ticketService.addReply(501, 1, { bodyText: 'x' }, actor, [], { replyToParticipant: { entryId: 88, email: 'rita@example.com' } }))
      .rejects.toThrow(/came from tim@example.com, not rita@example.com/);
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('an agent\'s own message, or one not on this ticket, cannot be answered this way', async () => {
    armThread({ ...forwardeeMessage, authorType: 'agent', incoming: false });
    await expect(send()).rejects.toThrow(/Only a message someone e-mailed/);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    await expect(send()).rejects.toThrow(/not on this ticket/);
    expect(prismaMock.ticketThreadEntry.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 88, ticketId: 501, workspaceId: 1 },
    }));
  });

  test('a plain reply still goes to the requester', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    await ticketService.addReply(501, 1, { bodyText: 'Hello Rita' }, actor, []);
    expect(sendgridMock.sendEmail.mock.calls[0][0].to).toEqual(['rita@example.com']);
  });

  // Review (a): the mail-loop risk fixed today.
  describe('never to our own mailboxes or a machine sender', () => {
    const fromAddress = (address) => ({ ...forwardeeMessage, actorEmail: address, actorName: null });
    const expectRefused = async (address, pattern) => {
      armThread(fromAddress(address), []);
      await expect(ticketService.addReply(501, 1, { bodyText: 'x' }, actor, [], { replyToParticipant: { entryId: 88 } }))
        .rejects.toThrow(pattern);
      expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
      expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    };

    test('one of our connected mailboxes, or a +tag variant of one', async () => {
      await expectRefused('IT@example.com', /it@example\.com is one of our own mailboxes/);
      await expectRefused('it+tp1042@example.com', /one of our own mailboxes/);
    });

    test('a no-reply or daemon sender (the defaults)', async () => {
      await expectRefused('no-reply@vendor.example.com', /automated sender .*"no-reply"/);
      await expectRefused('MAILER-DAEMON@example.org', /automated sender/);
    });

    test('an address on the workspace\'s machine-sender list', async () => {
      prismaMock.appSettings.findUnique.mockImplementation(async ({ where }) => (
        where.key === machineSenderSettingKey(1) ? { key: where.key, value: JSON.stringify({ entries: ['alerts@monitor.example.com'] }) } : null
      ));
      invalidateMachineSenderCache();
      await expectRefused('alerts@monitor.example.com', /automated sender .*"alerts@monitor\.example\.com"/);
    });

    test('our mailbox list cannot be read at all: nothing is sent', async () => {
      ownMock.fail = new Error('db down');
      await expectRefused('tim@example.com', /could not check its own mailboxes/);
    });
  });

  // Review (b): the subject always carries the ticket token.
  test('a subject stored on their message keeps the [TP-n] token', async () => {
    armThread({ ...forwardeeMessage, rawPayload: { subject: 'RE: Invoice question' } }, []);
    await send();
    expect(sendgridMock.sendEmail.mock.calls[0][0].subject).toBe('RE: Invoice question [TP-1042]');
    expect(withTicketToken('Re: FW: Thing [tp-1042]', 'TP-1042')).toBe('Re: FW: Thing [tp-1042]');
  });

  // Review (c): FreshService tickets.
  describe('on a FreshService ticket', () => {
    const fsTicket = { ...ticket, origin: 'freshservice', freshserviceTicketId: '24800', nativeNumber: null };
    test('refused where FreshService sends its replies', async () => {
      prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
      armThread();
      await expect(send()).rejects.toThrow(/sent by FreshService/);
      expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    });

    test('sent by Ticket Pulse where it sends FS-born replies, kept on this ticket only (like a forward)', async () => {
      fsLaneMock.enabled = true;
      prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
      armThread();
      await send();
      expect(sendgridMock.sendEmail.mock.calls[0][0].to).toEqual(['tim@example.com']);
      const stored = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
      expect(stored).toMatchObject({ isPrivate: true, mirrorState: null });
      expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
    });
  });
});

describe('participantQuote', () => {
  test('quotes the one message, escaped, with a plain-text twin', () => {
    const q = participantQuote({ actorName: 'Tim <x>', actorEmail: 'tim@example.com', bodyText: 'line 1\nline 2', occurredAt: '2026-11-23T18:00:00Z' }, 'America/Vancouver');
    expect(q.html).toContain('Tim &lt;x&gt; &lt;tim@example.com&gt; wrote:');
    expect(q.html).toContain('line 1<br/>line 2');
    expect(q.text).toMatch(/wrote:\n> line 1\n> line 2$/);
    expect(participantQuote({ actorName: 'A', bodyText: '' })).toBeNull();
  });
});
