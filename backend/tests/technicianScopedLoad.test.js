import { jest } from '@jest/globals';

/**
 * QA 09-25 (slow agent page): the technician daily/weekly/monthly endpoints
 * used to load EVERY lifetime ticket of the person (full width) and filter in
 * memory. They now load only the period's tickets + the open-like backlog +
 * the period's CSAT (technicianRepository.getByIdScoped).
 *
 * This suite pins that the scoped load yields byte-identical stats and ticket
 * lists to the old lifetime load, for a noisy fixture that straddles every
 * boundary (timezone edges, never-assigned tickets, CSAT on old tickets,
 * parked, custom statuses, noise).
 */

const prismaMock = {
  technician: { findUnique: jest.fn() },
  ticket: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const {
  default: technicianRepository,
  buildTechnicianScopeWhere,
  techDetailTicketOmit,
} = await import('../src/services/technicianRepository.js');
const {
  calculateTechnicianDetail,
  calculateTechnicianWeeklyStats,
  calculateTechnicianMonthlyStats,
} = await import('../src/services/statsCalculator.js');
const { getTodayRange } = await import('../src/utils/timezone.js');

const TZ = 'America/Los_Angeles';
const TECH = { id: 5, name: 'Ada Tech', workspaceId: 1, email: 'ada@example.com', photoUrl: null, timezone: TZ, isActive: true };

const STATUS_SETS = {
  open: new Set(['Open', 'In Triage']),
  pending: new Set(['Pending', 'Needs Rework']),
  openLike: new Set(['Open', 'In Triage', 'Pending', 'Needs Rework']),
  terminal: new Set(['Resolved', 'Closed', 'Fixed']),
};
const STATUSES = ['Open', 'In Triage', 'Pending', 'Needs Rework', 'Resolved', 'Closed', 'Fixed'];
const SERVICE_ACCOUNTS = ['Ticket Pulse'];

// Deterministic PRNG (mulberry32) so the fixture is stable run to run.
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLifetime() {
  const rand = rng(42);
  const center = Date.parse('2026-08-31T12:00:00Z');
  const span = 400 * 24 * 3600 * 1000;
  const tickets = [];
  for (let i = 1; i <= 1500; i++) {
    // Cluster half the tickets within ±40 days of the target period so every
    // boundary is exercised; the rest spread across the lifetime.
    const near = rand() < 0.5;
    const offset = near ? (rand() - 0.5) * 80 * 24 * 3600 * 1000 : (rand() - 0.5) * span;
    const createdAt = new Date(center + offset);
    const neverAssigned = rand() < 0.15;
    const firstAssignedAt = neverAssigned ? null : new Date(createdAt.getTime() + rand() * 6 * 3600 * 1000);
    // Realistic mix: most lifetime tickets are closed, a minority still open.
    const status = rand() < 0.15
      ? STATUSES[Math.floor(rand() * 4)]
      : STATUSES[4 + Math.floor(rand() * 3)];
    const hasCsat = rand() < 0.2;
    const csatSubmittedAt = hasCsat ? new Date(createdAt.getTime() + rand() * 60 * 24 * 3600 * 1000) : null;
    const who = rand();
    tickets.push({
      id: i,
      workspaceId: rand() < 0.03 ? 2 : 1, // a few strays in another workspace
      assignedTechId: TECH.id,
      subject: `T${i}`,
      status,
      createdAt,
      firstAssignedAt,
      isSelfPicked: who < 0.3,
      assignedBy: who < 0.3 ? TECH.name : who < 0.5 ? 'Ticket Pulse' : who < 0.8 ? 'Coordinator A' : 'Coordinator B',
      csatScore: hasCsat ? Math.ceil(rand() * 4) : null,
      csatSubmittedAt,
      parkedUntil: rand() < 0.05 ? new Date(center + 3 * 24 * 3600 * 1000) : null,
      isNoise: rand() < 0.1,
    });
  }
  // Exact-edge cases around the target week in LA time.
  const weekStart = getTodayRange(TZ, new Date(2026, 7, 31, 12)).start;
  const weekEnd = getTodayRange(TZ, new Date(2026, 8, 6, 12)).end;
  tickets.push(
    { id: 9001, workspaceId: 1, assignedTechId: 5, status: 'Closed', createdAt: weekStart, firstAssignedAt: weekStart, isSelfPicked: false, assignedBy: 'Coordinator A', csatScore: null, csatSubmittedAt: null, parkedUntil: null, isNoise: false },
    { id: 9002, workspaceId: 1, assignedTechId: 5, status: 'Closed', createdAt: weekEnd, firstAssignedAt: null, isSelfPicked: true, assignedBy: null, csatScore: 4, csatSubmittedAt: weekEnd, parkedUntil: null, isNoise: false },
    { id: 9003, workspaceId: 1, assignedTechId: 5, status: 'Resolved', createdAt: new Date(weekStart.getTime() - 1), firstAssignedAt: new Date(weekStart.getTime() - 1), isSelfPicked: false, assignedBy: 'Coordinator B', csatScore: null, csatSubmittedAt: null, parkedUntil: null, isNoise: false },
    // Assigned two years ago, CSAT arrives inside the week.
    { id: 9004, workspaceId: 1, assignedTechId: 5, status: 'Closed', createdAt: new Date('2024-09-01T10:00:00Z'), firstAssignedAt: new Date('2024-09-01T11:00:00Z'), isSelfPicked: false, assignedBy: 'Coordinator A', csatScore: 1, csatSubmittedAt: new Date('2026-09-02T18:00:00Z'), parkedUntil: null, isNoise: false },
    // Ancient ticket still open in a custom status.
    { id: 9005, workspaceId: 1, assignedTechId: 5, status: 'Needs Rework', createdAt: new Date('2023-01-01T10:00:00Z'), firstAssignedAt: new Date('2023-01-01T10:00:00Z'), isSelfPicked: true, assignedBy: TECH.name, csatScore: null, csatSubmittedAt: null, parkedUntil: null, isNoise: false },
  );
  return tickets;
}

// Minimal evaluator for the Prisma where shapes the scoped load emits.
function fieldMatches(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(value);
    if (value === null || value === undefined) return false;
    const v = new Date(value).getTime();
    if (cond.gte && v < new Date(cond.gte).getTime()) return false;
    if (cond.lte && v > new Date(cond.lte).getTime()) return false;
    return true;
  }
  return value === cond;
}
function matchesWhere(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((clause) => matchesWhere(row, clause));
    return fieldMatches(row[key], cond);
  });
}

