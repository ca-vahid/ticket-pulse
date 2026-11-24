/**
 * Mail loop guard (24 Nov 2026). In Accounting, a workflow acknowledgement went
 * from the AP mailbox to the AR mailbox (the ticket's requester), came back in
 * as a new ticket "from" AR, whose acknowledgement went back to AP, and so on:
 * 39 e-mails and 19 tickets in nineteen minutes.
 *   1. Sending: a workflow e-mail never goes to one of our own mailboxes.
 *   2. Intake: our own mail coming back is never a ticket or a reply.
 *   3. Intake: a ticket is never filed for one of our own mailboxes.
 * Invented addresses only (ourco.example, client.example).
 */
import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  approvalMessage: { findFirst: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn(), update: jest.fn() },
  notificationWorkflowRun: { findUnique: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const settings = new Map();
const settingsMock = {
  get: jest.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  set: jest.fn(async (key, value) => { settings.set(key, String(value)); }),
  delete: jest.fn(async (key) => settings.delete(key)),
};
const holdMock = { holdMessage: jest.fn(), isKnownMessageId: jest.fn(), recordSkipped: jest.fn() };
const graphMock = { isConfigured: jest.fn(() => true), getInboxMessagesForIngest: jest.fn(), getMessageAttachments: jest.fn(async () => ({ files: [], skipped: [] })) };
const ticketServiceMock = { createTicket: jest.fn() };
const mirrorServiceMock = { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn(), getInteractiveClient: jest.fn(async () => null) };
const activityMock = { create: jest.fn() };
const lifecycleMock = { emitTicketEvent: jest.fn(async () => ({ status: 'ok' })) };
const statusMock = {
  resolveBaseStatus: jest.fn(async (_ws, name) => (/closed/i.test(name) ? 'Closed' : /resolved/i.test(name) ? 'Resolved' : 'Open')),
  statusNamesForBase: jest.fn(async () => ['Open', 'Pending']),
};
const deliverMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: { link: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { isConfigured: () => false, upload: jest.fn(), buffersForThreadEntry: jest.fn(async () => []) } }));
jest.unstable_mockModule('../src/services/approvalConversationService.js', () => ({ default: { answer: jest.fn() }, plusAddressApprovalKey: () => null }));
jest.unstable_mockModule('../src/services/fsHelpdeskAddressService.js', () => ({
  fsHelpdeskAddresses: jest.fn(async () => new Set()), isFreshserviceTenantAddress: () => false, freshserviceWillIngest: async () => false,
}));
jest.unstable_mockModule('../src/services/fsTicketPrefixService.js', () => ({ fsTicketPrefixes: async () => [], default: {} }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusMock }));
jest.unstable_mockModule('../src/services/requesterReplyCopyService.js', () => ({ default: {}, copyAgentsOnRequesterReply: jest.fn(async () => ({ sent: true })) }));
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({ default: { notify: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock, emitTicketEvent: lifecycleMock.emitTicketEvent }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({ default: holdMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ deliverTransactionalEmail: deliverMock }));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName: jest.fn(async () => 'Accounting') }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ingest, selfSentReason, carriesOwnMark, intendedRequester } = await import('../src/services/mailboxIngestService.js');
const { processDelivery } = await import('../src/services/notificationDeliveryService.js');
const { invalidateOwnMailboxCache } = await import('../src/services/originalRecipientsService.js');
const { aliasSettingKey, invalidateAliasCache } = await import('../src/services/mailboxAliasService.js');
const { invalidateMachineSenderCache } = await import('../src/services/machineSenderService.js');
const { invalidateObserverCache } = await import('../src/services/workflowMailObserverService.js');

// Accounting's mailboxes: AP (with the "acc" alias) and AR; IT in another workspace.
const AP = 'ap@ourco.example';
const AR = 'ar@ourco.example';
const ACC = 'acc@ourco.example';
const IT = 'it@ourco.example';
const GLOBAL = 'ticketpulse@ourco.example';
const BOXES = [{ id: 5, address: AP }, { id: 6, address: AR }, { id: 9, address: IT }];
const apBox = { id: 5, workspaceId: 2, address: AP, intakeProfile: 'helpdesk', newTicketPolicy: 'create', agentCcIntake: true };
const plainBox = { id: 6, workspaceId: 2, address: AR, newTicketPolicy: 'create' };
const AGENT = { id: 41, name: 'Alex Rivera', email: 'alex.rivera@ourco.example' };
const CLIENT = 'jo.park@client.example';

