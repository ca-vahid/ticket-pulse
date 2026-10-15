/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TicketLinksCard } from './TicketOpsCards';

// 14 Oct 2026 (Vahid): a departure notice with five FreshService children showed
// each child twice — in the family card and again here as "parent of".
vi.mock('../../services/api', () => ({
  ticketsAPI: {
    links: vi.fn(() => Promise.resolve({
      data: [
        { id: 1, kind: 'parent_of', direction: 'out', other: { id: 11, displayRef: '#242556', subject: 'Child Ticket - Laptop' } },
        { id: 2, kind: 'parent_of', direction: 'in', label: 'child of', other: { id: 12, displayRef: '#242000', subject: 'Parent' } },
        { id: 3, kind: 'related_to', direction: 'out', other: { id: 13, displayRef: 'TP-1900', subject: 'Printer on 3' } },
      ],
    })),
    related: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

afterEach(cleanup);

describe('TicketLinksCard', () => {
  test('parent / child stays in the family card; other links are listed', async () => {
    render(<TicketLinksCard ticketId={45123} />);
    expect(await screen.findByText('TP-1900')).toBeInTheDocument();
    expect(screen.queryByText('#242556')).not.toBeInTheDocument();
    expect(screen.queryByText('#242000')).not.toBeInTheDocument();
  });
});
