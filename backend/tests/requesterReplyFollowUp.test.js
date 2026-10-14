import { jest } from '@jest/globals';

// 13 Oct 2026 — the two things that happen after a requester reply (owner
// away; reply that is really a new request) hang off the ONE event door,
// emitTicketEvent('ticket.reply_received'), after the workflows have run, and
// once per reply. Also: the per-workspace switches and their defaults.

const prismaMock = { ticket: { findUnique: jest.fn() }, technician: { findUnique: jest.fn() } };
const engineMock = { executeForEvent: jest.fn() };
const ownerAwayMock = { afterRequesterReply: jest.fn() };
const newRequestMock = { afterRequesterReply: jest.fn() };
const settingsMock = { get: jest.fn(), set: jest.fn() };
const statusServiceMock = { resolveBaseStatus: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: engineMock }));
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
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ dispatchWebhookEvent: jest.fn(), default: { dispatchWebhookEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: { scheduleRefresh: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: { observeStatusTransition: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: { afterRequesterReply: jest.fn(async () => ({})) } }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { onTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/webPushService.js', () => ({ default: { onTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpFollowUpService.js', () => ({ default: { classifyPostCloseReply: jest.fn(async () => null), onAgentReply: jest.fn() } }));

const { emitTicketEvent } = await import('../src/services/ticketLifecycleNotificationService.js');
const { afterRequesterReplyEvent } = await import('../src/services/requesterReplyFollowUp.js');
const rules = await import('../src/services/requesterReplyRulesService.js');

const RESOLVED_AT = new Date('2026-10-06T20:00:00Z');
const TICKET = {
  id: 700, workspaceId: 1, subject: 'Slow laptop connection', status: 'Resolved', priority: 2, origin: 'freshservice', nativeNumber: null,
  freshserviceTicketId: BigInt(245828), toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date('2026-10-01T09:00:00Z'),
  resolvedAt: RESOLVED_AT, closedAt: null, parkedUntil: null, resolvedByKind: null, assignedTechId: 7,
  workspace: { name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 55, name: 'Karen Wong', email: 'kwong@example.com' },
  assignedTech: { id: 7, name: 'Soheil Example', email: 's@example.com' }, internalCategory: null, internalSubcategory: null, tagLinks: [],
};
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  rules.invalidateRequesterReplyRulesCache();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET });
  statusServiceMock.resolveBaseStatus.mockResolvedValue('Resolved');
  engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
  ownerAwayMock.afterRequesterReply.mockResolvedValue({ rerouted: false, reason: 'owner_not_away' });
  newRequestMock.afterRequesterReply.mockResolvedValue({ suggested: false, reason: 'not_a_new_request' });
  settingsMock.get.mockResolvedValue(null);
  settingsMock.set.mockResolvedValue({});
});