let seq = 0;
const mail = (over = {}) => {
  seq += 1;
  return {
    id: `msg-${seq}`, subject: 'Invoice question', from: CLIENT, fromName: 'Jo Park', to: [AP], cc: [],
    receivedAt: new Date(), bodyHtml: null, bodyText: 'Hello, a question about invoice 77.', bodyPreview: 'Hello',
    internetMessageId: `<m-${seq}@client.example>`, inReplyTo: null, references: null, ...over,
  };
};
// What the AR mailbox's "Ticket received" acknowledgement looks like when it lands in AP.
const ackFromAr = (over = {}) => mail({
  from: AR, fromName: 'Accounts Receivable', sender: AR, senderName: 'Accounts Receivable', to: [AP],
  subject: 'Ticket received [TP-3101]: Invoice question', bodyText: 'We received your request.', ...over,
});

const delivery = (over = {}) => ({
  id: 701, workspaceId: 2, ticketId: 3101, channel: 'email', workflowRunId: 91, recipient: AR,
  toRecipients: [AR], ccRecipients: [], bccRecipients: [], subject: 'Ticket received [TP-3101]',
  htmlBody: '<p>We received your request.</p>', textBody: 'We received your request.', payload: { node: 'send' }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  invalidateOwnMailboxCache();
  invalidateAliasCache();
  invalidateMachineSenderCache();
  invalidateObserverCache();
  settings.set(aliasSettingKey(5), ACC);
  settings.set('sendgrid_from_email', GLOBAL);
  ingest._heldMessageIds?.clear?.();
  prismaMock.mailboxConnection.findMany.mockResolvedValue(BOXES);
  prismaMock.mailboxConnection.findFirst.mockImplementation(async ({ where }) => {
    const wanted = (where?.OR || []).map((c) => String(c?.address?.equals || '').toLowerCase());
    const box = BOXES.find((b) => wanted.includes(b.address));
    return box ? { id: box.id } : null;
  });
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.approvalMessage.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.requester.findUnique.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['ourco.example'] });
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (String(where?.email?.equals || '').toLowerCase() === AGENT.email ? AGENT : null));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationWorkflowRun.findUnique.mockResolvedValue({ workflowId: 16100 });
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  ticketServiceMock.createTicket.mockImplementation(async () => ({ id: 700 + seq, displayRef: `TP-${3000 + seq}`, workspaceId: 2 }));
  deliverMock.mockResolvedValue({ provider: 'msgraph', providerMessageId: '<tp-1-a@ourco.example>', messageId: '<tp-1-a@ourco.example>', via: 'msgraph', from: AP });
});

const created = () => ticketServiceMock.createTicket.mock.calls.map(([ws, payload, , options]) => ({ ws, ...payload, ...options }));
const skippedWith = () => holdMock.recordSkipped.mock.calls.map(([, , reason]) => reason);
const updateData = () => prismaMock.notificationDelivery.update.mock.calls[0][0].data;

