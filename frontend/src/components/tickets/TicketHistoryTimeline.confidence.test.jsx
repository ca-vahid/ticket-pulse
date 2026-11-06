/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TicketHistoryTimeline from './TicketHistoryTimeline';
import { buildHistoryItems, countMachine } from '../../utils/ticketHistory';

// QA 11-05b #3 — the Activity tab follow-ups: the AI's confidence only in the
// expanded details of its assignment line; workflow preview runs never shown.

afterEach(cleanup);

const now = Date.now();
const iso = (ms) => new Date(now - ms).toISOString();

const data = {
  assignmentEpisodes: [
    { id: 7, technician: { name: 'Jordan Lee' }, startMethod: 'workflow_assigned', startAssignedByName: 'Ticket Pulse AI', startedAt: iso(3600e3) },
  ],
  pipelineRuns: [{
    id: 33694, status: 'completed', decision: 'auto_assigned', triggerSource: 'webhook', assignedTechId: 2,
    createdAt: iso(3600e3 + 2000), decidedAt: iso(3600e3 + 1000),
    recommendation: { recommendations: [
      { rank: 1, score: 0.82, techId: 2, techName: 'Jordan Lee' },
      { rank: 2, score: 0.7, techId: 3, techName: 'Sam Ortiz' },
      { rank: 3, score: 0.55, techId: 4, techName: 'Casey Park' },
    ] },
  }],
  workflowRuns: [
    { id: 40, workflowName: 'Editor test of Ticket arrived', eventType: 'ticket.created', status: 'completed', executionMode: 'preview', shadow: true, startedAt: iso(600e3), durationMs: 900, outcome: 'nothing', actions: [{ type: 'email', to: 1, cc: 0, sent: false }], steps: [] },
    { id: 41, workflowName: 'Ticket arrived', eventType: 'ticket.created', status: 'completed', executionMode: 'mock', shadow: true, startedAt: iso(500e3), durationMs: 900, outcome: 'acted', actions: [{ type: 'email', to: 1, cc: 0, sent: false }], steps: [] },
  ],
};

function renderTab(hideMachine) {
  const items = buildHistoryItems(data);
  render(<TicketHistoryTimeline items={items} hideMachine={hideMachine} onToggleMachine={() => {}} hiddenMachineCount={countMachine(items)} />);
  return screen.getByRole('region', { name: 'Ticket history' });
}

describe('Activity tab follow-ups (QA 11-05b #3)', () => {
  test('(a) the AI line shows no confidence until it is expanded; then "Confidence 82 % · 3 people considered"', () => {
    const section = renderTab(true);
    const row = within(section).getAllByTestId('history-row').find((r) => /Ticket Pulse AI/.test(r.textContent));
    expect(row).toHaveTextContent(/assigned.*Jordan Lee.*auto-assign/);
    expect(row).not.toHaveTextContent(/Confidence|%/);
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const details = within(row).getByTestId('history-details');
    expect(details).toHaveTextContent('Confidence 82 % · 3 people considered');
    expect(details).toHaveTextContent(/AI run #33694/);
  });

  test('(c) a preview run is not shown even with machine activity on; the Shadow run is', () => {
    const section = renderTab(false);
    const wf = within(section).getAllByTestId('history-row').filter((r) => r.getAttribute('data-event') === 'wfrun');
    expect(wf).toHaveLength(1);
    expect(wf[0]).toHaveTextContent(/Ticket arrived.*Shadow — nothing sent/);
    expect(section).not.toHaveTextContent(/Editor test of Ticket arrived|Preview/);
  });
});
