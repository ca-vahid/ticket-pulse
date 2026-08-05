import { jest } from '@jest/globals';

/**
 * Phase 8b (QA 08-04 #12): dashboards must count custom statuses under their
 * BASE status. statsCalculator receives a per-request `statusSets` bundle
 * (resolved once via statusService.baseStatusSets) — a Pending-base "Needs
 * Rework" ticket counts as open/pending; a Resolved-base "Fixed" one counts
 * as closed. Omitting statusSets keeps the canonical-4 behavior byte-for-byte.
 */

const prismaMock = {
  ticketStatusDefinition: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: statusService, invalidateStatusCache } = await import('../src/services/statusService.js');
const { calculateTechnicianDailyStats, calculateTechnicianWeeklyStats } = await import('../src/services/statsCalculator.js');

const ROWS = [
  { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
  { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
  { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
  { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
  { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
  { id: 6, workspaceId: 1, name: 'In Triage', baseStatus: 'Open', sortOrder: 5, isSystem: false, isActive: true },
  { id: 7, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', sortOrder: 6, isSystem: false, isActive: true },
];

const now = new Date();
const rangeStart = new Date(now.getTime() - 12 * 3600 * 1000);
const rangeEnd = new Date(now.getTime() + 12 * 3600 * 1000);

const mkTicket = (id, status, extra = {}) => ({
  id,
  status,
  createdAt: new Date(now.getTime() - 2 * 3600 * 1000),
  firstAssignedAt: new Date(now.getTime() - 1 * 3600 * 1000),
  isSelfPicked: false,
  assignedBy: 'Cora Coordinator',
  csatScore: null,
  csatSubmittedAt: null,
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateStatusCache();
  prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(ROWS);
});

describe('statusService.baseStatusSets', () => {
  test('bundles active names into base-keyed Sets', async () => {
    const sets = await statusService.baseStatusSets(1);
    expect([...sets.open]).toEqual(['Open', 'In Triage']);
    expect([...sets.pending]).toEqual(['Pending', 'Needs Rework']);
    expect([...sets.openLike]).toEqual(['Open', 'In Triage', 'Pending', 'Needs Rework']);
    expect([...sets.terminal]).toEqual(['Resolved', 'Closed', 'Fixed']);
  });

  test('is cache-backed: repeated + concurrent resolutions cost one DB read', async () => {
    await Promise.all([
      statusService.baseStatusSets(1),
      statusService.baseStatusSets(1),
      statusService.statusNamesForBase(1, ['Open', 'Pending']),
    ]);
    await statusService.baseStatusSets(1);
    expect(prismaMock.ticketStatusDefinition.findMany).toHaveBeenCalledTimes(1);
  });

  test('canonical fallback when the registry is unreadable', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockRejectedValue(new Error('down'));
    const sets = await statusService.baseStatusSets(2);
    expect([...sets.openLike]).toEqual(['Open', 'Pending']);
    expect([...sets.terminal]).toEqual(['Resolved', 'Closed']);
  });
});

describe('statsCalculator with per-workspace statusSets', () => {
  const tech = (tickets) => ({ id: 7, name: 'Terry Tech', email: 't@x', photoUrl: null, timezone: 'UTC', tickets });

  test('daily stats: "Needs Rework" counts as open+pending, "Fixed" as closed', async () => {
    const statusSets = await statusService.baseStatusSets(1);
    const stats = calculateTechnicianDailyStats(
      tech([
        mkTicket(1, 'Needs Rework'),
        mkTicket(2, 'In Triage'),
        mkTicket(3, 'Fixed'),
        mkTicket(4, 'Open'),
      ]),
      rangeStart, rangeEnd, true, [], statusSets,
    );

    expect(stats.openTicketCount).toBe(3); // Needs Rework + In Triage + Open
    expect(stats.openOnlyCount).toBe(2); // In Triage + Open (Open-base)
    expect(stats.pendingCount).toBe(1); // Needs Rework (Pending-base)
    expect(stats.closedToday).toBe(1); // Fixed (Resolved-base)
  });

  test('weekly stats: custom statuses roll into the weekly closed/open snapshots', async () => {
    const statusSets = await statusService.baseStatusSets(1);
    const stats = calculateTechnicianWeeklyStats(
      tech([mkTicket(1, 'Needs Rework'), mkTicket(2, 'Fixed')]),
      rangeStart, rangeEnd, 'UTC', [], statusSets,
    );
    expect(stats.openTicketCount).toBe(1);
    expect(stats.weeklyClosed).toBe(1);
  });

  test('without statusSets the canonical-4 behavior is unchanged (custom labels fall out)', () => {
    const stats = calculateTechnicianDailyStats(
      tech([mkTicket(1, 'Needs Rework'), mkTicket(2, 'Open'), mkTicket(3, 'Resolved')]),
      rangeStart, rangeEnd, true, [],
    );
    expect(stats.openTicketCount).toBe(1); // only the literal 'Open'
    expect(stats.closedToday).toBe(1); // only the literal 'Resolved'
  });
});
