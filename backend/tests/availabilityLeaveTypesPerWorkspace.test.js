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
// email -> workspace ids, for the "is everyone in scope in my workspaces" checks.
let wsOf;

beforeEach(() => {
  jest.clearAllMocks();
  offRows = [];
  agentWorkspaces = [];
  accessWorkspaces = [];
  wsOf = { 'a.person@example.com': [5], 'b.person@example.com': [5], 'c.person@example.com': [9], 'both@example.com': [5, 9] };
  settingsMock.get.mockImplementation(async (key) => (key === 'admin_emails' ? 'super@example.com' : null));
  settingsMock.set.mockResolvedValue();
  prismaMock.workspaceAccess.findFirst.mockImplementation(async ({ where }) => (where.email === 'lead@example.com' && where.role === 'admin' ? { id: 1 } : null));
  prismaMock.workspaceAccess.findMany.mockImplementation(async ({ where }) => {
    if (where.role === 'admin') return where.email === 'lead@example.com' ? [{ workspaceId: 5 }] : [];
    if (where.email?.in) return [];
    return accessWorkspaces.map((workspaceId) => ({ workspaceId }));
  });
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => {
    if (where.email?.in) return where.email.in.flatMap((email) => (wsOf[email] || []).map((workspaceId) => ({ email, workspaceId, name: null })));
    return agentWorkspaces.map((workspaceId) => ({ workspaceId }));
  });
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
    await expect(svc.submit(AGENT, input)).rejects.toThrow(/Working from home isn't available in your workspace/);
    await expect(svc.preview(AGENT, input)).rejects.toThrow(/isn't available in your workspace/);
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
  });

  test('a waiting request keeps its own type even after it is switched off; any other type is checked', async () => {
    offRows = [{ leaveTypeId: 3, workspaceId: 5 }, { leaveTypeId: 4, workspaceId: 5 }];
    agentWorkspaces = [5];
    const person = { email: 'agent@example.com', workdays: null, dailyHours: 8 };
    const shaped = await svc._shape(person, { leaveTypeId: 3, startDate: '2099-12-07' }, { keepTypeId: 3 });
    expect(shaped.leaveType.id).toBe(3);
    await expect(svc._shape(person, { leaveTypeId: 4, startDate: '2099-12-07' }, { keepTypeId: 3 })).rejects.toThrow(/Site visit isn't available in your workspace/);
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

describe('one workspace\'s admin never changes what other workspaces get', () => {
  const RULE = { condition: { kind: 'always' }, outcome: 'needs_approval' };

  test('general settings and offices are the super admins\'', async () => {
    await expect(svc.updateSettings({ outlookEventsEnabled: true }, LEAD)).rejects.toThrow('Only super admins change shared settings');
    await expect(svc.updateSettings({ outlookEventsEnabled: true }, SUPER_AS_ADMIN_OF_5)).rejects.toThrow('Only super admins change shared settings');
    await expect(svc.saveOffice({ name: 'East Office' }, LEAD)).rejects.toThrow('Only super admins change shared settings');
    expect(prismaMock.avSettings.update).not.toHaveBeenCalled();
    expect(prismaMock.avOffice.create).not.toHaveBeenCalled();
  });

  test('the Vacation Tracker import (it can create shared types) is the super admins\'', async () => {
    await expect(svc.importFromVacationTracker(LEAD, { workspaceId: 5 })).rejects.toThrow('Only super admins change shared settings');
  });

  test('a rule for everyone: super admins only, to create, change or delete', async () => {
    await expect(svc.saveRule({ name: 'Everyone', scopeType: 'company', ...RULE }, LEAD)).rejects.toThrow('Only super admins change rules for everyone');
    prismaMock.avRule.findUnique.mockResolvedValue({ id: 4, name: 'Everyone', scopeType: 'company', scopeRef: null, ...RULE });
    await expect(svc.saveRule({ id: 4, name: 'Mine now', scopeType: 'person', scopeRef: 'a.person@example.com', ...RULE }, LEAD)).rejects.toThrow('rules for everyone');
    await expect(svc.deleteRule(4, LEAD)).rejects.toThrow('rules for everyone');
    expect(prismaMock.avRule.create).not.toHaveBeenCalled();
    expect(prismaMock.avRule.update).not.toHaveBeenCalled();
    expect(prismaMock.avRule.delete).not.toHaveBeenCalled();
  });

  test('a rule for a person: only when that person is in a workspace the admin administers', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 7 });
    await expect(svc.saveRule({ name: 'Mine', scopeType: 'person', scopeRef: 'a.person@example.com', ...RULE }, LEAD)).resolves.toMatchObject({ id: 7 });
    await expect(svc.saveRule({ name: 'Someone else\'s', scopeType: 'person', scopeRef: 'c.person@example.com', ...RULE }, LEAD)).rejects.toThrow(/workspaces you administer/);
    expect(prismaMock.avRule.create).toHaveBeenCalledTimes(1);
  });

  test('a rule for a group or an office: only when everyone in it is the admin\'s', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 8 });
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValueOnce([{ email: 'a.person@example.com' }, { email: 'both@example.com' }]);
    await expect(svc.saveRule({ name: 'Group', scopeType: 'group', scopeRef: '2', ...RULE }, LEAD)).resolves.toMatchObject({ id: 8 });
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValueOnce([{ email: 'a.person@example.com' }, { email: 'c.person@example.com' }]);
    await expect(svc.saveRule({ name: 'Mixed group', scopeType: 'group', scopeRef: '3', ...RULE }, LEAD)).rejects.toThrow(/workspaces you administer/);
    prismaMock.avPerson.findMany.mockResolvedValueOnce([{ email: 'a.person@example.com' }, { email: 'c.person@example.com' }]);
    await expect(svc.saveRule({ name: 'Shared office', scopeType: 'office', scopeRef: '12', ...RULE }, LEAD)).rejects.toThrow(/workspaces you administer/);
    prismaMock.avPerson.findMany.mockResolvedValueOnce([]);
    await expect(svc.saveRule({ name: 'Empty office', scopeType: 'office', scopeRef: '13', ...RULE }, LEAD)).rejects.toThrow(/workspaces you administer/);
    // A super admin may, of course.
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'c.person@example.com' }]);
    await expect(svc.saveRule({ name: 'Shared office', scopeType: 'office', scopeRef: '12', ...RULE }, SUPER)).resolves.toMatchObject({ id: 8 });
  });

  test('moving a rule off another workspace\'s person is refused too', async () => {
    prismaMock.avRule.findUnique.mockResolvedValue({ id: 9, name: 'Theirs', scopeType: 'person', scopeRef: 'c.person@example.com', ...RULE });
    await expect(svc.saveRule({ id: 9, name: 'Theirs', scopeType: 'person', scopeRef: 'a.person@example.com', ...RULE }, LEAD)).rejects.toThrow(/workspaces you administer/);
    await expect(svc.deleteRule(9, LEAD)).rejects.toThrow(/workspaces you administer/);
  });

  test('View as an admin of one workspace answers from that workspace', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 10 });
    await expect(svc.saveRule({ name: 'Five', scopeType: 'person', scopeRef: 'a.person@example.com', ...RULE }, SUPER_AS_ADMIN_OF_5)).resolves.toMatchObject({ id: 10 });
    await expect(svc.saveRule({ name: 'Nine', scopeType: 'person', scopeRef: 'c.person@example.com', ...RULE }, SUPER_AS_ADMIN_OF_5)).rejects.toThrow(/workspaces you administer/);
  });

  test('approval groups: a workspace admin manages their own, never one with people elsewhere', async () => {
    prismaMock.avApprovalGroup.create.mockResolvedValue({ id: 20 });
    prismaMock.avApprovalGroup.findUnique.mockResolvedValue({ id: 20, name: 'New', members: [], approvers: [] });
    await expect(svc.saveGroup({ name: 'New', members: ['a.person@example.com'], approvers: ['lead@example.com'] }, LEAD)).resolves.toBeTruthy();
    await expect(svc.saveGroup({ name: 'Reach', members: ['a.person@example.com', 'c.person@example.com'], approvers: ['lead@example.com'] }, LEAD)).rejects.toThrow(/approval groups whose members/);
    // An existing group with someone from elsewhere can't be changed or deleted, even to take them out.
    prismaMock.avApprovalGroup.findUnique.mockResolvedValue({ id: 21, name: 'Mixed', members: [{ email: 'c.person@example.com' }], approvers: [] });
    await expect(svc.saveGroup({ id: 21, name: 'Mixed', members: [], approvers: ['lead@example.com'] }, LEAD)).rejects.toThrow(/approval groups whose members/);
    await expect(svc.deleteGroup(21, LEAD)).rejects.toThrow(/approval groups whose members/);
    expect(prismaMock.avApprovalGroup.delete).not.toHaveBeenCalled();
    await expect(svc.deleteGroup(21, SUPER)).resolves.toEqual({ deleted: true });
  });
});

