import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — inbound mail.
//  Off: a reply onto imported history adopts the ticket first and is then a
//  normal Ticket Pulse reply; nothing is written to FreshService; a mail is
//  never skipped as "FreshService receives it itself". Adopted tickets own
//  their mail even while connected.

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticketThreadEntryOriginal: { create: jest.fn() },
  approvalMessage: { findFirst: jest.fn() },
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
// A workspace's own FreshService prefixes (6 Nov 2026): workspace 2 numbers tickets [CASE-n].
const prefixMock = { fsTicketPrefixes: jest.fn(async (workspaceId) => (Number(workspaceId) === 2 ? ['CASE'] : [])) };
jest.unstable_mockModule('../src/services/fsTicketPrefixService.js', () => ({ fsTicketPrefixes: prefixMock.fsTicketPrefixes, default: prefixMock }));
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

// FreshService switch: controllable mode + adoption.
const fsMode = { mode: 'connected' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));
const adoptionMock = { adoptTicket: jest.fn() };
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ default: adoptionMock }));

const { default: mailboxIngestService } = await import('../src/services/mailboxIngestService.js');

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
  fsMode.mode = 'connected';
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticketThreadEntryOriginal.create.mockResolvedValue({});
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


const FS_TICKET = { id: 44036, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 241459n, requesterFreshserviceId: 1001249103n, ccEmails: [], status: 'Closed', mirrorState: null };
const ADOPTED = { ...FS_TICKET, origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' };

describe('a reply onto imported history in an Off workspace', () => {
  test('adopts the ticket (requester_reply), stores the reply as a TP reply, writes nothing to FreshService', async () => {
    fsMode.mode = 'off';
    adoptionMock.adoptTicket.mockResolvedValueOnce({ ...ADOPTED, displayRef: 'TP-2001', adopted: true });
    const fsClient = { addNote: jest.fn() };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);

    await mailboxIngestService.ingestReply(connection, { ...FS_TICKET }, { ...baseEmail, internetMessageId: '<off-1@example.com>' }, 'fs_ref_subject');

    expect(adoptionMock.adoptTicket).toHaveBeenCalledWith(44036, 1, { actorEmail: null, reason: 'requester_reply' });
    const created = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(created.ticketId).toBe(44036);
    expect(created.mirrorState).toBe('none');
    expect(fsClient.addNote).not.toHaveBeenCalled();
    expect(mirrorServiceMock.getInteractiveClient).not.toHaveBeenCalled();
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test('a failed adoption never loses the reply, and still writes nothing to FreshService', async () => {
    fsMode.mode = 'off';
    adoptionMock.adoptTicket.mockRejectedValueOnce(new Error('db hiccup'));
    const fsClient = { addNote: jest.fn() };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);

    await mailboxIngestService.ingestReply(connection, { ...FS_TICKET }, { ...baseEmail, internetMessageId: '<off-2@example.com>' }, 'fs_ref_subject');

    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalled();
    expect(fsClient.addNote).not.toHaveBeenCalled();
  });

  test('Connected: unchanged — no adoption, the reply is written back to FreshService', async () => {
    const fsClient = { addNote: jest.fn(async () => ({ conversation: { id: 1 } })) };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);
    prismaMock.ticketThreadEntry.update = jest.fn(async () => ({}));
    await mailboxIngestService.ingestReply(connection, { ...FS_TICKET, status: 'Open' }, { ...baseEmail, internetMessageId: '<on-1@example.com>' }, 'fs_ref_subject');
    expect(adoptionMock.adoptTicket).not.toHaveBeenCalled();
    expect(fsClient.addNote).toHaveBeenCalled();
  });
});

describe('an adopted ticket never reaches its old FreshService ticket', () => {
  test('a reply is stored with no FreshService side, and nothing is queued for the mirror', async () => {
    const fsClient = { addNote: jest.fn() };
    mirrorServiceMock.getInteractiveClient = jest.fn(async () => fsClient);
    await mailboxIngestService.ingestReply(connection, { ...ADOPTED, status: 'Open' }, { ...baseEmail, internetMessageId: '<ad-1@example.com>' }, 'plus_address_fs');
    expect(adoptionMock.adoptTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.mirrorState).toBe('none');
    expect(fsClient.addNote).not.toHaveBeenCalled();
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });
});

