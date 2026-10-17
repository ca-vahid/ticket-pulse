/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AssigneePicker from './AssigneePicker';
import MobileAssignSheet from './MobileAssignSheet';
import HandBackReasonDialog from './HandBackReasonDialog';
import EscalationNote from './EscalationNote';
import { setCurrentIdentity } from '../../utils/currentIdentity';
import { asksChangeReason, latestEscalation, reasonOptions } from '../../utils/handBack';

/**
 * QA 10-16 item 1: ONE reason dialog for every change of agent — the queue
 * row, the peek and the ticket page (all AssigneePicker), the phone sheet and
 * the bulk bar (Tickets.bulkHandBack test) — with the same reasons, plus
 * Access / permission limited, and Escalate only when the ticket is unassigned.
 */

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
const recordOverrideReason = vi.fn();
vi.mock('../../services/api', () => ({
  ticketsAPI: { assign: (...a) => assign(...a), triage: vi.fn() },
  assignmentAPI: { decide: vi.fn(), recordOverrideReason: (...a) => recordOverrideReason(...a) },
}));

const alex = { id: 7, name: 'Alex Doe', email: 'alex@example.com', origin: 'freshservice' };
const sam = { id: 9, name: 'Sam Lee', email: 'sam@example.com', origin: 'freshservice' };
const cora = { id: 2, name: 'Cora Lane', email: 'cora@example.com', origin: 'freshservice' };

beforeEach(() => { assign.mockReset(); assign.mockResolvedValue({}); recordOverrideReason.mockReset(); });
afterEach(() => { cleanup(); act(() => setCurrentIdentity(null)); });

const labels = () => within(screen.getByTestId('hand-back-reasons')).getAllByRole('radio').map((r) => r.value);

describe('the reasons', () => {
  test('unassign: the four old reasons, Access / permission limited, Other, then Escalate set apart', () => {
    render(<HandBackReasonDialog open mode="unassign" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(labels()).toEqual(['location', 'capacity', 'competency', 'access', 'other', 'escalate']);
    expect(screen.getByLabelText(/Access \/ permission limited/)).toBeInTheDocument();
    expect(within(screen.getByTestId('hand-back-escalate')).getByLabelText(/Escalate to Advanced Troubleshooting Team/)).toBeInTheDocument();
  });

  test('reassign: the same list without Escalate', () => {
    render(<HandBackReasonDialog open mode="reassign" toName="Sam Lee" requireReason={false} personName="Alex Doe" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(labels()).toEqual(['location', 'capacity', 'competency', 'access', 'other']);
    expect(screen.queryByTestId('hand-back-escalate')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Why move Alex Doe's ticket to Sam Lee\?/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument();
  });

  test('Escalate names the category and says what happens; the button says Escalate', () => {
    const onSubmit = vi.fn();
    render(<HandBackReasonDialog open mode="unassign" categoryLabel="Networking / VPN" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByText(/Needs someone more advanced in Networking \/ VPN/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Escalate to Advanced Troubleshooting Team/));
    expect(screen.getByText(/only pick someone at a higher level in Networking \/ VPN/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));
    expect(onSubmit).toHaveBeenCalledWith({ code: 'escalate', note: null });
  });

  test('reasonOptions + asksChangeReason', () => {
    expect(reasonOptions('reassign').some((o) => o.code === 'escalate')).toBe(false);
    expect(asksChangeReason({ fromId: 7, toId: 9 })).toBe(true);
    expect(asksChangeReason({ fromId: null, toId: 9 })).toBe(false); // first assignment
    expect(asksChangeReason({ fromId: 7, toId: 7 })).toBe(false);
    expect(asksChangeReason({ fromId: 7, toId: 9, toTech: sam, me: { email: 'SAM@example.com' } })).toBe(false); // taking it yourself
  });
});

describe('AssigneePicker (queue row, peek, ticket page): moving to another person asks the same question', () => {
  const openAndPick = (name) => {
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Alex Doe/ }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
    return screen.findByTestId('hand-back-dialog');
  };

  test('the dialog opens before anything is written; the write carries the reason and the new person', async () => {
    act(() => setCurrentIdentity({ email: 'cora@example.com' }));
    const onAssigned = vi.fn();
    render(<AssigneePicker ticketId={501} value={7} technicians={[alex, sam, cora]} onAssigned={onAssigned} />);
    const dialog = await openAndPick('Sam Lee');
    expect(dialog).toHaveAttribute('data-mode', 'reassign');
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Access \/ permission limited/));
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'needs domain admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, 9, { handBack: { code: 'access', note: 'needs domain admin' } }));
    expect(onAssigned).toHaveBeenCalledWith(9);
  });

  test('my own ticket: no Skip; FS-born goes through the assignFn with the reason', async () => {
    act(() => setCurrentIdentity({ email: 'alex@example.com' }));
    const fsAssign = vi.fn().mockResolvedValue({ success: true, data: { aiOverride: true, reasonRecorded: true } });
    render(<AssigneePicker ticketId={601} value={7} technicians={[alex, sam]} assignFn={fsAssign} />);
    await openAndPick('Sam Lee');
    expect(screen.getByRole('dialog', { name: /Why are you passing this to Sam Lee\?/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Capacity full/));
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(fsAssign).toHaveBeenCalledWith(9, { handBack: { code: 'capacity', note: null } }));
    // The one dialog replaces the old override toast: nothing else pops up.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(recordOverrideReason).not.toHaveBeenCalled();
  });

  test('cancel leaves the assignee untouched', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[alex, sam]} />);
    await openAndPick('Sam Lee');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(assign).not.toHaveBeenCalled();
  });

  test('taking it yourself does not ask', async () => {
    act(() => setCurrentIdentity({ email: 'sam@example.com' }));
    render(<AssigneePicker ticketId={501} value={7} technicians={[alex, sam]} />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Alex Doe/ }));
    fireEvent.click(screen.getByRole('option', { name: /Sam Lee/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, 9));
    expect(screen.queryByTestId('hand-back-dialog')).not.toBeInTheDocument();
  });

  test('Unassigned opens the same dialog, with Escalate', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[alex, sam]} categoryLabel="Networking / VPN" />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Alex Doe/ }));
    fireEvent.click(screen.getByRole('option', { name: /Unassigned/ }));
    const dialog = await screen.findByTestId('hand-back-dialog');
    expect(dialog).toHaveAttribute('data-mode', 'unassign');
    fireEvent.click(screen.getByLabelText(/Escalate to Advanced Troubleshooting Team/));
    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, null, { handBack: { code: 'escalate', note: null } }));
  });
});

