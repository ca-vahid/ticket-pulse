/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TicketHistoryTimeline from './TicketHistoryTimeline';
import { buildHistoryItems } from '../../utils/ticketHistory';

// QA 11-24 item 9: an alert sent about the ticket is on its Activity tab, with
// who got it, how, why, and the reason a plain-text fallback was used.

afterEach(cleanup);

const AT = '2026-11-23T18:17:00Z';
const alertRow = (id, details) => ({ id, activityType: 'alert_sent', performedBy: 'Ticket Pulse', performedAt: AT, actorKind: 'system', details });

describe('alert_sent on the Activity tab', () => {
  test('one sentence under Ticket Pulse, shown with machine activity hidden', () => {
    const items = buildHistoryItems({
      activities: [alertRow(1, {
        sentence: 'Urgent-priority alert sent to Jordan Lee by e-mail and SMS: assignee, subscribed to Urgent alerts',
        kind: 'priority',
        channels: { sent: ['email', 'sms'], failed: [], queued: [] },
        actorKind: 'system',
      })],
    });
    const [item] = items;
    expect(item).toMatchObject({ event: 'alert', actor: 'Ticket Pulse', machine: false });

    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    const r = screen.getByTestId('history-row');
    expect(within(r).getByText('Urgent-priority alert sent to Jordan Lee by e-mail and SMS: assignee, subscribed to Urgent alerts')).toBeInTheDocument();
    expect(within(r).getByText('Alert sent')).toBeInTheDocument();
  });

  test('a fallback and a failed channel are in the details', () => {
    const items = buildHistoryItems({
      activities: [alertRow(2, {
        sentence: 'High-priority alert sent to Sam Park by e-mail (SMS failed): assignee, subscribed to High and Urgent alerts',
        channels: { sent: ['email'], failed: [{ channel: 'sms', error: 'Twilio 21614' }], queued: [] },
        fallbackReasons: [{ channel: 'email', reason: 'The ticket could not be read when the alert was sent, so it went as a plain one-line message.' }],
      })],
    });
    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    fireEvent.click(within(screen.getByTestId('history-row')).getByRole('button'));
    const details = screen.getByTestId('history-details');
    expect(details).toHaveTextContent('plain one-line message');
    expect(details).toHaveTextContent('sms: Twilio 21614');
  });

  test('two different alerts never fold into one row', () => {
    const items = buildHistoryItems({
      activities: [
        alertRow(3, { sentence: 'Urgent-priority alert sent to Jordan Lee by e-mail: assignee, subscribed to Urgent alerts' }),
        alertRow(4, { sentence: 'Urgent escalation sent to Sam Park by SMS: after-hours urgent escalation' }),
      ],
    });
    expect(items.filter((i) => i.event === 'alert')).toHaveLength(2);
  });
});
