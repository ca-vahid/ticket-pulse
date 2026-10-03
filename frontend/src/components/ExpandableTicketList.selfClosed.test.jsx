/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExpandableTicketList from './ExpandableTicketList';

// 2 Oct 2026 (Vahid): the Self tag showed on open/pending rows only.
const row = (id, status, extra = {}) => ({
  id, freshserviceTicketId: String(240000 + id), subject: `Ticket ${id}`, status, priority: 2,
  createdAt: '2026-09-22T16:00:00Z', ...extra,
});

afterEach(() => cleanup());

describe('ExpandableTicketList Self tag', () => {
  test('closed/resolved rows keep the Self tag; assigned ones do not get it', () => {
    render(
      <MemoryRouter>
        <ExpandableTicketList
          techName="Andrew Fong"
          viewMode="weekly"
          activeTickets={[row(1, 'Open', { isSelfPicked: true })]}
          closedTickets={[
            row(2, 'Closed', { isSelfPicked: true }),
            row(3, 'Resolved', { assignedBy: 'Andrew Fong' }),
            row(4, 'Closed', { assignedBy: 'Ticket Pulse' }),
          ]}
        />
      </MemoryRouter>,
    );
    const rowOf = (subject) => screen.getByText(subject).closest('div');
    expect(within(rowOf('Ticket 1')).getByText('Self')).toBeInTheDocument();
    expect(within(rowOf('Ticket 2')).getByText('Self')).toBeInTheDocument();
    expect(within(rowOf('Ticket 3')).getByText('Self')).toBeInTheDocument();
    expect(within(rowOf('Ticket 4')).queryByText('Self')).not.toBeInTheDocument();
  });
});
