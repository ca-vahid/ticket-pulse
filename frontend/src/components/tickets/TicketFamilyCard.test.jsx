/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TicketFamilyCard from './TicketFamilyCard';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: { family: vi.fn(), addChild: vi.fn(), setParent: vi.fn(), removeParent: vi.fn() },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const child = (id, ref, status, source) => ({ id, linkId: id, subject: `Child ${ref}`, status, displayRef: ref, source, assignee: null });

// 29 Sep 2026: FreshService's own parent/child links show on FS-born tickets.
describe('TicketFamilyCard — FreshService children', () => {
  test('FreshService links show without an unlink control; Ticket Pulse links keep theirs', async () => {
    ticketsAPI.family.mockResolvedValue({ data: { data: {
      parent: null,
      children: [child(44390, '#241814', 'Open', 'freshservice'), child(50001, 'TP-1200', 'Open', 'ticketpulse')],
      fsExternalChildren: [],
    } } });
    render(<TicketFamilyCard ticketId={44395} canWrite />);
    expect(await screen.findByText('Children (2)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Unlink child' })).toHaveLength(1);
    expect(screen.getByText('FreshService')).toBeInTheDocument();
  });

  test('children FreshService has but Ticket Pulse does not are listed by their FS number', async () => {
    ticketsAPI.family.mockResolvedValue({ data: { data: {
      parent: null,
      children: [child(44390, '#241814', 'Open', 'freshservice')],
      fsExternalChildren: [{ fsId: 299999, subject: 'Elsewhere', status: 'Resolved', agent: 'm@x.io' }],
    } } });
    render(<TicketFamilyCard ticketId={44395} canWrite={false} />);
    expect(await screen.findByText('Children (2)')).toBeInTheDocument();
    expect(screen.getByText('#299999')).toBeInTheDocument();
    expect(screen.getByText('Elsewhere')).toBeInTheDocument();
  });

  test('a FreshService parent is shown on the child without a remove control', async () => {
    ticketsAPI.family.mockResolvedValue({ data: { data: {
      parent: { id: 44395, linkId: 1, subject: 'Departure', status: 'Open', displayRef: '#241813', source: 'freshservice', assignee: null },
      children: [],
    } } });
    render(<TicketFamilyCard ticketId={44394} canWrite />);
    expect(await screen.findByText('#241813')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove parent' })).not.toBeInTheDocument();
  });
});
