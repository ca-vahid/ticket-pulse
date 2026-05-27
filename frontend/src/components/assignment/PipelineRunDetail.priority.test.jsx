/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import PipelineRunDetail from './PipelineRunDetail';
import { assignmentAPI, dashboardAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getFreshServiceDomain: vi.fn(),
    getRunFreshness: vi.fn(),
    getCompetencyTechnicians: vi.fn(),
  },
  dashboardAPI: {
    getTicketHistory: vi.fn(),
  },
}));

describe('PipelineRunDetail priority display', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
    assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
    assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
    dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
  });

  test('shows assessed priority and rationale alongside FreshService priority', async () => {
    render(<PipelineRunDetail
      run={{
        id: 3101,
        status: 'completed',
        decision: 'pending_review',
        triggerSource: 'manual',
        createdAt: '2026-05-26T16:00:00.000Z',
        ticket: {
          id: 501,
          freshserviceTicketId: 222999,
          subject: 'VPN outage for project team',
          status: 'Open',
          priority: 2,
          assessedPriority: 'Urgent',
          assessedPriorityId: 4,
          priorityRationale: 'The ticket reports a current outage blocking a project team.',
          priorityConfidence: 'high',
          priorityEvidence: ['outage', 'team impact'],
          createdAt: '2026-05-26T15:30:00.000Z',
          requester: { name: 'Casey Brown', department: 'Projects' },
        },
        recommendation: {
          overallReasoning: 'Route to network support.',
          recommendations: [{ techId: 17, techName: 'Alex Chen' }],
        },
        steps: [],
      }}
      isAdmin={false}
      workspaceTimezone="America/Vancouver"
    />);

    expect(await screen.findByText(/Ticket Pulse assessed priority: Urgent/)).toBeInTheDocument();
    expect(screen.getByText('The ticket reports a current outage blocking a project team.')).toBeInTheDocument();
    expect(screen.getByText('FreshService currently shows Medium.')).toBeInTheDocument();
    expect(screen.getByText('TP Urgent')).toBeInTheDocument();
    expect(screen.getByText('FS Medium')).toBeInTheDocument();
  });
});
