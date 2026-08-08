/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketBoard from './TicketBoard';

// Card anchors (QA 08-07 #7) use <Link>/useLocation, so the board needs a
// router context everywhere it renders.
const render = (ui, options) => rtlRender(ui, { wrapper: MemoryRouter, ...options });

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

describe('TicketBoard queue UX batch (QA 08-07 #6/#7/#12, Phase 3)', () => {
  test('card carries a muted requester line between subject and assignee row', () => {
    render(
      <TicketBoard
        tickets={[t(1, 'Open', { requester: { name: 'Rita Requester' } }), t(2, 'Open')]}
        ticketingOn
      />,
    );
    const line = screen.getByText('Rita Requester');
    expect(line).toBeInTheDocument();
    expect(line).toHaveClass('text-[11px]', 'text-slate-400', 'truncate');
    // No requester on the ticket → no empty line rendered.
    const card2 = screen.getByText('Ticket 2').closest('[role="button"]');
    expect(within(card2).queryByText(/requester/i)).not.toBeInTheDocument();
  });

  test('ref and subject are real anchors (href, draggable=false) with modifier-aware clicks', () => {
    const onClick = vi.fn();
    render(
      <TicketBoard tickets={[t(1, 'Open')]} ticketingOn onCardClick={onClick} />,
    );
    const ref = screen.getByRole('link', { name: 'TP-1' });
    const subject = screen.getByRole('link', { name: 'Ticket 1' });
    for (const a of [ref, subject]) {
      expect(a).toHaveAttribute('href', '/tickets/1');
      // Native HTML5 anchor-drag must not fight dnd-kit's PointerSensor.
      expect(a).toHaveAttribute('draggable', 'false');
    }
    // Plain left-click: preventDefault (fireEvent returns false) + peek/open path.
    expect(fireEvent.click(subject)).toBe(false);
    expect(onClick).toHaveBeenCalledWith(1);
    // Ctrl-click: NOT prevented — the browser's new-tab behavior stays native,
    // and the card's own open handler must not double-fire.
    onClick.mockClear();
    expect(fireEvent.click(subject, { ctrlKey: true })).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('drag still starts with anchors in the card (keyboard fireEvent on the draggable root)', () => {
    render(<TicketBoard tickets={[t(1, 'Open'), t(2, 'Pending')]} ticketingOn />);
    const card = screen.getByText('Ticket 1').closest('[role="button"]');
    // The draggable root keeps its dnd-kit listeners even though the ref and
    // subject inside are now anchors — a drag still activates.
    fireEvent.keyDown(card, { code: 'Enter' });
    // Drag active → DragOverlay renders the second copy of the card.
    expect(screen.getAllByText('Ticket 1').length).toBe(2);
  });

  test('column body uses the raised 50-card height caps (QA 08-07 #12)', () => {
    render(<TicketBoard tickets={[t(1, 'Open')]} ticketingOn />);
    const open = screen.getByRole('region', { name: 'Open column' });
    const body = open.querySelector('.settings-scrollbar');
    expect(body).toHaveClass('min-h-[42rem]', 'max-h-[max(48rem,calc(100vh-200px))]');
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
