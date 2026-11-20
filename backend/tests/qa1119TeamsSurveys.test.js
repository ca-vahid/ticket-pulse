import { jest } from '@jest/globals';

/**
 * QA 11-19 #1: one survey row ("A survey result comes in"), "Everyone's" for
 * admins only. The retired row "The requester rates my ticket in the survey"
 * (survey_response) still carries a person's choice over, but never sends.
 * Names are invented.
 */

const prismaMock = {
  notificationWorkspaceSetting: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
  notificationPreference: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  ticketNotificationMute: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  teamsDelivery: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  teamsConversation: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  technicianLeave: { findFirst: jest.fn().mockResolvedValue(null) },
  technicianNotificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  ticket: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ nativeTicketingEnabled: true, name: 'Facilities' }) },
  group: { findFirst: jest.fn().mockResolvedValue(null) },
};
const botMock = {
  isTeamsConfigured: jest.fn(() => true),
  teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
  sendToConversation: jest.fn().mockResolvedValue('act-1'),
  cardActivity: jest.fn((card, o) => ({ type: 'message', card, ...o })),
  sendActivityFeed: jest.fn().mockResolvedValue(),
  findUser: jest.fn(),
  installForUser: jest.fn(),
  createPersonalConversation: jest.fn(),
  describeError: (e) => e.message,
};
const roles = new Map();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) } }));
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ getAdminEmails: async () => ['super@example.com'] }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAccessRole: async (email) => roles.get(email) || null } }));

const { default: svc, EVENTS, RETIRED_EVENTS, effectivePrefs, offeredEvents, cleanPrefs } = await import('../src/services/teamsNotificationService.js');
const { default: extras } = await import('../src/services/teamsExtraNotices.js');

// Handlers with no work hours, so "away" never depends on the clock running the tests.
const SAM = { id: 7, name: 'Sam Okafor', email: 'sam.okafor@example.com', timezone: 'America/Vancouver', workStartTime: null, workEndTime: null, workspaceId: 3 };
const ELI = { id: 12, name: 'Eli Park', email: 'eli.park@example.com', timezone: 'America/Vancouver', workStartTime: null, workEndTime: null, workspaceId: 3 };
const PRIYA = { id: 14, name: 'Priya Nair', email: 'priya.nair@example.com', timezone: 'America/Vancouver', workStartTime: null, workEndTime: null, workspaceId: 3 };
const TECHS = { 7: SAM, 12: ELI, 14: PRIYA };
const wsRow = (extrasObj = {}, events = {}) => ({ workspaceId: 3, teamsEnabled: true, defaults: { events, options: {}, extras: extrasObj } });
const TICKET = { id: 1201, workspaceId: 3, subject: 'Badge reader at the front door', freshserviceTicketId: null, nativeNumber: 1201, origin: 'ticketpulse', assignedTechId: 7, requester: { name: 'Dana Fox', email: 'dana.fox@example.com' } };

let prefRows = {};
const sentTo = () => botMock.sendToConversation.mock.calls.map((c) => c[0].conversationId);

beforeEach(() => {
  jest.clearAllMocks();
  roles.clear();
  prefRows = {};
  prismaMock.teamsDelivery.create.mockResolvedValue({});
  prismaMock.teamsDelivery.findMany.mockResolvedValue([]);
  prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
  prismaMock.ticketNotificationMute.findUnique.mockResolvedValue(null);
  prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
  prismaMock.technicianLeave.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
  prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}));
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => TECHS[where.id] || null);
  prismaMock.notificationPreference.findUnique.mockImplementation(async ({ where }) => prefRows[where.workspaceId_technicianId.technicianId] || null);
  prismaMock.notificationPreference.findMany.mockImplementation(async () => Object.entries(prefRows).map(([id, r]) => ({ workspaceId: 3, technicianId: Number(id), ...r })));
  prismaMock.teamsConversation.findUnique.mockImplementation(async ({ where }) => ({ email: where.email, conversationId: `conv-${where.email}`, serviceUrl: 'https://smba.example.com/', aadObjectId: `aad-${where.email}` }));
  botMock.isTeamsConfigured.mockReturnValue(true);
  botMock.sendToConversation.mockResolvedValue('act-1');
});

describe('one row', () => {
  test('"The requester rates my ticket in the survey" is gone from the rows; its key stays readable', () => {
    expect(EVENTS.map((e) => e.key)).not.toContain('survey_response');
    expect(EVENTS.filter((e) => e.key === 'survey_result')).toHaveLength(1);
    expect(RETIRED_EVENTS).toEqual([expect.objectContaining({ key: 'survey_response', label: 'The requester rates my ticket in the survey', replacedBy: 'survey_result' })]);
    // Offered with or without the workspace switch.
    expect(offeredEvents({}).map((e) => e.key)).toContain('survey_result');
    expect(offeredEvents({ surveyResults: true }).map((e) => e.key)).toContain('survey_result');
    // A stored old value survives a save (nothing is migrated or wiped).
    expect(cleanPrefs({ events: { survey_response: 'off' } }, { personal: true }).events).toEqual({ survey_response: 'off' });
  });
});

