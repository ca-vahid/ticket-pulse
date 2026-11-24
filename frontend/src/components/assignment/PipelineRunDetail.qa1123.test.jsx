/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineRunDetail from './PipelineRunDetail';
import { assignmentAPI, dashboardAPI } from '../../services/api';
import { priorityOverrideFor } from './priorityOverride';
import { assignmentRuleLines } from './assignmentRuleLines';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getFreshServiceDomain: vi.fn(),
    getRunFreshness: vi.fn(),
    getCompetencyTechnicians: vi.fn(),
  },
  dashboardAPI: { getTicketHistory: vi.fn() },
}));

const renderRun = (run) => render(
  <MemoryRouter>
    <PipelineRunDetail run={run} isAdmin={false} workspaceTimezone="America/Vancouver" />
  </MemoryRouter>,
);

const baseTicket = {
  id: 501,
  freshserviceTicketId: 222999,
  subject: 'Cannot sign into Teams',
  status: 'Open',
  priority: 4,
  assessedPriority: 'Urgent',
  assessedPriorityId: 4,
  priorityRationale: 'Requester raised the ticket to urgent through the public ticket urgency link.',
  priorityConfidence: 'requester',
  priorityEvidence: ['Single-user impact', 'No outage or deadline language'],
  createdAt: '2026-11-23T17:47:00.000Z',
  requester: { name: 'Dana Fox', department: 'Finance' },
};
const baseRun = (ticket, extra = {}) => ({
  id: 4101,
  status: 'completed',
  decision: 'pending_review',
  triggerSource: 'manual',
  createdAt: '2026-11-23T18:00:00.000Z',
  ticket,
  recommendation: { overallReasoning: 'Route to collaboration support.', assessedPriority: 'Medium', recommendations: [{ techId: 17, techName: 'Eli Park' }] },
  steps: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  assignmentAPI.getFreshServiceDomain.mockResolvedValue({ domain: 'example.freshservice.com' });
  assignmentAPI.getRunFreshness.mockResolvedValue({ data: null });
  assignmentAPI.getCompetencyTechnicians.mockResolvedValue({ data: [] });
  dashboardAPI.getTicketHistory.mockResolvedValue({ data: { episodes: [] } });
});
afterEach(cleanup);

describe('QA 11-23 #4: the AI\'s earlier assessment after a requester raise', () => {
  test('the requester\'s note first; the AI\'s signals below it, labelled and muted', async () => {
    renderRun(baseRun({ ...baseTicket, priorityReason: { level: 'Urgent', source: 'requester_link', actorName: 'Dana Fox', at: '2026-11-23T18:17:00.000Z', note: 'Our whole team is locked out before the board call.' } }));
    const box = await screen.findByTestId('priority-override-box');
    expect(within(box).getByText('Priority: Urgent, raised by Dana Fox from their status link')).toBeInTheDocument();
    expect(within(box).getByText('Our whole team is locked out before the board call.')).toBeInTheDocument();
    const earlier = within(box).getByTestId('priority-ai-earlier');
    expect(earlier).toHaveClass('text-muted-foreground');
    expect(earlier).toHaveTextContent("The AI's earlier assessment (before Dana Fox raised it)");
    expect(earlier).toHaveTextContent('Rated Medium.');
    expect(earlier).toHaveTextContent('Signals: Single-user impact, No outage or deadline language');
    // The note comes before the AI's signals.
    expect(box.textContent.indexOf('locked out')).toBeLessThan(box.textContent.indexOf('Single-user impact'));
    // No "Ticket Pulse assessed priority: Urgent (requester confidence)".
    expect(screen.queryByText(/Ticket Pulse assessed priority/)).toBeNull();
    // The TP tag's tooltip says the same.
    const tag = screen.getByText('TP Urgent');
    expect(tag.getAttribute('title')).toContain('raised by Dana Fox');
    expect(tag.getAttribute('title')).toContain("The AI's earlier assessment (before Dana Fox raised it): rated Medium; signals: Single-user impact");
  });

  test('an older raise (no priorityReason yet) is found by its requester marker', () => {
    const o = priorityOverrideFor(baseTicket, baseRun(baseTicket));
    expect(o.earlierLabel).toBe("The AI's earlier assessment (before Dana Fox raised it)");
    expect(o.note).toBe(baseTicket.priorityRationale);
    expect(o.aiRationale).toBeNull();
  });

  test('an agent\'s change: "before Eli Park changed it"; the AI rationale is kept as the earlier view', () => {
    const ticket = { ...baseTicket, priority: 3, assessedPriority: 'Medium', assessedPriorityId: 2, priorityConfidence: 'medium', priorityRationale: 'One person affected.', priorityReason: { level: 'High', source: 'agent', actorName: 'Eli Park', at: '2026-11-23T18:20:00.000Z', note: null } };
    const o = priorityOverrideFor(ticket, null);
    expect(o.headline).toBe('Priority: High, changed by Eli Park');
    expect(o.earlierLabel).toBe("The AI's earlier assessment (before Eli Park changed it)");
    expect(o.aiLevel).toBe('Medium');
    expect(o.aiRationale).toBe('One person affected.');
  });

  test('the AI\'s own priority keeps the old box', async () => {
    renderRun(baseRun({ ...baseTicket, priorityConfidence: 'high', priorityRationale: 'Outage for a team.', priorityReason: { level: 'Urgent', source: 'ai_assessment', actorName: 'Ticket Pulse AI' } }));
    expect(await screen.findByText(/Ticket Pulse assessed priority: Urgent/)).toBeInTheDocument();
    expect(screen.queryByTestId('priority-override-box')).toBeNull();
    expect(screen.getByText('Signals: Single-user impact, No outage or deadline language')).toBeInTheDocument();
  });
});

