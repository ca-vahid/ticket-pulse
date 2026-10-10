/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import TicketHistoryTimeline from './TicketHistoryTimeline';
import { buildHistoryItems, countMachine } from '../../utils/ticketHistory';

// Urgent response on the ticket's Activity tab: the server's sentence, word
// for word, as Ticket Pulse's own line.

afterEach(cleanup);

const SENTENCE = 'Moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00. Andrew is at work and has the Network skill.';
const at = (min) => new Date(Date.parse('2026-10-12T14:10:00Z') + min * 60000).toISOString();

const activities = [
  { id: 1, activityType: 'status_changed', performedBy: 'Dana Agent', performedAt: at(0), details: { oldStatus: 'Open', newStatus: 'Pending', actorKind: 'human' } },
  { id: 2, activityType: 'urgent_response', performedBy: 'Ticket Pulse', performedAt: at(30), details: { sentence: SENTENCE, layer: 'raise', action: 'moved', fromTechId: 5, toTechId: 3 } },
  { id: 3, activityType: 'urgent_response', performedBy: 'Ticket Pulse', performedAt: at(90), actorKind: 'system', details: { sentence: 'Urgent and untouched for 15 minutes. The people at work were told.', layer: 'clock', action: 'team_told' } },
];

describe('urgent_response on the activity timeline', () => {
  test('the model: the sentence is the line, the actor is Ticket Pulse, and it is not machine noise', () => {
    const items = buildHistoryItems({ activities });
    const moved = items.find((i) => i.key === 'a-2');
    expect(moved).toMatchObject({ event: 'urgent', verb: SENTENCE, actor: 'Ticket Pulse', machine: false, detail: null, from: null, to: null });
    expect(items.find((i) => i.key === 'a-3')).toMatchObject({ event: 'urgent', actor: 'Ticket Pulse', machine: false });
    expect(countMachine(items)).toBe(0);
    // Two different sentences never fold into one "×2" row.
    expect(items.filter((i) => i.event === 'urgent')).toHaveLength(2);
  });

  test('an older row without a sentence still reads as words', () => {
    const [item] = buildHistoryItems({ activities: [{ id: 9, activityType: 'urgent_response', performedBy: 'Ticket Pulse', performedAt: at(0), details: {} }] });
    expect(item).toMatchObject({ event: 'urgent', verb: 'Urgent response', actor: 'Ticket Pulse' });
  });

  test('rendered verbatim under Ticket Pulse, also with machine activity hidden', () => {
    const items = buildHistoryItems({ activities });
    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    const run = screen.getAllByTestId('history-run').find((el) => el.getAttribute('data-actor') === 'Ticket Pulse');
    expect(run).toBeTruthy();
    expect(within(run).getByText(SENTENCE)).toBeInTheDocument();
    expect(within(run).getByText('Urgent and untouched for 15 minutes. The people at work were told.')).toBeInTheDocument();
    const rows = within(run).getAllByTestId('history-row');
    expect(rows.map((r) => r.getAttribute('data-event'))).toEqual(['urgent', 'urgent']);
    // The row's node carries an icon like every other event.
    expect(rows[0].querySelector('svg')).not.toBeNull();
  });
});