describe('the old row\'s choice carries over (read time)', () => {
  test('default is Teams', () => {
    expect(effectivePrefs(null, null).events.survey_result).toBe('teams');
  });

  test('an Off on the old row stays Off; a Digest stays Digest', () => {
    expect(effectivePrefs(null, { events: { survey_response: 'off' } }).events.survey_result).toBe('off');
    expect(effectivePrefs(null, { events: { survey_response: 'digest' } }).events.survey_result).toBe('digest');
  });

  test('a saved value for the new row wins over the old one', () => {
    expect(effectivePrefs(null, { events: { survey_response: 'off', survey_result: 'teams' } }).events.survey_result).toBe('teams');
    expect(effectivePrefs(null, { events: { survey_response: 'teams', survey_result: 'off' } }).events.survey_result).toBe('off');
  });

  test('the person\'s own old value beats a workspace default; a workspace default for the old row carries too', () => {
    expect(effectivePrefs({ events: { survey_result: 'digest' } }, { events: { survey_response: 'off' } }).events.survey_result).toBe('off');
    expect(effectivePrefs({ events: { survey_response: 'digest' } }, null).events.survey_result).toBe('digest');
  });

  test('workspace settings carry the effective defaults for the Settings grid', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}, { survey_response: 'off', assigned: 'digest' }));
    const ws = await svc.workspaceSettings(3);
    expect(ws.effectiveDefaults).toMatchObject({ survey_result: 'off', assigned: 'digest', requester_replied: 'teams' });
    expect(ws.effectiveDefaults).not.toHaveProperty('survey_response');
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}, { survey_response: 'off', survey_result: 'digest' }));
    expect((await svc.workspaceSettings(3)).effectiveDefaults.survey_result).toBe('digest');
  });

  test('the old key is no longer in anybody\'s effective rows', () => {
    expect(effectivePrefs(null, { events: { survey_response: 'teams' } }).events).not.toHaveProperty('survey_response');
  });

  test('my status shows the carried Off on the one row', async () => {
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...SAM });
    prefRows[7] = { events: { survey_response: 'off' }, options: {} };
    const me = await svc.myStatus(SAM.email, 3);
    const rows = me.events.filter((e) => e.key.startsWith('survey'));
    expect(rows).toEqual([expect.objectContaining({ key: 'survey_result', mode: 'off', workspaceDefault: 'teams' })]);
    techSpy.mockRestore();
  });

  test('a carried-over Off sends nothing for the handler', async () => {
    prefRows[7] = { events: { survey_response: 'off' }, options: {} };
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, resultKey: '5:1' });
    expect(out).toEqual({ sent: 0, held: 0, skipped: [] });
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
  });
});

describe('your own tickets, with the workspace switch off', () => {
  test('the handler gets the card in Teams by default', async () => {
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, outOf: 5, ratingLabel: 'Great', comment: 'Quick fix', resultKey: '5:1' });
    expect(out).toMatchObject({ sent: 1, held: 0 });
    expect(sentTo()).toEqual([`conv-${SAM.email}`]);
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'survey_result', status: 'sent', technicianId: 7, reason: 'survey:tp:1201:5:1' }) });
  });

  test('nobody else is looked up while the switch is off, even an admin who chose Everyone\'s', async () => {
    roles.set(ELI.email, 'admin');
    prefRows[12] = { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } };
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 4, resultKey: '4:1' });
    expect(out.sent).toBe(1);
    expect(sentTo()).toEqual([`conv-${SAM.email}`]);
    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  test('an agent who answered their own survey is not told', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, requester: { name: 'Sam Okafor', email: 'SAM.OKAFOR@example.com' } });
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, resultKey: '5:1' });
    expect(out).toEqual({ sent: 0, held: 0, skipped: [{ technicianId: 7, why: 'own_answer' }] });
  });
});

