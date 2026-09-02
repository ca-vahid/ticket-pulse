import { jest } from '@jest/globals';

/**
 * Phase RL (RL-4) — the mailbox hold queue: idempotent holds, attach →
 * ingestReply, create → createTicketFromEmail with forcedRequester, discard,
 * isKnownMessageId across thread entries / deliveries / held rows, and the
 * daily digest.
 */

const prismaMock = {
  mailboxHeldMessage: {
    findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn(), groupBy: jest.fn(),
  },
  ticketThreadEntry: { findFirst: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const ingestMock = { ingestReply: jest.fn(), createTicketFromEmail: jest.fn() };
const sendTransactionalEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mailboxIngestService.js', () => ({ default: ingestMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  sendTransactionalEmail: sendTransactionalEmailMock,
  default: { sendTransactionalEmail: sendTransactionalEmailMock },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn().mockResolvedValue('fallback@example.com') } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: mailboxHoldService, heldMessageKey, snippetFor, rehydrateEmail, HOLD_REASONS, NEW_TICKET_POLICIES } = await import('../src/services/mailboxHoldService.js');

const connection = { id: 11, workspaceId: 5, address: 'patickets@bgcengineering.ca' };
const email = {
  id: 'AAMk-graph-1',
  subject: 'Re: Invoice question',
  from: 'Susan.Xu@vendor.example',
  fromName: 'Susan Xu',
  to: ['patickets@bgcengineering.ca'],
  cc: ['boss@vendor.example'],
  receivedAt: new Date('2026-09-01T15:54:23Z'),
  bodyPreview: 'Here is the receipt you asked for.',
  bodyHtml: '<p>Here is the receipt you asked for.</p>',
  bodyText: null,
  internetMessageId: '<abc-1@vendor.example>',
  inReplyTo: '<never-seen@elsewhere.example>',
  references: '<never-seen@elsewhere.example>',
  hasAttachments: true,
};
const actor = { email: 'ari@bgcengineering.ca', name: 'Ari Agent' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(null);
  prismaMock.mailboxHeldMessage.create.mockImplementation(({ data }) => Promise.resolve({ id: 501, status: 'held', ...data }));
  prismaMock.mailboxHeldMessage.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([]);
  prismaMock.mailboxHeldMessage.count.mockResolvedValue(0);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  ingestMock.ingestReply.mockResolvedValue({ id: 9001 });
  ingestMock.createTicketFromEmail.mockResolvedValue({ id: 700, displayRef: 'TP-1300', workspaceId: 5 });
});

describe('contract surface', () => {
  test('exports the reason vocabulary and the policy enum the routes validate against', () => {
    expect(HOLD_REASONS).toEqual(expect.arrayContaining(['unknown_reference', 'agent_reply_no_requester', 'ambiguous_sender']));
    expect(NEW_TICKET_POLICIES).toEqual(['create', 'replies_only', 'hold_unmatched']);
  });
  test('heldMessageKey prefers the RFC Message-ID and falls back to the Graph id', () => {
    expect(heldMessageKey(email)).toBe('<abc-1@vendor.example>');
    expect(heldMessageKey({ id: 'g-9' })).toBe('graph:g-9');
  });
  test('snippetFor caps at 500 chars and strips HTML when only a body is present', () => {
    expect(snippetFor({ bodyHtml: '<p>Hello <b>there</b></p>' })).toBe('Hello there');
    expect(snippetFor({ bodyPreview: 'x'.repeat(900) })).toHaveLength(500);
  });
});

