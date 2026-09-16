/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Search v2 — the requester page.

const apiMock = vi.hoisted(() => ({ ticketsAPI: { requesterProfile: vi.fn(), list: vi.fn(), requesterPhoto: vi.fn().mockResolvedValue({ data: { photo: 'data:image/png;base64,AAA' } }) } }));
vi.mock('../services/api', () => apiMock);
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, isWorkspaceSelected: true }) }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));

import RequesterDetail from './RequesterDetail';

const profile = {
  requester: {
    id: 9, name: 'Sabina Greer', email: 'sgreer@bgc.ca', phone: '1-720-647-9772', mobile: '7208137774', jobTitle: 'Office Administrator',
    entraDepartment: 'Colorado', entraOfficeLocation: 'Denver', entraCity: 'Denver', entraState: 'CO', timeZone: 'America/Denver',
    freshserviceId: '1001705014', isActive: true, createdAt: '2025-02-01T00:00:00.000Z', entraProfileSyncedAt: '2026-09-10T00:00:00.000Z',
  },
  stats: { total: 12, open: 2, resolved: 9, firstTicketAt: '2025-03-01T00:00:00.000Z', lastTicketAt: '2026-09-10T00:00:00.000Z', lastTicket: { id: 500, subject: 'Printer', status: 'Open' }, medianResolutionHours: 10, resolutionSample: 3, topCategories: [{ id: 3, name: 'Devices & Hardware', count: 5 }] },
};
const list = { items: [
  { id: 500, displayRef: '#242500', subject: 'Printer jammed', status: 'Open', priority: 2, createdAt: '2026-09-10T00:00:00.000Z', assignedTech: { name: 'Reza Zaim' } },
  { id: 400, displayRef: 'TP-400', subject: 'Laptop', status: 'Resolved', priority: 1, createdAt: '2026-08-01T00:00:00.000Z' },
], total: 12 };

const renderPage = () => render(
  <MemoryRouter initialEntries={['/requesters/9']}>
    <Routes><Route path="/requesters/:id" element={<RequesterDetail />} /><Route path="/tickets/:id" element={<div>ticket page</div>} /></Routes>
  </MemoryRouter>,
);

describe('RequesterDetail', () => {
  beforeEach(() => {
    apiMock.ticketsAPI.requesterProfile.mockReset().mockResolvedValue({ data: profile });
    apiMock.ticketsAPI.list.mockReset().mockResolvedValue({ data: list });
  });
  afterEach(() => cleanup());

  test('header, contact chips, stat tiles, categories, tickets tab with the latest tickets and a "see all" link', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sabina Greer' })).toBeInTheDocument();
    expect(screen.getByText('Office Administrator · Colorado')).toBeInTheDocument();
    expect(screen.getByTitle('Copy e-mail address')).toHaveTextContent('sgreer@bgc.ca');
    expect(screen.getByText('Denver · CO')).toBeInTheDocument();
    // directory photo by e-mail (cached per address)
    await waitFor(() => expect(apiMock.ticketsAPI.requesterPhoto).toHaveBeenCalledWith('sgreer@bgc.ca'));
    await waitFor(() => expect(document.querySelector('img[src^="data:image/png"]')).not.toBeNull());
    expect(apiMock.ticketsAPI.requesterProfile).toHaveBeenCalledWith('9');
    expect(apiMock.ticketsAPI.list).toHaveBeenCalledWith({ requesterId: '9', pageSize: 50, sort: 'createdAt', dir: 'desc' });

    const stats = screen.getByRole('region', { name: 'Service history' });
    expect(within(stats).getByText('Open').previousSibling).toHaveTextContent('2');
    expect(within(stats).getByText('Resolved').previousSibling).toHaveTextContent('9');
    expect(within(stats).getByText('Total tickets').previousSibling).toHaveTextContent('12');
    expect(within(stats).getByText('Median resolution').previousSibling).toHaveTextContent('10 hr');
    expect(screen.getByText('Devices & Hardware · 5')).toBeInTheDocument();

    const tickets = await screen.findByRole('region', { name: 'Tickets' });
    expect(within(tickets).getByText('Printer jammed')).toBeInTheDocument();
    expect(within(tickets).getByText('Reza Zaim')).toBeInTheDocument();
    expect(within(tickets).getByText(/Showing the latest 2 of 12/)).toBeInTheDocument();
    expect(within(tickets).getByRole('link', { name: /See all in the queue/ })).toHaveAttribute('href', '/tickets?requesterId=9&requesterName=Sabina%20Greer&status=any');
    fireEvent.click(within(tickets).getByText('Printer jammed'));
    expect(await screen.findByText('ticket page')).toBeInTheDocument();
  });

  test('profile tab lists the directory fields; missing requester shows a friendly card', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Sabina Greer' });
    fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    const prof = screen.getByRole('region', { name: 'Profile' });
    expect(within(prof).getByText('FreshService id').nextSibling).toHaveTextContent('1001705014');
    expect(within(prof).getByText('Time zone').nextSibling).toHaveTextContent('America/Denver');
    cleanup();
    apiMock.ticketsAPI.requesterProfile.mockRejectedValue(Object.assign(new Error('Requester not found'), { status: 404 }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Requester not found');
  });
});
