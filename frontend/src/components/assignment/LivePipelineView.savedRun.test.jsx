/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LivePipelineView from './LivePipelineView';
import { assignmentAPI } from '../../services/api';
import { readSSEStream } from '../../hooks/useStreamingFetch';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getLatestRunForTicket: vi.fn(),
    getCompetencyTechnicians: vi.fn().mockResolvedValue({ data: [] }),
    decide: vi.fn(),
  },
}));

vi.mock('../../hooks/useStreamingFetch', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readSSEStream: vi.fn() };
});

const COMPLETED_RUN = {
  id: 22386,
  status: 'completed',
  createdAt: '2026-08-20T16:00:00.000Z',
  recommendation: { overallReasoning: 'Automated notification — no action needed.', recommendations: [] },
  fullTranscript: 'transcript text',
};

describe('LivePipelineView landing on a completed run (NT-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: COMPLETED_RUN });
    readSSEStream.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test('makes the saved-run state explicit instead of implying a fresh run', async () => {
    render(<LivePipelineView ticketId={42501} />);

    // No misleading "Analysis complete" — the header names it a saved run.
    expect(await screen.findByText('Viewing completed run')).toBeInTheDocument();
    expect(screen.queryByText('Analysis complete')).not.toBeInTheDocument();

    // The notice states the run date and that the pipeline did NOT run again.
    expect(screen.getByText(/This is a completed run from/)).toBeInTheDocument();
    expect(screen.getByText(/the pipeline has not run again/)).toBeInTheDocument();
  });

  test('offers an explicit "Re-run with current prompt" action that starts a fresh run', async () => {
    render(<LivePipelineView ticketId={42501} />);

    const rerunButton = await screen.findByRole('button', { name: /Re-run with current prompt/ });
    fireEvent.click(rerunButton);

    // A fresh pipeline run streams from the trigger endpoint (which always
    // fetches the current published prompt server-side).
    await waitFor(() => expect(readSSEStream).toHaveBeenCalled());
    expect(readSSEStream.mock.calls[0][0]).toBe('/assignment/trigger/42501?stream=true');
  });
});
