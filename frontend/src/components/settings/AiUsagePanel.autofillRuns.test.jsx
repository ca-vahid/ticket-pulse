/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ticketsAPI } from '../../services/api';
import { AutofillRunsTable } from './AiUsagePanel';

// Autofill v2 — Settings → AI Usage "Autofill runs" table: the workspace's
// last 50 paste reads with who / subject proposed / match states / tokens /
// the ticket they became.

vi.mock('../../services/api', () => ({
  aiUsageAPI: { report: vi.fn(), setUsdCadRate: vi.fn() },
  ticketsAPI: { workspaceIntakeRuns: vi.fn() },
}));
vi.mock('../../utils/highchartsTheme', () => ({ useChartColors: () => ({ series: {} }) }));
// Named exports only — a catch-all Proxy would expose a `then` and make
// vitest await the mock factory forever.
vi.mock('recharts', () => {
  const Nil = () => null;
  return { ResponsiveContainer: Nil, ComposedChart: Nil, Bar: Nil, Line: Nil, XAxis: Nil, YAxis: Nil, Tooltip: Nil, CartesianGrid: Nil };
});

const RUNS = [
  {
    id: 123,
    createdAt: '2026-08-31T15:10:30Z',
    actorName: 'Jane Agent',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    durationMs: 7480,
    inputTokens: 3100,
    outputTokens: 610,
    requestSummary: 'Teams chat',
    result: {
      subject: 'Laptop won’t boot after Windows update',
      requesterMatch: { status: 'matched', candidate: { requesterId: 41, email: 'sdickinson@acme.com', name: 'Simon Dickinson', source: 'requester' } },
      assigneeMatch: { status: 'ambiguous', technician: null, candidates: [] },
    },
    resolved: { ticketId: 9, displayRef: 'TP-9', applied: { subject: true } },
  },
  {
    id: 122,
    createdAt: '2026-08-30T09:00:00Z',
    actorName: 'Bob Agent',
    model: 'gpt-5.6-luna',
    inputTokens: 900,
    outputTokens: 200,
    result: { subject: null, requesterMatch: { status: 'none' }, assigneeMatch: null },
    resolved: null,
  },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderTable = () => render(<MemoryRouter><AutofillRunsTable /></MemoryRouter>);

describe('AiUsagePanel — Autofill runs table', () => {
  test('lists the last runs with who, subject, match chips, tokens and the linked ticket', async () => {
    ticketsAPI.workspaceIntakeRuns.mockResolvedValue({ data: RUNS });
    renderTable();
    const table = await screen.findByTestId('autofill-runs');
    expect(ticketsAPI.workspaceIntakeRuns).toHaveBeenCalledWith(50);
    expect(within(table).getByRole('heading', { name: 'Autofill runs' })).toBeInTheDocument();
    const rows = within(table).getAllByTestId('autofill-run-row');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent('Jane Agent');
    expect(rows[0]).toHaveTextContent('#123 · claude-sonnet-5');
    expect(rows[0]).toHaveTextContent('Laptop won’t boot after Windows update');
    expect(rows[0]).toHaveTextContent('matched');
    expect(rows[0]).toHaveTextContent('ambiguous');
    expect(rows[0]).toHaveTextContent('3.1K / 610');
    expect(within(rows[0]).getByRole('link', { name: 'TP-9' })).toHaveAttribute('href', '/tickets/9');

    expect(rows[1]).toHaveTextContent('Bob Agent');
    expect(within(rows[1]).getAllByText('none')).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('not created');
  });

  test('no runs → an explanatory empty line', async () => {
    ticketsAPI.workspaceIntakeRuns.mockResolvedValue({ data: [] });
    renderTable();
    expect(await screen.findByText(/No Autofill runs yet/)).toBeInTheDocument();
  });

  test('a 404 (feature not deployed) is treated as empty, not an error', async () => {
    ticketsAPI.workspaceIntakeRuns.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    renderTable();
    expect(await screen.findByText(/No Autofill runs yet/)).toBeInTheDocument();
  });

  test('other errors are shown', async () => {
    ticketsAPI.workspaceIntakeRuns.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500, data: { message: 'Database unavailable' } } }));
    renderTable();
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
  });
});