const LIFETIME = buildLifetime();

// The old getById: every ticket of the tech inside its workspace (+ noise filter).
function lifetimeTech({ excludeNoise = false } = {}) {
  return {
    ...TECH,
    tickets: LIFETIME.filter((t) => t.workspaceId === TECH.workspaceId && (!excludeNoise || !t.isNoise)),
  };
}

beforeEach(() => {
  prismaMock.technician.findUnique.mockReset().mockResolvedValue({ ...TECH });
  prismaMock.ticket.findMany.mockReset().mockImplementation(async ({ where }) => (
    LIFETIME.filter((t) => matchesWhere(t, where))
  ));
});

async function scoped(start, end, excludeNoise = false) {
  return technicianRepository.getByIdScoped(TECH.id, {
    start, end, openStatuses: STATUS_SETS.openLike, excludeNoise,
  });
}

describe('getByIdScoped — query shape', () => {
  test('one skinny ticket query: tech + workspace scoped, heavy columns omitted, slim requester', async () => {
    const tech = await scoped(new Date(2026, 7, 31, 12), new Date(2026, 8, 6, 12));
    expect(tech.id).toBe(5);
    expect(prismaMock.ticket.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(arg.where.assignedTechId).toBe(5);
    expect(arg.where.workspaceId).toBe(1);
    expect(arg.omit).toBe(techDetailTicketOmit);
    expect(arg.omit.description).toBe(true);
    expect(arg.include.requester).toEqual({ select: { id: true, name: true, email: true } });
    // The scoped load is a small slice of the lifetime set.
    expect(tech.tickets.length).toBeLessThan(lifetimeTech().tickets.length / 2);
  });

  test('returns null for an unknown technician without querying tickets', async () => {
    prismaMock.technician.findUnique.mockResolvedValue(null);
    expect(await scoped(new Date(), new Date())).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('buildTechnicianScopeWhere pads the window and honours noise', () => {
    const where = buildTechnicianScopeWhere({
      start: new Date('2026-08-31T12:00:00Z'), end: new Date('2026-09-06T12:00:00Z'),
      openStatuses: new Set(['Open']), workspaceId: 1, excludeNoise: true,
    });
    expect(where.isNoise).toBe(false);
    expect(where.OR[0].firstAssignedAt.gte.toISOString()).toBe('2026-08-29T12:00:00.000Z');
    expect(where.OR[0].firstAssignedAt.lte.toISOString()).toBe('2026-09-08T12:00:00.000Z');
    expect(where.OR[2]).toEqual({ status: { in: ['Open'] } });
  });
});

describe('scoped load keeps every stat identical to the lifetime load', () => {
  test.each([false, true])('weekly (excludeNoise=%s)', async (excludeNoise) => {
    const weekStartDate = new Date(2026, 7, 31, 12, 0, 0);
    const weekEndDate = new Date(2026, 8, 6, 12, 0, 0);
    const full = calculateTechnicianWeeklyStats(lifetimeTech({ excludeNoise }), weekStartDate, weekEndDate, TZ, SERVICE_ACCOUNTS, STATUS_SETS);
    const slim = calculateTechnicianWeeklyStats(await scoped(weekStartDate, weekEndDate, excludeNoise), weekStartDate, weekEndDate, TZ, SERVICE_ACCOUNTS, STATUS_SETS);
    expect(slim).toEqual(full);
    expect(full.weeklyTotalCreated).toBeGreaterThan(0);
    expect(full.weeklyCSATCount).toBeGreaterThan(0);
    expect(full.openTicketCount).toBeGreaterThan(0);
    expect(full.parkedTicketCount).toBeGreaterThan(0);
  });

  test('monthly', async () => {
    const monthStartDate = new Date(2026, 7, 1, 12, 0, 0);
    const monthEndDate = new Date(2026, 8, 0, 12, 0, 0);
    const full = calculateTechnicianMonthlyStats(lifetimeTech(), monthStartDate, monthEndDate, TZ, SERVICE_ACCOUNTS, STATUS_SETS);
    const slim = calculateTechnicianMonthlyStats(await scoped(monthStartDate, monthEndDate), monthStartDate, monthEndDate, TZ, SERVICE_ACCOUNTS, STATUS_SETS);
    expect(slim).toEqual(full);
    expect(full.monthlyTotalCreated).toBeGreaterThan(0);
  });

  test.each([
    ['historical day', new Date(2026, 8, 2, 12), false],
    ['week edge day', new Date(2026, 7, 31, 12), false],
    ['"today" mode', new Date(2026, 8, 3, 12), true],
  ])('daily detail — %s', async (_label, day, isViewingToday) => {
    const { start, end } = getTodayRange(TZ, day);
    const full = calculateTechnicianDetail(lifetimeTech(), start, end, isViewingToday, SERVICE_ACCOUNTS, STATUS_SETS);
    const slim = calculateTechnicianDetail(await scoped(start, end), start, end, isViewingToday, SERVICE_ACCOUNTS, STATUS_SETS);
    expect(slim).toEqual(full);
    expect(full.openTicketCount).toBeGreaterThan(0);
  });
});
