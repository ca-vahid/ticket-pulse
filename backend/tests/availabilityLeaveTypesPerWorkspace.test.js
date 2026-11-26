import { jest } from '@jest/globals';

/**
 * Vacation Pulse, 26 Nov 2026: leave types per workspace and the settings
 * change history.
 *   - a type is bookable when it is active and on in at least one workspace
 *     the person belongs to (no row = on; no workspace = every active type),
 *     in the booking form and in the API;
 *   - super admins own the shared list; a workspace admin switches a type on
 *     or off for their own workspace only (View as honoured);
 *   - every settings change writes an av_settings_changes row, and a failed
 *     write never blocks the save.
 * Invented people and workspaces only.
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  workspace: { findMany: jest.fn() },
  avLeaveType: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  avLeaveTypeWorkspace: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  avSettingsChange: { create: jest.fn(), findMany: jest.fn() },
  avSettings: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  avOffice: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  avRule: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  avApprovalGroup: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn() },
  avApprovalGroupApprover: { deleteMany: jest.fn(), upsert: jest.fn() },
  avPerson: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  avRequest: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  holiday: { findMany: jest.fn() },
  calendarLeaveSourceConfig: { findUnique: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn() },
};
const settingsMock = { get: jest.fn(), set: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: { workspaceSettings: jest.fn(), _prefsFor: jest.fn(), _inQuietHours: jest.fn(), _record: jest.fn(), _send: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: { isTeamsConfigured: jest.fn() } }));
jest.unstable_mockModule('../src/services/teamsCards.js', () => ({ textCard: (title, lines, actions) => ({ title, lines, actions }) }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tp.example' }));

const { default: svc, typesOffForWorkspaces } = await import('../src/services/availability/availabilityService.js');
const { changedFields } = await import('../src/services/availability/avSettingsChanges.js');

const SUPER = { email: 'super@example.com', role: 'admin' };
const LEAD = { email: 'lead@example.com', role: 'viewer' }; // admin of workspace 5 only
const SUPER_AS_ADMIN_OF_5 = { email: 'super@example.com', role: 'viewer', viewAs: { mode: 'role', role: 'admin', workspaceId: 5, by: 'super@example.com' } };
const SUPER_AS_REVIEWER = { email: 'super@example.com', role: 'viewer', viewAs: { mode: 'role', role: 'reviewer', workspaceId: 5, by: 'super@example.com' } };
const AGENT = { email: 'agent@example.com', role: 'agent' };

const VACATION = { id: 1, key: 'vacation', name: 'Vacation', isActive: true, unit: 'day', allowHalfDays: true, requiresNote: false, sortOrder: 10 };
const WFH = { id: 3, key: 'wfh', name: 'Working from home', isActive: true, unit: 'day', allowHalfDays: true, requiresNote: false, sortOrder: 30 };
const SITE = { id: 4, key: 'site_visit', name: 'Site visit', isActive: true, unit: 'day', allowHalfDays: true, requiresNote: false, sortOrder: 40 };
const TYPES = { 1: VACATION, 3: WFH, 4: SITE };

let offRows;
let agentWorkspaces;
let accessWorkspaces;

beforeEach(() => {
  jest.clearAllMocks();
  offRows = [];
  agentWorkspaces = [];
  accessWorkspaces = [];
  settingsMock.get.mockImplementation(async (key) => (key === 'admin_emails' ? 'super@example.com' : null));
  settingsMock.set.mockResolvedValue();
  prismaMock.workspaceAccess.findFirst.mockImplementation(async ({ where }) => (where.email === 'lead@example.com' && where.role === 'admin' ? { id: 1 } : null));
  prismaMock.workspaceAccess.findMany.mockImplementation(async ({ where }) => {
    if (where.role === 'admin') return where.email === 'lead@example.com' ? [{ workspaceId: 5 }] : [];
    return accessWorkspaces.map((workspaceId) => ({ workspaceId }));
  });
  prismaMock.technician.findMany.mockImplementation(async () => agentWorkspaces.map((workspaceId) => ({ workspaceId })));
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findMany.mockImplementation(async ({ where }) => [{ id: 5, name: 'Team Five' }, { id: 9, name: 'Team Nine' }]
    .filter((w) => !where?.id?.in || where.id.in.includes(w.id)));
  prismaMock.avLeaveType.findMany.mockResolvedValue([VACATION, WFH, SITE]);
  prismaMock.avLeaveType.findUnique.mockImplementation(async ({ where }) => TYPES[where.id] || null);
  prismaMock.avLeaveType.update.mockImplementation(async ({ where, data }) => ({ ...TYPES[where.id], ...data }));
  prismaMock.avLeaveTypeWorkspace.findMany.mockImplementation(async ({ where }) => (where.enabled === false ? offRows : []));
  prismaMock.avLeaveTypeWorkspace.findUnique.mockResolvedValue(null);
  prismaMock.avLeaveTypeWorkspace.upsert.mockImplementation(async ({ create }) => ({ ...create }));
  prismaMock.avSettingsChange.create.mockResolvedValue({ id: 1 });
  prismaMock.avPerson.findUnique.mockResolvedValue({ id: 7, email: 'agent@example.com', name: 'An Agent', workdays: null, dailyHours: 8 });
  prismaMock.holiday.findMany.mockResolvedValue([]);
});

const recorded = () => prismaMock.avSettingsChange.create.mock.calls.map((c) => c[0].data);

describe('effective leave types', () => {
  test('a type is off only when every workspace of the person switched it off', () => {
    const rows = [{ leaveTypeId: 3, workspaceId: 5 }, { leaveTypeId: 4, workspaceId: 5 }, { leaveTypeId: 4, workspaceId: 9 }];
    expect([...typesOffForWorkspaces(rows, [5])].sort()).toEqual([3, 4]);
    expect([...typesOffForWorkspaces(rows, [5, 9])]).toEqual([4]); // WFH is still on in 9: the union wins
    expect([...typesOffForWorkspaces(rows, [])]).toEqual([]); // no workspace: every active type
    expect([...typesOffForWorkspaces([], [5])]).toEqual([]); // no rows: nothing changes
  });

  test('nothing switched off anywhere: every active type is bookable, and no person lookup is made', async () => {
    const types = await svc.leaveTypesFor(AGENT);
    expect(types.map((t) => [t.id, t.bookable])).toEqual([[1, true], [3, true], [4, true]]);
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
  });

  test('switched off in the person\'s only workspace: listed, but not bookable', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }];
    agentWorkspaces = [5];
    const types = await svc.leaveTypesFor(AGENT);
    expect(types.map((t) => [t.id, t.bookable])).toEqual([[1, true], [3, false], [4, true]]);
    // The agent lookup counts active agents only, matched by e-mail.
    expect(prismaMock.technician.findMany.mock.calls[0][0].where).toMatchObject({ isActive: true });
  });

  test('on in another workspace the person belongs to: bookable', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }];
    agentWorkspaces = [5, 9];
    expect(await svc.isTypeBookableFor('agent@example.com', 3)).toBe(true);
  });

  test('someone who is nobody\'s agent: their workspace memberships count; with none, every active type', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }];
    accessWorkspaces = [5];
    expect(await svc.isTypeBookableFor('member@example.com', 3)).toBe(false);
    accessWorkspaces = [];
    expect(await svc.isTypeBookableFor('member@example.com', 3)).toBe(true);
  });

  test('an unreadable switch table (e.g. before the migration) leaves every active type bookable', async () => {
    prismaMock.avLeaveTypeWorkspace.findMany.mockRejectedValue(new Error('relation does not exist'));
    agentWorkspaces = [5];
    expect((await svc.leaveTypesFor(AGENT)).every((t) => t.bookable)).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  test('the API refuses a switched-off type: submit and preview', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }];
    agentWorkspaces = [5];
    const input = { leaveTypeId: 3, startDate: '2099-12-07', endDate: '2099-12-07' };
    await expect(svc.submit(AGENT, input)).rejects.toThrow(/Working from home is switched off for this team/);
    await expect(svc.preview(AGENT, input)).rejects.toThrow(/switched off/);
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
  });

  test('a waiting request keeps its own type even after it is switched off; any other type is checked', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }, { leaveTypeId: 4, workspaceId: 5 }];
    agentWorkspaces = [5];
    const person = { email: 'agent@example.com', workdays: null, dailyHours: 8 };
    const shaped = await svc._shape(person, { leaveTypeId: 3, startDate: '2099-12-07' }, { keepTypeId: 3 });
    expect(shaped.leaveType.id).toBe(3);
    await expect(svc._shape(person, { leaveTypeId: 4, startDate: '2099-12-07' }, { keepTypeId: 3 })).rejects.toThrow(/Site visit is switched off/);
  });
});

describe('permissions', () => {
  test('a workspace admin cannot change the shared list', async () => {
    await expect(svc.saveLeaveType({ id: 3, name: 'Working from home', isActive: false }, LEAD)).rejects.toThrow(/Only super admins can change the shared leave types/);
    expect(prismaMock.avLeaveType.update).not.toHaveBeenCalled();
    expect(prismaMock.avSettingsChange.create).not.toHaveBeenCalled();
  });

  test('a super admin trying a role on (View as) cannot either', async () => {
    await expect(svc.saveLeaveType({ id: 3, name: 'Working from home', isActive: false }, SUPER_AS_ADMIN_OF_5)).rejects.toThrow(/Only super admins/);
  });

  test('a super admin can, and the history keeps only what changed', async () => {
    prismaMock.avLeaveType.findUnique.mockResolvedValueOnce({ ...WFH, color: 'sky' });
    await svc.saveLeaveType({ id: 3, name: 'Working from home', color: 'sky', isActive: false }, SUPER);
    expect(prismaMock.avLeaveType.update).toHaveBeenCalled();
    expect(recorded()).toEqual([expect.objectContaining({
      actor: 'super@example.com', workspaceId: null, entity: 'leave_type', entityId: '3', action: 'deactivate', before: { isActive: true }, after: { isActive: false },
    })]);
  });

  test('a workspace admin switches a type for their own workspace, never another', async () => {
    const row = await svc.setLeaveTypeWorkspace(LEAD, { leaveTypeId: 3, workspaceId: 5, enabled: false });
    expect(row).toMatchObject({ leaveTypeId: 3, workspaceId: 5, enabled: false, updatedBy: 'lead@example.com' });
    expect(recorded()).toEqual([expect.objectContaining({
      actor: 'lead@example.com', workspaceId: 5, entity: 'leave_type_workspace', entityId: '3', action: 'disable', before: { enabled: true }, after: { enabled: false },
    })]);
    prismaMock.avLeaveTypeWorkspace.upsert.mockClear();
    await expect(svc.setLeaveTypeWorkspace(LEAD, { leaveTypeId: 3, workspaceId: 9, enabled: false })).rejects.toThrow(/workspaces you administer/);
    expect(prismaMock.avLeaveTypeWorkspace.upsert).not.toHaveBeenCalled();
  });

  test('a super admin can switch any workspace; View as answers from the role being tried', async () => {
    await expect(svc.setLeaveTypeWorkspace(SUPER, { leaveTypeId: 3, workspaceId: 9, enabled: false })).resolves.toMatchObject({ workspaceId: 9 });
    await expect(svc.setLeaveTypeWorkspace(SUPER_AS_ADMIN_OF_5, { leaveTypeId: 3, workspaceId: 5, enabled: false })).resolves.toMatchObject({ workspaceId: 5 });
    await expect(svc.setLeaveTypeWorkspace(SUPER_AS_ADMIN_OF_5, { leaveTypeId: 3, workspaceId: 9, enabled: false })).rejects.toThrow(/workspaces you administer/);
    await expect(svc.setLeaveTypeWorkspace(SUPER_AS_REVIEWER, { leaveTypeId: 3, workspaceId: 5, enabled: false })).rejects.toThrow(/workspaces you administer/);
    await expect(svc.setLeaveTypeWorkspace(AGENT, { leaveTypeId: 3, workspaceId: 5, enabled: false })).rejects.toThrow(/workspaces you administer/);
  });

  test('a switch that does not change anything writes no history row', async () => {
    prismaMock.avLeaveTypeWorkspace.findUnique.mockResolvedValueOnce({ leaveTypeId: 3, workspaceId: 5, enabled: false });
    await svc.setLeaveTypeWorkspace(LEAD, { leaveTypeId: 3, workspaceId: 5, enabled: false });
    expect(prismaMock.avSettingsChange.create).not.toHaveBeenCalled();
  });

  test('bad input is refused', async () => {
    await expect(svc.setLeaveTypeWorkspace(SUPER, { leaveTypeId: 3, workspaceId: 'x', enabled: false })).rejects.toThrow(/Pick a workspace/);
    await expect(svc.setLeaveTypeWorkspace(SUPER, { leaveTypeId: 3, workspaceId: 5, enabled: 'no' })).rejects.toThrow(/on or off/);
    await expect(svc.setLeaveTypeWorkspace(SUPER, { leaveTypeId: 99, workspaceId: 5, enabled: false })).rejects.toThrow(/not found/);
  });

  test('the settings page gets the switches the person owns', async () => {
    prismaMock.avLeaveTypeWorkspace.findMany.mockResolvedValue([{ leaveTypeId: 3, workspaceId: 5, enabled: false }]);
    const lead = await svc.leaveTypeAccess(LEAD);
    expect(lead).toMatchObject({ canEditTypes: false, workspaces: [{ id: 5, name: 'Team Five' }] });
    const sup = await svc.leaveTypeAccess(SUPER);
    expect(sup.canEditTypes).toBe(true);
    expect(sup.workspaces.map((w) => w.id)).toEqual([5, 9]);
    expect((await svc.leaveTypeAccess(SUPER_AS_ADMIN_OF_5)).workspaces.map((w) => w.id)).toEqual([5]);
  });
});

describe('change history rows', () => {
  test('general settings: only the changed fields', async () => {
    prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, yearStartMonth: 1, outlookEventsEnabled: false, autoRepliesEnabled: false });
    prismaMock.avSettings.update.mockResolvedValue({ id: 1 });
    await svc.updateSettings({ yearStartMonth: 1, outlookEventsEnabled: true }, LEAD);
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'settings', action: 'update', before: { outlookEventsEnabled: false }, after: { outlookEventsEnabled: true } })]);
  });

  test('offices: a new one and a change', async () => {
    prismaMock.avOffice.create.mockResolvedValue({ id: 12, name: 'North Office' });
    await svc.saveOffice({ name: 'North Office', province: 'BC' }, LEAD);
    prismaMock.avOffice.findUnique.mockResolvedValue({ id: 12, name: 'North Office', province: 'BC', timezone: 'America/Vancouver', isActive: true });
    prismaMock.avOffice.update.mockResolvedValue({ id: 12 });
    await svc.saveOffice({ id: 12, name: 'North Office', province: 'BC', timezone: 'America/Edmonton' }, LEAD);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'office', entityId: '12', action: 'create', after: expect.objectContaining({ name: 'North Office' }) }),
      expect.objectContaining({ entity: 'office', entityId: '12', action: 'update', before: { timezone: 'America/Vancouver' }, after: { timezone: 'America/Edmonton' } }),
    ]);
  });

  test('rules: saved and deleted (the deleted one keeps its name)', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 4 });
    await svc.saveRule({ name: 'Two at most', condition: { kind: 'capacity', max: 2 }, outcome: 'needs_approval' }, LEAD);
    prismaMock.avRule.findUnique.mockResolvedValue({ id: 4, name: 'Two at most', scopeType: 'company', condition: { kind: 'capacity', max: 2 }, outcome: 'needs_approval', isActive: true });
    await svc.deleteRule(4, LEAD);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'rule', entityId: '4', action: 'create' }),
      expect.objectContaining({ entity: 'rule', entityId: '4', action: 'delete', before: expect.objectContaining({ name: 'Two at most' }) }),
    ]);
  });

  test('approval groups: members and approvers added or removed show as lists', async () => {
    const was = { id: 2, name: 'Team Five', description: null, autoApproveTypeIds: [], requireAll: false, isActive: true, members: [{ email: 'a@example.com' }], approvers: [{ email: 'lead@example.com' }] };
    const now = { ...was, members: [{ email: 'a@example.com' }, { email: 'b@example.com' }] };
    prismaMock.avApprovalGroup.findUnique.mockResolvedValueOnce(was).mockResolvedValueOnce(now).mockResolvedValueOnce(now);
    prismaMock.avApprovalGroup.update.mockResolvedValue({ id: 2 });
    await svc.saveGroup({ id: 2, name: 'Team Five', members: ['a@example.com', 'b@example.com'], approvers: ['lead@example.com'] }, LEAD);
    await svc.deleteGroup(2, LEAD);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'approval_group', entityId: '2', action: 'update', before: { members: ['a@example.com'] }, after: { members: ['a@example.com', 'b@example.com'] } }),
      expect.objectContaining({ entity: 'approval_group', entityId: '2', action: 'delete', before: expect.objectContaining({ name: 'Team Five' }) }),
    ]);
  });

  test('people: the allowance that changed', async () => {
    prismaMock.avPerson.findUnique.mockResolvedValue({ email: 'agent@example.com', officeId: null, startDate: null, workdays: null, dailyHours: 8, isActive: true, entitlementOverrides: null });
    prismaMock.avPerson.update.mockResolvedValue({ id: 7 });
    await svc.updatePerson(7, { entitlementOverrides: { 1: 15 } }, SUPER);
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'person', entityId: '7', action: 'update', before: { entitlementOverrides: null }, after: { entitlementOverrides: { 1: 15 } } })]);
  });

  test('the shared calendar import mode, for its workspace', async () => {
    prismaMock.calendarLeaveSourceConfig.findUnique.mockResolvedValue({ workspaceId: 5 });
    await svc.setCalendarImportMode(LEAD, { workspaceId: 5, mode: 'shadow' });
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'calendar_import', workspaceId: 5, before: { mode: 'off' }, after: { mode: 'shadow' } })]);
  });

  test('retiring Vacation Tracker', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([]);
    const hand = jest.spyOn(svc, '_handOverFromVacationTracker').mockResolvedValue({ handedOver: 2, directRowsReplaced: 3, keptUnmatched: [], requestsChecked: 2, failed: [] });
    const wait = jest.spyOn(svc, '_waitForLeaveSync').mockResolvedValue();
    await svc.retireVacationTracker(SUPER, { now: new Date('2099-11-26T18:00:00Z') });
    expect(recorded()).toEqual([expect.objectContaining({
      actor: 'super@example.com', entity: 'settings', entityId: 'vacation_tracker', action: 'retire_vacation_tracker', before: { retired: false }, after: expect.objectContaining({ retired: true, handedOver: 2 }),
    })]);
    hand.mockRestore();
    wait.mockRestore();
  });

  test('a failed history write never blocks the save; it is a warning', async () => {
    prismaMock.avSettingsChange.create.mockRejectedValue(new Error('database is down'));
    prismaMock.avOffice.create.mockResolvedValue({ id: 13, name: 'South Office' });
    await expect(svc.saveOffice({ name: 'South Office' }, LEAD)).resolves.toMatchObject({ id: 13 });
    await expect(svc.setLeaveTypeWorkspace(LEAD, { leaveTypeId: 3, workspaceId: 5, enabled: false })).resolves.toMatchObject({ enabled: false });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringMatching(/could not record a settings change/));
  });

  test('changedFields compares values, not references, and skips untouched keys', () => {
    expect(changedFields({ a: [1, 2], b: 1 }, { a: [1, 2], b: 2, c: undefined })).toEqual({ before: { b: 1 }, after: { b: 2 } });
    expect(changedFields({ a: 1 }, { a: 1 })).toBeNull();
  });
});

describe('recent changes', () => {
  const row = (id, extra) => ({ id, createdAt: new Date('2099-11-26T17:00:00Z'), actor: 'lead@example.com', workspaceId: null, entityId: null, before: null, after: null, ...extra });

  test('a workspace admin sees their workspace and the company-wide changes; a super admin everything', async () => {
    prismaMock.avSettingsChange.findMany.mockResolvedValue([]);
    await svc.listSettingsChanges(LEAD);
    expect(prismaMock.avSettingsChange.findMany.mock.calls[0][0].where).toEqual({ OR: [{ workspaceId: null }, { workspaceId: { in: [5] } }] });
    await svc.listSettingsChanges(SUPER);
    expect(prismaMock.avSettingsChange.findMany.mock.calls[1][0].where).toEqual({});
    await expect(svc.listSettingsChanges(AGENT)).rejects.toThrow(/Only administrators/);
  });

  test('50 a page, with names to read it by', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(100 - i, { entity: 'settings', action: 'update' }));
    rows[0] = row(100, { entity: 'leave_type_workspace', entityId: '3', workspaceId: 5, action: 'disable', before: { enabled: true }, after: { enabled: false } });
    rows[1] = row(99, { entity: 'approval_group', entityId: '8', action: 'delete', before: { name: 'Old group' } });
    prismaMock.avSettingsChange.findMany.mockResolvedValue(rows);
    prismaMock.avLeaveType.findMany.mockResolvedValue([{ id: 3, name: 'Working from home' }]);
    prismaMock.avApprovalGroup.findMany.mockResolvedValue([]);
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'lead@example.com', name: 'Team Lead' }]);
    const res = await svc.listSettingsChanges(SUPER, { page: 2 });
    expect(prismaMock.avSettingsChange.findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 51 });
    expect(res).toMatchObject({ page: 2, pageSize: 50, hasMore: true });
    expect(res.changes).toHaveLength(50);
    expect(res.changes[0]).toMatchObject({ actorName: 'Team Lead', entityName: 'Working from home', workspaceName: 'Team Five', action: 'disable' });
    expect(res.changes[1]).toMatchObject({ entityName: 'Old group', action: 'delete' });
  });
});
