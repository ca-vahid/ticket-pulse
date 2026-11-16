import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * MEGA 11-14, Part A — one reopen path (lane a1, backend), through the ONE
 * event door emitTicketEvent('ticket.reply_received'):
 *   A2  reply facts worked out once (sentBy, closedMinutes, replyReopens24h)
 *   A3  the reading, only when an enabled reply workflow asks for it
 *   A5  the Ticket Ops page keeps only the two switches and the limit
 *   A6  the "why it didn't reopen" line and the loop guard's count
 *   A7  "New ticket from this reply" (the executor; the engine side is in
 *       replyOnePathEngine1114.test.js)
 * Invented names and example.com only.
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const engineMock = { executeForEvent: jest.fn() };
const updateNodeMock = jest.fn();
const ownerAwayMock = { afterRequesterReply: jest.fn() };
const newRequestMock = { afterRequesterReply: jest.fn() };
const settingsMock = { get: jest.fn(), set: jest.fn() };
const followUpMock = { classifyPostCloseReply: jest.fn(), classifyReply: jest.fn(), onAgentReply: jest.fn() };
const azureMock = { resolveAddress: jest.fn() };
const splitMock = { split: jest.fn() };
const sseMock = { broadcast: jest.fn() };
const BASES = { open: 'Open', pending: 'Pending', 'pending response': 'Pending', resolved: 'Resolved', closed: 'Closed' };
const statusServiceMock = {
  resolveBaseStatus: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  baseStatusOf: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  listStatuses: jest.fn(async () => []),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: engineMock, executeUpdateTicketNode: updateNodeMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: statusServiceMock,
  BASE_STATUSES: ['Open', 'Pending', 'Resolved', 'Closed'],
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
  heuristicBaseStatus: (s) => s,
  invalidateStatusCache: jest.fn(),
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ownerAwayRerouteService.js', () => ({ default: ownerAwayMock }));
jest.unstable_mockModule('../src/services/newRequestSuggestionService.js', () => ({ default: newRequestMock }));
jest.unstable_mockModule('../src/services/autoHelpFollowUpService.js', () => ({ default: followUpMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureMock }));
jest.unstable_mockModule('../src/services/ticketSplitService.js', () => ({ default: splitMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: sseMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ dispatchWebhookEvent: jest.fn(), default: { dispatchWebhookEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: { scheduleRefresh: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: { observeStatusTransition: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: { afterRequesterReply: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { onTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/webPushService.js', () => ({ default: { onTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({ default: { notify: jest.fn() } }));

const { emitTicketEvent } = await import('../src/services/ticketLifecycleNotificationService.js');
const rulesService = await import('../src/services/requesterReplyRulesService.js');
const { default: replyReopen, QUIET_LINES, WHY_LINES, REPLY_CHECK_OPERATION } = await import('../src/services/requesterReplyReopenService.js');
const facts = await import('../src/services/replyFacts.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { executeCreateTicketFromReplyNode } = await import('../src/services/notificationWorkflowActionNodes.js');
const { default: webhookDispatch } = await import('../src/services/webhookDispatchService.js');
const { dispatchWebhookEvent } = await import('../src/services/webhookDispatchService.js');

const NOW = Date.now();
const ticketRow = (over = {}) => ({
  id: 700, workspaceId: 1, subject: 'Laptop dock not charging', status: 'Resolved', priority: 2, origin: 'ticketpulse', nativeNumber: 1990,
  freshserviceTicketId: null, toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date(NOW - 5 * 86400e3),
  resolvedAt: new Date(NOW - 2 * 86400e3), closedAt: null, parkedUntil: null, parkKind: null, resolvedByKind: 'agent', assignedTechId: 7,
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 55, name: 'Rita Example', email: 'rita@example.com' },
  assignedTech: { id: 7, name: 'Sam Ortiz', email: 'sam@example.com' }, internalCategory: null, internalSubcategory: null, tagLinks: [],
  ...over,
});
const reply = (id, bodyText, over = {}) => ({
  id, ticketId: 700, workspaceId: 1, eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false,
  source: 'email_inbound', bodyText, content: bodyText, title: null, rawPayload: null, occurredAt: new Date(), ...over,
});
const reopenWorkflow = (over = {}) => ({
  id: 9764, workspaceId: 1, key: 'ticket_reply_received_reopen', name: 'Reopen on requester reply', triggerType: 'ticket.reply_received',
  isDefaultVariant: true, isEnabled: true, archivedAt: null, publishedVersion: 3, routingMode: 'exclusive', routingPriority: 100,
  publishedDefinition: buildDefaultWorkflowDefinition('ticket.reply_received'), ...over,
});
/** A reply workflow that reads "Reply reads as" (the full six answers). */
const richWorkflow = () => {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  def.nodes.find((n) => n.id === 'is-resolved').data.conditionGroup.conditions.push({ field: 'event.replyVerdict', operator: 'is_not', value: 'new_request' });
  return reopenWorkflow({ publishedDefinition: def });
};
/** Thank-you switch off, nothing reads the verdict: no reading at all. */
const plainWorkflow = () => {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  const data = def.nodes.find((n) => n.id === 'is-resolved').data;
  delete data.ignoreThanks;
  delete data.replyLoopGuard;
  return reopenWorkflow({ publishedDefinition: def });
};

function seed({ ticket = {}, entries = [], workflows = [reopenWorkflow()], deliveries = [], activities = [], attempts = [] } = {}) {
  db = createFakePrisma({
    ticket: [ticketRow(ticket)],
    ticketThreadEntry: entries,
    notificationWorkflow: workflows,
    notificationDelivery: deliveries,
    ticketActivity: activities,
    aiProviderAttempt: attempts,
  });
}
const rows = (name) => db._rows(name);
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const lines = () => rows('ticketThreadEntry').filter((e) => e.authorType === 'system' && e.rawPayload?.kind === 'reply_stays_closed');
const engineExtra = () => engineMock.executeForEvent.mock.calls[0][0].event.extra;
const send = (extra = { entryId: 1, from: 'rita@example.com' }, opts = {}) => emitTicketEvent('ticket.reply_received', 700, {
  source: 'email_inbound', dedupeStamp: `reply:${extra.entryId ?? 'x'}`, extra, ...opts,
});
/** What executeForEvent returns for one reopen workflow whose condition step said no. */
const stoppedRun = (lastCondition, workflowId = 9764) => ({
  status: 'completed',
  results: [{ status: 'completed', workflowId, state: { lastCondition }, steps: [{ nodeId: 'is-resolved', nodeType: 'condition' }, { nodeId: 'skip', nodeType: 'stop' }] }],
});

beforeEach(() => {
  jest.clearAllMocks();
  rulesService.invalidateRequesterReplyRulesCache();
  facts.resetReplyFactsCaches();
  settingsMock.get.mockResolvedValue(null);
  settingsMock.set.mockResolvedValue({});
  engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [] });
  ownerAwayMock.afterRequesterReply.mockResolvedValue({ rerouted: false });
  newRequestMock.afterRequesterReply.mockResolvedValue({ suggested: false });
  followUpMock.classifyPostCloseReply.mockResolvedValue(null);
  followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'model', modelVerdict: 'unclear' });
  azureMock.resolveAddress.mockResolvedValue({ status: 'absent' });
  seed();
});

// ------------------------------------------------------------------ A2
describe('A2 — who sent the reply', () => {
  const T = (over = {}) => ({ id: 700, requester: { email: 'rita@example.com' }, ccEmails: [], replyCcEmails: [], ...over });

  test('the requester, by address: no capitals, no spaces; or the mail was sent on their behalf', async () => {
    expect(await facts.replySentBy({ ticket: T({ requester: { email: 'Rita@Example.com ' } }), from: ' RITA@example.com' })).toMatchObject({ sentBy: 'requester', via: 'address' });
    expect(await facts.replySentBy({ ticket: T(), from: 'alex.delegate@example.com', onBehalfOf: 'rita@example.com' })).toMatchObject({ sentBy: 'requester', via: 'on_behalf_of' });
  });

  test('the requester changed after creation: the current one counts', async () => {
    const changed = T({ requester: { email: 'new.owner@example.com' } });
    expect((await facts.replySentBy({ ticket: changed, from: 'new.owner@example.com' })).sentBy).toBe('requester');
    expect((await facts.replySentBy({ ticket: changed, from: 'rita@example.com' })).sentBy).toBe('other');
  });

  test('a requester who is also an agent in the workspace still counts as the requester (the address decides)', async () => {
    seed({ ticket: { requester: { id: 56, name: 'Sam Ortiz', email: 'sam@example.com' } }, entries: [reply(1, 'Still broken')] });
    await send({ entryId: 1, from: 'sam@example.com' });
    expect(engineExtra().sentBy).toBe('requester');
  });

  test('an agent forwarding a mail onto the ticket: the original sender is judged', async () => {
    seed({ entries: [reply(1, 'FYI see below', { authorType: 'agent' })] });
    await send({ entryId: 1, from: 'rita@example.com', forwardedBy: 'sam@example.com' });
    expect(engineExtra()).toMatchObject({ sentBy: 'requester', forwardedBy: 'sam@example.com' });
  });

  test('a requester with no e-mail address: someone else (and no alias lookup)', async () => {
    const out = await facts.replySentBy({ ticket: T({ requester: { email: null } }), from: 'rita@example.com', alias: true });
    expect(out).toEqual({ sentBy: 'other', via: 'none', aliasCheck: 'skipped' });
    expect(azureMock.resolveAddress).not.toHaveBeenCalled();
  });

  test('both the requester and on the Cc list: the requester; Cc only: cc; a workflow e-mailed them: workflow_recipient', async () => {
    expect((await facts.replySentBy({ ticket: T({ ccEmails: ['rita@example.com'] }), from: 'rita@example.com' })).sentBy).toBe('requester');
    expect((await facts.replySentBy({ ticket: T({ ccEmails: ['Alex.Rivera@example.com'] }), from: 'alex.rivera@example.com' })).sentBy).toBe('cc');
    expect((await facts.replySentBy({ ticket: T({ replyCcEmails: ['alex.rivera@example.com'] }), from: 'alex.rivera@example.com' })).sentBy).toBe('cc');
    seed({ deliveries: [
      { id: 1, ticketId: 700, workflowRunId: 5, recipient: null, toRecipients: ['pm.person@example.com'], ccRecipients: [], bccRecipients: [] },
      { id: 2, ticketId: 700, workflowRunId: null, recipient: 'outsider@example.com', toRecipients: [], ccRecipients: [], bccRecipients: [] },
    ] });
    expect(await facts.replySentBy({ ticket: T(), from: 'pm.person@example.com' })).toMatchObject({ sentBy: 'workflow_recipient', via: 'workflow_delivery' });
    // A delivery that was not a workflow's (an agent notice) does not count.
    expect((await facts.replySentBy({ ticket: T(), from: 'outsider@example.com' })).sentBy).toBe('other');
  });

  test('the requester under another address: one Entra lookup per address, cached; only when asked', async () => {
    azureMock.resolveAddress.mockImplementation(async (a) => ({ status: a === 'rita@example.com' ? 'found' : 'alias', owner: 'rita.example@example.com' }));
    expect(await facts.replySentBy({ ticket: T(), from: 'r.example@example.org', alias: true })).toEqual({ sentBy: 'requester', via: 'alias', aliasCheck: 'ok' });
    expect(await facts.replySentBy({ ticket: T(), from: 'r.example@example.org', alias: true })).toMatchObject({ sentBy: 'requester' });
    expect(azureMock.resolveAddress).toHaveBeenCalledTimes(2); // each address once, then the cache
    expect((await facts.replySentBy({ ticket: T(), from: 'r.example@example.org' })).sentBy).toBe('other'); // not asked: no lookup
  });

  test('the Entra lookup fails or times out: the next step decides and aliasCheck says so', async () => {
    azureMock.resolveAddress.mockResolvedValue({ status: 'unavailable' });
    expect(await facts.replySentBy({ ticket: T({ ccEmails: ['r2@example.org'] }), from: 'r2@example.org', alias: true })).toEqual({ sentBy: 'cc', via: 'cc', aliasCheck: 'failed' });
    const never = () => new Promise(() => {});
    expect(await facts.replySentBy({ ticket: T(), from: 'r3@example.org', alias: true, aliasLookup: never, aliasTimeoutMs: 20 })).toEqual({ sentBy: 'other', via: 'none', aliasCheck: 'failed' });
  });

  test('the FreshService roads pass fromEmail (no "on behalf of"); both names are read', async () => {
    const out = await facts.computeReplyFacts({ ticket: ticketRow(), statusBase: 'Resolved', extra: { fromEmail: 'rita@example.com', externalEntryId: 'fs-conversation:1' }, workflows: [] });
    expect(out.sentBy).toBe('requester');
  });
});

describe('A2 — time since closed, reopens today, what the workflows ask for', () => {
  test('closedMinutes: close time, else resolve time, else the last activity; empty when not Resolved / Closed', () => {
    const at = NOW - 90 * 60000;
    expect(facts.closedMinutesFor({ closedAt: new Date(at), resolvedAt: new Date(at - 86400e3) }, 'Closed', NOW)).toBe(90);
    expect(facts.closedMinutesFor({ resolvedAt: new Date(at) }, 'Resolved', NOW)).toBe(90);
    expect(facts.closedMinutesFor({ status: 'Closed', lastRealActivityAt: new Date(at) }, 'Closed', NOW)).toBe(90);
    expect(facts.closedMinutesFor({ resolvedAt: new Date(at) }, 'Open', NOW)).toBeNull();
    expect(facts.closedMinutesFor({ status: 'Closed' }, 'Closed', NOW)).toBeNull();
  });

  test('replyReopens24h counts reopens by reply workflows in the last day only', async () => {
    const reopen = (hoursAgo, over = {}) => ({
      ticketId: 700, activityType: 'workflow_updated_ticket', performedAt: new Date(NOW - hoursAgo * 3600e3),
      details: { eventType: 'ticket.reply_received', changes: { status: { from: 'Resolved', to: 'Open' } }, ...over },
    });
    seed({ activities: [
      reopen(1), reopen(5), reopen(23),
      reopen(30), // older than a day
      reopen(2, { eventType: 'ticket.created' }), // not a reply workflow
      reopen(2, { changes: { priority: { from: 2, to: 3 } } }), // no status change
      reopen(2, { changes: { status: { from: 'Open', to: 'Pending' } } }), // not a reopen
    ] });
    expect(await facts.replyReopensLast24h({ id: 700, workspaceId: 1 }, { now: NOW })).toBe(3);
  });

  test('replyWorkflowNeeds: the switch asks for the reading; "Reply reads as" asks for all six; "Reply sent by" for the alias lookup', () => {
    expect(facts.replyWorkflowNeeds([plainWorkflow()])).toEqual({ alias: false, reading: false, rich: false });
    expect(facts.replyWorkflowNeeds([reopenWorkflow()])).toEqual({ alias: false, reading: true, rich: false });
    expect(facts.replyWorkflowNeeds([richWorkflow()])).toEqual({ alias: false, reading: true, rich: true });
    const legacy = plainWorkflow();
    legacy.publishedDefinition.nodes.find((n) => n.id === 'is-resolved').data.ignoreAutoHelpThanks = true;
    expect(facts.replyWorkflowNeeds([legacy]).reading).toBe(true);
    const bySender = plainWorkflow();
    bySender.publishedDefinition.nodes.find((n) => n.id === 'is-resolved').data.conditionGroup.conditions.push({ field: 'event.sentBy', operator: 'is', value: 'requester' });
    expect(facts.replyWorkflowNeeds([bySender]).alias).toBe(true);
  });

  test('every road gets the facts on the event, the webhook and the ticket (ticket.closedMinutes)', async () => {
    seed({ ticket: { ccEmails: ['alex.rivera@example.com'] }, entries: [reply(1, 'Adding Alex')], workflows: [plainWorkflow()] });
    await send({ entryId: 1, from: 'alex.rivera@example.com' });
    expect(engineExtra()).toMatchObject({ sentBy: 'cc', replyReopens24h: 0, closedMinutes: expect.any(Number) });
    expect(engineMock.executeForEvent.mock.calls[0][0].ticket.closedMinutes).toBeGreaterThanOrEqual(2 * 1440 - 1);
    const [, type, payload] = dispatchWebhookEvent.mock.calls.find(([, t]) => t === 'ticket.reply_received');
    expect(type).toBe('ticket.reply_received');
    expect(payload.extra).toMatchObject({ sentBy: 'cc', replyReopens24h: 0 });
    expect(webhookDispatch).toBeDefined();
  });
});

// ------------------------------------------------------------------ A3
describe('A3 — the reading, asked for by the workflow', () => {
  test('no enabled workflow asks: no reading, no replyVerdict, no model call', async () => {
    seed({ entries: [reply(1, 'Thank you so much for sorting this out')], workflows: [plainWorkflow()] });
    await send();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra().replyVerdict).toBeUndefined();
  });

  test('the switch on: a bare thank-you to a closed ticket reads as thanks (keywords, no model)', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    await send();
    expect(engineExtra().replyVerdict).toBe('thanks');
    expect(followUpMock.classifyReply).toHaveBeenCalledWith(1, 'Thanks!', expect.objectContaining({ reader: 'person', operation: REPLY_CHECK_OPERATION }));
  });

  test.each([
    ['thanks', 'thanks'], ['auto_reply', 'auto_reply'], ['still_broken', 'still_broken'],
    ['new_request', 'new_request'], ['question', 'question'], ['unclear', 'reply'], [null, 'reply'],
  ])('the model says %p → replyVerdict %p', async (answer, verdict) => {
    seed({ entries: [reply(1, 'Some longer reply that the keywords cannot place on their own')], workflows: [richWorkflow()] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: answer === 'thanks' ? 'confirmed' : 'help', via: 'model', modelVerdict: answer });
    await send();
    expect(engineExtra().replyVerdict).toBe(verdict);
  });

  test('a thank-you only counts on Resolved / Closed: on a Pending ticket it reads as "Other reply"', async () => {
    seed({ ticket: { status: 'Pending Response', resolvedAt: null }, entries: [reply(1, 'Thank you, appreciated, all good now')], workflows: [richWorkflow()] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'model', modelVerdict: 'thanks' });
    await send();
    expect(engineExtra().replyVerdict).toBe('reply');
    // Only the switch (no "Reply reads as"): an open ticket's reply is not sent to the model at all.
    jest.clearAllMocks();
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [] });
    seed({ ticket: { status: 'Pending Response', resolvedAt: null }, entries: [reply(1, 'Thank you, appreciated, all good now')] });
    await send();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra().replyVerdict).toBe('reply');
  });

  test('G5: an out-of-office on a Pending ticket reads as auto_reply (any status, no AI)', async () => {
    seed({
      ticket: { status: 'Pending Response', resolvedAt: null },
      entries: [reply(1, 'I am out of the office until Monday.', { rawPayload: { headers: { 'Auto-Submitted': 'auto-replied' } } })],
    });
    await send();
    expect(engineExtra().replyVerdict).toBe('auto_reply');
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
  });

  test('an agent\'s forward is never a thank-you', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    await send({ entryId: 1, from: 'rita@example.com', forwardedBy: 'sam@example.com' });
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra().replyVerdict).toBe('reply');
  });

  test('over the limit, a failure or a timeout: "Other reply", so the ticket reopens', async () => {
    seed({ entries: [reply(1, 'Thank you all for your patience with me on this one')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'budget_cap' });
    await send();
    expect(engineExtra().replyVerdict).toBe('reply');

    jest.clearAllMocks();
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [] });
    seed({ entries: [reply(1, 'Thank you all for your patience with me on this one')] });
    followUpMock.classifyReply.mockRejectedValue(new Error('provider down'));
    await send();
    expect(engineExtra().replyVerdict).toBe('reply');

    followUpMock.classifyReply.mockImplementation(() => new Promise(() => {}));
    const read = await replyReopen.readReply(rows('ticket')[0], { entryId: 1 }, { timeoutMs: 20 });
    expect(read).toMatchObject({ verdict: 'reply', via: 'timeout' });
  });

  test('Auto-help\'s own reading is reused: no second reading', async () => {
    seed({ ticket: { resolvedByKind: 'auto_help' }, entries: [reply(1, 'Thanks, that worked!')] });
    followUpMock.classifyPostCloseReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords', runId: 901 });
    await send();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra()).toMatchObject({ autoHelpReplyVerdict: 'confirmed', replyVerdict: 'thanks' });
  });

  test('a manual one-workflow replay gets the cheap facts only (no reading)', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    await send({ entryId: 1, from: 'rita@example.com' }, { onlyWorkflowId: 9764 });
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra()).toMatchObject({ sentBy: 'requester' });
    expect(engineExtra().replyVerdict).toBeUndefined();
    expect(lines()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ A6
describe('A6 — "why it didn\'t reopen", one private line per reply', () => {
  const activityNotes = () => rows('ticketActivity').filter((a) => a.activityType === 'requester_reply_stays_closed').map((a) => a.details.note);

  test('a thank-you: the line, private, never mirrored, the history row carries it; no follow-ups', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    engineMock.executeForEvent.mockResolvedValue(stoppedRun({ nodeId: 'is-resolved', passed: false, source: 'reply_thanks', verdict: 'thanks', summary: '…' }));
    const result = await send();
    await flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ bodyText: QUIET_LINES.thanks, isPrivate: true, actorName: 'Ticket Pulse', mirrorState: null });
    expect(activityNotes()).toEqual([QUIET_LINES.thanks]);
    expect(result.replyOutcome).toMatchObject({ openNow: false, stillClosed: true, line: QUIET_LINES.thanks });
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1); // the line fires no event
  });

  test('an out-of-office', async () => {
    seed({ entries: [reply(1, 'I am out of the office until Monday.', { rawPayload: { headers: { 'Auto-Submitted': 'auto-replied' } } })] });
    engineMock.executeForEvent.mockResolvedValue(stoppedRun({ passed: false, source: 'reply_thanks', verdict: 'auto_reply', summary: '…' }));
    await send();
    expect(activityNotes()).toEqual([QUIET_LINES.auto_reply]);
  });

  test('a condition said no: who replied and the condition\'s own sentence, with the workflow\'s name', async () => {
    seed({
      entries: [reply(1, 'Here are the survey results')],
      deliveries: [{ id: 1, ticketId: 700, workflowRunId: 5, recipient: 'pm.person@example.com', toRecipients: [], ccRecipients: [], bccRecipients: [] }],
    });
    engineMock.executeForEvent.mockResolvedValue(stoppedRun({ passed: false, source: 'conditions', summary: 'Reply answers a workflow e-mail is not true (this ticket: true)' }));
    await send({ entryId: 1, from: 'pm.person@example.com', replyToWorkflowEmail: true });
    expect(activityNotes()).toEqual(['Reply from pm.person@example.com (someone a workflow e-mailed); not reopened: Reply answers a workflow e-mail is not true (this ticket: true) (Reopen on requester reply).']);
  });

  test('the loop guard: replyReopens24h on the event, and the line', async () => {
    const reopenRow = (hoursAgo) => ({ ticketId: 700, activityType: 'workflow_updated_ticket', performedAt: new Date(NOW - hoursAgo * 3600e3), details: { eventType: 'ticket.reply_received', changes: { status: { from: 'Closed', to: 'Open' } } } });
    seed({ entries: [reply(1, 'Broken again')], activities: [reopenRow(1), reopenRow(3), reopenRow(6)] });
    engineMock.executeForEvent.mockResolvedValue(stoppedRun({ passed: false, source: 'reply_loop', summary: '…' }));
    await send();
    expect(engineExtra().replyReopens24h).toBe(3);
    expect(activityNotes()).toEqual([WHY_LINES.loop()]);
    expect(WHY_LINES.loop()).toBe('Reopened 3 times by replies today; not reopened again. Please take a look.');
  });

  test('no workflow reopens replies in this workspace', async () => {
    seed({ entries: [reply(1, 'Hello again')], workflows: [] });
    await send();
    expect(activityNotes()).toEqual(['Reply received; no workflow reopens replies in this workspace.']);
  });

  test('the reopen failed: the reason', async () => {
    seed({ entries: [reply(1, 'Hello again')] });
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [{ status: 'failed', workflowId: 9764, error: 'Failed to write reopen to FreshService: 503' }] });
    await send();
    expect(activityNotes()).toEqual(['Reply received; the reopen failed: Failed to write reopen to FreshService: 503.']);
  });

  test('"could not check aliases" when the Entra lookup failed', async () => {
    const bySender = reopenWorkflow();
    bySender.publishedDefinition.nodes.find((n) => n.id === 'is-resolved').data.conditionGroup.conditions.push({ field: 'event.sentBy', operator: 'is', value: 'requester' });
    seed({ entries: [reply(1, 'From my other address')], workflows: [bySender] });
    azureMock.resolveAddress.mockResolvedValue({ status: 'unavailable' });
    engineMock.executeForEvent.mockResolvedValue(stoppedRun({ passed: false, source: 'conditions', summary: 'Reply sent by is requester (this ticket: other)' }));
    await send({ entryId: 1, from: 'rita.other@example.org' });
    expect(activityNotes()[0]).toBe('Reply from rita.other@example.org; not reopened: Reply sent by is requester (this ticket: other) (Reopen on requester reply). (Could not check aliases.)');
  });

  test('a workflow reopened it: no line, the follow-ups run; and one line per reply only', async () => {
    seed({ entries: [reply(1, 'Still broken')] });
    engineMock.executeForEvent.mockImplementationOnce(async () => { rows('ticket')[0].status = 'Open'; return { status: 'completed', results: [] }; });
    await send();
    await flush();
    expect(lines()).toHaveLength(0);
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);

    seed({ entries: [reply(2, 'Hello')], workflows: [] });
    await send({ entryId: 2, from: 'rita@example.com' });
    await send({ entryId: 2, from: 'rita@example.com' }); // the same reply dispatched twice
    expect(lines()).toHaveLength(1);
  });

  test('a reply on an open ticket gets no line', async () => {
    seed({ ticket: { status: 'Open', resolvedAt: null }, entries: [reply(1, 'Any news?')] });
    await send();
    await flush();
    expect(lines()).toHaveLength(0);
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });

  test('Mail review\'s "add without reopening" line names the person', async () => {
    seed();
    await replyReopen.writeQuietLine(rows('ticket')[0], { text: WHY_LINES.mail_review({ person: 'Alex Rivera' }), cause: 'mail_review', replyEntryId: 3, stamp: 'reply:3' });
    expect(activityNotes()).toEqual(['Added without reopening by Alex Rivera.']);
  });

  test('a new ticket from the reply: the line points at it', () => {
    const why = replyReopen.whyLine({
      facts: { workflows: [reopenWorkflow()] },
      result: { results: [{ status: 'completed', workflowId: 9764, state: { replyNewTicket: { id: 802, displayRef: 'TP-2105', note: 'Closed more than 14 days ago.' } } }] },
    });
    expect(why).toEqual({ cause: 'new_ticket', text: 'Reply opened a new ticket, TP-2105; this one stays closed. Closed more than 14 days ago.', newTicketId: 802 });
  });
});

