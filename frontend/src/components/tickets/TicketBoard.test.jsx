/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TicketBoard from './TicketBoard';

afterEach(cleanup);

const t = (id, status, extra = {}) => ({
  id,
  status,
  subject: `Ticket ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'ticketpulse',
  assignedTech: null,
  tags: [],
  ...extra,
});

describe('TicketBoard bucket honesty (QA 08-04 #15/#16)', () => {
  test('cards land in lifecycle buckets; Waiting on Customer joins Pending, Resolved joins Closed', () => {
    render(
      <TicketBoard
        tickets={[t(1, 'Open'), t(2, 'Pending'), t(3, 'Waiting on Customer'), t(4, 'Resolved'), t(5, 'Closed')]}
        ticketingOn
      />,
    );
    const open = screen.getByRole('region', { name: 'Open column' });
    const pending = screen.getByRole('region', { name: 'Pending column' });
    const closed = screen.getByRole('region', { name: 'Closed column' });
    expect(within(open).getByText('Ticket 1')).toBeInTheDocument();
    expect(within(pending).getByText('Ticket 2')).toBeInTheDocument();
    expect(within(pending).getByText('Ticket 3')).toBeInTheDocument();
    expect(within(closed).getByText('Ticket 4')).toBeInTheDocument();
    expect(within(closed).getByText('Ticket 5')).toBeInTheDocument();
    // Column counts reflect the rendered buckets (no pagination → bare numbers).
    expect(within(open).getByText('1')).toBeInTheDocument();
    expect(within(pending).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/on page/)).not.toBeInTheDocument();
  });

  test('paginated board labels counts as page-local instead of posing as totals', () => {
    render(<TicketBoard tickets={[t(1, 'Open'), t(2, 'Open')]} ticketingOn paginated />);
    const open = screen.getByRole('region', { name: 'Open column' });
    expect(within(open).getByText('on page')).toBeInTheDocument();
  });

  test('empty Closed column explains a scope that hides terminal statuses and offers to widen it', () => {
    const onShowClosed = vi.fn();
    render(
      <TicketBoard
        tickets={[t(1, 'Open'), t(2, 'Pending')]}
        ticketingOn
        closedExcluded
        onShowClosed={onShowClosed}
      />,
    );
    const closed = screen.getByRole('region', { name: 'Closed column' });
    expect(within(closed).getByText('Closed hidden by current filters')).toBeInTheDocument();
    within(closed).getByRole('button', { name: 'Show closed' }).click();
    expect(onShowClosed).toHaveBeenCalledTimes(1);
    // The generic drag hint must not double up with the explanation.
    expect(within(closed).queryByText(/drag a card over/)).not.toBeInTheDocument();
  });

  test('without closedExcluded the Closed column keeps the plain empty hint', () => {
    render(<TicketBoard tickets={[t(1, 'Open')]} ticketingOn />);
    const closed = screen.getByRole('region', { name: 'Closed column' });
    expect(within(closed).getByText(/drag a card over/)).toBeInTheDocument();
    expect(within(closed).queryByText(/hidden by current filters/)).not.toBeInTheDocument();
  });
});

describe('TicketBoard workspace custom statuses (Phase 8b)', () => {
  const DEFS = [
    { name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true },
    { name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true },
    { name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true },
    { name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true },
    { name: 'In Triage', baseStatus: 'Open', color: 'cyan', sortOrder: 4, isSystem: false },
    { name: 'Needs Rework', baseStatus: 'Pending', color: 'orange', sortOrder: 5, isSystem: false },
    { name: 'Fixed', baseStatus: 'Resolved', color: 'violet', sortOrder: 6, isSystem: false },
  ];

  test('custom statuses land in their BASE column ("Needs Rework" → Pending, "Fixed" → Closed)', () => {
    render(
      <TicketBoard
        tickets={[t(1, 'In Triage'), t(2, 'Needs Rework'), t(3, 'Fixed'), t(4, 'Open')]}
        ticketingOn
        statusDefs={DEFS}
      />,
    );
    const open = screen.getByRole('region', { name: 'Open column' });
    const pending = screen.getByRole('region', { name: 'Pending column' });
    const closed = screen.getByRole('region', { name: 'Closed column' });
    expect(within(open).getByText('Ticket 1')).toBeInTheDocument();
    expect(within(open).getByText('Ticket 4')).toBeInTheDocument();
    expect(within(pending).getByText('Ticket 2')).toBeInTheDocument();
    expect(within(closed).getByText('Ticket 3')).toBeInTheDocument();
  });

  test('a card in a custom status carries its status tag inside the base column', () => {
    render(<TicketBoard tickets={[t(1, 'Needs Rework')]} ticketingOn statusDefs={DEFS} />);
    const pending = screen.getByRole('region', { name: 'Pending column' });
    expect(within(pending).getByText('Needs Rework')).toBeInTheDocument();
    // A card sitting in its column's own status stays untagged.
    cleanup();
    render(<TicketBoard tickets={[t(2, 'Pending')]} ticketingOn statusDefs={DEFS} />);
    const pending2 = screen.getByRole('region', { name: 'Pending column' });
    expect(within(pending2).queryByText('Pending', { selector: 'span span' })).not.toBeInTheDocument();
  });

  test('unknown labels stay off the board (Deleted/Spam behavior unchanged)', () => {
    render(<TicketBoard tickets={[t(1, 'Deleted'), t(2, 'Spam'), t(3, 'Open')]} ticketingOn statusDefs={DEFS} />);
    expect(screen.queryByText('Ticket 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Ticket 2')).not.toBeInTheDocument();
    expect(screen.getByText('Ticket 3')).toBeInTheDocument();
  });
});

describe('TicketBoard crash-proofing (QA 08-07 #10, Phase 2)', () => {
  test('active ticket vanishing mid-drag (live refetch) does not throw or trip the boundary', () => {
    const { rerender } = render(
      <TicketBoard tickets={[t(1, 'Open'), t(2, 'Pending')]} ticketingOn />,
    );

    // Start a keyboard drag on Ticket 1 (dnd-kit KeyboardSensor: Enter).
    const card = screen.getByText('Ticket 1').closest('[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.keyDown(card, { code: 'Enter' });
    // Drag started → the DragOverlay renders a second copy of the card.
    expect(screen.getAllByText('Ticket 1').length).toBe(2);

    // A background refetch removes the dragged ticket from the page.
    expect(() => {
      rerender(<TicketBoard tickets={[t(2, 'Pending')]} ticketingOn />);
    }).not.toThrow();

    // The phantom drag is cancelled: overlay gone, board healthy, no fallback.
    expect(screen.queryByText('Ticket 1')).not.toBeInTheDocument();
    expect(screen.getByText('Ticket 2')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  test('a render throw inside the board falls back to the inline boundary card, not a white screen', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Force a deterministic render throw with a ticket whose property
      // access explodes mid-render — stands in for any future board crash.
      const poison = new Proxy(t(1, 'Open'), {
        get(target, prop) {
          if (prop === 'subject') throw new Error('poisoned ticket');
          return target[prop];
        },
      });
      render(<TicketBoard tickets={[poison]} ticketingOn />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText(/The ticket board hit an unexpected error/)).toBeInTheDocument();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
