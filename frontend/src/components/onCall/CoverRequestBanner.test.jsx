/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// App-wide on-call cover prompt: one slim line when somebody asks the
// signed-in person for cover; silent when there is nothing, or on a failure.

const api = vi.hoisted(() => ({ myCoverRequests: vi.fn(), respondCoverRequest: vi.fn() }));
vi.mock('../../services/api', () => ({ urgentResponseAPI: api }));
const authState = { isAuthenticated: true };
const wsState = { currentWorkspace: { id: 1 } };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));

const { default: CoverRequestBanner, COVER_POLL_MS } = await import('./CoverRequestBanner');

const REQUEST = {
  id: 41,
  original: { id: 3, name: 'Andrew Fong' },
  startsAt: '2026-10-16T00:00:00.000Z',
  endsAt: '2026-10-20T00:00:00.000Z',
  timezone: 'America/Vancouver',
  message: null,
  createdBy: 'Vahid Haeri',
};
const SECOND = { ...REQUEST, id: 42, original: { id: 5, name: 'David Zapata' } };
const ok = (data) => Promise.resolve({ success: true, data });

const renderBanner = (path = '/tickets') => render(
  <MemoryRouter initialEntries={[path]}>
    <CoverRequestBanner />
  </MemoryRouter>,
);

beforeEach(() => {
  sessionStorage.clear();
  authState.isAuthenticated = true;
  wsState.currentWorkspace = { id: 1 };
  api.myCoverRequests.mockImplementation(() => ok([REQUEST]));
  api.respondCoverRequest.mockImplementation(() => ok({ status: 'filled', cover: { id: 91 } }));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('CoverRequestBanner', () => {
  test('says who needs cover and when, with the three answers', async () => {
    renderBanner();
    const banner = await screen.findByTestId('cover-request-banner');
    expect(banner).toHaveTextContent('Andrew Fong needs on-call cover from Thu 15 Oct to Mon 19 Oct. Can you take it?');
    expect(within(banner).getByRole('button', { name: 'Take it' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Not this time' })).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'See schedule' })).toHaveAttribute('href', '/on-call?request=41');
  });

  test('nothing renders when there are no requests', async () => {
    api.myCoverRequests.mockImplementation(() => ok([]));
    renderBanner();
    await waitFor(() => expect(api.myCoverRequests).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cover-request-banner')).not.toBeInTheDocument();
  });

  test('a failed check is silent', async () => {
    api.myCoverRequests.mockImplementation(() => Promise.reject(new Error('boom')));
    renderBanner();
    await waitFor(() => expect(api.myCoverRequests).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cover-request-banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('Take it confirms with the exact commitment, then accepts and says thank you', async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Take it' }));
    expect(api.respondCoverRequest).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('You will be on call from Thu 15 Oct 5:00 p.m. to Mon 19 Oct 5:00 p.m.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(api.respondCoverRequest).toHaveBeenCalledWith(41, 'accept'));
    expect(await screen.findByText(/Thank you\. You will be on call from Thu 15 Oct/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument();
  });

  test('Not this time declines and the line goes away', async () => {
    renderBanner();
    api.myCoverRequests.mockImplementation(() => ok([]));
    fireEvent.click(await screen.findByRole('button', { name: 'Not this time' }));
    await waitFor(() => expect(api.respondCoverRequest).toHaveBeenCalledWith(41, 'decline'));
    await waitFor(() => expect(screen.queryByTestId('cover-request-banner')).not.toBeInTheDocument());
  });

  test('409 on Take it: someone else already took it', async () => {
    api.respondCoverRequest.mockImplementation(() => Promise.reject(Object.assign(new Error('Already filled'), { status: 409 })));
    renderBanner();
    api.myCoverRequests.mockImplementation(() => ok([]));
    fireEvent.click(await screen.findByRole('button', { name: 'Take it' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Take it' }));
    expect(await screen.findByText(/Someone else already took it/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('dismiss hides that request for the session and shows the next one', async () => {
    api.myCoverRequests.mockImplementation(() => ok([REQUEST, SECOND]));
    const first = renderBanner();
    expect(await screen.findByTestId('cover-request-banner')).toHaveTextContent('Andrew Fong needs');
    fireEvent.click(screen.getByRole('button', { name: 'Hide this request for now' }));
    expect(screen.getByTestId('cover-request-banner')).toHaveTextContent('David Zapata needs');
    expect(JSON.parse(sessionStorage.getItem('tp_coverRequestsDismissed'))).toEqual(['41']);
    expect(api.respondCoverRequest).not.toHaveBeenCalled();

    // A new page load in the same session keeps it hidden.
    first.unmount();
    renderBanner('/dashboard');
    expect(await screen.findByTestId('cover-request-banner')).toHaveTextContent('David Zapata needs');
  });

  test.each(['/login', '/workspace', '/approval/AbC123', '/ticket-status/9f8e7d', '/summit/vote/tok', '/on-call'])('never on %s', async (path) => {
    renderBanner(path);
    await act(async () => { await Promise.resolve(); });
    expect(api.myCoverRequests).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cover-request-banner')).not.toBeInTheDocument();
  });

  test('never for a signed-out visitor, and it does show on /approvals', async () => {
    authState.isAuthenticated = false;
    const signedOut = renderBanner('/tickets');
    await act(async () => { await Promise.resolve(); });
    expect(api.myCoverRequests).not.toHaveBeenCalled();
    signedOut.unmount();

    authState.isAuthenticated = true;
    renderBanner('/approvals');
    expect(await screen.findByTestId('cover-request-banner')).toBeInTheDocument();
  });

  test('checks again every 10 minutes', async () => {
    vi.useFakeTimers();
    api.myCoverRequests.mockImplementation(() => ok([]));
    renderBanner();
    await act(async () => { await Promise.resolve(); });
    expect(api.myCoverRequests).toHaveBeenCalledTimes(1);
    api.myCoverRequests.mockImplementation(() => ok([REQUEST]));
    await act(async () => { await vi.advanceTimersByTimeAsync(COVER_POLL_MS); });
    expect(api.myCoverRequests).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('cover-request-banner')).toHaveTextContent('Andrew Fong needs');
  });
});
