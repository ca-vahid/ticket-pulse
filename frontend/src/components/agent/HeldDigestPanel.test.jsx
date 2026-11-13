/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HeldDigestPanel, { HELD_DIGEST_PREF_KEY } from './HeldDigestPanel';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: { getQueuePreference: vi.fn(), setQueuePreference: vi.fn() },
}));

beforeEach(() => {
  ticketsAPI.getQueuePreference.mockResolvedValue({ data: { key: HELD_DIGEST_PREF_KEY, value: null } });
  ticketsAPI.setQueuePreference.mockResolvedValue({ data: { key: HELD_DIGEST_PREF_KEY, value: 'off' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const toggle = () => screen.getByTestId('held-digest-toggle');

describe('Held e-mail digest switch (QA 11-12 #1)', () => {
  test('people who do not receive the digest see nothing, and nothing is asked', () => {
    const { container } = render(<HeldDigestPanel workspaceId={2} workspaceName="Accounting Team" receives={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(ticketsAPI.getQueuePreference).not.toHaveBeenCalled();
  });

  test('never set means on; switching it off saves "off" for this workspace and says so', async () => {
    render(<HeldDigestPanel workspaceId={2} workspaceName="Accounting Team" receives />);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(ticketsAPI.getQueuePreference).toHaveBeenCalledWith('mail.heldDigest');
    expect(screen.getByRole('switch', { name: 'Send me the held e-mail digest for Accounting Team' })).toBeInTheDocument();
    expect(screen.getByTestId('held-digest-panel')).toHaveTextContent('only for Accounting Team');

    fireEvent.click(toggle());
    await waitFor(() => expect(ticketsAPI.setQueuePreference).toHaveBeenCalledWith('mail.heldDigest', 'off'));
    await waitFor(() => expect(screen.getByTestId('held-digest-note')).toHaveTextContent('Off. You will not get this e-mail for this workspace.'));
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  test('a stored "off" shows off; switching it back saves "on"', async () => {
    ticketsAPI.getQueuePreference.mockResolvedValue({ data: { key: HELD_DIGEST_PREF_KEY, value: 'off' } });
    render(<HeldDigestPanel workspaceId={2} workspaceName="Accounting Team" receives />);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(ticketsAPI.setQueuePreference).toHaveBeenCalledWith('mail.heldDigest', 'on'));
  });

  test('a failed save puts the switch back and says so', async () => {
    ticketsAPI.setQueuePreference.mockRejectedValue(new Error('500'));
    render(<HeldDigestPanel workspaceId={2} workspaceName="Accounting Team" receives />);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId('held-digest-note')).toHaveTextContent('That did not save. Try again.'));
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  test('the setting is read again when the workspace changes', async () => {
    const { rerender } = render(<HeldDigestPanel workspaceId={2} workspaceName="Accounting Team" receives />);
    await waitFor(() => expect(ticketsAPI.getQueuePreference).toHaveBeenCalledTimes(1));
    rerender(<HeldDigestPanel workspaceId={1} workspaceName="IT" receives />);
    await waitFor(() => expect(ticketsAPI.getQueuePreference).toHaveBeenCalledTimes(2));
  });
});
