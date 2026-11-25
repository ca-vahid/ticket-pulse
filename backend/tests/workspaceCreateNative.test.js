import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-24 #4: super admins create Ticket Pulse-only workspaces.
 *  - POST /api/workspaces/native is for the GLOBAL admin role only: a
 *    workspace admin or a viewer gets 403 super_admin_required.
 *  - The slug comes from the name, avoids reserved page names and every slug
 *    and link name already in use (base, base-2, base-3 …).
 *  - One transaction seeds the workspace (native ticketing on, FS id 0), the
 *    four system statuses, a "General" default group, IT's ticket types
 *    without FS ids, and an admin grant for the creator; Access history gets
 *    workspace_created + role_granted.
 */

const tx = {
  workspace: { create: jest.fn(), update: jest.fn() },
  ticketStatusDefinition: { createMany: jest.fn() },
  group: { create: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn(), createMany: jest.fn() },
  workspaceAccess: { upsert: jest.fn() },
};
const prismaMock = {
  workspace: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  appSettings: { findMany: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(tx)),
};
const recordAccessEvent = jest.fn().mockResolvedValue({});
const initDefaults = {
  businessHours: jest.fn(), llm: jest.fn(), noise: jest.fn(), sync: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/accessAuditService.js', () => ({
  recordAccessEvent,
  listAccessEvents: jest.fn(),
  ACTIONS: { WORKSPACE_CREATED: 'workspace_created', ROLE_GRANTED: 'role_granted', ROLE_CHANGED: 'role_changed', ACCESS_REVOKED: 'access_revoked', DASHBOARD_VIEW_CHANGED: 'dashboard_view_changed' },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: jest.fn().mockResolvedValue(null), getAll: jest.fn().mockResolvedValue([]), getMergedWorkspaces: jest.fn().mockResolvedValue([]) },
  mergeWorkspaceLists: () => [],
}));
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ default: express.Router(), resolveUserAccess: jest.fn() }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getFreshServiceConfig: jest.fn() },
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { initializeDefaultBusinessHours: initDefaults.businessHours } }));
jest.unstable_mockModule('../src/services/llmConfigService.js', () => ({ default: { initializeDefaultConfig: initDefaults.llm } }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { seedDefaults: initDefaults.noise } }));
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({ default: { startForWorkspace: initDefaults.sync } }));
jest.unstable_mockModule('../src/services/holidayAutoloadService.js', () => ({ default: { ensureHolidaysLoaded: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: () => false, searchUsers: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: workspaceRoutes } = await import('../src/routes/workspace.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { slugifyWorkspaceName, uniqueSlug, createNativeWorkspace } = await import('../src/services/workspaceCreationService.js');

function makeApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = user ? { user } : {}; next(); });
  app.use('/api/workspaces', workspaceRoutes);
  app.use(errorHandler);
  return app;
}

const superAdmin = { email: 'Root@Example.com', role: 'admin' };
const wsAdmin = { email: 'wsadmin@example.com', role: 'viewer', selectedWorkspaceId: 1 };

function wireHappyPath() {
  prismaMock.workspace.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['example.com', 'Example.org'] });
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, slug: 'it' }, { id: 6, slug: 'facilities' }]);
  prismaMock.appSettings.findMany.mockResolvedValue([{ value: 'facilities-2' }]);
  tx.workspace.create.mockImplementation(async ({ data }) => ({ id: 12, ...data, freshserviceWorkspaceId: 0 }));
  tx.workspace.update.mockImplementation(async ({ data }) => ({
    id: 12, name: 'Facilities', slug: 'facilities-3', freshserviceWorkspaceId: 0, nativeTicketingEnabled: true, isActive: true, ...data,
  }));
  tx.ticketStatusDefinition.createMany.mockResolvedValue({ count: 4 });
  tx.group.create.mockResolvedValue({ id: 501, name: 'General' });
  tx.ticketTypeDefinition.findMany.mockResolvedValue([
    { id: 1, name: 'Incident', description: 'Broken', aliases: ['inc'], fsTypeValue: 'Incident', fsChoiceId: 9n, aiAssignable: true, isDefault: true, color: 'red', abbreviation: 'INC', sortOrder: 0 },
    { id: 2, name: 'Service Request', description: null, aliases: [], fsTypeValue: 'Service Request', fsChoiceId: 10n, aiAssignable: true, isDefault: false, color: 'blue', abbreviation: 'SR', sortOrder: 1 },
  ]);
  tx.ticketTypeDefinition.createMany.mockResolvedValue({ count: 2 });
  tx.workspaceAccess.upsert.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
  wireHappyPath();
});

