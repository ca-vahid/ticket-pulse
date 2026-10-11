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
  now: '2026-10-11T05:00:00.000Z', // Sat 10 Oct 10:00 p.m. Pacific — the page reads the server's clock
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
  window.localStorage.clear();
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

// ---------------------------------------------------------------------------
// The richer page (10 Oct 2026): faces, the countdown, who is next, your own
// turn, the strip, the calendar, the rotation and the calendar file.

const day = (date, technicianId, extra = {}) => ({ date, technicianId, morningTechnicianId: technicianId, cover: false, weekIndex: 0, holiday: null, away: false, needsCover: false, ...extra });
const RICH = {
  ...SCHEDULE,
  order: [3, 12, 5],
  people: {
    3: { id: 3, name: 'Andrew Fong', email: 'afong@example.com', photoUrl: 'data:image/png;base64,AAAA', location: 'Vancouver' },
    7: { id: 7, name: 'Maria Lee', email: 'mlee@example.com', photoUrl: null, location: 'Toronto' },
    12: { id: 12, name: 'Dana Agent', email: 'dana@example.com', photoUrl: null, location: null },
    5: { id: 5, name: 'David Zapata', email: 'dzapata@example.com', photoUrl: null, location: null },
  },
  weeks: [
    {
      ...SCHEDULE.weeks[0],
      segments: [
        { technicianId: 3, startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-09T00:00:00.000Z', cover: false },
        { technicianId: 7, startsAt: '2026-10-09T00:00:00.000Z', endsAt: '2026-10-13T00:00:00.000Z', cover: true },
      ],
    },
    { ...SCHEDULE.weeks[1], segments: [{ technicianId: 12, startsAt: '2026-10-13T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z', cover: false }] },
    { ...SCHEDULE.weeks[2], segments: [{ technicianId: 5, startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-27T00:00:00.000Z', cover: false }] },
  ],
  days: [
    day('2026-10-09', 7, { morningTechnicianId: 3, cover: true }),
    day('2026-10-10', 7, { cover: true }),
    day('2026-10-11', 7, { cover: true }),
    day('2026-10-12', 12, { morningTechnicianId: 7, weekIndex: 1, holiday: 'Thanksgiving' }),
    day('2026-10-13', 12, { weekIndex: 1 }),
    day('2026-10-14', 12, { weekIndex: 1 }),
    day('2026-10-15', 12, { weekIndex: 1 }),
    day('2026-10-16', 12, { weekIndex: 1 }),
    day('2026-10-21', 5, { weekIndex: 2, away: true, needsCover: true }),
  ],
  holidays: [{ date: '2026-10-12', name: 'Thanksgiving' }],
  previous: { technicianId: 5, scheduledTechnicianId: 5, startsAt: '2026-09-29T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
  next: { technicianId: 12, startsAt: '2026-10-13T00:00:00.000Z' },
  me: { technicianId: 12, inRotation: true, canManage: true },
};

describe('On-call page, the richer view', () => {
  beforeEach(() => {
    api.getOnCall.mockImplementation(() => ok(RICH));
    api.myCoverRequests.mockImplementation(() => ok([]));
  });

  test('a skeleton holds the place while the schedule loads', async () => {
    let release;
    api.getOnCall.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ success: true, data: RICH }); }));
    renderPage();
    expect(screen.getByTestId('on-call-loading')).toHaveAttribute('aria-label', 'Loading on-call…');
    release();
    expect(await screen.findByTestId('on-call-now')).toBeInTheDocument();
    expect(screen.queryByTestId('on-call-loading')).not.toBeInTheDocument();
  });

  test('now: the face, how long is left by the server clock, how far through, and ways to reach them', async () => {
    renderPage();
    const now = await screen.findByTestId('on-call-now');
    expect(screen.getByText('Has the phone')).toBeInTheDocument();
    expect(within(now).getByText('Maria Lee')).toBeInTheDocument();
    expect(within(now).getByText('until Mon 12 Oct 5:00 p.m.')).toBeInTheDocument();
    // 10:00 p.m. Saturday to 5:00 p.m. Monday.
    expect(screen.getByTestId('on-call-left')).toHaveTextContent('(1 day 19 hours left)');
    expect(within(now).getByText('Covering for Andrew Fong')).toBeInTheDocument();
    expect(within(now).getByText('Toronto')).toBeInTheDocument();
    expect(within(now).getByRole('link', { name: 'Chat with Maria Lee in Teams' })).toHaveAttribute('href', 'https://teams.microsoft.com/l/chat/0/0?users=mlee%40example.com');
    expect(within(now).getByRole('link', { name: 'E-mail Maria Lee' })).toHaveAttribute('href', 'mailto:mlee@example.com');
    const track = screen.getByTestId('on-call-shift-track');
    // Thu 8 Oct 5:00 p.m. to Mon 12 Oct 5:00 p.m. is 96 hours; 53 of them have passed.
    expect(within(track).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '55');
    expect(within(track).getByText('Since Thu 8 Oct 5:00 p.m.')).toBeInTheDocument();
  });

  test('a photo from the API is the face; nobody else gets a broken image', async () => {
    renderPage();
    const rotation = await screen.findByTestId('on-call-rotation');
    const andrew = within(rotation).getByTestId('on-call-rotation-3');
    expect(andrew.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(within(rotation).getByTestId('on-call-rotation-5').querySelector('img')).toBeNull();
    expect(within(rotation).getByTestId('on-call-rotation-5')).toHaveTextContent('DZ');
  });

  test('next and my own turn, said to me as "you"', async () => {
    renderPage();
    const next = await screen.findByTestId('on-call-next');
    expect(within(next).getByText('Dana Agent')).toBeInTheDocument();
    expect(within(next).getByText('You take over Mon 12 Oct 5:00 p.m.')).toBeInTheDocument();
    expect(screen.getByTestId('on-call-next-in')).toHaveTextContent('in 2 days');
    const mine = screen.getByTestId('on-call-mine');
    expect(within(mine).getByText('Mon 12 Oct to Mon 19 Oct')).toBeInTheDocument();
    expect(within(mine).getByText('Your next turn, in 2 days')).toBeInTheDocument();
  });

  test('my turn when I hold the phone, when I am outside the rotation, and when I am not a technician', async () => {
    api.getOnCall.mockImplementation(() => ok({ ...RICH, me: { technicianId: 7, inRotation: false } }));
    const { unmount } = renderPage();
    let mine = await screen.findByTestId('on-call-mine');
    expect(within(mine).getByText('You have the phone now')).toBeInTheDocument();
    expect(within(mine).getByText('until Mon 12 Oct 5:00 p.m.')).toBeInTheDocument();
    // I am the one on call: no buttons to reach myself, and the page says so.
    expect(within(screen.getByTestId('on-call-now')).getByText('That is you')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Chat with/ })).not.toBeInTheDocument();
    unmount();

    api.getOnCall.mockImplementation(() => ok({ ...RICH, me: { technicianId: 99, inRotation: false } }));
    const second = renderPage();
    mine = await screen.findByTestId('on-call-mine');
    expect(within(mine).getByText('You are not in the rotation')).toBeInTheDocument();
    expect(within(mine).queryByRole('button')).not.toBeInTheDocument();
    second.unmount();

    api.getOnCall.mockImplementation(() => ok({ ...RICH, me: { technicianId: null } }));
    renderPage();
    mine = await screen.findByTestId('on-call-mine');
    expect(within(mine).getByText('You are not a technician of this workspace.')).toBeInTheDocument();
  });

  test('the next seven nights start tonight and mark the holiday', async () => {
    renderPage();
    const nights = await screen.findByTestId('on-call-nights');
    const items = within(nights).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveTextContent('Tonight');
    expect(items[0]).toHaveTextContent('Maria');
    expect(items[2]).toHaveTextContent('Mon');
    expect(items[2]).toHaveTextContent('You');
    expect(items[2]).toHaveTextContent('Thanksgiving');
  });

  test('nobody on call: an amber word, and why', async () => {
    api.getOnCall.mockImplementation(() => ok({ ...RICH, current: { technician: null, scheduled: { id: 3, name: 'Andrew Fong' }, cover: null, until: null, onLeaveNoCover: true }, next: null }));
    renderPage();
    expect(await screen.findByText('Nobody has the phone')).toBeInTheDocument();
    expect(screen.getByText(/Andrew Fong is away and has no cover yet\./)).toBeInTheDocument();
    expect(screen.queryByText('Has the phone')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('on-call-next')).getByText('No change of hands in the weeks shown.')).toBeInTheDocument();
  });

  test('the strip: a button per week that says it in words, a line for now, and a pick that finds the week in the list', async () => {
    renderPage();
    const ribbon = await screen.findByTestId('on-call-ribbon');
    const first = within(ribbon).getByTestId('on-call-ribbon-week-0');
    expect(first).toHaveAccessibleName(/Mon 5 Oct to Mon 12 Oct: Andrew Fong, Maria Lee covers Thu 8 Oct 5:00 p\.m\. to Mon 12 Oct 5:00 p\.m\./);
    expect(within(ribbon).getByTestId('on-call-ribbon-week-1')).toHaveAccessibleName(/Dana Agent, your week/);
    expect(within(ribbon).getByTestId('on-call-ribbon-week-2')).toHaveAccessibleName(/David Zapata, needs cover/);
    expect(within(ribbon).getAllByTestId('on-call-ribbon-now')).toHaveLength(1);

    fireEvent.click(within(ribbon).getByTestId('on-call-ribbon-week-2'));
    const row = screen.getByTestId('on-call-week-2');
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(within(ribbon).getByTestId('on-call-ribbon-week-2')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1));
    expect(Element.prototype.scrollIntoView.mock.instances[0]).toBe(row);
  });

  test('the list: this week in words, holidays on both sides of a handover day, and the days somebody is away', async () => {
    renderPage();
    const first = await screen.findByTestId('on-call-week-0');
    expect(within(first).getByText('This week')).toBeInTheDocument();
    expect(within(first).getByText('Thanksgiving, Mon 12 Oct')).toBeInTheDocument();
    const second = screen.getByTestId('on-call-week-1');
    expect(within(second).getByText('Next week')).toBeInTheDocument();
    expect(within(second).getByText('Thanksgiving, Mon 12 Oct')).toBeInTheDocument();
    const third = screen.getByTestId('on-call-week-2');
    expect(within(third).getByText('In 2 weeks')).toBeInTheDocument();
    expect(within(third).getByText('Away Wed 21 Oct')).toBeInTheDocument();
    expect(within(third).queryByText(/Thanksgiving/)).not.toBeInTheDocument();
  });

  test('the calendar: remembered, a day says who has the phone, today is marked', async () => {
    renderPage();
    await screen.findByTestId('on-call-now');
    expect(screen.queryByTestId('on-call-calendar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Calendar' }));
    const calendar = screen.getByTestId('on-call-calendar');
    expect(window.localStorage.getItem('tp_on_call_view')).toBe('calendar');
    expect(screen.queryByTestId('on-call-week-0')).not.toBeInTheDocument();
    expect(within(calendar).getByRole('group', { name: 'October 2026' })).toBeInTheDocument();
    expect(within(calendar).getByTestId('on-call-day-2026-10-10')).toHaveAttribute('data-today', 'true');
    // Before a day is picked the line is about today.
    expect(screen.getByTestId('on-call-day-detail')).toHaveTextContent('Sat 10 Oct: Maria Lee has the phone tonight, as cover.');

    const holiday = within(calendar).getByRole('button', { name: 'Mon 12 Oct, Dana Agent, Thanksgiving' });
    fireEvent.click(holiday);
    expect(holiday).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('on-call-day-detail')).toHaveTextContent('Mon 12 Oct: You have the phone that night. Maria Lee has it until the change of hands (5:00 p.m. on a handover day). Thanksgiving.');

    fireEvent.click(within(calendar).getByTestId('on-call-day-2026-10-21'));
    expect(screen.getByTestId('on-call-day-detail')).toHaveTextContent('The scheduled person is away and nobody covers yet.');
    // The legend names every colour, in words.
    const legend = within(calendar).getByRole('list', { name: 'Who each colour is' });
    for (const word of ['Maria', 'Dana', 'David', 'Holiday', 'Needs cover']) expect(within(legend).getByText(word)).toBeInTheDocument();

    // Picking a week on the strip goes back to the list, on that week.
    fireEvent.click(screen.getByTestId('on-call-ribbon-week-1'));
    expect(screen.getByTestId('on-call-week-1')).toHaveAttribute('data-selected', 'true');
    expect(window.localStorage.getItem('tp_on_call_view')).toBe('weeks');
  });

  test('the calendar choice comes back on the next visit', async () => {
    window.localStorage.setItem('tp_on_call_view', 'calendar');
    renderPage();
    expect(await screen.findByTestId('on-call-calendar')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Calendar' })).toHaveAttribute('aria-checked', 'true');
  });

  test('an older API without days keeps the list even when the calendar was chosen', async () => {
    window.localStorage.setItem('tp_on_call_view', 'calendar');
    api.getOnCall.mockImplementation(() => ok(SCHEDULE));
    renderPage();
    expect(await screen.findByTestId('on-call-week-0')).toBeInTheDocument();
    expect(screen.queryByTestId('on-call-calendar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('on-call-nights')).not.toBeInTheDocument();
  });

  test('the rotation: the order, who has this week, and when each next week starts', async () => {
    renderPage();
    const rotation = await screen.findByTestId('on-call-rotation');
    const items = within(rotation).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual(['on-call-rotation-3', 'on-call-rotation-12', 'on-call-rotation-5']);
    expect(items[0]).toHaveTextContent('Andrew Fong');
    expect(items[0]).toHaveTextContent('This week');
    expect(items[1]).toHaveTextContent('12 Oct');
    expect(items[2]).toHaveTextContent('19 Oct');
    expect(screen.getByText('3 people, one week each, in this order.')).toBeInTheDocument();
  });

  test('my turns as a calendar file, and the whole schedule', async () => {
    const blobs = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob) => { blobs.push(blob); return 'blob:on-call'; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Add my turns to my calendar' }));
      expect(click).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('on-call-file-note')).toHaveTextContent('Downloaded 1 entry.');
      expect(await blobs[0].text()).toContain('DTSTART:20261013T000000Z');

      fireEvent.click(screen.getByRole('button', { name: 'Calendar file' }));
      expect(screen.getByTestId('on-call-file-note')).toHaveTextContent('Downloaded 4 entries.');
      expect(await blobs[1].text()).toContain('SUMMARY:On call: Maria Lee (cover)');
    } finally {
      click.mockRestore();
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });

  test('only somebody who can change the rotation sees the way to Settings', async () => {
    const { unmount } = renderPage();
    expect(await screen.findByRole('link', { name: 'Change the rotation' })).toHaveAttribute('href', '/settings#urgent-response');
    unmount();
    api.getOnCall.mockImplementation(() => ok({ ...RICH, me: { technicianId: 12, inRotation: true, canManage: false } }));
    renderPage();
    await screen.findByTestId('on-call-now');
    expect(screen.queryByRole('link', { name: 'Change the rotation' })).not.toBeInTheDocument();
  });

  test('no rotation yet: an admin is offered the way to set one up', async () => {
    api.getOnCall.mockImplementation(() => ok({ timezone: TZ, handoverDay: 1, handoverTime: '17:00', current: null, weeks: [], order: [], me: { technicianId: null, canManage: true } }));
    renderPage();
    expect(await screen.findByText('No on-call rotation yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the rotation' })).toHaveAttribute('href', '/settings#urgent-response');
  });

  test('a tab that comes back after a while reads the schedule again', async () => {
    renderPage();
    await screen.findByTestId('on-call-now');
    expect(api.getOnCall).toHaveBeenCalledTimes(1);
    // Straight away: still fresh, nothing is read.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.getOnCall).toHaveBeenCalledTimes(1);
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(api.getOnCall).toHaveBeenCalledTimes(2));
    } finally {
      Date.now = realNow;
    }
  });
});
