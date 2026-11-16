import { jest } from '@jest/globals';

/**
 * "Closed as a duplicate or merged" (16 Nov 2026). Grouping closes a repeat
 * alert or a person's follow-up into the ticket already open, and IT's
 * "Ticket resolved or closed" e-mail told them their ticket was resolved.
 * The condition reads the ticket's duplicate_of / merged_into link or its
 * "duplicate" resolution reason, only when a condition names it.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: engine } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { CONDITION_FIELDS } = await import('../src/services/notificationConditionModel.js');
const { RULE_FIELDS } = await import('../src/services/conditionRuleShared.js');

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 1000;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.findUnique.mockResolvedValue({ resolutionReason: null });
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
});

// The real default "Ticket resolved or closed" workflow, with the new row on its first condition step.
const definition = (() => {
  const def = buildDefaultWorkflowDefinition('ticket.resolved_closed');
  let cond = def.nodes.find((n) => n.type === 'condition');
  if (!cond) {
    // No condition step in the default: put one right after the trigger.
    const first = def.edges.find((e) => e.source === 'trigger');
    cond = { id: 'not-dup', type: 'condition', position: { x: 200, y: 60 }, data: { conditionGroup: { logic: 'all', conditions: [] } } };
    def.nodes.push(cond, { id: 'skip-dup', type: 'stop', position: { x: 200, y: 200 }, data: {} });
    def.edges.push({ id: 'e-dup-true', source: 'not-dup', target: first.target, sourceHandle: 'true' }, { id: 'e-dup-false', source: 'not-dup', target: 'skip-dup', sourceHandle: 'false' });
    first.target = 'not-dup';
  }
  cond.data.conditionGroup = { logic: 'all', conditions: [...(cond.data.conditionGroup?.conditions || []), { field: 'ticket.isDuplicate', operator: 'is_false' }] };
  delete cond.data.rule;
  return def;
})();
const COND_ID = definition.nodes.find((n) => n.type === 'condition').id;const ctx = () => ({
  event: { type: 'ticket.resolved_closed', source: 'test', occurredAt: '2026-11-16T20:00:00.000Z', extra: {} },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, workspaceId: 1, subject: 'Transfer has failed', status: 'Closed' },
  requester: { name: 'Alex Rivera', email: 'alex@example.com' },
  assignedAgent: null,
  previousAgent: null,
});
async function conditionStep() {
  const result = await engine.executePreview({
    workflow: { id: 5, workspaceId: 1, triggerType: 'ticket.resolved_closed', draftDefinition: definition, publishedVersion: 0, versions: [] },
    definition,
    eventContext: ctx(),
  });
  return result.steps.find((s) => s.nodeId === COND_ID);
}

describe('"Closed as a duplicate or merged"', () => {
  test('is a condition field in both catalogues', () => {
    expect(CONDITION_FIELDS['ticket.isDuplicate']).toMatchObject({ label: 'Closed as a duplicate or merged', type: 'boolean' });
    expect(RULE_FIELDS['ticket.isDuplicate']).toBeTruthy();
  });

  test('a ticket grouping closed as a duplicate takes the False path', async () => {
    prismaMock.ticketLink.findFirst.mockResolvedValue({ id: 974 });
    const step = await conditionStep();
    expect(step.output.passed).toBe(false);
  });

  test('resolution reason "duplicate" without a link also counts', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ resolutionReason: 'duplicate' });
    expect((await conditionStep()).output.passed).toBe(false);
  });

  test('an ordinary close passes', async () => {
    expect((await conditionStep()).output.passed).toBe(true);
    expect(prismaMock.ticketLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 100, kind: { in: ['duplicate_of', 'merged_into'] } } }));
  });

  test('a workflow that never names it reads nothing extra', async () => {
    const plain = JSON.parse(JSON.stringify(definition));
    plain.nodes.find((n) => n.id === COND_ID).data.conditionGroup.conditions = [{ field: 'ticket.isNoise', operator: 'is_false' }];
    await engine.executePreview({
      workflow: { id: 5, workspaceId: 1, triggerType: 'ticket.resolved_closed', draftDefinition: plain, publishedVersion: 0, versions: [] },
      definition: plain,
      eventContext: ctx(),
    });
    expect(prismaMock.ticketLink.findFirst).not.toHaveBeenCalled();
  });
});
