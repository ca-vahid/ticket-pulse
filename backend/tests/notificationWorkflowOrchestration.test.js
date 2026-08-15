import { jest } from '@jest/globals';

/**
 * Phase 3 orchestration: branch (N-way switch) routing, delay park + durable
 * resume, and the graph-validation rules for the new node types.
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
  // FR 08-05 Phase 1b: typed custom-field conditions + category-by-name.
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
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
const {
  default: engine,
  executeDefinition,
  resumeWaitingRuns,
  invalidateCustomFieldConditionTypesCache,
} = await import('../src/services/notificationWorkflowEngine.js');

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
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findFirst.mockResolvedValue(null);
  invalidateCustomFieldConditionTypesCache();
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

  test('the graph validates (propose_reply is an action; needs an upstream draft source)', () => {
    expect(validateWorkflowDefinition(proposeDefinition(), { triggerType: 'ticket.created' }).errors).toEqual([]);

    // A rendered template is an equally valid draft source (QA 07-07 #5).
    const templated = proposeDefinition();
    templated.nodes = templated.nodes.map((n) => (
      n.id === 'draft' ? { id: 'draft', type: 'template_render', data: { subject: 'Hi', html: '<p>Hi</p>' } } : n
    ));
    expect(validateWorkflowDefinition(templated, { triggerType: 'ticket.created' }).errors).toEqual([]);

    const noSource = proposeDefinition();
    noSource.nodes = noSource.nodes.filter((n) => n.id !== 'draft');
    noSource.edges = [
      { id: 'e1', source: 'trigger', target: 'propose' },
      { id: 'e3', source: 'propose', target: 'end' },
    ];
    expect(validateWorkflowDefinition(noSource, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/upstream draft source/i);
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

  test('with no LLM draft, a rendered template stages instead (workflow_template)', async () => {
    const workflow = { id: 41, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: proposeDefinition(),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 951 },
        state: { email: { subject: 'Welcome', html: '<p>Templated reply</p>', text: 'Templated reply' } },
        startNodeIds: ['propose'],
      },
    });

    expect(result.status).toBe('completed');
    expect(proposedReplyCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 100,
      subject: 'Welcome',
      bodyHtml: '<p>Templated reply</p>',
      confidence: null,
      source: 'workflow_template',
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

describe('content addressing (pin a producer\'s output)', () => {
  // Outputs as recordLlmOutput / recordNodeOutput store them.
  const llmOutput = (nodeId, body, confidence) => ({
    nodeId,
    nodeType: 'llm_generate',
    llm: { email: { extra: { confidence } }, confidence },
    email: { subject: `Draft ${nodeId}`, html: `<p>${body}</p>`, text: body },
  });
  const templateOutput = (nodeId, body) => ({
    nodeId,
    nodeType: 'template_render',
    email: { subject: `Tmpl ${nodeId}`, html: `<p>${body}</p>`, text: body },
  });

  function addressedSendDefinition(sendData = {}) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'] } },
        { id: 'draft_a', type: 'llm_generate', data: { prompt: 'a', promoteToEmail: false } },
        { id: 'draft_b', type: 'llm_generate', data: { prompt: 'b', promoteToEmail: false } },
        { id: 'tmpl', type: 'template_render', data: { contentSource: 'template_only', subject: 'S', html: '<p>T</p>', text: 'T' } },
        { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, ...sendData } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'recipients' },
        { id: 'e2', source: 'recipients', target: 'draft_a' },
        { id: 'e3', source: 'draft_a', target: 'draft_b' },
        { id: 'e4', source: 'draft_b', target: 'tmpl' },
        { id: 'e5', source: 'tmpl', target: 'send' },
      ],
    };
  }

  test('two LLM drafts: the send uses the PINNED one, and its confidence drives the gate', async () => {
    const workflow = { id: 60, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: addressedSendDefinition({ contentFrom: 'draft_a', minLlmConfidence: 'high' }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 960 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          outputs: {
            draft_a: llmOutput('draft_a', 'first draft', 'high'),
            draft_b: llmOutput('draft_b', 'second draft', 'low'),
          },
          // Shared slots reflect the LAST writer (draft_b) — the pin must win.
          llm: { promotedToEmail: false, email: { extra: { confidence: 'low' } } },
          email: { subject: 'S', html: '<p>T</p>', text: 'T' },
        },
        startNodeIds: ['send'],
      },
    });

    expect(result.status).toBe('completed');
    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBeUndefined();
    expect(sendStep.output.htmlBody).toContain('first draft');
    expect(sendStep.output.contentFrom).toBe('draft_a');
    expect(sendStep.output.contentKind).toBe('llm');
  });

  test('a pinned LOW-confidence draft still downgrades under the gate', async () => {
    const workflow = { id: 61, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: addressedSendDefinition({ contentFrom: 'draft_b', minLlmConfidence: 'high' }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 961 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          outputs: { draft_b: llmOutput('draft_b', 'second draft', 'low') },
          email: { subject: 'S', html: '<p>T</p>', text: 'T' },
        },
        startNodeIds: ['send'],
      },
    });

    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBe(true);
    expect(proposedReplyCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'auto_send_downgrade',
      bodyHtml: '<p>second draft</p>',
    }));
  });

  test('pinning a template output bypasses LLM gates even with a promoted low-confidence draft around', async () => {
    const workflow = { id: 62, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: addressedSendDefinition({ contentFrom: 'tmpl', minLlmConfidence: 'high' }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 962 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          outputs: { tmpl: templateOutput('tmpl', 'templated body') },
          llm: { promotedToEmail: true, email: { extra: { confidence: 'low' } } },
          email: { subject: 'S', html: '<p>llm body</p>', text: 'llm body' },
        },
        startNodeIds: ['send'],
      },
    });

    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.downgradedToProposal).toBeUndefined();
    expect(sendStep.output.htmlBody).toContain('templated body');
    expect(sendStep.output.contentKind).toBe('template');
  });

  test('a pinned source that never produced anything skips with a named reason', async () => {
    const workflow = { id: 63, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: addressedSendDefinition({ contentFrom: 'draft_a' }),
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 963 },
        state: {
          recipients: { to: ['rita@example.com'], cc: [], bcc: [] },
          email: { subject: 'S', html: '<p>T</p>', text: 'T' },
        },
        startNodeIds: ['send'],
      },
    });

    const sendStep = result.steps.find((s) => s.nodeId === 'send');
    expect(sendStep.output.skipped).toBe(true);
    expect(sendStep.output.reason).toContain('draft_a');
  });

  test('propose_reply pinned to a template output stages it as workflow_template', async () => {
    const definition = {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'draft', type: 'llm_generate', data: { prompt: 'x', promoteToEmail: false } },
        { id: 'tmpl', type: 'template_render', data: { contentSource: 'template_only', subject: 'T', html: '<p>T</p>' } },
        { id: 'propose', type: 'propose_reply', data: { contentFrom: 'tmpl' } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'draft' },
        { id: 'e2', source: 'draft', target: 'tmpl' },
        { id: 'e3', source: 'tmpl', target: 'propose' },
        { id: 'e4', source: 'propose', target: 'end' },
      ],
    };
    const workflow = { id: 64, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: eventContext(),
      executionMode: 'live',
      resume: {
        run: { id: 964 },
        state: {
          outputs: { tmpl: templateOutput('tmpl', 'canned answer') },
          // An LLM draft exists in the shared slot — the pin must ignore it.
          llm: { email: { subject: 'L', html: '<p>llm</p>', text: 'llm' }, confidence: 'high' },
        },
        startNodeIds: ['propose'],
      },
    });

    expect(result.status).toBe('completed');
    expect(proposedReplyCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'workflow_template',
      bodyHtml: '<p>canned answer</p>',
      confidence: null,
    }));
  });

  test('validation: contentFrom / llmFrom must reference an upstream producer', () => {
    const base = addressedSendDefinition();
    // Unknown node
    let definition = addressedSendDefinition({ contentFrom: 'ghost' });
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/no longer exists .*ghost/i);
    // Not a producer
    definition = addressedSendDefinition({ contentFrom: 'recipients' });
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/must point at an LLM generate or Template step/i);
    // Not upstream (self-forward reference: pin the send node's own id)
    definition = addressedSendDefinition({ contentFrom: 'send' });
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors.length).toBeGreaterThan(0);
    // Valid pins pass
    definition = addressedSendDefinition({ contentFrom: 'draft_a' });
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);
    // llmFrom on the template must target an llm_generate
    definition = addressedSendDefinition();
    definition.nodes = definition.nodes.map((n) => (n.id === 'tmpl'
      ? { ...n, data: { ...n.data, llmFrom: 'recipients' } }
      : n));
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/must point at an LLM generate step/i);
    definition.nodes = definition.nodes.map((n) => (n.id === 'tmpl'
      ? { ...n, data: { ...n.data, llmFrom: 'draft_b' } }
      : n));
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);
    expect(base).toBeTruthy();
  });
});

describe('run_workflow sub-workflow node', () => {
  const childDefinition = {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      { id: 'bump', type: 'update_ticket', data: { setPriority: 4 } },
      { id: 'end', type: 'stop', data: {} },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bump' },
      { id: 'e2', source: 'bump', target: 'end' },
    ],
  };
  const parentDefinition = {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      { id: 'sub', type: 'run_workflow', data: { workflowId: 61 } },
      // run_workflow isn't in the action list requirement? it is not — include an action.
      { id: 'note', type: 'update_ticket', data: { setPriority: 3 } },
      { id: 'end', type: 'stop', data: {} },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'sub' },
      { id: 'e2', source: 'sub', target: 'note' },
      { id: 'e3', source: 'note', target: 'end' },
    ],
  };

  test('validation requires a referenced workflow', () => {
    const bad = JSON.parse(JSON.stringify(parentDefinition));
    bad.nodes.find((n) => n.id === 'sub').data = {};
    expect(validateWorkflowDefinition(bad, { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/must reference a workflow/i);
  });

  test('live execution runs the child inline and blocks further nesting', async () => {
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue({
      id: 61, workspaceId: 1, triggerType: 'ticket.created',
      publishedVersion: 2, publishedDefinition: childDefinition,
      mockModeEnabled: false, versions: [],
    });
    prismaMock.ticket.findUnique.mockResolvedValue({
      id: 100, workspaceId: 1, origin: 'ticketpulse', status: 'Open', priority: 2, createdAt: new Date(),
    });

    const workflow = { id: 60, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };
    const result = await executeDefinition({
      workflow,
      definition: parentDefinition,
      eventContext: eventContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const subStep = result.steps.find((s) => s.nodeId === 'sub');
    expect(subStep.output.ranWorkflowId).toBe(61);
    // The child's update_ticket really executed (priority bumped to 4).
    const childUpdate = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.priority === 4);
    expect(childUpdate).toBeTruthy();

    // Depth guard: an event context already inside a sub-workflow is refused.
    const nested = await executeDefinition({
      workflow,
      definition: parentDefinition,
      eventContext: { ...eventContext(), event: { ...eventContext().event, subWorkflowDepth: 1 } },
      executionMode: 'live',
    });
    const nestedStep = nested.steps.find((s) => s.nodeId === 'sub');
    expect(nestedStep.output.skipped).toBe(true);
    expect(nestedStep.output.reason).toMatch(/cannot nest/i);
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

// Phase 8c: workflows can match custom statuses by NAME (exact string) or by
// BASE (ticket.statusBase, enriched by the engine from the workspace status
// registry when the emitter didn't populate it).
describe('custom-status conditions (Phase 8c)', () => {
  const REGISTRY_ROWS = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
  ];

  function statusConditionDefinition(conditionGroup) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.status_changed' } },
        { id: 'check', type: 'condition', data: { conditionGroup } },
        { id: 'hit', type: 'update_ticket', data: { setPriority: 4 } },
        { id: 'end-hit', type: 'stop', data: {} },
        { id: 'end-miss', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'check' },
        { id: 'e2', source: 'check', sourceHandle: 'true', target: 'hit' },
        { id: 'e3', source: 'check', sourceHandle: 'false', target: 'end-miss' },
        { id: 'e4', source: 'hit', target: 'end-hit' },
      ],
    };
  }

  async function armRegistry() {
    prismaMock.ticketStatusDefinition = { findMany: jest.fn().mockResolvedValue(REGISTRY_ROWS) };
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();
  }

  async function disarmRegistry() {
    delete prismaMock.ticketStatusDefinition;
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();
  }

  afterEach(async () => disarmRegistry());

  function statusChangedContext(status) {
    return eventContext({
      event: {
        type: 'ticket.status_changed',
        source: 'test',
        occurredAt: '2026-08-05T10:00:00.000Z',
        dedupeStamp: `sc-${Math.random()}`,
        extra: { from: 'Open', to: status },
      },
      ticket: { id: 100, freshserviceTicketId: 225010, subject: 'VPN access problem', status, isNoise: false },
    });
  }

  test('a custom status name matches with a base-insensitive exact string', async () => {
    await armRegistry();
    const definition = statusConditionDefinition({
      logic: 'all',
      conditions: [{ field: 'ticket.status', operator: 'is', value: 'Needs Rework' }],
    });
    const result = await engine.executePreview({
      workflow: { id: 30, workspaceId: 1, triggerType: 'ticket.status_changed', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: statusChangedContext('Needs Rework'),
      executeLlm: false,
    });
    const conditionStep = result.steps.find((s) => s.nodeType === 'condition');
    expect(conditionStep.output.passed).toBe(true);
    expect(result.steps.some((s) => s.nodeId === 'hit')).toBe(true);
  });

  test('ticket.statusBase matches "any Pending-base status" via the engine enrichment', async () => {
    await armRegistry();
    const definition = statusConditionDefinition({
      logic: 'all',
      conditions: [{ field: 'ticket.statusBase', operator: 'is', value: 'Pending' }],
    });
    // The context does NOT carry statusBase — executeDefinition resolves it
    // from the registry ("Needs Rework" → Pending).
    const result = await engine.executePreview({
      workflow: { id: 31, workspaceId: 1, triggerType: 'ticket.status_changed', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: statusChangedContext('Needs Rework'),
      executeLlm: false,
    });
    const conditionStep = result.steps.find((s) => s.nodeType === 'condition');
    expect(conditionStep.output.passed).toBe(true);
  });

  test('statusBase does not match a different base (custom Pending is not Open)', async () => {
    await armRegistry();
    const definition = statusConditionDefinition({
      logic: 'all',
      conditions: [{ field: 'ticket.statusBase', operator: 'is', value: 'Open' }],
    });
    const result = await engine.executePreview({
      workflow: { id: 32, workspaceId: 1, triggerType: 'ticket.status_changed', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: statusChangedContext('Needs Rework'),
      executeLlm: false,
    });
    const conditionStep = result.steps.find((s) => s.nodeType === 'condition');
    expect(conditionStep.output.passed).toBe(false);
    expect(result.steps.some((s) => s.nodeId === 'hit')).toBe(false);
  });

  test('the notify_on_custom_status template targets status_changed with an editable status condition', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'notify_on_custom_status');
    expect(template).toBeDefined();
    expect(template.triggerType).toBe('ticket.status_changed');
    const definition = template.build();
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.status_changed' }).errors).toEqual([]);
    const condition = definition.nodes.find((n) => n.type === 'condition');
    expect(condition.data.conditionGroup.conditions[0]).toEqual({ field: 'ticket.status', operator: 'is', value: 'Needs Rework' });
    const recipients = definition.nodes.find((n) => n.type === 'recipient_resolver');
    expect(recipients.data.to).toEqual(['assigned_agent', 'requester']);
  });
});

// FR 08-05 Phase 1b: API intake enrichment wired into automation — typed
// custom-field conditions evaluate through the engine, and update_ticket can
// set the category BY NAME (resolved against the workspace taxonomy at run
// time), which is what makes QA's sourceRequestType→category mapping
// self-service.
describe('API intake routing (FR 08-05 Phase 1b)', () => {
  const TAXONOMY = [
    { id: 11, workspaceId: 1, name: 'Project Setup', parentId: null, isActive: true },
    { id: 12, workspaceId: 1, name: 'Accounting', parentId: null, isActive: true },
    { id: 21, workspaceId: 1, name: 'New Project', parentId: 11, isActive: true },
  ];

  function intakeDefinition(updateData) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        {
          id: 'match',
          type: 'condition',
          data: {
            conditionGroup: {
              logic: 'all',
              conditions: [{ field: 'custom:source_request_type', operator: 'is', value: 'Project Setup' }],
            },
          },
        },
        { id: 'route', type: 'update_ticket', data: updateData },
        { id: 'end-hit', type: 'stop', data: {} },
        { id: 'end-miss', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'match' },
        { id: 'e2', source: 'match', sourceHandle: 'true', target: 'route' },
        { id: 'e3', source: 'match', sourceHandle: 'false', target: 'end-miss' },
        { id: 'e4', source: 'route', target: 'end-hit' },
      ],
    };
  }

  function intakeContext(value = 'Project Setup') {
    return eventContext({
      ticket: {
        id: 100,
        workspaceId: 1,
        subject: 'Project Setup - Coyote Landslide',
        status: 'Open',
        isNoise: false,
        customFields: { source_request_type: value },
      },
    });
  }

  beforeEach(() => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([{ key: 'source_request_type', type: 'text' }]);
    prismaMock.competencyCategory.findMany.mockResolvedValue(TAXONOMY);
    prismaMock.competencyCategory.findFirst.mockImplementation(({ where }) => Promise.resolve(
      TAXONOMY.find((c) => c.id === where.id
        && (where.parentId === null ? c.parentId === null : c.parentId === where.parentId)) || null,
    ));
    prismaMock.ticket.findUnique.mockResolvedValue({
      id: 100,
      workspaceId: 1,
      origin: 'ticketpulse',
      status: 'Open',
      priority: 2,
      internalCategoryId: null,
      internalSubcategoryId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    });
  });

  test('end-to-end: intake custom field matches → category (and child subcategory) set by name', async () => {
    const result = await executeDefinition({
      workflow: { id: 70, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] },
      definition: intakeDefinition({ setCategoryName: 'project setup', setSubcategoryName: 'new project' }),
      eventContext: intakeContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const conditionStep = result.steps.find((s) => s.nodeType === 'condition');
    expect(conditionStep.output.passed).toBe(true);

    const updateStep = result.steps.find((s) => s.nodeId === 'route');
    // Case-insensitive resolution returns the canonical names.
    expect(updateStep.output.resolvedCategory).toEqual(expect.objectContaining({
      categoryId: 11,
      subcategoryId: 21,
      categoryName: 'Project Setup',
      subcategoryName: 'New Project',
    }));
    expect(updateStep.output.updated.internalCategoryId).toEqual({ from: null, to: 11 });

    const patchCall = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.internalCategoryId === 11);
    expect(patchCall).toBeTruthy();
    expect(patchCall[0].data.internalSubcategoryId).toBe(21);
  });

  test('non-matching intake value takes the false path — no category write', async () => {
    const result = await executeDefinition({
      workflow: { id: 71, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] },
      definition: intakeDefinition({ setCategoryName: 'Project Setup' }),
      eventContext: intakeContext('Invoice Question'),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some((s) => s.nodeId === 'route')).toBe(false);
    expect(result.steps.some((s) => s.nodeId === 'end-miss')).toBe(true);
    expect(prismaMock.ticket.update.mock.calls.some((c) => c[0].data?.internalCategoryId)).toBe(false);
  });

  test('a bad category name surfaces as a run error (categoryError), never a crash', async () => {
    const result = await executeDefinition({
      workflow: { id: 72, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] },
      definition: intakeDefinition({ setCategoryName: 'No Such Category' }),
      eventContext: intakeContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const updateStep = result.steps.find((s) => s.nodeId === 'route');
    expect(updateStep.output.categoryError).toMatch(/unknown category/i);
    expect(updateStep.output.categoryError).toMatch(/Project Setup/); // lists the allowed values
    expect(prismaMock.ticket.update.mock.calls.some((c) => c[0].data?.internalCategoryId)).toBe(false);
  });

  test('typed numeric custom-field conditions coerce through the engine', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([{ key: 'budget', type: 'number' }]);
    invalidateCustomFieldConditionTypesCache();
    const definition = intakeDefinition({ setPriority: 4 });
    definition.nodes.find((n) => n.id === 'match').data.conditionGroup = {
      logic: 'all',
      conditions: [{ field: 'custom:budget', operator: 'gt', value: 1000 }],
    };
    const contextFor = (budget) => eventContext({
      ticket: { id: 100, workspaceId: 1, subject: 'Budget check', status: 'Open', isNoise: false, customFields: { budget } },
    });

    const hit = await engine.executePreview({
      workflow: { id: 73, workspaceId: 1, triggerType: 'ticket.created', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: contextFor('1500'), // string on the ticket, number in the rule
      executeLlm: false,
    });
    expect(hit.steps.find((s) => s.nodeType === 'condition').output.passed).toBe(true);

    invalidateCustomFieldConditionTypesCache();
    const miss = await engine.executePreview({
      workflow: { id: 74, workspaceId: 1, triggerType: 'ticket.created', draftDefinition: definition, publishedVersion: 0, versions: [] },
      definition,
      eventContext: contextFor('500'),
      executeLlm: false,
    });
    expect(miss.steps.find((s) => s.nodeType === 'condition').output.passed).toBe(false);
  });

  test('the api_intake_router template wires condition → category-by-name → assignee notify', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'api_intake_router');
    expect(template).toBeDefined();
    expect(template.triggerType).toBe('ticket.created');
    const definition = template.build();
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);
    const condition = definition.nodes.find((n) => n.type === 'condition');
    expect(condition.data.conditionGroup.conditions[0]).toEqual({
      field: 'custom:source_request_type', operator: 'is', value: 'Project Setup',
    });
    const update = definition.nodes.find((n) => n.type === 'update_ticket');
    expect(update.data.setCategoryName).toBe('Project Setup');
    const recipients = definition.nodes.find((n) => n.type === 'recipient_resolver');
    expect(recipients.data.to).toEqual(['assigned_agent']);
  });
});

// FR 08-07 #3: subcategory routing sharp edges. The subcategory resolves
// against the EFFECTIVE parent (explicit setCategoryName/ID, else the ticket's
// CURRENT category), applies even when the category is unchanged, and
// subcategory-only nodes count as configured.
describe('update_ticket subcategory matrix (FR 08-07 #3)', () => {
  const TAXONOMY = [
    { id: 11, workspaceId: 1, name: 'Project Setup', parentId: null, isActive: true },
    { id: 12, workspaceId: 1, name: 'Accounting', parentId: null, isActive: true },
    { id: 21, workspaceId: 1, name: 'Quebec', parentId: 11, isActive: true },
    { id: 22, workspaceId: 1, name: 'Chile', parentId: 11, isActive: true },
    { id: 23, workspaceId: 1, name: 'Other', parentId: 11, isActive: true },
  ];

  function updateDefinition(updateData) {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'route', type: 'update_ticket', data: updateData },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'route' },
        { id: 'e2', source: 'route', target: 'end' },
      ],
    };
  }

  function armTaxonomy() {
    prismaMock.competencyCategory.findMany.mockResolvedValue(TAXONOMY);
    prismaMock.competencyCategory.findFirst.mockImplementation(({ where }) => {
      if (where.id !== undefined) {
        return Promise.resolve(TAXONOMY.find((c) => c.id === where.id
          && (where.parentId === null ? c.parentId === null
            : where.parentId === undefined ? true : c.parentId === where.parentId)) || null);
      }
      if (where.name?.equals !== undefined) {
        const target = String(where.name.equals).trim().toLowerCase();
        return Promise.resolve(TAXONOMY.find((c) => c.parentId === where.parentId
          && c.name.trim().toLowerCase() === target) || null);
      }
      return Promise.resolve(null);
    });
  }

  function armTicket(over = {}) {
    prismaMock.ticket.findUnique.mockResolvedValue({
      id: 100,
      workspaceId: 1,
      origin: 'ticketpulse',
      status: 'Open',
      priority: 2,
      internalCategoryId: 11,
      internalSubcategoryId: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      ...over,
    });
  }

  async function run(updateData, { workflowId = 80 } = {}) {
    const result = await executeDefinition({
      workflow: { id: workflowId, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] },
      definition: updateDefinition(updateData),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    return { result, step: result.steps.find((s) => s.nodeId === 'route') };
  }

  beforeEach(() => armTaxonomy());

  test('subcategory-ONLY node counts as configured and applies under the ticket current category', async () => {
    armTicket(); // category 11, no sub
    const { result, step } = await run({ setSubcategoryName: 'quebec' });

    expect(result.status).toBe('completed');
    expect(step.output.skipped).toBeUndefined();
    expect(step.output.categoryError).toBeUndefined();
    expect(step.output.updated.internalSubcategoryId).toEqual({ from: null, to: 21 });
    expect(step.output.updated.internalCategoryId).toBeUndefined();

    const patch = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.internalSubcategoryId === 21);
    expect(patch).toBeTruthy();
    expect(patch[0].data.internalCategoryId).toBeUndefined(); // category untouched
  });

  test('subcategory-only on an UNCATEGORIZED ticket errors into the step output, never crashes', async () => {
    armTicket({ internalCategoryId: null });
    const { result, step } = await run({ setSubcategoryName: 'Quebec' });

    expect(result.status).toBe('completed');
    expect(step.output.categoryError).toMatch(/has no category/i);
    expect(prismaMock.ticket.update.mock.calls.some((c) => c[0].data?.internalSubcategoryId)).toBe(false);
  });

  test('subcategory applies even when the explicit category is UNCHANGED (was the short-circuit bug)', async () => {
    armTicket(); // already category 11
    const { step } = await run({ setCategoryName: 'Project Setup', setSubcategoryName: 'Chile' });

    expect(step.output.updated.internalSubcategoryId).toEqual({ from: null, to: 22 });
    expect(step.output.updated.internalCategoryId).toBeUndefined();
    const patch = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.internalSubcategoryId === 22);
    expect(patch).toBeTruthy();
    expect(patch[0].data.internalCategoryId).toBeUndefined();
  });

  test('changing the category WITHOUT a subcategory still nulls the old sub (existing behavior)', async () => {
    armTicket({ internalCategoryId: 12, internalSubcategoryId: null });
    const { step } = await run({ setCategoryName: 'Project Setup' });

    expect(step.output.updated.internalCategoryId).toEqual({ from: 12, to: 11 });
    const patch = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.internalCategoryId === 11);
    expect(patch[0].data.internalSubcategoryId).toBeNull();
  });

  test('an UNCHANGED category without a subcategory does NOT clear an existing sub', async () => {
    armTicket({ internalCategoryId: 11, internalSubcategoryId: 21 });
    const { step } = await run({ setCategoryName: 'Project Setup' });

    // No effective changes — and crucially no ticket.update nulling the sub.
    expect(step.output.skipped).toBe(true);
    expect(prismaMock.ticket.update.mock.calls.length).toBe(0);
  });

  test('an unknown subcategory name under the effective parent surfaces categoryError', async () => {
    armTicket();
    const { step } = await run({ setSubcategoryName: 'Atlantis' });
    expect(step.output.categoryError).toMatch(/unknown subcategory/i);
    expect(prismaMock.ticket.update.mock.calls.length).toBe(0);
  });

  test('the location_subcategory_router template: 3 branches on custom:client_location, subcategory-only updates, validates', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'location_subcategory_router');
    expect(template).toBeDefined();
    expect(template.triggerType).toBe('ticket.created');
    const definition = template.build();
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);

    const branch = definition.nodes.find((n) => n.type === 'branch');
    expect(branch.data.branches.map((b) => b.key)).toEqual(['quebec', 'chile']);
    expect(branch.data.branches[0].conditionGroup.conditions[0]).toEqual({
      field: 'custom:client_location', operator: 'contains', value: 'Quebec',
    });
    const updates = definition.nodes.filter((n) => n.type === 'update_ticket');
    expect(updates.map((n) => n.data.setSubcategoryName).sort()).toEqual(['Chile', 'Other', 'Quebec']);
    // No category set anywhere — the ticket's current category is the parent.
    expect(updates.every((n) => !n.data.setCategoryName && !n.data.setInternalCategoryId)).toBe(true);
    // Otherwise branch lands on the Other update node.
    const otherwiseEdge = definition.edges.find((e) => e.sourceHandle === 'otherwise');
    expect(definition.nodes.find((n) => n.id === otherwiseEdge.target).data.setSubcategoryName).toBe('Other');
  });

  test('template end-to-end: client_location "Santiago, Chile" → subcategory Chile under the current category', async () => {
    armTicket(); // category 11 (Project Setup), no sub
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([{ key: 'client_location', type: 'text' }]);
    invalidateCustomFieldConditionTypesCache();

    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'location_subcategory_router');
    const definition = template.build();
    const ctx = eventContext({
      ticket: {
        id: 100,
        workspaceId: 1,
        subject: 'New AP project',
        status: 'Open',
        isNoise: false,
        customFields: { client_location: 'Santiago, Chile' },
      },
    });

    const result = await executeDefinition({
      workflow: { id: 81, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] },
      definition,
      eventContext: ctx,
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const branchStep = result.steps.find((s) => s.nodeType === 'branch');
    expect(branchStep.output.matchedBranch).toBe('chile');
    expect(result.steps.some((s) => s.nodeId === 'set-chile')).toBe(true);
    expect(result.steps.some((s) => s.nodeId === 'set-quebec')).toBe(false);

    const chileStep = result.steps.find((s) => s.nodeId === 'set-chile');
    expect(chileStep.output.updated.internalSubcategoryId).toEqual({ from: null, to: 22 });
    const patch = prismaMock.ticket.update.mock.calls.find((c) => c[0].data?.internalSubcategoryId === 22);
    expect(patch).toBeTruthy();
    expect(patch[0].data.internalCategoryId).toBeUndefined();
  });
});

// Phase B (QA 08-11 #5 rider): the approval_requester recipient token resolves
// from event.extra.requestedBy so approval-event workflows can email the
// requesting agent. Unknown/absent extra resolves empty (no crash, no send).
describe('approval_requester recipient token', () => {
  function approvalRecipientDefinition() {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'approval.decided' } },
        { id: 'recipients', type: 'recipient_resolver', data: { to: ['approval_requester'] } },
        { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'Decided', html: '<p>Decided</p>', text: 'Decided' } },
        { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'recipients' },
        { id: 'e2', source: 'recipients', target: 'template' },
        { id: 'e3', source: 'template', target: 'send' },
      ],
    };
  }

  test('resolves the requester email from event.extra.requestedBy', async () => {
    const ctx = eventContext({
      event: {
        type: 'approval.decided', source: 'ticketpulse_native', occurredAt: '2026-08-15T10:00:00.000Z',
        dedupeStamp: `a-${Math.random()}`,
        extra: { approvalId: 7, status: 'approved', approverEmail: 'alice@x.io', requestedBy: 'req@x.io' },
      },
    });
    const result = await executeDefinition({
      workflow: { id: 90, workspaceId: 1, triggerType: 'approval.decided', publishedVersion: 1, versions: [] },
      definition: approvalRecipientDefinition(),
      eventContext: ctx,
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const step = result.steps.find((s) => s.nodeType === 'recipient_resolver');
    expect(step.output.recipients.to).toEqual(['req@x.io']);
  });

  test('resolves empty when the event carries no requestedBy', async () => {
    const result = await executeDefinition({
      workflow: { id: 91, workspaceId: 1, triggerType: 'approval.decided', publishedVersion: 1, versions: [] },
      definition: approvalRecipientDefinition(),
      eventContext: eventContext(), // ticket.created shape — no extra
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const step = result.steps.find((s) => s.nodeType === 'recipient_resolver');
    expect(step.output.recipients.to).toEqual([]);
  });
});
