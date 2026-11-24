/**
 * Mail loop guard (24 Nov 2026). In Accounting, a workflow acknowledgement went
 * from the AP mailbox to the AR mailbox (the ticket's requester), came back in
 * as a new ticket "from" AR, whose acknowledgement went back to AP, and so on:
 * 39 e-mails and 19 tickets in nineteen minutes.
 *   1. Sending: a workflow e-mail (and the editor's test send) never goes to
 *      one of our own ENABLED mailboxes; a failed list read uses the last good list.
 *   2. Intake: mail that is provably ours (our header, Auto-Submitted from our
 *      mailbox, a Message-ID we minted on our domain or one our sends recorded)
 *      is skipped. Unproven mail From another team mailbox goes on as any mail:
 *      with Exchange "Send As" a clerk's reply looks exactly like the mailbox.
 *   3. Intake: unmarked mail that would open a ticket FOR one of our mailboxes
 *      (a hand-off) is held for a person, never created.
 * Invented addresses only (ourco.example, client.example, vendor.example).
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
const approvalMock = { answer: jest.fn(), plusAddressApprovalKey: jest.fn(() => null) };
const deliverMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: { link: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { isConfigured: () => false, upload: jest.fn(), buffersForThreadEntry: jest.fn(async () => []) } }));
jest.unstable_mockModule('../src/services/approvalConversationService.js', () => ({
  default: { answer: (...args) => approvalMock.answer(...args) },
  plusAddressApprovalKey: (...args) => approvalMock.plusAddressApprovalKey(...args),
}));
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

const { default: ingest, ownMailProof, ownMark, intendedRequester } = await import('../src/services/mailboxIngestService.js');
const { processDelivery, ownMailboxSplit } = await import('../src/services/notificationDeliveryService.js');
const { invalidateOwnMailboxCache } = await import('../src/services/originalRecipientsService.js');
const { aliasSettingKey, invalidateAliasCache } = await import('../src/services/mailboxAliasService.js');
const { invalidateMachineSenderCache } = await import('../src/services/machineSenderService.js');
const { invalidateObserverCache } = await import('../src/services/workflowMailObserverService.js');
const { DEFAULT_MESSAGE_ID_DOMAIN } = await import('../src/services/emailThreadingService.js');
const { rememberSentMessageId, wasRecentlySent, clearRecentSentMessageIds, RECENT_SENT_TTL_MS } = await import('../src/utils/recentSentMessageIds.js');
const { ownMailboxAddresses, OWN_FAILURE_TTL_MS } = await import('../src/services/originalRecipientsService.js');
const { senderKindFor, PERSON_REASONS } = await import('../src/utils/heldAlertGroups.js');

// Accounting's mailboxes: AP (with the "acc" alias) and AR; IT in another workspace;
// an old connection that was switched off.
const AP = 'ap@ourco.example';
const AR = 'ar@ourco.example';
const ACC = 'acc@ourco.example';
const IT = 'it@ourco.example';
const OLD = 'old-intake@ourco.example';
const GLOBAL = 'ticketpulse@ourco.example';
const BOXES = [
  { id: 5, workspaceId: 2, address: AP, isEnabled: true },
  { id: 6, workspaceId: 2, address: AR, isEnabled: true },
  { id: 9, workspaceId: 1, address: IT, isEnabled: true },
  { id: 11, workspaceId: 2, address: OLD, isEnabled: false },
];
const apBox = { id: 5, workspaceId: 2, address: AP, intakeProfile: 'helpdesk', newTicketPolicy: 'create', agentCcIntake: true };
const plainBox = { id: 6, workspaceId: 2, address: AR, newTicketPolicy: 'create' };
const AGENT = { id: 41, name: 'Alex Rivera', email: 'alex.rivera@ourco.example' };
const CLIENT = 'jo.park@client.example';
// An Exchange-made Message-ID (Graph createReply): no tp- shape.
const EXCHANGE_ID = '<SN6PR01MB4321A1B2C3D4E5F6@SN6PR01MB4321.prod.outlook.example>';
const OUR_TP_ID = '<tp-1764021720000-k3j9x0abcdq1w2@ourco.example>';

// What our sends recorded (notification_deliveries.message_id / Ticket Pulse thread entries),
// and the Message-IDs ticket threads know (for In-Reply-To matching).
const sentDeliveryIds = new Set();
const sentEntryIds = new Set();
const threadRefs = new Map(); // Message-ID -> ticketId

let seq = 0;
const mail = (over = {}) => {
  seq += 1;
  return {
    id: `msg-${seq}`, subject: 'Invoice question', from: CLIENT, fromName: 'Jo Park', to: [AP], cc: [],
    receivedAt: new Date(), bodyHtml: null, bodyText: 'Hello, a question about invoice 77.', bodyPreview: 'Hello',
    internetMessageId: `<m-${seq}@client.example>`, inReplyTo: null, references: null, ...over,
  };
};
// Mail from the AR mailbox as Exchange shows it (Send As: Sender == From).
const fromAr = (over = {}) => mail({ from: AR, fromName: 'Accounts Receivable', sender: AR, senderName: 'Accounts Receivable', to: [AP], ...over });

const delivery = (over = {}) => ({
  id: 701, workspaceId: 2, ticketId: 3101, channel: 'email', workflowRunId: 91, recipient: AR,
  toRecipients: [AR], ccRecipients: [], bccRecipients: [], subject: 'Ticket received [TP-3101]',
  htmlBody: '<p>We received your request.</p>', textBody: 'We received your request.', payload: { node: 'send' }, ...over,
});

const OPEN_TICKET = { id: 880, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 3101, subject: 'Invoice question', status: 'Open', ccEmails: [], requesterId: 5 };

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  sentDeliveryIds.clear();
  sentEntryIds.clear();
  threadRefs.clear();
  invalidateOwnMailboxCache();
  clearRecentSentMessageIds();
  invalidateAliasCache();
  invalidateMachineSenderCache();
  invalidateObserverCache();
  settings.set(aliasSettingKey(5), ACC);
  settings.set('sendgrid_from_email', GLOBAL);
  ingest._heldMessageIds?.clear?.();
  approvalMock.plusAddressApprovalKey.mockImplementation(() => null);
  approvalMock.answer.mockResolvedValue({ ok: true });
  prismaMock.mailboxConnection.findMany.mockImplementation(async ({ where } = {}) => BOXES
    .filter((b) => (where?.isEnabled === undefined ? true : b.isEnabled === where.isEnabled))
    .map(({ id, workspaceId, address }) => ({ id, workspaceId, address })));
  prismaMock.mailboxConnection.findFirst.mockImplementation(async ({ where }) => {
    const wanted = (where?.OR || []).map((c) => String(c?.address?.equals || '').toLowerCase());
    const box = BOXES.find((b) => wanted.includes(b.address));
    return box ? { id: box.id } : null;
  });
  prismaMock.ticketThreadEntry.findFirst.mockImplementation(async ({ where }) => {
    const ids = where?.emailMessageId?.in || [];
    if (where?.source === 'ticketpulse_user') return ids.some((id) => sentEntryIds.has(id)) ? { id: 1 } : null;
    const hit = ids.find((id) => threadRefs.has(id));
    return hit ? { ticketId: threadRefs.get(hit) } : null;
  });
  prismaMock.notificationDelivery.findFirst.mockImplementation(async ({ where }) => {
    const ids = where?.messageId?.in || [];
    return ids.some((id) => sentDeliveryIds.has(id)) ? { id: 2 } : null;
  });
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.approvalMessage.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.findUnique.mockImplementation(async ({ where }) => (where?.id === OPEN_TICKET.id ? OPEN_TICKET : null));
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.requester.findUnique.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['ourco.example'] });
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (String(where?.email?.equals || '').toLowerCase() === AGENT.email ? AGENT : null));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationWorkflowRun.findUnique.mockResolvedValue({ workflowId: 16100 });
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  ticketServiceMock.createTicket.mockImplementation(async () => ({ id: 700 + seq, displayRef: `TP-${3000 + seq}`, workspaceId: 2 }));
  deliverMock.mockResolvedValue({ provider: 'msgraph', providerMessageId: OUR_TP_ID, messageId: OUR_TP_ID, via: 'msgraph', from: AP });
});

const created = () => ticketServiceMock.createTicket.mock.calls.map(([ws, payload, , options]) => ({ ws, ...payload, ...options }));
const skippedWith = () => holdMock.recordSkipped.mock.calls.map(([, , reason]) => reason);
const heldWith = () => holdMock.holdMessage.mock.calls.map(([, , opts]) => opts);
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

  test('a disabled mailbox connection is not ours: its address gets the e-mail', async () => {
    await processDelivery(delivery({ recipient: OLD, toRecipients: [OLD] }));
    expect(deliverMock.mock.calls[0][0]).toMatchObject({ to: [OLD] });
    expect(prismaMock.mailboxConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isEnabled: true } }));
  });

  test('normal recipients: sent exactly as before, marked automatic, nothing extra on the record', async () => {
    await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT], ccRecipients: ['sam.ortiz@client.example'] }));
    expect(deliverMock.mock.calls[0][0]).toMatchObject({ to: [CLIENT], cc: ['sam.ortiz@client.example'], automated: true });
    const data = updateData();
    expect(data.status).toBe('sent');
    expect(data.toRecipients).toBeUndefined();
    expect(data.payload).toBeUndefined();
  });

  test('a list read failure with a stale cache still strips (the last good list, past its minute)', async () => {
    await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT] })); // loads the list
    invalidateOwnMailboxCache({ keepLastGood: true }); // the minute is up
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    prismaMock.notificationDelivery.update.mockClear();
    const res = await processDelivery(delivery());
    expect(res).toMatchObject({ success: true, skipped: 'own_mailbox' });
    expect(deliverMock).toHaveBeenCalledTimes(1); // only the first one
    expect(updateData()).toMatchObject({ status: 'skipped', payload: { skippedReason: 'own_mailbox' } });
  });

  test('no list has ever loaded: nothing is sent, the delivery fails (retryable) and says why', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    const res = await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT] }));
    expect(res.success).toBe(false);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(updateData()).toMatchObject({ status: 'failed', payload: expect.objectContaining({ lastErrorClass: 'own_mailbox_unverified', lastErrorRetryable: true }) });
    expect(updateData().error).toMatch(/own-mailbox list could not be read/);
  });

  test('the workflow editor’s test send gets the same strip', async () => {
    const res = await processDelivery(delivery({ workflowRunId: null, notificationType: 'notification_workflow_test_email', recipient: AR, toRecipients: [AR] }));
    expect(res).toMatchObject({ success: true, skipped: 'own_mailbox' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  test('not a workflow e-mail (an assignment ping): the guard does not apply and the mail is not marked automatic', async () => {
    await processDelivery(delivery({ workflowRunId: null, notificationType: 'assignment', recipient: 'alex.rivera@ourco.example', toRecipients: ['alex.rivera@ourco.example'] }));
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][0].automated).toBeUndefined();
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
  });

  test('ownMailboxSplit (what Shadow records): who Live would take off', async () => {
    const split = await ownMailboxSplit([AR, CLIENT], [ACC], []);
    expect(split.to).toEqual([CLIENT]);
    expect(split.removed).toEqual([{ address: AR, field: 'to' }, { address: ACC, field: 'cc' }]);
  });
});

// ---------------------------------------------------------------------------
describe('2. intake: provably ours is skipped; unproven mail from a team mailbox goes on', () => {
  const own = [AP, ACC, AR, IT, GLOBAL];

  test('the pure rules: our header, a tp- Message-ID on our domain only, Auto-Submitted only from our mailbox', () => {
    expect(ownMark({ ticketPulseMail: 'workflow' }, own)).toBe('header');
    expect(ownMark({ internetMessageId: OUR_TP_ID }, own)).toBe('message_id');
    expect(ownMark({ internetMessageId: '<tp-3101-mfa1b2c3.0a1b2c3d4e5f6a7b8c@ourco.example>' }, own)).toBe('message_id');
    expect(ownMark({ internetMessageId: `<tp-3101-mfa1b2c3.0a1b2c3d4e5f@${DEFAULT_MESSAGE_ID_DOMAIN}>` }, own)).toBe('message_id');
    expect(ownMark({ internetMessageId: '<tp-1764021720000-k3j9x0abcdq1w2@vendor.example>' }, own)).toBeNull();
    expect(ownMark({ internetMessageId: '<CAJx7=tp-1@mail.example.com>' }, own)).toBeNull();
    expect(ownMailProof({ from: AR, autoSubmitted: 'auto-generated' }, own)).toBe('auto_submitted');
    expect(ownMailProof({ from: CLIENT, autoSubmitted: 'auto-generated' }, own)).toBeNull();
    // Send As from a team mailbox, no mark: not proven ours.
    expect(ownMailProof({ from: AR, sender: AR }, own)).toBeNull();
    expect(ownMailProof({ from: GLOBAL }, own)).toBeNull();
  });

  test('an acknowledgement from AR carrying our header: skipped (self_send), recorded, no ticket', async () => {
    expect(await ingest.processEmail(apBox, fromAr({ subject: 'Ticket received [TP-3101]', ticketPulseMail: 'workflow' }))).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('from AR with Auto-Submitted: auto-generated (the SendGrid lane): skipped', async () => {
    expect(await ingest.processEmail(apBox, fromAr({ autoSubmitted: 'auto-generated' }))).toBe('skipped');
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('a Graph createReply ack with no headers, whose Message-ID a delivery recorded: skipped, even though it threads', async () => {
    sentDeliveryIds.add(EXCHANGE_ID);
    threadRefs.set('<earlier@client.example>', OPEN_TICKET.id);
    const ack = fromAr({ subject: 'RE: Invoice question [TP-3101]', internetMessageId: EXCHANGE_ID, inReplyTo: '<earlier@client.example>', references: '<earlier@client.example>' });
    expect(await ingest.processEmail(apBox, ack)).toBe('skipped');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['self_send']);
    // The lookup is scoped to the workspaces that have a mailbox.
    expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: { in: [2, 1] } }),
    }));
  });

  test('...or whose Message-ID one of our reply entries recorded: skipped', async () => {
    sentEntryIds.add(EXCHANGE_ID);
    expect(await ingest.processEmail(apBox, fromAr({ internetMessageId: EXCHANGE_ID }))).toBe('skipped');
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('a tp- Message-ID on our own domain (any sender) is ours; on a vendor’s domain it is not', async () => {
    expect(await ingest.processEmail(apBox, mail({ from: 'relay@mailer.example', internetMessageId: OUR_TP_ID }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail({ internetMessageId: '<tp-1764021720000-k3j9x0abcdq1w2@vendor.example>' }))).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT });
    expect(skippedWith()).toEqual(['self_send']);
  });

  test('a Send As reply from the AR mailbox that threads onto an existing ticket: ingested as a reply', async () => {
    threadRefs.set('<earlier@client.example>', OPEN_TICKET.id);
    const reply = fromAr({ subject: 'RE: Invoice question [TP-3101]', bodyText: 'We have applied the payment.', inReplyTo: '<earlier@client.example>', references: '<earlier@client.example>' });
    expect(await ingest.processEmail(apBox, reply)).toBe('reply');
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data).toMatchObject({ ticketId: OPEN_TICKET.id });
  });

  test('an approval answer from a team mailbox with the +ap key: processed', async () => {
    approvalMock.plusAddressApprovalKey.mockImplementation(() => 'k7Q2');
    const answer = fromAr({ to: ['ap+apk7Q2@ourco.example'], subject: 'RE: Approval needed [TP-3101]', bodyText: 'Approved.' });
    expect(await ingest.processEmail(apBox, answer)).toBe('approval_reply');
    expect(approvalMock.answer).toHaveBeenCalledWith(expect.objectContaining({ plusKey: 'k7Q2', senderEmail: AR }));
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });

  test('a requester replying to our ack (In-Reply-To our tp- id): a reply as before', async () => {
    threadRefs.set(OUR_TP_ID, OPEN_TICKET.id);
    sentDeliveryIds.add(OUR_TP_ID);
    const reply = mail({ subject: 'RE: Ticket received [TP-3101]', bodyText: 'Thanks, one more detail.', inReplyTo: OUR_TP_ID, references: OUR_TP_ID });
    expect(await ingest.processEmail(apBox, reply)).toBe('reply');
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data).toMatchObject({ ticketId: OPEN_TICKET.id });
  });

  test('a database error in the sent-by-us lookup means "not proven ours": the hand-off is held, not skipped', async () => {
    prismaMock.notificationDelivery.findFirst.mockRejectedValue(new Error('db down'));
    expect(await ingest.processEmail(apBox, fromAr({ subject: 'Vendor statement' }))).toBe('held');
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });

  test('a normal person: a ticket as before, filed for them', async () => {
    expect(await ingest.processEmail(apBox, mail())).toBe('created');
    expect(created()[0]).toMatchObject({ ws: 2, requesterEmail: CLIENT });
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });

  test('a person CCing team mailboxes on a real conversation: a ticket as before', async () => {
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

  test('a disabled connection’s address is not ours: its mail is a ticket like anyone’s', async () => {
    expect(await ingest.processEmail(apBox, mail({ from: OLD, sender: OLD }))).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: OLD });
  });

  test('the own-mailbox list cannot be read: today’s check still applies, our header still counts, a person’s mail is still a ticket', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    expect(await ingest.processEmail(apBox, mail({ from: AP }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail({ from: 'relay@mailer.example', ticketPulseMail: 'workflow' }))).toBe('skipped');
    expect(await ingest.processEmail(apBox, mail())).toBe('created');
  });
});

// ---------------------------------------------------------------------------
describe('3. intake: a new ticket is never filed for one of our own mailboxes; a person decides', () => {
  test('intendedRequester: the same picks as ticket creation', () => {
    expect(intendedRequester({ from: 'A@x.example' }, { kind: 'fresh' })).toBe('a@x.example');
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'forward', original: { email: AR } })).toBe(AR);
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'agent_cc', requester: { email: CLIENT } })).toBe(CLIENT);
    expect(intendedRequester({ from: 'a@x.example' }, { kind: 'fresh', forcedRequester: CLIENT })).toBe(CLIENT);
  });

  test('an unmarked hand-off from the AR mailbox to AP: held (own_mailbox_requester), not skipped, no ticket', async () => {
    expect(await ingest.processEmail(apBox, fromAr({ subject: 'Remittance for the Northwind invoice' }))).toBe('held');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
    expect(heldWith()).toEqual([expect.objectContaining({
      reason: 'own_mailbox_requester',
      decision: expect.objectContaining({ rule: 'own_mailbox_requester', details: expect.objectContaining({ requester: AR, insteadOf: 'fresh' }) }),
    })]);
  });

  test('also on a standard mailbox (policy create): AP into AR is held; AR’s own mail into AR is skipped as today', async () => {
    expect(await ingest.processEmail(plainBox, mail({ from: AP, sender: AP, to: [AR], subject: 'Hand-off' }))).toBe('held');
    expect(heldWith()[0]).toMatchObject({ reason: 'own_mailbox_requester' });
    expect(await ingest.processEmail(plainBox, mail({ from: AR, sender: AR, to: [AR], subject: 'Note to self' }))).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('an agent forwarding the AR mailbox’s mail into AP: held, no ticket', async () => {
    const fwd = mail({
      from: AGENT.email, fromName: AGENT.name, to: [AP], subject: 'FW: Remittance advice',
      bodyText: `For AP.\n\nFrom: Accounts Receivable <${AR}>\nSent: Monday, November 23, 2026 9:14 AM\nTo: Jo Park <${CLIENT}>\nSubject: Remittance advice\n\nPlease find it attached.`,
    });
    expect(await ingest.processEmail(apBox, fwd)).toBe('held');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(heldWith()[0]).toMatchObject({ reason: 'own_mailbox_requester' });
  });

  test('the hold queue unavailable: recorded as skipped instead, still no ticket', async () => {
    holdMock.holdMessage.mockRejectedValue(new Error('hold table missing'));
    expect(await ingest.processEmail(apBox, fromAr({ subject: 'Vendor statement' }))).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['own_mailbox_requester']);
  });
});

// ---------------------------------------------------------------------------
describe('4. follow-ups: every create path refuses a ticket for one of our mailboxes', () => {
  const intake = { kind: 'fresh', agent: null, decision: { rule: 'external_reply_unknown', details: {} } };

  test('_holdOrFallback with the hold queue down (policy create): never created, recorded as skipped', async () => {
    holdMock.holdMessage.mockRejectedValue(new Error('hold table missing'));
    const outcome = await ingest._holdOrFallback(apBox, fromAr({ subject: 'RE: Statement' }), intake, 'unknown_reference', new Map());
    expect(outcome).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(skippedWith()).toEqual(['own_mailbox_requester']);
  });

  test('_holdOrFallback with the hold queue down: a person’s mail is still created as before', async () => {
    holdMock.holdMessage.mockRejectedValue(new Error('hold table missing'));
    expect(await ingest._holdOrFallback(apBox, mail({ subject: 'RE: Statement' }), intake, 'unknown_reference', new Map())).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT });
  });

  test('"Create ticket" on held mail (a person, or Live Mail triage from a possible_follow_up hold): refused for our mailbox, fine once someone is chosen', async () => {
    const email = fromAr({ subject: 'Remittance' });
    const held = { kind: 'fresh', createdVia: 'held_reply', heldMessageId: 77, resolvedBy: 'Mail triage' };
    await expect(ingest.createTicketFromEmail(apBox, email, held)).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'own_mailbox_requester', requester: AR },
    });
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    // Mail triage passes a requester only when it is not one of our mailboxes; with none it is the sender (AR): refused.
    await expect(ingest.createTicketFromEmail(apBox, email, { ...held, forcedRequester: AR })).rejects.toMatchObject({ statusCode: 400 });
    await ingest.createTicketFromEmail(apBox, email, { ...held, forcedRequester: CLIENT });
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT });
  });
});

describe('5. follow-ups: the createReply race, the failure cache, person reasons', () => {
  test('recentSentMessageIds: remembered ids (with or without brackets) for ten minutes', () => {
    const t0 = 1_800_000_000_000;
    rememberSentMessageId(EXCHANGE_ID, t0);
    expect(wasRecentlySent(EXCHANGE_ID, t0 + 1000)).toBe(true);
    expect(wasRecentlySent(EXCHANGE_ID.slice(1, -1).toUpperCase(), t0 + 1000)).toBe(true);
    expect(wasRecentlySent('<other@ourco.example>', t0 + 1000)).toBe(false);
    expect(wasRecentlySent(EXCHANGE_ID, t0 + RECENT_SENT_TTL_MS)).toBe(false);
    expect(wasRecentlySent('', t0)).toBe(false);
  });

  test('an ack whose Message-ID was remembered before the send, back before its delivery row exists: skipped', async () => {
    rememberSentMessageId(EXCHANGE_ID);
    expect(await ingest.processEmail(apBox, fromAr({ internetMessageId: EXCHANGE_ID }))).toBe('skipped');
    expect(skippedWith()).toEqual(['self_send']);
    // Without it (and no rows) the same mail is an unproven hand-off: held.
    clearRecentSentMessageIds();
    expect(await ingest.processEmail(apBox, fromAr({ internetMessageId: '<SN6PR01MB0000@x.prod.outlook.example>' }))).toBe('held');
  });

  test('a failed list read is remembered for ten seconds once a list has loaded: no query per message or delivery, then read again', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      prismaMock.mailboxConnection.findMany.mockImplementation(async () => BOXES.filter((b) => b.isEnabled));
      expect(await ownMailboxAddresses()).toContain(AR);
      invalidateOwnMailboxCache({ keepLastGood: true });
      prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
      await expect(ownMailboxAddresses()).rejects.toThrow('db down');
      expect(await ownMailboxAddresses({ staleOk: true })).toContain(AR);
      await processDelivery(delivery({ recipient: CLIENT, toRecipients: [CLIENT] }));
      await ingest.processEmail(apBox, mail());
      expect(prismaMock.mailboxConnection.findMany).toHaveBeenCalledTimes(2);
      now += OWN_FAILURE_TTL_MS;
      prismaMock.mailboxConnection.findMany.mockImplementation(async () => BOXES.filter((b) => b.isEnabled));
      expect(await ownMailboxAddresses()).toContain(AR);
      expect(prismaMock.mailboxConnection.findMany).toHaveBeenCalledTimes(3);
    } finally {
      Date.now = realNow;
    }
  });

  test('before any list has loaded, a failure is not remembered: the next call asks again', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(ownMailboxAddresses()).rejects.toThrow('db down');
    prismaMock.mailboxConnection.findMany.mockImplementation(async () => BOXES.filter((b) => b.isEnabled));
    expect(await ownMailboxAddresses()).toContain(AR);
    expect(prismaMock.mailboxConnection.findMany).toHaveBeenCalledTimes(2);
  });

  test('own_mailbox_requester holds are a person’s mail in the held-mail groups', () => {
    expect(PERSON_REASONS).toContain('own_mailbox_requester');
    expect(senderKindFor({ sender: AR, reasons: ['own_mailbox_requester'] })).toBe('person');
  });
});
