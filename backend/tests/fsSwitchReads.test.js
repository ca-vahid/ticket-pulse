import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — the smaller FreshService readers.
//  Off → none of them calls FreshService; adopted tickets never read their old
//  FS ticket. Connected → unchanged.

process.env.FS_TAXONOMY_SYNC_WORKSPACE_IDS = '1';

const fsMode = { mode: 'connected' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  ticketLink: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  group: { findMany: jest.fn(async () => []) },
  workspace: { findUnique: jest.fn(async () => null) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const fsClient = {
  _get: jest.fn(async () => ({ data: { ticket: { related_tickets: {} } } })),
  fetchTicket: jest.fn(async () => ({ approval_status: 1, approval_status_name: 'Approved' })),
  addPrivateNote: jest.fn(async () => ({})),
  listGroups: jest.fn(async () => []),
  fetchTicketActivities: jest.fn(async () => []),
  listTicketFormFields: jest.fn(async () => []),
  listCustomObjects: jest.fn(async () => []),
};
const mirrorServiceMock = { getInteractiveClient: jest.fn(async () => fsClient) };
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
const createFreshServiceClient = jest.fn(() => fsClient);
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn(async () => ({ domain: 'example.freshservice.com', apiKey: 'k', workspaceId: 2 })) },
}));

const { syncFsRelations, _resetRelationCache } = await import('../src/services/fsTicketRelationService.js');
const { refreshFsApprovalStatus, resetFsApprovalRefreshCache } = await import('../src/services/fsApprovalRefreshService.js');
const { default: ticketLinkService } = await import('../src/services/ticketLinkService.js');
const { getFsGroups, _resetFsGroupCache } = await import('../src/services/fsHomeGroupService.js');
const { default: skillHierarchyService } = await import('../src/services/skillHierarchyService.js');
const { executeTool } = await import('../src/services/assignmentTools.js');

const fsBorn = { id: 77, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 245001n, mirrorState: null };
const adopted = { ...fsBorn, origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' };

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  prismaMock.ticket.findFirst.mockReset();
  prismaMock.ticket.findUnique.mockReset();
  _resetRelationCache();
  resetFsApprovalRefreshCache();
  _resetFsGroupCache();
});

describe('FreshService parent/child relations', () => {
  test('Off → null, FreshService not asked', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn);
    expect(await syncFsRelations(77, 1, { force: true })).toBeNull();
    expect(fsClient._get).not.toHaveBeenCalled();
  });

  test('Connected FS-born → read as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn);
    await syncFsRelations(77, 1, { force: true });
    expect(fsClient._get).toHaveBeenCalledWith('/tickets/245001?include=related_tickets');
  });
});

describe('FreshService approval refresh', () => {
  test('Off → the stored status stands', async () => {
    fsMode.mode = 'off';
    const t = { ...fsBorn, fsApprovalStatus: 0, fsApprovalStatusName: 'Requested' };
    expect(await refreshFsApprovalStatus(t)).toEqual({ fsApprovalStatus: 0, fsApprovalStatusName: 'Requested' });
    expect(mirrorServiceMock.getInteractiveClient).not.toHaveBeenCalled();
  });

  test('adopted → the stored status stands, even when the caller did not select mirrorState', async () => {
    const { mirrorState, ...bare } = adopted;
    expect(mirrorState).toBe('adopted');
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: 'adopted' });
    await refreshFsApprovalStatus({ ...bare, fsApprovalStatus: null, fsApprovalStatusName: null });
    expect(fsClient.fetchTicket).not.toHaveBeenCalled();
  });

  test('Connected FS-born → refreshed as before', async () => {
    const out = await refreshFsApprovalStatus({ ...fsBorn, fsApprovalStatus: null, fsApprovalStatusName: null });
    expect(fsClient.fetchTicket).toHaveBeenCalledWith(245001);
    expect(out.fsApprovalStatusName).toBe('Approved');
  });
});

describe('parent/child pointer note on the FreshService ticket', () => {
  test('never on an adopted ticket, never while Off; as before otherwise', async () => {
    await ticketLinkService._fsPointerNote(adopted, 1, 'linked');
    fsMode.mode = 'off';
    await ticketLinkService._fsPointerNote(fsBorn, 1, 'linked');
    expect(fsClient.addPrivateNote).not.toHaveBeenCalled();
    fsMode.mode = 'connected';
    await ticketLinkService._fsPointerNote(fsBorn, 1, 'linked');
    expect(fsClient.addPrivateNote).toHaveBeenCalledWith(245001, 'linked');
  });
});

describe('home groups (assignable-only people)', () => {
  test('Off → no FreshService groups', async () => {
    fsMode.mode = 'off';
    expect(await getFsGroups(1, fsClient)).toBeNull();
    expect(fsClient.listGroups).not.toHaveBeenCalled();
  });
});

describe('skill hierarchy FreshService routes', () => {
  test.each(['getFreshserviceFields', 'getFreshserviceDrift', 'syncFreshserviceObjects'])('%s → 409 freshservice_off when Off', async (method) => {
    fsMode.mode = 'off';
    await expect(skillHierarchyService[method](1)).rejects.toMatchObject({ statusCode: 409, code: 'freshservice_off' });
    expect(createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('Connected → reads FreshService as before', async () => {
    await skillHierarchyService.getFreshserviceFields(1);
    expect(fsClient.listTicketFormFields).toHaveBeenCalled();
  });
});

describe('AI tool: get_freshservice_activities', () => {
  test('Off → empty, with the note "FreshService is off for this workspace"', async () => {
    fsMode.mode = 'off';
    const out = await executeTool('get_freshservice_activities', { freshservice_ticket_id: 245001 }, { workspaceId: 1, ticketId: 77 });
    expect(out).toEqual(expect.objectContaining({ activityCount: 0, activities: [], note: 'FreshService is off for this workspace' }));
    expect(fsClient.fetchTicketActivities).not.toHaveBeenCalled();
  });

  test('adopted → empty, FreshService not asked', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ mirrorState: 'adopted' });
    const out = await executeTool('get_freshservice_activities', { freshservice_ticket_id: 245001 }, { workspaceId: 1, ticketId: 77 });
    expect(out.activityCount).toBe(0);
    expect(fsClient.fetchTicketActivities).not.toHaveBeenCalled();
  });

  test('Connected FS-born → read as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ mirrorState: null });
    await executeTool('get_freshservice_activities', { freshservice_ticket_id: 245001 }, { workspaceId: 1, ticketId: 77 });
    expect(fsClient.fetchTicketActivities).toHaveBeenCalledWith(245001);
  });
});