// ---------------------------------------------------------------------------
describe('1. sending: a workflow e-mail never goes to our own mailboxes', () => {
  test('AP sends the acknowledgement to AR (the requester): not sent, skipped, reason own_mailbox', async () => {
    const res = await processDelivery(delivery());
    expect(res).toMatchObject({ success: true, skipped: 'own_mailbox' });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(updateData()).toMatchObject({
      status: 'skipped',
      error: null,
      payload: { node: 'send', skippedReason: 'own_mailbox', ownMailboxRemoved: [{ address: AR, field: 'to' }] },
    });
  });

  test('every shape of our address comes off: another workspace, an alias, a +tag, the global sender, a FreshService relay; the person still gets it', async () => {
    await processDelivery(delivery({
      recipient: CLIENT,
      toRecipients: [CLIENT, 'Accounts Receivable <AR@ourco.example>'],
      ccRecipients: [ACC, 'ap+tp3101@ourco.example', IT, GLOBAL, 'support@ourco.freshservice.com', 'sam.ortiz@client.example'],
      bccRecipients: ['ar+fs12@ourco.example'],
    }));
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][0]).toMatchObject({ to: [CLIENT], cc: ['sam.ortiz@client.example'], bcc: [], automated: true });
    const data = updateData();
    expect(data).toMatchObject({ status: 'sent', toRecipients: [CLIENT], ccRecipients: ['sam.ortiz@client.example'], bccRecipients: [] });
    expect(data.payload.ownMailboxRemoved.map((r) => `${r.field}:${r.address}`)).toEqual([
      `to:${AR}`, `cc:${ACC}`, 'cc:ap+tp3101@ourco.example', `cc:${IT}`, `cc:${GLOBAL}`, 'cc:support@ourco.freshservice.com', 'bcc:ar+fs12@ourco.example',
    ]);
  });

  test('normal recipients: sent exactly as before, marked automatic, nothing extra on the record', async () => {
    await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT], ccRecipients: ['sam.ortiz@client.example'] }));
    expect(deliverMock.mock.calls[0][0]).toMatchObject({ to: [CLIENT], cc: ['sam.ortiz@client.example'], automated: true });
    const data = updateData();
    expect(data.status).toBe('sent');
    expect(data.toRecipients).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });

  test('our mailbox list cannot be read: nothing is sent, the delivery fails (retryable) and says why', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    const res = await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT] }));
    expect(res.success).toBe(false);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(updateData()).toMatchObject({ status: 'failed', payload: expect.objectContaining({ lastErrorClass: 'own_mailbox_unverified', lastErrorRetryable: true }) });
    expect(updateData().error).toMatch(/own-mailbox list could not be read/);
  });

  test('not a workflow e-mail (no run): the guard does not apply and the mail is not marked automatic', async () => {
    await processDelivery(delivery({ workflowRunId: null, notificationType: 'assignment', recipient: 'alex.rivera@ourco.example', toRecipients: ['alex.rivera@ourco.example'] }));
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][0].automated).toBeUndefined();
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('2. intake: our own mail coming back is never a ticket', () => {
  test('the pure rule: From any of our mailboxes or the global sender, our mark, and the person-sent exception', () => {
    const own = [AP, ACC, AR, IT, GLOBAL];
    expect(selfSentReason({ from: AR }, own)).toBe('self_send');
    expect(selfSentReason({ from: 'AR+tp3101@ourco.example', sender: AR }, own)).toBe('self_send');
    expect(selfSentReason({ from: GLOBAL }, own)).toBe('self_send');
    expect(selfSentReason({ from: CLIENT }, own)).toBeNull();
    // A person sending as / on behalf of the mailbox keeps today's path...
    expect(selfSentReason({ from: ACC, sender: AGENT.email }, own)).toBeNull();
    // ...unless the mail says it is automatic, or carries our mark.
    expect(selfSentReason({ from: AR, sender: AGENT.email, autoSubmitted: 'auto-generated' }, own)).toBe('self_send');
    expect(selfSentReason({ from: AR, sender: AGENT.email, autoSubmitted: 'no' }, own)).toBeNull();
    expect(selfSentReason({ from: CLIENT, ticketPulseMail: 'workflow' }, own)).toBe('self_send');
    expect(carriesOwnMark({ internetMessageId: '<tp-1764021720000-k3j9x0abcdq1w2@ourco.example>' })).toBe(true);
    expect(carriesOwnMark({ internetMessageId: '<tp-3101-mfa1b2c3.0a1b2c3d4e5f6a7b8c@ourco.example>' })).toBe(true);
    expect(carriesOwnMark({ internetMessageId: '<CAJx7=tp-1@mail.example.com>' })).toBe(false);
    expect(carriesOwnMark({ internetMessageId: '<SN6PR01MB1234@SN6PR01MB1234.prod.outlook.com>' })).toBe(false);
  });

  test('an acknowledgement from the other team mailbox: skipped (self_send), recorded, no ticket, no reply', async () => {
    expect(await ingest.processEmail(apBox, ackFromAr())).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('also on a standard (non-helpdesk) mailbox, and also when it threads onto a ticket by its headers', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockImplementation(async ({ where }) => (where?.emailMessageId?.in ? { ticketId: 880 } : null));
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 880, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 3101, status: 'Open', ccEmails: [], requesterId: 5 });
    const ack = mail({ from: AP, sender: AP, to: [AR], subject: 'RE: Invoice question [TP-3101]', inReplyTo: '<earlier@client.example>', references: '<earlier@client.example>' });
    expect(await ingest.processEmail(plainBox, ack)).toBe('skipped');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('from the global sender, or carrying our header / minted Message-ID from anywhere: skipped', async () => {
    expect(await ingest.processEmail(apBox, mail({ from: GLOBAL, subject: 'Ticket resolved [TP-3101]' }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail({ from: 'relay@mailer.example', ticketPulseMail: 'workflow' }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail({ from: 'relay@mailer.example', internetMessageId: '<tp-1764021720000-k3j9x0abcdq1w2@ourco.example>' }))).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send', 'self_send', 'self_send']);
  });

  test('an Auto-Submitted header: skipped on a standard mailbox (as before), and from our mailbox even when a person is named as Sender', async () => {
    expect(await ingest.processEmail(plainBox, mail({ to: [AR], autoSubmitted: 'auto-generated' }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, ackFromAr({ sender: AGENT.email, autoSubmitted: 'auto-generated' }))).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('a normal person: a ticket as before, filed for them', async () => {
    expect(await ingest.processEmail(apBox, mail())).toBe('created');
    expect(created()[0]).toMatchObject({ ws: 2, requesterEmail: CLIENT });
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });

  test('a person CCing a team mailbox on a real conversation: a ticket as before', async () => {
    expect(await ingest.processEmail(apBox, mail({ to: ['kim.lee@ourco.example'], cc: [AP, AR] }))).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT });
  });

  test('an agent sending as the mailbox’s public address: credited as the writer, a ticket for the person it went to (as before)', async () => {
    const sentAs = mail({ from: ACC, fromName: 'Accounting', sender: AGENT.email, senderName: AGENT.name, to: [CLIENT], cc: [ACC], subject: 'Statement for October' });
    expect(await ingest.processEmail(apBox, sentAs)).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT, createdVia: 'agent_cc', assignedTechId: AGENT.id });
  });

  test('an agent forwarding a client’s mail: a ticket for the client (as before)', async () => {
    const fwd = mail({
      from: AGENT.email, fromName: AGENT.name, to: [AP], subject: 'FW: Invoice question',
      bodyText: `Please handle.\n\nFrom: Jo Park <${CLIENT}>\nSent: Monday, November 23, 2026 9:14 AM\nTo: Alex Rivera <${AGENT.email}>\nSubject: Invoice question\n\nHello, a question about invoice 77.`,
    });
    expect(await ingest.processEmail(apBox, fwd)).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT });
  });

  test('the own-mailbox list cannot be read: today’s check still applies, and a person’s mail is still a ticket', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    expect(await ingest.processEmail(apBox, mail({ from: AP }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail({ from: 'relay@mailer.example', ticketPulseMail: 'workflow' }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail())).toBe('created');
  });
});

// ---------------------------------------------------------------------------
describe('3. intake: a ticket is never filed for one of our own mailboxes', () => {
  test('intendedRequester: the same picks as ticket creation', () => {
    expect(intendedRequester({ from: 'A@x.example' }, { kind: 'fresh' })).toBe('a@x.example');
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'forward', original: { email: AR } })).toBe(AR);
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'agent_cc', requester: { email: CLIENT } })).toBe(CLIENT);
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'fresh', forcedRequester: CLIENT })).toBe(CLIENT);
  });

  test('an agent forwarding the AR mailbox’s mail into AP: skipped (own_mailbox_requester), recorded, no ticket', async () => {
    const fwd = mail({
      from: AGENT.email, fromName: AGENT.name, to: [AP], subject: 'FW: Remittance advice',
      bodyText: `For AP.\n\nFrom: Accounts Receivable <${AR}>\nSent: Monday, November 23, 2026 9:14 AM\nTo: Jo Park <${CLIENT}>\nSubject: Remittance advice\n\nPlease find it attached.`,
    });
    expect(await ingest.processEmail(apBox, fwd)).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['own_mailbox_requester']);
  });

  test('a person sending on behalf of the AR mailbox (the mail stays AR’s): skipped, not a ticket for AR', async () => {
    const onBehalf = mail({ from: AR, fromName: 'Accounts Receivable', sender: 'kim.lee@ourco.example', senderName: 'Kim Lee', to: [AP], subject: 'Vendor statement' });
    expect(await ingest.processEmail(apBox, onBehalf)).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['own_mailbox_requester']);
  });
});