describe('holdMessage', () => {
  test('creates a held row with the mapped email, snippet, recipients, reason, best guess and decision', async () => {
    const result = await mailboxHoldService.holdMessage(connection, email, {
      reason: 'unknown_reference', bestGuessTicketId: 42, candidates: null, decision: { rule: 3, via: 'rung0' },
    });
    expect(result).toEqual({ id: 501, status: 'held', duplicate: false });
    const { data } = prismaMock.mailboxHeldMessage.create.mock.calls[0][0];
    expect(data).toMatchObject({
      workspaceId: 5, connectionId: 11, internetMessageId: '<abc-1@vendor.example>',
      fromEmail: 'susan.xu@vendor.example', fromName: 'Susan Xu',
      toEmails: ['patickets@bgcengineering.ca'], ccEmails: ['boss@vendor.example'],
      subject: 'Re: Invoice question', snippet: 'Here is the receipt you asked for.',
      bodyHtml: '<p>Here is the receipt you asked for.</p>',
      reason: 'unknown_reference', bestGuessTicketId: 42, decision: { rule: 3, via: 'rung0' }, status: 'held',
    });
    // The payload keeps everything the ingest pipeline reads (minus the HTML body).
    expect(data.emailPayload).toMatchObject({ id: 'AAMk-graph-1', inReplyTo: '<never-seen@elsewhere.example>', hasAttachments: true });
    expect(data.emailPayload).not.toHaveProperty('bodyHtml');
    expect(data.receivedAt).toEqual(email.receivedAt);
  });

  test('is idempotent on (connectionId, internetMessageId) — a duplicate returns the existing row and never re-opens it', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue({ id: 77, status: 'attached' });
    const result = await mailboxHoldService.holdMessage(connection, email, { reason: 'unknown_reference' });
    expect(result).toEqual({ id: 77, status: 'attached', duplicate: true });
    expect(prismaMock.mailboxHeldMessage.create).not.toHaveBeenCalled();
    expect(prismaMock.mailboxHeldMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 11, internetMessageId: '<abc-1@vendor.example>' },
    }));
  });

  test('a lost unique-index race resolves to the winner row', async () => {
    prismaMock.mailboxHeldMessage.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 88, status: 'held' });
    const result = await mailboxHoldService.holdMessage(connection, email, { reason: 'unknown_reference' });
    expect(result).toEqual({ id: 88, status: 'held', duplicate: true });
  });

  test('agent_reply_no_requester stores the address candidates for the chooser', async () => {
    await mailboxHoldService.holdMessage(connection, email, {
      reason: 'agent_reply_no_requester', candidates: ['Alvina@Vendor.example', 'bob@bgcengineering.ca', 'Alvina@Vendor.example'],
    });
    expect(prismaMock.mailboxHeldMessage.create.mock.calls[0][0].data.candidates).toEqual(['alvina@vendor.example', 'bob@bgcengineering.ca']);
  });

  test('an unknown reason is stored as unknown_reference; a missing connection throws', async () => {
    await mailboxHoldService.holdMessage(connection, email, { reason: 'something_else' });
    expect(prismaMock.mailboxHeldMessage.create.mock.calls[0][0].data.reason).toBe('unknown_reference');
    await expect(mailboxHoldService.holdMessage(null, email, { reason: 'unknown_reference' })).rejects.toThrow(/connection/);
  });
});

describe('isKnownMessageId', () => {
  test('false for empty input without touching the DB', async () => {
    expect(await mailboxHoldService.isKnownMessageId(5, [])).toBe(false);
    expect(prismaMock.ticketThreadEntry.findFirst).not.toHaveBeenCalled();
  });
  test('true when a thread entry, a delivery (message_id OR provider_message_id) or a held row carries the id', async () => {
    expect(await mailboxHoldService.isKnownMessageId(5, ['<x@y>'])).toBe(false);
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({ id: 1 });
    expect(await mailboxHoldService.isKnownMessageId(5, ['<x@y>'])).toBe(true);
    expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 5, OR: [{ messageId: { in: ['<x@y>'] } }, { providerMessageId: { in: ['<x@y>'] } }] },
    }));
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValueOnce({ id: 2 });
    expect(await mailboxHoldService.isKnownMessageId(5, '<held@y>')).toBe(true);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce({ id: 3 });
    expect(await mailboxHoldService.isKnownMessageId(5, ['<a@y>', '<b@y>'])).toBe(true);
    expect(prismaMock.ticketThreadEntry.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { workspaceId: 5, emailMessageId: { in: ['<a@y>', '<b@y>'] } },
    }));
  });
});

