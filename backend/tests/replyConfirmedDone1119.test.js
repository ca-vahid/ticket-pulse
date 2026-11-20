import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * "Resolve when the requester confirms it's done (waiting tickets)" —
 * 19 Nov 2026, through the one reply door emitTicketEvent('ticket.reply_received'):
 *   - Off (old definitions): today's behaviour, no extra reading;
 *   - the waiting-ticket question and its verdict mapping (fixtures below);
 *   - Shadow: reopens as before, one history row says what Live would do;
 *   - Live: resolved through the quiet update path, ONE private note, no
 *     reopen and no follow-ups; resolving that fails reopens instead;
 *   - Resolved / Closed tickets keep the thank-you reading unchanged;
 *   - the Shadow review list.
 * The model is mocked where the other reply tests mock it (classifyReply).
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
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { resolveAddress: jest.fn(async () => ({ status: 'absent' })) } }));
jest.unstable_mockModule('../src/services/ticketSplitService.js', () => ({ default: { split: jest.fn() } }));
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
const {
  default: replyReopen, REPLY_CHECK_OPERATION, CONFIRMED_DONE_CAUSES, STAYS_CLOSED_ACTIVITY, listConfirmedDone,
} = await import('../src/services/requesterReplyReopenService.js');
const facts = await import('../src/services/replyFacts.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const NOW = Date.now();
const ticketRow = (over = {}) => ({
  id: 700, workspaceId: 1, subject: 'Second monitor flickers', status: 'Pending Response', priority: 2, origin: 'ticketpulse', nativeNumber: 2306,
  freshserviceTicketId: null, toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date(NOW - 6 * 86400e3),
  resolvedAt: null, closedAt: null, parkedUntil: null, parkKind: null, resolvedByKind: null, assignedTechId: 7,
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 55, name: 'Dana Fox', email: 'dana.fox@example.com' },
  assignedTech: { id: 7, name: 'Eli Park', email: 'eli.park@example.com' }, internalCategory: null, internalSubcategory: null, tagLinks: [],
  ...over,
});
const reply = (id, bodyText) => ({
  id, ticketId: 700, workspaceId: 1, eventType: 'reply', authorType: 'requester', incoming: true, isPrivate: false,
  source: 'email_inbound', bodyText, content: bodyText, title: null, rawPayload: null, occurredAt: new Date(),
});
/** The ready-made reopen workflow with the new setting (absent = Off, an old definition). */
const reopenWorkflow = (mode) => {
  const def = buildDefaultWorkflowDefinition('ticket.reply_received');
  if (mode) def.nodes.find((n) => n.id === 'is-resolved').data.resolveConfirmedDone = mode;
  return {
    id: 9764, workspaceId: 1, key: 'ticket_reply_received_reopen', name: 'Reopen on requester reply', triggerType: 'ticket.reply_received',
    isDefaultVariant: true, isEnabled: true, archivedAt: null, publishedVersion: 3, routingMode: 'exclusive', routingPriority: 100,
    publishedDefinition: def,
  };
};
function seed({ ticket = {}, entries = [], mode = null, activities = [] } = {}) {
  db = createFakePrisma({
    ticket: [ticketRow(ticket)],
    ticketThreadEntry: entries,
    notificationWorkflow: [reopenWorkflow(mode)],
    notificationDelivery: [],
    ticketActivity: activities,
    aiProviderAttempt: [],
  });
}
const rows = (name) => db._rows(name);
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const engineExtra = () => engineMock.executeForEvent.mock.calls[0][0].event.extra;
const send = () => emitTicketEvent('ticket.reply_received', 700, { source: 'email_inbound', dedupeStamp: 'reply:1', extra: { entryId: 1, from: 'dana.fox@example.com' } });
const notes = () => rows('ticketThreadEntry').filter((e) => e.authorType === 'system' && e.isPrivate === true);
const whyRows = () => rows('ticketActivity').filter((a) => a.activityType === STAYS_CLOSED_ACTIVITY);
/** The model's answer to the waiting-ticket question. */
const modelSays = (modelVerdict, confidence = 'high') => followUpMock.classifyReply.mockImplementation(async (_ws, _text, o) => (o.reader === 'confirm_done'
  ? { verdict: modelVerdict === 'confirmed_done' && confidence === 'high' ? 'confirmed' : 'help', via: 'model', modelVerdict, confidence }
  : { verdict: 'help', via: 'model', modelVerdict: 'unclear' }));
