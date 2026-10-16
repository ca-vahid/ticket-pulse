/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));

vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
  useEditor: () => null,
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: {},
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));

const getAuditMock = vi.fn();
const getAuditRunEmailMock = vi.fn();
vi.mock('../../services/api', () => ({
  notificationWorkflowAPI: {
    getAudit: (...args) => getAuditMock(...args),
    getAuditRunEmail: (...args) => getAuditRunEmailMock(...args),
  },
}));

const { MockAuditPanel } = await import('./NotificationWorkflowsPanel.jsx');

const FILTERS = {
  executionMode: 'live_mock',
  workflowId: 'all',
  range: '7d',
  status: 'all',
  health: 'all',
  signalLevel: 'all',
  eventType: 'all',
  triggerSource: 'all',
  provider: 'all',
  fallbackSource: 'all',
  department: 'all',
  search: '',
};

// A slim list row, as GET /notification-workflows/runs sends it.
const summaryRun = {
  summary: true,
  id: 91,
  auditId: 'TP-NWF-91',
  workflowId: 12,
  eventType: 'ticket.created',
  status: 'completed',
  executionMode: 'live',
  startedAt: '2026-10-14T20:10:00.000Z',
  workflow: { id: 12, name: 'Brisbane variant', key: 'ticket_created_brisbane_copy', triggerType: 'ticket.created', scheduleMode: 'after_hours' },
  ticket: { id: 601, displayRef: 'TP-1042', subject: 'Laptop will not start' },
  health: { state: 'completed_with_warning', label: 'Warning', notSent: true, summary: 'Not sent: no recipient' },
  warnings: [{ type: 'no_recipient', message: 'Not sent: no recipient' }],
  steps: [{ id: 1, nodeId: 'send', nodeType: 'send_email', status: 'completed' }],
  deliveries: [],
};

function renderPanel(props = {}) {
  return render(
    <MockAuditPanel
      workflows={[]}
      selectedWorkflow={null}
      runs={[summaryRun]}
      selectedRun={summaryRun}
      loading={false}
      error={null}
      filters={FILTERS}
      onFiltersChange={vi.fn()}
      onRefresh={vi.fn()}
      onSelectRun={vi.fn()}
      tabbed
      {...props}
    />,
  );
}

beforeEach(() => {
  getAuditMock.mockReset();
  getAuditRunEmailMock.mockReset();
  getAuditRunEmailMock.mockResolvedValue({ data: null });
  getAuditMock.mockResolvedValue({
    data: {
      ...summaryRun,
      summary: undefined,
      eventContext: { ticket: { subject: 'Laptop will not start' } },
      steps: [
        { id: 1, nodeId: 'recipients', nodeType: 'recipient_resolver', status: 'completed', output: { recipients: { to: [], cc: [], bcc: [] } } },
        { id: 2, nodeId: 'send', nodeType: 'send_email', status: 'completed', output: { skipped: true, reason: 'No recipient email address resolved' } },
      ],
    },
  });
});

afterEach(cleanup);

describe('Workflow Audit panel (QA 10-15)', () => {
  test('the list row shows the TP number, the after-hours label and the not-sent warning', async () => {
    renderPanel();
    const list = screen.getByTestId('workflow-audit-list');
    expect(list).toHaveTextContent('TP-1042');
    expect(list).toHaveTextContent('Ticket arrived after-hours / holiday');
    expect(list).not.toHaveTextContent('during business hours');
    expect(list).toHaveTextContent('Not sent: no recipient');
    await waitFor(() => expect(getAuditMock).toHaveBeenCalledWith('TP-NWF-91'));
  });

  test('the detail loads once for the open run, not with the list', async () => {
    const { rerender } = renderPanel();
    await waitFor(() => expect(getAuditMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Steps')).toBeInTheDocument();
    // Re-render with the same run (e.g. typing in search): served from cache.
    rerender(
      <MockAuditPanel
        workflows={[]}
        runs={[summaryRun]}
        selectedRun={summaryRun}
        loading
        filters={{ ...FILTERS, search: 'TP-1042' }}
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onSelectRun={vi.fn()}
        tabbed
      />,
    );
    expect(getAuditMock).toHaveBeenCalledTimes(1);
    // Rows stay on screen while a new search loads.
    expect(screen.getByTestId('workflow-audit-list')).toHaveTextContent('TP-1042');
  });

  test('less-used filters sit behind "More filters", which counts the ones in use', () => {
    renderPanel({ filters: { ...FILTERS, provider: 'openai', department: 'Brisbane' } });
    const toggle = screen.getByRole('button', { name: /More filters/ });
    expect(toggle).toHaveTextContent('(2 on)');
    // Opens by itself when some are in use; closes on click.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Filter workflow audit by LLM provider')).not.toBeInTheDocument();
    // The everyday filters stay out.
    expect(screen.getByLabelText('Filter workflow audit by event type')).toBeInTheDocument();
    expect(screen.getByLabelText('Search workflow audit')).toBeInTheDocument();
  });

  test('layout: filters wrap in an auto-fit grid; list and detail sit side by side only from lg', () => {
    renderPanel();
    const filters = screen.getByTestId('workflow-audit-filters');
    expect(filters.className).toContain('grid-cols-[repeat(auto-fill,minmax(160px,1fr))]');
    expect(filters.className).not.toMatch(/(^|\s)xl:grid-cols-/);
    const split = screen.getByTestId('workflow-audit-split');
    expect(split.className).toContain('lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]');
    // Below lg nothing is clipped: the tab scrolls and the list has its own height.
    expect(split.className).not.toMatch(/(^|\s)overflow-hidden/);
    expect(screen.getByTestId('workflow-audit-panel').className).toContain('overflow-y-auto');
    expect(screen.getByTestId('workflow-audit-list').className).toContain('h-[40vh]');
  });
});
