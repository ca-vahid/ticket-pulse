/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TicketHistoryTimeline, { HistoryRow, dayHeading, fullTime } from './TicketHistoryTimeline';
import { buildHistoryItems, countMachine } from '../../utils/ticketHistory';

// QA 11-05 #9 — the Activity tab: the right actor, one line per event,
// workflow runs, and machine activity one line per action.

afterEach(cleanup);

const DAY = 86400e3;
const now = Date.now();
const iso = (ms) => new Date(now - ms).toISOString();

const data = {
  activities: [
    { id: 1, activityType: 'reassigned', performedBy: 'Jordan Lee', performedAt: iso(60e3), actorKind: 'human', details: { fromTechId: 1, toTechId: 2, note: 'Ticket reassigned — Competency mismatch', actorKind: 'human' } },
  ],
  assignmentEpisodes: [
    { id: 7, technician: { name: 'Jordan Lee' }, startMethod: 'workflow_assigned', startAssignedByName: 'Ticket Pulse AI', startedAt: iso(14 * DAY) },
  ],
  workflowRuns: [
    { id: 31, workflowName: 'New ticket acknowledgement', eventType: 'ticket.created', status: 'completed', executionMode: 'live', shadow: false, startedAt: iso(14 * DAY + 60e3), durationMs: 1200, outcome: 'acted', actions: [{ type: 'email', to: 1, cc: 0, sent: true }], steps: [{ nodeId: 'trigger', nodeType: 'trigger', status: 'completed' }, { nodeId: 'send', nodeType: 'send_email', status: 'completed', note: '1 recipient' }] },
    { id: 32, workflowName: 'Ticket arrived', eventType: 'ticket.created', status: 'completed', executionMode: 'mock', shadow: true, startedAt: iso(14 * DAY + 120e3), durationMs: 4400, outcome: 'acted', actions: [{ type: 'email', to: 1, cc: 0, sent: false, reason: 'Shadow - email not sent' }], steps: [] },
  ],
  techNameById: new Map([[1, 'Jordan Lee'], [2, 'Sam Ortiz']]),
};

function renderTab(hideMachine = true) {
  const items = buildHistoryItems(data);
  render(<TicketHistoryTimeline items={items} hideMachine={hideMachine} onToggleMachine={() => {}} hiddenMachineCount={countMachine(items)} />);
  return screen.getByRole('region', { name: 'Ticket history' });
}

