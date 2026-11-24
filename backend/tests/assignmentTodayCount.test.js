import { jest } from '@jest/globals';

/**
 * QA 11-23 item 3: one "today" for Level match and get_assignment_risk_signals.
 * Tickets given to the person since local midnight (Pacific), by anyone, once
 * per ticket; the ticket being decided left out.
 */
const prismaMock = {
  ticketAssignmentEpisode: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { countAssignedToday } = await import('../src/services/assignmentTodayCount.js');

// 9:47 AM Pacific, 23 Nov 2026 (PST, UTC−8).
const NOW = new Date('2026-11-23T17:47:00.000Z');
const at = (hhmm) => new Date(`2026-11-23T${hhmm}:00.000-08:00`);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockResolvedValue([]);
});

test('counts each ticket once, whatever the source and however often it came back', async () => {
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([
    { technicianId: 11, ticketId: 501, startedAt: at('08:05') }, // automation
    { technicianId: 11, ticketId: 501, startedAt: at('09:10') }, // came back to them: same ticket
    { technicianId: 11, ticketId: 502, startedAt: at('08:30') }, // an older ticket a coordinator gave them
    { technicianId: 11, ticketId: 503, startedAt: at('09:00') }, // self-picked, later handed back: still landed on them
    { technicianId: 12, ticketId: 504, startedAt: at('07:45') },
  ]);
  // FreshService assignment the activity sync has not turned into an episode yet.
  prismaMock.ticket.findMany.mockResolvedValue([
    { id: 505, assignedTechId: 11 },
    { id: 502, assignedTechId: 11 }, // already counted
  ]);
  const counts = await countAssignedToday({ workspaceId: 1, technicianIds: [11, 12, 13], timezone: 'America/Vancouver', now: NOW });
  expect(counts.get(11)).toBe(4);
  expect(counts.get(12)).toBe(1);
  expect(counts.get(13)).toBe(0);
});

test('asks for the Pacific day up to now, without the ticket being decided', async () => {
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([
    { technicianId: 11, ticketId: 900, startedAt: at('09:40') },
    { technicianId: 11, ticketId: 501, startedAt: at('08:05') },
  ]);
  const counts = await countAssignedToday({ workspaceId: 1, technicianIds: [11], timezone: 'America/Vancouver', now: NOW, excludeTicketId: 900 });
  expect(counts.get(11)).toBe(1);
  const where = prismaMock.ticketAssignmentEpisode.findMany.mock.calls[0][0].where;
  expect(where.startedAt.gte.toISOString()).toBe('2026-11-23T08:00:00.000Z'); // midnight PST
  expect(where.startedAt.lte).toBe(NOW);
  expect(where.NOT).toEqual({ ticketId: 900 });
  expect(prismaMock.ticket.findMany.mock.calls[0][0].where.NOT).toEqual({ id: 900 });
});

test('yesterday does not count', async () => {
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([
    { technicianId: 11, ticketId: 501, startedAt: new Date('2026-11-23T07:30:00.000Z') }, // 11:30 PM Sunday
  ]);
  const counts = await countAssignedToday({ workspaceId: 1, technicianIds: [11], timezone: 'America/Vancouver', now: NOW });
  expect(counts.get(11)).toBe(0);
});

test('a source that cannot be read counts nothing; never throws', async () => {
  prismaMock.ticketAssignmentEpisode.findMany.mockRejectedValue(new Error('db down'));
  prismaMock.ticket.findMany.mockResolvedValue([{ id: 505, assignedTechId: 11 }]);
  const counts = await countAssignedToday({ workspaceId: 1, technicianIds: [11], now: NOW });
  expect(counts.get(11)).toBe(1);
  expect((await countAssignedToday({ workspaceId: 1, technicianIds: [] })).size).toBe(0);
});
