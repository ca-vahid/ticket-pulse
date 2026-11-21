// 20 Nov 2026: an approval left open on a ticket that closed ends as "not
// needed any more" (decidedVia 'ticket_closed'). Its words, and the one
// history row the ticket gets.
import { describe, expect, test } from 'vitest';
import { closedByTicketClose, closedWords, TICKET_CLOSED_TITLE } from './approvalCloseReasons';
import { buildHistoryItems } from './ticketHistory';

describe('closedByTicketClose', () => {
  test('only a closed row whose ticket closed it', () => {
    expect(closedByTicketClose({ status: 'closed', closeReason: 'not_needed', decidedVia: 'ticket_closed' })).toBe(true);
    expect(closedByTicketClose({ status: 'closed', closeReason: 'not_needed', decidedVia: 'app' })).toBe(false);
    expect(closedByTicketClose({ status: 'pending', decidedVia: 'ticket_closed' })).toBe(false);
    expect(closedByTicketClose(null)).toBe(false);
  });

  test('the title is plain words, and the reason word is unchanged', () => {
    expect(TICKET_CLOSED_TITLE).toBe('No longer needed');
    expect(closedWords('not_needed')).toBe('Closed: no longer needed');
  });
});

describe('History: the approval close row', () => {
  const row = (details) => ({
    id: 9, activityType: 'approval_closed', performedBy: 'Ticket Pulse', performedAt: '2026-11-20T18:00:00Z', details,
  });

  test('one visible line from Ticket Pulse, saying nobody was told', () => {
    const [item] = buildHistoryItems({
      activities: [row({ via: 'ticket_closed', closeReason: 'not_needed', note: 'Approval no longer needed: the ticket was closed', approvalIds: [173], closed: 1, actorKind: 'system' })],
    });
    expect(item.verb).toBe('Approval no longer needed: the ticket was closed');
    expect(item.detail).toBe('Closed as not needed. Nobody was told.');
    expect(item.actor).toBe('Ticket Pulse');
    expect(item.machine).toBe(false);
  });

  test('several approvals at once are counted', () => {
    const [item] = buildHistoryItems({ activities: [row({ via: 'ticket_closed', approvalIds: [173, 174], closed: 2 })] });
    expect(item.detail).toBe('2 approvals closed as not needed. Nobody was told.');
  });

  test('a person closing an approval keeps the old line', () => {
    const [item] = buildHistoryItems({ activities: [{ ...row({ approvalId: 5, closeReason: 'handled_otherwise' }), performedBy: 'Dana Fox' }] });
    expect(item.verb).toBe('approval closed');
  });
});
