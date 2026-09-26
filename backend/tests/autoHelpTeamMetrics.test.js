import { jest } from '@jest/globals';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * Auto-help closes in people metrics — one rule (utils/autoHelpMetrics.js),
 * the same on every surface (plans/AUTO_HELP_P1_PLAN.md §3, team-safe):
 *   - per agent: out of closes, close-rate numerator AND denominator,
 *     resolution time and CSAT; assignment counts unchanged;
 *   - team: still resolved, plus its own "by Auto-help" line.
 * Each surface is pinned twice: with no Auto-help closes (numbers exactly as
 * before) and with one added (the person's numbers do not move).
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const BASES = { Open: ['Open'], Pending: ['Pending'], Resolved: ['Resolved'], Closed: ['Closed'] };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    statusNamesForBase: jest.fn(async (_ws, bases) => (Array.isArray(bases) ? bases : [bases]).flatMap((b) => BASES[b] || [])),
    resolveBaseStatus: jest.fn(async (_ws, s) => s),
    baseStatusSets: jest.fn(async () => null),
  },
}));

const metrics = await import('../src/utils/autoHelpMetrics.js');
const {
  calculateTechnicianWeeklyStats, calculateTechnicianMonthlyStats, calculateTechnicianDetail,
  calculateWeeklyDashboard, calculateMonthlyDashboard,
} = await import('../src/services/statsCalculator.js');
const { getTeamBalance, getOverview, getDemandFlow, invalidateAnalyticsCache } = await import('../src/services/analyticsService.js');

const PDT = (iso) => new Date(`${iso}-07:00`);
const TZ = 'America/Vancouver';

describe('the shared rule (utils/autoHelpMetrics.js)', () => {
  test('row predicate, Prisma fragment and SQL fragment say the same thing', () => {
    expect(metrics.isAutoHelpResolved({ resolvedByKind: 'auto_help' })).toBe(true);
    expect(metrics.isAutoHelpResolved({ resolvedByKind: 'agent' })).toBe(false);
    expect(metrics.countsForAgentMetrics({ resolvedByKind: null })).toBe(true);
    expect(metrics.countsForAgentMetrics({})).toBe(true);
    // NULL is spelled out (a bare `not` would drop NULL rows in SQL).
    expect(metrics.AGENT_METRIC_TICKET_WHERE).toEqual({ OR: [{ resolvedByKind: null }, { resolvedByKind: { not: 'auto_help' } }] });
    expect(metrics.withAgentMetricTickets({ workspaceId: 1, OR: [{ a: 1 }] })).toEqual({ AND: [{ workspaceId: 1, OR: [{ a: 1 }] }, metrics.AGENT_METRIC_TICKET_WHERE] });
    expect(metrics.agentMetricTicketSql('t')).toBe("t.resolved_by_kind IS DISTINCT FROM 'auto_help'");
    expect(metrics.autoHelpResolvedTicketSql('')).toBe("resolved_by_kind = 'auto_help'");
    expect(() => metrics.agentMetricTicketSql('t; drop')).toThrow(/alias/);
  });

  test('close rate leaves Auto-help closes out of both sides', () => {
    expect(metrics.agentCloseRatePct(3, 4)).toBe(75);
    expect(metrics.agentCloseRatePct(3, 5, 1)).toBe(75);
    expect(metrics.agentCloseRatePct(0, 1, 1)).toBe(0);
    const closed = (t) => ['Resolved', 'Closed'].includes(t.status);
    const split = metrics.splitAgentCloses([
      { id: 1, status: 'Resolved' }, { id: 2, status: 'Open' }, { id: 3, status: 'Resolved', resolvedByKind: 'auto_help' },
    ], closed);
    expect(split.agentTickets.map((t) => t.id)).toEqual([1, 2]);
    expect(split.agentClosed.map((t) => t.id)).toEqual([1]);
    expect(split.autoHelpClosed.map((t) => t.id)).toEqual([3]);
  });
});

