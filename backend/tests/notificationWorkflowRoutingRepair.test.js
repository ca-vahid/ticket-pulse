import { jest } from '@jest/globals';

// QA 08-06 #6 — the workflow routing trap. Covers:
//  1. rule-less routing save round-trip keeps routingRule NULL (the frontend
//     no longer seeds the AU-BRISBANE demo rule; the backend must not revive
//     one either);
//  2. template install (additive, no rule) → routing tab save → the engine's
//     variant selection STILL selects the workflow;
//  3. routingMode is preserved through the save (not reset to 'exclusive');
//  4. recordSuppressionDecisions persists lastSuppressedAt/Reason per workflow.

const prismaMock = {
  notificationWorkflow: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    create: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const repository = (await import('../src/services/notificationWorkflowRepository.js')).default;
const { selectWorkflowVariants } = await import('../src/services/notificationWorkflowRoutingService.js');

// The template-install shape: additive automation with no routing rule
// (e.g. the AI draft stager installed from the template gallery).
const installedTemplate = {
  id: 42,
  workspaceId: 1,
  key: 'ticket_created_ai_draft',
  name: 'AI first-reply draft',
  triggerType: 'ticket.created',
  routingMode: 'additive',
  routingPriority: 50,
  routingRule: null,
  isDefaultVariant: false,
  archivedAt: null,
  isEnabled: true,
  publishedVersion: 1,
};

const defaultWorkflow = {
  id: 7,
  workspaceId: 1,
  key: 'ticket_created',
  name: 'Ticket arrived',
  triggerType: 'ticket.created',
  routingMode: 'exclusive',
  routingPriority: 100,
  routingRule: null,
  isDefaultVariant: true,
  archivedAt: null,
  isEnabled: true,
  publishedVersion: 1,
};

describe('rule-less routing save round-trip (QA 08-06 #6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue({ ...installedTemplate });
    prismaMock.notificationWorkflow.update.mockImplementation(({ data }) => Promise.resolve({ ...installedTemplate, ...data }));
  });

  test('saving the Routing tab untouched keeps routingRule null and routingMode additive', async () => {
    // Exactly what the fixed frontend sends for a rule-less workflow whose
    // builder was never touched.
    const updated = await repository.updateWorkflowRouting(1, 42, {
      routingMode: 'additive',
      routingPriority: 50,
      routingRule: null,
    }, { email: 'admin@example.com' });

    const { data } = prismaMock.notificationWorkflow.update.mock.calls[0][0];
    expect(data.routingRule).toBeNull();
    expect(data.routingMode).toBe('additive');
    expect(data.routingPriority).toBe(50);
    expect(updated.routingRule).toBeNull();

    // ...and the engine still selects the workflow after that save.
    const selection = selectWorkflowVariants(
      [defaultWorkflow, { ...installedTemplate, ...data }],
      { event: { type: 'ticket.created' }, requester: { regionKey: 'CA-VANCOUVER' } },
    );
    expect(selection.selectedWorkflowIds).toContain(42);
    expect(selection.matched).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 42, reason: 'additive_no_rule_always_runs' }),
    ]));
  });

  test('a real rule saved from the builder round-trips intact', async () => {
    const rule = { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] };
    await repository.updateWorkflowRouting(1, 42, {
      routingMode: 'additive',
      routingPriority: 50,
      routingRule: rule,
    }, null);

    const { data } = prismaMock.notificationWorkflow.update.mock.calls[0][0];
    expect(data.routingRule).toEqual(rule);
    expect(data.routingMode).toBe('additive');
  });

  test('an exclusive variant with a never-matching rule is suppressed BEFORE any run (the original trap)', () => {
    const trapped = {
      ...installedTemplate,
      id: 43,
      routingMode: 'exclusive',
      routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
    };
    const selection = selectWorkflowVariants(
      [defaultWorkflow, trapped],
      { event: { type: 'ticket.created' }, requester: { regionKey: 'CA-VANCOUVER' } },
    );
    expect(selection.selectedWorkflowIds).not.toContain(43);
    expect(selection.suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 43, reason: 'routing_rule_not_matched' }),
    ]));
  });
});

describe('recordSuppressionDecisions (QA 08-06 #6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationWorkflow.updateMany.mockResolvedValue({ count: 1 });
  });

  test('persists lastSuppressedAt/lastSuppressedReason grouped by reason', async () => {
    const result = await repository.recordSuppressionDecisions([
      { id: 43, reason: 'routing_rule_not_matched' },
      { id: 44, reason: 'routing_rule_not_matched' },
      { id: 7, reason: 'default_variant_not_needed' },
    ]);

    expect(result.updated).toBe(2);
    expect(prismaMock.notificationWorkflow.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.notificationWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [43, 44] } },
      data: expect.objectContaining({
        lastSuppressedAt: expect.any(Date),
        lastSuppressedReason: 'routing_rule_not_matched',
      }),
    });
    expect(prismaMock.notificationWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
      data: expect.objectContaining({ lastSuppressedReason: 'default_variant_not_needed' }),
    });
  });

  test('no-ops on empty or malformed input', async () => {
    expect(await repository.recordSuppressionDecisions([])).toEqual({ updated: 0 });
    expect(await repository.recordSuppressionDecisions([{ id: null, reason: '' }])).toEqual({ updated: 0 });
    expect(prismaMock.notificationWorkflow.updateMany).not.toHaveBeenCalled();
  });
});
