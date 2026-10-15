import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * "When a requester replies" (14 Oct 2026, plans/REQUESTER_REPLY_SETTINGS_PLAN.md):
 * the page's reopen and thank-you reading, through the ONE event door
 * (emitTicketEvent('ticket.reply_received')).
 *
 *  - a reply to a ticket in a ticked status reopens it, before the workflows;
 *  - a thank-you / out-of-office to a person-closed ticket stays closed, with
 *    one quiet line and no follow-ups (no reroute, no split suggestion);
 *  - every doubt (unclear, over the limit, timed out) reopens;
 *  - off (the default) changes nothing; the Auto-help guard still works;
 *  - the reopen workflow is archived only when the page is saved.
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const engineMock = { executeForEvent: jest.fn() };
const updateNodeMock = jest.fn();
const ownerAwayMock = { afterRequesterReply: jest.fn() };
const newRequestMock = { afterRequesterReply: jest.fn() };
const settingsMock = { get: jest.fn(), set: jest.fn() };
const followUpMock = { classifyPostCloseReply: jest.fn(), classifyReply: jest.fn(), onAgentReply: jest.fn() };
const sseMock = { broadcast: jest.fn() };
const BASES = { open: 'Open', pending: 'Pending', 'pending response': 'Pending', resolved: 'Resolved', closed: 'Closed' };
const STATUS_ROWS = [
  { name: 'Open', baseStatus: 'Open' }, { name: 'Pending', baseStatus: 'Pending' }, { name: 'Pending Response', baseStatus: 'Pending' },
  { name: 'Resolved', baseStatus: 'Resolved' }, { name: 'Closed', baseStatus: 'Closed' },
];
const statusServiceMock = {
  resolveBaseStatus: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  baseStatusOf: jest.fn(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null),
  listStatuses: jest.fn(async () => STATUS_ROWS),
  normalizeStatusName: jest.fn(async (_ws, s) => STATUS_ROWS.find((r) => r.name.toLowerCase() === String(s).toLowerCase())?.name || null),
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
const { default: replyReopen, reopenWorkflowShape, QUIET_LINES, REPLY_CHECK_OPERATION } = await import('../src/services/requesterReplyReopenService.js');
const repository = await import('../src/services/notificationWorkflowRepository.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { default: watcherNotificationService } = await import('../src/services/watcherNotificationService.js');
const { default: teamsNotificationService } = await import('../src/services/teamsNotificationService.js');

const NOW = Date.now();
const ticketRow = (over = {}) => ({
  id: 700, workspaceId: 1, subject: 'Laptop dock not charging', status: 'Resolved', priority: 2, origin: 'ticketpulse', nativeNumber: 1990,
  freshserviceTicketId: null, toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date(NOW - 5 * 86400e3),
  resolvedAt: new Date(NOW - 2 * 86400e3), closedAt: null, parkedUntil: null, parkKind: null, resolvedByKind: 'agent', assignedTechId: 7,
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 55, name: 'Rita Example', email: 'rita@example.com' },
  assignedTech: { id: 7, name: 'Soheil Example', email: 's@example.com' }, internalCategory: null, internalSubcategory: null, tagLinks: [],
  ...over,
});
const reply = (id, bodyText, over = {}) => ({
  id, ticketId: 700, workspaceId: 1, eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false,
  source: 'email_inbound', bodyText, content: bodyText, title: null, rawPayload: null, occurredAt: new Date(), ...over,
});
// A FreshService-synced requester reply: no mail headers, no subject, author_type NULL.
const fsReply = (id, bodyText) => ({
  id, ticketId: 700, workspaceId: 1, eventType: 'customer_reply', authorType: null, incoming: true, isPrivate: false,
  source: 'freshservice_conversation', externalEntryId: `fs-conversation:${id}`, bodyText, title: null, occurredAt: new Date(),
  rawPayload: { id, body_text: bodyText, incoming: true, private: false, source: 0, from_email: 'rita@example.com', to_emails: ['it@example.com'], user_id: 5 },
});

function seed({ ticket = {}, entries = [], workflows = [], attempts = [] } = {}) {
  db = createFakePrisma({
    ticket: [ticketRow(ticket)],
    ticketThreadEntry: entries,
    notificationWorkflow: workflows,
    aiProviderAttempt: attempts,
  });
}
const rows = (name) => db._rows(name);
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const quietLines = () => rows('ticketThreadEntry').filter((e) => e.authorType === 'system' && e.rawPayload?.kind === 'reply_stays_closed');
const engineExtra = () => engineMock.executeForEvent.mock.calls[0][0].event.extra;

let stored = null;
async function saveRules(patch) {
  rulesService.invalidateRequesterReplyRulesCache();
  return rulesService.setRequesterReplyRules(1, patch);
}

beforeEach(() => {
  jest.clearAllMocks();
  rulesService.invalidateRequesterReplyRulesCache();
  stored = null;
  settingsMock.get.mockImplementation(async () => stored);
  settingsMock.set.mockImplementation(async (_k, v) => { stored = v; return {}; });
  engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
  updateNodeMock.mockImplementation(async () => {
    rows('ticket')[0].status = 'Open';
    return { updated: { status: { from: 'Resolved', to: 'Open' } } };
  });
  ownerAwayMock.afterRequesterReply.mockResolvedValue({ rerouted: false });
  newRequestMock.afterRequesterReply.mockResolvedValue({ suggested: false });
  followUpMock.classifyPostCloseReply.mockResolvedValue(null);
  followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'model' });
  seed();
});