describe('dashboard stats (statsCalculator) — weekly, monthly, technician detail list', () => {
  const t = (id, status, extra = {}) => ({
    id, status, createdAt: PDT('2026-09-08T09:00:00'), firstAssignedAt: PDT('2026-09-08T10:00:00'),
    isSelfPicked: false, assignedBy: 'Coord', csatScore: null, parkedUntil: null, resolvedByKind: null, ...extra,
  });
  const base = () => [t(1, 'Resolved'), t(2, 'Closed'), t(3, 'Open'), t(4, 'Resolved')];
  const tech = (tickets) => ({ id: 5, name: 'Dana', email: 'd@x', isActive: true, tickets });
  const withAutoHelp = () => [...base(), t(5, 'Resolved', { resolvedByKind: 'auto_help' })];
  const weekStart = PDT('2026-09-07T12:00:00');
  const weekEnd = PDT('2026-09-13T12:00:00');
  const monthStart = PDT('2026-09-01T12:00:00');
  const monthEnd = PDT('2026-09-30T12:00:00');
  const dayStart = PDT('2026-09-08T00:00:00');
  const dayEnd = PDT('2026-09-08T23:59:59');

  test('no Auto-help closes: the numbers are exactly the pre-P1 ones', () => {
    const w = calculateTechnicianWeeklyStats(tech(base()), weekStart, weekEnd, TZ);
    expect(w).toMatchObject({ weeklyTotalCreated: 4, weeklyClosed: 3, weeklyAutoHelpResolved: 0, weeklyNetChange: 1 });
    const m = calculateTechnicianMonthlyStats(tech(base()), monthStart, monthEnd, TZ);
    expect(m).toMatchObject({ monthlyTotalCreated: 4, monthlyClosed: 3, monthlyAutoHelpResolved: 0, monthlyNetChange: 1 });
    const d = calculateTechnicianDetail(tech(base()), dayStart, dayEnd, false);
    expect(d.closedTicketsOnDate.map((x) => x.id)).toEqual([1, 2, 4]);
    expect(d).toMatchObject({ closedTicketsOnDateCount: 3, autoHelpResolvedOnDateCount: 0, totalTicketsOnDate: 4 });
  });

  test('with an Auto-help close: the agent\'s numbers do not move; the team line counts it', () => {
    const w = calculateTechnicianWeeklyStats(tech(withAutoHelp()), weekStart, weekEnd, TZ);
    expect(w).toMatchObject({ weeklyTotalCreated: 5, weeklyClosed: 3, weeklyAutoHelpResolved: 1, weeklyNetChange: 1 });
    expect(w.dailyBreakdown.reduce((s, x) => s + x.closed, 0)).toBe(3);
    const m = calculateTechnicianMonthlyStats(tech(withAutoHelp()), monthStart, monthEnd, TZ);
    expect(m).toMatchObject({ monthlyTotalCreated: 5, monthlyClosed: 3, monthlyAutoHelpResolved: 1, monthlyNetChange: 1 });
    expect(m.dailyBreakdown.reduce((s, x) => s + x.closed, 0)).toBe(3);

    // The detail list and its count agree; Auto-help's close is its own list.
    const d = calculateTechnicianDetail(tech(withAutoHelp()), dayStart, dayEnd, false);
    expect(d.closedTicketsOnDate.map((x) => x.id)).toEqual([1, 2, 4]);
    expect(d.closedTicketsOnDateCount).toBe(d.closedTicketsOnDate.length);
    expect(d.autoHelpResolvedTicketsOnDate.map((x) => x.id)).toEqual([5]);
    expect(d.autoHelpResolvedOnDateCount).toBe(1);

    const wd = calculateWeeklyDashboard([tech(withAutoHelp())], weekStart, weekEnd, TZ);
    expect(wd.statistics).toMatchObject({ weeklyClosed: 3, weeklyAutoHelpResolved: 1, weeklyNetChange: 1 });
    const md = calculateMonthlyDashboard([tech(withAutoHelp())], monthStart, monthEnd, TZ);
    expect(md.statistics).toMatchObject({ monthClosed: 3, monthAutoHelpResolved: 1 });
    const md0 = calculateMonthlyDashboard([tech(base())], monthStart, monthEnd, TZ);
    expect(md0.statistics).toMatchObject({ monthClosed: 3, monthAutoHelpResolved: 0 });
  });
});

