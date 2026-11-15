import { jest } from '@jest/globals';

/**
 * MEGA 11-14, Part A — the engine side (lane a1): the loop guard switch, the
 * "New ticket from this reply" step in preview and validation, the gallery
 * template, and (API Dev thread check 1) that a new ticket whose requester is
 * an unattended mailbox gets no acknowledgment: the recipient guard drops it.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findFirst: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  buildDefaultWorkflowDefinition, validateWorkflowDefinition, WORKFLOW_TEMPLATES, installableWorkflowTemplates, NOTIFICATION_NODE_REGISTRY,
} = await import('../src/services/notificationWorkflowDefinition.js');
const { default: engine, explainSwitchStop } = await import('../src/services/notificationWorkflowEngine.js');
const { requesterContextFromSource } = await import('../src/services/requesterProfileService.js');

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 1000;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, ...data }));
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.requester.findUnique.mockResolvedValue(null);
});

const replyContext = (extra = {}, ticket = {}) => ({
  event: { type: 'ticket.reply_received', source: 'test', occurredAt: '2026-11-15T18:00:00.000Z', extra },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, workspaceId: 1, subject: 'Laptop', status: 'Closed', ...ticket },
  requester: { name: 'Rita Example', email: 'rita@example.com' },
  assignedAgent: null,
  previousAgent: null,
});
const preview = (definition, ctx, triggerType = 'ticket.reply_received') => engine.executePreview({
  workflow: { id: 9764, workspaceId: 1, triggerType, draftDefinition: definition, publishedVersion: 0, versions: [] },
  definition,
  eventContext: ctx,
});

/** trigger → the reopen condition → New ticket from this reply → stop. */
function newTicketDefinition() {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  def.nodes = def.nodes.filter((n) => n.id !== 'reopen');
  def.nodes.push({ id: 'new-ticket', type: 'create_ticket_from_reply', position: { x: 540, y: 0 }, data: { note: 'Closed more than 14 days ago.' } });
  def.edges = def.edges.map((e) => (e.target === 'reopen' ? { ...e, target: 'new-ticket' } : e.source === 'reopen' ? { ...e, source: 'new-ticket' } : e));
  return def;
}

describe('Stop after 3 reopens by replies in a day (replyLoopGuard)', () => {
  test('the 4th reopen takes the False path and says why; the run state carries the source for the "why" line', async () => {
    const result = await preview(buildDefaultWorkflowDefinition('ticket.reply_received'), replyContext({ replyReopens24h: 3 }));
    const step = result.steps.find((s) => s.nodeId === 'is-resolved');
    expect(step.output.passed).toBe(false);
    expect(step.output.explain).toMatchObject({ source: 'reply_loop', replyLoopStopped: true, reopens: 3 });
    expect(step.output.explain.summary).toBe('replies reopened this ticket 3 times in the last 24 hours, and this step stops after 3');
    expect(result.state.lastCondition).toMatchObject({ passed: false, source: 'reply_loop' });
    expect(result.steps.some((s) => s.nodeType === 'update_ticket')).toBe(false);
  });

  test('2 reopens today: it reopens; the switch off: any number reopens', async () => {
    const two = await preview(buildDefaultWorkflowDefinition('ticket.reply_received'), replyContext({ replyReopens24h: 2 }));
    expect(two.steps.find((s) => s.nodeType === 'update_ticket').output).toMatchObject({ dryRun: true, wouldSet: { status: 'Open' } });
    const off = buildDefaultWorkflowDefinition('ticket.reply_received');
    off.nodes.find((n) => n.id === 'is-resolved').data.replyLoopGuard = false;
    const many = await preview(off, replyContext({ replyReopens24h: 9 }));
    expect(many.steps.find((s) => s.nodeId === 'is-resolved').output.passed).toBe(true);
  });

  test('explainSwitchStop keeps "reply_thanks" for every close', () => {
    expect(explainSwitchStop('reply_thanks', { event: { extra: { replyVerdict: 'auto_reply' } } })).toMatchObject({ source: 'reply_thanks', verdict: 'auto_reply' });
  });
});

