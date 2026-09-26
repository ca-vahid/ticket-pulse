import { jest } from '@jest/globals';

/**
 * Auto-help integration W2 + W4 through the REAL ticketService.addReply
 * (harness from ticketReplyDrSn.test.js):
 *  - first response counts only when a person sends it: an automated answer
 *    stamps firstAutomatedReplyAt and leaves firstPublicAgentReplyAt alone
 *    unless the workspace opted in (autoHelpCountsAsFirstResponse);
 *  - a person's own public reply takes the first reply (reply owner 'agent');
 *    a one-click Auto-help send records owner 'auto_help'; automation never
 *    takes it.
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  workspaceEmailIdentity: { findUnique: jest.fn(), upsert: jest.fn() },
  mailboxConnection: { findFirst: jest.fn() },
  userEmailSignature: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
prismaMock.ticket.updateMany = jest.fn(async () => ({ count: 1 }));
prismaMock.ticketProposedReply = { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) };

const settingsRepositoryMock = {
  get: jest.fn(),
  set: jest.fn(),
  getSendGridConfig: jest.fn(),
};
const sendgridMock = { sendEmail: jest.fn() };
const fsClientMock = { createReply: jest.fn(), addNote: jest.fn(), fetchAgentByEmail: jest.fn(async () => null) };
const mirrorServiceMock = {
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
};
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({}), emitTicketEvent: emitTicketEventMock },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
const intakeMock = { onManualSettle: jest.fn(async () => ({ id: 31 })) };
const repoMock = { getOpenPipelineRun: jest.fn(async () => null) };
jest.unstable_mockModule('../src/services/autoHelpIntakeService.js', () => ({ default: intakeMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: repoMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { isConfigured: jest.fn(() => true), validateUpload: jest.fn(), upload: jest.fn(), ingestForFsTicket: jest.fn() },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { clearSenderIdentityCache } = await import('../src/services/workspaceEmailIdentityService.js');
const { invalidateFsReplyAsAgentCache } = await import('../src/services/fsReplyAsAgentService.js');
const { invalidateFsBornReplyLaneCache } = await import('../src/services/fsBornReplyLaneService.js');

const agent = { email: 'soheil@example.com', name: 'Soheil Nasiri', role: 'viewer', workspaceRole: 'member', technicianId: 7, kind: 'member' };

const nativeTicket = {
  id: 501,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Laptop will not boot',
  status: 'Open',
  priority: 3,
  createdAt: new Date('2026-07-01T10:00:00Z'),
  assignedTechId: null,
  firstPublicAgentReplyAt: null,
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
};

let nextEntryId;
beforeEach(() => {
  jest.clearAllMocks();
  clearSenderIdentityCache();
  invalidateFsReplyAsAgentCache();
  invalidateFsBornReplyLaneCache();
  nextEntryId = 9001;
  prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: nextEntryId++, ...data }));
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.create.mockResolvedValue({});
  prismaMock.workspaceEmailIdentity.findUnique.mockResolvedValue(null);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Soheil Nasiri', freshserviceId: BigInt(1002090731) });
  settingsRepositoryMock.get.mockResolvedValue(null);
  settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ fromEmail: 'ticketpulse@bgcengineering.ca', fromName: 'Ticket Pulse IT' });
  sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
  fsClientMock.createReply.mockResolvedValue({ conversation: { id: 1042916725 } });
  fsClientMock.addNote.mockResolvedValue({ conversation: { id: 1042916726 } });
});


const patchOf = () => prismaMock.ticket.update.mock.calls.map(([arg]) => arg.data).find((d) => 'lastRealActivityAt' in d);
const ownerWrites = () => prismaMock.ticket.updateMany.mock.calls.map(([arg]) => arg.data);
const settle = () => new Promise((r) => setImmediate(r));

describe('W4 first response', () => {
  test('a reply written by a person stamps firstPublicAgentReplyAt (unchanged)', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);
    expect(patchOf().firstPublicAgentReplyAt).toBeInstanceOf(Date);
    expect(patchOf().firstAutomatedReplyAt).toBeUndefined();
  });

  test('an automated answer stamps firstAutomatedReplyAt only — the first-response clock keeps running', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Here is how to install it.' }, { name: 'Ticket Pulse (Auto-help)', email: null, role: 'automation' }, [], {
      replyOwner: { kind: 'auto_help', ref: 'run:901' },
      automatedReply: { kind: 'answer', countsAsFirstResponse: false },
    });
    expect(patchOf().firstPublicAgentReplyAt).toBeUndefined();
    expect(patchOf().firstAutomatedReplyAt).toBeInstanceOf(Date);
  });

  test('with autoHelpCountsAsFirstResponse on, the automated answer also stops the clock', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Here is how to install it.' }, { name: 'Ticket Pulse (Auto-help)', role: 'automation' }, [], {
      automatedReply: { kind: 'answer', countsAsFirstResponse: true },
    });
    expect(patchOf().firstPublicAgentReplyAt).toBeInstanceOf(Date);
    expect(patchOf().firstAutomatedReplyAt).toBeInstanceOf(Date);
  });

  test('an automated check-in (follow_up) stamps neither', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Just checking in.' }, { name: 'Ticket Pulse (Auto-help)', role: 'automation' }, [], {
      automatedReply: { kind: 'follow_up' },
    });
    expect(patchOf().firstPublicAgentReplyAt).toBeUndefined();
    expect(patchOf().firstAutomatedReplyAt).toBeUndefined();
  });

  test('an existing firstAutomatedReplyAt is never moved', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, firstAutomatedReplyAt: new Date('2026-07-01T10:05:00Z') });
    await ticketService.addReply(501, 1, { bodyText: 'Second automated answer.' }, { name: 'Ticket Pulse (Auto-help)', role: 'automation' }, [], {
      automatedReply: { kind: 'answer' },
    });
    expect(patchOf().firstAutomatedReplyAt).toBeUndefined();
  });
});

describe('W2 reply owner on the reply path', () => {
  test('a reply a person wrote takes the first reply (agent, entry ref)', async () => {
    const { entry } = await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);
    await settle();
    expect(ownerWrites()).toContainEqual({ replyOwner: 'agent', replyOwnerRef: `entry:${entry.id}` });
  });

  test('a one-click Auto-help send records owner auto_help (the agent is still the author)', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Here is how.' }, agent, [], { replyOwner: { kind: 'auto_help', ref: 'run:901' } });
    await settle();
    expect(ownerWrites()).toContainEqual({ replyOwner: 'auto_help', replyOwnerRef: 'run:901' });
    expect(ownerWrites()).not.toContainEqual(expect.objectContaining({ replyOwner: 'agent' }));
    // An agent-sent Auto-help answer still counts as the first response (Vahid).
    expect(patchOf().firstPublicAgentReplyAt).toBeInstanceOf(Date);
  });

  test('automation never takes the first reply', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Just checking in.' }, { name: 'Ticket Pulse (Auto-help)', role: 'automation' }, [], { automatedReply: { kind: 'follow_up' } });
    await settle();
    expect(ownerWrites()).toEqual([]);
  });

  test('internal notes never touch the owner', async () => {
    await ticketService.addPrivateNote(501, 1, { bodyText: 'note' }, agent);
    await settle();
    expect(ownerWrites()).toEqual([]);
  });

  test('an owner write that fails never fails the reply', async () => {
    prismaMock.ticket.updateMany.mockRejectedValueOnce(new Error('db blip'));
    const res = await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);
    expect(res.entry.id).toBeTruthy();
  });
});

describe('W1 manual settle is durable in its own code path', () => {
  beforeEach(() => {
    prismaMock.ticket.findUnique = jest.fn(async () => ({
      workspaceId: 1, internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Software' }, internalSubcategory: { name: 'Install' },
    }));
  });

  test('no pipeline run open: the job (with its marker) is queued BEFORE the workflow event, which says enqueued', async () => {
    const order = [];
    intakeMock.onManualSettle.mockImplementation(async () => { order.push('job'); return { id: 31 }; });
    emitTicketEventMock.mockImplementation(async () => { order.push('event'); return {}; });
    const res = await ticketService._emitManualIntakeSettled(501, 'fields:501:9', 'human');
    expect(res).toEqual({ emitted: true, enqueued: true });
    expect(order).toEqual(['job', 'event']);
    expect(intakeMock.onManualSettle).toHaveBeenCalledWith(501, 1, expect.objectContaining({ source: 'manual', stamp: 'manual:fields:501:9', categoryId: 10 }));
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.intake_settled', 501, expect.objectContaining({
      dedupeStamp: 'intake_settled:501:manual:fields:501:9', extra: expect.objectContaining({ enqueued: true, source: 'manual' }),
    }));
  });

  test('a queue failure never stops the workflow event (enqueued false: the listener tries again, the catch-up too)', async () => {
    intakeMock.onManualSettle.mockRejectedValue(new Error('db down'));
    const res = await ticketService._emitManualIntakeSettled(501, 'fields:501:10', 'human');
    expect(res.enqueued).toBe(false);
    expect(emitTicketEventMock.mock.calls.at(-1)[2].extra.enqueued).toBe(false);
  });

  test('a pipeline run is open: it will settle the intake itself', async () => {
    repoMock.getOpenPipelineRun.mockResolvedValueOnce({ id: 7, status: 'queued' });
    const res = await ticketService._emitManualIntakeSettled(501, 'fields:501:11', 'human');
    expect(res).toEqual({ skipped: 'pipeline_run_open', runId: 7 });
    expect(intakeMock.onManualSettle).not.toHaveBeenCalled();
  });
});

describe('audit nice-to-have 9: existing behaviour in a workspace without Auto-help', () => {
  test('a person replies (no Auto-help anywhere): first response stamped as before, no automated stamp, the owner written exactly once', async () => {
    const { entry } = await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, agent);
    await settle();
    const patch = patchOf();
    expect(patch.firstPublicAgentReplyAt).toBeInstanceOf(Date);
    expect(patch).not.toHaveProperty('firstAutomatedReplyAt');
    expect(ownerWrites()).toEqual([{ replyOwner: 'agent', replyOwnerRef: `entry:${entry.id}` }]);
    // No Auto-help proposal to set aside (none exists): nothing else is touched.
    expect(prismaMock.ticketProposedReply.updateMany.mock.calls.every(([arg]) => arg.data?.status !== 'sent')).toBe(true);
  });

  test('a second reply keeps the first stamp and does not write the owner again', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, firstPublicAgentReplyAt: new Date('2026-07-01T10:30:00Z'), replyOwner: 'agent', replyOwnerRef: 'entry:9000' });
    await ticketService.addReply(501, 1, { bodyText: 'One more thing.' }, agent);
    await settle();
    expect(patchOf().firstPublicAgentReplyAt).toBeUndefined();
    expect(ownerWrites()).toEqual([]);
  });
});