describe('Analytics (Team Balance, Overview, Demand & Flow)', () => {
  const QUERY = { range: 'custom', start: '2026-09-01', end: '2026-09-07', timezone: TZ, compare: 'none' };
  const DANA = { id: 5, name: 'Dana Agent' };
  const SAM = { id: 6, name: 'Sam Tech' };
  const tk = (id, tech, status, extra = {}) => ({
    id, workspaceId: 1, status, assignedTechId: tech.id, assignedTech: tech, createdAt: PDT('2026-09-02T09:00:00'),
    firstAssignedAt: PDT('2026-09-02T10:00:00'), isSelfPicked: false, assignedBy: 'Coord', isNoise: false,
    resolutionTimeSeconds: null, csatScore: null, resolvedByKind: null, priority: 2, source: 1, requester: { name: 'Pat', email: 'pat@x' }, ...extra,
  });
  const baseTickets = () => [
    tk(1, DANA, 'Resolved', { resolutionTimeSeconds: 3600, csatScore: 4 }),
    tk(2, DANA, 'Closed', { resolutionTimeSeconds: 7200 }),
    tk(3, DANA, 'Open'),
    tk(4, DANA, 'Resolved', { resolutionTimeSeconds: 10800 }),
    tk(5, SAM, 'Resolved', { resolutionTimeSeconds: 3600 }),
    tk(6, SAM, 'Open'),
  ];
  const autoHelpTicket = () => tk(7, DANA, 'Resolved', { resolutionTimeSeconds: 400000, csatScore: 1, resolvedByKind: 'auto_help' });
  const seed = (tickets) => {
    db = createFakePrisma({
      technician: [{ id: 5, workspaceId: 1, name: 'Dana Agent', email: 'dana@x', isActive: true }, { id: 6, workspaceId: 1, name: 'Sam Tech', email: 'sam@x', isActive: true }],
      ticket: tickets,
    });
    invalidateAnalyticsCache(1);
  };
  const byName = (res) => Object.fromEntries(res.technicians.map((r) => [r.name, r]));

  test('Team Balance, no Auto-help closes: pinned numbers', async () => {
    seed(baseTickets());
    const res = await getTeamBalance(1, QUERY);
    const rows = byName(res);
    expect(rows['Dana Agent']).toMatchObject({ assigned: 4, closed: 3, closeRatePct: 75, avgResolutionHours: 2, resolutionSample: 3, csatCount: 1, csatAverage: 4, openNow: 1 });
    expect(rows['Sam Tech']).toMatchObject({ assigned: 2, closed: 1, closeRatePct: 50, avgResolutionHours: 1, resolutionSample: 1, openNow: 1 });
    expect(res.summary).toMatchObject({ totalAssigned: 6, autoHelpResolved: 0 });
    expect(res.timeline.reduce((s, r) => s + r.closed, 0)).toBe(4);
  });

  test('Team Balance with an Auto-help close: the person\'s close rate, resolution time and CSAT do not move', async () => {
    seed([...baseTickets(), autoHelpTicket()]);
    const res = await getTeamBalance(1, QUERY);
    const dana = byName(res)['Dana Agent'];
    // Still their assignment (workload), but not their close — out of both sides of the rate.
    expect(dana).toMatchObject({ assigned: 5, closed: 3, closeRatePct: 75, avgResolutionHours: 2, resolutionSample: 3, csatCount: 1, csatAverage: 4 });
    expect(byName(res)['Sam Tech']).toMatchObject({ closeRatePct: 50 });
    expect(res.summary.autoHelpResolved).toBe(1);
    expect(res.timeline.reduce((s, r) => s + r.closed, 0)).toBe(4);
    // Team-safe: no per-person Auto-help figure on the rows.
    expect(Object.keys(dana).some((k) => /autohelp/i.test(k))).toBe(false);
  });

  test('Overview and Demand & Flow: the team keeps counting it as resolved, with its own line', async () => {
    seed(baseTickets());
    const before = await getOverview(1, QUERY);
    expect(before.cards.resolved.current).toBe(4);
    expect(before.cards.resolvedByAutoHelp.current).toBe(0);
    const flowBefore = await getDemandFlow(1, QUERY);
    expect(flowBefore.resolvedByAutoHelp).toBe(0);
    expect(flowBefore.trend.reduce((s, r) => s + r.resolved, 0)).toBe(4);

    seed([...baseTickets(), autoHelpTicket()]);
    const after = await getOverview(1, QUERY);
    expect(after.cards.resolved.current).toBe(5);
    expect(after.cards.resolvedByAutoHelp.current).toBe(1);
    const flow = await getDemandFlow(1, QUERY);
    expect(flow.trend.reduce((s, r) => s + r.resolved, 0)).toBe(5);
    expect(flow.resolvedByAutoHelp).toBe(1);
  });
});