describe('QA 11-23 #6: Level match and same-day follow-up in plain words', () => {
  const levelMatch = {
    mode: 'live', outcome: 'moved', applied: true, requiredLevel: 'intermediate',
    sentence: 'Lighter day: Priya Nair (2 today) instead of Eli Park (6 today). Both intermediate in Teams; Priya Nair has 4 open, Eli Park 9.',
    moveReason: 'lighter_day', skipped: [],
  };
  const followUpRouting = {
    mode: 'shadow', outcome: 'would_route', applied: false, notAppliedReason: 'shadow', relatedTicketId: 900, relatedRef: 'TP-1042',
    to: { techId: 17, techName: 'Eli Park' }, sentence: 'Would send to Eli Park: same problem as TP-1042 reported today.',
  };
  const repeatReport = { relatedTicketId: 900, relatedRef: 'TP-1042', raised: true, aiPriority: 'Medium', raisedTo: 'High', sentence: 'Raised to High: same problem reported again today (TP-1042).' };

  test('the run detail shows each rule\'s sentence and whether it changed anything', async () => {
    const ticket = { ...baseTicket, priority: 3, priorityConfidence: 'high', priorityReason: null };
    renderRun(baseRun(ticket, { recommendation: { ...baseRun(ticket).recommendation, levelMatch, followUpRouting, repeatReport } }));
    const block = await screen.findByTestId('run-rule-lines');
    expect(within(block).getByTestId('run-rule-level_match')).toHaveTextContent(levelMatch.sentence);
    const follow = within(block).getByTestId('run-rule-follow_up');
    expect(follow).toHaveTextContent('Would send to Eli Park: same problem as TP-1042 reported today.');
    expect(follow).toHaveTextContent('Shadow: nothing was changed.');
    expect(within(follow).getByRole('link', { name: 'Open TP-1042' })).toHaveAttribute('href', '/tickets/900');
    expect(within(block).getByTestId('run-rule-repeat_report')).toHaveTextContent('Raised to High: same problem reported again today (TP-1042).');
  });

  test('a Live move that could not act says why; runs without rule records show nothing', () => {
    const lines = assignmentRuleLines({ recommendation: { followUpRouting: { ...followUpRouting, mode: 'live', notAppliedReason: 'suggest_only' } } });
    expect(lines[0].note).toBe('Not applied: the run only suggested a person; it did not assign.');
    expect(assignmentRuleLines({ recommendation: {} })).toEqual([]);
    // After hours a repeat is not raised; B2's sentence is shown as given.
    const kept = assignmentRuleLines({ recommendation: { repeatReport: { ...repeatReport, raised: false, raisedTo: null, notRaisedReason: 'after_hours', sentence: "Kept at High: after hours, a repeat report doesn't page on-call." } } });
    expect(kept[0]).toMatchObject({ key: 'repeat_report', sentence: "Kept at High: after hours, a repeat report doesn't page on-call." });
    // A step-only record is found too.
    const fromStep = assignmentRuleLines({ steps: [{ stepName: 'level_match', output: { kind: 'level_match', ...levelMatch, mode: 'shadow' } }] });
    expect(fromStep[0]).toMatchObject({ key: 'level_match', note: 'Shadow: nothing was changed.' });
  });
});
