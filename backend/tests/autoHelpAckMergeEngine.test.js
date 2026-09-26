import { jest } from '@jest/globals';

/**
 * Auto-help integration W3 — ack merge in the workflow engine (Vahid: merge).
 * A send-email node with autoHelpMerge.enabled:
 *  - Auto-help NOT expected to send by itself (shadow / approve — every
 *    workspace in this build) → the ack goes at once, unchanged;
 *  - expected → the node leaves a pending ack and parks (durable delay that
 *    re-runs the node after waitMinutes, capped at 15);
 *  - on wake: the answer carried it (consumed) → nothing is sent; the window
 *    passed (released) → the ack goes as usual; the answer is mid-send
 *    (merging) → look again in a minute, never send both.
 * Harness from notificationWorkflowEnginePersistence.test.js.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  aiProviderAttempt: { updateMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationEmailBlock: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  autoHelpPendingAck: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
};
const contextMock = {
  expectedFor: jest.fn(async () => false),
  contextFor: jest.fn(async () => ({ state: 'off', expected: false })),
  definitionReadsAutoHelp: jest.fn(() => false),
};
const processDeliveryMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/autoHelpContextService.js', () => ({ ...contextMock, default: contextMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: processDeliveryMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: { listEnabledForEvent: jest.fn(), recordSuppressionDecisions: jest.fn().mockResolvedValue({ updated: 0 }) },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn(async (context) => context),
  selectWorkflowsForNotificationTiming: jest.fn((workflows) => ({ selected: workflows, suppressed: [], mode: 'standard', reason: null })),
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: { sendJson: jest.fn(), runToolTurn: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  enrichEventContextWithPublicStatusUrl: jest.fn(async (context) => context),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const workflow = { id: 7, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [{ id: 70, version: 1 }] };
const eventContext = {
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-09-26T19:00:00.000Z', dedupeStamp: '2026-09-26T19:00:00.000Z' },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 501, displayRef: 'TP-900', subject: 'Install Bluebeam please', status: 'Open', priorityLabel: 'Medium', isNoise: false, origin: 'ticketpulse' },
  requester: { name: 'Pat Requester', email: 'pat@example.com' },
  assignedAgent: null,
  previousAgent: null,
};

function mergeDefinition(option = { enabled: true, waitMinutes: 5 }) {
  const definition = buildDefaultWorkflowDefinition('ticket.created');
  const send = definition.nodes.find((n) => n.type === 'send_email');
  send.data = { ...send.data, autoHelpMerge: option };
  return { definition, sendId: send.id };
}
const waitingUpdate = () => prismaMock.notificationWorkflowRun.update.mock.calls.map(([a]) => a.data).find((d) => d.status === 'waiting');

function resetMocks() {
  jest.clearAllMocks();
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 1234, ...data }));
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.aiProviderAttempt.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
  prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.autoHelpPendingAck.create.mockImplementation(({ data }) => Promise.resolve({ id: 61, ...data }));
  processDeliveryMock.mockResolvedValue({ success: true, result: { provider: 'sendgrid' } });
  contextMock.expectedFor.mockResolvedValue(false);
}

beforeEach(resetMocks);

describe('send-email node: autoHelpMerge', () => {
  test('Auto-help will not send by itself → the ack goes at once (no hold, no wait)', async () => {
    const { definition } = mergeDefinition();
    const result = await executeDefinition({ workflow, definition, eventContext, dryRun: false, triggerSource: 'test' });
    expect(result.status).toBe('completed');
    expect(contextMock.expectedFor).toHaveBeenCalledWith(501, 1);
    expect(prismaMock.autoHelpPendingAck.create).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });

  test('the option off → Auto-help is not even asked', async () => {
    const { definition } = mergeDefinition({ enabled: false });
    await executeDefinition({ workflow, definition, eventContext, dryRun: false, triggerSource: 'test' });
    expect(contextMock.expectedFor).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });

  test('expected → a pending ack (rendered text) and a durable wait that re-runs the send node (max 15 min)', async () => {
    contextMock.expectedFor.mockResolvedValue(true);
    const { definition, sendId } = mergeDefinition({ enabled: true, waitMinutes: 40 });
    const result = await executeDefinition({ workflow, definition, eventContext, dryRun: false, triggerSource: 'test' });
    expect(result.status).toBe('waiting');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    const hold = prismaMock.autoHelpPendingAck.create.mock.calls[0][0].data;
    expect(hold).toMatchObject({ workspaceId: 1, ticketId: 501, workflowRunId: 900, nodeId: sendId, status: 'pending' });
    expect(hold.ackText.length).toBeGreaterThan(10);
    expect(hold.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60e3 + 1000);
    const w = waitingUpdate();
    expect(w.resumeNodeId).toBe(sendId);
    expect(new Date(w.resumeAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60e3 + 1000);
    expect(w.resumeState.state.autoHelpMerge[sendId]).toMatchObject({ held: true, pendingAckId: 61 });
  });

  async function resumeWith(ackRow, { claimed = 0 } = {}) {
    contextMock.expectedFor.mockResolvedValue(true);
    const { definition, sendId } = mergeDefinition();
    await executeDefinition({ workflow, definition, eventContext, dryRun: false, triggerSource: 'test' });
    const state = waitingUpdate().resumeState.state;
    resetMocks();
    prismaMock.autoHelpPendingAck.updateMany.mockResolvedValue({ count: claimed });
    prismaMock.autoHelpPendingAck.findFirst.mockResolvedValue(ackRow);
    return executeDefinition({
      workflow, definition, eventContext, dryRun: false, triggerSource: 'delay_resume',
      resume: { run: { id: 900, workflowId: 7 }, state, startNodeIds: [sendId] },
    });
  }

  test('Auto-help sent in the window → the ack rode on the answer; nothing is sent separately', async () => {
    const result = await resumeWith({ id: 61, status: 'consumed', consumedRunId: 4401 });
    expect(result.status).toBe('completed');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(contextMock.expectedFor).not.toHaveBeenCalled(); // decided once, at the first pass
    const sendStep = result.steps.find((s) => s.nodeType === 'send_email');
    expect(sendStep.output).toMatchObject({ skipped: true, mergedIntoAutoHelp: true, autoHelpRunId: 4401 });
  });

  test('the window passed → the node releases the ack and sends it as usual', async () => {
    const result = await resumeWith(null, { claimed: 1 });
    expect(result.status).toBe('completed');
    expect(prismaMock.autoHelpPendingAck.updateMany).toHaveBeenCalledWith({ where: { id: 61, status: 'pending' }, data: { status: 'released' } });
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });

  test('the answer is being sent right now → wait one more minute, never send both', async () => {
    const result = await resumeWith({ id: 61, status: 'merging', updatedAt: new Date(), createdAt: new Date() });
    expect(result.status).toBe('waiting');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    const w = waitingUpdate();
    expect(new Date(w.resumeAt).getTime() - Date.now()).toBeLessThanOrEqual(61e3);
    expect(w.resumeState.state.autoHelpMerge).toBeDefined();
  });

  test('preview / dry-run never holds an ack', async () => {
    contextMock.expectedFor.mockResolvedValue(true);
    const { definition } = mergeDefinition();
    const result = await executeDefinition({ workflow, definition, eventContext, dryRun: true, triggerSource: 'test' });
    expect(result.status).toBe('completed');
    expect(prismaMock.autoHelpPendingAck.create).not.toHaveBeenCalled();
  });
});
