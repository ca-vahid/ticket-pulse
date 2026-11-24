/**
 * Invoice-number matching for mail (24 Nov 2026), through the real ingest:
 *  - Shadow: intake decides exactly as before; the matcher runs after it.
 *  - Live: an FW/Fwd forward with a match is held as a possible follow-up of
 *    that ticket; a match joins the follow-up candidates as a hard link.
 *  - Intake never throws, whatever the matcher does.
 * The matcher itself is stood in for (tests/invoiceMatchService.test.js covers it).
 * Every name and address is invented.
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
const invoiceMock = {
  getMode: jest.fn(async () => 'off'),
  attachmentNamesFor: jest.fn(async () => []),
  findInvoiceMatches: jest.fn(async () => []),
  recordAfterIntake: jest.fn(async () => null),
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
jest.unstable_mockModule('../src/services/invoiceMatchService.js', () => ({ default: invoiceMock, ...invoiceMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ingest, isForwardMail } = await import('../src/services/mailboxIngestService.js');
const { invalidateAliasCache } = await import('../src/services/mailboxAliasService.js');

const MAILBOX = 'ap-tickets@example.com';
const front = { id: 6, workspaceId: 2, address: MAILBOX, intakeProfile: 'helpdesk', newTicketPolicy: 'create', agentCcIntake: true };
const AGENT = { id: 41, name: 'Alex Rivera', email: 'alex.rivera@example.com' };
const CLIENT = 'jo.park@client.example.org';
const MATCH = { ticketId: 880, displayRef: 'TP-2040', vendor: 'Acme Supplies', invoiceNumber: 'INV-20417', attachmentId: 300, matchedBy: 'vendor' };

let seq = 0;
const mail = (over = {}) => {
  seq += 1;
  return {
    id: `msg-${seq}`, subject: 'Hello', from: CLIENT, fromName: 'Jo Park', to: [MAILBOX], cc: [],
    receivedAt: new Date(), bodyHtml: null, bodyText: 'Please see below.', bodyPreview: 'Please see below.',
    internetMessageId: `<m-${seq}@example.com>`, inReplyTo: null, references: null, ...over,
  };
};
const heldWith = () => holdMock.holdMessage.mock.calls[0][2];
const live = () => invoiceMock.getMode.mockResolvedValue('live');

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  invalidateAliasCache();
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
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (String(where?.email?.equals || '').toLowerCase() === AGENT.email ? AGENT : null));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.holdMessage.mockResolvedValue({ id: 31 });
  holdMock.isKnownMessageId.mockResolvedValue(false);
  holdMock.recordSkipped.mockResolvedValue({ id: 77 });
  activityMock.create.mockResolvedValue({});
  mirrorServiceMock.enqueueThreadEntry.mockResolvedValue({});
  ticketServiceMock.createTicket.mockImplementation(async () => ({ id: 700 + seq, displayRef: `TP-${2000 + seq}`, workspaceId: 2 }));
  invoiceMock.getMode.mockResolvedValue('off');
  invoiceMock.attachmentNamesFor.mockResolvedValue([]);
  invoiceMock.findInvoiceMatches.mockResolvedValue([]);
  invoiceMock.recordAfterIntake.mockResolvedValue(null);
});

test('isForwardMail: an agent’s forward, or new mail whose subject starts FW:/Fwd:', () => {
  expect(isForwardMail({ subject: 'Anything' }, { kind: 'forward' })).toBe(true);
  expect(isForwardMail({ subject: 'FW: Invoice INV-20417' }, { kind: 'fresh' })).toBe(true);
  expect(isForwardMail({ subject: '[EXT] Fwd: Invoice INV-20417' }, { kind: 'agent_cc' })).toBe(true);
  expect(isForwardMail({ subject: 'RE: Invoice INV-20417' }, { kind: 'fresh' })).toBe(false);
  expect(isForwardMail({ subject: 'FW: Invoice INV-20417' }, { kind: 'external_reply_unknown' })).toBe(false);
});

describe('Shadow: intake decides as before; the matcher runs after it', () => {
  test('a new ticket is made exactly as with the feature off, then the after-intake record is asked for', async () => {
    invoiceMock.getMode.mockResolvedValue('shadow');
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]); // even a match changes nothing in Shadow
    const email = mail({ subject: 'FW: Invoice INV-20417 from Acme Supplies' });
    expect(await ingest.processEmail(front, email, new Map())).toBe('created');
    expect(ticketServiceMock.createTicket).toHaveBeenCalledTimes(1);
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    expect(invoiceMock.findInvoiceMatches).not.toHaveBeenCalled();
    await ingest._lastInvoiceMatchJob;
    expect(invoiceMock.recordAfterIntake).toHaveBeenCalledWith(expect.objectContaining({ id: 6, workspaceId: 2 }), email, 'created', { attachmentNames: null });
  });

  test('held mail is recorded too; a skipped mail is not', async () => {
    invoiceMock.getMode.mockResolvedValue('shadow');
    await ingest._invoiceMatchAfterIntake(front, mail(), 'held');
    expect(invoiceMock.recordAfterIntake).toHaveBeenCalledWith(front, expect.any(Object), 'held', { attachmentNames: null });
    invoiceMock.recordAfterIntake.mockClear();
    expect(ingest._invoiceMatchAfterIntake(front, mail(), 'skipped')).toBeNull();
    expect(invoiceMock.recordAfterIntake).not.toHaveBeenCalled();
  });
});

describe('Live (built, default off)', () => {
  test('an FW forward with a match is held as a possible follow-up of that ticket, the match first and the best guess', async () => {
    live();
    invoiceMock.attachmentNamesFor.mockResolvedValue(['INV-20417.pdf']);
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    const email = mail({ subject: 'FW: Documents from Acme Supplies', hasAttachments: true });
    expect(await ingest.processEmail(front, email, new Map())).toBe('held');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(heldWith()).toMatchObject({
      reason: 'possible_follow_up',
      bestGuessTicketId: 880,
      candidates: [{ ticketId: 880, why: 'same invoice number INV-20417 from Acme Supplies on an open ticket' }],
      decision: {
        rule: 'possible_follow_up',
        details: { matched: ['same_invoice'], bestGuessOpen: true },
        invoiceMatch: { mode: 'live', matches: [MATCH], attachmentNames: ['INV-20417.pdf'] },
      },
    });
    expect(invoiceMock.findInvoiceMatches).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 2, subject: email.subject, fromEmail: CLIENT, attachmentNames: ['INV-20417.pdf'] }));
    // The names read for the decision are handed to the after-intake record (no second read).
    await ingest._lastInvoiceMatchJob;
    expect(invoiceMock.recordAfterIntake).toHaveBeenCalledWith(expect.any(Object), email, 'held', { attachmentNames: ['INV-20417.pdf'] });
    expect(invoiceMock.attachmentNamesFor).toHaveBeenCalledTimes(1);
  });

  test('an agent’s forward with a match is held the same way', async () => {
    live();
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    const email = mail({ from: AGENT.email, fromName: AGENT.name, subject: 'FW: Invoice INV-20417 from Acme Supplies', bodyText: 'For you.\n\nFrom: Acme Supplies Billing <billing@acme-supplies.example>\nSent: Monday\nSubject: Invoice INV-20417 from Acme Supplies\n\nAttached.' });
    expect(await ingest.processEmail(front, email, new Map())).toBe('held');
    expect(heldWith()).toMatchObject({ reason: 'possible_follow_up', bestGuessTicketId: 880 });
    expect(heldWith().decision.details.matched).toContain('same_invoice');
  });

  test('a forward with no match is created as before; a non-forward new mail is never checked', async () => {
    live();
    expect(await ingest.processEmail(front, mail({ subject: 'FW: Invoice INV-30552 from Northwind Traders' }), new Map())).toBe('created');
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
    invoiceMock.findInvoiceMatches.mockClear();
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    expect(await ingest.processEmail(front, mail({ subject: 'Invoice INV-20417 from Acme Supplies' }), new Map())).toBe('created');
    expect(invoiceMock.findInvoiceMatches).not.toHaveBeenCalled();
  });

  test('a match joins the follow-up candidates of a reply this mailbox would make a ticket, ahead of a same-subject one', async () => {
    live();
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where?.status?.notIn
      ? [{ id: 890, workspaceId: 2, subject: 'Statement for October', status: 'Closed', createdAt: new Date(Date.now() - 9 * 86400000), category: null, internalCategory: null }]
      : []));
    const email = mail({ subject: 'RE: Statement for October', inReplyTo: '<earlier@outlook.example.com>', references: '<earlier@outlook.example.com>' });
    expect(await ingest.processEmail(front, email, new Map())).toBe('held');
    expect(heldWith().candidates.map((c) => c.ticketId)).toEqual([880, 890]);
    expect(heldWith()).toMatchObject({ bestGuessTicketId: 880, decision: { details: { matched: ['same_invoice', 'same_subject'] } } });
  });

  test('off (the default): the forward with a match is created as before and the matcher is never asked', async () => {
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    expect(await ingest.processEmail(front, mail({ subject: 'FW: Invoice INV-20417 from Acme Supplies' }), new Map())).toBe('created');
    expect(invoiceMock.findInvoiceMatches).not.toHaveBeenCalled();
    expect(holdMock.holdMessage).not.toHaveBeenCalled();
  });
});

describe('intake never throws', () => {
  test('the matcher failing at the decision or after it: the mail is created as before', async () => {
    live();
    invoiceMock.findInvoiceMatches.mockRejectedValue(new Error('db down'));
    invoiceMock.recordAfterIntake.mockRejectedValue(new Error('write failed'));
    expect(await ingest.processEmail(front, mail({ subject: 'FW: Invoice INV-20417 from Acme Supplies' }), new Map())).toBe('created');
    await expect(ingest._lastInvoiceMatchJob).resolves.toBeNull();
    invoiceMock.getMode.mockRejectedValue(new Error('settings down'));
    expect(await ingest.processEmail(front, mail({ subject: 'FW: Invoice INV-20417 from Acme Supplies' }), new Map())).toBe('created');
    await expect(ingest._lastInvoiceMatchJob).resolves.toBeNull();
  });
});
