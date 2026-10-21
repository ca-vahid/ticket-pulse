/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import WorkflowPreviewPage, { PREVIEW_FILTER_DEFAULTS } from './WorkflowPreviewPage';

afterEach(cleanup);

const TICKETS = {
  items: [
    { id: 1, displayRef: 'TP-10179', origin: 'ticketpulse', subject: 'anyone working today?', status: 'Open', priorityLabel: 'Medium', requester: { name: 'Richard Carter' }, assignedAgent: null, createdAt: new Date().toISOString() },
    { id: 2, displayRef: '#247711', origin: 'freshservice', subject: 'VPN down', status: 'Pending', priorityLabel: 'High', requester: { name: 'Ana' }, assignedAgent: { name: 'Mehdi' }, createdAt: new Date().toISOString(), internalCategory: { name: 'Network' } },
  ],
  total: 2,
  totalPages: 1,
};

const MODEL = {
  summary: { status: 'running', ref: 'TP-10179', subject: 'anyone working today?', auditId: 'TP-NWF-7001', facts: ['2.1 s'] },
  steps: [
    { key: 'trigger', nodeId: 'trigger', nodeType: 'trigger', typeLabel: 'Trigger', name: 'Trigger', status: 'completed', durationMs: 3, hasPayload: false },
    { key: 'llm', nodeId: 'llm', nodeType: 'llm_generate', typeLabel: 'LLM', name: 'Draft reply', status: 'running', hasPayload: false },
    { key: 'send', nodeId: 'send', nodeType: 'send_email', typeLabel: 'Send email', name: 'Send email', status: 'pending', hasPayload: false },
  ],
  email: null,
  recipients: {},
  llm: [],
  issues: [],
  pendingEmail: true,
};

