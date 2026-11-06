/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketBoard from './TicketBoard';

// QA 11-05b UI review: the card's priority is the whole word and keeps its
// width beside the SLA chip; the assignee name is what gives way.

afterEach(cleanup);

test('priority shows the whole word, never a 3-letter cut, and does not shrink', () => {
  render(
    <MemoryRouter>
      <TicketBoard
        ticketingOn
        tickets={[{
          id: 1, status: 'Open', subject: 'Ticket 1', displayRef: 'TP-1', priority: 4, origin: 'ticketpulse', tags: [],
          assignedTech: { name: 'Alexandra Konstantinopoulou-Whitfield' }, dueBy: new Date(Date.now() + 22 * 3600e3).toISOString(),
        }]}
      />
    </MemoryRouter>,
  );
  const priority = screen.getByTestId('board-card-priority');
  expect(priority).toHaveTextContent(/^Urgent$/);
  expect(priority).toHaveClass('shrink-0', 'whitespace-nowrap');
  expect(screen.getByText('Alexandra Konstantinopoulou-Whitfield')).toHaveClass('truncate');
});