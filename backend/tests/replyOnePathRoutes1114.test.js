import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * MEGA 11-14, Part A — contract §4 endpoints (lane a1), mounted at
 * /api/notification-workflows:
 *   GET  /reply-candidates?ticketId=   the ticket's last 10 incoming requester replies
 *   POST /test  + replyEntryId, asStatus  → data.replyPreview (preview only)
 *   GET  /reopen-check                 reopen workflows + the two warnings
 *   GET  /:id/reopen-upgrade           { available, changes }
 *   POST /:id/reopen-upgrade           the upgrade as the DRAFT (never published)
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const repositoryMock = {
  getWorkflow: jest.fn(), saveDraft: jest.fn(), publishWorkflow: jest.fn(), listEnabledForEvent: jest.fn(async () => []), listWorkflows: jest.fn(async () => []),
};
const engineMock = { executePreview: jest.fn() };
const followUpMock = { classifyReply: jest.fn(), classifyPostCloseReply: jest.fn() };
const BASES = { open: 'Open', pending: 'Pending', 'pending response': 'Pending', resolved: 'Resolved', closed: 'Closed' };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({ default: repositoryMock, listEnabledForEvent: repositoryMock.listEnabledForEvent }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: engineMock, finalizeWorkflowSendEmail: jest.fn(), sanitizeWorkflowAuditPayload: (v) => v,
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null), baseStatusOf: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null) },
  BASE_STATUSES: ['Open', 'Pending', 'Resolved', 'Closed'],
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
  heuristicBaseStatus: (s) => s,
  invalidateStatusCache: jest.fn(),
}));
jest.unstable_mockModule('../src/services/autoHelpFollowUpService.js', () => ({ default: followUpMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn() }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { getSendGridConfig: jest.fn(), get: jest.fn(async () => null), set: jest.fn() } }));
jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn((context) => context),
  getNotificationWorkflowSchedulePreview: jest.fn(),
  getNotificationWorkflowPolicy: jest.fn(),
  isOffHoursWorkflow: jest.fn(),
  selectWorkflowsForNotificationTiming: jest.fn((workflows) => ({ selected: workflows, suppressed: [], mode: 'standard', reason: null })),
  updateNotificationWorkflowPolicy: jest.fn(),
}));
jest.unstable_mockModule('../src/services/notificationContextEnrichmentService.js', () => ({ buildNotificationLlmContext: jest.fn(), summarizeNotificationLlmContext: jest.fn() }));
jest.unstable_mockModule('../src/services/notificationLlmToolPolicyService.js', () => ({
  getNotificationLlmToolPolicy: jest.fn(), notificationLlmToolCatalog: jest.fn(), normalizeNotificationLlmToolPolicy: jest.fn((p) => p), updateNotificationLlmToolPolicy: jest.fn(),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: routes } = await import('../src/routes/notificationWorkflow.routes.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const NOW = Date.now();
const TICKET = {
  id: 700, workspaceId: 1, subject: 'Laptop dock not charging', status: 'Open', priority: 2, origin: 'ticketpulse', nativeNumber: 1990,
  toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date(NOW - 9 * 86400e3), resolvedAt: new Date(NOW - 3 * 86400e3), closedAt: null,
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 55, name: 'Rita Example', email: 'rita@example.com' },
  assignedTech: null, internalCategory: null, internalSubcategory: null,
};
const entry = (id, minutesAgo, over = {}) => ({
  id, ticketId: 700, workspaceId: 1, eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false, source: 'email_inbound',
  actorEmail: 'rita@example.com', actorName: 'Rita Example', bodyText: `Reply number ${id} ` + 'x'.repeat(200), occurredAt: new Date(NOW - minutesAgo * 60000), rawPayload: null, ...over,
});
const workflowRow = (over = {}) => ({
  id: 9764, workspaceId: 1, name: 'Reopen on requester reply', triggerType: 'ticket.reply_received', isEnabled: true, archivedAt: null,
  routingMode: 'exclusive', publishedVersion: 2, publishedDefinition: buildDefaultWorkflowDefinition('ticket.reply_received'),
  draftDefinition: buildDefaultWorkflowDefinition('ticket.reply_received'), routingRule: null, ...over,
});
/** IT's reopen workflow before the upgrade: status rows + a leftover raw rule, no switches. */
function olderReopenDefinition({ extraRows = [], rule = true } = {}) {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  const data = def.nodes.find((n) => n.id === 'is-resolved').data;
  data.conditionGroup = { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed', 'Pending Response'] }, ...extraRows] };
  delete data.ignoreThanks;
  delete data.replyLoopGuard;
  if (rule) data.rule = { in: [{ var: 'ticket.status' }, ['Resolved', 'Closed', 'Pending Response']] };
  delete def.metadata.shapeVersion;
  return def;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 1; req.session = { user: { role: 'admin', email: 'admin@example.com', name: 'Alex Rivera' } }; next(); });
  app.use('/api/notification-workflows', routes);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1, (12 - i) * 60));
  entries.push(entry(50, 5, { isPrivate: true, eventType: 'note', authorType: 'agent' })); // a note: never a candidate
  entries.push(entry(51, 4, { authorType: 'agent', incoming: false })); // an agent's reply: never a candidate
  db = createFakePrisma({
    ticket: [TICKET], ticketThreadEntry: entries, notificationWorkflow: [workflowRow()],
    requester: [{ id: 55, name: 'Rita Example', email: 'rita@example.com', entraProfileSyncedAt: new Date() }],
  });
  repositoryMock.getWorkflow.mockResolvedValue(workflowRow());
  repositoryMock.saveDraft.mockImplementation(async (_ws, _id, data) => ({ ...workflowRow(), draftDefinition: data.definition }));
  engineMock.executePreview.mockResolvedValue({ status: 'completed', steps: [], state: {}, warnings: [] });
  followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'model', modelVerdict: 'still_broken' });
});

