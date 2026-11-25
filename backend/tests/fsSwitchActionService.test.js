import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — AI write-backs.
//  Off, adopted or TP-born → local fields only, status skipped with the reason;
//  FreshService is never PUT. Connected FS-born → unchanged.

process.env.FS_TAXONOMY_SYNC_WORKSPACE_IDS = '1';

const fsMode = { mode: 'connected' };
const fsGate = jest.fn(async () => fsMode.mode !== 'off');
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {}, fsGate, isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'), onModeChange: jest.fn(() => () => {}),
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
  assignmentConfig: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  technician: { findUnique: jest.fn(), findFirst: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ tpSkillCustomField: null, tpSubskillCustomField: null })) },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(async () => ({})) },
  ticketAssignmentEpisode: { findFirst: jest.fn(), create: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({})) },
  ticketTypeDefinition: {
    findMany: jest.fn(async () => [
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident'], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
      { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['service request'], isActive: true, aiAssignable: true, isDefault: false, fsTypeValue: 'Service Request', sortOrder: 1 },
    ]),
  },
  ticketActivity: { create: jest.fn(async () => ({ id: 1 })), findFirst: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
const settingsRepositoryMock = {
  getFreshServiceConfigForWorkspace: jest.fn(async () => ({ domain: 'example.freshservice.com', apiKey: 'k' })),
  getServiceAccountNames: jest.fn(async () => []),
};
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
const fsClient = {
  updateTicketPriority: jest.fn(async () => ({})),
  updateTicketType: jest.fn(async () => ({})),
  updateTicketCustomFields: jest.fn(async () => ({})),
};
const createFreshServiceClient = jest.fn(() => fsClient);
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient }));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: { queueNotificationsForAssignment: jest.fn(async () => ({})) },
}));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketLifecycleNotifications: jest.fn(async () => ({})) },
}));
const mirrorServiceMock = { enqueueFieldSync: jest.fn(async () => ({})) };
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc } = await import('../src/services/freshServiceActionService.js');

const ticketOf = (over = {}) => ({
  id: 77, freshserviceTicketId: 245001n, origin: 'freshservice', mirrorState: null,
  priority: 2, assessedPriority: 'High', assessedPriorityId: 3, priorityRationale: 'outage',
  ticketType: null, assessedTicketType: 'Incident', tpSkill: null, tpSubskill: null,
  internalCategory: { name: 'Printers' }, internalSubcategory: null, ...over,
});
const runOf = (ticket) => ({ id: 900, ticketId: 77, workspaceId: 1, decision: 'pending_review', recommendation: {}, ticket });

function lastRunUpdate() {
  const calls = prismaMock.assignmentPipelineRun.update.mock.calls;
  return calls[calls.length - 1]?.[0]?.data;
}

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  prismaMock.assignmentConfig.findUnique.mockResolvedValue({ typeWritebackEnabled: true, priorityWritebackEnabled: true, autoCloseNoise: true });
});

describe('priority write-back', () => {
  test('Connected FS-born: unchanged — PUT to FreshService', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce(runOf(ticketOf()));
    await svc.executePriorityWriteback(900, 1, false);
    expect(fsClient.updateTicketPriority).toHaveBeenCalledWith(245001, 3);
    expect(lastRunUpdate()).toEqual(expect.objectContaining({ priorityWritebackStatus: 'synced' }));
  });

  test.each([
    ['off', ticketOf(), 'freshservice_off', false],
    ['connected', ticketOf({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' }), 'adopted', false],
    ['connected', ticketOf({ origin: 'ticketpulse', nativeNumber: 1500, mirrorState: 'mirrored' }), 'ticketpulse_owned', true],
  ])('%s %#: local priority only, recorded skipped (%s)', async (mode, ticket, reason, queuesMirror) => {
    fsMode.mode = mode;
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce(runOf(ticket));
    const out = await svc.executePriorityWriteback(900, 1, false);
    expect(fsClient.updateTicketPriority).not.toHaveBeenCalled();
    expect(createFreshServiceClient).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ priority: 3 }) });
    // An adopted ticket keeps 'adopted'; an FS-born one is never flagged pending.
    const data = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(data.mirrorState).toBe(queuesMirror ? 'pending' : undefined);
    expect(mirrorServiceMock.enqueueFieldSync).toHaveBeenCalledTimes(queuesMirror ? 1 : 0);
    expect(lastRunUpdate()).toEqual(expect.objectContaining({ priorityWritebackStatus: 'skipped', priorityWritebackError: reason }));
    expect(out).toEqual(expect.objectContaining({ success: true, skipped: true, error: reason, localOnly: true }));
  });
});

