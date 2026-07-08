import { jest } from '@jest/globals';

/**
 * Workflow authoring (QA 07-07 #3): manual/sub-workflow trigger type,
 * blank-start creation, and trigger changes on existing workflows.
 */

const prismaMock = {
  notificationWorkflow: {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  NOTIFICATION_EVENT_TYPES,
  buildDefaultWorkflowDefinition,
  validateWorkflowDefinition,
} = await import('../src/services/notificationWorkflowDefinition.js');
const {
  createWorkflowVariant,
  changeWorkflowTrigger,
  listEnabledForEvent,
} = await import('../src/services/notificationWorkflowRepository.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationWorkflow.findFirst.mockResolvedValue(null);
  prismaMock.notificationWorkflow.findMany.mockResolvedValue([]);
  prismaMock.notificationWorkflow.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  prismaMock.notificationWorkflow.update.mockImplementation(async ({ data }) => ({ id: 700, ...data }));
});

describe('manual trigger type (sub-workflows)', () => {
  test('manual is a registered trigger and its default definition validates', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('manual');
    const definition = buildDefaultWorkflowDefinition('manual');
    expect(validateWorkflowDefinition(definition, { triggerType: 'manual' }).success).toBe(true);
  });

  test('a blank-start manual workflow is created as a disabled draft', async () => {
    const workflow = await createWorkflowVariant(1, { triggerType: 'manual', name: 'Notify facilities' }, { email: 'admin@x.com' });
    expect(workflow.triggerType).toBe('manual');
    expect(workflow.isEnabled).toBe(false);
    expect(workflow.publishedVersion).toBe(0);
    expect(workflow.name).toBe('Notify facilities');
  });

  test('lifecycle events can never select manual workflows (no event is named manual)', async () => {
    // Structural guarantee: dispatch looks up workflows by the fired event's
    // type; the only "manual" dispatch paths pass onlyWorkflowId explicitly.
    const lifecycleEvents = NOTIFICATION_EVENT_TYPES.filter((t) => t !== 'manual');
    for (const eventType of lifecycleEvents) {
      await listEnabledForEvent(1, eventType);
      const where = prismaMock.notificationWorkflow.findMany.mock.calls.at(-1)[0].where;
      expect(where.triggerType).toBe(eventType);
      expect(where.triggerType).not.toBe('manual');
    }
  });
});

describe('changeWorkflowTrigger', () => {
  const baseWorkflow = () => ({
    id: 700,
    workspaceId: 1,
    triggerType: 'ticket.created',
    isDefaultVariant: false,
    archivedAt: null,
    isEnabled: false,
    publishedVersion: 0,
    draftDefinition: buildDefaultWorkflowDefinition('ticket.created'),
  });

  test('retargets the trigger node and keeps the rest of the graph', async () => {
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue(baseWorkflow());
    const updated = await changeWorkflowTrigger(1, 700, 'ticket.assigned', { email: 'admin@x.com' });
    const update = prismaMock.notificationWorkflow.update.mock.calls[0][0];
    expect(update.data.triggerType).toBe('ticket.assigned');
    const trigger = update.data.draftDefinition.nodes.find((n) => n.type === 'trigger');
    expect(trigger.data.triggerType).toBe('ticket.assigned');
    // graph preserved: same node count as before
    expect(update.data.draftDefinition.nodes.length).toBe(baseWorkflow().draftDefinition.nodes.length);
    expect(updated.triggerType).toBe('ticket.assigned');
  });

  test('a live workflow is disabled until re-published on the new trigger', async () => {
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue({
      ...baseWorkflow(), isEnabled: true, publishedVersion: 3,
    });
    await changeWorkflowTrigger(1, 700, 'ticket.reply_received');
    expect(prismaMock.notificationWorkflow.update.mock.calls[0][0].data.isEnabled).toBe(false);
  });

  test('moving to schedule.time seeds slot defaults so the draft validates', async () => {
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue(baseWorkflow());
    await changeWorkflowTrigger(1, 700, 'schedule.time');
    const trigger = prismaMock.notificationWorkflow.update.mock.calls[0][0]
      .data.draftDefinition.nodes.find((n) => n.type === 'trigger');
    expect(trigger.data).toEqual(expect.objectContaining({
      triggerType: 'schedule.time', frequency: 'daily', time: '08:30',
    }));
  });

  test('default variants and unknown triggers are refused', async () => {
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue({ ...baseWorkflow(), isDefaultVariant: true });
    await expect(changeWorkflowTrigger(1, 700, 'ticket.assigned')).rejects.toThrow(/Default variants/);

    prismaMock.notificationWorkflow.findFirst.mockResolvedValue(baseWorkflow());
    await expect(changeWorkflowTrigger(1, 700, 'ticket.exploded')).rejects.toThrow(/Unsupported/);
  });
});
