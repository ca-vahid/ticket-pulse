import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

/**
 * QA 11-24 #4 review (must-fix): the creator of a Ticket Pulse-only workspace
 * is its admin, and the admin "pull from FreshService" routes only checked
 * requireAdmin. In a workspace with FS id 0 they answer 409
 * freshservice_not_linked and never reach syncService; a linked workspace
 * works as before.
 */

const prismaMock = { workspace: { findUnique: jest.fn() } };
const syncServiceMock = {
  syncWeek: jest.fn().mockResolvedValue({ ok: true }),
  backfillDateRange: jest.fn().mockResolvedValue({ ok: true }),
  backfillPickupTimes: jest.fn().mockResolvedValue({ ok: true }),
  backfillThreadEntries: jest.fn().mockResolvedValue({ ok: true }),
  backfillEpisodes: jest.fn().mockResolvedValue({ ok: true }),
  getSyncStatus: jest.fn(() => ({ isRunning: false })),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({ default: { triggerManualSync: jest.fn(), getStatus: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  // wsadmin@example.com is the admin of BOTH workspaces (the creator of the native one).
  default: { getAccessRole: jest.fn(async (email) => (email === 'wsadmin@example.com' ? 'admin' : null)) },
  mergeWorkspaceLists: () => [],
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: syncRoutes } = await import('../src/routes/sync.routes.js');
const { requireFreshServiceLink } = await import('../src/middleware/requireFreshServiceLink.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: settingsRepository } = await import('../src/services/settingsRepository.js');

const NATIVE = 12;
const LINKED = 2;

function makeApp(workspaceId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { email: 'wsadmin@example.com', role: 'viewer', selectedWorkspaceId: workspaceId } };
    req.workspaceId = workspaceId;
    next();
  });
  app.use('/api/sync', syncRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => (
    where.id === NATIVE ? { freshserviceWorkspaceId: 0n } : { freshserviceWorkspaceId: 1000208182n }
  ));
});

const ROUTES = [
  ['/week', { startDate: '2026-11-16', endDate: '2026-11-22' }, 'syncWeek'],
  ['/backfill', { startDate: '2026-01-01', endDate: '2026-01-31' }, 'backfillDateRange'],
  ['/backfill-pickup-times', {}, 'backfillPickupTimes'],
  ['/backfill-thread-entries', {}, 'backfillThreadEntries'],
  ['/backfill-episodes', {}, 'backfillEpisodes'],
];

describe('sync routes refuse an unlinked workspace (its admin included)', () => {
  test.each(ROUTES)('POST /api/sync%s → 409 freshservice_not_linked', async (path, body, method) => {
    const res = await request(makeApp(NATIVE)).post(`/api/sync${path}`).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'freshservice_not_linked' });
    expect(res.body.message).toMatch(/isn't linked to FreshService/);
    expect(syncServiceMock[method]).not.toHaveBeenCalled();
  });

  test('a linked workspace still syncs a week', async () => {
    const res = await request(makeApp(LINKED)).post('/api/sync/week').send({ startDate: '2026-11-16', endDate: '2026-11-22' });
    expect(res.status).toBe(200);
    expect(syncServiceMock.syncWeek).toHaveBeenCalledWith({ startDate: '2026-11-16', endDate: '2026-11-22', workspaceId: LINKED });
  });
});

describe('requireFreshServiceLink', () => {
  const run = async (workspaceId) => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    await requireFreshServiceLink({ workspaceId }, res, next);
    return { res, next };
  };

  test('unlinked → 409; a real FS id and a missing workspace id → next()', async () => {
    let out = await run(NATIVE);
    expect(out.res.status).toHaveBeenCalledWith(409);
    expect(out.next).not.toHaveBeenCalled();
    out = await run(LINKED);
    expect(out.next).toHaveBeenCalledWith();
    out = await run(null);
    expect(out.next).toHaveBeenCalledWith();
  });

  test('a lookup failure goes to the error handler, never through', async () => {
    prismaMock.workspace.findUnique.mockRejectedValueOnce(new Error('db down'));
    const { next } = await run(NATIVE);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('the other admin "sync from FreshService" routes are fenced', () => {
  test('assignment sync-now uses the gate; the group picker lists nothing; ticket-type sync answers 409', () => {
    const assignment = readFileSync(new URL('../src/routes/assignment.routes.js', import.meta.url), 'utf8');
    expect(assignment).toMatch(/router\.post\('\/sync-now', requireAdmin, requireFreshServiceLink,/);
    expect(assignment).toMatch(/if \(isFreshServiceUnlinked\(workspace\)\) return res\.json\(\{ success: true, data: \[\] \}\);/);
    const settings = readFileSync(new URL('../src/routes/settings.routes.js', import.meta.url), 'utf8');
    const block = settings.slice(settings.indexOf("'/ticket-types/sync'"), settings.indexOf("'/ticket-types/sync'") + 1500);
    expect(block).toMatch(/isFreshServiceUnlinked\(workspace\)[\s\S]*status\(409\)[\s\S]*freshservice_not_linked/);
    expect(block.indexOf('isFreshServiceUnlinked')).toBeLessThan(block.indexOf('syncFromFreshService'));
  });
});

describe('settingsRepository marks the link on the FS config', () => {
  test('freshserviceLinked is false for FS id 0 and true for a real id', async () => {
    jest.spyOn(settingsRepository, 'get').mockImplementation(async (key) => (key === 'freshservice_domain' ? 'example' : 'key'));
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ id: NATIVE, freshserviceWorkspaceId: 0n, defaultTimezone: 'America/Vancouver' });
    await expect(settingsRepository.getFreshServiceConfigForWorkspace(NATIVE)).resolves.toMatchObject({ workspaceId: null, freshserviceLinked: false });
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ id: LINKED, freshserviceWorkspaceId: 1000208182n, defaultTimezone: 'America/Vancouver' });
    await expect(settingsRepository.getFreshServiceConfigForWorkspace(LINKED)).resolves.toMatchObject({ workspaceId: '1000208182', freshserviceLinked: true });
  });
});
