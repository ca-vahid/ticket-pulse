/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render as rtlRender, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketBoard from './TicketBoard';

// QA 11-05b #2 — Board cards carry a small "opened" date on the requester
// line: "Opened Tue 20 Oct", or "Opened 2 h ago" within a day (Pacific).

const render = (ui) => rtlRender(ui, { wrapper: MemoryRouter });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const t = (id, extra = {}) => ({
  id, status: 'Open', subject: `Ticket ${id}`, displayRef: `TP-${id}`, priority: 2, origin: 'ticketpulse', assignedTech: null, tags: [], ...extra,
});

describe('Board card opened date (QA 11-05b #2)', () => {
  test('an older ticket shows the Pacific day beside the requester, with the full time as a tooltip; no new row', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T20:00:00Z'), toFake: ['Date'] });
    // 05:30 UTC on 21 Oct is still Tue 20 Oct in Vancouver.
    render(<TicketBoard tickets={[t(1, { requester: { name: 'Rita Requester' }, createdAt: '2026-10-21T05:30:00.000Z' })]} ticketingOn />);
    const opened = screen.getByTestId('board-card-opened');
    expect(opened).toHaveTextContent('Opened Tue 20 Oct');
    expect(opened).toHaveAttribute('title', 'Opened Tue 20 Oct 2026, 10:30 PM PDT');
    expect(opened.tagName).toBe('TIME');
    // Same line as the requester (one meta row), the name truncates first.
    const meta = screen.getByTestId('board-card-meta');
    expect(within(meta).getByText('Rita Requester')).toHaveClass('truncate');
    expect(meta).toContainElement(opened);
    expect(opened).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  test('a ticket opened within the day says how long ago', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T20:00:00Z'), toFake: ['Date'] });
    render(<TicketBoard tickets={[t(2, { createdAt: '2026-11-05T18:00:00.000Z' })]} ticketingOn />);
    expect(screen.getByTestId('board-card-opened')).toHaveTextContent('Opened 2 h ago');
  });

  test('another year carries the year; no date and no requester renders no meta line', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T20:00:00Z'), toFake: ['Date'] });
    render(<TicketBoard tickets={[t(3, { createdAt: '2025-12-30T18:00:00.000Z' }), t(4)]} ticketingOn />);
    expect(screen.getByTestId('board-card-opened')).toHaveTextContent('Opened Tue 30 Dec 2025');
    expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
  });
});
