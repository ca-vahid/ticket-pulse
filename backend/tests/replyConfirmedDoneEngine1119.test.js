import { jest } from '@jest/globals';

/**
 * "Resolve when the requester confirms it's done (waiting tickets)" —
 * 19 Nov 2026, the engine and the definition:
 *   - the condition step checks resolveConfirmedDone AFTER its conditions:
 *     Live takes the False path (source reply_confirmed_done), Shadow passes
 *     as before; both leave state.replyConfirmedDone; preview marks dryRun;
 *   - only on a waiting (Pending-base) ticket, only where the step passed;
 *   - the quiet path the Live resolve uses: no lifecycle event (so no
 *     "resolved" e-mail workflow runs), FS-born through updateFsTicket with
 *     notifyLifecycle off;
 *   - definition validation for the new field.
 * Invented names and example.com only.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findFirst: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn(), upsert: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
};
const activityCreateMock = jest.fn().mockResolvedValue({});
const updateFsTicketMock = jest.fn().mockResolvedValue({});
const fetchTicketSafeMock = jest.fn().mockResolvedValue({ status: 3 });
const BASES = { open: 'Open', pending: 'Pending', 'pending response': 'Pending', resolved: 'Resolved', closed: 'Closed' };
const statusServiceMock = {
  resolveBaseStatus: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  baseStatusOf: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  normalizeStatusName: jest.fn(async (_ws, s) => (BASES[String(s || '').toLowerCase()] ? s : null)),
  listStatuses: jest.fn(async () => []),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: statusServiceMock,
  BASE_STATUSES: ['Open', 'Pending', 'Resolved', 'Closed'],
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
  heuristicBaseStatus: (s) => s,
  invalidateStatusCache: jest.fn(),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreateMock } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}), getInteractiveClient: jest.fn().mockResolvedValue({ fetchTicketSafe: fetchTicketSafeMock }) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { updateFsTicket: updateFsTicketMock, _emitFieldsUpdated: jest.fn() } }));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({ default: { recordFailure: jest.fn().mockResolvedValue({}), recordSuccess: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  emitTicketEvent: jest.fn(), default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/autoCloseResolvedService.js', () => ({ default: { closedInsteadOfResolved: jest.fn(async (_ws, s) => s) } }));
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({ default: { openChildrenOf: jest.fn(async () => []) } }));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: { observeStatusTransition: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', () => ({ default: { settleOnChange: jest.fn(async () => ({})) } }));

const { buildDefaultWorkflowDefinition, validateWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { default: engine, executeUpdateTicketNode, explainSwitchStop } = await import('../src/services/notificationWorkflowEngine.js');
const { default: lifecycleMock } = await import('../src/services/ticketLifecycleNotificationService.js');
const { confirmedDoneMode, confirmedDoneSwitch, confirmedDoneEffect } = await import('../src/services/conditionRuleShared.js');

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 1000;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowRun.findMany.mockResolvedValue([]);
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
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ id: 100, ...data }));
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.requester.findUnique.mockResolvedValue(null);
});

const defWith = (mode) => {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  if (mode !== undefined) def.nodes.find((n) => n.id === 'is-resolved').data.resolveConfirmedDone = mode;
  return def;
};
const replyContext = (extra = {}, ticket = {}) => ({
  event: { type: 'ticket.reply_received', source: 'test', occurredAt: '2026-11-19T18:00:00.000Z', extra: { replyVerdict: 'reply', ...extra } },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, workspaceId: 1, subject: 'Monitor', status: 'Pending Response', statusBase: 'Pending', origin: 'ticketpulse', ...ticket },
  requester: { name: 'Priya Nair', email: 'priya.nair@example.com' },
  assignedAgent: null,
  previousAgent: null,
});
const preview = (definition, ctx) => engine.executePreview({
  workflow: { id: 9764, workspaceId: 1, triggerType: 'ticket.reply_received', draftDefinition: definition, publishedVersion: 0, versions: [] },
  definition,
  eventContext: ctx,
});
const conditionStep = (result) => result.steps.find((s) => s.nodeId === 'is-resolved');
const reopenStep = (result) => result.steps.find((s) => s.nodeType === 'update_ticket');

describe('the condition step (engine)', () => {
  test('Live: a confirmed-done reply on a waiting ticket takes the False path and says why; the run is marked (dry in preview)', async () => {
    const result = await preview(defWith('live'), replyContext({ replyConfirmedDone: true }));
    expect(conditionStep(result).output).toMatchObject({ passed: false, confirmedDone: 'live', explain: { source: 'reply_confirmed_done', verdict: 'confirmed_done' } });
    expect(conditionStep(result).output.explain.summary).toMatch(/requester confirmed it's done/);
    expect(reopenStep(result)).toBeUndefined();
    expect(result.state.replyConfirmedDone).toEqual({ mode: 'live', configured: 'live', nodeId: 'is-resolved', dryRun: true });
    expect(result.state.lastCondition).toMatchObject({ passed: false, source: 'reply_confirmed_done' });
  });

  test('Live stops the run at the step: nothing on the False branch runs (no e-mail), and the explanation says so', async () => {
    const def = defWith('live');
    // A workflow with work on its False branch: a note, then a stop.
    def.nodes = def.nodes.filter((n) => n.id !== 'skip');
    def.nodes.push({ id: 'tell', type: 'add_note', position: { x: 540, y: 150 }, data: { mode: 'text', bodyTemplate: 'Reply on {{ ticket.displayRef }}' } }, { id: 'skip', type: 'stop', position: { x: 800, y: 150 }, data: {} });
    def.edges = def.edges.map((e) => (e.id === 'e-false' ? { ...e, target: 'tell' } : e));
    def.edges.push({ id: 'e-tell', source: 'tell', target: 'skip' });
    expect(validateWorkflowDefinition(def, { triggerType: 'ticket.reply_received' }).errors).toEqual([]);
    const result = await preview(def, replyContext({ replyConfirmedDone: true }));
    expect(result.steps.map((s) => s.nodeId)).toEqual(['trigger', 'is-resolved']);
    expect(conditionStep(result).output).toMatchObject({ haltRun: true, explain: { runStopped: true } });
    expect(conditionStep(result).output.explain.summary).toMatch(/the run stops here, no further step runs/);
    // Not confirmed: the False branch runs as before.
    const plain = await preview(def, replyContext({}, { status: 'Open', statusBase: 'Open' }));
    expect(plain.steps.map((s) => s.nodeId)).toEqual(['trigger', 'is-resolved', 'tell', 'skip']);
  });

  test('Live on a FreshService-born ticket behaves as Shadow: passes, reopens, marked fsBorn', async () => {
    const result = await preview(defWith('live'), replyContext({ replyConfirmedDone: true }, { origin: 'freshservice' }));
    expect(conditionStep(result).output).toMatchObject({ passed: true, confirmedDone: 'shadow', confirmedDoneFsBorn: true });
    expect(conditionStep(result).output.haltRun).toBeUndefined();
    expect(reopenStep(result).output.wouldSet.status).toBe('Open');
    expect(result.state.replyConfirmedDone).toMatchObject({ mode: 'shadow', configured: 'live', fsBorn: true });
  });

  test('Live in a resumed run (after a wait) behaves as Shadow: passes and reopens', async () => {
    const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');
    const result = await executeDefinition({
      workflow: { id: 9764, workspaceId: 1, triggerType: 'ticket.reply_received', publishedVersion: 1 },
      definition: defWith('live'),
      eventContext: replyContext({ replyConfirmedDone: true }),
      dryRun: true,
      executionMode: 'preview',
      resume: { run: { id: 900 }, state: {}, startNodeIds: ['is-resolved'] },
    });
    expect(conditionStep(result).output).toMatchObject({ passed: true, confirmedDone: 'shadow' });
    expect(result.state.replyConfirmedDone).toMatchObject({ mode: 'shadow', configured: 'live', resumed: true });
    expect(reopenStep(result).output.wouldSet.status).toBe('Open');
  });

  test('Shadow: the step passes and the reopen runs exactly as before; the run is marked', async () => {
    const result = await preview(defWith('shadow'), replyContext({ replyConfirmedDone: true }));
    expect(conditionStep(result).output).toMatchObject({ passed: true, confirmedDone: 'shadow' });
    expect(reopenStep(result).output).toMatchObject({ dryRun: true, wouldSet: { status: 'Open' } });
    expect(result.state.replyConfirmedDone).toMatchObject({ mode: 'shadow' });
  });

  test('Off (an old definition, or "off"): no mark, reopens', async () => {
    for (const mode of [undefined, 'off']) {
      const result = await preview(defWith(mode), replyContext({ replyConfirmedDone: true }));
      expect(conditionStep(result).output.passed).toBe(true);
      expect(conditionStep(result).output.confirmedDone).toBeUndefined();
      expect(result.state.replyConfirmedDone).toBeUndefined();
      expect(reopenStep(result).output.wouldSet.status).toBe('Open');
    }
  });

  test('not a confirmed-done reply, not waiting, or the conditions said no: nothing changes', async () => {
    const plain = await preview(defWith('live'), replyContext({}));
    expect(plain.state.replyConfirmedDone).toBeUndefined();
    expect(reopenStep(plain).output.wouldSet.status).toBe('Open');
    // A closed ticket keeps the thank-you rules: the switch never looks at it.
    const closed = await preview(defWith('live'), replyContext({ replyConfirmedDone: true }, { status: 'Closed', statusBase: 'Closed' }));
    expect(closed.state.replyConfirmedDone).toBeUndefined();
    // An open ticket is outside the step's status list: the False path, as before, and no mark.
    const open = await preview(defWith('live'), replyContext({ replyConfirmedDone: true }, { status: 'Open', statusBase: 'Open' }));
    expect(conditionStep(open).output.passed).toBe(false);
    expect(open.state.replyConfirmedDone).toBeUndefined();
  });

  test('the thank-you switch still comes first on its own verdicts', async () => {
    const result = await preview(defWith('live'), replyContext({ replyVerdict: 'auto_reply' }));
    expect(conditionStep(result).output.explain.source).toBe('reply_thanks');
    expect(explainSwitchStop('reply_confirmed_done')).toMatchObject({ source: 'reply_confirmed_done', confirmedDone: true });
  });

  test('the shared helpers: missing or unknown = off; only Pending-base tickets', () => {
    expect(confirmedDoneMode({})).toBe('off');
    expect(confirmedDoneMode({ resolveConfirmedDone: 'LIVE' })).toBe('off');
    expect(confirmedDoneMode({ resolveConfirmedDone: 'shadow' })).toBe('shadow');
    const scope = (statusBase, yes = true) => ({ ticket: { statusBase }, event: { extra: { replyConfirmedDone: yes } } });
    expect(confirmedDoneSwitch({ resolveConfirmedDone: 'live' }, scope('Pending'))).toBe('live');
    expect(confirmedDoneSwitch({ resolveConfirmedDone: 'live' }, scope('Resolved'))).toBeNull();
    expect(confirmedDoneSwitch({ resolveConfirmedDone: 'live' }, scope('Pending', false))).toBeNull();
    expect(confirmedDoneSwitch({ resolveConfirmedDone: 'off' }, scope('Pending'))).toBeNull();
    const tp = { ticket: { statusBase: 'Pending', origin: 'ticketpulse' }, event: { extra: { replyConfirmedDone: true } } };
    expect(confirmedDoneEffect({ resolveConfirmedDone: 'live' }, tp)).toEqual({ mode: 'live', configured: 'live' });
    expect(confirmedDoneEffect({ resolveConfirmedDone: 'live' }, tp, { resumed: true })).toEqual({ mode: 'shadow', configured: 'live', resumed: true });
    expect(confirmedDoneEffect({ resolveConfirmedDone: 'live' }, scope('Pending'))).toEqual({ mode: 'shadow', configured: 'live', fsBorn: true });
    expect(confirmedDoneEffect({ resolveConfirmedDone: 'shadow' }, tp)).toEqual({ mode: 'shadow', configured: 'shadow' });
  });
});

describe('the quiet path the Live resolve uses (executeUpdateTicketNode as Ticket Pulse)', () => {
  const NODE = { id: 'reply-confirmed-done', type: 'update_ticket', data: { setStatus: 'Resolved', note: 'Requester confirmed it\'s done' } };
  const CTX = { event: { type: 'ticket.reply_received' }, ticket: { id: 100, workspaceId: 1 }, workspace: { id: 1 } };
  const ACTOR = { name: 'Ticket Pulse', kind: 'system', source: 'requester_confirmed_done' };

  test('TP-born: Resolved written to the row, a status_changed history row by Ticket Pulse, and no lifecycle event (no "resolved" e-mail)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 100, workspaceId: 1, origin: 'ticketpulse', status: 'Pending Response', createdAt: new Date('2026-11-13T17:00:00Z'), resolvedByKind: null });
    const res = await executeUpdateTicketNode(NODE, CTX, { actor: ACTOR });
    expect(res.updated.status).toEqual({ from: 'Pending Response', to: 'Resolved' });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'Resolved', resolvedAt: expect.any(Date) }) }));
    expect(activityCreateMock).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'status_changed', performedBy: 'Ticket Pulse' }));
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
    expect(lifecycleMock.emitTicketLifecycleNotifications).not.toHaveBeenCalled();
  });

  test('FS-born: through updateFsTicket with notifyLifecycle off', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 100, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: BigInt(512300), status: 'Pending Response', createdAt: new Date() });
    const res = await executeUpdateTicketNode(NODE, CTX, { actor: ACTOR });
    expect(res.status).toMatchObject({ applied: true });
    expect(updateFsTicketMock).toHaveBeenCalledWith(100, 1, { status: 'Resolved' }, expect.objectContaining({ name: 'Ticket Pulse' }), { notifyLifecycle: false });
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
  });
});

describe('"Try it on a past reply" says what would happen', () => {
  test('Live: would resolve; Shadow: would reopen, and says what Live would do', async () => {
    const { previewOutcome } = await import('../src/services/replyPreviewService.js');
    const live = await preview(defWith('live'), replyContext({ replyConfirmedDone: true }));
    expect(previewOutcome({ steps: live.steps, state: live.state, asTerminal: false })).toEqual({
      outcome: 'resolve', why: 'Would resolve the ticket: the requester confirmed it\'s done. No e-mail to the requester.',
    });
    const shadow = await preview(defWith('shadow'), replyContext({ replyConfirmedDone: true }));
    expect(previewOutcome({ steps: shadow.steps, state: shadow.state, asTerminal: false })).toEqual({
      outcome: 'reopen', why: 'Would set the status to Open. Shadow: would have resolved, the requester confirmed it\'s done.',
    });
  });
});

describe('definition validation', () => {
  const errors = (def, triggerType = 'ticket.reply_received') => validateWorkflowDefinition(def, { triggerType }).errors;

  test('off / shadow / live and an old definition without the field are valid', () => {
    for (const mode of [undefined, null, 'off', 'shadow', 'live']) expect(errors(defWith(mode))).toEqual([]);
  });

  test('anything else is refused', () => {
    for (const mode of ['on', true, 'LIVE', 1]) {
      expect(errors(defWith(mode))).toEqual(['Condition node is-resolved: "Resolve when the requester confirms it\'s done" must be off, shadow or live']);
    }
  });

  test('Live is refused when a wait step runs before (or beside) the step; Shadow is not; a wait after it is fine', () => {
    const waitBefore = (mode) => {
      const def = defWith(mode);
      def.nodes.push({ id: 'wait', type: 'delay', position: { x: 120, y: 60 }, data: { minutes: 10 } });
      def.edges = def.edges.map((e) => (e.id === 'e-trigger' ? { ...e, target: 'wait' } : e));
      def.edges.push({ id: 'e-wait', source: 'wait', target: 'is-resolved' });
      return def;
    };
    expect(errors(waitBefore('live'))).toEqual(['Condition node is-resolved: "Resolve when the requester confirms it\'s done" can be Live only when no wait step runs before or beside it (wait); use Shadow, or move the wait after this step']);
    expect(errors(waitBefore('shadow'))).toEqual([]);
    const waitAfter = defWith('live');
    waitAfter.nodes.push({ id: 'wait', type: 'delay', position: { x: 400, y: 0 }, data: { minutes: 10 } });
    waitAfter.edges = waitAfter.edges.map((e) => (e.id === 'e-true' ? { ...e, target: 'wait' } : e));
    waitAfter.edges.push({ id: 'e-wait', source: 'wait', target: 'reopen' });
    expect(errors(waitAfter)).toEqual([]);
  });

  test('Shadow / Live only on the "Requester replied" trigger', () => {
    const onCreated = {
      version: 1, metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'check', type: 'condition', data: { conditionGroup: { logic: 'all', conditions: [] }, resolveConfirmedDone: 'shadow' } },
        { id: 'note', type: 'add_note', data: { bodyTemplate: 'Hello' } },
        { id: 'done', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'check' },
        { id: 'e2', source: 'check', target: 'note', sourceHandle: 'true' },
        { id: 'e3', source: 'check', target: 'done', sourceHandle: 'false' },
        { id: 'e4', source: 'note', target: 'done' },
      ],
    };
    expect(errors(onCreated, 'ticket.created')).toContain('Condition node check: "Resolve when the requester confirms it\'s done" only works on the "Requester replied" trigger');
    onCreated.nodes[1].data.resolveConfirmedDone = 'off';
    expect(errors(onCreated, 'ticket.created').some((e) => /confirms it's done/.test(e))).toBe(false);
  });
});
