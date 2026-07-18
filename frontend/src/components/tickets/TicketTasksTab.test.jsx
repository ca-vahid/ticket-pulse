/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const task = { id: 5, title: 'Provision laptop', description: null, status: 'open', assignedTechId: null, assignee: null, dueAt: null };

describe('TicketTasksTab (QA 07-17)', () => {
  afterEach(() => cleanup());

  test('add form shows labeled fields (Task Description, Due Date)', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [] });
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('No tasks yet.')).toBeInTheDocument());
    expect(screen.getByText('Task Description')).toBeInTheDocument();
    expect(screen.getByText('Due Date')).toBeInTheDocument();
    expect(screen.getByText('Assign To')).toBeInTheDocument();
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

  test('task description is editable inline', async () => {
    ticketsAPI.tasks.mockResolvedValue({ data: [task] });
    ticketsAPI.updateTask.mockResolvedValue({});
    render(<TicketTasksTab ticketId={1} technicians={[]} canWrite ticketOrigin="ticketpulse" />);
    await waitFor(() => expect(screen.getByText('Provision laptop')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Edit task description'));
    const input = screen.getByLabelText('Edit task description');
    fireEvent.change(input, { target: { value: 'Provision laptop + dock' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(ticketsAPI.updateTask).toHaveBeenCalledWith(1, 5, { title: 'Provision laptop + dock' }));
  });
});
