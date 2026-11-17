/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getMachineSenders = vi.fn();
const setMachineSenders = vi.fn();
vi.mock('../../services/api', () => ({ notificationWorkflowAPI: { getMachineSenders: (...a) => getMachineSenders(...a), setMachineSenders: (...a) => setMachineSenders(...a) } }));

const { default: WorkflowMachineSenders, cleanEntry, kindOf, summary } = await import('./WorkflowMachineSenders');

const entries = (values) => values.map((value) => ({ value, kind: kindOf(value) }));

beforeEach(() => {
  getMachineSenders.mockReset();
  setMachineSenders.mockReset();
});
afterEach(cleanup);

describe('Machine senders card', () => {
  test('helpers: the three shapes, and a short summary', () => {
    expect(cleanEntry(' *@Alerts-Example.org ')).toBe('@alerts-example.org');
    expect(cleanEntry('no')).toBeNull();
    expect(kindOf('bot@example.com')).toBe('address');
    expect(kindOf('example.org')).toBe('domain');
    expect(kindOf('noreply')).toBe('word');
    expect(summary(entries(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']))).toBe('Workflows never e-mail a.com, b.com, c.com, d.com and 1 more.');
  });

  test('shows the standard list until saved, then edit: add, remove, test, save', async () => {
    getMachineSenders.mockResolvedValue({ data: { entries: entries(['noreply', 'no-reply']), saved: false } });
    setMachineSenders.mockImplementation(async (list) => ({ data: { entries: entries(list), saved: true } }));
    render(<WorkflowMachineSenders />);
    expect(await screen.findByTestId('machine-senders-summary')).toHaveTextContent('Workflows never e-mail noreply, no-reply. (the standard list)');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Add a machine sender'), { target: { value: 'Notifications@App.HR-Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove no-reply' }));
    expect(screen.getAllByTestId('machine-sender-row').map((r) => r.textContent)).toEqual([
      'noreplyany address with this in its name',
      'notifications@app.hr-example.comthis address',
    ]);

    fireEvent.change(screen.getByLabelText('Test an address'), { target: { value: 'notifications@app.hr-example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByTestId('machine-sender-test')).toHaveTextContent('No workflow e-mails: matches notifications@app.hr-example.com.');
    fireEvent.change(screen.getByLabelText('Test an address'), { target: { value: 'rita@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByTestId('machine-sender-test')).toHaveTextContent('Gets workflow e-mails as usual.');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setMachineSenders).toHaveBeenCalledWith(['noreply', 'notifications@app.hr-example.com']));
    expect(await screen.findByTestId('machine-senders-summary')).toHaveTextContent('Workflows never e-mail noreply, notifications@app.hr-example.com.');
  });

  test('refuses text that is not an address, domain or word', async () => {
    getMachineSenders.mockResolvedValue({ data: { entries: [], saved: true } });
    render(<WorkflowMachineSenders />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Add a machine sender'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an address');
    expect(screen.queryAllByTestId('machine-sender-row')).toHaveLength(0);
  });
});