// ------------------------------------------------------------------ A5
describe('A5 — Ticket Ops keeps two switches and the limit', () => {
  test('the page reads only the contract §5 keys; old reopen keys are ignored on read and on save', async () => {
    settingsMock.get.mockResolvedValue(JSON.stringify({ rerouteWhenOwnerAway: false, reopenOnReply: true, reopenStatuses: ['Closed'], ignoreThanks: true, replyCheckMonthlyCapUsd: 25 }));
    const page = await replyReopen.pageContext(1);
    expect(Object.keys(page).sort()).toEqual(['replyCheckBudget', 'replyCheckCapChoices', 'replyCheckMonthlyCapUsd', 'rerouteWhenOwnerAway', 'suggestNewRequest']);
    expect(page).toMatchObject({ rerouteWhenOwnerAway: false, suggestNewRequest: true, replyCheckMonthlyCapUsd: 25, replyCheckCapChoices: [5, 10, 25, 50] });
    rulesService.invalidateRequesterReplyRulesCache();
    const saved = await rulesService.setRequesterReplyRules(1, { reopenOnReply: true, reopenStatuses: [], suggestNewRequest: false });
    expect(saved).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: false, replyCheckMonthlyCapUsd: 25 });
  });

  test('the retired pieces are gone', () => {
    expect(replyReopen.beforeWorkflows).toBeUndefined();
    expect(replyReopen.reopen).toBeUndefined();
    expect(replyReopen.retireReopenWorkflows).toBeUndefined();
    expect(replyReopen.restoreRetiredWorkflow).toBeUndefined();
    expect(rulesService.recordRetiredWorkflows).toBeUndefined();
  });

  test('the reading limit: this month\'s requester_reply_check spend; unreadable spend counts as over', async () => {
    seed({ attempts: [
      { workspaceId: 1, operation: 'requester_reply_check', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 1_000_000, outputTokens: 0, startedAt: new Date() },
      { workspaceId: 1, operation: 'auto_help', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 9_000_000, outputTokens: 0, startedAt: new Date() },
    ] });
    settingsMock.get.mockResolvedValue(JSON.stringify({ replyCheckMonthlyCapUsd: 5 }));
    const state = await replyReopen.budgetState(1);
    expect(state).toMatchObject({ capUsd: 5, checks: 1, exhausted: false });
    const broken = db;
    db = new Proxy({}, { get: (_t, prop) => (prop === 'aiProviderAttempt' ? { findMany: async () => { throw new Error('pool timeout'); } } : broken[prop]) });
    expect(await replyReopen.budgetState(1)).toMatchObject({ exhausted: true, unknown: true });
  });
});