/** What executeForEvent returns: the condition step's mark, and the reopen when the step passed. */
const runWith = (mode, { reopen = mode !== 'live', dryRun = false } = {}) => async () => {
  if (reopen) rows('ticket')[0].status = 'Open';
  return {
    status: 'completed',
    results: [{
      status: 'completed', workflowId: 9764, executionMode: dryRun ? 'mock' : 'live',
      state: {
        lastCondition: { nodeId: 'is-resolved', passed: mode !== 'live', ...(mode === 'live' ? { source: 'reply_confirmed_done', verdict: 'confirmed_done' } : {}) },
        replyConfirmedDone: { mode, nodeId: 'is-resolved', dryRun },
      },
      steps: [],
    }],
  };
};
/** The quiet update path writes the status (TP-born). */
const quietWrite = () => updateNodeMock.mockImplementation(async (node) => {
  const from = rows('ticket')[0].status;
  rows('ticket')[0].status = node.data.setStatus;
  return { updated: { status: { from, to: node.data.setStatus } } };
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
  updateNodeMock.mockReset();
  statusServiceMock.resolveBaseStatus.mockReset();
  statusServiceMock.resolveBaseStatus.mockImplementation(async (_ws, s) => BASES[String(s || '').toLowerCase()] || null);
  seed();
});

describe('Off — today\'s behaviour (old definitions have no setting)', () => {
  test('a thank-you on a waiting ticket is not read and reopens as before', async () => {
    seed({ entries: [reply(1, 'Yep, much appreciated!')] });
    engineMock.executeForEvent.mockImplementationOnce(async () => { rows('ticket')[0].status = 'Open'; return { status: 'completed', results: [] }; });
    await send();
    await flush();
    expect(followUpMock.classifyReply).not.toHaveBeenCalled();
    expect(engineExtra().replyVerdict).toBe('reply');
    expect(engineExtra().replyConfirmedDone).toBeUndefined();
    expect(whyRows()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });

  test('"off" written out reads the same; the strongest mode across workflows wins', () => {
    expect(facts.confirmDoneNeed([reopenWorkflow(null)])).toBe('off');
    expect(facts.confirmDoneNeed([reopenWorkflow('off')])).toBe('off');
    expect(facts.confirmDoneNeed([reopenWorkflow('shadow')])).toBe('shadow');
    expect(facts.confirmDoneNeed([reopenWorkflow('shadow'), reopenWorkflow('live')])).toBe('live');
    expect(facts.confirmDoneNeed([reopenWorkflow('bogus')])).toBe('off');
  });
});

describe('the waiting-ticket question (fixtures from the production pattern, invented wording)', () => {
  test.each([
    ['Yep, much appreciated!', 'confirmed_done', 'high', true],
    ['All working now, thanks!', 'confirmed_done', 'high', true],
    ['That fixed it, thank you', 'confirmed_done', 'high', true],
    ['Perfect, all sorted', 'confirmed_done', 'high', true],
    ['Thanks, I will ask my contact at the gas company and let you know', 'next_step', 'high', false],
    ['Thanks - I\'ll be in the office Wednesday, I can stop by', 'next_step', 'high', false],
    // Borderline: confirmed_done only when the model is confident.
    ['Thanks for the recommendation; we will follow it', 'confirmed_done', 'medium', false],
    ['Thanks for the recommendation; we will follow it', 'confirmed_done', 'high', true],
  ])('%p → model %p (%p) → confirmed: %p', async (text, modelVerdict, confidence, confirmed) => {
    seed({ entries: [reply(1, text)], mode: 'shadow' });
    modelSays(modelVerdict, confidence);
    await send();
    const call = followUpMock.classifyReply.mock.calls.find((c) => c[2]?.reader === 'confirm_done');
    expect(call).toBeDefined();
    expect(call[1]).toBe(text); // no keyword shortcut: even "Yep, much appreciated!" is asked
    expect(call[2]).toMatchObject({ operation: REPLY_CHECK_OPERATION, subject: 'Second monitor flickers' });
    // "Reply reads as" sees "Other reply" either way, so Shadow reopens exactly as before.
    expect(engineExtra().replyVerdict).toBe('reply');
    expect(engineExtra().replyConfirmedDone === true).toBe(confirmed);
  });

  test('any other answer reads as before: "Other reply" (an out-of-office from the model too, so the thank-you switch does not stop it)', async () => {
    for (const answer of ['still_broken', 'auto_reply', 'question']) {
      jest.clearAllMocks();
      engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [] });
      seed({ entries: [reply(1, 'Thanks, but it flickers again this morning')], mode: 'live' });
      modelSays(answer);
      await send();
      expect(engineExtra()).toMatchObject({ replyVerdict: 'reply' });
      expect(engineExtra().replyConfirmedDone).toBeUndefined();
    }
  });

  test('a workflow that reads "Reply reads as" gets the full answer from the same one call', async () => {
    seed({ entries: [reply(1, 'Thanks, but it flickers again this morning')], mode: 'live' });
    const wf = rows('notificationWorkflow')[0];
    wf.publishedDefinition.nodes.find((n) => n.id === 'is-resolved').data.conditionGroup.conditions.push({ field: 'event.replyVerdict', operator: 'is_not', value: 'new_request' });
    modelSays('still_broken');
    await send();
    expect(followUpMock.classifyReply).toHaveBeenCalledTimes(1);
    expect(engineExtra()).toMatchObject({ replyVerdict: 'still_broken' });
  });

  test('timeout, spend limit or a model error: no confirmation, the ticket reopens', async () => {
    for (const fail of [
      () => followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'budget_cap' }),
      () => followUpMock.classifyReply.mockResolvedValue({ verdict: 'help', via: 'fallback', error: 'provider down' }),
      () => followUpMock.classifyReply.mockRejectedValue(new Error('provider down')),
    ]) {
      jest.clearAllMocks();
      engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [] });
      seed({ entries: [reply(1, 'All working now, thanks!')], mode: 'live' });
      fail();
      await send();
      expect(engineExtra().replyVerdict).toBe('reply');
      expect(engineExtra().replyConfirmedDone).toBeUndefined();
      expect(updateNodeMock).not.toHaveBeenCalled();
    }
    seed({ entries: [reply(1, 'All working now, thanks!')], mode: 'live' });
    followUpMock.classifyReply.mockImplementation(() => new Promise(() => {}));
    const read = await replyReopen.readReply(rows('ticket')[0], { entryId: 1 }, { allowThanks: false, confirmDone: true, timeoutMs: 20 });
    expect(read).toMatchObject({ verdict: 'reply', via: 'timeout' });
  });

  test('an agent\'s forward is never asked', async () => {
    seed({ entries: [reply(1, 'All working now, thanks!')], mode: 'live' });
    modelSays('confirmed_done');
    await emitTicketEvent('ticket.reply_received', 700, { source: 'email_inbound', dedupeStamp: 'reply:1', extra: { entryId: 1, from: 'dana.fox@example.com', forwardedBy: 'eli.park@example.com' } });
    expect(followUpMock.classifyReply.mock.calls.some((c) => c[2]?.reader === 'confirm_done')).toBe(false);
    expect(engineExtra().replyConfirmedDone).toBeUndefined();
  });
});

