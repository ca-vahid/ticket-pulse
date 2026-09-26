/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AssigneePicker from './AssigneePicker';
import MobileAssignSheet from './MobileAssignSheet';
import HandBackReasonDialog from './HandBackReasonDialog';
import { setCurrentIdentity } from '../../utils/currentIdentity';

// QA 09-25 item 3 (hand-back reason) + item 6 (assignable-only in pickers).

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
vi.mock('../../services/api', () => ({
  ticketsAPI: { assign: (...a) => assign(...a), triage: vi.fn() },
  assignmentAPI: { decide: vi.fn(), recordOverrideReason: vi.fn() },
}));

const terry = { id: 7, name: 'Terry Tech', email: 'terry@x.io', origin: 'freshservice' };
const cora = { id: 2, name: 'Cora Coordinator', email: 'cora@x.io', origin: 'freshservice' };
const juan = { id: 40, name: 'Juan Gonzalez', email: 'juan@x.io', origin: 'freshservice', assignableOnly: true };

beforeEach(() => { assign.mockReset(); assign.mockResolvedValue({}); });
afterEach(() => { cleanup(); act(() => setCurrentIdentity(null)); });

describe('HandBackReasonDialog', () => {
  test('required: no Skip, Other needs a note, Enter submits', () => {
    const onSubmit = vi.fn();
    render(<HandBackReasonDialog open requireReason onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /why are you handing this back/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Other/));
    const submit = screen.getByRole('button', { name: 'Hand back' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Printer is in the Calgary lab' } });
    fireEvent.keyDown(screen.getByLabelText(/Note/), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith({ code: 'other', note: 'Printer is in the Calgary lab' });
  });

  test('coordinator view offers Skip; Esc cancels', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<HandBackReasonDialog open requireReason={false} personName="Terry Tech" onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole('dialog', { name: /Terry Tech's ticket being released/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSubmit).toHaveBeenCalledWith({ code: 'skipped', note: null });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  test('Esc and the backdrop are ignored while the hand-back is saving', () => {
    const onCancel = vi.fn();
    render(<HandBackReasonDialog open busy requireReason onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('hand-back-dialog'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Tab stays inside the dialog; focus returns to the returnFocusRef trigger on close', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.appendChild(trigger);
    const ref = { current: trigger };
    const { rerender } = render(<HandBackReasonDialog open requireReason returnFocusRef={ref} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByTestId('hand-back-dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Last enabled control is Cancel (Hand back is disabled until a reason is picked).
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    rerender(<HandBackReasonDialog open={false} requireReason returnFocusRef={ref} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });
});

describe('AssigneePicker — no hand-back question without a real ticket (S3)', () => {
  test('ticketId null (split form) clears straight away', async () => {
    const assignFn = vi.fn().mockResolvedValue({ data: null });
    render(<AssigneePicker ticketId={null} value={7} technicians={[terry]} assignFn={assignFn} />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Terry Tech/ }));
    fireEvent.click(screen.getByRole('option', { name: /Unassigned/ }));
    await waitFor(() => expect(assignFn).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId('hand-back-dialog')).not.toBeInTheDocument();
  });

  test('askHandBack={false} clears straight away on a real ticket too', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry]} askHandBack={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Terry Tech/ }));
    fireEvent.click(screen.getByRole('option', { name: /Unassigned/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, null));
    expect(screen.queryByTestId('hand-back-dialog')).not.toBeInTheDocument();
  });

  test('cancelling the dialog returns focus to the picker trigger', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry]} />);
    const trigger = screen.getByRole('button', { name: /Assignee: Terry Tech/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Unassigned/ }));
    await screen.findByTestId('hand-back-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('AssigneePicker — clearing the assignee asks why', () => {
  const openAndClear = () => {
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Terry Tech/ }));
    fireEvent.click(screen.getByRole('option', { name: /Unassigned/ }));
    return screen.findByTestId('hand-back-dialog');
  };

  test('the assignee handing back their own ticket must pick a reason; payload carries it', async () => {
    act(() => setCurrentIdentity({ email: 'Terry@x.io' }));
    const onAssigned = vi.fn();
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry, cora]} onAssigned={onAssigned} />);
    await openAndClear();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Capacity full/));
    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, null, { handBack: { code: 'capacity', note: null } }));
    expect(onAssigned).toHaveBeenCalledWith(null);
  });

  test('a coordinator clearing someone else may skip', async () => {
    act(() => setCurrentIdentity({ email: 'cora@x.io' }));
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry, cora]} />);
    await openAndClear();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, null, { handBack: { code: 'skipped', note: null } }));
  });

  test('FS-born: the reason rides the assignFn (fs-update) call', async () => {
    const fsAssign = vi.fn().mockResolvedValue({ success: true, data: {} });
    render(<AssigneePicker ticketId={601} value={7} technicians={[terry]} assignFn={fsAssign} />);
    await openAndClear();
    fireEvent.click(screen.getByLabelText(/Location issue/));
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(fsAssign).toHaveBeenCalledWith(null, { handBack: { code: 'location', note: null } }));
    expect(assign).not.toHaveBeenCalled();
  });

  test('cancel leaves the assignee untouched', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry]} />);
    await openAndClear();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('hand-back-dialog')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  test('assigning a person never asks', async () => {
    render(<AssigneePicker ticketId={501} value={7} technicians={[terry, cora]} />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Terry Tech/ }));
    fireEvent.click(screen.getByRole('option', { name: /Cora Coordinator/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, 2));
    expect(screen.queryByTestId('hand-back-dialog')).not.toBeInTheDocument();
  });
});

describe('assignable-only people (QA 09-25 item 6)', () => {
  test('listed under "Other teams" after the team, and no read-only tag when they hold the ticket', () => {
    render(<AssigneePicker ticketId={501} value={40} technicians={[terry, juan]} />);
    expect(screen.queryByText('read-only')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Juan Gonzalez/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.findIndex((t) => t.includes('Terry'))).toBeLessThan(options.findIndex((t) => t.includes('Juan')));
    expect(screen.getByText('Other teams')).toBeInTheDocument();
  });
});

describe('MobileAssignSheet — Unassign asks why', () => {
  const ticket = { id: 501, displayRef: 'TP-1', subject: 'Printer', origin: 'ticketpulse', assignedTechId: 7, assignedTech: terry, ai: null };

  test('the sheet closes, the dialog asks, and the write carries the reason', async () => {
    act(() => setCurrentIdentity({ email: 'terry@x.io' }));
    const onClose = vi.fn();
    const onAssigned = vi.fn();
    render(<MobileAssignSheet ticket={ticket} open technicians={[terry]} onClose={onClose} onAssigned={onAssigned} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    expect(onClose).toHaveBeenCalled();
    await screen.findByTestId('hand-back-dialog');
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Competency mismatch/));
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'SAP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(501, null, { handBack: { code: 'competency', note: 'SAP' } }));
    expect(onAssigned).toHaveBeenCalledWith(null);
  });

  test('assignable-only people sit under "Other teams" on mobile too', () => {
    render(<MobileAssignSheet ticket={{ ...ticket, assignedTechId: null, assignedTech: null }} open technicians={[terry, juan]} onClose={vi.fn()} />);
    expect(screen.getByText('Other teams')).toBeInTheDocument();
  });
});