describe('GET /api/notification-workflows/reply-candidates', () => {
  test('the last 10 incoming requester replies, newest first, preview ≤ 160 plain characters', async () => {
    const res = await request(buildApp()).get('/api/notification-workflows/reply-candidates?ticketId=700');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data.map((r) => r.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(res.body.data[0]).toEqual({ id: 12, occurredAt: expect.any(String), fromEmail: 'rita@example.com', fromName: 'Rita Example', preview: expect.any(String) });
    expect(res.body.data[0].preview.length).toBeLessThanOrEqual(160);
  });

  test('a ticket from another workspace: 404', async () => {
    db = createFakePrisma({ ticket: [{ ...TICKET, workspaceId: 2 }] });
    expect((await request(buildApp()).get('/api/notification-workflows/reply-candidates?ticketId=700')).status).toBe(404);
  });
});

describe('POST /api/notification-workflows/test with replyEntryId', () => {
  test('as if Closed (default): the facts on the preview context, a one-line answer, no AI without executeLlm', async () => {
    engineMock.executePreview.mockResolvedValue({
      status: 'completed', state: {}, warnings: [],
      steps: [{ nodeId: 'is-resolved', nodeType: 'condition', status: 'completed', output: { passed: true } }, { nodeId: 'reopen', nodeType: 'update_ticket', status: 'completed', output: { dryRun: true, wouldSet: { status: 'Open' } } }],
    });
    const res = await request(buildApp()).post('/api/notification-workflows/test').send({ workflowId: 9764, ticketId: 700, replyEntryId: 12 });
    expect(res.status).toBe(200);
    expect(res.body.data.replyPreview).toEqual({ sentBy: 'requester', replyVerdict: null, closedMinutes: expect.any(Number), replyToWorkflowEmail: false, outcome: 'reopen', why: 'Would reopen the ticket.' });
    const ctx = engineMock.executePreview.mock.calls[0][0].eventContext;
    expect(ctx.ticket).toMatchObject({ status: 'Closed', statusBase: 'Closed' });
    expect(ctx.event.extra).toMatchObject({ entryId: 12, from: 'rita@example.com', sentBy: 'requester' });
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(db._rows('ticket')[0].status).toBe('Open'); // nothing written
  });

  test('stays closed: the condition\'s reason; with "Use AI" the reading runs', async () => {
    engineMock.executePreview.mockResolvedValue({
      status: 'completed', warnings: [], state: { lastCondition: { passed: false, source: 'reply_thanks', verdict: 'thanks', summary: '…' } },
      steps: [{ nodeId: 'is-resolved', nodeType: 'condition', status: 'completed', output: { passed: false } }, { nodeId: 'skip', nodeType: 'stop', status: 'completed', output: {} }],
    });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'model', modelVerdict: 'thanks' });
    const res = await request(buildApp()).post('/api/notification-workflows/test').send({ workflowId: 9764, ticketId: 700, replyEntryId: 11, asStatus: 'Resolved', executeLlm: true });
    expect(res.body.data.replyPreview).toMatchObject({ replyVerdict: 'thanks', outcome: 'stays_closed', why: 'Would stay closed: reads as a thank-you.' });
    expect(followUpMock.classifyReply).toHaveBeenCalledTimes(1);
    expect(engineMock.executePreview.mock.calls[0][0].eventContext.event.extra.replyVerdict).toBe('thanks');
  });

  test('a reply that is not one of the ticket\'s incoming requester replies: 400', async () => {
    const res = await request(buildApp()).post('/api/notification-workflows/test').send({ workflowId: 9764, ticketId: 700, replyEntryId: 50 });
    expect(res.status).toBe(400);
  });

  test('without replyEntryId the test panel works as before (no replyPreview)', async () => {
    const res = await request(buildApp()).post('/api/notification-workflows/test').send({ workflowId: 9764, ticketId: 700 });
    expect(res.status).toBe(200);
    expect(res.body.data.replyPreview).toBeUndefined();
  });
});