describe('list', () => {
  test('returns held rows newest-first with the best-guess ticket hydrated and the body/payload stripped', async () => {
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([{
      id: 501, workspaceId: 5, connectionId: 11, reason: 'unknown_reference', status: 'held', bestGuessTicketId: 42,
      resolvedTicketId: null, bodyHtml: '<p>x</p>', emailPayload: { id: 'g' }, connection: { address: 'patickets@bgcengineering.ca' },
    }]);
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 42, nativeNumber: 1204, freshserviceTicketId: null, origin: 'ticketpulse', subject: 'Invoice', status: 'Open' }]);
    const rows = await mailboxHoldService.list(5, { status: 'held' });
    expect(prismaMock.mailboxHeldMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 5, status: 'held' },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    }));
    expect(rows[0]).toMatchObject({ id: 501, hasBody: true, connectionAddress: 'patickets@bgcengineering.ca', bestGuessTicket: { id: 42, displayRef: 'TP-1204', subject: 'Invoice' } });
    expect(rows[0]).not.toHaveProperty('bodyHtml');
    expect(rows[0]).not.toHaveProperty('emailPayload');
  });
});

function heldRow(overrides = {}) {
  return {
    id: 501, workspaceId: 5, connectionId: 11, status: 'held', reason: 'unknown_reference',
    internetMessageId: '<abc-1@vendor.example>', fromEmail: 'susan.xu@vendor.example', fromName: 'Susan Xu',
    toEmails: ['patickets@bgcengineering.ca'], ccEmails: [], subject: 'Re: Invoice question', snippet: 'Here is the receipt',
    bodyHtml: '<p>Here is the receipt you asked for.</p>',
    emailPayload: { id: 'AAMk-graph-1', from: 'susan.xu@vendor.example', fromName: 'Susan Xu', receivedAt: '2026-09-01T15:54:23.000Z', internetMessageId: '<abc-1@vendor.example>', inReplyTo: '<never-seen@elsewhere.example>', hasAttachments: true },
    receivedAt: new Date('2026-09-01T15:54:23Z'),
    connection, ...overrides,
  };
}

describe('attach', () => {
  test('re-hydrates the stored email and calls ingestReply(connection, ticket, email, via); row → attached', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow());
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 42, workspaceId: 5, origin: 'ticketpulse', status: 'Open', nativeNumber: 1204, requester: { email: 'susan.xu@vendor.example' } });

    const result = await mailboxHoldService.attach(501, 42, actor, { workspaceId: 5 });

    expect(ingestMock.ingestReply).toHaveBeenCalledTimes(1);
    const [conn, ticket, mail, via] = ingestMock.ingestReply.mock.calls[0];
    expect(conn).toBe(connection);
    expect(ticket.id).toBe(42);
    expect(via).toBe('held_reply_attach');
    expect(mail).toMatchObject({
      id: 'AAMk-graph-1', from: 'susan.xu@vendor.example', fromName: 'Susan Xu',
      bodyHtml: '<p>Here is the receipt you asked for.</p>', internetMessageId: '<abc-1@vendor.example>',
      inReplyTo: '<never-seen@elsewhere.example>', hasAttachments: true,
    });
    expect(mail.receivedAt).toBeInstanceOf(Date);
    expect(prismaMock.mailboxHeldMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({ status: 'attached', resolvedBy: 'ari@bgcengineering.ca', resolvedTicketId: 42 }),
    }));
    expect(result.ticket).toEqual({ id: 42, displayRef: 'TP-1204' });
    expect(result.held.status).toBe('attached');
  });

  test('refuses a ticket outside the workspace, a deleted ticket, and an already-resolved row', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow());
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await expect(mailboxHoldService.attach(501, 999, actor)).rejects.toThrow(/Ticket not found/);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 42, workspaceId: 5, status: 'Deleted' });
    await expect(mailboxHoldService.attach(501, 42, actor)).rejects.toThrow(/deleted/);
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow({ status: 'discarded' }));
    await expect(mailboxHoldService.attach(501, 42, actor)).rejects.toThrow(/already discarded/);
    expect(ingestMock.ingestReply).not.toHaveBeenCalled();
  });
});

