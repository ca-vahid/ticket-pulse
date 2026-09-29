import { jest } from '@jest/globals';

// 29 Sep 2026: on already-assigned tickets (classification-only runs) Sonnet
// 5.5 submits the current assignee straight from get_ticket_details. With only
// the name there it sent techId 0, was rejected, and paid a get_technicians
// round trip to recover. The tool now returns the internal id too.

const prismaMock = {
  ticket: { findUnique: jest.fn(), findFirst: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ defaultTimezone: 'America/Los_Angeles' })) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { executeTool } = await import('../src/services/assignmentTools.js');

const baseTicket = {
  id: 60707, workspaceId: 1, freshserviceTicketId: 244532n, subject: 'Install request', description: 'x',
  status: 'Open', priority: 1, createdAt: new Date('2026-09-29T13:00:00Z'), requester: null,
};

describe('get_ticket_details — current assignee', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the internal id alongside the name', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ ...baseTicket, assignedTech: { id: 5, name: 'Andrew Fong' } });
    const result = await executeTool('get_ticket_details', { ticket_id: 60707 }, { workspaceId: 1, ticketId: 60707 });
    expect(result.currentlyAssignedTo).toBe('Andrew Fong');
    expect(result.currentlyAssignedTechId).toBe(5);
  });

  test('unassigned: name says so and the id is null', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ ...baseTicket, assignedTech: null });
    const result = await executeTool('get_ticket_details', { ticket_id: 60707 }, { workspaceId: 1, ticketId: 60707 });
    expect(result.currentlyAssignedTo).toBe('Unassigned');
    expect(result.currentlyAssignedTechId).toBeNull();
  });
});