describe('the event door', () => {
  test('a requester reply runs both follow-ups once, AFTER the workflows, with the ticket as it was before them', async () => {
    const order = [];
    engineMock.executeForEvent.mockImplementation(async () => { order.push('workflows'); return { status: 'completed' }; });
    ownerAwayMock.afterRequesterReply.mockImplementation(async () => { order.push('owner_away'); return { rerouted: false }; });
    newRequestMock.afterRequesterReply.mockImplementation(async () => { order.push('new_request'); return { suggested: false }; });
    const extra = { externalEntryId: 'fs-conversation:1043270001', fromEmail: 'kwong@example.com', via: 'freshservice', senderIsAgent: false, isSurveyResponse: false };

    const result = await emitTicketEvent('ticket.reply_received', 700, { source: 'freshservice_sync', dedupeStamp: 'fs-conversation:1043270001', extra });
    await flush();

    expect(result).toEqual({ status: 'completed' });
    expect(order).toEqual(['workflows', 'owner_away', 'new_request']);
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledWith(700, 1, { replyStamp: 'fs-conversation:1043270001' });
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledWith({
      before: { id: 700, workspaceId: 1, status: 'Resolved', statusBase: 'Resolved', resolvedAt: RESOLVED_AT, closedAt: null },
      replyStamp: 'fs-conversation:1043270001',
      extra,
    });
  });

  test('a workflow failure does not stop the follow-ups; other events never start them', async () => {
    engineMock.executeForEvent.mockRejectedValueOnce(new Error('engine down'));
    expect(await emitTicketEvent('ticket.reply_received', 700, { dedupeStamp: 'reply:1', extra: { entryId: 1 } })).toMatchObject({ status: 'failed' });
    await flush();
    expect(ownerAwayMock.afterRequesterReply).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET });
    engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
    await emitTicketEvent('ticket.note_added', 700, { dedupeStamp: 'note:1', extra: { entryId: 2 } });
    await emitTicketEvent('ticket.public_reply_added', 700, { dedupeStamp: 'reply:2', extra: { entryId: 3 } });
    // A manual "run this one workflow" replay of a reply is not a new reply.
    await emitTicketEvent('ticket.reply_received', 700, { dedupeStamp: 'reply:1', extra: { entryId: 1 }, onlyWorkflowId: 9764 });
    await flush();
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
  });
});

describe('afterRequesterReplyEvent', () => {
  test('a survey response or an agent\'s own reply starts neither follow-up', async () => {
    await afterRequesterReplyEvent({ before: TICKET, statusBaseBefore: 'Closed', stamp: 's', extra: { isSurveyResponse: true } });
    await afterRequesterReplyEvent({ before: TICKET, statusBaseBefore: 'Closed', stamp: 's', extra: { senderIsAgent: true } });
    expect(ownerAwayMock.afterRequesterReply).not.toHaveBeenCalled();
    expect(newRequestMock.afterRequesterReply).not.toHaveBeenCalled();
  });

  test('one follow-up throwing never costs the other', async () => {
    ownerAwayMock.afterRequesterReply.mockRejectedValue(new Error('boom'));
    const out = await afterRequesterReplyEvent({ before: TICKET, statusBaseBefore: 'Resolved', stamp: 's', extra: {} });
    expect(out.ownerAway).toBeNull();
    expect(newRequestMock.afterRequesterReply).toHaveBeenCalledTimes(1);
  });
});

describe('the switches', () => {
  test('never saved: ON for IT (workspace 1), OFF everywhere else', async () => {
    expect(await rules.getRequesterReplyRules(1)).toEqual({ rerouteWhenOwnerAway: true, suggestNewRequest: true });
    expect(await rules.getRequesterReplyRules(2)).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: false });
    expect(await rules.getRequesterReplyRules(5)).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: false });
    expect(settingsMock.get).toHaveBeenCalledWith('requester_reply_rules_ws1');
  });

  test('a saved choice wins over the default, one switch at a time', async () => {
    settingsMock.get.mockResolvedValue(JSON.stringify({ rerouteWhenOwnerAway: false }));
    expect(await rules.getRequesterReplyRules(1)).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: true });

    rules.invalidateRequesterReplyRulesCache();
    settingsMock.get.mockResolvedValue(null);
    const saved = await rules.setRequesterReplyRules(5, { suggestNewRequest: true, nonsense: 1, rerouteWhenOwnerAway: 'yes' });
    expect(saved).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: true });
    expect(settingsMock.set).toHaveBeenCalledWith('requester_reply_rules_ws5', JSON.stringify({ rerouteWhenOwnerAway: false, suggestNewRequest: true }));
    expect(await rules.getRequesterReplyRules(5)).toEqual(saved); // from the cache
  });

  test('a settings store that cannot be read means OFF, even for IT', async () => {
    settingsMock.get.mockRejectedValue(new Error('pool timeout'));
    expect(await rules.getRequesterReplyRules(1)).toEqual({ rerouteWhenOwnerAway: false, suggestNewRequest: false });
  });
});
