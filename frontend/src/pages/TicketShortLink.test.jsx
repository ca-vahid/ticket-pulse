/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { looksLikeTicketRef, ticketShortLink, RESERVED_FIRST_SEGMENTS } from '../utils/ticketShortLink';

const resolveTicket = vi.fn();
const switchWorkspace = vi.fn();
vi.mock('../services/api', () => ({ workspaceAPI: { resolveTicket: (...a) => resolveTicket(...a) } }));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' }, switchWorkspace }),
}));

const { default: TicketShortLink } = await import('./TicketShortLink');

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tickets/:id" element={<div>ticket page</div>} />
        <Route path="/tickets" element={<div>ticket list</div>} />
        <Route path="/:ref" element={<TicketShortLink />} />
        <Route path="/:wsSlug/:ref" element={<TicketShortLink />} />
      </Routes>
    </MemoryRouter>,
  );
}

const match = (over = {}) => ({ ticketId: 62936, workspaceId: 1, workspaceName: 'IT', workspaceSlug: 'it', ref: 'TP-1876', matchedAs: 'tp', subject: 'FW: Shared Voicemail', status: 'Open', ...over });

beforeEach(() => { resolveTicket.mockReset(); switchWorkspace.mockReset(); });
afterEach(cleanup);

describe('ticket references in a URL', () => {
  it('reads TP numbers and plain numbers, nothing else', () => {
    for (const ok of ['TP-1876', 'tp1876', '1876', '246762', 'TP-10000', 'TP%201876']) expect(looksLikeTicketRef(ok)).toBe(true);
    for (const no of ['dashboard', 'TP-', '0', 'sw.js', 'it', '', undefined]) expect(looksLikeTicketRef(no)).toBe(false);
  });

  it('builds the short link from the workspace slug and the ticket reference', () => {
    expect(ticketShortLink({ slug: 'it' }, { displayRef: 'TP-1876' }, 'https://tp.example')).toBe('https://tp.example/it/TP-1876');
    expect(ticketShortLink({ slug: 'it' }, { displayRef: '#246762' }, 'https://tp.example')).toBe('https://tp.example/it/246762');
    expect(ticketShortLink({ slug: '' }, { displayRef: 'TP-1' }, 'https://tp.example')).toBeNull();
    expect(ticketShortLink({ slug: 'it' }, {}, 'https://tp.example')).toBeNull();
  });

  it('page names are never read as a workspace', () => {
    for (const page of ['tickets', 'settings', 'dashboard', 'approvals']) expect(RESERVED_FIRST_SEGMENTS.has(page)).toBe(true);
    expect(RESERVED_FIRST_SEGMENTS.has('it')).toBe(false);
  });
});

describe('TicketShortLink page', () => {
  it('one match in the current workspace opens the ticket', async () => {
    resolveTicket.mockResolvedValue({ data: { matches: [match()] } });
    renderAt('/it/1876');
    expect(await screen.findByText('ticket page')).toBeInTheDocument();
    expect(resolveTicket).toHaveBeenCalledWith('1876', 'it');
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it('a match in another workspace switches there and lands on the ticket', async () => {
    resolveTicket.mockResolvedValue({ data: { matches: [match({ ticketId: 7, workspaceId: 2, workspaceName: 'Accounting Team' })] } });
    renderAt('/TP-1876');
    await waitFor(() => expect(switchWorkspace).toHaveBeenCalledWith(2, { landOn: '/tickets/7' }));
    expect(resolveTicket).toHaveBeenCalledWith('TP-1876', null);
  });

  it('a bare number that is both kinds asks which one', async () => {
    resolveTicket.mockResolvedValue({ data: { matches: [
      match({ ticketId: 70000, ref: 'TP-80000' }),
      match({ ticketId: 9, ref: '#80000', matchedAs: 'freshservice', subject: 'old printer', status: 'Closed' }),
    ] } });
    renderAt('/80000');
    expect(await screen.findByText(/matches more than one ticket/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/old printer/));
    expect(await screen.findByText('ticket page')).toBeInTheDocument();
  });

  it('no match says so and offers a search', async () => {
    resolveTicket.mockResolvedValue({ data: { matches: [] } });
    renderAt('/it/TP-99999');
    expect(await screen.findByText('No ticket TP-99999 that you can open')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Search tickets'));
    expect(await screen.findByText('ticket list')).toBeInTheDocument();
  });

  it('an unknown workspace is named', async () => {
    resolveTicket.mockResolvedValue({ data: { matches: [], unknownWorkspace: true } });
    renderAt('/hr/1876');
    expect(await screen.findByText(/no workspace "hr" that you can open/)).toBeInTheDocument();
  });

  it('a failed lookup can be retried', async () => {
    resolveTicket.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ data: { matches: [match()] } });
    renderAt('/it/1876');
    fireEvent.click(await screen.findByText('Try again'));
    expect(await screen.findByText('ticket page')).toBeInTheDocument();
  });
});