describe('createTicket', () => {
  test('calls createTicketFromEmail(connection, email, { kind: fresh, forcedRequester, createdVia: held_reply }); row → created', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow({ reason: 'agent_reply_no_requester' }));

    const result = await mailboxHoldService.createTicket(501, { requesterEmail: 'Alvina@Vendor.example', actor, workspaceId: 5 });

    const [conn, mail, intake] = ingestMock.createTicketFromEmail.mock.calls[0];
    expect(conn).toBe(connection);
    expect(mail.bodyHtml).toBe('<p>Here is the receipt you asked for.</p>');
    expect(intake).toMatchObject({ kind: 'fresh', forcedRequester: 'alvina@vendor.example', createdVia: 'held_reply', heldMessageId: 501 });
    expect(prismaMock.mailboxHeldMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'created', resolvedTicketId: 700 }),
    }));
    expect(result.ticket).toMatchObject({ id: 700, displayRef: 'TP-1300' });
  });

  test('no requesterEmail → forcedRequester null (sender wins); a malformed one is rejected', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow());
    await mailboxHoldService.createTicket(501, { actor });
    expect(ingestMock.createTicketFromEmail.mock.calls[0][2].forcedRequester).toBeNull();
    await expect(mailboxHoldService.createTicket(501, { requesterEmail: 'not-an-email', actor })).rejects.toThrow(/valid email/);
  });
});

describe('discard', () => {
  test('marks the row discarded with the actor; nothing is ingested', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow());
    const held = await mailboxHoldService.discard(501, actor, { workspaceId: 5 });
    expect(held.status).toBe('discarded');
    expect(prismaMock.mailboxHeldMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'discarded', resolvedBy: 'ari@bgcengineering.ca', resolvedTicketId: null }),
    }));
    expect(ingestMock.ingestReply).not.toHaveBeenCalled();
    expect(ingestMock.createTicketFromEmail).not.toHaveBeenCalled();
  });
});

describe('rehydrateEmail', () => {
  test('falls back to the row columns when the payload is missing and never resurrects a synthetic graph: key as a Message-ID', () => {
    const mail = rehydrateEmail({ internetMessageId: 'graph:g-1', subject: 'S', fromEmail: 'a@b.c', toEmails: ['x@y.z'], bodyHtml: '<p>b</p>', snippet: 'b', emailPayload: null, receivedAt: '2026-09-01T00:00:00Z' });
    expect(mail).toMatchObject({ subject: 'S', from: 'a@b.c', to: ['x@y.z'], bodyHtml: '<p>b</p>', internetMessageId: null });
    expect(mail.receivedAt).toBeInstanceOf(Date);
  });
});

describe('sendDailyDigests', () => {
  test('emails workspace admins once per workspace with held rows; skips workspaces with empty queues', async () => {
    prismaMock.mailboxHeldMessage.groupBy.mockResolvedValue([{ workspaceId: 5, _count: { _all: 2 } }]);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Admin@bgcengineering.ca' }]);
    prismaMock.workspace.findUnique.mockResolvedValue({ name: 'PA' });
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([heldRow(), heldRow({ id: 502, subject: 'Re: <script>x</script>' })]);
    sendTransactionalEmailMock.mockResolvedValue({ sent: true, via: 'sendgrid' });

    const result = await mailboxHoldService.sendDailyDigests({ appUrl: 'https://ticketpulse.example' });

    expect(result.sent).toEqual([{ workspaceId: 5, count: 2, recipients: 1, sent: true, via: 'sendgrid' }]);
    const params = sendTransactionalEmailMock.mock.calls[0][0];
    expect(params).toMatchObject({ workspaceId: 5, to: ['admin@bgcengineering.ca'], label: 'mailbox-hold-digest' });
    expect(params.subject).toBe('Ticket Pulse: 2 unmatched replies waiting for review');
    expect(params.html).toContain('https://ticketpulse.example/settings#ticket-mailboxes');
    expect(params.html).toContain('&lt;script&gt;'); // subjects are escaped
  });

  test('falls back to the global admin_emails setting when the workspace has no admin rows; no rows → nothing sent', async () => {
    prismaMock.mailboxHeldMessage.groupBy.mockResolvedValue([{ workspaceId: 5, _count: { _all: 1 } }]);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([heldRow()]);
    sendTransactionalEmailMock.mockResolvedValue({ sent: true, via: 'msgraph' });
    await mailboxHoldService.sendDailyDigests();
    expect(sendTransactionalEmailMock.mock.calls[0][0].to).toEqual(['fallback@example.com']);

    jest.clearAllMocks();
    prismaMock.mailboxHeldMessage.groupBy.mockResolvedValue([]);
    expect(await mailboxHoldService.sendDailyDigests()).toEqual({ sent: [] });
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });
});