describe('Activity tab, one line per event (QA 11-05 #9)', () => {
  test('the AI-assigned step sits under Ticket Pulse AI, not under the assignee, and "by …" is never printed', () => {
    const section = renderTab();
    const aiRun = within(section).getAllByTestId('history-run').find((r) => r.getAttribute('data-actor') === 'Ticket Pulse AI');
    expect(aiRun).toBeTruthy();
    const row = within(aiRun).getByTestId('history-row');
    expect(row).toHaveTextContent('Ticket Pulse AI');
    expect(row).toHaveTextContent(/assigned.*Jordan Lee.*auto-assign/);
    expect(section).not.toHaveTextContent(/by Ticket Pulse AI/);
    expect(section).not.toHaveTextContent(/took ownership/);
  });

  test('a person\'s reassignment is one line: picture, name, icon label, from → to and the short reason (with its full text as a title)', () => {
    const section = renderTab();
    const run = within(section).getAllByTestId('history-run').find((r) => r.getAttribute('data-actor') === 'Jordan Lee');
    const rows = within(run).getAllByTestId('history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/reassigned.*Jordan Lee.*Sam Ortiz.*Competency mismatch/);
    expect(within(rows[0]).getByText('Assignment')).toHaveClass('sr-only');
    expect(within(rows[0]).getByTitle('Competency mismatch')).toBeInTheDocument();
    // Initials when there is no photo.
    expect(within(rows[0]).getAllByText('JL').length).toBeGreaterThanOrEqual(1);
    // No pills: no "Human" chip.
    expect(within(section).queryByText('Human')).not.toBeInTheDocument();
  });

  test('a live workflow run shows as its own line; the Shadow run is machine activity, labelled when shown', () => {
    let section = renderTab(true);
    const wf = within(section).getAllByTestId('history-row').filter((r) => r.getAttribute('data-event') === 'wfrun');
    expect(wf).toHaveLength(1);
    expect(wf[0]).toHaveTextContent(/Workflow.*“New ticket acknowledgement”.*ran.*e-mailed 1 person/);
    expect(within(section).getByTestId('machine-hidden-count')).toHaveTextContent('1 machine event hidden');
    cleanup();
    section = renderTab(false);
    const shadow = within(section).getAllByTestId('history-row').find((r) => /Ticket arrived/.test(r.textContent));
    expect(shadow).toHaveTextContent(/Shadow — nothing sent.*would e-mail 1 person/);
    expect(within(shadow).getByText('Shadow run')).toHaveClass('sr-only');
  });

  test('the whole row is the disclosure button: expanding shows the steps and the Pacific time, collapsing hides them', () => {
    const section = renderTab();
    const row = within(section).getAllByTestId('history-row').find((r) => r.getAttribute('data-event') === 'wfrun');
    const button = within(row).getByRole('button', { expanded: false });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const details = within(row).getByTestId('history-details');
    expect(within(details).getByRole('list', { name: 'Workflow steps' })).toHaveTextContent(/E-mail · 1 recipient/);
    expect(details).toHaveTextContent(/took 1\.2 s/);
    expect(details).toHaveTextContent(fullTime(data.workflowRuns[0].startedAt));
    fireEvent.click(button);
    expect(within(row).queryByTestId('history-details')).not.toBeInTheDocument();
  });

  test('below sm the change sits on its own wrapping line under the name; from sm up it shares the line (UI Design 11-05)', () => {
    const section = renderTab();
    const row = within(section).getAllByTestId('history-row').find((r) => /Competency mismatch/.test(r.textContent));
    const change = within(row).getByTestId('history-change');
    // Phone: line 2, wrapping, never truncated; desktop: line 1.
    expect(change.className).toMatch(/\brow-start-2\b/);
    expect(change.className).toMatch(/\bflex-wrap\b/);
    expect(change.className).toMatch(/\bwhitespace-normal\b/);
    expect(change.className).toMatch(/\bsm:row-start-1\b/);
    for (const el of change.querySelectorAll('*')) expect(el.className?.baseVal ?? el.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    // The actor's name is visible text on the phone too (not only a tooltip).
    expect(within(row).getByText('Jordan Lee', { selector: 'span.truncate' })).not.toHaveClass('sr-only');
  });

  test('the peek (compact) is always two lines and never truncates a value', () => {
    const items = buildHistoryItems(data).filter((i) => !i.machine);
    render(<div>{items.map((i) => <HistoryRow key={i.key} item={i} compact />)}</div>);
    const rows = screen.getAllByTestId('history-row');
    expect(rows.every((r) => r.getAttribute('data-layout') === 'two-line')).toBe(true);
    const change = within(rows.find((r) => /Sam Ortiz/.test(r.textContent))).getByTestId('history-change');
    expect(change.className).not.toMatch(/sm:/);
    expect(change.innerHTML).not.toMatch(/sm:truncate|(\s|")truncate(\s|")/);
  });

  test('every arrow is the ArrowRight icon, also inside a workflow summary; workflow rows use the run icon, not the workflow glyph twice', () => {
    const items = buildHistoryItems({ workflowRuns: [{ ...data.workflowRuns[0], id: 40, actions: [{ type: 'update', fields: ['status'], status: { from: 'Pending', to: 'Open' } }] }] });
    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    const row = screen.getByTestId('history-row');
    const change = within(row).getByTestId('history-change');
    expect(change.textContent).toMatch(/set status Pending\s*Open/);
    expect(change.textContent).not.toContain('→');
    expect(within(change).getAllByLabelText('to').length).toBeGreaterThanOrEqual(1);
    expect(within(row).getByText('Workflow run')).toHaveClass('sr-only');
    expect(row.querySelectorAll('svg.lucide-workflow')).toHaveLength(1);
    expect(row.querySelectorAll('svg.lucide-play')).toHaveLength(1);
  });

  test('a macro reads as the person\'s one line with the wand icon', () => {
    const items = buildHistoryItems({ activities: [{ id: 81, activityType: 'macro_applied', performedBy: 'Alex Rivera', performedAt: iso(30e3), details: { actorKind: 'human', macroName: 'Laptop handover', steps: [{ type: 'note', summary: 'Added a note', ok: true }] } }] });
    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    const row = screen.getByTestId('history-row');
    expect(row).toHaveTextContent(/Alex Rivera.*applied macro “Laptop handover”.*1 step/);
    expect(within(row).getByText('Macro')).toHaveClass('sr-only');
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByTestId('history-details')).toHaveTextContent('Added a note');
  });

  test('day headings name the day ("Today", "Tue 3 Nov")', () => {
    const section = renderTab();
    const headings = within(section).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe('Today');
    expect(headings[1]).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/);
    expect(dayHeading(Date.parse('2026-11-03T20:00:00Z'), Date.parse('2026-11-05T20:00:00Z'))).toBe('Tue 3 Nov');
    expect(fullTime(Date.parse('2026-10-22T21:14:00Z'))).toMatch(/^Thu 22 Oct(?: 2026)?, 2:14 PM$/);
  });
});
