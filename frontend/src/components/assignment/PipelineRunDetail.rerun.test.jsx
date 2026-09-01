/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineRunDetail from './PipelineRunDetail';
import { assignmentAPI, dashboardAPI } from '../../services/api';

// PipelineRunDetail links to the in-app ticket page, so it needs router context.
const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getFreshServiceDomain: vi.fn(),
    getRunFreshness: vi.fn(),
    getCompetencyTechnicians: vi.fn(),
    rerunPipeline: vi.fn(),
    getLatestRunForTicket: vi.fn(),
  },
  dashboardAPI: {
    getTicketHistory: vi.fn(),
  },
}));

// NT-7/NT-8 fixture: a terminal noise_dismissed run — the exact shape that
// used to offer NO re-run affordance and burned QA.
function makeRun(overrides = {}) {
  return {
    id: 22386,
    ticketId: 42501,
    status: 'completed',
    decision: 'noise_dismissed',
    triggerSource: 'webhook',
    createdAt: '2026-08-20T16:00:00.000Z',
    promptVersionNumber: 33,
    currentPublishedPromptVersion: 34,
    ticket: {
      id: 42501,
      freshserviceTicketId: 239931,
      subject: 'Package arrived at shipping room',
      status: 'Closed',
      priority: 1,
      createdAt: '2026-08-20T15:30:00.000Z',
      requester: { name: 'Casey Brown', department: 'Operations' },
    },
    recommendation: { overallReasoning: 'Automated notification — no action needed.', recommendations: [] },
    steps: [],
    ...overrides,
  };
}

describe('PipelineRunDetail re-run on terminal runs (NT-7)', () => {
  let confirmSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
    assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
    assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
    assignmentAPI.rerunPipeline.mockResolvedValue({ success: true, data: { ticketId: 42501, supersededRunId: null } });
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: { id: 99999, status: 'running' } });
    dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    cleanup();
  });

  test('shows the Re-run button on a noise_dismissed run and fires the API after confirm', async () => {
    renderWithRouter(<PipelineRunDetail run={makeRun()} isAdmin workspaceTimezone="America/Vancouver" />);

    const rerunButton = await screen.findByRole('button', { name: 'Re-run' });
    fireEvent.click(rerunButton);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('CURRENT published prompt (v34)');
    expect(confirmSpy.mock.calls[0][0]).toContain('The existing run is kept for history.');

    await waitFor(() => expect(assignmentAPI.rerunPipeline).toHaveBeenCalledWith(22386));
    // Points the user at the new run once it exists.
    await waitFor(() => expect(assignmentAPI.getLatestRunForTicket).toHaveBeenCalledWith(42501));
  });

  test('declining the confirm dialog does not trigger a re-run', async () => {
    confirmSpy.mockReturnValue(false);
    renderWithRouter(<PipelineRunDetail run={makeRun()} isAdmin workspaceTimezone="America/Vancouver" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(assignmentAPI.rerunPipeline).not.toHaveBeenCalled();
  });

  test('hides the Re-run button for non-admins and for in-flight runs', async () => {
    const { unmount } = renderWithRouter(
      <PipelineRunDetail run={makeRun()} isAdmin={false} workspaceTimezone="America/Vancouver" />,
    );
    await screen.findByText('Noise Dismissed');
    expect(screen.queryByRole('button', { name: 'Re-run' })).not.toBeInTheDocument();
    unmount();

    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({ status: 'running', decision: null })}
        isAdmin
        workspaceTimezone="America/Vancouver"
      />,
    );
    await screen.findByText('Package arrived at shipping room');
    expect(screen.queryByRole('button', { name: 'Re-run' })).not.toBeInTheDocument();
  });

  test('renders a noise_veto trace step gracefully', async () => {
    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({
          decision: 'pending_review',
          steps: [{
            id: 7,
            stepNumber: 1,
            stepName: 'noise_veto',
            status: 'completed',
            output: { message: 'Noise veto: rule Shipping-room guard — forced out of noise_dismissed' },
          }],
        })}
        isAdmin={false}
        workspaceTimezone="America/Vancouver"
      />,
    );

    expect(await screen.findByText('noise veto')).toBeInTheDocument();
  });
});

describe('PipelineRunDetail stale-prompt banner (NT-8)', () => {
  let confirmSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
    assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
    assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
    assignmentAPI.rerunPipeline.mockResolvedValue({ success: true });
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: { id: 99999 } });
    dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    cleanup();
  });

  test('renders the banner when the run prompt version is behind the published one', async () => {
    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({ promptVersionNumber: 33, currentPublishedPromptVersion: 34 })}
        isAdmin
        workspaceTimezone="America/Vancouver"
      />,
    );

    expect(
      await screen.findByText('This run used prompt v33; v34 is now published — results may differ.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run with current prompt' })).toBeInTheDocument();
    expect(screen.getByText('prompt v33')).toBeInTheDocument();
  });

  test('the banner CTA fires the re-run API after confirm', async () => {
    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({ promptVersionNumber: 33, currentPublishedPromptVersion: 34 })}
        isAdmin
        workspaceTimezone="America/Vancouver"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run with current prompt' }));
    await waitFor(() => expect(assignmentAPI.rerunPipeline).toHaveBeenCalledWith(22386));
  });

  test('does not render the banner when the versions match', async () => {
    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({ promptVersionNumber: 34, currentPublishedPromptVersion: 34 })}
        isAdmin
        workspaceTimezone="America/Vancouver"
      />,
    );

    await screen.findByText('Noise Dismissed');
    expect(screen.queryByText(/is now published — results may differ/)).not.toBeInTheDocument();
    // The prompt-version chip still shows, in its neutral (non-stale) style.
    expect(screen.getByText('prompt v34')).toBeInTheDocument();
  });

  test('does not render the banner when prompt metadata is missing', async () => {
    renderWithRouter(
      <PipelineRunDetail
        run={makeRun({ promptVersionNumber: null, currentPublishedPromptVersion: null })}
        isAdmin
        workspaceTimezone="America/Vancouver"
      />,
    );

    await screen.findByText('Noise Dismissed');
    expect(screen.queryByText(/is now published — results may differ/)).not.toBeInTheDocument();
  });
});