describe('"FreshService receives this mail itself" never drops mail it will not sync', () => {
  const fsRefMail = { ...baseEmail, subject: 'Re: Printer [#241459]', to: ['helpdesk-pilot@example.com', 'it@example.com'], internetMessageId: '<both-1@example.com>' };

  test('Connected FS-born: skipped as before (FreshService ingests it)', async () => {
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where?.freshserviceTicketId === 241459n ? { ...FS_TICKET, status: 'Open' } : null));
    expect(await mailboxIngestService.processEmail(connection, fsRefMail)).toBe('skipped');
  });

  test('Off: Ticket Pulse takes it', async () => {
    fsMode.mode = 'off';
    adoptionMock.adoptTicket.mockResolvedValueOnce({ ...ADOPTED, status: 'Open', displayRef: 'TP-2001', adopted: true });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where?.freshserviceTicketId === 241459n ? { ...FS_TICKET, status: 'Open' } : null));
    expect(await mailboxIngestService.processEmail(connection, fsRefMail)).toBe('reply');
  });

  test('adopted (connected): Ticket Pulse takes it', async () => {
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where?.freshserviceTicketId === 241459n ? { ...ADOPTED, status: 'Open' } : null));
    expect(await mailboxIngestService.processEmail(connection, { ...fsRefMail, internetMessageId: '<both-2@example.com>' })).toBe('reply');
  });
});
describe('inbound replies on Ticket Pulse tickets: no stuck "waiting to copy"', () => {
  const TP = { id: 46466, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1500, freshserviceTicketId: 246100n, mirrorState: 'mirrored', ccEmails: [], status: 'Open' };

  test("Off workspace → entry 'none', nothing queued for the mirror", async () => {
    fsMode.mode = 'off';
    await mailboxIngestService.ingestReply(connection, { ...TP }, { ...baseEmail, internetMessageId: '<tp-off@example.com>' }, 'tp_ref');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.mirrorState).toBe('none');
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test("Connected → 'pending' and queued, as before", async () => {
    await mailboxIngestService.ingestReply(connection, { ...TP }, { ...baseEmail, internetMessageId: '<tp-on@example.com>' }, 'tp_ref');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.mirrorState).toBe('pending');
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 46466, 9001);
  });
});
describe('a Cc added on a reply never un-adopts the ticket', () => {
  const ccMail = (id) => ({ ...baseEmail, cc: ['boss@example.com'], internetMessageId: `<${id}@example.com>` });
  const ticketWrite = () => prismaMock.ticket.update.mock.calls.map(([q]) => q.data).find((d) => d.ccEmails);
  const TP = { id: 46466, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1500, freshserviceTicketId: 246100n, ccEmails: [], status: 'Open' };

  test("adopted (connected): Cc merged, mirrorState left 'adopted'", async () => {
    await mailboxIngestService.ingestReply(connection, { ...TP, mirrorState: 'adopted' }, ccMail('cc-ad'), 'tp_ref');
    expect(ticketWrite().ccEmails).toEqual(['boss@example.com']);
    expect(ticketWrite()).not.toHaveProperty('mirrorState');
  });

  test("Off workspace: Cc merged, no 'pending' flip", async () => {
    fsMode.mode = 'off';
    await mailboxIngestService.ingestReply(connection, { ...TP, mirrorState: 'mirrored' }, ccMail('cc-off'), 'tp_ref');
    expect(ticketWrite()).not.toHaveProperty('mirrorState');
  });

  test("Connected TP-born: 'pending' as before ('none' stays 'none')", async () => {
    await mailboxIngestService.ingestReply(connection, { ...TP, mirrorState: 'mirrored' }, ccMail('cc-on'), 'tp_ref');
    expect(ticketWrite().mirrorState).toBe('pending');
    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
    prismaMock.ticket.update.mockResolvedValue({});
    await mailboxIngestService.ingestReply(connection, { ...TP, mirrorState: 'none' }, ccMail('cc-none'), 'tp_ref');
    expect(ticketWrite().mirrorState).toBe('none');
  });
});