function renderPage(props = {}) {
  const handlers = {
    onBack: vi.fn(),
    onRun: vi.fn(),
    onFiltersChange: vi.fn(),
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
  };
  render(
    <WorkflowPreviewPage
      workflowName="Ticket arrived during business hours"
      tickets={TICKETS}
      filters={PREVIEW_FILTER_DEFAULTS}
      page={1}
      pageSize={25}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('Workflow Preview page (18 Oct 2026)', () => {
  test('a dense ticket list with a Run button on every row', () => {
    const { onRun } = renderPage();
    const row = screen.getByTestId('preview-ticket-1');
    expect(row).toHaveTextContent('TP-10179');
    expect(row).toHaveTextContent('Unassigned');
    fireEvent.click(within(row).getByRole('button', { name: 'Run preview on TP-10179' }));
    expect(onRun).toHaveBeenCalledWith(TICKETS.items[0]);
    expect(screen.getByTestId('preview-ticket-2')).toHaveTextContent('Network');
    // No pop-up chrome: no Close, no "Run with selected ticket", no action-block switch.
    expect(screen.queryByText(/Run with selected ticket/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Show all checked action blocks/)).not.toBeInTheDocument();
  });

  test('filters sit on one row as icon selects, with 25 or 50 a page', () => {
    const { onFiltersChange, onPageSizeChange } = renderPage();
    const row = screen.getByTestId('preview-filters');
    expect(row.className).toContain('overflow-x-auto');
    fireEvent.change(screen.getByLabelText('Filter preview tickets by owner'), { target: { value: 'unassigned' } });
    expect(onFiltersChange).toHaveBeenCalledWith({ assigned: 'unassigned' });
    fireEvent.change(screen.getByLabelText('Filter preview tickets by where the ticket was born'), { target: { value: 'ticketpulse' } });
    expect(onFiltersChange).toHaveBeenCalledWith({ origin: 'ticketpulse' });
    fireEvent.change(screen.getByLabelText('Tickets per page'), { target: { value: '50' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
    expect(screen.getByTestId('preview-range')).toHaveTextContent('1–2 of 2');
  });

  test('Back returns to the workflow', () => {
    const { onBack } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Back to Ticket arrived during business hours/ }));
    expect(onBack).toHaveBeenCalled();
  });

  test('while a run goes, the list folds into a strip and the pipeline fills in', () => {
    renderPage({ running: true, hasRun: true, runTicket: TICKETS.items[0], model: MODEL });
    expect(screen.queryByTestId('preview-ticket-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-ticket-strip')).toHaveTextContent('TP-10179');
    const pipeline = screen.getByTestId('run-pipeline');
    const states = [...pipeline.querySelectorAll('[data-state]')].map((el) => el.getAttribute('data-state'));
    expect(states).toEqual(['done', 'running', 'pending']);
    expect(screen.getByTestId('run-summary')).toHaveTextContent('TP-NWF-7001');
    fireEvent.click(screen.getByRole('button', { name: /Choose another ticket/ }));
    expect(screen.getByTestId('preview-ticket-table')).toBeInTheDocument();
  });

  test('a finished run shows the LLM output wide, with its facts', () => {
    renderPage({
      hasRun: true,
      runTicket: TICKETS.items[0],
      model: {
        ...MODEL,
        summary: { ...MODEL.summary, status: 'completed' },
        steps: MODEL.steps.map((step) => ({ ...step, status: step.key === 'send' ? 'not_reached' : 'completed' })),
        email: { subject: 'Re: anyone working today?', html: '<p>Hi Richard</p>', text: 'Hi Richard' },
        recipients: { to: ['rcarter@example.com'] },
        pendingEmail: false,
        llm: [{
          nodeId: 'llm',
          name: 'Draft reply',
          llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', tokenDiagnostics: { outputTokens: 412, requestedMaxTokens: 1200 }, guard: { accepted: true } },
          email: { subject: 'Re: anyone working today?', text: 'Hi Richard, we are on it.' },
          durationMs: 2300,
        }],
      },
    });
    const llm = screen.getByTestId('run-llm');
    expect(llm).toHaveTextContent('anthropic · claude-sonnet-5-5');
    expect(llm).toHaveTextContent('412 / 1200');
    expect(llm).toHaveTextContent('Hi Richard, we are on it.');
    expect(screen.getByTestId('run-email')).toHaveTextContent('rcarter@example.com');
    expect(screen.getByTestId('run-email-frame')).toBeInTheDocument();
    const steps = screen.getByTestId('run-steps');
    expect(steps).toHaveTextContent('not reached');
  });
});

// QA 10-20 #8: TP-10019 (Vancouver) previewed on the Brisbane after-hours
// variant ran as if it matched. The preview now stops at routing.
describe('a ticket the routing rule does not match (QA 10-20 #8)', () => {
  const SKIPPED = {
    ...MODEL,
    summary: { ...MODEL.summary, status: 'skipped', auditId: null, facts: [] },
    steps: MODEL.steps.map((step) => ({ ...step, status: 'not_reached' })),
    pendingEmail: false,
    skipped: {
      reason: 'routing_rule_not_matched',
      ruleText: 'Requester region equals "AU-BRISBANE"',
      fields: [{ label: 'Requester region', value: 'CA-VANCOUVER' }],
      goesTo: 'Ticket arrived after-hours / holiday',
    },
    routing: { wouldRunSelectedWorkflow: false, ownRule: { present: true, matched: false }, reason: 'No exclusive variant matched; default workflow selected' },
    emptyEmailText: 'Nothing ran, so there is no e-mail.',
  };

  test('says Skipped, shows the rule and the value it read, and offers Preview it anyway', () => {
    const runTicket = TICKETS.items[0];
    const { onRun } = renderPage({ hasRun: true, runTicket, model: SKIPPED });
    expect(screen.getByTestId('run-summary')).toHaveTextContent('Skipped by routing');
    const box = screen.getByTestId('run-skipped');
    expect(box).toHaveTextContent('Skipped: this ticket does not match the workflow’s routing rule');
    expect(box).toHaveTextContent('Requester region equals "AU-BRISBANE"');
    expect(box).toHaveTextContent('Requester region on this ticket');
    expect(box).toHaveTextContent('CA-VANCOUVER');
    expect(box).toHaveTextContent('Runs insteadTicket arrived after-hours / holiday');
    expect(screen.getByText('The routing rule does not match this ticket')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Preview it anyway' }));
    expect(onRun).toHaveBeenCalledWith(runTicket, { ignoreRouting: true });
  });

  test('the subject column no longer takes all the spare width', () => {
    renderPage();
    const cols = screen.getByTestId('preview-ticket-table').querySelectorAll('col');
    expect(cols[3].className).toContain('w-[16%]');
    expect(cols[4].className).toContain('w-[15%]');
    expect(cols[7].className).toContain('w-[20%]');
  });
});
