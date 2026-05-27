/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

  test('shows priority writeback and alert delivery audit evidence', async () => {
    render(<PipelineRunDetail
      run={{
        id: 3102,
        status: 'completed',
        decision: 'priority_only',
        triggerSource: 'priority_assessment_after_hours',
        createdAt: '2026-05-26T16:00:00.000Z',
        priorityWritebackStatus: 'synced',
        priorityWrittenAt: '2026-05-26T16:01:00.000Z',
        priorityWritebackPayload: { preview: 'Set priority to Urgent' },
        ticket: {
          id: 502,
          freshserviceTicketId: 223000,
          subject: 'Production system outage',
          status: 'Open',
          priority: 4,
          assessedPriority: 'Urgent',
          assessedPriorityId: 4,
          priorityRationale: 'Production outage after hours.',
          priorityConfidence: 'high',
          createdAt: '2026-05-26T15:30:00.000Z',
          requester: { name: 'Casey Brown', department: 'Operations' },
        },
        recommendation: {
          overallReasoning: 'After-hours urgent priority pass.',
          recommendations: [{ techId: 17, techName: 'Alex Chen' }],
        },
        notificationDeliveries: [{
          id: 88,
          channel: 'sms',
          status: 'sent',
          recipient: '+16045551234',
          provider: 'twilio',
          providerMessageId: 'SM123',
          queuedAt: '2026-05-26T16:01:10.000Z',
          sentAt: '2026-05-26T16:01:12.000Z',
        }],
        steps: [{
          id: 99,
          stepName: 'after_hours_urgent_escalation',
          status: 'completed',
          output: { queued: 1, channels: ['sms'] },
          createdAt: '2026-05-26T16:01:10.000Z',
        }],
      }}
      isAdmin={false}
      workspaceTimezone="America/Vancouver"
    />);

    expect(await screen.findByText('Priority and alert audit')).toBeInTheDocument();
    expect(screen.getByText('After-hours priority pass')).toBeInTheDocument();
    expect(screen.getByText('synced')).toBeInTheDocument();
    expect(screen.getByText('Set priority to Urgent')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText('SM123')).toBeInTheDocument();
  });

  test('shows provider and fallback audit details', async () => {
    render(<PipelineRunDetail
      run={{
        id: 3103,
        status: 'completed',
        decision: 'pending_review',
        triggerSource: 'manual',
        createdAt: '2026-05-26T16:00:00.000Z',
        llmProvider: 'openai',
        llmModel: 'gpt-5.5',
        llmFallbackUsed: true,
        llmFallbackReason: 'primary_request_failed',
        aiProviderAttempts: [
          { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'failed' },
          { provider: 'openai', model: 'gpt-5.5', status: 'succeeded' },
        ],
        ticket: {
          id: 503,
          freshserviceTicketId: 223001,
          subject: 'Laptop setup request',
          status: 'Open',
          priority: 2,
          createdAt: '2026-05-26T15:30:00.000Z',
          requester: { name: 'Casey Brown', department: 'Operations' },
        },
        recommendation: {
          overallReasoning: 'Route to endpoint support.',
          recommendations: [{ techId: 17, techName: 'Alex Chen' }],
        },
        steps: [],
      }}
      isAdmin={false}
      workspaceTimezone="America/Vancouver"
    />);

    expect(await screen.findByText('AI provider fallback used — completed with openai')).toBeInTheDocument();
    expect(screen.getByText(/primary_request_failed/)).toBeInTheDocument();
    expect(screen.getByText(/anthropic\/claude-sonnet-4-6: failed/)).toBeInTheDocument();
    expect(screen.getByText(/openai\/gpt-5.5: succeeded/)).toBeInTheDocument();
    expect(screen.getByText('fallback used')).toBeInTheDocument();
  });
});