describe('Shadow — reopens as today and records what Live would do', () => {
  test('one history row with the reason code, the quote and the confidence; no note, no status write; follow-ups run', async () => {
    seed({ entries: [reply(1, 'Yep, much appreciated!')], mode: 'shadow' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('shadow'));
    const result = await send();
    await flush();
    expect(rows('ticket')[0].status).toBe('Open');
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(0);
    expect(whyRows()).toHaveLength(1);
    expect(whyRows()[0].details).toMatchObject({
      cause: CONFIRMED_DONE_CAUSES.SHADOW, note: 'Would have resolved: requester confirmed it\'s done.', verdict: 'confirmed_done',
      mode: 'shadow', confidence: 'high', snippet: 'Yep, much appreciated!', workspaceId: 1, workflowId: 9764, replyEntryId: 1, replyStamp: 'reply:1',
    });
    expect(result.replyOutcome).toMatchObject({ openNow: true, confirmedDone: { mode: 'shadow', outcome: 'recorded' } });
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });

  test('a preview / mock run records nothing', async () => {
    seed({ entries: [reply(1, 'Yep, much appreciated!')], mode: 'shadow' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('shadow', { dryRun: true }));
    await send();
    expect(whyRows()).toHaveLength(0);
  });
});

describe('Live — resolved quietly with one private note', () => {
  test('TP-born: the quiet update path sets Resolved as Ticket Pulse; ONE private note quoting the reply; no follow-ups, no second event', async () => {
    seed({ entries: [reply(1, 'Yep, much appreciated!')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    quietWrite();
    const result = await send();
    await flush();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    const [node, ctx, opts] = updateNodeMock.mock.calls[0];
    expect(node).toMatchObject({ type: 'update_ticket', data: { setStatus: 'Resolved' } });
    expect(ctx.ticket).toEqual({ id: 700, workspaceId: 1 });
    expect(opts.actor).toMatchObject({ name: 'Ticket Pulse', kind: 'system' });
    expect(rows('ticket')[0].status).toBe('Resolved');
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      bodyText: 'Requester confirmed it\'s done: "Yep, much appreciated!"', isPrivate: true, actorName: 'Ticket Pulse', mirrorState: null, eventType: 'note',
    });
    expect(whyRows()).toHaveLength(1);
    expect(whyRows()[0].details).toMatchObject({ cause: CONFIRMED_DONE_CAUSES.LIVE, mode: 'live', confidence: 'high', snippet: 'Yep, much appreciated!' });
    expect(result.replyOutcome).toMatchObject({ openNow: false, confirmedDone: { mode: 'live', outcome: 'resolved' } });
    // No requester e-mail from here: the only event is the reply itself, and no follow-up runs.
    expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
  });

  test('the note quotes the first 160 characters', async () => {
    const long = `All working now, thanks! ${'The second screen came back after the cable swap. '.repeat(6)}`;
    seed({ entries: [reply(1, long)], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    quietWrite();
    await send();
    const quoted = notes()[0].bodyText.match(/^Requester confirmed it's done: "(.*)"$/)[1];
    expect(quoted).toHaveLength(160);
    expect(long.startsWith(quoted)).toBe(true);
  });

  test('FS-born under Live: recorded like Shadow (fsBorn), reopened by the workflow, never resolved', async () => {
    seed({ ticket: { origin: 'freshservice', freshserviceTicketId: 512300, nativeNumber: null }, entries: [reply(1, 'That fixed it, thank you')], mode: 'live' });
    modelSays('confirmed_done');
    // What the engine marks for an FS-born ticket under Live: Shadow, and the step passed.
    engineMock.executeForEvent.mockImplementation(async () => {
      rows('ticket')[0].status = 'Open';
      return { status: 'completed', results: [{ status: 'completed', workflowId: 9764, state: { replyConfirmedDone: { mode: 'shadow', configured: 'live', fsBorn: true, nodeId: 'is-resolved', dryRun: false } } }] };
    });
    const result = await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(0);
    expect(rows('ticket')[0].status).toBe('Open');
    expect(whyRows()[0].details).toMatchObject({ cause: CONFIRMED_DONE_CAUSES.SHADOW, mode: 'shadow', configured: 'live', fsBorn: true });
    expect(result.replyOutcome.confirmedDone).toEqual({ mode: 'shadow', outcome: 'recorded', fsBorn: true });
  });

  test('already in the target base after the write (a duplicate reply event): counts as resolved, no reopen', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock.mockImplementation(async () => { rows('ticket')[0].status = 'Resolved'; return { skipped: true, reason: 'No effective changes' }; });
    const result = await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(rows('ticket')[0].status).toBe('Resolved');
    expect(whyRows()[0].details.cause).toBe(CONFIRMED_DONE_CAUSES.LIVE);
    expect(result.replyOutcome.confirmedDone.outcome).toBe('resolved');
  });

  test('the write throws but the ticket ended Closed: counted as done, never reopened', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock.mockImplementationOnce(async () => { rows('ticket')[0].status = 'Closed'; throw new Error('write raced'); });
    await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(rows('ticket')[0].status).toBe('Closed');
  });

  test('resolving fails and someone else already moved the ticket on: the fallback does not reopen it again', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock.mockImplementationOnce(async () => { rows('ticket')[0].status = 'Open'; return { skipped: true, reason: 'No effective changes' }; });
    const result = await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(result.replyOutcome.confirmedDone).toMatchObject({ mode: 'live', outcome: 'not_waiting' });
    expect(notes()).toHaveLength(0);
  });

  test('resolving and the fallback reopen both fail: a truthful line, no reopen claimed, left Pending', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock.mockRejectedValueOnce(new Error('database busy')).mockRejectedValueOnce(new Error('database still busy'));
    const result = await send();
    expect(updateNodeMock.mock.calls.map((c) => c[0].data.setStatus)).toEqual(['Resolved', 'Open']);
    expect(rows('ticket')[0].status).toBe('Pending Response');
    expect(notes()[0].bodyText).toBe('Requester confirmed it\'s done, but Ticket Pulse couldn\'t resolve or reopen it: database busy; database still busy; left Pending for the normal reopen.');
    expect(notes()[0].bodyText).not.toMatch(/reopened instead/);
    expect(whyRows()[0].details).toMatchObject({ cause: CONFIRMED_DONE_CAUSES.FAILED, reopened: false });
    expect(result.replyOutcome.confirmedDone.outcome).toBe('failed');
  });

  test('the status cannot be read after the run: reopened (the reply is not dropped)', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(async (...args) => {
      const out = await runWith('live')(...args);
      statusServiceMock.resolveBaseStatus.mockResolvedValue(null);
      return out;
    });
    quietWrite();
    const result = await send();
    expect(updateNodeMock.mock.calls.map((c) => c[0].data.setStatus)).toEqual(['Open']);
    expect(rows('ticket')[0].status).toBe('Open');
    expect(whyRows()[0].details).toMatchObject({ cause: CONFIRMED_DONE_CAUSES.FAILED, reopened: true });
    expect(notes()[0].bodyText).toBe('Requester confirmed it\'s done, but resolving failed (its status could not be read); reopened instead.');
    expect(result.replyOutcome.confirmedDone).toMatchObject({ mode: 'live', outcome: 'reopened' });
  });

  test.each(['waiting', 'failed'])('a Live workflow whose run is %p (no hand-over): the normal reopen, recorded like Shadow', async (status) => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [{ status, workflowId: 9764, ...(status === 'failed' ? { error: 'boom' } : { runId: 5, resumeAt: new Date().toISOString() }) }] });
    quietWrite();
    const result = await send();
    expect(updateNodeMock.mock.calls.map((c) => c[0].data.setStatus)).toEqual(['Open']);
    expect(rows('ticket')[0].status).toBe('Open');
    expect(notes()).toHaveLength(0);
    expect(whyRows()[0].details).toMatchObject({ cause: CONFIRMED_DONE_CAUSES.SHADOW, mode: 'shadow', configured: 'live', fallback: status, reopened: true });
    expect(result.replyOutcome.confirmedDone).toMatchObject({ mode: 'shadow', outcome: 'reopened', fallback: status });
  });

  test('a Shadow workflow whose run parked: nothing extra (its resumed run reopens as before)', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'shadow' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed', results: [{ status: 'waiting', workflowId: 9764 }] });
    const result = await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(whyRows()).toHaveLength(0);
    expect(result.replyOutcome.confirmedDone).toBeUndefined();
  });

  test('resolving fails: reopened instead, and the note says so', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock
      .mockRejectedValueOnce(new Error('Failed to write status "Resolved" to FreshService: 503'))
      .mockImplementationOnce(async (node) => { rows('ticket')[0].status = node.data.setStatus; return { updated: { status: { to: node.data.setStatus } } }; });
    const result = await send();
    expect(updateNodeMock.mock.calls.map((c) => c[0].data.setStatus)).toEqual(['Resolved', 'Open']);
    expect(rows('ticket')[0].status).toBe('Open');
    expect(notes()).toHaveLength(1);
    expect(notes()[0].bodyText).toMatch(/^Requester confirmed it's done, but resolving failed \(Failed to write status "Resolved" to FreshService: 503\); reopened instead\.$/);
    expect(whyRows()[0].details.cause).toBe(CONFIRMED_DONE_CAUSES.FAILED);
    expect(result.replyOutcome.confirmedDone).toMatchObject({ mode: 'live', outcome: 'reopened' });
  });

  test('a parent with open children is not resolved (roll-up): reopened instead', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live'));
    updateNodeMock
      .mockResolvedValueOnce({ skipped: true, reason: 'No effective changes' })
      .mockImplementationOnce(async (node) => { rows('ticket')[0].status = node.data.setStatus; return { updated: { status: { to: 'Open' } } }; });
    await send();
    expect(rows('ticket')[0].status).toBe('Open');
    expect(whyRows()[0].details.cause).toBe(CONFIRMED_DONE_CAUSES.FAILED);
  });

  test('no longer waiting after the workflows (another workflow moved it): left alone', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementation(runWith('live', { reopen: true }));
    const result = await send();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(result.replyOutcome.confirmedDone).toEqual({ mode: 'live', outcome: 'not_waiting' });
  });

  test('the same reply dispatched twice: the second run is the engine\'s duplicate skip, nothing more is written', async () => {
    seed({ entries: [reply(1, 'Perfect, all sorted')], mode: 'live' });
    modelSays('confirmed_done');
    engineMock.executeForEvent.mockImplementationOnce(runWith('live'));
    engineMock.executeForEvent.mockResolvedValueOnce({ status: 'completed', results: [{ status: 'skipped', reason: 'Duplicate workflow event', workflowId: 9764 }] });
    quietWrite();
    await send();
    rows('ticket')[0].status = 'Pending Response'; // as if the reply arrived twice before the write was seen
    await send();
    expect(updateNodeMock).toHaveBeenCalledTimes(1);
    expect(notes()).toHaveLength(1);
  });
});

