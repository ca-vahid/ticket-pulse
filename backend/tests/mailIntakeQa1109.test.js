/**
 * QA 11-09 mail intake:
 *  A (#3) a reply to a workflow mail sent through SendGrid threads onto its
 *         ticket (rung 1c, via 'workflow_mail_ref') and never reopens it;
 *  B      burst hold only for look-alike mail;
 *  C (#8) meeting invites are not tickets; a forwarded invite with a question
 *         is, without the attendees; carried Cc is capped.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  approvalMessage: { findFirst: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const holdMock = { holdMessage: jest.fn(), isKnownMessageId: jest.fn(), recordSkipped: jest.fn() };
const requesterRepoMock = { findByEmail: jest.fn(), createNative: jest.fn() };
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
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepoMock }));
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
  default: ingest, burstSubjectKey, senderBurstKeys, referenceLocalParts,
  MAX_SAME_SUBJECT_CREATES_PER_CYCLE, MAX_CREATES_PER_SENDER_PER_CYCLE, MAX_CARRIED_CC,
} = await import('../src/services/mailboxIngestService.js');
const { meetingMailSignal, judgeMeetingMail, forwarderWords } = await import('../src/utils/meetingInvite.js');
const { default: logger } = await import('../src/utils/logger.js');

const side = { id: 5, workspaceId: 5, address: 'projects@example.com' };
const front = { id: 9, workspaceId: 1, address: 'helpdesk@example.com', intakeProfile: 'helpdesk' };
let seq = 0;
const mail = (over = {}) => {
  seq += 1;
  return {
    id: `msg-${seq}`,
    subject: 'Printer jammed',
    from: 'rita@example.com',
    fromName: 'Rita Requester',
    to: ['helpdesk@example.com'],
    cc: [],
    receivedAt: new Date(),
    bodyHtml: null,
    bodyText: 'It is jammed again',
    bodyPreview: 'It is jammed again',
    internetMessageId: `<m-${seq}@example.com>`,
    inReplyTo: null,
    references: null,
    ...over,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
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
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  ticketServiceMock.createTicket.mockImplementation(async () => ({ id: 700 + seq, displayRef: `TP-${2000 + seq}`, workspaceId: 1 }));
});

// ---------------------------------------------------------------------------
describe('A: a reply to a workflow mail sent through SendGrid', () => {
  const SG_ID = 'AbCdEfGhIjKlMnOpQrStUv';
  const ref = `<${SG_ID}@geopod-ismtpd-25>`;
  const closedTicket = { id: 4401, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 3301, status: 'Closed', subject: 'Project 1234567 - TEM survey request', requesterId: null, ccEmails: [] };
  const deliveryFor = (ticketId) => ({ where }) => {
    // 1b (exact ids, OR shape) finds nothing; 1c (local part on provider_message_id) finds the send.
    if (where?.OR) return Promise.resolve(null);
    if (where?.providerMessageId?.in?.includes(SG_ID) && where.workspaceId === 5) return Promise.resolve({ ticketId });
    return Promise.resolve(null);
  };
  const pmReply = (over = {}) => mail({
    subject: 'Re: Project 1234567 - TEM survey request processed',
    from: 'pm.person@example.com',
    fromName: 'Pat Manager',
    to: ['projects@example.com'],
    bodyText: 'Thanks, can you also add the second site?',
    inReplyTo: ref,
    references: ref,
    ...over,
  });

  test('referenceLocalParts keeps the part before @ and ignores short ones', () => {
    expect(referenceLocalParts([ref, '<abc@x.example.com>', '<tp-1-abcdef@example.com>'])).toEqual([SG_ID, 'tp-1-abcdef']);
    expect(referenceLocalParts([])).toEqual([]);
  });

  test('rung 1c: the ref local part = the delivery provider_message_id in the same workspace → workflow_mail_ref', async () => {
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket });
    const match = await ingest.matchEmailToTicket(5, pmReply(), side.address);
    expect(match).toMatchObject({ via: 'workflow_mail_ref', ticket: { id: 4401 } });
    const call = prismaMock.notificationDelivery.findFirst.mock.calls.find(([q]) => !q.where.OR);
    expect(call[0].where).toEqual({ workspaceId: 5, providerMessageId: { in: [SG_ID] } });
  });

  test('a ticket from another workspace is never matched', async () => {
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket, workspaceId: 2 });
    expect(await ingest.matchEmailToTicket(5, pmReply(), side.address)).toBeNull();
  });

  test('a failing delivery lookup falls through quietly', async () => {
    prismaMock.notificationDelivery.findFirst.mockImplementation(({ where }) => (where?.OR ? Promise.resolve(null) : Promise.reject(new Error('db gone'))));
    expect(await ingest.matchEmailToTicket(5, pmReply(), side.address)).toBeNull();
  });

  test('on a closed ticket: recorded as an incoming reply, mirrored, and the ticket is not reopened', async () => {
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket });
    const outcome = await ingest.processEmail(side, pmReply());
    expect(outcome).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ticketId: 4401, eventType: 'reply', incoming: true, authorType: 'requester', actorEmail: 'pm.person@example.com', mirrorState: 'pending' }),
    }));
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(5, 4401, 9001);
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    // Status is never touched: the only ticket update is the activity stamp.
    for (const [arg] of prismaMock.ticket.update.mock.calls) expect(arg.data.status).toBeUndefined();
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'requester_reply', details: expect.objectContaining({ via: 'workflow_mail_ref', keptClosed: true }),
    }));
  });

  test('on a resolved FS-born ticket the write-back is a marked note, not an incoming requester reply', async () => {
    const fsTicket = { ...closedTicket, origin: 'freshservice', status: 'Resolved', freshserviceTicketId: BigInt(555123), requesterFreshserviceId: BigInt(42) };
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue(fsTicket);
    const addNote = jest.fn(async () => ({ conversation: { id: 9 } }));
    mirrorServiceMock.getInteractiveClient.mockResolvedValueOnce({ addNote });
    expect(await ingest.processEmail(side, pmReply())).toBe('reply');
    expect(addNote).toHaveBeenCalledWith(555123, expect.stringContaining('[Ticket Pulse]'), expect.objectContaining({ incoming: false }));
    expect(addNote.mock.calls[0][2].userId).toBeUndefined();
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
  });

  test('on an open ticket the reply is a normal requester reply (reply_received fires)', async () => {
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket, status: 'Open' });
    expect(await ingest.processEmail(side, pmReply())).toBe('reply');
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith('ticket.reply_received', 4401, expect.objectContaining({ extra: expect.objectContaining({ via: 'workflow_mail_ref' }) }));
  });

  test('a workspace agent answering a workflow mail: incoming entry by the agent, no "replied to requester", no reopen', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 61, name: 'Alex Agent', email: 'alex.agent@example.com' });
    prismaMock.notificationDelivery.findFirst.mockImplementation(deliveryFor(4401));
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket });
    expect(await ingest.processEmail(side, pmReply({ from: 'alex.agent@example.com', fromName: 'Alex Agent' }))).toBe('reply');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ authorType: 'agent', incoming: true }),
    }));
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload?.deliveryState).toBeUndefined();
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled(); // no first-response stamp
  });

  test('a thread-entry match still wins over the delivery lookup', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce({ ticketId: 4402 });
    prismaMock.ticket.findUnique.mockResolvedValue({ ...closedTicket, id: 4402 });
    const match = await ingest.matchEmailToTicket(5, pmReply(), side.address);
    expect(match.via).toBe('threading_headers');
    expect(prismaMock.notificationDelivery.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('B: burst hold only for look-alike mail', () => {
  test('burstSubjectKey: lowercase, Re/Fw/Fwd gone, digits and whitespace collapsed', () => {
    expect(burstSubjectKey('RE: Fwd:  BGC-EDM-HV2 - Error: Volume transfer has failed for BGC-EDM-FILE1'))
      .toBe('bgc-edm-hv# - error: volume transfer has failed for bgc-edm-file#');
    expect(burstSubjectKey('Corporate Traveller Invoice: CAFS-I1234 | Jamie Example'))
      .not.toBe(burstSubjectKey('Corporate Traveller Invoice: CAFS-I5678 | Robin Sample'));
    expect(burstSubjectKey('Invoice 1234')).toBe(burstSubjectKey('invoice   98765'));
  });

  test('nine invoices for different travellers from one sender all become tickets', async () => {
    const senderCreates = new Map();
    const names = ['Jamie Example', 'Robin Sample', 'Casey Demo', 'Morgan Test', 'Riley Mock', 'Avery Fake', 'Quinn Placeholder', 'Drew Dummy', 'Sky Invented'];
    const outcomes = [];
    for (const [i, name] of names.entries()) {
      outcomes.push(await ingest.processEmail(front, mail({ from: 'invoices@travel.example.com', subject: `Corporate Traveller Invoice: CAFS-I${4100 + i} | ${name}` }), senderCreates));
    }
    expect(outcomes).toEqual(Array(9).fill('created'));
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
  });

  test('a repeating alert is held from the 4th', async () => {
    const senderCreates = new Map();
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await ingest.processEmail(front, mail({ from: 'nas@devices.example.com', subject: 'BGC-EDM-HV2 - Error: Volume transfer has failed for BGC-EDM-FILE1' }), senderCreates));
    }
    expect(outcomes).toEqual(['created', 'created', 'created', 'held', 'held']);
    expect(MAX_SAME_SUBJECT_CREATES_PER_CYCLE).toBe(3);
    expect(holdMock.holdMessage).toHaveBeenCalledWith(front, expect.anything(), expect.objectContaining({
      reason: 'sender_burst',
      decision: expect.objectContaining({ rule: 'sender_burst', details: expect.objectContaining({ kind: 'same_subject', cap: 3, sender: 'nas@devices.example.com' }) }),
    }));
  });

  test('anything else from one sender is held above the per-sender cap of 25', async () => {
    const sender = 'busy@example.com';
    const senderCreates = new Map([[sender, MAX_CREATES_PER_SENDER_PER_CYCLE]]);
    expect(MAX_CREATES_PER_SENDER_PER_CYCLE).toBe(25);
    expect(await ingest.processEmail(front, mail({ from: sender, subject: 'A brand new question' }), senderCreates)).toBe('held');
    expect(holdMock.holdMessage.mock.calls[0][2].decision.details).toMatchObject({ kind: 'sender_total', cap: 25 });
  });

  test('counters: one create counts against both keys', async () => {
    const senderCreates = new Map();
    const email = mail({ subject: 'Fwd: Laptop 12 is slow' });
    expect(await ingest.processEmail(front, email, senderCreates)).toBe('created');
    const { senderKey, subjectKey } = senderBurstKeys(email);
    expect(senderCreates.get(senderKey)).toBe(1);
    expect(senderCreates.get(subjectKey)).toBe(1);
  });

  test('a side mailbox still skips look-alike mail over the cap (loop guard)', async () => {
    const email = mail({ to: ['projects@example.com'] });
    const senderCreates = new Map([[senderBurstKeys(email).subjectKey, 3]]);
    expect(await ingest.processEmail(side, email, senderCreates)).toBe('skipped');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('C: meeting invites', () => {
  const attendees = Array.from({ length: 30 }, (_, i) => `person${i}@example.com`);
  const inviteBody = 'Microsoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting';
  const forwardedInvite = (note) => [
    note,
    '',
    '-----Original Appointment-----',
    'From: Olivia Organizer <olivia.organizer@example.com>',
    'Sent: Monday, November 9, 2026 9:00 AM',
    `To: ${attendees.slice(0, 5).join('; ')}`,
    'Cc: person20@example.com',
    'Subject: Safety town hall',
    'When: Tuesday, November 10, 2026 10:00 AM-11:00 AM (UTC-08:00) Pacific Time (US & Canada).',
    'Where: Microsoft Teams Meeting',
    '',
    inviteBody,
  ].join('\n');

  test('meetingMailSignal reads the Graph type, the meeting type, Content-Class and (with a calendar body) the subject', () => {
    expect(meetingMailSignal({ subject: 'Safety town hall', graphType: '#microsoft.graph.eventMessageRequest' })).toMatchObject({ kind: 'request', via: 'graph_type', forwarded: false });
    expect(meetingMailSignal({ subject: 'Accepted: Safety town hall', graphType: '#microsoft.graph.eventMessageResponse' })).toMatchObject({ kind: 'response' });
    expect(meetingMailSignal({ subject: 'X', meetingMessageType: 'meetingCancelled' })).toMatchObject({ kind: 'cancellation', via: 'meeting_message_type' });
    expect(meetingMailSignal({ subject: 'X', meetingMessageType: 'none' })).toBeNull();
    expect(meetingMailSignal({ subject: 'X', contentClass: 'urn:content-classes:calendarmessage' })).toMatchObject({ via: 'content_class' });
    expect(meetingMailSignal({ subject: 'Invitation: Planning @ Tue Nov 10, 2026', bodyText: 'Invitation from Google Calendar' })).toMatchObject({ via: 'subject', kind: 'request' });
    expect(meetingMailSignal({ subject: 'Fwd: Invitation: Planning', bodyText: 'Join with meet.google.com/abc-defg-hij' })).toMatchObject({ forwarded: true });
    // Subject alone is not enough: AP gets "Declined: card payment" and "Canceled: order" mail.
    expect(meetingMailSignal({ subject: 'Declined: card payment 4411', bodyText: 'Your card payment was declined.' })).toBeNull();
    expect(meetingMailSignal({ subject: 'Canceled: order 1234', bodyText: 'Your order was canceled.' })).toBeNull();
    // A reply in a thread is not an invite.
    expect(meetingMailSignal({ subject: 'RE: Accepted: Safety town hall', bodyText: 'Microsoft Teams meeting' })).toBeNull();
    expect(meetingMailSignal({ subject: 'Printer jammed', bodyText: 'It is jammed' })).toBeNull();
  });

  test('forwarderWords drops the divider and phone signatures', () => {
    expect(forwarderWords('Sent from my iPhone\n-----Original Appointment-----')).toBe('');
    expect(forwarderWords('Can IT book the AV for this?\n\n-----Original Appointment-----')).toBe('Can IT book the AV for this?');
  });

  test('judgeMeetingMail: plain invite → skip; forward without text → skip; forward with a question → create with attendees', () => {
    const graphType = '#microsoft.graph.eventMessageRequest';
    expect(judgeMeetingMail({ subject: 'Safety town hall', graphType, bodyText: inviteBody })).toMatchObject({ action: 'skip', reason: 'plain_invite' });
    expect(judgeMeetingMail({ subject: 'FW: Safety town hall', graphType, bodyText: forwardedInvite('') })).toMatchObject({ action: 'skip', reason: 'forward_without_text' });
    expect(judgeMeetingMail({ subject: 'FW: Safety town hall', graphType, bodyText: inviteBody })).toMatchObject({ action: 'skip', reason: 'forward_unsplit' });
    const ok = judgeMeetingMail({ subject: 'FW: Safety town hall', graphType, bodyText: forwardedInvite('Hi IT, the room screen will not share. Can someone check before 10?') });
    expect(ok).toMatchObject({ action: 'create', reason: 'forward_with_text' });
    expect(ok.attendees).toEqual(expect.arrayContaining(['person0@example.com', 'person4@example.com', 'person20@example.com']));
    expect(judgeMeetingMail({ subject: 'Printer jammed', bodyText: 'x' })).toBeNull();
  });

  test('a plain invite is not a ticket: recorded as skipped (meeting_invite) on any mailbox', async () => {
    for (const conn of [front, side]) {
      const email = mail({ subject: 'Safety town hall', graphType: '#microsoft.graph.eventMessageRequest', to: [conn.address, ...attendees], bodyText: inviteBody });
      expect(await ingest.processEmail(conn, email)).toBe('skipped');
      expect(holdMock.recordSkipped).toHaveBeenLastCalledWith(conn, expect.objectContaining({ subject: 'Safety town hall' }), 'meeting_invite');
    }
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    const { ingestSkipCounts } = await import('../src/services/mailboxIngestService.js');
    expect(ingestSkipCounts(1).byReason.meeting_invite).toBeGreaterThanOrEqual(1);
  });

  test('an Accepted / Declined response is not a ticket either, and never threads onto a ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 1, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1001, status: 'Open' });
    const email = mail({ subject: 'Accepted: Laptop handover TP-1001', graphType: '#microsoft.graph.eventMessageResponse', bodyText: '' });
    expect(await ingest.processEmail(front, email)).toBe('skipped');
    expect(holdMock.recordSkipped).toHaveBeenCalledWith(front, expect.anything(), 'meeting_invite');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('a forwarded invite with a question becomes a ticket, without the invite attendees in Cc or To', async () => {
    const email = mail({
      subject: 'FW: Safety town hall',
      graphType: '#microsoft.graph.eventMessageRequest',
      to: ['helpdesk@example.com', 'person1@example.com'],
      cc: ['manager@example.com', 'person2@example.com'],
      bodyText: forwardedInvite('Hi IT, the room screen will not share. Can someone check before 10?'),
    });
    expect(await ingest.processEmail(front, email)).toBe('created');
    expect(ticketServiceMock.createTicket).toHaveBeenCalledTimes(1);
    const recipientsUpdate = prismaMock.ticket.update.mock.calls.find(([q]) => q.data.ccEmails !== undefined);
    expect(recipientsUpdate[0].data.ccEmails).toEqual(['manager@example.com']);
    expect(recipientsUpdate[0].data.toEmails).toEqual(['helpdesk@example.com']);
  });

  test('a person filing a skipped plain invite gets no attendees on the ticket', async () => {
    const email = mail({ subject: 'Safety town hall', graphType: '#microsoft.graph.eventMessageRequest', to: ['projects@example.com', ...attendees.slice(0, 3)], cc: attendees.slice(3, 6), bodyText: inviteBody });
    await ingest.createTicketFromEmail(side, email, { kind: 'fresh', createdVia: 'held_reply', heldMessageId: 12 });
    const recipientsUpdate = prismaMock.ticket.update.mock.calls.find(([q]) => q.data.ccEmails !== undefined);
    expect(recipientsUpdate[0].data).toMatchObject({ toEmails: ['projects@example.com'], ccEmails: [] });
  });

  test('any new ticket carries at most MAX_CARRIED_CC Cc addresses, and the cut is logged', async () => {
    const email = mail({ to: ['projects@example.com'], cc: attendees });
    expect(await ingest.processEmail(side, email)).toBe('created');
    const recipientsUpdate = prismaMock.ticket.update.mock.calls.find(([q]) => q.data.ccEmails !== undefined);
    expect(MAX_CARRIED_CC).toBe(10); // the Cc editor's own limit
    expect(recipientsUpdate[0].data.ccEmails).toEqual(attendees.slice(0, 10));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('30 Cc addresses'));
  });

  test('an agent forwarding an invite with a question: ticket for the organiser, attendees left off the original-email entry', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 61, name: 'Alex Agent', email: 'alex.agent@example.com' });
    const email = mail({
      from: 'alex.agent@example.com', fromName: 'Alex Agent', subject: 'FW: Safety town hall', graphType: '#microsoft.graph.eventMessageRequest',
      to: ['helpdesk@example.com'], bodyText: forwardedInvite('Logging this for Olivia: the room screen will not share.'),
    });
    expect(await ingest.processEmail(front, email)).toBe('created');
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(1, expect.objectContaining({ requesterEmail: 'olivia.organizer@example.com' }), expect.anything(), expect.objectContaining({ createdVia: 'forward' }));
    const original = prismaMock.ticketThreadEntry.create.mock.calls.find(([q]) => q.data.eventType === 'original_email')[0].data;
    expect(original.rawPayload.to_emails).toBeUndefined();
    expect(original.rawPayload.cc_emails).toBeUndefined();
    expect(original.rawPayload.forwarded).toMatchObject({ meetingInvite: true, originalTo: [], originalCc: [], attendeesLeftOff: 6 });
  });

  test('a plain invite attached to a ticket by a person adds none of its attendees to the Cc', async () => {
    const ticket = { id: 4501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 3401, status: 'Open', ccEmails: [], requesterId: null };
    const email = mail({ subject: 'Safety town hall', graphType: '#microsoft.graph.eventMessageRequest', to: ['helpdesk@example.com', ...attendees.slice(0, 4)], bodyText: inviteBody });
    await ingest.ingestReply(front, ticket, email, 'held_attach');
    for (const [arg] of prismaMock.ticket.update.mock.calls) expect(arg.data.ccEmails).toBeUndefined();
  });

  test('ordinary mail is untouched by the invite rule', async () => {
    expect(await ingest.processEmail(front, mail({ cc: ['boss@example.com'] }))).toBe('created');
    expect(holdMock.recordSkipped).not.toHaveBeenCalled();
  });
});
