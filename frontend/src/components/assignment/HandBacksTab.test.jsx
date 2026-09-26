/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HandBacksTab from './HandBacksTab';

// QA 09-25 item 3: Assignment Review → Hand-backs.
const { listSpy, rosterSpy } = vi.hoisted(() => ({ listSpy: vi.fn(), rosterSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  handBacksAPI: { list: (...a) => listSpy(...a) },
  assignmentAPI: { getCompetencyTechnicians: (...a) => rosterSpy(...a) },
}));

const DATA = {
  items: [
    {
      id: 1, createdAt: '2026-09-25T17:00:00Z', origin: 'ticketpulse', reasonCode: 'competency', reasonLabel: 'Competency mismatch',
      reasonNote: 'Never touched SAP', selfHandBack: true,
      ticket: { id: 501, displayRef: 'TP-1042', subject: 'SAP access', categoryName: 'ERP' },
      technician: { id: 7, name: 'Terry Tech' }, actor: { id: 7, name: 'Terry Tech' },
      next: { runId: 9, text: 'Suggested Gaby (awaiting review)' },
    },
    {
      id: 2, createdAt: '2026-09-24T17:00:00Z', origin: 'freshservice', reasonCode: 'skipped', reasonLabel: 'No reason given',
      reasonNote: null, selfHandBack: false,
      ticket: { id: 502, displayRef: '#240001', subject: 'Printer', categoryName: null },
      technician: { id: 8, name: 'Ava' }, actor: { id: 2, name: 'Cora Coordinator' }, next: null,
    },
  ],
  summary: {
    total: 2,
    byReason: [{ code: 'competency', label: 'Competency mismatch', count: 1 }, { code: 'skipped', label: 'No reason given', count: 1 }],
    byCategory: [{ name: 'ERP', count: 1 }, { name: 'Uncategorized', count: 1 }],
  },
};

const mount = (props = {}) => render(<MemoryRouter><HandBacksTab {...props} /></MemoryRouter>);

beforeEach(() => {
  listSpy.mockReset(); listSpy.mockResolvedValue({ data: DATA });
  rosterSpy.mockReset(); rosterSpy.mockResolvedValue({ data: [] });
});
afterEach(cleanup);

describe('HandBacksTab', () => {
  test('rows show ticket, category, who, reason + note, and where the AI sent it next', async () => {
    mount({ isAdmin: true });
    const rows = await screen.findAllByTestId('hand-back-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: 'TP-1042' })).toHaveAttribute('href', '/tickets/501');
    expect(first.getByText('ERP')).toBeInTheDocument();
    expect(first.getByText('Competency mismatch')).toBeInTheDocument();
    expect(first.getByText(/Never touched SAP/)).toBeInTheDocument();
    expect(first.getByText('Suggested Gaby (awaiting review)')).toBeInTheDocument();
    // competency mismatch → the skills matrix, focused on that person
    expect(first.getByRole('link', { name: 'Review skills matrix' })).toHaveAttribute('href', '/assignments/competencies?tech=7');
    expect(within(rows[1]).getByText('released by Cora Coordinator')).toBeInTheDocument();
  });

  test('summary is by reason and by category — no per-person tally', async () => {
    mount();
    await screen.findAllByTestId('hand-back-row');
    expect(screen.getByText(/By reason · 2 total/)).toBeInTheDocument();
    expect(screen.getByText('By category')).toBeInTheDocument();
    expect(screen.queryByText(/By person|By technician/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review skills matrix' })).not.toBeInTheDocument(); // non-admin
  });

  test('the reason filter re-queries', async () => {
    mount();
    await screen.findAllByTestId('hand-back-row');
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by reason' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Capacity full' }));
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'capacity' })));
  });

  test('"Handed back by" shows avatar + name: photo from the page map, initials otherwise', async () => {
    const { container } = mount({ techPhotos: { 7: { id: 7, name: 'Terry Tech', photoUrl: 'https://img.example/terry.png' } } });
    const rows = await screen.findAllByTestId('hand-back-row');
    const first = within(rows[0]).getByTestId('hand-back-person');
    expect(first).toHaveTextContent('Terry Tech');
    expect(first.querySelector('img')).toHaveAttribute('src', 'https://img.example/terry.png');
    const second = within(rows[1]).getByTestId('hand-back-person');
    expect(second.querySelector('img')).toBeNull();
    expect(second).toHaveTextContent('Ava');
    expect(container.querySelector('.rounded-full.px-2')).toBeNull(); // no pills
    expect(rosterSpy).not.toHaveBeenCalled(); // map supplied → no roster fetch
  });

  test('without a map, one roster fetch supplies the photos (never per row)', async () => {
    rosterSpy.mockResolvedValue({ data: [{ id: 8, name: 'Ava', photoUrl: 'https://img.example/ava.png' }] });
    mount();
    const rows = await screen.findAllByTestId('hand-back-row');
    await waitFor(() => expect(within(rows[1]).getByTestId('hand-back-person').querySelector('img')).toHaveAttribute('src', 'https://img.example/ava.png'));
    expect(within(rows[0]).getByTestId('hand-back-person').querySelector('img')).toBeNull();
    expect(rosterSpy).toHaveBeenCalledTimes(1);
  });
});