const send = (extra = { entryId: 1 }, opts = {}) => emitTicketEvent('ticket.reply_received', 700, { source: 'email_inbound', dedupeStamp: `reply:${extra.entryId ?? 'x'}`, extra, ...opts });

describe('off (never saved): nothing changes on deploy', () => {
  test('no reading, no reopen in code, no replyVerdict; the workflows and follow-ups run as before', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    await send();
    await flush();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(engineExtra().replyVerdict).toBeUndefined();
    expect(quietLines()).toHaveLength(0);
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });
});

describe('Which statuses reopen', () => {
  test('a reply to a ticked status reopens in code, BEFORE the workflows, recorded as Ticket Pulse', async () => {
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved', 'Closed', 'Pending Response'] });
    seed({ entries: [reply(1, 'It stopped charging again this morning.')] });
    const order = [];
    updateNodeMock.mockImplementation(async (node, ctx, opts) => {
      order.push('reopen');
      expect(node).toMatchObject({ type: 'update_ticket', data: { setStatus: 'Open' } });
      expect(opts.actor).toMatchObject({ name: 'Ticket Pulse', kind: 'system' });
      rows('ticket')[0].status = 'Open';
      return { updated: { status: { from: 'Resolved', to: 'Open' } } };
    });
    engineMock.executeForEvent.mockImplementation(async () => { order.push('workflows'); return { status: 'completed' }; });
    await send();
    await flush();
    expect(order).toEqual(['reopen', 'workflows']);
    expect(rows('ticket')[0].status).toBe('Open');
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1); // the follow-ups still run on a real reply
  });

  test('Pending Response ticked → reopens (no reading: it is not closed)', async () => {
    await saveRules({ reopenOnReply: true, ignoreThanks: true, reopenStatuses: ['Pending Response'] });
    seed({ ticket: { status: 'Pending Response' }, entries: [reply(1, 'Thanks!')] });
    await send();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
  });

  test('a status that is not ticked is left alone (and its reply is not read)', async () => {
    await saveRules({ reopenOnReply: true, ignoreThanks: true, reopenStatuses: ['Pending Response'] });
    seed({ entries: [reply(1, 'Thank you for sorting this out so quickly, much appreciated')] });
    await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
  });

  test('reopen on with nothing ticked is refused; statuses keep their order and drop repeats', async () => {
    await expect(saveRules({ reopenOnReply: true, reopenStatuses: [] })).rejects.toThrow('Tick at least one status');
    const saved = await saveRules({ reopenOnReply: true, reopenStatuses: ['Closed', ' closed', 'Resolved'] });
    expect(saved.reopenStatuses).toEqual(['Closed', 'Resolved']);
  });

  test('a FreshService reopen that fails is tried again later, while the status is still ticked', async () => {
    jest.useFakeTimers();
    try {
      await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved'] });
      seed({ ticket: { origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 245828 }, entries: [fsReply(1, 'Still broken')] });
      updateNodeMock.mockRejectedValueOnce(new Error('Failed to write reopen to FreshService: 503'));
      const res = await replyReopen.reopen(rows('ticket')[0]);
      expect(res).toEqual({ reopened: false, reason: 'retry_scheduled' });
      await jest.advanceTimersByTimeAsync(2 * 60 * 1000 + 10);
      expect(updateNodeMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('A thank-you or out-of-office reply does not reopen', () => {
  beforeEach(async () => {
    await saveRules({ reopenOnReply: true, ignoreThanks: true, reopenStatuses: ['Resolved', 'Closed', 'Pending Response'] });
  });

  test('a thank-you on a PERSON-closed ticket stays closed, with one quiet line and no follow-ups', async () => {
    seed({ entries: [reply(1, 'Thank you so much for the help yesterday, the new dock is perfect.')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'model' });
    await send();
    await flush();
    expect(followUpMock.classifyReply).toHaveBeenCalledWith(1, expect.any(String), expect.objectContaining({ reader: 'person', operation: REPLY_CHECK_OPERATION }));
    expect(typeof followUpMock.classifyReply.mock.calls[0][2].budgetState).toBe('function');
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(rows('ticket')[0].status).toBe('Resolved');
    expect(engineExtra()).toMatchObject({ replyVerdict: 'thanks' });
    expect(engineExtra().autoHelpReplyVerdict).toBeUndefined();
    const lines = quietLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ bodyText: QUIET_LINES.thanks, isPrivate: true, actorName: 'Ticket Pulse', mirrorState: null });
    expect(rows('ticketActivity').map((a) => a.activityType)).toContain('requester_reply_stays_closed');
    // Quiet: no follow-ups, no watcher / Teams notification from the line itself.
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(watcherNotificationService.notify).not.toHaveBeenCalled();
    expect(teamsNotificationService.onTicketEvent.mock.calls.filter(([ctx]) => ctx?.event?.type === 'ticket.note_added')).toHaveLength(0);
    expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1); // only the reply itself; the line fires no event
  });

  test('a bare "Thanks!" never needs the model (keyword fast path inside classifyReply)', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    await send();
    expect(quietLines()).toHaveLength(1);
    expect(quietLines()[0].rawPayload).toMatchObject({ verdict: 'thanks', via: 'keywords', replyEntryId: 1 });
  });

  test('an out-of-office stays closed — Ticket Pulse mail (headers) and FreshService-synced (text only)', async () => {
    seed({ entries: [reply(1, 'I am out of the office until Monday.', { rawPayload: { headers: { 'Auto-Submitted': 'auto-replied' } } })] });
    await send({ entryId: 1 });
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled(); // no model call for an out-of-office
    expect(quietLines()[0].bodyText).toBe(QUIET_LINES.auto_reply);

    jest.clearAllMocks();
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
    seed({
      ticket: { origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 245828 },
      entries: [fsReply(1043270001, 'Thank you for your email. I am currently out of the office and will return on Monday, October 20 with limited access to email. For urgent matters please contact the IT helpdesk. Kind regards, Rita')],
    });
    await emitTicketEvent('ticket.reply_received', 700, {
      source: 'freshservice_sync', dedupeStamp: 'fs-conversation:1043270001',
      extra: { externalEntryId: 'fs-conversation:1043270001', fromEmail: 'rita@example.com', via: 'freshservice', senderIsAgent: false, isSurveyResponse: false },
    });
    await flush();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(engineExtra()).toMatchObject({ replyVerdict: 'auto_reply' });
    expect(quietLines()).toHaveLength(1);
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
  });

  test('a real reply (or an unclear one) reopens and gets no quiet line', async () => {
    seed({ entries: [reply(1, 'Thanks, but the second monitor still flickers.')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'model', modelVerdict: 'needs_reply' });
    await send();
    await flush();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(engineExtra()).toMatchObject({ replyVerdict: 'reply' });
    expect(quietLines()).toHaveLength(0);
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });

  test('over the monthly limit → the reply reopens (classifyReply says budget_cap)', async () => {
    seed({ entries: [reply(1, 'Thank you all for your patience with me on this one')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'budget_cap', usage: null });
    await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(quietLines()).toHaveLength(0);
  });

  test('timed out → the reply reopens', async () => {
    seed({ entries: [reply(1, 'Thank you all for your patience with me on this one')] });
    followUpMock.classifyReply.mockImplementation(() => new Promise(() => {})); // never answers
    const read = await replyReopen.readReply(rows('ticket')[0], { entryId: 1 }, { timeoutMs: 20 });
    expect(read).toMatchObject({ verdict: 'reply', via: 'timeout' });
  });

  test('a reading that throws → the reply reopens', async () => {
    seed({ entries: [reply(1, 'Thank you all for your patience with me on this one')] });
    followUpMock.classifyReply.mockRejectedValue(new Error('provider down'));
    await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(quietLines()).toHaveLength(0);
  });

  test('an agent forwarding mail onto the ticket is never read as a thank-you', async () => {
    seed({ entries: [reply(1, 'Thanks!')] });
    await send({ entryId: 1, forwardedBy: 'agent@example.com' });
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
  });
});

describe('the Auto-help guard still works', () => {
  const autoHelpClosed = { resolvedByKind: 'auto_help' };

  test('page off: autoHelpReplyVerdict is set exactly as before, nothing else', async () => {
    seed({ ticket: autoHelpClosed, entries: [reply(1, 'Thanks, that worked!')] });
    followUpMock.classifyPostCloseReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords', runId: 901 });
    await send();
    expect(engineExtra()).toMatchObject({ autoHelpReplyVerdict: 'confirmed' });
    expect(engineExtra().replyVerdict).toBeUndefined();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(quietLines()).toHaveLength(0);
  });

  test('page on: Auto-help\'s verdict is reused (no second reading) — it stays closed, both fields set', async () => {
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved', 'Closed'] });
    seed({ ticket: autoHelpClosed, entries: [reply(1, 'Thanks, that worked!')] });
    followUpMock.classifyPostCloseReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords', runId: 901 });
    await send();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(engineExtra()).toMatchObject({ autoHelpReplyVerdict: 'confirmed', replyVerdict: 'thanks' });
    expect(quietLines()).toHaveLength(1);
  });

  test('page on: Auto-help says "help" → reopens', async () => {
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved'] });
    seed({ ticket: autoHelpClosed, entries: [reply(1, 'Still broken')] });
    followUpMock.classifyPostCloseReply.mockResolvedValue({ verdict: 'help', via: 'model', runId: 901 });
    await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
  });

  test('Auto-help waiting on the requester (auto_help park): its own loop reads the reply, the page does not reopen', async () => {
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Pending'] });
    seed({ ticket: { status: 'Pending', parkKind: 'auto_help', parkedUntil: new Date(NOW + 86400e3) }, entries: [reply(1, 'Thanks')] });
    await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
  });
});

describe('the workflow still reopens (page reopen off, thank-you switch on)', () => {
  test('replyVerdict rides on the event; the quiet line only when the ticket is still closed after the workflows', async () => {
    await saveRules({ ignoreThanks: true });
    seed({ entries: [reply(1, 'Thanks!')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(engineExtra()).toMatchObject({ replyVerdict: 'thanks' });
    expect(quietLines()).toHaveLength(1); // the workflow's switch left it closed

    // A workflow without the switch reopened it anyway: no quiet line, follow-ups run.
    jest.clearAllMocks();
    seed({ entries: [reply(2, 'Thanks!')] });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    engineMock.executeForEvent.mockImplementation(async () => { rows('ticket')[0].status = 'Open'; return { status: 'completed' }; });
    await send({ entryId: 2 });
    await flush();
    expect(quietLines()).toHaveLength(0);
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });

  test('a manual "run this one workflow" replay is not a new reply', async () => {
    await saveRules({ reopenOnReply: true, ignoreThanks: true, reopenStatuses: ['Resolved'] });
    seed({ entries: [reply(1, 'Thanks!')] });
    await send({ entryId: 1 }, { onlyWorkflowId: 9764 });
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
  });
});

describe('the reopen workflow it replaces', () => {
  const seeded = (over = {}) => ({
    id: 9764, workspaceId: 1, key: 'ticket_reply_received_reopen', name: 'Reopen on requester reply', triggerType: 'ticket.reply_received',
    isDefaultVariant: true, isEnabled: true, archivedAt: null, publishedVersion: 2, publishedDefinition: buildDefaultWorkflowDefinition('ticket.reply_received'), ...over,
  });
  const reopenPlusMail = () => {
    const def = buildDefaultWorkflowDefinition('ticket.reply_received');
    def.nodes.push({ id: 'mail', type: 'send_email', position: { x: 0, y: 0 }, data: {} });
    return def;
  };

  test('found by trigger + action shape, never by id: reopen-only vs reopen-plus vs not a reopen', () => {
    expect(reopenWorkflowShape(seeded())).toBe('reopen_only');
    expect(reopenWorkflowShape(seeded({ id: 1, name: 'Anything at all' }))).toBe('reopen_only');
    expect(reopenWorkflowShape(seeded({ publishedDefinition: reopenPlusMail() }))).toBe('reopen_plus');
    expect(reopenWorkflowShape(seeded({ triggerType: 'ticket.created' }))).toBeNull();
    expect(reopenWorkflowShape(seeded({ publishedVersion: 0 }))).toBeNull(); // never published: never ran
    const pending = buildDefaultWorkflowDefinition('ticket.reply_received');
    pending.nodes.find((n) => n.type === 'update_ticket').data.setStatus = 'Pending';
    expect(reopenWorkflowShape(seeded({ publishedDefinition: pending }))).toBeNull();
  });

  test('reading the page, saving other switches, or a reply never archives anything', async () => {
    seed({ workflows: [seeded()], entries: [reply(1, 'Thanks!')] });
    await replyReopen.pageContext(1);
    await saveRules({ ignoreThanks: true });
    await send();
    expect(rows('notificationWorkflow')[0].archivedAt).toBeNull();
  });

  test('saved ON: the reopen-only copy (a default variant) is archived, not deleted, and named; a reopen-plus copy is left on', async () => {
    seed({ workflows: [seeded(), seeded({ id: 11400, key: 'custom_reopen_mail', name: 'Reopen and tell the requester', isDefaultVariant: false, publishedDefinition: reopenPlusMail() })] });
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved', 'Closed', 'Pending Response'] });
    const out = await replyReopen.retireReopenWorkflows(1, { email: 'vhaeri@example.com' });
    expect(out.retired).toEqual([expect.objectContaining({ id: 9764, name: 'Reopen on requester reply', wasEnabled: true, by: 'vhaeri@example.com' })]);
    expect(out.kept).toEqual([{ id: 11400, name: 'Reopen and tell the requester', isEnabled: true }]);
    const [wf, plus] = rows('notificationWorkflow');
    expect(wf.archivedAt).toBeInstanceOf(Date);
    expect(wf.isEnabled).toBe(false);
    expect(plus.archivedAt).toBeNull();
    expect(rows('notificationWorkflow')).toHaveLength(2); // nothing deleted

    const page = await replyReopen.pageContext(1);
    expect(page.retiredWorkflows).toEqual([expect.objectContaining({ id: 9764, name: 'Reopen on requester reply' })]);
    expect(page.reopenWorkflows).toEqual([{ id: 11400, name: 'Reopen and tell the requester', isEnabled: true, shape: 'reopen_plus' }]);
    expect(page.statuses.map((s) => s.name)).toEqual(['Pending', 'Pending Response', 'Resolved', 'Closed']);
    expect(page.suggestedReopenStatuses).toEqual(['Resolved', 'Closed', 'Pending Response']);
  });

  test('the default-workflow seeding does not bring a retired reopen copy back (the other defaults are still put right)', async () => {
    const upsert = jest.fn(async ({ create }) => create);
    db = new Proxy({}, { get: (_t, prop) => (prop === 'notificationWorkflow' ? { upsert } : undefined) });
    repository.resetDefaultWorkflowsMemo();
    await repository.ensureDefaultWorkflows(1);
    const byKey = Object.fromEntries(upsert.mock.calls.map(([args]) => [args.where.workspaceId_key.key, args.update]));
    expect(byKey.ticket_reply_received_reopen).toBeDefined();
    expect('archivedAt' in byKey.ticket_reply_received_reopen).toBe(false);
    expect(byKey.ticket_created).toMatchObject({ archivedAt: null, archivedBy: null });
  });

  test('turning the page reopen OFF does not un-archive; restoring is a deliberate step that switches it back on', async () => {
    seed({ workflows: [seeded()] });
    await saveRules({ reopenOnReply: true, reopenStatuses: ['Resolved'] });
    await replyReopen.retireReopenWorkflows(1, { email: 'vhaeri@example.com' });
    await saveRules({ reopenOnReply: false });
    expect(rows('notificationWorkflow')[0].archivedAt).toBeInstanceOf(Date);
    const page = await replyReopen.pageContext(1);
    expect(page.reopenOnReply).toBe(false);
    expect(page.reopenWorkflows).toEqual([]); // the page says nothing reopens now
    expect(page.retiredWorkflows).toHaveLength(1);

    await replyReopen.restoreRetiredWorkflow(1, 9764, { email: 'vhaeri@example.com' });
    expect(rows('notificationWorkflow')[0]).toMatchObject({ archivedAt: null, isEnabled: true });
    expect((await replyReopen.pageContext(1)).retiredWorkflows).toEqual([]);
  });
});

describe('the reply-reading limit (its own line, not Auto-help\'s)', () => {
  test('this month\'s requester_reply_check spend against the workspace limit; unreadable spend counts as over', async () => {
    seed({
      attempts: [
        { workspaceId: 1, operation: 'requester_reply_check', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 1_000_000, outputTokens: 0, startedAt: new Date() },
        { workspaceId: 1, operation: 'auto_help', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 9_000_000, outputTokens: 0, startedAt: new Date() },
        { workspaceId: 2, operation: 'requester_reply_check', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 9_000_000, outputTokens: 0, startedAt: new Date() },
        { workspaceId: 1, operation: 'requester_reply_check', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 9_000_000, outputTokens: 0, startedAt: new Date('2020-01-01') },
      ],
    });
    await saveRules({ replyCheckMonthlyCapUsd: 5 });
    const state = await replyReopen.budgetState(1);
    expect(state.capUsd).toBe(5);
    expect(state.checks).toBe(1);
    expect(state.spentUsd).toBeGreaterThan(0);
    expect(state.spentUsd).toBeLessThan(5);
    expect(state.exhausted).toBe(false);

    await saveRules({ replyCheckMonthlyCapUsd: 33 }); // not a choice: ignored
    expect((await rulesService.getRequesterReplyRules(1)).replyCheckMonthlyCapUsd).toBe(5);

    const broken = db;
    db = new Proxy({}, { get: (_t, prop) => (prop === 'aiProviderAttempt' ? { findMany: async () => { throw new Error('pool timeout'); } } : broken[prop]) });
    expect(await replyReopen.budgetState(1)).toMatchObject({ exhausted: true, unknown: true });
  });
});
