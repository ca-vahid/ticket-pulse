/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicTicketEscalation from './PublicTicketEscalation';
import { publicTicketEscalationAPI } from '../services/api';

vi.mock('../services/api', () => ({
  publicTicketEscalationAPI: {
    get: vi.fn(),
    submit: vi.fn(),
  },
}));

const responseTable = {
  columns: ['Business Hours', 'After-hours', 'Late Night'],
  rows: [
    { label: 'Monday to Friday', businessHours: '5am - 5pm PT', afterHours: '5pm - 10pm PT', lateNight: 'After 10pm PT' },
    { label: 'Weekends', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
    { label: 'Holidays', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
  ],
};

const payload = (overrides = {}) => ({
  status: 'available',
  available: true,
  reasons: [],
  alreadyUrgent: false,
  alreadyEscalated: false,
  afterHours: {
    active: true,
    availability: { isBusinessHours: false, isAfterHours: true, isHoliday: false, nextBusinessTimeLocal: 'Tue, Nov 17, 5:00 AM PT' },
    responseTable,
    phase: 'after_hours',
    localHour: 21,
    nextBusinessShort: '5 AM',
    expect: {
      businessHours: 'We answer tickets as they come in.',
      afterHours: 'For high-priority issues. We reply within about 2 hours.',
      lateNight: "We'll still try, but it can take longer than 2 hours.",
    },
    ...(overrides.afterHours || {}),
  },
  escalation: { sentAt: null, sentAtLocal: null },
  ticket: {
    id: 66260,
    ref: 'TP-12591',
    freshserviceTicketId: '252303',
    subject: "Laptop won't connect to VPN",
    status: 'Open',
    priority: 'Medium',
    publicStatusUrl: 'https://tickets.example.com/ticket-status/tok',
    raiseUrgencyUrl: 'https://tickets.example.com/ticket-urgency/tok',
  },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  branding: { brandName: 'IT Helpdesk', logoDataUrl: 'data:image/png;base64,AAAA', logoAltText: 'Example Co' },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'afterHours')),
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/ticket-escalation/tok-1']}>
      <Routes>
        <Route path="/ticket-escalation/:token" element={<PublicTicketEscalation />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicTicketEscalation (QA 11-16 redesign)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  test('available: greeting, out-of-office headline, own reference and the two choices', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload() });
    const { container } = renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: "We're out of the office until 5 AM" })).toBeInTheDocument();
    expect(screen.getByText('Good evening')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Is this high priority?' })).toBeInTheDocument();
    expect(screen.getByText("TP-12591 · Laptop won't connect to VPN · in our queue")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/252303/);
    expect(screen.getByRole('button', { name: 'Contact after-hours support' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'It can wait until morning' })).toBeEnabled();
    expect(screen.getByAltText('Example Co')).toBeInTheDocument();
    expect(container.querySelector('.tp-light')).not.toBeNull();
  });

  test('hours table: rows from the policy, weekends and holidays merged, the current row marked', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload() });
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Weekends and holidays' })).toBeInTheDocument();
    const officeRow = within(table).getByRole('rowheader', { name: 'In the office' }).closest('tr');
    expect(within(officeRow).getByText('5 AM – 5 PM')).toBeInTheDocument();
    expect(within(officeRow).getByText('Closed')).toBeInTheDocument();
    const lateRow = within(table).getByRole('rowheader', { name: 'Late night' }).closest('tr');
    expect(within(lateRow).getByText('10 PM – 5 AM')).toBeInTheDocument();
    expect(within(lateRow).getByText('5 PM – 10 AM')).toBeInTheDocument();
    const nowRow = within(table).getByText('Right now').closest('tr');
    expect(nowRow).toHaveAttribute('aria-current', 'true');
    expect(within(nowRow).getByText('After-hours support')).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/\bPT\b|PDT|PST/);
  });

  test('late night: the current row moves and the copy does not promise 2 hours', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload({ afterHours: { phase: 'late_night', localHour: 23 } }) });
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Right now').closest('tr')).toHaveTextContent('Late night');
    expect(screen.getByText(/at this hour it can take longer than 2 hours/)).toBeInTheDocument();
  });

  test('"It can wait" thanks the requester without calling the API', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'It can wait until morning' }));
    expect(screen.getByRole('heading', { name: "Thanks — we'll pick it up first thing." })).toBeInTheDocument();
    expect(screen.getByText('You can close this page.')).toBeInTheDocument();
    expect(publicTicketEscalationAPI.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Contact after-hours support' }));
    expect(screen.getByRole('heading', { name: 'Is this high priority?' })).toBeInTheDocument();
  });

  test('submitted: confirms with the time sent and what happens next, naming nobody', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload() });
    publicTicketEscalationAPI.submit.mockResolvedValue({
      data: payload({
        status: 'submitted',
        available: false,
        reasons: ['cooldown_active'],
        escalation: { sentAt: '2026-11-17T05:41:00.000Z', sentAtLocal: '9:41 PM' },
        notificationSummary: { queued: 2 },
      }),
    });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Contact after-hours support' }));
    await waitFor(() => expect(publicTicketEscalationAPI.submit).toHaveBeenCalledWith('tok-1'));
    expect(await screen.findByRole('heading', { name: 'After-hours support has your request' })).toBeInTheDocument();
    expect(screen.getByText(/We alerted them at 9:41 PM\. They usually reply within about 2 hours\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What happens next' })).toBeInTheDocument();
    expect(screen.getByText('9:41 PM. TP-12591 is now marked Urgent.')).toBeInTheDocument();
    expect(screen.getByText('You hear back')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contact after-hours support' })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Alex|Kim|Robin/);
  });

  test('already escalated on load shows the same confirmation', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({
      data: payload({
        status: 'unavailable',
        available: false,
        alreadyEscalated: true,
        reasons: ['cooldown_active', 'already_escalated'],
        escalation: { sentAt: '2026-11-17T05:41:00.000Z', sentAtLocal: '9:41 PM' },
      }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'After-hours support has your request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contact after-hours support' })).not.toBeInTheDocument();
  });

  test('unavailable in office hours: a calm message and no contact button', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({
      data: payload({
        status: 'unavailable',
        available: false,
        reasons: ['not_after_hours'],
        afterHours: { phase: 'business', localHour: 10, nextBusinessShort: null, availability: { isBusinessHours: true, isAfterHours: false } },
      }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: "We're in the office now" })).toBeInTheDocument();
    expect(screen.getByText('Good morning')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "We're in the office right now" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Tell us it's urgent" })).toHaveAttribute('href', 'https://tickets.example.com/ticket-urgency/tok');
    expect(screen.queryByRole('button', { name: 'Contact after-hours support' })).not.toBeInTheDocument();
  });

  test('unavailable when the workspace turned it off', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({
      data: payload({ status: 'unavailable', available: false, reasons: ['self_service_disabled'] }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: "After-hours support isn't available from this page" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contact after-hours support' })).not.toBeInTheDocument();
  });

  test('a failed submit says so and keeps the choice on screen', async () => {
    publicTicketEscalationAPI.get.mockResolvedValue({ data: payload() });
    publicTicketEscalationAPI.submit.mockRejectedValue(new Error('Network Error'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Contact after-hours support' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network Error');
    expect(screen.getByRole('button', { name: 'Contact after-hours support' })).toBeEnabled();
  });
});
