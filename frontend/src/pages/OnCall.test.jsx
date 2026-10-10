/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// On-call page (plans/URGENT_RESPONSE_PLAN.md): the read-only schedule every
// member can open, and the cover requests waiting for the signed-in person.

const api = vi.hoisted(() => ({
  getOnCall: vi.fn(),
  myCoverRequests: vi.fn(),
  respondCoverRequest: vi.fn(),
}));
vi.mock('../services/api', () => ({ urgentResponseAPI: api }));
vi.mock('../components/AppHeader', () => ({ default: () => null }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));

const { default: OnCall } = await import('./OnCall');

const TZ = 'America/Vancouver';
const SCHEDULE = {
  timezone: TZ,
  handoverDay: 1,
  handoverTime: '17:00',
  current: {
    technician: { id: 7, name: 'Maria Lee' },
    scheduled: { id: 3, name: 'Andrew Fong' },
    cover: { id: 90 },
    until: '2026-10-13T00:00:00.000Z', // Mon 12 Oct 5:00 p.m. Pacific
  },
  weeks: [
    {
      index: 0,
      startsAt: '2026-10-06T00:00:00.000Z',
      endsAt: '2026-10-13T00:00:00.000Z',
      scheduled: { id: 3, name: 'Andrew Fong' },
      covers: [{ id: 90, technician: { id: 7, name: 'Maria Lee' }, startsAt: '2026-10-09T00:00:00.000Z', endsAt: '2026-10-13T00:00:00.000Z', note: 'Dentist', source: 'admin' }],
      leaveDays: [],
      needsCover: false,
      openRequest: null,
    },
    {
      index: 1,
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2026-10-20T00:00:00.000Z',
      scheduled: { id: 12, name: 'Dana Agent' },
      covers: [],
      leaveDays: [],
      needsCover: false,
      openRequest: null,
    },
    {
      index: 2,
      startsAt: '2026-10-20T00:00:00.000Z',
      endsAt: '2026-10-27T00:00:00.000Z',
      scheduled: { id: 5, name: 'David Zapata' },
      covers: [],
      leaveDays: ['2026-10-21'],
      needsCover: true,
      openRequest: { id: 41, status: 'open', askedCount: 4, declinedCount: 1 },
    },
  ],
  me: { technicianId: 12 },
};
const REQUEST = {
  id: 41,
  original: { id: 3, name: 'Andrew Fong' },
  startsAt: '2026-10-16T00:00:00.000Z', // Thu 15 Oct 5:00 p.m. Pacific
  endsAt: '2026-10-20T00:00:00.000Z', // Mon 19 Oct 5:00 p.m. Pacific
  message: 'Family trip, back Tuesday.',
  createdBy: 'Vahid Haeri',
};
const OTHER = { ...REQUEST, id: 42, original: { id: 5, name: 'David Zapata' }, message: null };

const ok = (data) => Promise.resolve({ success: true, data });