describe('role gating', () => {
  test('a workspace admin gets 403 super_admin_required and nothing is written', async () => {
    const res = await request(makeApp(wsAdmin)).post('/api/workspaces/native').send({ name: 'Facilities' });
    expect(res.status).toBe(403);
    expect(res.body.code || res.body.error?.code).toBe('super_admin_required');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('signed out → refused before the handler', async () => {
    const res = await request(makeApp(null)).post('/api/workspaces/native').send({ name: 'Facilities' });
    expect([401, 403]).toContain(res.status);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('a super admin creates it: 201, defaults initialised, FS sync start asked (and it skips itself)', async () => {
    const res = await request(makeApp(superAdmin)).post('/api/workspaces/native').send({ name: 'Facilities', defaultTimezone: 'America/Edmonton' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 12, slug: 'facilities-3', nativeTicketingEnabled: true, defaultInternalGroupId: 501, creatorGranted: true });
    expect(res.body.data.seeded).toEqual({ statuses: ['Open', 'Pending', 'Resolved', 'Closed'], group: { id: 501, name: 'General' }, ticketTypes: ['Incident', 'Service Request'] });
    expect(initDefaults.businessHours).toHaveBeenCalledWith(12);
    expect(initDefaults.llm).toHaveBeenCalledWith(12);
  });

  test('bad input is a 400, a taken name a 409', async () => {
    let res = await request(makeApp(superAdmin)).post('/api/workspaces/native').send({ name: '   ' });
    expect(res.status).toBe(400);
    res = await request(makeApp(superAdmin)).post('/api/workspaces/native').send({ name: 'Ops', defaultTimezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    prismaMock.workspace.findFirst.mockResolvedValueOnce({ id: 3, isActive: true });
    res = await request(makeApp(superAdmin)).post('/api/workspaces/native').send({ name: 'IT' });
    expect(res.status).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('slug', () => {
  test('derived from the name, never a page name or a ticket number', () => {
    expect(slugifyWorkspaceName('Health & Safety (West)')).toBe('health-and-safety-west');
    expect(slugifyWorkspaceName('  Café Ops  ')).toBe('cafe-ops');
    expect(slugifyWorkspaceName('!!!')).toBe('team');
    expect(slugifyWorkspaceName('Workspace')).toBe('workspace-ws');
    expect(slugifyWorkspaceName('1234')).toBe('1234-ws');
    expect(slugifyWorkspaceName('Tickets')).toBe('tickets-ws');
    expect(slugifyWorkspaceName('A very long workspace name that keeps on going').length).toBeLessThanOrEqual(30);
  });

  test('unique against every slug and link name in use', () => {
    expect(uniqueSlug('facilities', new Set(['it']))).toBe('facilities');
    expect(uniqueSlug('facilities', new Set(['facilities', 'facilities-2']))).toBe('facilities-3');
    const long = 'a'.repeat(30);
    expect(uniqueSlug(long, new Set([long]))).toBe(`${'a'.repeat(28)}-2`);
  });
});

describe('seed', () => {
  test('one transaction: workspace with FS id 0 + native on, 4 system statuses, General group as default, IT types without FS ids, creator admin', async () => {
    const out = await createNativeWorkspace({ name: 'Facilities', actorEmail: 'Root@Example.com' });

    const created = tx.workspace.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ name: 'Facilities', slug: 'facilities-3', nativeTicketingEnabled: true, isActive: true, defaultTimezone: 'America/Vancouver' });
    expect(created.freshserviceWorkspaceId).toBe(0n);
    // Internal domains copied from IT, cleaned.
    expect(created.internalDomains).toEqual(['example.com', 'example.org']);

    const statuses = tx.ticketStatusDefinition.createMany.mock.calls[0][0].data;
    expect(statuses.map((s) => [s.name, s.baseStatus, s.isSystem])).toEqual([
      ['Open', 'Open', true], ['Pending', 'Pending', true], ['Resolved', 'Resolved', true], ['Closed', 'Closed', true],
    ]);
    expect(statuses.every((s) => s.workspaceId === 12)).toBe(true);

    expect(tx.group.create).toHaveBeenCalledWith({ data: { workspaceId: 12, name: 'General', origin: 'local', freshserviceId: null, isActive: true } });
    expect(tx.workspace.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { defaultInternalGroupId: 501 } });

    expect(tx.ticketTypeDefinition.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 1, isActive: true });
    const types = tx.ticketTypeDefinition.createMany.mock.calls[0][0].data;
    expect(types.map((t) => [t.name, t.fsTypeValue, t.fsChoiceId, t.source, t.workspaceId])).toEqual([
      ['Incident', null, null, 'manual', 12], ['Service Request', null, null, 'manual', 12],
    ]);

    expect(tx.workspaceAccess.upsert).toHaveBeenCalledWith({
      where: { email_workspaceId: { email: 'root@example.com', workspaceId: 12 } },
      update: { role: 'admin' },
      create: { email: 'root@example.com', workspaceId: 12, role: 'admin' },
    });
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 12, action: 'workspace_created', actorEmail: 'root@example.com', targetLabel: expect.any(String) }));
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 12, action: 'role_granted', targetEmail: 'root@example.com', newValue: 'admin' }));
    expect(out.creatorGranted).toBe(true);
  });

  test('explicit internal domains replace the copy; a slug race surfaces as a 409-class conflict', async () => {
    await createNativeWorkspace({ name: 'Lab', internalDomains: ['user@Lab.example.com', 'bad', 'lab.example.com'], actorEmail: 'root@example.com' });
    expect(tx.workspace.create.mock.calls[0][0].data.internalDomains).toEqual(['lab.example.com']);

    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    await expect(createNativeWorkspace({ name: 'Lab 2', actorEmail: 'root@example.com' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
