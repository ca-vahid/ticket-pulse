/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TicketTasksTab from './TicketTasksTab';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    tasks: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
    removeTask: vi.fn(),
  },
}));

const task = {
  id: 5, title: 'Provision laptop', description: null, status: 'open',
  assignedTechId: null, assignee: null, dueAt: null, remindBeforeMinutes: null,
};

describe('TicketTasksTab (QA 07-17)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('add form shows labeled fields (Task Description, Due Date, Time, Notify Before)', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('No tasks yet.')).toBeInTheDocument());
    expect(screen.getByText('Task Description')).toBeInTheDocument();
    expect(screen.getByText('Due Date')).toBeInTheDocument();
    expect(screen.getByText('Assign To')).toBeInTheDocument();
    // QA 08-04 #8: due TIME (15-min steps, default 5:00 PM) + Notify Before (default Never).
    expect(screen.getByLabelText('Time')).toHaveValue('17:00');
    expect(screen.getByLabelText('Notify Before')).toHaveValue('');
    expect(within(screen.getByLabelText('Notify Before')).getByText('1 Hour')).toBeInTheDocument();
  });

  test('each task exposes a status dropdown (Open/In progress/Done)', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [task] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());
    const statusSelect = screen.getByTitle('Task status');
    expect(statusSelect).toBeInTheDocument();
    expect(statusSelect.value).toBe('open');

    ticketsAPI.updateTask.mockResolvedValue({});
    fireEvent.change(statusSelect, { target: { value: 'done' } });
    await waitFor(() => expect(ticketsAPI.updateTask).toHaveBeenCalledWith(1, 5, { status: 'done' }));
  });
});

describe('TicketTasksTab due time + reminders (QA 08-04 #8)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('adding a task posts a full local-time ISO dueAt plus remindBeforeMinutes', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [] });
    ticketsAPI.addTask.mockResolvedValue({});
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('No tasks yet.')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'Order dock' } });
    fireEvent.change(screen.getByLabelText('Due Date'), { target: { value: '2099-03-05' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:15' } });
    fireEvent.change(screen.getByLabelText('Notify Before'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(ticketsAPI.addTask).toHaveBeenCalledWith(1, {
      title: 'Order dock',
      assignedTechId: null,
      dueAt: new Date('2099-03-05T09:15').toISOString(), // local time, NOT a bare date
      remindBeforeMinutes: 30,
      notifyAgent: true,
    }));
  });

  test('due renders as date+time with an overdue tint when past and not done', async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    ticketsAPI.tasks.mockResolvedValue({ data: [{ ...task, dueAt: past }] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());

    const due = screen.getByText(/^Due (?!Date)/);
    expect(due).toHaveClass('text-rose-600');
    expect(due.textContent).toMatch(/\d{1,2}:\d{2}/); // time, not just the date
  });

  test('a done task never shows the overdue tint', async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    ticketsAPI.tasks.mockResolvedValue({ data: [{ ...task, status: 'done', dueAt: past }] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());
    expect(screen.getByText(/^Due (?!Date)/)).not.toHaveClass('text-rose-600');
  });

  test('pencil opens the edit popover; Save PATCHes only the changed fields', async () => {
    const due = new Date('2099-03-05T17:00');
    ticketsAPI.tasks.mockResolvedValue({
      data: [{ ...task, description: 'old note', dueAt: due.toISOString(), remindBeforeMinutes: 15 }],
    });
    ticketsAPI.updateTask.mockResolvedValue({});
    render(<TicketTasksTab ticketId={1} technicians={[{ id: 9, name: 'Mehdi' }]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Edit task'));
    const popover = screen.getByRole('dialog');
    // Popover pre-fills from the task row.
    expect(within(popover).getByLabelText('Title')).toHaveValue('Provision laptop');
    expect(within(popover).getByLabelText('Due Date')).toHaveValue('2099-03-05');
    expect(within(popover).getByLabelText('Time')).toHaveValue('17:00');
    expect(within(popover).getByLabelText('Notify Before')).toHaveValue('15');

    fireEvent.change(within(popover).getByLabelText('Title'), { target: { value: 'Provision laptop + dock' } });
    fireEvent.change(within(popover).getByLabelText('Time'), { target: { value: '09:30' } });
    fireEvent.change(within(popover).getByLabelText('Notify Before'), { target: { value: '60' } });
    fireEvent.change(within(popover).getByLabelText('Assign To'), { target: { value: '9' } });
    fireEvent.click(within(popover).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(ticketsAPI.updateTask).toHaveBeenCalledWith(1, 5, {
      title: 'Provision laptop + dock',
      assignedTechId: 9,
      dueAt: new Date('2099-03-05T09:30').toISOString(),
      remindBeforeMinutes: 60,
    }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('saving an untouched popover sends no PATCH; Escape closes it', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [task] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Edit task'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(ticketsAPI.updateTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Edit task'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
