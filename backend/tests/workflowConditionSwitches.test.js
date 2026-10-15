import { jest } from '@jest/globals';

/**
 * Workflow conditions without code (14 Oct 2026): the reopen-on-reply step is
 * builder rows + the "Ignore a thank-you or out-of-office reply after an
 * Auto-help close" switch, and the engine applies that switch (like Skip
 * noise) with a plain explanation.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { buildDefaultWorkflowDefinition, validateWorkflowDefinition, WORKFLOW_TEMPLATES } = await import('../src/services/notificationWorkflowDefinition.js');
const { default: engine, explainSwitchStop } = await import('../src/services/notificationWorkflowEngine.js');
const { conditionStepPasses } = await import('../src/services/workflowRuleConversion.js');
const { addReopenGuard } = await import('../src/services/autoHelpWorkflowGuards.js');

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
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
});

const replyContext = ({ status = 'Resolved', verdict = null, isNoise = false } = {}) => ({
  event: { type: 'ticket.reply_received', source: 'test', occurredAt: '2026-10-14T18:00:00.000Z', extra: verdict ? { autoHelpReplyVerdict: verdict } : {} },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, workspaceId: 1, subject: 'Laptop', status, isNoise },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: null,
  previousAgent: null,
});

async function runReopen(definition, ctx) {
  const result = await engine.executePreview({
    workflow: { id: 9764, workspaceId: 1, triggerType: 'ticket.reply_received', draftDefinition: definition, publishedVersion: 0, versions: [] },
    definition,
    eventContext: ctx,
  });
  return result.steps.find((s) => s.nodeId === 'is-resolved');
}

describe('reply_received default template', () => {
  test('is builder rows + the Auto-help switch, never a raw rule, and validates', () => {
    const def = buildDefaultWorkflowDefinition('ticket.reply_received');
    const node = def.nodes.find((n) => n.id === 'is-resolved');
    expect(node.data.rule).toBeUndefined();
    expect(node.data.conditionGroup).toEqual({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed', 'Pending Response'] }] });
    expect(node.data.ignoreAutoHelpThanks).toBe(true);
    expect(validateWorkflowDefinition(def, { triggerType: 'ticket.reply_received' }).errors).toEqual([]);
  });

  test('every other default step opens on rows too (no raw rules in shipped templates)', () => {
    const raw = [];
    const defs = [
      ...['ticket.created', 'ticket.assigned', 'ticket.note_added', 'ticket.fields_updated', 'ticket.resolved_closed'].map((t) => buildDefaultWorkflowDefinition(t)),
      ...WORKFLOW_TEMPLATES.map((t) => t.build()),
    ];
    for (const def of defs) {
      for (const n of def.nodes) {
        if (n.type === 'condition' && n.data?.rule !== undefined) raw.push(n.id);
        for (const b of n.data?.branches || []) if (b.rule !== undefined) raw.push(`${n.id}/${b.key}`);
      }
    }
    expect(raw).toEqual([]);
    const skip = buildDefaultWorkflowDefinition('ticket.created').nodes.find((n) => n.id === 'skip-noise');
    expect(skip.data).toMatchObject({ skipNoise: true, conditionGroup: { logic: 'all', conditions: [] } });
  });

  test('the step answers like the old raw rule for every old status', () => {
    const def = buildDefaultWorkflowDefinition('ticket.reply_received');
    const data = def.nodes.find((n) => n.id === 'is-resolved').data;
    const scope = (status, verdict) => ({ ticket: { status }, event: { extra: verdict ? { autoHelpReplyVerdict: verdict } : {} } });
    expect(conditionStepPasses(data, scope('Resolved', 'confirmed'))).toBe(false);
    expect(conditionStepPasses(data, scope('Closed', 'auto_reply'))).toBe(false);
    expect(conditionStepPasses(data, scope('Resolved', 'help'))).toBe(true);
    expect(conditionStepPasses(data, scope('Closed', null))).toBe(true);
    expect(conditionStepPasses(data, scope('Pending Response', null))).toBe(true);
    expect(conditionStepPasses(data, scope('Open', null))).toBe(false);
  });
});

describe('engine: Ignore a thank-you or out-of-office reply after an Auto-help close', () => {
  const definitionWith = (ignoreAutoHelpThanks) => {
    const def = buildDefaultWorkflowDefinition('ticket.reply_received');
    def.nodes.find((n) => n.id === 'is-resolved').data.ignoreAutoHelpThanks = ignoreAutoHelpThanks;
    return def;
  };

  test.each([
    ['confirmed', 'a thank-you'],
    ['auto_reply', 'an out-of-office or automatic reply'],
  ])('switch on + verdict %s: the step is false and says why', async (verdict, words) => {
    const step = await runReopen(definitionWith(true), replyContext({ verdict }));
    expect(step.output.passed).toBe(false);
    expect(step.output.explain).toMatchObject({ source: 'auto_help_thanks', autoHelpThanksIgnored: true, verdict });
    expect(step.output.explain.summary).toBe(`the reply reads as ${words} after an Auto-help close, and this step is set to ignore those`);
  });

  test('switch on + "help" or no verdict: the conditions decide', async () => {
    expect((await runReopen(definitionWith(true), replyContext({ verdict: 'help' }))).output.passed).toBe(true);
    expect((await runReopen(definitionWith(true), replyContext({}))).output.passed).toBe(true);
    expect((await runReopen(definitionWith(true), replyContext({ status: 'Open' }))).output.passed).toBe(false);
  });

  test('switch off: a thank-you reopens like any reply', async () => {
    const step = await runReopen(definitionWith(false), replyContext({ verdict: 'confirmed' }));
    expect(step.output.passed).toBe(true);
    expect(step.output.explain.source).toBe('conditions');
  });

  test('the same switch honours the page\'s reading (event.extra.replyVerdict) of a reply to any closed ticket', async () => {
    const ctx = (replyVerdict) => ({ ...replyContext({}), event: { ...replyContext({}).event, extra: { replyVerdict } } });
    const thanks = await runReopen(definitionWith(true), ctx('thanks'));
    expect(thanks.output.passed).toBe(false);
    expect(thanks.output.explain.summary).toBe('the reply reads as a thank-you (When a requester replies), and this step is set to ignore those');
    expect((await runReopen(definitionWith(true), ctx('auto_reply'))).output.passed).toBe(false);
    expect((await runReopen(definitionWith(true), ctx('reply'))).output.passed).toBe(true);
    expect((await runReopen(definitionWith(false), ctx('thanks'))).output.passed).toBe(true);
  });

  test('Skip noise is still checked first', () => {
    expect(explainSwitchStop('skip_noise').summary).toBe('Skip noise tickets is on and this ticket is marked as noise');
  });
});

describe('Auto-help guard one-off sets the switch', () => {
  test('a legacy raw-rule reopen step gets the switch, once', () => {
    const def = buildDefaultWorkflowDefinition('ticket.reply_received');
    const node = def.nodes.find((n) => n.id === 'is-resolved');
    delete node.data.conditionGroup;
    delete node.data.ignoreAutoHelpThanks;
    node.data.rule = { in: [{ var: 'ticket.status' }, ['Resolved', 'Closed']] };
    const first = addReopenGuard(def);
    expect(first.changed).toBe(true);
    expect(first.definition.nodes.find((n) => n.id === 'is-resolved').data.ignoreAutoHelpThanks).toBe(true);
    expect(addReopenGuard(first.definition)).toMatchObject({ changed: false, why: 'already guarded' });
  });
});
