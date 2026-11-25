import { jest } from '@jest/globals';

/**
 * QA 11-24 #4: the FreshService fallback mirror refused only INACTIVE
 * workspaces (the sandboxes). A workspace made with "New workspace" is active
 * and has FS id 0, and the per-workspace FS config falls back to the global
 * credentials with no workspace filter — so its tickets would land in the real
 * FreshService. The mirror now refuses it at enqueue too.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  mirrorJob: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { buffersForThreadEntry: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }), get: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => ({})) }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn() }, emitTicketEvent: jest.fn(),
}));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

beforeEach(() => {
  jest.clearAllMocks();
  mirrorService._activeCache?.clear?.();
  prismaMock.mirrorJob.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
});

test('an active workspace with FS id 0 gets no mirror job', async () => {
  prismaMock.workspace.findUnique.mockResolvedValue({ isActive: true, freshserviceWorkspaceId: 0n });
  const job = await mirrorService.enqueueTicketCreate({ id: 900, workspaceId: 12 });
  expect(job).toBeNull();
  expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
  expect(prismaMock.workspace.findUnique).toHaveBeenCalledWith({ where: { id: 12 }, select: { isActive: true, freshserviceWorkspaceId: true } });
});

test('an FS-linked active workspace still mirrors', async () => {
  prismaMock.workspace.findUnique.mockResolvedValue({ isActive: true, freshserviceWorkspaceId: 1000208182n });
  const job = await mirrorService.enqueueTicketCreate({ id: 901, workspaceId: 2 });
  expect(job).toMatchObject({ ticketId: 901, kind: 'create_ticket' });
});

test('the inactive sandboxes stay refused', async () => {
  prismaMock.workspace.findUnique.mockResolvedValue({ isActive: false, freshserviceWorkspaceId: 0n });
  expect(await mirrorService.enqueueTicketCreate({ id: 902, workspaceId: 7 })).toBeNull();
});
