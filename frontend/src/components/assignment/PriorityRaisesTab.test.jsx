/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PriorityRaisesTab from './PriorityRaisesTab';
import { priorityRaisesAPI } from '../../services/api';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pageSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../pages/AssignmentReview.jsx'), 'utf8');

vi.mock('../../services/api', () => ({
  priorityRaisesAPI: { list: vi.fn() },
}));

const renderTab = () => render(<MemoryRouter><PriorityRaisesTab /></MemoryRouter>);

beforeEach(() => { priorityRaisesAPI.list.mockReset(); });
afterEach(cleanup);

describe('Assignment Review → Raised by requester (QA 11-23 #5)', () => {
  test('lists ticket, subject, AI level → raised level, who and when, for the last 7 days', async () => {
    priorityRaisesAPI.list.mockResolvedValue({
      success: true,
      days: 7,
      data: [
        { ticketId: 900, displayRef: 'TP-1042', subject: 'Cannot sign into Teams', aiPriority: 'Medium', raisedTo: 'Urgent', raisedAt: '2026-11-20T18:17:00.000Z', requesterName: 'Dana Fox' },
        { ticketId: 901, displayRef: 'TP-1050', subject: 'Printer offline', aiPriority: 'Low', raisedTo: 'Urgent', raisedAt: '2026-11-19T22:05:00.000Z', requesterName: 'Sam Okafor' },
      ],
    });
    renderTab();
    expect(priorityRaisesAPI.list).toHaveBeenCalledWith(7);
    expect(await screen.findByTestId('priority-raises-verdict')).toHaveTextContent('2 tickets in the last 7 days: the AI rated them Medium or Low, and the requester raised them from their status link.');
    const table = screen.getByRole('table');
    const rows = within(table).getAllByTestId('priority-raise-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'TP-1042' })).toHaveAttribute('href', '/tickets/900');
    expect(rows[0]).toHaveTextContent('Cannot sign into Teams');
    expect(rows[0]).toHaveTextContent('MediumUrgent');
    expect(within(rows[0]).getByLabelText('raised to')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Dana Fox');
    // Pacific time: 18:17 UTC on 20 Nov is 10:17 AM in Vancouver.
    expect(rows[0]).toHaveTextContent(/Fri 20 Nov( 2026)?, 10:17 AM/);
  });

  test('another period refetches; an empty week says so', async () => {
    priorityRaisesAPI.list.mockResolvedValue({ success: true, data: [] });
    renderTab();
    expect(await screen.findByTestId('priority-raises-verdict')).toHaveTextContent('No requester raised a Medium or Low ticket in the last 7 days.');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(priorityRaisesAPI.list).toHaveBeenLastCalledWith(30));
  });

  test('polish 11-24: the heading and the Assignment Review tab use the same name', async () => {
    priorityRaisesAPI.list.mockResolvedValue({ success: true, data: [] });
    renderTab();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Raised by requester$/);
    expect(screen.getByTestId('priority-raises-tab')).toHaveAccessibleName('Raised by requester');
    // The tab label in AssignmentReview.jsx, read as text (the page is too heavy to render here).
    const tabLine = pageSource.split('\n').find((l) => l.includes("id: 'priority-raises'"));
    expect(tabLine).toContain("label: 'Raised by requester'");
    await screen.findByTestId('priority-raises-verdict');
  });

  test('a 403 reads in plain words', async () => {
    priorityRaisesAPI.list.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only coordinators and admins can see this list.');
  });
});
