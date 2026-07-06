import { jest } from '@jest/globals';

/**
 * Phase 3 orchestration: branch (N-way switch) routing, delay park + durable
 * resume, and the graph-validation rules for the new node types.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketActivity: { create: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
// The live update_ticket path dynamically imports these; the real modules
// open handles (SSE heartbeats etc.) that keep jest alive.
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
const proposedReplyCreateMock = jest.fn().mockResolvedValue({ id: 501 });
jest.unstable_mockModule('../src/services/ticketProposedReplyService.js', () => ({
  default: { create: proposedReplyCreateMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  validateWorkflowDefinition,
  WORKFLOW_TEMPLATES,
} = await import('../src/services/notificationWorkflowDefinition.js');
const { default: engine, executeDefinition, resumeWaitingRuns } = await import('../src/services/notificationWorkflowEngine.js');

const eventContext = (over = {}) => ({
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-07-07T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, freshserviceTicketId: 225010, subject: 'VPN access problem', status: 'Open', priorityLabel: 'Urgent', isNoise: false },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: null,
  previousAgent: null,
  ...over,
});

function branchDefinition() {
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      {
        id: 'switch',
        type: 'branch',
        data: {
          branches: [
            { key: 'urgent', label: 'Urgent', conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' }] } },
            { key: 'halifax', label: 'Halifax', conditionGroup: { logic: 'all', conditions: [{ field: 'requester.officeLocation', operator: 'is', value: 'Halifax' }] } },
          ],
        },
      },
      { id: 'bump', type: 'update_ticket', data: { setPriority: 4 } },
      { id: 'calm', type: 'update_ticket', data: { setPriority: 2 } },
      { id: 'end-a', type: 'stop', data: {} },
      { id: 'end-b', type: 'stop', data: {} },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'switch' },
      { id: 'e2', source: 'switch', sourceHandle: 'urgent', target: 'bump' },
      { id: 'e3', source: 'switch', sourceHandle: 'otherwise', target: 'calm' },
      { id: 'e4', source: 'bump', target: 'end-a' },
      { id: 'e5', source: 'calm', target: 'end-b' },
    ],
  };
}

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
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketActivity.create.mockResolvedValue({});
  prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 700, ...create }));
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
});

describe('branch node validation', () => {
  test('a valid branch graph validates', () => {
    const result = validateWorkflowDefinition(branchDefinition(), { triggerType: 'ticket.created' });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  test('missing otherwise edge, duplicate keys, and unknown handles are rejected', () => {
    const noOtherwise = branchDefinition();
    noOtherwise.edges = noOtherwise.edges.filter((e) => e.sourceHandle !== 'otherwise');
    noOtherwise.nodes = noOtherwise.nodes.filter((n) => n.id !== 'calm' && n.id !== 'end-b');
    noOtherwise.edges = noOtherwise.edges.filter((e) => !['e3', 'e5'].includes(e.id));
    expect(validateWorkflowDefinition(noOtherwise, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/otherwise/i);

    const dupKeys = branchDefinition();
    dupKeys.nodes.find((n) => n.id === 'switch').data.branches[1].key = 'urgent';
    expect(validateWorkflowDefinition(dupKeys, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/duplicate branch key/i);

    const badHandle = branchDefinition();
    badHandle.edges[1].sourceHandle = 'nope';
    expect(validateWorkflowDefinition(badHandle, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/unknown branch/i);
  });

  test('delay bounds are validated', () => {
    const def = branchDefinition();
    def.nodes.push({ id: 'wait', type: 'delay', data: { minutes: 0 } });
    def.edges = def.edges.map((e) => (e.id === 'e4' ? { ...e, target: 'wait' } : e));
    def.edges.push({ id: 'e6', source: 'wait', target: 'end-a' });
    expect(validateWorkflowDefinition(def, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/between 1 minute and 7 days/i);
  });
});

describe('branch node routing', () => {
  test('first matching branch wins', async () => {
    const result = await engine.executePreview({
      workflow: { id: 20, workspaceId: 1, triggerType: 'ticket.created', draftDefinition: branchDefinition(), publishedVersion: 0, versions: [] },
      definition: branchDefinition(),
      eventContext: eventContext(), // Urgent → 'urgent' branch
      executeLlm: false,
    });
    expect(result.status).toBe('completed');
    const branchStep = result.steps.find((s) => s.nodeType === 'branch');
    expect(branchStep.output.matchedBranch).toBe('urgent');
    // The urgent path's update node ran; the otherwise path's did not.
    expect(result.steps.some((s) => s.nodeId === 'bump')).toBe(true);
    expect(result.steps.some((s) => s.nodeId === 'calm')).toBe(false);
  });

  test('no match routes to otherwise', async () => {
    const ctx = eventContext();
    ctx.ticket.priorityLabel = 'Low';
    const result = await engine.executePreview({
      workflow: { id: 21, workspaceId: 1, triggerType: 'ticket.created', draftDefinition: branchDefinition(), publishedVersion: 0, versions: [] },
      definition: branchDefinition(),
      eventContext: ctx,
      executeLlm: false,
    });
    const branchStep = result.steps.find((s) => s.nodeType === 'branch');
    expect(branchStep.output.matchedBranch).toBe('otherwise');
    expect(result.steps.some((s) => s.nodeId === 'calm')).toBe(true);
  });
});

describe('delay node — park and durable resume', () => {
  function delayDefinition() {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'wait', type: 'delay', data: { minutes: 30 } },
        { id: 'bump', type: 'update_ticket', data: { setPriority: 4 } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'bump' },
        { id: 'e3', source: 'bump', target: 'end' },
      ],
    };
  }

  test('live runs park at the delay with resume metadata instead of blocking', async () => {
    const workflow = { id: 30, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 3, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: delayDefinition(),
      eventContext: eventContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('waiting');
    expect(result.resumeAt).toBeTruthy();
    const parkUpdate = prismaMock.notificationWorkflowRun.update.mock.calls
      .map((c) => c[0])
      .find((c) => c.data?.status === 'waiting');
    expect(parkUpdate).toBeTruthy();
    expect(parkUpdate.data.resumeNodeId).toBe('bump');
    expect(parkUpdate.data.resumeAt).toBeInstanceOf(Date);
    // The downstream update node did NOT run.
    expect(result.steps.some((s) => s.nodeId === 'bump')).toBe(false);
  });

  test('previews skip the wait and continue', async () => {
    const result = await engine.executePreview({
      workflow: { id: 31, workspaceId: 1, triggerType: 'ticket.created', draftDefinition: delayDefinition(), publishedVersion: 0, versions: [] },
      definition: delayDefinition(),
      eventContext: eventContext(),
      executeLlm: false,
    });
    expect(result.status).toBe('completed');
    const delayStep = result.steps.find((s) => s.nodeType === 'delay');
    expect(delayStep.output.wouldWaitMinutes).toBe(30);
    expect(result.steps.some((s) => s.nodeId === 'bump')).toBe(true);
  });

  test('resumeWaitingRuns continues a due run from its saved node, pinned to its version', async () => {
    const parkedRun = {
      id: 901,
      workflowId: 30,
      workflowVersionId: 55,
      workspaceId: 1,
      eventContext: eventContext(),
      dryRun: false,
      executionMode: 'live',
      triggerSource: 'test',
      status: 'waiting',
      resumeAt: new Date(Date.now() - 60000),
      resumeNodeId: 'bump',
      resumeState: { state: {} },
    };
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValue([parkedRun]);
    prismaMock.notificationWorkflow.findUnique.mockResolvedValue({
      id: 30, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 4,
      publishedDefinition: delayDefinition(), versions: [],
    });
    // Pinned version differs from current published — must win.
    prismaMock.notificationWorkflowVersion.findUnique.mockResolvedValue({ id: 55, version: 3, definition: delayDefinition() });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 100, workspaceId: 1, origin: 'ticketpulse', status: 'Open', priority: 3, createdAt: new Date() });

    const summary = await resumeWaitingRuns();

    expect(summary).toEqual({ due: 1, resumed: 1 });
    expect(prismaMock.notificationWorkflowVersion.findUnique).toHaveBeenCalledWith({ where: { id: 55 } });
    // Run was flipped back to running with resume fields cleared…
    const resumeFlip = prismaMock.notificationWorkflowRun.update.mock.calls
      .map((c) => c[0])
      .find((c) => c.data?.status === 'running' && c.where.id === 901);
    expect(resumeFlip).toBeTruthy();
    // …and the downstream update_ticket actually executed (priority bumped).
    const completed = prismaMock.notificationWorkflowRun.update.mock.calls
      .map((c) => c[0])
      .find((c) => c.data?.status === 'completed' && c.where.id === 901);
    expect(completed).toBeTruthy();
  });
});

describe('propose_reply node (draft-to-approve)', () => {
  function proposeDefinition() {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'draft', type: 'llm_generate', data: { prompt: 'draft', promoteToEmail: false } },
        { id: 'propose', type: 'propose_reply', data: {} },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'draft' },
        { id: 'e2', source: 'draft', target: 'propose' },
        { id: 'e3', source: 'propose', target: 'end' },
      ],
    };
  }

  test('the graph validates (propose_reply is an action; needs upstream LLM)', () => {
    expect(validateWorkflowDefinition(proposeDefinition(), { triggerType: 'ticket.created' }).errors).toEqual([]);

    const noLlm = proposeDefinition();
    noLlm.nodes = noLlm.nodes.filter((n) => n.id !== 'draft');
    noLlm.edges = [
      { id: 'e1', source: 'trigger', target: 'propose' },
      { id: 'e3', source: 'propose', target: 'end' },
    ];
    expect(validateWorkflowDefinition(noLlm, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/upstream LLM/i);
  });

  test('live execution stages the LLM draft as a proposal', async () => {
    const workflow = { id: 40, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    // Resume mid-graph at the propose node with a saved LLM state, exactly as
    // a real run carries it.
    const result = await executeDefinition({
      workflow,
      definition: proposeDefinition(),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 950 },
        state: { llm: { email: { subject: 'Re: VPN', html: '<p>Try this</p>', text: 'Try this', extra: { confidence: 'medium' } } } },
        startNodeIds: ['propose'],
      },
    });

    expect(result.status).toBe('completed');
    expect(proposedReplyCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1,
      ticketId: 100,
      subject: 'Re: VPN',
      bodyHtml: '<p>Try this</p>',
      confidence: 'medium',
      source: 'workflow_llm',
    }));
  });
});

describe('auto-send safety gates on send_email', () => {
  function sendDefinition(sendData = {}) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'] } },
        { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'S', html: '<p>B</p>', text: 'B' } },
        { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, ...sendData } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'recipients' },
        { id: 'e2', source: 'recipients', target: 'template' },
        { id: 'e3', source: 'template', target: 'send' },
      ],
    };
  }

  test('low LLM confidence downgrades the send to a staged proposal', async () => {
    const workflow = { id: 41, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: sendDefinition({ minLlmConfidence: 'high' }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 951 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          email: { subject: 'S', html: '<p>llm body</p>', text: 'llm body' },
          llm: { promotedToEmail: true, email: { extra: { confidence: 'low' } } },
        },
        startNodeIds: ['send'],
      },
    });

    expect(result.status).toBe('completed');
    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBe(true);
    expect(proposedReplyCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'auto_send_downgrade',
      confidence: 'low',
    }));
  });

  test('always-human requester match downgrades regardless of confidence', async () => {
    const workflow = { id: 42, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: sendDefinition({ alwaysHumanRecipients: ['@example.com'] }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 952 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          email: { subject: 'S', html: '<p>llm body</p>', text: 'llm body' },
          llm: { promotedToEmail: true, email: { extra: { confidence: 'high' } } },
        },
        startNodeIds: ['send'],
      },
    });

    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBe(true);
    expect(sendStep.output.reason).toMatch(/always-human/i);
  });

  test('plain template sends (no LLM content) are never gated', async () => {
    const workflow = { id: 43, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: sendDefinition({ minLlmConfidence: 'high', alwaysHumanRecipients: ['@example.com'] }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 953 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          email: { subject: 'S', html: '<p>template body</p>', text: 'template body' },
          // No promotedToEmail — the content came from the template.
        },
        startNodeIds: ['send'],
      },
    });

    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBeUndefined();
    expect(proposedReplyCreateMock).not.toHaveBeenCalled();
  });
});

describe('installable workflow templates', () => {
  test('every template builds a definition that validates for its trigger type', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const template of WORKFLOW_TEMPLATES) {
      const definition = template.build();
      const result = validateWorkflowDefinition(definition, { triggerType: template.triggerType });
      expect({ key: template.key, errors: result.errors }).toEqual({ key: template.key, errors: [] });
    }
  });
});