describe('Resolved / Closed tickets keep the thank-you reading unchanged', () => {
  test('a thank-you to a resolved ticket: the closed-ticket reader, verdict thanks, no confirmed-done', async () => {
    seed({ ticket: { status: 'Resolved', resolvedAt: new Date(NOW - 86400e3) }, entries: [reply(1, 'Thanks!')], mode: 'live' });
    followUpMock.classifyReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords' });
    engineMock.executeForEvent.mockImplementation(runWith('live', { reopen: false }));
    await send();
    expect(followUpMock.classifyReply).toHaveBeenCalledTimes(1);
    expect(followUpMock.classifyReply.mock.calls[0][2]).toMatchObject({ reader: 'person' });
    expect(engineExtra().replyVerdict).toBe('thanks');
    expect(engineExtra().replyConfirmedDone).toBeUndefined();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(whyRows().every((r) => !String(r.details.cause || '').startsWith('confirmed_done'))).toBe(true);
  });
});

describe('Shadow review: listConfirmedDone', () => {
  test('lists the Shadow rows with ticket, quote, verdict and confidence; filters by cause and workspace', async () => {
    const row = (ticketId, cause, ws = 1, hoursAgo = 1) => ({
      ticketId, activityType: STAYS_CLOSED_ACTIVITY, performedAt: new Date(NOW - hoursAgo * 3600e3),
      details: { cause, mode: cause === CONFIRMED_DONE_CAUSES.SHADOW ? 'shadow' : 'live', snippet: 'All working now, thanks!', verdict: 'confirmed_done', confidence: 'high', workspaceId: ws, workflowId: 9764 },
    });
    db = createFakePrisma({
      ticket: [ticketRow({ id: 700, status: 'Open' }), ticketRow({ id: 701, nativeNumber: 2307 })],
      ticketActivity: [
        row(700, CONFIRMED_DONE_CAUSES.SHADOW), row(701, CONFIRMED_DONE_CAUSES.LIVE),
        row(701, CONFIRMED_DONE_CAUSES.SHADOW, 2), { ticketId: 700, activityType: STAYS_CLOSED_ACTIVITY, performedAt: new Date(), details: { cause: 'thanks' } },
      ],
    });
    // The fake store has no JSON-path filter: apply the same where by hand, and check its shape.
    const seen = [];
    db.ticketActivity.findMany = async ({ where, take }) => {
      seen.push(where);
      const causes = where.OR.map((o) => o.details.equals);
      const ws = where.AND?.[0]?.details?.equals;
      return db._rows('ticketActivity')
        .filter((a) => a.activityType === where.activityType && causes.includes(a.details?.cause) && (ws === undefined || a.details?.workspaceId === ws))
        .slice(0, take);
    };
    const list = await listConfirmedDone({ workspaceId: 1 });
    expect(seen[0]).toMatchObject({ activityType: 'requester_reply_stays_closed', OR: [{ details: { path: ['cause'], equals: 'confirmed_done_shadow' } }] });
    expect(list).toEqual([expect.objectContaining({
      ticketId: 700, ref: 'TP-2306', workspaceId: 1, cause: 'confirmed_done_shadow', mode: 'shadow', snippet: 'All working now, thanks!',
      verdict: 'confirmed_done', confidence: 'high', workflowId: 9764, statusNow: 'Open',
    })]);
    expect((await listConfirmedDone({ cause: 'all' })).map((r) => r.cause).sort()).toEqual(['confirmed_done', 'confirmed_done_shadow', 'confirmed_done_shadow']);
  });
});