describe('"Everyone\'s" is for admins only', () => {
  test('who may choose: super admin and workspace admin yes; reviewer, read-only and agents no', async () => {
    roles.set(ELI.email, 'admin');
    roles.set(PRIYA.email, 'reviewer');
    roles.set('ro@example.com', 'readonly');
    expect(await svc._canSeeAllSurveys('super@example.com', 3)).toBe(true);
    expect(await svc._canSeeAllSurveys(ELI.email, 3)).toBe(true);
    expect(await svc._canSeeAllSurveys(PRIYA.email, 3)).toBe(false);
    expect(await svc._canSeeAllSurveys('ro@example.com', 3)).toBe(false);
    expect(await svc._canSeeAllSurveys(SAM.email, 3)).toBe(false);
  });

  test('on save: a reviewer\'s "Everyone\'s" is not stored; an admin\'s is', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    const statusSpy = jest.spyOn(svc, 'myStatus').mockResolvedValue({ ok: true });
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...PRIYA });
    roles.set(PRIYA.email, 'reviewer');
    await svc.saveMyPrefs(PRIYA.email, 3, { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[0][0].update.options).toEqual({});
    techSpy.mockResolvedValue({ ...ELI });
    roles.set(ELI.email, 'admin');
    await svc.saveMyPrefs(ELI.email, 3, { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[1][0].update.options).toEqual({ surveyScope: 'all' });
    statusSpy.mockRestore(); techSpy.mockRestore();
  });

  test('my status: the choice only for an admin, and only with the switch on', async () => {
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...PRIYA });
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    roles.set(PRIYA.email, 'reviewer');
    expect((await svc.myStatus(PRIYA.email, 3)).surveyScopeChoice).toBe(false);
    roles.set(PRIYA.email, 'admin');
    expect((await svc.myStatus(PRIYA.email, 3)).surveyScopeChoice).toBe(true);
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}));
    expect((await svc.myStatus(PRIYA.email, 3)).surveyScopeChoice).toBe(false);
    techSpy.mockRestore();
  });

  test('on send: a reviewer who saved "Everyone\'s" before gets nothing for others\' tickets; the stored value is left alone', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    roles.set(PRIYA.email, 'reviewer');
    roles.set(ELI.email, 'admin');
    prefRows[14] = { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } };
    prefRows[12] = { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } };
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 3, resultKey: '3:1' });
    expect(out.sent).toBe(2);
    expect(sentTo()).toEqual([`conv-${SAM.email}`, `conv-${ELI.email}`]);
    expect(prismaMock.notificationPreference.upsert).not.toHaveBeenCalled();
    expect(prismaMock.notificationPreference.update).not.toHaveBeenCalled();
  });

  test('a reviewer who handled the ticket still gets their own result', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, assignedTechId: 14 });
    roles.set(PRIYA.email, 'reviewer');
    prefRows[14] = { events: { survey_result: 'teams' }, options: { surveyScope: 'all' } };
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 3, resultKey: '3:2' });
    expect(out.sent).toBe(1);
    expect(sentTo()).toEqual([`conv-${PRIYA.email}`]);
  });
});

describe('one message per Ticket Pulse survey answer', () => {
  // What notifyTicketFeedback() hands both senders for one answer.
  const feedbackCtx = () => ({
    event: { type: 'ticket.feedback_received', occurredAt: new Date().toISOString(), dedupeStamp: 'feedback:1201:1', extra: { score: 5, label: 'Great', comment: 'Quick fix', updated: false, byEmail: 'dana.fox@example.com' } },
    workspace: { id: 3, timezone: 'America/Vancouver' },
    ticket: { id: 1201, displayRef: 'TP-1201', subject: TICKET.subject, priority: 4, groupId: null, internalGroupId: null },
    assignedAgent: { id: 7, name: 'Sam Okafor' },
    requester: { name: 'Dana Fox', email: 'dana.fox@example.com' },
  });

  test('the ticket-event path sends no card, even with the old row on', async () => {
    prefRows[7] = { events: { survey_response: 'teams', survey_result: 'teams' }, options: { respectAway: false } };
    const consider = jest.spyOn(svc, '_consider');
    const queue = jest.spyOn(svc, '_queue');
    await svc._onTicketEvent(feedbackCtx());
    expect(consider).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(svc.pending.size).toBe(0);
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    consider.mockRestore(); queue.mockRestore();
  });

  test('both senders for one answer: exactly one Teams message, the survey result card', async () => {
    prefRows[7] = { events: { survey_response: 'teams' }, options: { respectAway: false } };
    await svc._onTicketEvent(feedbackCtx());
    const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, outOf: 5, ratingLabel: 'Great', comment: 'Quick fix', resultKey: '5:1' });
    expect(out.sent).toBe(1);
    expect(botMock.sendToConversation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(botMock.sendToConversation.mock.calls[0])).toContain('From the Ticket Pulse \\"How did we do?\\" survey.');
    const created = prismaMock.teamsDelivery.create.mock.calls.map((c) => c[0].data.eventKey);
    expect(created).not.toContain('survey_response');
  });
});

describe('FreshService CSAT: the same card and path as before', () => {
  beforeEach(() => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, origin: 'freshservice', freshserviceTicketId: BigInt(244501), nativeNumber: null });
  });

  test('found by FS id, the FreshService card, keyed once per response, only recent, only in the app', async () => {
    const running = jest.spyOn(svc, 'isRunning').mockReturnValue(true);
    const now = new Date('2026-11-19T20:00:00Z');
    const out = await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, outOf: 4, ratingLabel: 'Happy', submittedAt: new Date('2026-11-19T18:00:00Z'), resultKey: '777', now });
    expect(out.sent).toBe(1);
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ freshserviceTicketId: BigInt(244501) });
    expect(JSON.stringify(botMock.sendToConversation.mock.calls[0])).toContain('From the FreshService satisfaction survey.');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'survey_result', status: 'sent', reason: 'survey:fs:1201:777' }) });
    prismaMock.teamsDelivery.findFirst.mockResolvedValue({ id: 1 });
    expect((await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, resultKey: '777', submittedAt: new Date('2026-11-19T18:00:00Z'), now })).skipped).toEqual([{ technicianId: 7, why: 'already' }]);
    expect((await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, submittedAt: new Date('2026-11-01T18:00:00Z'), now })).off).toBe('old');
    running.mockReturnValue(false);
    expect((await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3 })).off).toBe('not_in_app');
    running.mockRestore();
  });
});
