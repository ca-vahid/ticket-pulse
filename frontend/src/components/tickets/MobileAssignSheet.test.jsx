/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MobileAssignSheet from './MobileAssignSheet';

// vaul relies on DOM APIs jsdom lacks; render its parts as plain wrappers so we
// can exercise the sheet body. Root shows children only when `open`.
vi.mock('vaul', () => {
  const Pass = ({ children }) => children;
  return {
    Drawer: {
      Root: ({ children, open }) => (open ? children : null),
      Portal: Pass,
      Overlay: () => null,
      Content: ({ children }) => <div>{children}</div>,
      Title: ({ children }) => <div>{children}</div>,
    },
  };
});

const assign = vi.fn().mockResolvedValue({});
const decide = vi.fn().mockResolvedValue({});
const recordOverrideReason = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  ticketsAPI: { assign: (...a) => assign(...a), triage: vi.fn() },
  assignmentAPI: { decide: (...a) => decide(...a), recordOverrideReason: (...a) => recordOverrideReason(...a) },
}));

afterEach(() => {
  cleanup();
  assign.mockReset(); assign.mockResolvedValue({});
  decide.mockClear(); recordOverrideReason.mockClear();
});

const team = [
  { id: 10, name: 'Alison Norton', origin: 'freshservice' },
  { id: 11, name: 'Brendan Navoa', origin: 'freshservice' },
];

const suggestedTicket = {
  id: 1,
  displayRef: '#231309',
  subject: 'Payment receipt',
  origin: 'freshservice',
  freshserviceTicketId: '231309',
  assignedTechId: null,
  assignedTech: null,
  ai: {
    runId: 7,
    state: 'suggested',
    techId: 49,
    techName: 'Zoe Dio',
    score: 0.89,
    candidates: [
      { techId: 49, techName: 'Zoe Dio', score: 0.89 },
      { techId: 50, techName: 'Benjamin Rabel', score: 0.87 },
      { techId: 51, techName: 'Dominic Bautista', score: 0.86 },
    ],
  },
};

describe('MobileAssignSheet', () => {
  test('lists all AI candidates and the member list, top pre-selected', () => {
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={() => {}} onAssigned={() => {}} />);
    expect(screen.getByRole('radio', { name: /Zoe Dio/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Benjamin Rabel/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Dominic Bautista/ })).toBeInTheDocument();
    // Member list (with an Unassigned option) is present too.
    expect(screen.getByText('Alison Norton')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  test('does NOT auto-focus the search field (no keyboard pop on open)', () => {
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={() => {}} onAssigned={() => {}} />);
    const search = screen.getByRole('searchbox', { name: /search members/i });
    expect(document.activeElement).not.toBe(search);
  });

  test('tapping a member assigns and closes', async () => {
    const onClose = vi.fn();
    const onAssigned = vi.fn();
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={onClose} onAssigned={onAssigned} />);
    fireEvent.click(screen.getByText('Brendan Navoa'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(1, 11));
    expect(onAssigned).toHaveBeenCalledWith(11);
    expect(onClose).toHaveBeenCalled();
  });

  test('Approve decides the selected AI candidate', async () => {
    const onAssigned = vi.fn();
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={() => {}} onAssigned={onAssigned} />);
    fireEvent.click(screen.getByRole('radio', { name: /Benjamin Rabel/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(7, { decision: 'approved', assignedTechId: 50 }));
  });

  // QA 08-04 #9: the sheet raises the same "Why the override?" toast as the
  // desktop picker when the assign response flags an AI override — and the
  // toast survives the sheet closing (it portals outside the drawer).
  test('assigning over a completed AI decision raises the override prompt and records the reason', async () => {
    assign.mockResolvedValue({ success: true, data: { aiOverride: true } });
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={() => {}} onAssigned={() => {}} />);
    fireEvent.click(screen.getByText('Brendan Navoa'));

    expect(await screen.findByText('Why the override?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load balancing' }));
    await waitFor(() => expect(recordOverrideReason).toHaveBeenCalledWith(
      1, { toTechnicianId: 11, reasonCode: 'load_balancing' },
    ));
  });

  test('no override prompt when the assign response carries no flag', async () => {
    render(<MobileAssignSheet open ticket={suggestedTicket} technicians={team} canReview onClose={() => {}} onAssigned={() => {}} />);
    fireEvent.click(screen.getByText('Brendan Navoa'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(1, 11));
    expect(screen.queryByText('Why the override?')).not.toBeInTheDocument();
  });
});