// ------------------------------------------------------------------ §4 reopen check
describe('reopen check (two at once / none)', () => {
  test('two reopen workflows that would both run, and none switched on', async () => {
    seed({ workflows: [reopenWorkflow(), reopenWorkflow({ id: 11400, name: 'Reopen for projects', isDefaultVariant: false, routingMode: 'additive' })] });
    const check = await replyReopen.reopenCheck(1);
    expect(check.reopenWorkflows).toEqual([{ id: 9764, name: 'Reopen on requester reply', isEnabled: true }, { id: 11400, name: 'Reopen for projects', isEnabled: true }]);
    expect(check.warnings.map((w) => w.code)).toEqual(['two_reopen_workflows']);

    // Exclusive variants: only one runs per reply — no warning.
    seed({ workflows: [reopenWorkflow(), reopenWorkflow({ id: 11400, name: 'Reopen for projects', isDefaultVariant: false })] });
    expect((await replyReopen.reopenCheck(1)).warnings).toEqual([]);

    seed({ workflows: [reopenWorkflow({ isEnabled: false }), reopenWorkflow({ id: 16098, publishedVersion: 0 })] });
    const none = await replyReopen.reopenCheck(1);
    expect(none.warnings.map((w) => w.code)).toEqual(['no_reopen_workflow']);
    expect(none.reopenWorkflows).toEqual([{ id: 9764, name: 'Reopen on requester reply', isEnabled: false }]);
  });
});

