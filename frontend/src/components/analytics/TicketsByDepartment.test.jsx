/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  analyticsAPI: { getTicketsByDepartment: vi.fn() },
  ticketsAPI: { getDepartmentMap: vi.fn().mockResolvedValue({ data: null }) },
}));

import { analyticsAPI } from '../../services/api';
import TicketsByDepartment, { buildDepartmentBarOptions } from './TicketsByDepartment';

/**
 * Analytics → Demand → Tickets by department (QA 11-24 #2): counts and shares
 * of tickets created in range by the requester's department, or by city.
 * Deterministic; Unknown last; the table lists every group.
 */
const DATA = {
  total: 20,
  departments: [
    { label: 'Geoscience & Engineering', count: 9, pct: 45, unknown: false },
    { label: 'Accounting', count: 6, pct: 30, unknown: false },
    { label: 'IT', count: 3, pct: 15, unknown: false },
    { label: 'Unknown', count: 2, pct: 10, unknown: true },
  ],
  cities: [
    { label: 'Vancouver', count: 12, pct: 60, unknown: false },
    { label: 'Calgary', count: 8, pct: 40, unknown: false },
  ],
  coverage: { departmentKnown: 18, cityKnown: 20, total: 20 },
};

const params = { range: '30d', groupBy: 'day', compare: 'none', excludeNoise: 'false', timezone: 'America/Vancouver' };

describe('TicketsByDepartment', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('fetches with the page params and lists every department with count and share', async () => {
    analyticsAPI.getTicketsByDepartment.mockResolvedValue({ data: DATA });
    render(<TicketsByDepartment params={params} />);
    const table = await screen.findByTestId('tickets-by-department-table');
    expect(analyticsAPI.getTicketsByDepartment).toHaveBeenCalledWith(params);
    const rows = within(table).getAllByRole('row');
    // header + 4 groups + total
    expect(rows).toHaveLength(6);
    expect(within(rows[1]).getByText('Geoscience & Engineering')).toBeInTheDocument();
    expect(within(rows[1]).getByText('45%')).toBeInTheDocument();
    expect(within(rows[4]).getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText(/20 tickets; 18 with a known department/)).toBeInTheDocument();
    expect(screen.getByTestId('department-mapping')).toBeInTheDocument();
  });

  it('switches to cities without another request', async () => {
    render(<TicketsByDepartment params={params} data={DATA} />);
    fireEvent.click(screen.getByRole('tab', { name: 'By city' }));
    const table = screen.getByTestId('tickets-by-department-table');
    expect(within(table).getByRole('columnheader', { name: 'City' })).toBeInTheDocument();
    expect(within(table).getByText('Vancouver')).toBeInTheDocument();
    expect(analyticsAPI.getTicketsByDepartment).not.toHaveBeenCalled();
  });

  it('says so when nothing was created, and offers a retry on failure', async () => {
    render(<TicketsByDepartment params={params} data={{ total: 0, departments: [], cities: [], coverage: {} }} />);
    expect(screen.getByTestId('tickets-by-department-empty')).toBeInTheDocument();
    cleanup();
    analyticsAPI.getTicketsByDepartment.mockRejectedValueOnce(new Error('timeout'));
    render(<TicketsByDepartment params={params} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('timeout'));
  });

  it('bar options take colours from the palette and keep Unknown grey', () => {
    const opts = buildDepartmentBarOptions(DATA.departments, { blue: '#111111', ash: '#999999' });
    expect(opts.chart.type).toBe('bar');
    expect(opts.xAxis.categories).toEqual(['Geoscience & Engineering', 'Accounting', 'IT', 'Unknown']);
    expect(opts.series[0].data.map((p) => p.color)).toEqual(['#111111', '#111111', '#111111', '#999999']);
    expect(opts.series[0].data[0]).toMatchObject({ y: 9, pct: 45 });
  });
});