describe('change history rows', () => {
  test('general settings: only the changed fields', async () => {
    prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, yearStartMonth: 1, outlookEventsEnabled: false, autoRepliesEnabled: false });
    prismaMock.avSettings.update.mockResolvedValue({ id: 1 });
    await svc.updateSettings({ yearStartMonth: 1, outlookEventsEnabled: true }, SUPER);
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'settings', action: 'update', before: { outlookEventsEnabled: false }, after: { outlookEventsEnabled: true } })]);
  });

  test('offices: a new one and a change', async () => {
    prismaMock.avOffice.create.mockResolvedValue({ id: 12, name: 'North Office' });
    await svc.saveOffice({ name: 'North Office', province: 'BC' }, SUPER);
    prismaMock.avOffice.findUnique.mockResolvedValue({ id: 12, name: 'North Office', province: 'BC', timezone: 'America/Vancouver', isActive: true });
    prismaMock.avOffice.update.mockResolvedValue({ id: 12 });
    await svc.saveOffice({ id: 12, name: 'North Office', province: 'BC', timezone: 'America/Edmonton' }, SUPER);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'office', entityId: '12', action: 'create', after: expect.objectContaining({ name: 'North Office' }) }),
      expect.objectContaining({ entity: 'office', entityId: '12', action: 'update', before: { timezone: 'America/Vancouver' }, after: { timezone: 'America/Edmonton' } }),
    ]);
  });

  test('rules: saved and deleted (the deleted one keeps its name)', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 4 });
    await svc.saveRule({ name: 'Two at most', condition: { kind: 'capacity', max: 2 }, outcome: 'needs_approval' }, SUPER);
    prismaMock.avRule.findUnique.mockResolvedValue({ id: 4, name: 'Two at most', scopeType: 'company', condition: { kind: 'capacity', max: 2 }, outcome: 'needs_approval', isActive: true });
    await svc.deleteRule(4, SUPER);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'rule', entityId: '4', action: 'create', workspaceId: null, workspaceIds: [] }),
      expect.objectContaining({ entity: 'rule', entityId: '4', action: 'delete', workspaceIds: [], before: expect.objectContaining({ name: 'Two at most' }) }),
    ]);
  });

  test('a rule for one person is stamped with that person\'s workspaces', async () => {
    prismaMock.avRule.create.mockResolvedValue({ id: 6 });
    await svc.saveRule({ name: 'Notice', scopeType: 'person', scopeRef: 'both@example.com', condition: { kind: 'always' }, outcome: 'needs_approval' }, SUPER);
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'rule', workspaceId: 5, workspaceIds: [5, 9] })]);
  });

  test('approval groups: members and approvers added or removed show as lists', async () => {
    const was = { id: 2, name: 'Five group', description: null, autoApproveTypeIds: [], requireAll: false, isActive: true, members: [{ email: 'a.person@example.com' }], approvers: [{ email: 'lead@example.com' }] };
    const now = { ...was, members: [{ email: 'a.person@example.com' }, { email: 'b.person@example.com' }] };
    prismaMock.avApprovalGroup.findUnique.mockResolvedValueOnce(was).mockResolvedValueOnce(now).mockResolvedValueOnce(now);
    prismaMock.avApprovalGroup.update.mockResolvedValue({ id: 2 });
    await svc.saveGroup({ id: 2, name: 'Five group', members: ['a.person@example.com', 'b.person@example.com'], approvers: ['lead@example.com'] }, LEAD);
    await svc.deleteGroup(2, LEAD);
    expect(recorded()).toEqual([
      expect.objectContaining({ entity: 'approval_group', entityId: '2', action: 'update', before: { members: ['a.person@example.com'] }, after: { members: ['a.person@example.com', 'b.person@example.com'] } }),
      expect.objectContaining({ entity: 'approval_group', entityId: '2', action: 'delete', before: expect.objectContaining({ name: 'Five group' }) }),
    ]);
  });

  test('people: the allowance that changed, stamped with the person\'s workspace', async () => {
    prismaMock.avPerson.findUnique.mockResolvedValue({ email: 'a.person@example.com', officeId: null, startDate: null, workdays: null, dailyHours: 8, isActive: true, entitlementOverrides: null });
    prismaMock.avPerson.update.mockResolvedValue({ id: 7 });
    await svc.updatePerson(7, { entitlementOverrides: { 1: 15 } }, SUPER);
    expect(recorded()).toEqual([expect.objectContaining({
      entity: 'person', entityId: '7', action: 'update', workspaceId: 5, workspaceIds: [5], before: { entitlementOverrides: null }, after: { entitlementOverrides: { 1: 15 } },
    })]);
  });

  test('a person of no workspace: the row is for super admins only, never company-wide', async () => {
    prismaMock.avPerson.findUnique.mockResolvedValue({ email: 'nobody@example.com', officeId: null, startDate: null, workdays: null, dailyHours: 8, isActive: true, entitlementOverrides: null });
    prismaMock.avPerson.update.mockResolvedValue({ id: 8 });
    await svc.updatePerson(8, { dailyHours: 6 }, SUPER);
    expect(recorded()).toEqual([expect.objectContaining({ entity: 'person', workspaceId: null, workspaceIds: [0] })]);
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
    await expect(svc.saveOffice({ name: 'South Office' }, SUPER)).resolves.toMatchObject({ id: 13 });
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
    expect(prismaMock.avSettingsChange.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ workspaceId: null, workspaceIds: { isEmpty: true } }, { workspaceId: { in: [5] } }, { workspaceIds: { hasSome: [5] } }],
    });
    await svc.listSettingsChanges(SUPER);
    expect(prismaMock.avSettingsChange.findMany.mock.calls[1][0].where).toEqual({});
    await expect(svc.listSettingsChanges(AGENT)).rejects.toThrow(/Only administrators/);
  });

  test('who is named as the agent they are, else the e-mail', async () => {
    prismaMock.avSettingsChange.findMany.mockResolvedValue([row(1, { entity: 'settings', action: 'update' }), row(2, { actor: 'unknown.person@example.com', entity: 'settings', action: 'update' })]);
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'lead@example.com', name: 'lead' }]);
    prismaMock.technician.findMany.mockImplementation(async ({ where }) => (where.email?.in?.includes('lead@example.com') ? [{ email: 'Lead@Example.com', name: 'Lee Lead' }] : []));
    const res = await svc.listSettingsChanges(SUPER);
    expect(res.changes.map((c) => [c.actor, c.actorName])).toEqual([['lead@example.com', 'Lee Lead'], ['unknown.person@example.com', null]]);
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