describe('MobileAssignSheet: the same dialog on the phone', () => {
  const ticket = {
    id: 501, displayRef: 'TP-1', subject: 'VPN drops', origin: 'ticketpulse', assignedTechId: 7, assignedTech: alex, ai: null,
    internalCategory: { name: 'Networking' }, internalSubcategory: { name: 'VPN' },
  };
  test('picking another person closes the sheet and asks why', async () => {
    const onClose = vi.fn();
    render(<MobileAssignSheet ticket={ticket} open technicians={[alex, sam]} onClose={onClose} onAssigned={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sam Lee/ }));
    expect(onClose).toHaveBeenCalled();
    const dialog = await screen.findByTestId('hand-back-dialog');
    expect(dialog).toHaveAttribute('data-mode', 'reassign');
    expect(screen.queryByTestId('hand-back-escalate')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Location issue/));
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, 9, { handBack: { code: 'location', note: null } }));
  });
});

describe('EscalationNote: the ticket says it was escalated', () => {
  const activities = [
    { activityType: 'assigned', performedBy: 'Alex Doe', performedAt: '2026-10-16T17:00:00Z', details: { handBack: { code: 'capacity' } } },
    {
      activityType: 'assigned',
      performedBy: 'Alex Doe',
      performedAt: '2026-10-16T18:00:00Z',
      details: { handBack: { code: 'escalate', fromTechName: 'Alex Doe', escalation: { fromTechName: 'Alex Doe', scope: 'Networking / VPN', level: 'intermediate' } } },
    },
  ];
  test('latestEscalation reads the snapshot from the audit rows', () => {
    expect(latestEscalation(activities)).toMatchObject({ by: 'Alex Doe', scope: 'Networking / VPN', level: 'intermediate' });
    expect(latestEscalation([activities[0]])).toBeNull();
  });
  test('renders the plain line', () => {
    render(<EscalationNote activities={activities} />);
    expect(screen.getByTestId('escalation-note')).toHaveTextContent('Escalated by Alex Doe: needs someone more advanced in Networking / VPN');
  });
});
