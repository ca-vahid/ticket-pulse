/**
 * Mail triage, part 1 (11 Nov 2026): the rule fixes, through the real ingest.
 *  1. "Also known as": a mailbox's public address counts as the mailbox in To
 *     and in Cc, and is never an external recipient, a requester or a Cc.
 *     The fourteen held shapes (an agent's own Outlook mail that copied the
 *     public address) take the agent-copy path instead of being held.
 *  2. Look-alike cap: a long number in a subject is an identity. Invoices that
 *     differ only by number are different mail; a repeating alert is still held
 *     from the 4th, and a storm that stamps every mail with its own id from the 11th.
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
  notificationDelivery: { findFirst: jest.fn() },
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
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: ingest, burstSubjectKey, burstShapeKey, senderBurstKeys, mergeInboundCc,
  MAX_SAME_SUBJECT_CREATES_PER_CYCLE, MAX_SAME_SHAPE_CREATES_PER_CYCLE, MAX_CREATES_PER_SENDER_PER_CYCLE,
} = await import('../src/services/mailboxIngestService.js');
const {
  recipientRoles, classifyIntake, isMailboxAddress, mailboxAddresses, prepareAgentContext,
} = await import('../src/services/agentIntakeService.js');
const { aliasSettingKey, invalidateAliasCache } = await import('../src/services/mailboxAliasService.js');
const { longNumbers, longNumbersDiffer, maskCounters } = await import('../src/utils/subjectIdentity.js');

// A team's ticket mailbox, and the public address that delivers into it.
const MAILBOX = 'ar-tickets@example.com';
const ALIAS = 'receivables@example.com';
const front = { id: 6, workspaceId: 2, address: MAILBOX, intakeProfile: 'helpdesk', newTicketPolicy: 'create', agentCcIntake: true };
const AGENT = { id: 41, name: 'Alex Rivera', email: 'alex.rivera@example.com' };
const COLLEAGUE = 'sam.ortiz@example.com';
const CLIENT = 'jo.park@client.example.org';
const VENDOR = 'payables@vendor.example.net';

let seq = 0;
const mail = (over = {}) => {
  seq += 1;
  return {
    id: `msg-${seq}`, subject: 'Hello', from: AGENT.email, fromName: AGENT.name, to: [COLLEAGUE], cc: [ALIAS],
    receivedAt: new Date(), bodyHtml: null, bodyText: 'Please see below.', bodyPreview: 'Please see below.',
    internetMessageId: `<m-${seq}@example.com>`, inReplyTo: null, references: null, ...over,
  };
};
const reply = (over = {}) => mail({ inReplyTo: `<earlier-${seq}@outlook.example.com>`, references: `<earlier-${seq}@outlook.example.com>`, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  invalidateAliasCache();
  settings.set(aliasSettingKey(front.id), ALIAS);
  ingest._heldMessageIds.clear();
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
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['example.com'] });
  // The sender is a technician of this workspace; nobody else on the mail is.
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (String(where?.email?.equals || '').toLowerCase() === AGENT.email ? AGENT : null));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  ticketServiceMock.createTicket.mockImplementation(async () => ({ id: 700 + seq, displayRef: `TP-${2000 + seq}`, workspaceId: 2 }));
});

const created = () => ticketServiceMock.createTicket.mock.calls.map(([ws, payload, , options]) => ({ ws, ...payload, ...options }));

// ---------------------------------------------------------------------------
describe('1. also known as: the alias is the mailbox', () => {
  const withAlias = { ...front, aliases: [ALIAS] };

  test('mailboxAddresses / isMailboxAddress: own address first, aliases after, +tag variants of either', () => {
    expect(mailboxAddresses(withAlias)).toEqual([MAILBOX, ALIAS]);
    expect(mailboxAddresses(front)).toEqual([MAILBOX]);
    expect(isMailboxAddress('Receivables@Example.com', mailboxAddresses(withAlias))).toBe(true);
    expect(isMailboxAddress('receivables+tp12@example.com', mailboxAddresses(withAlias))).toBe(true);
    expect(isMailboxAddress(ALIAS, MAILBOX)).toBe(false); // one address still works as before
    expect(isMailboxAddress(COLLEAGUE, mailboxAddresses(withAlias))).toBe(false);
    expect(isMailboxAddress(ALIAS, null)).toBe(false);
  });

  test('recognised in To and in Cc; never an external recipient', async () => {
    const inCc = await recipientRoles(withAlias, mail());
    expect(inCc).toMatchObject({ mailboxInTo: false, mailboxInCc: true, mailboxPresent: true, externals: [COLLEAGUE] });
    const inTo = await recipientRoles(withAlias, mail({ to: [ALIAS], cc: [] }));
    expect(inTo).toMatchObject({ mailboxInTo: true, mailboxInCc: false, mailboxSoleTo: true, externals: [] });
    // Without the alias the same mail reads as "mailbox was Bcc'd", and the alias is an external.
    const before = await recipientRoles(front, mail());
    expect(before).toMatchObject({ mailboxPresent: false, externals: [COLLEAGUE, ALIAS] });
  });

  test('never a requester: not offered, not picked from a quoted From, and an agent writing only to it is the requester themselves', async () => {
    const quotesAlias = mail({
      to: [ALIAS, CLIENT], cc: [],
      subject: 'RE: Statement',
      bodyText: `Thanks.\n\nFrom: Receivables <${ALIAS}>\nSent: Monday, November 9, 2026 9:14 AM\nTo: Jo Park <${CLIENT}>\nSubject: Statement\n\nPlease find it attached.`,
    });
    const ctx = await prepareAgentContext(withAlias, quotesAlias, AGENT);
    expect(ctx.originalOk).toBe(false);
    expect(ctx.recencySender).toBe(CLIENT);
    const intake = await classifyIntake(withAlias, quotesAlias, { agent: AGENT, ctx });
    expect(intake.kind).toBe('agent_cc');
    expect(intake.requester.email).toBe(CLIENT);
    expect(intake.externals).toEqual([CLIENT]);

    const onlyAlias = await classifyIntake(withAlias, mail({ to: [ALIAS], cc: [] }), { agent: AGENT });
    expect(onlyAlias).toMatchObject({ kind: 'fresh', decision: { rule: 'fresh_from_agent' } });
  });

  test('never a Cc: a reply that copies the alias adds the other people, not the alias', () => {
    const merged = mergeInboundCc(['pat@example.com'], { to: [MAILBOX], cc: [ALIAS, 'receivables+x@example.com', CLIENT] }, { mailboxAddress: [MAILBOX, ALIAS] });
    expect(merged.added).toEqual([CLIENT]);
    expect(merged.next).toEqual(['pat@example.com', CLIENT]);
    // One address (every caller before aliases) behaves as it did.
    expect(mergeInboundCc([], { to: [MAILBOX], cc: [ALIAS] }, { mailboxAddress: MAILBOX }).added).toEqual([ALIAS]);
  });

  test('the bug it fixes: without the alias the agent’s mail is held, with the alias offered as a requester', async () => {
    settings.clear();
    invalidateAliasCache();
    expect(await ingest.processEmail(front, mail({ subject: 'Payment from Fabrikam' }))).toBe('held');
    const [, , hold] = holdMock.holdMessage.mock.calls[0];
    expect(hold.reason).toBe('agent_reply_no_requester');
    expect(hold.decision.rule).toBe('agent_bcc_mailbox');
    expect(hold.candidates).toEqual([{ email: COLLEAGUE }, { email: ALIAS }]);
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('a failed alias lookup changes nothing: the mail is judged as before, never lost', async () => {
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await ingest.processEmail(front, mail({ to: [MAILBOX], cc: [], from: CLIENT, fromName: 'Jo Park', subject: 'A question' }))).toBe('created');
  });

  test('sent "as" the public address by a person: the person is the writer, the address is never the requester', async () => {
    const sentAs = mail({ from: ALIAS, fromName: 'Receivables', sender: 'Alex.Rivera@example.com', senderName: 'Alex Rivera', to: [CLIENT], cc: [ALIAS], subject: 'Statement for October' });
    expect(await ingest.processEmail(front, sentAs)).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: CLIENT, createdVia: 'agent_cc', assignedTechId: AGENT.id });
  });
});

// ---------------------------------------------------------------------------
describe('1. the fourteen held shapes, with the alias set', () => {
  // [what it is, the mail, who the ticket is filed for, who is copied on it]
  const SHAPES = [
    // New mail (no reply headers) to an internal colleague, alias in Cc.
    ['new reminder, invoice 4054060', mail({ subject: 'Reminder: 78 Days Outstanding Invoice - 4054060 - Northwind', cc: ['kim.lee@example.com', ALIAS] }), COLLEAGUE, ['kim.lee@example.com']],
    ['new reminder, invoice 4054103', mail({ subject: 'Reminder: 75 Days Outstanding Invoice - 4054103 - Northwind', to: [CLIENT], cc: [COLLEAGUE, ALIAS] }), CLIENT, [COLLEAGUE]],
    ['new reminder, invoice 4054122', mail({ subject: 'Reminder: 74 Days Outstanding Invoice - 4054122 - Northwind', cc: ['kim.lee@example.com', ALIAS] }), COLLEAGUE, ['kim.lee@example.com']],
    ['new reminder, no number', mail({ subject: 'Reminder: Outstanding Invoices - Contoso' }), COLLEAGUE, []],
    ['new note to another team’s shared address', mail({ subject: 'Payment from Fabrikam', to: ['people-team@example.com'] }), 'people-team@example.com', []],
    // Replies (reply headers, RE:) to a colleague or a client contact, alias in Cc.
    ['reply to a colleague 1', reply({ subject: 'RE: Reminder: 70 Days Outstanding Invoice - 4053829 - Tailspin', cc: ['kim.lee@example.com', ALIAS] }), COLLEAGUE, ['kim.lee@example.com']],
    ['reply to a client, others copied', reply({ subject: 'RE: 25-14995.00_Corrections to Inv for OH', to: [CLIENT], cc: [ALIAS, 'kim.lee@example.com', COLLEAGUE] }), CLIENT, ['kim.lee@example.com', COLLEAGUE]],
    ['reply to a client 2', reply({ subject: 'RE: Reminder: 175 Days Outstanding Invoice - 4051188 - Wingtip', to: [CLIENT], cc: [ALIAS, COLLEAGUE] }), CLIENT, [COLLEAGUE]],
    ['reply to a colleague 2', reply({ subject: 'RE: July 2026 - Blue Creek (PO 99529-OS-125)' }), COLLEAGUE, []],
    ['reply to a colleague 3', reply({ subject: 'RE: Reminder: 85 Days Outstanding Invoice - 4053377 - Adatum' }), COLLEAGUE, []],
    ['reply to a colleague 4', reply({ subject: 'RE: Reminder: 86 Days Outstanding Invoice - 4052690 - Litware', cc: ['kim.lee@example.com', ALIAS] }), COLLEAGUE, ['kim.lee@example.com']],
    ['reply to a colleague 5', reply({ subject: 'RE: Reminder: 78 Days Outstanding Invoice - 4053119 - Proseware', cc: [ALIAS, 'kim.lee@example.com'] }), COLLEAGUE, ['kim.lee@example.com']],
    // To an external vendor address, alias in Cc: one reply, one new.
    ['reply to a vendor (remittance)', reply({ subject: 'RE: Payment Remittance Advice 11/18/2026', to: [VENDOR] }), VENDOR, []],
    ['new mail to a vendor (remittance)', mail({ subject: 'Remittance Advice Email Update', to: [VENDOR] }), VENDOR, []],
  ];

  test('there are fourteen', () => expect(SHAPES).toHaveLength(14));

  test.each(SHAPES)('%s: not held; a ticket filed for the person it was sent to, the agent assigned, the alias nowhere on it', async (_name, email, requester, copied) => {
    expect(await ingest.processEmail(front, email, new Map())).toBe('created');
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    const [ticket] = created();
    expect(ticket).toMatchObject({
      ws: 2, requesterEmail: requester, createdVia: 'agent_cc', assignedTechId: AGENT.id, suppressRequesterAck: true,
    });
    expect(ticket.ccEmails || []).toEqual(copied);
    expect(JSON.stringify(ticket)).not.toContain(ALIAS);
    // The agent's words are the first public reply, already delivered by Outlook: never sent again.
    const entry = prismaMock.ticketThreadEntry.create.mock.calls.map(([arg]) => arg.data).find((d) => d.eventType === 'reply');
    expect(entry).toMatchObject({ authorType: 'agent', incoming: false, actorEmail: AGENT.email });
    expect(entry.rawPayload).toMatchObject({ deliveryState: 'external', agentIntake: { kind: 'agent_cc', requester } });
  });

  test('all fourteen in one cycle: none is caught by the look-alike cap', async () => {
    const senderCreates = new Map();
    const outcomes = [];
    for (const [, email] of SHAPES) outcomes.push(await ingest.processEmail(front, { ...email, internetMessageId: `<again-${outcomes.length}@example.com>` }, senderCreates));
    expect(outcomes).toEqual(Array(14).fill('created'));
  });

  test('a reply whose subject matches ONE open ticket the recipient is on threads onto it as the agent’s reply (no new ticket, no reopen event)', async () => {
    const open = { id: 880, workspaceId: 2, origin: 'freshservice', freshserviceTicketId: 249132n, subject: 'Reminder: 85 Days Outstanding Invoice - 4053377 - Adatum', status: 'Open', ccEmails: [], requesterId: 5 };
    prismaMock.ticket.findMany.mockResolvedValue([open]);
    const outcome = await ingest.processEmail(front, reply({ subject: 'RE: Reminder: 85 Days Outstanding Invoice - 4053377 - Adatum' }), new Map());
    expect(outcome).toBe('reply');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    const entry = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(entry).toMatchObject({ ticketId: 880, authorType: 'agent', incoming: false });
    expect(entry.rawPayload.agentIntake).toMatchObject({ kind: 'agent_reply_email', via: 'fs_subject_sender' });
  });

  test('known gap, pinned: a CLOSED ticket with the same subject is not found, so the reply becomes a new ticket', async () => {
    // Rung 5 reads Open and Pending tickets only; the closed one is never a candidate.
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where?.status?.in?.includes('Closed') ? [{ id: 1 }] : []));
    expect(await ingest.processEmail(front, reply({ subject: 'RE: Reminder: 85 Days Outstanding Invoice - 4053377 - Adatum' }), new Map())).toBe('created');
    expect(created()[0]).toMatchObject({ requesterEmail: COLLEAGUE, createdVia: 'agent_cc', subject: 'Reminder: 85 Days Outstanding Invoice - 4053377 - Adatum' });
  });
});

// ---------------------------------------------------------------------------
describe('2. look-alike cap: a long number is an identity', () => {
  const NOW = Date.parse('2026-11-11T18:00:00Z');

  test('long numbers stay in the key; short numbers, glued digits, dates and current stamps are masked', () => {
    expect(burstSubjectKey('Reminder: 70 Days Outstanding Invoice - 4053829 - Northwind'))
      .toBe('reminder: # days outstanding invoice - 4053829 - northwind');
    expect(burstSubjectKey('Reminder: 70 Days Outstanding Invoice - 4053829 - Northwind'))
      .not.toBe(burstSubjectKey('Reminder: 71 Days Outstanding Invoice - 4054122 - Northwind'));
    // The same invoice a day later is the same mail.
    expect(burstSubjectKey('Reminder: 70 Days Outstanding Invoice - 4053829 - Northwind'))
      .toBe(burstSubjectKey('RE: Reminder: 71 Days Outstanding Invoice - 4053829 - Northwind'));
    // A vendor's invoice file names: four long numbers each, all different.
    expect(burstSubjectKey('Invoice from Acme Rentals_XVC4250_16520151_US_CAD_186076352_1695121008_0_462009816071'))
      .not.toBe(burstSubjectKey('Invoice from Acme Rentals_XVC4250_16520151_US_CAD_186076358_1694411257_0_462009826982'));
    // Short and glued numbers: one key, as before.
    expect(burstSubjectKey('SRV-EDM-HV2 - Error: Volume transfer has failed for SRV-EDM-FILE1'))
      .toBe(burstSubjectKey('SRV-EDM-HV7 - Error: Volume transfer has failed for SRV-EDM-FILE3'));
    expect(burstSubjectKey('[NAS-01] Drive 12 on RS1221 is not listed')).toBe(burstSubjectKey('[NAS-01] Drive 9 on RS1221 is not listed'));
    expect(burstSubjectKey('Invoice 1234')).toBe(burstSubjectKey('invoice   98765'));
    expect(burstSubjectKey('Alert INC0012345 raised')).toBe(burstSubjectKey('Alert INC0099999 raised'));
    // Dates written without separators, and a current Unix time, are stamps.
    expect(burstSubjectKey('Backup failed 20261111', { now: NOW })).toBe(burstSubjectKey('Backup failed 20261112', { now: NOW }));
    expect(burstSubjectKey('Backup failed 20261111091455', { now: NOW })).toBe('backup failed #');
    expect(burstSubjectKey(`Probe down at ${Math.floor(NOW / 1000)}`, { now: NOW })).toBe('probe down at #');
    expect(burstSubjectKey(`Probe down at ${NOW - 5000}`, { now: NOW })).toBe('probe down at #');
    // An old ten-digit number is an identity (a vendor's document number), not a stamp.
    expect(burstSubjectKey('Document 1695121008', { now: NOW })).toBe('document 1695121008');
  });

  test('the helpers: longNumbers, maskCounters, longNumbersDiffer, burstShapeKey', () => {
    expect(longNumbers('Invoice - 4053829 - PO 99529 - 4053829 / 462009816071')).toEqual(['4053829', '462009816071']);
    expect(longNumbers('Drive 12 on RS1221 / FILE123456')).toEqual([]);
    expect(maskCounters('70 days, invoice 4053829')).toBe('# days, invoice 4053829');
    expect(longNumbersDiffer('Invoice 4053829', 'Invoice 4054122')).toBe(true);
    expect(longNumbersDiffer('Invoice 4053829', 'RE: Invoice 4053829 (2nd notice)')).toBe(false);
    expect(longNumbersDiffer('Invoice 4053829', 'Printer jammed')).toBe(false); // nothing to compare
    expect(burstShapeKey('Invoice 4053829')).toBe('invoice #');
    expect(senderBurstKeys({ from: 'A@x.io', subject: 'Printer 12 jammed' }).shapeKey).toBeNull();
    expect(senderBurstKeys({ from: 'A@x.io', subject: 'Invoice 4053829' }).shapeKey).toContain('invoice #');
  });

  test('five invoices that differ only by a long number: five tickets (two were held before)', async () => {
    const senderCreates = new Map();
    const outcomes = [];
    for (const n of ['186076352_1695121008_0_462009816071', '186076358_1694411257_0_462009826982', '186145539_1692847322_0_462009826568', '186145540_1692847399_0_462009826570', '186145541_1692847401_0_462009826571']) {
      outcomes.push(await ingest.processEmail(front, mail({ from: 'billing@rentals.example.net', fromName: 'Acme Rentals', to: [ALIAS], cc: [], subject: `Invoice from Acme Rentals_XVC4250_16520151_US_CAD_${n}` }), senderCreates));
    }
    expect(outcomes).toEqual(Array(5).fill('created'));
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
  });

  test('short numbers do not split: the same alert twenty times is still held from the 4th', async () => {
    const senderCreates = new Map();
    const outcomes = [];
    for (let i = 0; i < 20; i += 1) {
      outcomes.push(await ingest.processEmail(front, mail({ from: 'backup@devices.example.com', to: [MAILBOX], cc: [], subject: `SRV-EDM-HV2 - Error: Volume transfer has failed for SRV-EDM-FILE${(i % 3) + 1}` }), senderCreates));
    }
    expect(outcomes).toEqual([...Array(MAX_SAME_SUBJECT_CREATES_PER_CYCLE).fill('created'), ...Array(17).fill('held')]);
    expect(holdMock.holdMessage.mock.calls[0][2].decision.details).toMatchObject({ kind: 'same_subject', cap: 3 });
  });

  test('a storm that stamps every mail with its own long id is still held: from the 11th, not the 26th', async () => {
    const senderCreates = new Map();
    const outcomes = [];
    for (let i = 0; i < 30; i += 1) {
      outcomes.push(await ingest.processEmail(front, mail({ from: 'alerts@monitor.example.com', to: [MAILBOX], cc: [], subject: `Incident ${7000000 + i}: host unreachable` }), senderCreates));
    }
    expect(MAX_SAME_SHAPE_CREATES_PER_CYCLE).toBe(10);
    expect(outcomes).toEqual([...Array(10).fill('created'), ...Array(20).fill('held')]);
    expect(holdMock.holdMessage.mock.calls[0][2]).toMatchObject({ reason: 'sender_burst', decision: { rule: 'sender_burst', details: { kind: 'same_shape', cap: 10 } } });
    // The per-sender total is unchanged underneath.
    expect(MAX_CREATES_PER_SENDER_PER_CYCLE).toBe(25);
  });

  test('a held burst is not offered the sender’s newest ticket when that ticket is a different invoice', async () => {
    const from = 'billing@rentals.example.net';
    const email = mail({ from, to: [ALIAS], cc: [], subject: 'Invoice from Acme Rentals_186076352' });
    const senderCreates = new Map([[senderBurstKeys(email).subjectKey, MAX_SAME_SUBJECT_CREATES_PER_CYCLE]]);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 120165, subject: 'Invoice from Acme Rentals_186145539' });
    expect(await ingest.processEmail(front, email, senderCreates)).toBe('held');
    expect(holdMock.holdMessage.mock.calls[0][2].bestGuessTicketId).toBeNull();

    // The same invoice again IS a fair guess.
    holdMock.holdMessage.mockClear();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 120166, subject: 'RE: Invoice from Acme Rentals_186076352' });
    const again = mail({ from, to: [ALIAS], cc: [], subject: 'Invoice from Acme Rentals_186076352' });
    expect(await ingest.processEmail(front, again, new Map([[senderBurstKeys(again).subjectKey, MAX_SAME_SUBJECT_CREATES_PER_CYCLE]]))).toBe('held');
    expect(holdMock.holdMessage.mock.calls[0][2].bestGuessTicketId).toBe(120166);
  });
});
