import { jest } from '@jest/globals';

/**
 * MEGA 09-01 Phase RO-4 / RO-5 — the update_ticket node writes a status to an
 * FS-born ticket THROUGH FreshService (ticketService.updateFsTicket), skips
 * when FreshService already shows that status (its own automator beat us),
 * and on failure leaves the local row untouched: attempts 1..2 park the run
 * for a delay-resume retry AT the node, attempt 3 fails the step visibly.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), create: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};
const activityCreateMock = jest.fn().mockResolvedValue({});
const fetchTicketSafeMock = jest.fn();
const getInteractiveClientMock = jest.fn().mockResolvedValue({ fetchTicketSafe: fetchTicketSafeMock });
const updateFsTicketMock = jest.fn();
const recordFailureMock = jest.fn().mockResolvedValue({});
const recordSuccessMock = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreateMock } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueFieldSync: jest.fn().mockResolvedValue({}),
    enqueueThreadEntry: jest.fn().mockResolvedValue({}),
    getInteractiveClient: getInteractiveClientMock,
  },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({
  default: { updateFsTicket: updateFsTicketMock, assignTicket: jest.fn() },
}));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({
  default: { recordFailure: recordFailureMock, recordSuccess: recordSuccessMock },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: { setValues: jest.fn() },
  prettifyKeyLabel: (key) => String(key),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  applyFsBornStatusWriteback, executeDefinition, FS_WRITEBACK_MAX_ATTEMPTS, FS_WRITEBACK_RETRY_MINUTES,
} = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const flush = () => new Promise((r) => setTimeout(r, 10));

const FS_TICKET = {
  id: 39618,
  workspaceId: 2,
  origin: 'freshservice',
  freshserviceTicketId: BigInt(237051),
  status: 'Closed',
  priority: 3,
  createdAt: new Date('2026-08-11T16:03:00Z'),
  customFields: {},
};
const NODE = { id: 'reopen', type: 'update_ticket', data: { setStatus: 'Open', note: 'Reopened automatically — the requester replied.' } };

describe('applyFsBornStatusWriteback (RO-4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getInteractiveClientMock.mockResolvedValue({ fetchTicketSafe: fetchTicketSafeMock });
  });

  test('FS still Closed → writes Open through updateFsTicket as the workflow actor', async () => {
    fetchTicketSafeMock.mockResolvedValue({ id: 237051, status: 5 });
    updateFsTicketMock.mockResolvedValue({ id: 39618, status: 'Open' });
    const state = {};

    const out = await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state, eventContext: { event: { type: 'ticket.reply_received' } } });
    await flush();

    expect(updateFsTicketMock).toHaveBeenCalledWith(39618, 2, { status: 'Open' }, expect.objectContaining({ name: 'Notification workflow', role: 'workflow' }));
    expect(out).toEqual(expect.objectContaining({ applied: true, via: 'freshservice_writeback', status: { from: 'Closed', to: 'Open' } }));
    expect(activityCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'workflow_updated_ticket',
      details: expect.objectContaining({ via: 'freshservice_writeback', actorKind: 'workflow', eventType: 'ticket.reply_received' }),
    }));
    expect(recordSuccessMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'freshservice_writeback', workspaceId: 2 }));
    expect(prismaMock.ticket.update).not.toHaveBeenCalled(); // never a local-only flip
  });

  test('FS already Open (its automator beat us) → skipped "already open in FreshService", no write', async () => {
    fetchTicketSafeMock.mockResolvedValue({ id: 237051, status: 2 });

    const out = await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state: {} });

    expect(out).toEqual(expect.objectContaining({ skipped: true, reason: 'already open in FreshService', via: 'freshservice_writeback' }));
    expect(updateFsTicketMock).not.toHaveBeenCalled();
  });

  test('a failed write parks the run for a retry AT the node and records a health failure', async () => {
    fetchTicketSafeMock.mockResolvedValue({ id: 237051, status: 5 });
    updateFsTicketMock.mockRejectedValue(new Error('FreshService 401 — bad key'));
    const state = {};

    const out = await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state });
    await flush();

    expect(out).toEqual(expect.objectContaining({
      __waitMinutes: FS_WRITEBACK_RETRY_MINUTES,
      __retryNodeId: 'reopen',
      failed: true,
      attempt: 1,
      maxAttempts: FS_WRITEBACK_MAX_ATTEMPTS,
      error: 'Failed to write reopen to FreshService: FreshService 401 — bad key',
    }));
    expect(state.__fsWritebackAttempts).toEqual({ reopen: 1 });
    expect(recordFailureMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'freshservice_writeback', workspaceId: 2 }));
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('the last attempt throws so the step reads "failed" in the run detail', async () => {
    fetchTicketSafeMock.mockResolvedValue({ id: 237051, status: 5 });
    updateFsTicketMock.mockRejectedValue(new Error('FreshService 401 — bad key'));
    const state = { __fsWritebackAttempts: { reopen: FS_WRITEBACK_MAX_ATTEMPTS - 1 } };

    await expect(applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state }))
      .rejects.toThrow('Failed to write reopen to FreshService: FreshService 401 — bad key');
  });
});

describe('seeded "Reopen on requester reply" end-to-end on an FS-born ticket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let stepId = 100;
    prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
    prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
    prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
    prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
    prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
    prismaMock.ticket.findUnique.mockResolvedValue(FS_TICKET);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
    getInteractiveClientMock.mockResolvedValue({ fetchTicketSafe: fetchTicketSafeMock });
    fetchTicketSafeMock.mockResolvedValue({ id: 237051, status: 5 });
    updateFsTicketMock.mockResolvedValue({ id: 39618, status: 'Open' });
  });

  const context = () => ({
    event: { type: 'ticket.reply_received', source: 'freshservice_sync', occurredAt: '2026-08-17T17:48:40.000Z', dedupeStamp: 'fs-activity:2862800', extra: { senderIsAgent: false, isSurveyResponse: false } },
    workspace: { id: 2, name: 'Accounting', timezone: 'America/Vancouver' },
    ticket: { id: 39618, workspaceId: 2, origin: 'freshservice', freshserviceTicketId: 237051, subject: 'PMT-FC 19279', status: 'Closed', isNoise: false, customFields: {} },
    requester: { name: '1800 Recevables', email: 'ar@vendor.example.com' },
    assignedAgent: null,
    previousAgent: null,
  });
  const WORKFLOW = { id: 524, name: 'Reopen on requester reply', workspaceId: 2, triggerType: 'ticket.reply_received', publishedVersion: 1, versions: [] };

  test('live run: the reopen node writes through FreshService (via freshservice_writeback)', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: buildDefaultWorkflowDefinition('ticket.reply_received'),
      eventContext: context(),
      dryRun: false,
      executionMode: 'live',
    });
    const step = result.steps.find((s) => s.nodeId === 'reopen');
    expect(step.output).toEqual(expect.objectContaining({ via: 'freshservice_writeback', status: expect.objectContaining({ applied: true }) }));
    expect(updateFsTicketMock).toHaveBeenCalledWith(39618, 2, { status: 'Open' }, expect.anything());
    expect(result.status).toBe('completed');
  });

  test('mock run: reports what it WOULD set and never touches FreshService', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: buildDefaultWorkflowDefinition('ticket.reply_received'),
      eventContext: context(),
      dryRun: false,
      executionMode: 'mock',
    });
    const step = result.steps.find((s) => s.nodeId === 'reopen');
    expect(step.output).toEqual(expect.objectContaining({ dryRun: true, wouldSet: expect.objectContaining({ status: 'Open' }) }));
    expect(updateFsTicketMock).not.toHaveBeenCalled();
    expect(fetchTicketSafeMock).not.toHaveBeenCalled();
  });

  test('live run with a bad key: the run parks for a retry at the reopen node (no local flip)', async () => {
    updateFsTicketMock.mockRejectedValue(new Error('401 Unauthorized'));
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: buildDefaultWorkflowDefinition('ticket.reply_received'),
      eventContext: context(),
      dryRun: false,
      executionMode: 'live',
    });
    expect(result.status).toBe('waiting');
    expect(prismaMock.notificationWorkflowRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'waiting', resumeNodeId: 'reopen', resumeState: expect.objectContaining({ state: expect.objectContaining({ __fsWritebackAttempts: { reopen: 1 } }) }) }),
    }));
    const step = result.steps.find((s) => s.nodeId === 'reopen');
    expect(step.output).toEqual(expect.objectContaining({ waiting: true, retry: true, attempt: 1, error: expect.stringContaining('Failed to write reopen to FreshService') }));
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });
});