describe('ticket type write-back', () => {
  test('Off: local type only, skipped freshservice_off', async () => {
    fsMode.mode = 'off';
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ ...runOf(ticketOf()), recommendation: { ticketType: 'Incident' } });
    const out = await svc.executeTicketTypeWriteback(900, 1, false);
    expect(fsClient.updateTicketType).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ ticketType: 'Incident' }) });
    expect(out).toEqual(expect.objectContaining({ skipped: true, error: 'freshservice_off' }));
  });

  test('Connected FS-born: unchanged', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ ...runOf(ticketOf()), recommendation: { ticketType: 'Incident' } });
    await svc.executeTicketTypeWriteback(900, 1, false);
    expect(fsClient.updateTicketType).toHaveBeenCalledWith(245001, 'Incident');
  });
});

describe('category write-back', () => {
  test('adopted: local category only, skipped adopted', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce(runOf(ticketOf({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' })));
    const out = await svc.executeCategoryWriteback(900, 1, false);
    expect(fsClient.updateTicketCustomFields).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ tpSkill: 'Printers', tpSubskill: null }) });
    expect(out).toEqual(expect.objectContaining({ skipped: true, error: 'adopted' }));
    expect(mirrorServiceMock.enqueueFieldSync).not.toHaveBeenCalled();
  });
});

describe('direct priority write-back', () => {
  test('Off: local priority only', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 77, freshserviceTicketId: 245001n, origin: 'freshservice', mirrorState: null });
    const out = await svc.executeDirectPriorityWriteback({ workspaceId: 1, ticketId: 77, priorityId: 4, source: 'urgent-self-escalation' });
    expect(fsClient.updateTicketPriority).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ priority: 4 }) });
    expect(out).toEqual(expect.objectContaining({ success: true, skipped: true, error: 'freshservice_off', localOnly: true }));
  });
});

describe('execute (assignment decision)', () => {
  test('Off FS-born: the decision is applied locally, run recorded skipped freshservice_off, nothing queued', async () => {
    fsMode.mode = 'off';
    const ticket = ticketOf({ assignedTechId: null, status: 'Open', workspaceId: 1, createdAt: new Date() });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ ...runOf(ticket), decision: 'approved', assignedTechId: 9 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket);
    prismaMock.technician.findUnique.mockResolvedValueOnce({ id: 9, name: 'Terry Tech' });
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...ticket, ...data }));

    const out = await svc.execute(900, 1, false);

    expect(createFreshServiceClient).not.toHaveBeenCalled();
    const assignWrite = prismaMock.ticket.update.mock.calls.find(([q]) => q.data.assignedTechId === 9)?.[0];
    expect(assignWrite).toBeTruthy();
    expect(assignWrite.data).not.toHaveProperty('mirrorState');
    expect(lastRunUpdate()).toEqual(expect.objectContaining({ syncStatus: 'skipped', syncError: 'freshservice_off' }));
    expect(mirrorServiceMock.enqueueFieldSync).not.toHaveBeenCalled();
    expect(out).toEqual(expect.objectContaining({ success: true, skipped: true, reason: 'freshservice_off' }));
  });

  test('adopted: local, keeps mirrorState adopted, never queued for the mirror', async () => {
    const ticket = ticketOf({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted', assignedTechId: null, status: 'Open', workspaceId: 1, createdAt: new Date() });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ ...runOf(ticket), decision: 'approved', assignedTechId: 9 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket);
    prismaMock.technician.findUnique.mockResolvedValueOnce({ id: 9, name: 'Terry Tech' });
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...ticket, ...data }));

    await svc.execute(900, 1, false);

    for (const [q] of prismaMock.ticket.update.mock.calls) expect(q.data.mirrorState).toBeUndefined();
    expect(mirrorServiceMock.enqueueFieldSync).not.toHaveBeenCalled();
    expect(lastRunUpdate()).toEqual(expect.objectContaining({ syncStatus: 'skipped', syncError: 'adopted' }));
  });

  test('TP-born (connected): unchanged — local, pending, queued for the mirror, synced', async () => {
    const ticket = ticketOf({ origin: 'ticketpulse', nativeNumber: 1500, mirrorState: 'mirrored', assignedTechId: null, status: 'Open', workspaceId: 1, createdAt: new Date() });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValueOnce({ ...runOf(ticket), decision: 'approved', assignedTechId: 9 });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket);
    prismaMock.technician.findUnique.mockResolvedValueOnce({ id: 9, name: 'Terry Tech' });
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...ticket, ...data }));

    await svc.execute(900, 1, false);

    const assignWrite = prismaMock.ticket.update.mock.calls.find(([q]) => q.data.assignedTechId === 9)?.[0];
    expect(assignWrite.data.mirrorState).toBe('pending');
    expect(mirrorServiceMock.enqueueFieldSync).toHaveBeenCalledWith(1, 77);
    expect(lastRunUpdate()).toEqual(expect.objectContaining({ syncStatus: 'synced' }));
  });
});