describe('New ticket from this reply (create_ticket_from_reply)', () => {
  test('registered as an action step with the palette label', () => {
    expect(NOTIFICATION_NODE_REGISTRY.create_ticket_from_reply).toMatchObject({ label: 'New ticket from this reply', terminal: false });
  });

  test('valid on "Requester replied" only; the extra line is short text', () => {
    expect(validateWorkflowDefinition(newTicketDefinition(), { triggerType: 'ticket.reply_received' }).errors).toEqual([]);
    const onCreated = {
      version: 1, metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'new-ticket', type: 'create_ticket_from_reply', data: {} },
        { id: 'done', type: 'stop', data: {} },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'new-ticket' }, { id: 'e2', source: 'new-ticket', target: 'done' }],
    };
    expect(validateWorkflowDefinition(onCreated, { triggerType: 'ticket.created' }).errors)
      .toEqual(['"New ticket from this reply" (new-ticket) only works on the "Requester replied" trigger']);
    const longNote = newTicketDefinition();
    longNote.nodes.find((n) => n.id === 'new-ticket').data.note = 'x'.repeat(301);
    expect(validateWorkflowDefinition(longNote, { triggerType: 'ticket.reply_received' }).errors[0]).toMatch(/at most 300 characters/);
  });

  test('preview says it would open a ticket and writes nothing', async () => {
    const result = await preview(newTicketDefinition(), replyContext({ entryId: 5, from: 'alex.rivera@example.com' }));
    const step = result.steps.find((s) => s.nodeId === 'new-ticket');
    expect(step.output).toEqual({ dryRun: true, wouldCreate: true });
    expect(result.state.replyNewTicket).toBeUndefined();
  });
});

describe('the ready-made workflow (contract §7)', () => {
  test('the gallery offers "Reopen on requester reply" with the shapeVersion 2 shape; it validates', () => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.key === 'reopen_on_requester_reply');
    expect(installableWorkflowTemplates()).toContain(t);
    const def = t.build();
    expect(def.metadata).toMatchObject({ shapeVersion: 2, installedFromTemplate: true });
    expect(def.nodes.find((n) => n.type === 'condition').data).toMatchObject({ ignoreThanks: true, replyLoopGuard: true });
    expect(validateWorkflowDefinition(def, { triggerType: 'ticket.reply_received' }).errors).toEqual([]);
  });
});

describe('API Dev check 1: a new ticket for an unattended requester sends no acknowledgment', () => {
  // The ticket "New ticket from this reply" starts fires "Ticket arrived" like
  // any new ticket. Its requester is the person who replied: when that is a
  // machine sender (an unattended requester), the ack has nobody to go to.
  const createdContext = (requester, ccEmails = []) => ({
    event: { type: 'ticket.created', source: 'ticketpulse_native', occurredAt: '2026-11-15T18:00:00.000Z', extra: {} },
    workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
    ticket: { id: 802, workspaceId: 1, subject: 'Disk alert again', status: 'Open', isNoise: false, ccEmails, origin: 'ticketpulse', nativeNumber: 2105 },
    requester,
    assignedAgent: null,
    previousAgent: null,
  });
  const resolvedTo = (result) => result.steps.find((s) => s.nodeType === 'recipient_resolver')?.output?.recipients?.to;

  test('the unattended flag rides through requesterContextFromSource, and the ack resolves to nobody', async () => {
    const machine = requesterContextFromSource({ name: 'Monitoring', email: 'monitor@example.com', unattended: true });
    expect(machine.unattended).toBe(true);
    const def = buildDefaultWorkflowDefinition('ticket.created');
    const result = await preview(def, createdContext(machine), 'ticket.created');
    expect(resolvedTo(result)).toEqual([]);

    // The same ticket for a person: the ack goes to them (the guard is what stops it above).
    const person = await preview(def, createdContext(requesterContextFromSource({ name: 'Alex Rivera', email: 'alex.rivera@example.com' })), 'ticket.created');
    expect(resolvedTo(person)).toHaveLength(1); // the step output redacts the address itself
    expect(person.state.recipients.to).toHaveLength(1);
  });

  test('read back from the requester row (the live path enriches by id): still unattended', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ id: 61, name: 'Monitoring', email: 'monitor@example.com', unattended: true });
    const result = await preview(buildDefaultWorkflowDefinition('ticket.created'), createdContext({ id: 61, name: 'Monitoring', email: 'monitor@example.com', unattended: true }), 'ticket.created');
    expect(resolvedTo(result)).toEqual([]);
  });
});
