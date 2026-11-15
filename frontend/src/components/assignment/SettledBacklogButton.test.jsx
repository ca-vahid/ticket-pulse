/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * MEGA 11-14 Part B: "Clear N settled items" in Assignment Review — the count
 * first, one confirmation that says nothing is assigned and nobody is told,
 * then the result. Admin only; nothing to clear means no button.
 */

const getSettledBacklog = vi.fn();
const clearSettledBacklog = vi.fn();
vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getSettledBacklog: (...a) => getSettledBacklog(...a),
    clearSettledBacklog: (...a) => clearSettledBacklog(...a),
  },
}));

import SettledBacklogButton from './SettledBacklogButton';

beforeEach(() => {
  getSettledBacklog.mockReset();
  clearSettledBacklog.mockReset();
});
afterEach(cleanup);

test('not an admin: no request, no button', async () => {
  render(<SettledBacklogButton isAdmin={false} />);
  await act(async () => {});
  expect(getSettledBacklog).not.toHaveBeenCalled();
  expect(screen.queryByTestId('settled-backlog-button')).toBeNull();
});

test('nothing to clear: no button', async () => {
  getSettledBacklog.mockResolvedValue({ data: { count: 0 } });
  render(<SettledBacklogButton isAdmin />);
  await act(async () => {});
  expect(screen.queryByTestId('settled-backlog-button')).toBeNull();
});

test('shows the count, asks once, clears, and says how many', async () => {
  getSettledBacklog.mockResolvedValue({ data: { count: 2131 } });
  clearSettledBacklog.mockResolvedValue({ data: { settled: 2131, remaining: 0 } });
  const onCleared = vi.fn();
  render(<SettledBacklogButton isAdmin onCleared={onCleared} />);
  const button = await screen.findByRole('button', { name: /Clear 2,131 settled items/ });

  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'Clear 2,131 settled items?' });
  expect(dialog).toHaveTextContent('already have an owner, or are closed or removed');
  expect(dialog).toHaveTextContent('Nothing is assigned and nobody is told.');
  expect(clearSettledBacklog).not.toHaveBeenCalled();

  await act(async () => { fireEvent.click(screen.getByTestId('settled-backlog-confirm')); });
  expect(clearSettledBacklog).toHaveBeenCalledTimes(1);
  expect(onCleared).toHaveBeenCalledWith({ settled: 2131, remaining: 0 });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByTestId('settled-backlog-message')).toHaveTextContent('Cleared 2,131.');
});

test('Cancel and Escape close without clearing; a failure says so', async () => {
  getSettledBacklog.mockResolvedValue({ data: { count: 1 } });
  clearSettledBacklog.mockRejectedValue(new Error('Network down'));
  render(<SettledBacklogButton isAdmin />);
  fireEvent.click(await screen.findByRole('button', { name: /Clear 1 settled item$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByTestId('settled-backlog-button'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(clearSettledBacklog).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('settled-backlog-button'));
  await act(async () => { fireEvent.click(screen.getByTestId('settled-backlog-confirm')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not clear: Network down');
});
