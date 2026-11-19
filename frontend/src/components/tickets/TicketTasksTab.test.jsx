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

describe('TicketTasksTab paste a list (QA 11-18 #3)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  const paste = (el, text) => fireEvent.paste(el, { clipboardData: { getData: (type) => (type === 'text/plain' || type === 'text' ? text : '') } });
  const QA_LIST = '- Floor 6:\n    ◦ 11-652 - Keyboard and Mouse\n    ◦ 2-636 - Keyboard and Mouse\n    ◦ 4-210 - Monitor';

  async function mountForm(origin = 'ticketpulse') {
    ticketsAPI.tasks.mockResolvedValue({ data: [] });
    render(<TicketTasksTab ticketId={1} technicians={[{ id: 9, name: 'Dana Fox' }]} canWrite ticketOrigin={origin} />);
    await waitFor(() => expect(screen.getByText('No tasks yet.')).toBeInTheDocument());
    return screen.getByLabelText('Task Description');
  }

  test('a multi-line paste asks first, then adds one task per line with the shared fields', async () => {
    ticketsAPI.addTask.mockResolvedValue({});
    const input = await mountForm();
    fireEvent.change(screen.getByLabelText('Assign To'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Due Date'), { target: { value: '2099-03-05' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:15' } });
    fireEvent.change(screen.getByLabelText('Notify Before'), { target: { value: '60' } });

    paste(input, QA_LIST);
    expect(input).toHaveValue(''); // not dumped into the one-line box
    const confirm = screen.getByTestId('paste-tasks-confirm');
    expect(within(confirm).getByText('Add 3 tasks, one per line?')).toBeInTheDocument();
    expect(within(confirm).getByText(/Headings like ‘Floor 6’ are kept in front of their lines/)).toBeInTheDocument();
    expect(within(confirm).getByText(/one e-mail per task/)).toBeInTheDocument();
    const preview = within(confirm).getByRole('list', { name: 'Tasks to add' });
    expect(within(preview).getAllByRole('listitem')).toHaveLength(3);
    expect(within(preview).getByText('Floor 6 · 2-636 - Keyboard and Mouse')).toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Add 3 tasks' }));
    await waitFor(() => expect(ticketsAPI.addTask).toHaveBeenCalledTimes(3));
    const shared = {
      assignedTechId: 9,
      dueAt: new Date('2099-03-05T09:15').toISOString(),
      remindBeforeMinutes: 60,
      notifyAgent: true,
    };
    expect(ticketsAPI.addTask).toHaveBeenNthCalledWith(1, 1, { title: 'Floor 6 · 11-652 - Keyboard and Mouse', ...shared });
    expect(ticketsAPI.addTask).toHaveBeenNthCalledWith(2, 1, { title: 'Floor 6 · 2-636 - Keyboard and Mouse', ...shared });
    expect(ticketsAPI.addTask).toHaveBeenNthCalledWith(3, 1, { title: 'Floor 6 · 4-210 - Monitor', ...shared });
    await waitFor(() => expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument());
    expect(ticketsAPI.tasks).toHaveBeenCalledTimes(2); // reloaded once, after the run
  });

  test('Cancel drops the list and creates nothing; Escape does too', async () => {
    const input = await mountForm();
    paste(input, 'Order dock\nImage laptop');
    fireEvent.click(within(screen.getByTestId('paste-tasks-confirm')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument();

    paste(input, 'Order dock\nImage laptop');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add 2 tasks' }), { key: 'Escape' });
    expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument();
    expect(ticketsAPI.addTask).not.toHaveBeenCalled();
  });

  test('a single-line paste behaves as before (no confirmation)', async () => {
    const input = await mountForm();
    const ev = paste(input, 'Order dock\n');
    expect(ev).toBe(true); // default not prevented: the browser pastes the line
    expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument();
  });

  test('FreshService errors stop the run and say how many were added; the rest stay to retry', async () => {
    ticketsAPI.addTask
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ response: { data: { message: 'FreshService said no' } } });
    const input = await mountForm('freshservice');
    paste(input, '1. Order dock\n2. Image laptop\n3. Set up printer');
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 tasks' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Added 1 task of 3. Stopped at “Image laptop”: FreshService said no'));
    expect(ticketsAPI.addTask).toHaveBeenCalledTimes(2); // stopped at the first error
    expect(screen.getByRole('button', { name: 'Add 2 tasks' })).toBeInTheDocument();
  });

  // A controllable addTask: each call waits until the test releases it.
  function deferredAddTask() {
    const pending = [];
    ticketsAPI.addTask.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    return {
      calls: () => ticketsAPI.addTask.mock.calls.length,
      releaseNext: async () => { const r = pending.shift(); r?.({}); await Promise.resolve(); },
    };
  }

  test('during a run: Enter, a second click and a paste cannot start anything else', async () => {
    const api = deferredAddTask();
    const input = await mountForm();
    paste(input, 'Order dock\nImage laptop\nSet up printer');
    const addAll = screen.getByRole('button', { name: 'Add 3 tasks' });
    fireEvent.click(addAll);
    await waitFor(() => expect(api.calls()).toBe(1));

    expect(input).toBeDisabled();
    expect(addAll).toBeDisabled();
    fireEvent.click(addAll);
    fireEvent.change(input, { target: { value: 'Typed meanwhile' } });
    fireEvent.keyDown(input, { key: 'Enter' }); // doAdd is guarded
    paste(input, 'Other\nList');
    const preview = screen.getByRole('list', { name: 'Tasks to add' });
    expect(within(preview).getByText('Order dock')).toBeInTheDocument();
    expect(within(preview).queryByText('Other')).not.toBeInTheDocument();
    expect(api.calls()).toBe(1);

    await api.releaseNext();
    await waitFor(() => expect(api.calls()).toBe(2));
    await api.releaseNext();
    await waitFor(() => expect(api.calls()).toBe(3));
    await api.releaseNext();
    await waitFor(() => expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument());
    expect(api.calls()).toBe(3);
    expect(ticketsAPI.addTask.mock.calls.map((c) => c[1].title)).toEqual(['Order dock', 'Image laptop', 'Set up printer']);
    expect(input).not.toBeDisabled();
  });

  test('Stop during a run ends it after the task being added now', async () => {
    const api = deferredAddTask();
    const input = await mountForm();
    paste(input, 'Order dock\nImage laptop\nSet up printer');
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 tasks' }));
    await waitFor(() => expect(api.calls()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('Stopping after this task…')).toBeInTheDocument();
    await api.releaseNext();
    await waitFor(() => expect(screen.getByText('Stopped after 1 task of 3. The rest were not added.')).toBeInTheDocument());
    expect(api.calls()).toBe(1);
    expect(screen.queryByTestId('paste-tasks-confirm')).not.toBeInTheDocument();
  });

  test('more than 50 lines: only the first 50, and it says so', async () => {
    const input = await mountForm();
    paste(input, Array.from({ length: 60 }, (_, i) => `- Item ${i + 1}`).join('\n'));
    const confirm = screen.getByTestId('paste-tasks-confirm');
    expect(within(confirm).getByText('Add 50 tasks, one per line?')).toBeInTheDocument();
    expect(within(confirm).getByText(/Only the first 50 are added; the paste had 60/)).toBeInTheDocument();
  });
});
