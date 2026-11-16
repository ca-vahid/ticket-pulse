/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, test, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ getObservers: vi.fn(), setObservers: vi.fn() }));
vi.mock('../../services/api', () => ({ notificationWorkflowAPI: api }));
vi.mock('../../utils/currentIdentity', () => ({ useCurrentIdentity: () => ({ email: 'alex.rivera@example.com', name: 'Alex Rivera' }) }));

const { default: WorkflowMailObservers, untilFor, scopeText } = await import('./WorkflowMailObservers');

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const workflows = [
  { id: 16100, name: 'Ticket arrived', isEnabled: true },
  { id: 5, name: 'Ticket resolved or closed', isEnabled: true },
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('Copy me on workflow e-mails', () => {
  test('nobody yet: says so, and the form starts with me, 2 weeks, every workflow', async () => {
    api.getObservers.mockResolvedValue({ data: { observers: [] } });
    api.setObservers.mockImplementation(async (list) => ({ data: { observers: list.map((o) => ({ ...o, email: o.email.toLowerCase(), active: true })) } }));
    render(<WorkflowMailObservers workflows={workflows} />);
    expect(await screen.findByText(/Nobody gets a Bcc/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Copy someone on workflow e-mails'));
    expect(screen.getByLabelText('E-mail address to Bcc')).toHaveValue('alex.rivera@example.com');
    expect(screen.getByLabelText('How long')).toHaveValue('14');
    fireEvent.click(screen.getByText('Start Bcc'));
    await waitFor(() => expect(api.setObservers).toHaveBeenCalled());
    const [list] = api.setObservers.mock.calls[0];
    expect(list).toEqual([expect.objectContaining({ email: 'alex.rivera@example.com', name: 'Alex Rivera', workflowIds: null })]);
    expect(await screen.findByText(/gets a Bcc of every workflow e-mail until/)).toBeInTheDocument();
  });

  test('an active observer shows with Stop; Stop saves the list without them', async () => {
    api.getObservers.mockResolvedValue({ data: { observers: [
      { email: 'alex.rivera@example.com', name: 'Alex Rivera', until: inDays(10), workflowIds: null, active: true },
      { email: 'sam@example.com', name: null, until: inDays(3), workflowIds: [5], active: true },
    ] } });
    api.setObservers.mockResolvedValue({ data: { observers: [] } });
    render(<WorkflowMailObservers workflows={workflows} />);
    expect(await screen.findAllByTestId('observer-row')).toHaveLength(2);
    expect(screen.getByText(/e-mails from "Ticket resolved or closed"/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Stop Bcc for sam@example.com'));
    await waitFor(() => expect(api.setObservers).toHaveBeenCalledWith([
      expect.objectContaining({ email: 'alex.rivera@example.com' }),
    ]));
  });

  test('chosen workflows needs at least one ticked', async () => {
    api.getObservers.mockResolvedValue({ data: { observers: [] } });
    render(<WorkflowMailObservers workflows={workflows} />);
    fireEvent.click(await screen.findByText('Copy someone on workflow e-mails'));
    fireEvent.change(screen.getByLabelText('Which workflows'), { target: { value: 'some' } });
    fireEvent.click(screen.getByText('Start Bcc'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one workflow');
    expect(api.setObservers).not.toHaveBeenCalled();
  });

  test('helpers: the end of the last day, and the scope in words', () => {
    const until = new Date(untilFor(14, new Date('2026-11-16T20:00:00Z')));
    expect(until.getHours()).toBe(23);
    expect(scopeText({ workflowIds: null })).toBe('every workflow e-mail');
    expect(scopeText({ workflowIds: [5, 16100] }, workflows)).toBe('e-mails from 2 workflows');
  });
});