describe('GET /api/notification-workflows/reopen-check', () => {
  test('lists the reopen workflows and warns when none is on', async () => {
    let res = await request(buildApp()).get('/api/notification-workflows/reopen-check');
    expect(res.body).toEqual({ success: true, data: { reopenWorkflows: [{ id: 9764, name: 'Reopen on requester reply', isEnabled: true }], warnings: [] } });
    db = createFakePrisma({ notificationWorkflow: [workflowRow({ isEnabled: false })] });
    res = await request(buildApp()).get('/api/notification-workflows/reopen-check');
    expect(res.body.data.warnings).toEqual([{ code: 'no_reopen_workflow', message: expect.any(String) }]);
  });
});

describe('/api/notification-workflows/:id/reopen-upgrade', () => {
  test('IT\'s shape: keeps its statuses, adds the agent / survey rows, both switches on, drops the leftover rule', async () => {
    repositoryMock.getWorkflow.mockResolvedValue(workflowRow({ draftDefinition: olderReopenDefinition(), publishedDefinition: olderReopenDefinition() }));
    const get = await request(buildApp()).get('/api/notification-workflows/9764/reopen-upgrade');
    expect(get.body.data.available).toBe(true);
    expect(get.body.data.changes).toEqual([
      'Removes the leftover code rule (the conditions already say the same).',
      'Adds “Reply sender is an agent is not true”.',
      'Adds “Reply is a survey response is not true”.',
      'Turns on “Don\'t reopen on a thank-you or out-of-office reply”.',
      'Turns on “Stop after 3 reopens by replies in a day”.',
    ]);
    const post = await request(buildApp()).post('/api/notification-workflows/9764/reopen-upgrade');
    expect(post.status).toBe(200);
    const data = post.body.data.draftDefinition.nodes.find((n) => n.id === 'is-resolved').data;
    expect(data.rule).toBeUndefined();
    expect(data).toMatchObject({ ignoreThanks: true, replyLoopGuard: true });
    expect(data.conditionGroup.conditions.map((c) => c.field)).toEqual(['event.senderIsAgent', 'event.isSurveyResponse', 'ticket.status']);
    expect(post.body.data.draftDefinition.metadata.shapeVersion).toBe(2);
    expect(repositoryMock.saveDraft).toHaveBeenCalledWith(1, 9764, { definition: expect.any(Object) }, expect.objectContaining({ email: 'admin@example.com' }));
    expect(repositoryMock.publishWorkflow).not.toHaveBeenCalled(); // never published here
  });

  test('Project Accounting\'s extra condition is kept; Accounting\'s own agent/survey step is reused, not doubled', async () => {
    const pa = olderReopenDefinition({ extraRows: [{ field: 'event.replyToWorkflowEmail', operator: 'is_false' }], rule: false });
    repositoryMock.getWorkflow.mockResolvedValue(workflowRow({ draftDefinition: pa }));
    const res = await request(buildApp()).post('/api/notification-workflows/9764/reopen-upgrade');
    const rowsOut = res.body.data.draftDefinition.nodes.find((n) => n.id === 'is-resolved').data.conditionGroup.conditions;
    expect(rowsOut).toContainEqual({ field: 'event.replyToWorkflowEmail', operator: 'is_false' });
    expect(rowsOut).toContainEqual({ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed', 'Pending Response'] });

    // Two condition steps (sender / survey first, then the status list).
    const two = olderReopenDefinition({ rule: false });
    two.nodes.push({ id: 'not-agent', type: 'condition', data: { conditionGroup: { logic: 'all', conditions: [{ field: 'event.senderIsAgent', operator: 'is_false' }, { field: 'event.isSurveyResponse', operator: 'is_false' }] } } });
    two.edges = two.edges.map((e) => (e.id === 'e-trigger' ? { ...e, target: 'not-agent' } : e));
    two.edges.push({ id: 'e-na-true', source: 'not-agent', sourceHandle: 'true', target: 'is-resolved' }, { id: 'e-na-false', source: 'not-agent', sourceHandle: 'false', target: 'skip' });
    repositoryMock.getWorkflow.mockResolvedValue(workflowRow({ draftDefinition: two }));
    const twoRes = await request(buildApp()).get('/api/notification-workflows/9764/reopen-upgrade');
    expect(twoRes.body.data.changes).toEqual([
      'Turns on “Don\'t reopen on a thank-you or out-of-office reply”.',
      'Turns on “Stop after 3 reopens by replies in a day”.',
    ]);
  });

  test('already the ready-made shape: nothing to offer, and a POST is refused', async () => {
    const get = await request(buildApp()).get('/api/notification-workflows/9764/reopen-upgrade');
    expect(get.body.data).toEqual({ available: false, changes: [] });
    expect((await request(buildApp()).post('/api/notification-workflows/9764/reopen-upgrade')).status).toBe(400);
    expect(repositoryMock.saveDraft).not.toHaveBeenCalled();
  });
});
