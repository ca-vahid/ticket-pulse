import { jest } from '@jest/globals';

// QA 08-05 #3 — Cc visibility. TP-born tickets must persist their Cc list on
// the Ticket ROW (the same ccEmails column FS sync fills), and composer
// replies must stash per-message recipients in rawPayload using the exact
// key shape FS conversations carry ({to_emails, cc_emails}) so one UI path
// renders recipients for both origins.

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: [], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
    ]),
  },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const noiseRuleServiceMock = { evaluate: jest.fn() };
const ticketActivityRepositoryMock = { create: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn() };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const sendgridMock = { sendEmail: jest.fn() };
const runPipelineMock = jest.fn();
const fsClientMock = { createReply: jest.fn(), addNote: jest.fn() };
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: runPipelineMock },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const actor = { email: 'coord@example.com', name: 'Cora Coordinator', role: 'viewer', technicianId: null, kind: 'member' };

function armCreateDefaults() {
  prismaMock.workspace.findUnique.mockResolvedValue({
    id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true,
  });
  requesterRepositoryMock.findByEmail.mockResolvedValue({
    id: 40, name: 'Rita Requester', email: 'rita@example.com', department: 'Finance', freshserviceId: null,
  });
  noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
  prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
  prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
    id: 501,
    ...data,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  }));
  ticketActivityRepositoryMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  runPipelineMock.mockResolvedValue({ id: 900 });
}

describe('createTicket cc persistence (ticket row)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armCreateDefaults();
  });

  test('ccEmails land on the Ticket row — normalized lowercase and deduped', async () => {
    await ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      requesterEmail: 'rita@example.com',
      ccEmails: ['Boss@Example.com', 'boss@example.com', 'peer@example.com'],
    }, actor);

    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ccEmails: ['boss@example.com', 'peer@example.com'],
      }),
    }));
    // The created audit still records them too (unchanged behavior).
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'created',
      details: expect.objectContaining({ ccEmails: ['boss@example.com', 'peer@example.com'] }),
    }));
  });

  test('no cc → the column is left to its default (key omitted)', async () => {
    await ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      requesterEmail: 'rita@example.com',
    }, actor);

    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.ccEmails).toBeUndefined();
  });

  test('invalid cc addresses are rejected by the schema', async () => {
    await expect(ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      requesterEmail: 'rita@example.com',
      ccEmails: ['not-an-email'],
    }, actor)).rejects.toThrow(/invalid email/i);
  });
});

describe('thread entry recipients (rawPayload, FS conversation shape)', () => {
  const nativeTicket = {
    id: 501,
    workspaceId: 1,
    origin: 'ticketpulse',
    nativeNumber: 1042,
    freshserviceTicketId: null,
    subject: 'Laptop will not boot',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    assignedTechId: null,
    firstPublicAgentReplyAt: null,
    requester: { id: 40, name: 'Rita Requester', email: 'Rita@Example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
    prismaMock.notificationDelivery.create.mockResolvedValue({});
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
  });

  test('native reply with Cc stashes {to_emails, cc_emails}', async () => {
    await ticketService.addReply(501, 1, {
      bodyText: 'We are on it!',
      cc: ['boss@example.com', 'peer@example.com'],
    }, actor);

    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        rawPayload: {
          to_emails: ['rita@example.com'], // requester, lowercased
          cc_emails: ['boss@example.com', 'peer@example.com'],
        },
      }),
    }));
  });

  test('native reply without Cc still records the To (requester) — no cc_emails key', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'Just us' }, actor);

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toEqual({ to_emails: ['rita@example.com'] });
  });

  test('internal notes carry NO recipients (cc is stripped and rawPayload omitted)', async () => {
    await ticketService.addPrivateNote(501, 1, { bodyText: 'internal context' }, actor);

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.isPrivate).toBe(true);
    expect(data.rawPayload).toBeUndefined();
  });

  test('FS-born replies stash recipients too (same shape as synced FS conversations)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9),
    });
    fsClientMock.createReply.mockResolvedValue({ conversation: { id: 42001 } });

    await ticketService.addReply(501, 1, {
      bodyText: 'hello from TP',
      cc: ['boss@example.com'],
    }, actor);

    expect(fsClientMock.createReply).toHaveBeenCalledWith(9, expect.any(String), expect.objectContaining({
      ccEmails: ['boss@example.com'],
    }));
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        rawPayload: expect.objectContaining({ cc_emails: ['boss@example.com'] }),
      }),
    }));
  });
});
