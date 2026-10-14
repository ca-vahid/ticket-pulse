/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// "This reply looks like a new request" (13 Oct 2026): one quiet line above
// the conversation, two answers, nothing automatic.
const api = vi.hoisted(() => ({ getNewRequestSuggestion: vi.fn(), splitNewRequest: vi.fn(), dismissNewRequest: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: NewRequestSuggestionLine } = await import('./NewRequestSuggestionLine');

const SUGGESTION = { id: 40, ticketId: 700, state: 'suggested', reason: 'The reply asks for Adobe Acrobat, which has nothing to do with the slow Wi-Fi that was fixed.' };

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getNewRequestSuggestion.mockResolvedValue({ data: { data: SUGGESTION } });
  api.splitNewRequest.mockResolvedValue({ data: { data: { changed: true, child: { id: 801, ref: 'TP-1950' }, parentStatus: { requested: 'Resolved', applied: true } } } });
  api.dismissNewRequest.mockResolvedValue({ data: { data: { changed: true, state: 'dismissed' } } });
});

describe('NewRequestSuggestionLine', () => {
  test('shows the reason in one line with both answers', async () => {
    render(<NewRequestSuggestionLine ticketId={700} canSplit />);
    const line = await screen.findByTestId('new-request-suggestion');
    expect(line).toHaveTextContent('This reply looks like a new request: The reply asks for Adobe Acrobat');
    expect(screen.getByRole('button', { name: 'Split into its own ticket' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'It belongs here' })).toBeInTheDocument();
    expect(api.getNewRequestSuggestion).toHaveBeenCalledWith(700);
  });

  test('nothing waiting, or a failed lookup, renders nothing', async () => {
    api.getNewRequestSuggestion.mockResolvedValueOnce({ data: { data: null } });
    const { container, unmount } = render(<NewRequestSuggestionLine ticketId={700} canSplit />);
    await waitFor(() => expect(api.getNewRequestSuggestion).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    api.getNewRequestSuggestion.mockRejectedValueOnce(new Error('offline'));
    const again = render(<NewRequestSuggestionLine ticketId={700} canSplit />);
    await waitFor(() => expect(api.getNewRequestSuggestion).toHaveBeenCalledTimes(2));
    expect(again.container).toBeEmptyDOMElement();
  });

  test('"Split into its own ticket" splits once, hides the line and reports the new ticket', async () => {
    const onSplit = vi.fn();
    render(<NewRequestSuggestionLine ticketId={700} canSplit onSplit={onSplit} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Split into its own ticket' }));
    await waitFor(() => expect(api.splitNewRequest).toHaveBeenCalledWith(700, 40));
    await waitFor(() => expect(onSplit).toHaveBeenCalledWith(expect.objectContaining({ child: { id: 801, ref: 'TP-1950' } })));
    expect(screen.queryByTestId('new-request-suggestion')).not.toBeInTheDocument();
    expect(api.splitNewRequest).toHaveBeenCalledTimes(1);
  });

  test('"It belongs here" dismisses and hides the line', async () => {
    const onDismissed = vi.fn();
    render(<NewRequestSuggestionLine ticketId={700} canSplit onDismissed={onDismissed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'It belongs here' }));
    await waitFor(() => expect(api.dismissNewRequest).toHaveBeenCalledWith(700, 40));
    await waitFor(() => expect(onDismissed).toHaveBeenCalled());
    expect(screen.queryByTestId('new-request-suggestion')).not.toBeInTheDocument();
    expect(api.splitNewRequest).not.toHaveBeenCalled();
  });

  test('an agent sees the line and can keep the reply, but cannot split', async () => {
    render(<NewRequestSuggestionLine ticketId={700} canSplit={false} />);
    await screen.findByTestId('new-request-suggestion');
    expect(screen.queryByRole('button', { name: 'Split into its own ticket' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'It belongs here' })).toBeInTheDocument();
  });

  test('a refused split keeps the line and says why', async () => {
    api.splitNewRequest.mockRejectedValueOnce({ response: { data: { message: 'The reply this suggestion was about is no longer on the ticket.' } } });
    const onError = vi.fn();
    render(<NewRequestSuggestionLine ticketId={700} canSplit onError={onError} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Split into its own ticket' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The reply this suggestion was about is no longer on the ticket.'));
    expect(screen.getByTestId('new-request-suggestion')).toBeInTheDocument();
  });

  test('looks again when the conversation changes', async () => {
    api.getNewRequestSuggestion.mockResolvedValueOnce({ data: { data: null } });
    const { rerender } = render(<NewRequestSuggestionLine ticketId={700} canSplit refreshKey="3:Resolved" />);
    await waitFor(() => expect(api.getNewRequestSuggestion).toHaveBeenCalledTimes(1));
    rerender(<NewRequestSuggestionLine ticketId={700} canSplit refreshKey="4:Open" />);
    expect(await screen.findByTestId('new-request-suggestion')).toBeInTheDocument();
    expect(api.getNewRequestSuggestion).toHaveBeenCalledTimes(2);
  });
});
