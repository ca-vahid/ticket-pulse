/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineRunDetail from './PipelineRunDetail';
import { assignmentAPI, dashboardAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getFreshServiceDomain: vi.fn(),
    getRunFreshness: vi.fn(),
    getCompetencyTechnicians: vi.fn(),
    rerunPipeline: vi.fn(),
    reopenAndRoute: vi.fn(),
    getLatestRunForTicket: vi.fn(),
  },
  dashboardAPI: {
    getTicketHistory: vi.fn(),
  },
}));

// Reopen & route (27 Sep 2026): a ticket the AI closed as noise that needed a
// person. The noise digest e-mail links here with ?reopen=1.
function makeRun(overrides = {}, ticketOverrides = {}) {
  return {
    id: 24410,
    ticketId: 50,
    status: 'completed',
    decision: 'noise_dismissed',
    triggerSource: 'webhook',
    createdAt: '2026-09-26T16:00:00.000Z',
    ticket: {
      id: 50,
      freshserviceTicketId: 242259,
      subject: 'FW: Stay connected with Sage',
      status: 'Closed',
      isNoise: true,
      priority: 1,
      createdAt: '2026-09-26T15:30:00.000Z',
      requester: { name: 'Casey Brown', department: 'Accounting' },
      ...ticketOverrides,
    },
    recommendation: { overallReasoning: 'Vendor newsletter.', recommendations: [] },
    steps: [],
    ...overrides,
  };
}

const renderAt = (run, { url = '/assignments/run/24410', isAdmin = true, onDecide = vi.fn() } = {}) => render(
  <MemoryRouter initialEntries={[url]}>
    <PipelineRunDetail run={run} isAdmin={isAdmin} onDecide={onDecide} workspaceTimezone="America/Vancouver" />
  </MemoryRouter>,
);

describe('PipelineRunDetail - Reopen & route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
    assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
    assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
    dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
    assignmentAPI.reopenAndRoute.mockResolvedValue({ success: true, data: { ticketId: 50, reopened: true, routing: true } });
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: { id: 24411 } });
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => cleanup());

  test('a ticket still closed as noise offers Reopen & route, which calls the API', async () => {
    renderAt(makeRun());
    expect(screen.getByText('This ticket was closed as noise.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reopen & route/ }));
    await waitFor(() => expect(assignmentAPI.reopenAndRoute).toHaveBeenCalledWith(24410));
    await waitFor(() => expect(assignmentAPI.getLatestRunForTicket).toHaveBeenCalledWith(50));
  });

  test('arriving from the digest (?reopen=1) scrolls to the banner', () => {
    renderAt(makeRun(), { url: '/assignments/run/24410?reopen=1' });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  test('no banner once the ticket is no longer flagged noise, or for other decisions', () => {
    renderAt(makeRun({}, { isNoise: false }));
    expect(screen.queryByText('This ticket was closed as noise.')).not.toBeInTheDocument();
    cleanup();
    renderAt(makeRun({ decision: 'auto_assigned' }));
    expect(screen.queryByRole('button', { name: /Reopen & route/ })).not.toBeInTheDocument();
  });

  test('a refusal from the server is shown, not swallowed', async () => {
    assignmentAPI.reopenAndRoute.mockRejectedValueOnce({ response: { data: { message: 'Reviewer access required' } } });
    renderAt(makeRun());
    fireEvent.click(screen.getByRole('button', { name: /Reopen & route/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reviewer access required');
  });
});
