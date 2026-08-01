/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Render coverage for the agent-page rebuild (C skeleton + A drillable chips +
// B heatmap): the page must mount, resolve its period fetch, show PERIOD-SCOPED
// chip counts (the badge-integrity fix), refilter the evidence table on chip
// click, draw heatmap cells, and show the merged /5 satisfaction figure with N.

const DAY_TICKETS = [
  {
    id: 101, subject: 'Distribution list membership', status: 'Closed',
    requesterName: 'Graham Dick', isSelfPicked: true, assignedBy: 'Anton Kuzmychev',
    firstAssignedAt: '2026-07-27T15:02:00.000Z', createdAt: '2026-07-27T14:50:00.000Z',
  },
  {
    id: 102, subject: 'Entra group cleanup', status: 'Closed',
    requesterName: 'Reggie Chen', isSelfPicked: false, assignedBy: 'Coordinator',
    firstAssignedAt: '2026-07-27T16:12:00.000Z', createdAt: '2026-07-27T16:00:00.000Z',
  },
  {
    id: 103, subject: 'OnDMARC alert', status: 'Open',
    requesterName: 'Red Sift', isSelfPicked: false, assignedBy: 'Coordinator',
    firstAssignedAt: '2026-07-27T18:30:00.000Z', createdAt: '2026-07-27T18:25:00.000Z',
  },
];

const TECH_DAILY = {
  success: true,
  data: {
    id: 7, name: 'Anton Kuzmychev', email: 'anton@example.com', photoUrl: null,
    timezone: 'America/Toronto', workStartTime: '09:00', workEndTime: '17:00', isActive: true,
    totalTicketsOnDate: 3, closedTicketsOnDateCount: 2, selfPickedOnDate: 1,
    assignedOnDate: 2, appAssignedOnDate: 0,
    ticketsOnDate: DAY_TICKETS,
    closedTicketsOnDate: DAY_TICKETS.filter((t) => t.status === 'Closed'),
    selfPickedTickets: [DAY_TICKETS[0]],
    assignedTickets: [DAY_TICKETS[1], DAY_TICKETS[2]],
    openTickets: [DAY_TICKETS[2]],
    rejectedThisPeriod: 0, rejected7d: 0, rejected30d: 0, rejectedLifetime: 1,
  },
};

const CSAT = {
  data: {
    csatTickets: [
      {
        id: 601, subject: 'VPN fixed fast', csatScore: 4, csatTotalScore: 4,
        csatSubmittedAt: '2026-07-27T20:00:00.000Z', requesterName: 'Reggie Chen',
        csatFeedback: 'Fast and clear, thanks Anton',
      },
    ],
  },
};

const FEEDBACK = {
  data: {
    feedbackTickets: [
      {
        id: 602, subject: 'Laptop swap', requesterName: 'Alvin Lau',
        feedback: { score: 4, comment: 'Smooth handover', submittedAt: '2026-07-26T18:00:00.000Z' },
      },
    ],
  },
};

const CALENDAR = {
  data: {
    days: [
      { date: '2026-07-27', count: 3 },
      { date: '2026-07-26', count: 1 },
    ],
  },
};

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getTechnician: vi.fn(() => Promise.resolve(TECH_DAILY)),
    getTechnicianWeekly: vi.fn(() => Promise.resolve(TECH_DAILY)),
    getTechnicianMonthly: vi.fn(() => Promise.resolve(TECH_DAILY)),
    getTechnicianFeedback: vi.fn(() => Promise.resolve(FEEDBACK)),
    getTechnicianActivityCalendar: vi.fn(() => Promise.resolve(CALENDAR)),
    getTechnicianBounced: vi.fn(() => Promise.resolve({ data: { rejections: [] } })),
  },
  settingsAPI: {
    getTicketTypes: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

vi.mock('../contexts/DashboardContext', () => ({
  useDashboard: () => ({ getTechnicianCSAT: vi.fn(() => Promise.resolve(CSAT)) }),
}));

vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    isWorkspaceSelected: true,
  }),
}));

vi.mock('../components/ExportButton', () => ({ default: () => <div>Export</div> }));

import TechnicianDetailNew from './TechnicianDetailNew';

function renderPage(initialEntry = '/technician/7') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        {/* Real route shape so useParams().id resolves like in App.jsx */}
        <Route path="/technician/:id" element={<TechnicianDetailNew />} />
        <Route path="/tickets/:id" element={<div>Ticket detail</div>} />
        <Route path="/timeline" element={<div>Timeline</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function mounted() {
  await waitFor(() => expect(screen.getAllByText('Anton Kuzmychev').length).toBeGreaterThan(0));
}

describe('TechnicianDetailNew (agent page rebuild)', () => {
  afterEach(() => cleanup());

  test('mounts without throwing and resolves the daily fetch', async () => {
    renderPage();
    await mounted();
  });

  test('stat chips render period-scoped counts (badge-integrity fix)', async () => {
    renderPage();
    await mounted();
    // Handled 3, Closed 2, Self-picked 1 — the day's numbers, not lifetime.
    expect(screen.getByRole('button', { name: 'Handled · today: 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Closed: 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Self-picked: 1' })).toBeInTheDocument();
    // Bounced chip carries the period count (0) with lifetime as context only.
    expect(screen.getByRole('button', { name: 'Bounced: 0' })).toBeInTheDocument();
  });

  test('clicking a chip refilters the evidence table (title follows)', async () => {
    renderPage();
    await mounted();
    // Default: handled evidence.
    expect(screen.getByText(/Handled on .+ · 3 tickets/)).toBeInTheDocument();
    // Click Closed → the same table now tells the closed story.
    fireEvent.click(screen.getByRole('button', { name: 'Closed: 2' }));
    expect(screen.getByText(/Closed on .+ · 2 tickets/)).toBeInTheDocument();
    expect(screen.queryByText(/Handled on .+ · 3 tickets/)).not.toBeInTheDocument();
  });

  test('heatmap renders day cells from the activity calendar', async () => {
    renderPage();
    await mounted();
    // Auto (daily) → the surrounding week as 7 large cells.
    await waitFor(() => {
      expect(screen.getAllByTitle(/· \d+ handled/).length).toBeGreaterThanOrEqual(7);
    });
  });

  test('satisfaction shows the merged /5 average with N always visible', async () => {
    renderPage();
    await mounted();
    // FS 4/4 → 5.0, TP 4/5 → 4 ⇒ weighted merge (5 + 4) / 2 = 4.5 over 2 responses.
    await waitFor(() => {
      expect(screen.getAllByText('4.5').length).toBeGreaterThan(0);
    });
    // N appears in both the rail chip and the panel header — never hidden.
    expect(screen.getAllByText(/2 responses/).length).toBeGreaterThan(0);
    // Source chips label each response's origin.
    expect(screen.getAllByText('FreshService').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ticket Pulse').length).toBeGreaterThan(0);
  });

  test('?tab=bounced deep link (buildBouncedUrl contract) opens the bounced view', async () => {
    renderPage('/technician/7?tab=bounced&range=day&start=2026-07-27&end=2026-07-27');
    await mounted();
    await waitFor(() => {
      expect(screen.getByText(/Bounced tickets/)).toBeInTheDocument();
    });
  });
});