// ------------------------------------------------------------------ A7
describe('A7 — New ticket from this reply (the executor)', () => {
  const ctx = (over = {}) => ({
    event: { type: 'ticket.reply_received', extra: { entryId: 1, from: 'alex.rivera@example.com', fromName: 'Alex Rivera' } },
    ticket: { id: 700, workspaceId: 1 },
    workspace: { id: 1 },
    ...over,
  });

  test('preview / Shadow only says it would', async () => {
    expect(await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx(), { dryRun: true })).toEqual({ dryRun: true, wouldCreate: true });
    expect(splitMock.split).not.toHaveBeenCalled();
  });

  test('only on "Requester replied"', async () => {
    expect(await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx({ event: { type: 'ticket.created' } }))).toMatchObject({ skipped: true });
  });

  test('live: the split starts a related ticket, requester = the person who replied, "Ticket arrived" fires; the reply\'s files move', async () => {
    seed({ entries: [reply(1, 'Different thing: the projector in room 4 is dead', { actorName: 'Alex Rivera', actorEmail: 'alex.rivera@example.com' })] });
    db._rows('ticketAttachment')?.push?.({ id: 1, ticketId: 700, workspaceId: 1, threadEntryId: 1 });
    splitMock.split.mockResolvedValue({ child: { id: 802, ref: 'TP-2105', subject: 'Laptop dock not charging' }, linkKind: 'related_to' });
    const out = await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx(), { workflow: { id: 9764, name: 'Reopen on requester reply' } });
    expect(out).toEqual({ created: { id: 802, displayRef: 'TP-2105' }, linkKind: 'related_to' });
    const [parentId, ws, input, actor] = splitMock.split.mock.calls[0];
    expect([parentId, ws]).toEqual([700, 1]);
    expect(input).toMatchObject({
      subject: 'Laptop dock not charging', entryIds: [], includeDescription: false, runAiTriage: true, linkKind: 'related_to',
      notifyRequester: true, createdVia: 'email', requesterEmail: 'alex.rivera@example.com', requesterName: 'Alex Rivera',
    });
    expect(input.description).toMatch(/From a reply to TP-1990/);
    expect(input.description).toMatch(/projector in room 4/);
    expect(input.parentStatus).toBeUndefined(); // the old ticket stays as it is (closed)
    expect(actor).toMatchObject({ name: 'Workflow: Reopen on requester reply', role: 'workflow' });
  });

  test('the new ticket cannot be started (e.g. native ticketing off): it reopens instead and says so', async () => {
    seed({ entries: [reply(1, 'Hello')] });
    splitMock.split.mockRejectedValue(new Error('Native ticketing is not enabled for this workspace'));
    updateNodeMock.mockResolvedValue({ updated: { status: { from: 'Resolved', to: 'Open' } } });
    const out = await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx(), { workflow: { id: 9764 } });
    expect(out).toMatchObject({ skipped: true, reopenedInstead: true, reason: expect.stringContaining('reopened instead') });
    expect(updateNodeMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_ticket', data: expect.objectContaining({ setStatus: 'Open' }) }), expect.any(Object), { workflowId: 9764 });
  });

  // 16 Nov 2026: two replies 8 minutes apart to the same long-closed ticket
  // started two tickets. The second belongs on the one the first started.
  describe('a second reply from the same person joins the ticket the first one started', () => {
    const earlierTicket = (over = {}) => ({
      id: 803, workspaceId: 1, status: 'Open', origin: 'ticketpulse', nativeNumber: 2106, freshserviceTicketId: null,
      requester: { id: 56, email: 'alex.rivera@example.com' }, ...over,
    });
    const seedWithEarlier = ({ earlier = {}, linkAgeDays = 0 } = {}) => {
      seed({ entries: [reply(2, 'Still not working after the restart', { actorName: 'Alex Rivera', actorEmail: 'alex.rivera@example.com' })] });
      db._rows('ticket').push(earlierTicket(earlier));
      db._rows('ticketLink').push({ id: 1, workspaceId: 1, ticketId: 700, relatedTicketId: 803, kind: 'related_to', createdAt: new Date(NOW - linkAgeDays * 86400e3) });
    };
    const ctx2 = () => ({ event: { type: 'ticket.reply_received', extra: { entryId: 2, from: 'alex.rivera@example.com' } }, ticket: { id: 700, workspaceId: 1 }, workspace: { id: 1 } });

    test('the reply is added to the open ticket the earlier reply started; no new ticket', async () => {
      seedWithEarlier();
      splitMock.split.mockClear();
      const out = await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx2(), { workflow: { id: 9764, name: 'Reopen on requester reply' } });
      expect(out).toEqual({ joined: { id: 803, displayRef: 'TP-2106' } });
      expect(splitMock.split).not.toHaveBeenCalled();
      const added = db._rows('ticketThreadEntry').find((e) => e.ticketId === 803);
      expect(added).toMatchObject({ eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false, externalEntryId: 'replyjoin:700:2' });
      expect(added.bodyText).toMatch(/Still not working/);
      expect(db._rows('ticketActivity').some((a) => a.ticketId === 803 && a.activityType === 'reply_redirected' && a.details?.kind === 'reply_join')).toBe(true);
      expect(WHY_LINES.joined_ticket({ ref: 'TP-2106' })).toBe('Reply added to TP-2106, which an earlier reply to this ticket started; this one stays closed.');
    });

    test('someone else replying still gets a ticket of their own', async () => {
      seedWithEarlier({ earlier: { requester: { id: 57, email: 'sam.ortiz@example.com' } } });
      splitMock.split.mockResolvedValue({ child: { id: 804, ref: 'TP-2107' }, linkKind: 'related_to' });
      const out = await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx2(), { workflow: { id: 9764 } });
      expect(out).toMatchObject({ created: { id: 804 } });
    });

    test('the earlier ticket is already resolved: a new ticket', async () => {
      seedWithEarlier({ earlier: { status: 'Resolved' } });
      splitMock.split.mockResolvedValue({ child: { id: 805, ref: 'TP-2108' }, linkKind: 'related_to' });
      expect(await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx2(), { workflow: { id: 9764 } })).toMatchObject({ created: { id: 805 } });
    });

    test('the earlier link is more than 7 days old: a new ticket', async () => {
      seedWithEarlier({ linkAgeDays: 8 });
      splitMock.split.mockResolvedValue({ child: { id: 806, ref: 'TP-2109' }, linkKind: 'related_to' });
      expect(await executeCreateTicketFromReplyNode({ id: 'n', data: {} }, ctx2(), { workflow: { id: 9764 } })).toMatchObject({ created: { id: 806 } });
    });
  });
});
