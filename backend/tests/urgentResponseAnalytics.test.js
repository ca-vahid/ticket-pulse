import { jest } from '@jest/globals';

/**
 * Analytics → Automation Ops, the optional `urgentResponse` block
 * (plans/URGENT_RESPONSE_PLAN.md): counts by layer for the SELECTED range,
 * live and Shadow apart, from one grouped read of the log. Null when the rule
 * is off and never ran, or when the tables are missing. No per-person numbers.
 */
const prismaMock = {
  urgentResponseSettings: { findUnique: jest.fn() },
  urgentResponseAction: { groupBy: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { urgentResponseStatsForRange } = await import('../src/services/analyticsService.js');

const RANGE = { start: new Date('2026-09-01T07:00:00Z'), end: new Date('2026-10-01T06:59:59Z') };
const ZERO = { redirected: 0, held: 0, moved: 0, raiseMoved: 0, clockMoved: 0, toldOwnerAway: 0, teamTold: 0, coordinator: 0, onCallAssigned: 0, undone: 0 };
const group = (layer, action, shadow, n) => ({ layer, action, shadow, _count: { _all: n } });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ mode: 'live' });
  prismaMock.urgentResponseAction.groupBy.mockResolvedValue([]);
});

describe('urgentResponseStatsForRange', () => {
  test('counts by layer, live and Shadow apart, for the selected range', async () => {
    prismaMock.urgentResponseAction.groupBy.mockResolvedValue([
      group('assign', 'redirected', false, 4),
      group('assign', 'held', false, 1),
      group('raise', 'held', false, 2),
      group('raise', 'moved', false, 3),
      group('clock', 'moved', false, 2),
      group('raise', 'told_owner_away', false, 5),
      group('clock', 'team_told', false, 6),
      group('clock', 'coordinator', false, 1),
      group('raise', 'on_call_assigned', false, 1),
      group('undo', 'undone', false, 1),
      group('raise', 'moved', true, 7),
      group('clock', 'team_told', true, 9),
      // The on-call bookkeeping and failures are not counts of this panel.
      group('on_call', 'cover_set', false, 3),
      group('raise', 'failed', false, 2),
    ]);
    expect(await urgentResponseStatsForRange(1, RANGE)).toEqual({
      mode: 'live',
      live: { redirected: 4, held: 3, moved: 5, raiseMoved: 3, clockMoved: 2, toldOwnerAway: 5, teamTold: 6, coordinator: 1, onCallAssigned: 1, undone: 1 },
      shadow: { ...ZERO, moved: 7, raiseMoved: 7, teamTold: 9 },
    });
    expect(prismaMock.urgentResponseAction.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMock.urgentResponseAction.groupBy).toHaveBeenCalledWith({
      by: ['layer', 'action', 'shadow'],
      where: { workspaceId: 1, createdAt: { gte: RANGE.start, lte: RANGE.end } },
      _count: { _all: true },
    });
  });

  test('nothing about people: no technician ids or names are read or returned', async () => {
    prismaMock.urgentResponseAction.groupBy.mockResolvedValue([group('raise', 'moved', false, 3)]);
    const out = await urgentResponseStatsForRange(1, RANGE);
    expect(JSON.stringify(out)).not.toMatch(/technician|name/i);
    expect(prismaMock.urgentResponseAction.groupBy.mock.calls[0][0].by).not.toEqual(expect.arrayContaining(['fromTechnicianId', 'toTechnicianId']));
  });

  test('off and never ran: null; off with rows from before: the rows, mode off', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue(null);
    expect(await urgentResponseStatsForRange(2, RANGE)).toBeNull();
    prismaMock.urgentResponseAction.groupBy.mockResolvedValue([group('clock', 'team_told', true, 2)]);
    expect(await urgentResponseStatsForRange(2, RANGE)).toEqual({ mode: 'off', live: ZERO, shadow: { ...ZERO, teamTold: 2 } });
  });

  test('Shadow with a quiet range: zeros, not null', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ mode: 'observe' });
    expect(await urgentResponseStatsForRange(1, RANGE)).toEqual({ mode: 'observe', live: ZERO, shadow: ZERO });
  });

  test('a missing table is null, never an error', async () => {
    prismaMock.urgentResponseAction.groupBy.mockRejectedValue(new Error('relation "urgent_response_actions" does not exist'));
    await expect(urgentResponseStatsForRange(1, RANGE)).resolves.toBeNull();
  });
});
