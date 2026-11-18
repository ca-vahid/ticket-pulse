import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-17 #2-#4 through the HTTP routes: Settings → Teams (workspace admin)
 * and the person's own Teams choices. Names are invented.
 */

const store = { ws: { workspaceId: 3, teamsEnabled: true, defaults: null }, pref: null };
const prismaMock = {
  notificationWorkspaceSetting: {
    findUnique: jest.fn(async () => store.ws),
    upsert: jest.fn(async ({ update }) => { store.ws = { ...store.ws, ...update }; return store.ws; }),
  },
  notificationPreference: {
    findUnique: jest.fn(async () => store.pref),
    upsert: jest.fn(async ({ update }) => { store.pref = { ...(store.pref || {}), ...update }; return store.pref; }),
  },
  ticketNotificationMute: { findMany: jest.fn().mockResolvedValue([]) },
  teamsDelivery: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
  teamsConversation: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  technician: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { findMany: jest.fn().mockResolvedValue([]) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'Health & Safety' }) },
  workspaceAccess: { findMany: jest.fn().mockResolvedValue([]) },
};
const roles = new Map();
const passthrough = (_req, _res, next) => next();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({ requireAdmin: passthrough, requireAuth: passthrough }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({
  default: { isTeamsConfigured: () => true, teamsConfig: () => ({ appId: 'app' }), probe: async () => ({ configured: true }) },
}));
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ getAdminEmails: async () => ['super@example.com'] }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAccessRole: async (email) => roles.get(email) || null } }));
jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({
  default: {},
  resolveAgentTechnician: async (email) => ({ technician: { id: 7, name: 'Sam Okafor', email, workspaceId: 3, timezone: 'America/Vancouver' } }),
}));
for (const m of ['summitWorkshopService', 'notificationPreferenceService', 'agentAlertService', 'userSignatureService', 'webPushService']) {
  jest.unstable_mockModule(`../src/services/${m}.js`, () => ({ default: {} }));
}
jest.unstable_mockModule('../src/services/teamsAssistantSettings.js', () => ({ default: {}, RETENTION_DAYS: 180 }));

const { teamsAdminRouter } = await import('../src/routes/teams.routes.js');
const { default: agentRouter } = await import('../src/routes/agent.routes.js');

function app(email = 'sam.okafor@example.com') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.workspaceId = 3; req.user = { email }; next(); });
  a.use('/api/teams/admin', teamsAdminRouter);
  a.use('/api/agent', agentRouter);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  return a;
}

beforeEach(() => {
  store.ws = { workspaceId: 3, teamsEnabled: true, defaults: null };
  store.pref = null;
  roles.clear();
});

describe('Settings → Teams: digest times and the two new switches', () => {
  test('defaults: one digest time (8:00), both switches off', async () => {
    const res = await request(app()).put('/api/teams/admin/settings').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ digestTimes: ['08:00'], onCallNotice: false, surveyResults: false });
  });

  test('H&S: 9:00 AM and 3:00 PM PT; on-call and survey switches on', async () => {
    const res = await request(app()).put('/api/teams/admin/settings').send({ digestTimes: ['09:00', '15:00'], onCallNotice: true, surveyResults: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ digestTimes: ['09:00', '15:00'], onCallNotice: true, surveyResults: true });
    expect(store.ws.defaults.options.digestTime).toBe('09:00');
    expect(store.ws.defaults.extras).toEqual({ digestTimes: ['15:00'], onCallNotice: true, surveyResults: true });
  });

  test('more than four times, or a bad time, is a 400', async () => {
    expect((await request(app()).put('/api/teams/admin/settings').send({ digestTimes: ['08:00', '09:00', '10:00', '11:00', '12:00'] })).status).toBe(400);
    const bad = await request(app()).put('/api/teams/admin/settings').send({ digestTimes: ['08:00', '3pm'] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/HH:MM/);
  });
});

describe('My Teams choices', () => {
  test('the extra time and the on-call row show once the workspace offers them', async () => {
    store.ws = { workspaceId: 3, teamsEnabled: true, defaults: { events: {}, options: { digestTime: '09:00' }, extras: { digestTimes: ['15:00'], onCallNotice: true } } };
    const res = await request(app()).get('/api/agent/teams?workspaceId=3');
    expect(res.status).toBe(200);
    expect(res.body.data.digestTimes).toEqual(['09:00', '15:00']);
    expect(res.body.data.options.digestSlots).toEqual([]);
    const keys = res.body.data.events.map((e) => e.key);
    expect(keys).toContain('on_call_start');
    expect(keys).not.toContain('survey_result');
  });

  test('switching the 3 PM digest on saves it; "Everyone\'s" falls back to Mine for an agent', async () => {
    store.ws = { workspaceId: 3, teamsEnabled: true, defaults: { events: {}, options: {}, extras: { digestTimes: ['15:00'], surveyResults: true } } };
    const res = await request(app()).put('/api/agent/teams/preferences').send({ workspaceId: 3, events: { survey_result: 'teams' }, options: { digestSlots: ['15:00'], surveyScope: 'all' } });
    expect(res.status).toBe(200);
    expect(store.pref.options).toEqual({ digestSlots: ['15:00'] });
    expect(res.body.data.surveyScopeChoice).toBe(false);
    expect(res.body.data.options.surveyScope).toBe('mine');
  });

  test('a reviewer (or a super admin) keeps "Everyone\'s"', async () => {
    store.ws = { workspaceId: 3, teamsEnabled: true, defaults: { events: {}, options: {}, extras: { surveyResults: true } } };
    roles.set('priya.nair@example.com', 'reviewer');
    const res = await request(app('priya.nair@example.com')).put('/api/agent/teams/preferences').send({ workspaceId: 3, events: { survey_result: 'digest' }, options: { surveyScope: 'all' } });
    expect(store.pref.options).toEqual({ surveyScope: 'all' });
    expect(res.body.data.surveyScopeChoice).toBe(true);
    const sup = await request(app('super@example.com')).get('/api/agent/teams?workspaceId=3');
    expect(sup.body.data.surveyScopeChoice).toBe(true);
  });
});
