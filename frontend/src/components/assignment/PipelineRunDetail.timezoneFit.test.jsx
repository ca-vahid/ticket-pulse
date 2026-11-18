/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineRunDetail from './PipelineRunDetail';
import { assignmentAPI, dashboardAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getFreshServiceDomain: vi.fn(),
    getRunFreshness: vi.fn(),
    getCompetencyTechnicians: vi.fn(),
  },
  dashboardAPI: { getTicketHistory: vi.fn() },
}));

// QA 11-17 item 1: the timezone_fit step shows its sentence on the run.
const SENTENCE = 'Time zone: the requester is in Santiago (UTC−3); Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana would be put first.';
const makeRun = (output) => ({
  id: 35000,
  ticketId: 50,
  status: 'completed',
  decision: 'auto_assigned',
  triggerSource: 'webhook',
  createdAt: '2026-11-17T13:14:00.000Z',
  ticket: { id: 50, subject: 'Blue screen', status: 'Open', priority: 2, createdAt: '2026-11-17T13:14:00.000Z', requester: { name: 'Sam Okafor' } },
  recommendation: { overallReasoning: 'Hardware fault.', recommendations: [] },
  steps: [{ id: 1, stepNumber: 4, stepName: 'timezone_fit', status: 'completed', durationMs: 0, output }],
});
const renderRun = (run) => render(
  <MemoryRouter><PipelineRunDetail run={run} workspaceTimezone="America/Vancouver" /></MemoryRouter>,
);

describe('PipelineRunDetail - Time zone fit step', () => {
  beforeEach(() => {
    assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
    assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
    assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
    dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('Shadow: the sentence, marked shadow', () => {
    renderRun(makeRun({ kind: 'timezone_fit', mode: 'shadow', applied: false, sentence: SENTENCE }));
    expect(screen.getByText(/timezone fit/i)).toBeInTheDocument();
    expect(screen.getByTestId('timezone-fit-step-sentence')).toHaveTextContent(`${SENTENCE} (shadow)`);
  });

  test('Live: the sentence alone', () => {
    const live = SENTENCE.replace('would be put first', 'was put first');
    renderRun(makeRun({ kind: 'timezone_fit', mode: 'live', applied: true, sentence: live }));
    expect(screen.getByTestId('timezone-fit-step-sentence')).toHaveTextContent(live);
    expect(screen.getByTestId('timezone-fit-step-sentence')).not.toHaveTextContent('(shadow)');
  });

  test('Live but not applied: says why, never "shadow"', () => {
    renderRun(makeRun({
      kind: 'timezone_fit', mode: 'live', applied: false, notAppliedReason: 'the run waits for a person to decide', sentence: SENTENCE,
    }));
    const line = screen.getByTestId('timezone-fit-step-sentence');
    expect(line).toHaveTextContent('(not applied: the run waits for a person to decide)');
    expect(line).not.toHaveTextContent('(shadow)');
  });
});
