import { jest } from '@jest/globals';

/**
 * QA 11-23 item 5, second-look review MUST 1: get_ticket_details showed the AI
 * the saved (already raised) priority, the next run answered at that level,
 * and the raise stacked. The AI now sees its own level and why the ticket
 * sits higher.
 */
const prismaMock = {
  ticket: { findUnique: jest.fn(), findFirst: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ defaultTimezone: 'America/Vancouver' })) },
};
const priorityContextForAi = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentFollowUp/sameDayRepeatService.js', () => ({ default: { priorityContextForAi } }));

const { executeTool } = await import('../src/services/assignmentTools.js');

const ticket = {
  id: 2001, workspaceId: 1, freshserviceTicketId: 244532n, subject: "Still can't sign in to Teams", description: 'x', status: 'Open',
  priority: 3, assessedPriority: 'High', assessedPriorityId: 3, priorityRationale: 'One person blocked.', createdAt: new Date('2026-11-23T18:15:00Z'),
  requester: null, assignedTech: null,
};
const details = () => executeTool('get_ticket_details', { ticket_id: 2001 }, { workspaceId: 1, ticketId: 2001 });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...ticket });
});

test('a raised ticket shows the AI its own level and the reason, not the raised one', async () => {
  priorityContextForAi.mockResolvedValue({ aiLevelBeforeRaise: 'Medium', raisedTo: 'High', relatedRef: 'TP-1042', note: 'Ticket Pulse raised this ticket…' });
  const out = await details();
  expect(priorityContextForAi).toHaveBeenCalledWith(2001);
  expect(out).toMatchObject({
    assessedPriority: 'Medium', assessedPriorityId: 2, priorityRationale: 'One person blocked.',
    priorityRaisedForRepeatReport: { aiLevelBeforeRaise: 'Medium', raisedTo: 'High', relatedRef: 'TP-1042' },
  });
});

test('no raise, or the lookup fails: unchanged', async () => {
  priorityContextForAi.mockResolvedValue(null);
  const plain = await details();
  expect(plain).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
  expect(plain.priorityRaisedForRepeatReport).toBeUndefined();
  priorityContextForAi.mockRejectedValue(new Error('boom'));
  expect((await details()).assessedPriority).toBe('High');
});