function renderPage(path = '/on-call') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OnCall />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getOnCall.mockImplementation(() => ok(SCHEDULE));
  api.myCoverRequests.mockImplementation(() => ok([REQUEST]));
  api.respondCoverRequest.mockImplementation(() => ok({ status: 'filled', cover: { id: 91 } }));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('On-call page', () => {
  test('explains the handover, who is on call now and for whom they cover', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'On-call' })).toBeInTheDocument();
    expect(await screen.findByText(/Handover is Monday at 5:00 p\.m\./)).toBeInTheDocument();
    const now = await screen.findByTestId('on-call-now');
    expect(within(now).getByText('Maria Lee')).toBeInTheDocument();
    expect(within(now).getByText('until Mon 12 Oct 5:00 p.m.')).toBeInTheDocument();
    expect(within(now).getByText('Covering for Andrew Fong')).toBeInTheDocument();
  });

  test('the schedule: dates, cover lines, my own week in plain words, and needs cover', async () => {
    renderPage();
    const first = await screen.findByTestId('on-call-week-0');
    expect(within(first).getByText('Mon 5 Oct to Mon 12 Oct')).toBeInTheDocument();
    expect(within(first).getByText('Andrew Fong')).toBeInTheDocument();
    expect(within(first).getByText(/Maria Lee covers Thu 8 Oct 5:00 p\.m\. to Mon 12 Oct 5:00 p\.m\. · Dentist/)).toBeInTheDocument();
    expect(within(first).queryByText('Your week')).not.toBeInTheDocument();

    const mine = screen.getByTestId('on-call-week-1');
    expect(within(mine).getByText('Your week')).toBeInTheDocument();
    expect(within(mine).queryByText('Needs cover')).not.toBeInTheDocument();

    const gap = screen.getByTestId('on-call-week-2');
    expect(within(gap).getByText('Needs cover')).toBeInTheDocument();
    expect(within(gap).getByText('Asked 4 people · 1 declined')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Next 3 weeks' })).toBeInTheDocument();
  });

  test('Take it asks first, saying exactly what is agreed to, then accepts', async () => {
    renderPage();
    const row = await screen.findByTestId('cover-request-41');
    expect(within(row).getByText('Andrew Fong')).toBeInTheDocument();
    expect(within(row).getByText('Thu 15 Oct 5:00 p.m. to Mon 19 Oct 5:00 p.m.')).toBeInTheDocument();
    expect(within(row).getByText('Family trip, back Tuesday.')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: /Take it/ }));
    expect(api.respondCoverRequest).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('You will be on call from Thu 15 Oct 5:00 p.m. to Mon 19 Oct 5:00 p.m.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(api.respondCoverRequest).toHaveBeenCalledWith(41, 'accept'));
    expect(await screen.findByTestId('cover-note')).toHaveTextContent('Thank you. You will be on call from Thu 15 Oct 5:00 p.m. to Mon 19 Oct 5:00 p.m.');
    expect(screen.queryByTestId('cover-request-41')).not.toBeInTheDocument();
    // The schedule is read again so the new cover shows.
    await waitFor(() => expect(api.getOnCall).toHaveBeenCalledTimes(2));
  });

  test('cancelling the confirm sends nothing', async () => {
    renderPage();
    const row = await screen.findByTestId('cover-request-41');
    fireEvent.click(within(row).getByRole('button', { name: /Take it/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.respondCoverRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('cover-request-41')).toBeInTheDocument();
  });

  test('Not this time declines without a confirm', async () => {
    api.respondCoverRequest.mockImplementation(() => ok({ status: 'open', cover: null }));
    renderPage();
    const row = await screen.findByTestId('cover-request-41');
    fireEvent.click(within(row).getByRole('button', { name: /Not this time/ }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.respondCoverRequest).toHaveBeenCalledWith(41, 'decline'));
    expect(await screen.findByTestId('cover-note')).toHaveTextContent('Noted.');
    expect(screen.queryByTestId('cover-request-41')).not.toBeInTheDocument();
  });

  test('409: someone else already took it', async () => {
    api.respondCoverRequest.mockImplementation(() => Promise.reject(Object.assign(new Error('Already filled'), { status: 409 })));
    renderPage();
    const row = await screen.findByTestId('cover-request-41');
    fireEvent.click(within(row).getByRole('button', { name: /Take it/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Take it' }));
    expect(await screen.findByTestId('cover-note')).toHaveTextContent('Someone else already took it.');
    expect(screen.queryByTestId('cover-request-41')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('another failure keeps the request and says why', async () => {
    api.respondCoverRequest.mockImplementation(() => Promise.reject(Object.assign(new Error('Server is busy'), { status: 503 })));
    renderPage();
    const row = await screen.findByTestId('cover-request-41');
    fireEvent.click(within(row).getByRole('button', { name: /Not this time/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server is busy');
    expect(screen.getByTestId('cover-request-41')).toBeInTheDocument();
  });

  test('?request=<id> scrolls to that request and marks it', async () => {
    api.myCoverRequests.mockImplementation(() => ok([OTHER, REQUEST]));
    renderPage('/on-call?request=41');
    const wanted = await screen.findByTestId('cover-request-41');
    expect(wanted).toHaveAttribute('data-highlighted', 'true');
    expect(screen.getByTestId('cover-request-42')).not.toHaveAttribute('data-highlighted');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1));
    expect(Element.prototype.scrollIntoView.mock.instances[0]).toBe(wanted);
  });

  test('?request=<id> for a request that is gone says so', async () => {
    api.myCoverRequests.mockImplementation(() => ok([]));
    renderPage('/on-call?request=41');
    expect(await screen.findByTestId('cover-request-gone')).toHaveTextContent('no longer open');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test('no requests: the section is not shown', async () => {
    api.myCoverRequests.mockImplementation(() => ok([]));
    renderPage();
    await screen.findByTestId('on-call-now');
    expect(screen.queryByRole('heading', { name: 'Cover requests for you' })).not.toBeInTheDocument();
  });

  test('empty state when no rotation is set up', async () => {
    api.getOnCall.mockImplementation(() => ok({ timezone: TZ, handoverDay: 1, handoverTime: '17:00', current: null, weeks: [], me: { technicianId: 12 } }));
    api.myCoverRequests.mockImplementation(() => ok([]));
    renderPage();
    expect(await screen.findByText('No on-call rotation yet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'On call now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Next \d+ weeks/ })).not.toBeInTheDocument();
  });

  test('a failed load offers another try', async () => {
    api.getOnCall.mockImplementationOnce(() => Promise.reject(new Error('Network error. Please check your connection.')));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('on-call-now')).toBeInTheDocument();
  });
});
