/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// QA 11-05: #4 Close goes back to the filtered list you came from, #7 the
// creation date leads the header and the number is quieter, #8 "Also for"
// sits in the requester's name row.

const NOW = Date.now();
const BASE = {
  id: 501,
  subject: 'Docking station drops the second monitor',
  description: '<p>Screen goes black</p>',
  descriptionText: 'Screen goes black',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-10-20T16:14:00Z',
  updatedAt: '2026-10-22T20:05:00Z',
  lastActivityAt: '2026-10-22T20:05:00Z',
  requesterId: 40,
  requester: { id: 40, name: 'Alex Rivera', email: 'alex@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  toEmails: [],
  ccEmails: ['sam@example.com', 'jo@example.com'],
  replyCcEmails: [],
  fwdEmails: [],
  tags: [],
  activities: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  thread: [],
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  nativeNumber: 10320,
  displayRef: 'TP-10320',
};
const META = {
  nativeTicketingEnabled: true, technicians: [], categoryTree: [], categoryGroupLinks: [], groups: [], tags: [],
  approvalCategories: [], statuses: [],
  actor: { kind: 'admin', email: 'qa@example.com', workspaceRole: 'admin', technicianId: null },
};

const pending = () => new Promise(() => {});
const apiOverrides = {};
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 1, currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({ useWorkspaceRole: () => 'admin', NAV_DESTINATIONS: [] }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../components/AppHeader', () => ({ default: () => null }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/ThreadSummaryCard', () => ({ default: () => null }));
vi.mock('../components/tickets/ProposedReplyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFamilyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTasksTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTagEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketOpsCards', () => ({ CustomFieldsCard: () => null, MacroMenu: () => null, TicketLinksCard: () => null }));
vi.mock('../components/tickets/AssigneePicker', () => ({ default: () => null }));
vi.mock('../components/tickets/DueDateEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({
  default: ({ value, onChange }) => (
    <div data-testid="cc-chips">
      {value.join(',')}
      <button type="button" onClick={() => onChange([...value, 'new@example.com'])}>add-person</button>
    </div>
  ),
}));
vi.mock('../components/tickets/RichTextEditor', () => ({ default: () => null, isRichContent: () => false, htmlToPlainText: (s) => s }));

import TicketDetail from './TicketDetail';
import { rememberTicketList } from '../utils/lastTicketList';
import { formatPacificWhen } from '../utils/ticketDates';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="tickets-list" data-search={loc.search}>{loc.state?.toast?.message || ''}</div>;
}
async function renderAt(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
        <Route path="/tickets" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('region', { name: 'Ticket description' });
}
const FROM = { pathname: '/tickets/501', state: { from: '/tickets?assignee=59&status=Open&due=overdue' } };

async function closeTicket() {
  fireEvent.click(screen.getByTestId('header-close'));
  const dialog = await screen.findByRole('dialog', { name: 'Close TP-10320?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
  return screen.findByTestId('tickets-list');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  apiOverrides.get = vi.fn((id) => Promise.resolve({ data: { ...BASE, id: Number(id) } }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: META }));
  apiOverrides.setStatus = vi.fn(() => Promise.resolve({ data: {} }));
  apiOverrides.update = vi.fn(() => Promise.resolve({ data: {} }));
  apiOverrides.requesterPhoto = vi.fn(() => Promise.resolve({ data: { photo: null } }));
});
afterEach(() => cleanup());

describe('QA 11-05 #4: back to the filtered list after Close', () => {
  test('opened from a filtered list, a tab switch keeps the return address, Close goes back with the filters', async () => {
    await renderAt(FROM);
    fireEvent.click(screen.getByRole('tab', { name: /Related/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Related/ })).toHaveAttribute('aria-selected', 'true'));
    const list = await closeTicket();
    expect(list.getAttribute('data-search')).toBe('?assignee=59&status=Open&due=overdue');
    expect(list).toHaveTextContent('TP-10320 closed');
  });

  test('no router state (reload, link, new tab): the list this tab last showed is used', async () => {
    rememberTicketList(1, '/tickets?assignee=59&status=Open&peek=777');
    await renderAt('/tickets/501');
    const list = await closeTicket();
    // The list's side preview is not part of the return address.
    expect(list.getAttribute('data-search')).toBe('?assignee=59&status=Open');
  });

  test('opened from a plain link with nothing remembered: the bare queue', async () => {
    await renderAt('/tickets/501');
    const list = await closeTicket();
    expect(list.getAttribute('data-search')).toBe('');
  });

  test('another workspace’s remembered list is never used', async () => {
    rememberTicketList(2, '/tickets?status=Pending');
    await renderAt('/tickets/501');
    const list = await closeTicket();
    expect(list.getAttribute('data-search')).toBe('');
  });

  test('the next-ticket arrow carries the return address along', async () => {
    sessionStorage.setItem('tp_ticket_nav', JSON.stringify([501, 502]));
    await renderAt(FROM);
    fireEvent.click(screen.getByRole('button', { name: 'Next ticket in queue' }));
    await waitFor(() => expect(apiOverrides.get).toHaveBeenCalledWith(502, expect.anything()));
    await screen.findByRole('region', { name: 'Ticket description' });
    const list = await closeTicket();
    expect(list.getAttribute('data-search')).toBe('?assignee=59&status=Open&due=overdue');
  });
});

describe('QA 11-05 #7: the creation date leads, the number is quieter', () => {
  test('the full opened date in Pacific time, with its age', async () => {
    await renderAt(FROM);
    const created = screen.getByTestId('ticket-created');
    expect(created).toHaveTextContent(formatPacificWhen('2026-10-20T16:14:00Z'));
    expect(formatPacificWhen('2026-10-20T16:14:00Z', new Date('2026-11-05T12:00:00Z'))).toBe('Tue 20 Oct, 9:14 AM');
    expect(created.getAttribute('title')).toMatch(/2026/);
    expect(screen.getByTestId('ticket-dates')).toHaveTextContent(/days ago/);
  });

  test('last activity shows once — a date, not "date · date"', async () => {
    await renderAt(FROM);
    const last = screen.getByTestId('ticket-last-activity');
    expect(last).toHaveTextContent(formatPacificWhen('2026-10-22T20:05:00Z'));
    expect(screen.getByTestId('ticket-dates').textContent).not.toMatch(/Oct 22.*·.*Oct 22/);
    expect(last.textContent).not.toContain('·');
  });

  test('a recent last activity reads as relative time only', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...BASE, lastActivityAt: new Date(NOW - 2 * 3600 * 1000).toISOString() } }));
    await renderAt(FROM);
    expect(screen.getByTestId('ticket-last-activity')).toHaveTextContent(/^2 h ago$/);
  });

  test('the number still copies on click and on Enter', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAt(FROM);
    const ref = screen.getByTestId('ticket-ref');
    expect(ref).toHaveAttribute('title', 'TP-10320 — click to copy');
    expect(ref.className).toContain('text-muted-foreground');
    expect(ref.className).not.toMatch(/text-muted-foreground\/\d/);
    fireEvent.click(ref);
    expect(writeText).toHaveBeenLastCalledWith('TP-10320');
    writeText.mockClear();
    fireEvent.keyDown(ref, { key: 'Enter' });
    expect(writeText).toHaveBeenLastCalledWith('TP-10320');
  });
});

describe('QA 11-05 review: the action row wraps cleanly', () => {
  test('the divider and More wrap as one group; Mark as solution leaves the row below xl and sits under More', async () => {
    await renderAt(FROM);
    const more = screen.getByTestId('more-actions');
    const group = more.parentElement.parentElement;
    expect(group.querySelector('[aria-hidden="true"].w-px')).not.toBeNull();
    expect(group.className).toContain('inline-flex');
    const rowSolution = within(screen.getByTestId('ticket-actions')).getAllByRole('button', { name: 'Mark as solution' })[0];
    expect(rowSolution.className).toContain('hidden xl:inline-flex');
    fireEvent.click(more);
    const phoneSection = screen.getByTestId('more-actions-phone');
    expect(phoneSection.className).toContain('xl:hidden');
    expect(within(phoneSection).getByRole('menuitem', { name: 'Mark as solution' }).className).not.toContain('sm:hidden');
    expect(within(phoneSection).getByRole('menuitem', { name: /Mark as noise/ }).className).toContain('sm:hidden');
  });
});

describe('QA 11-05 #8: "Also for" in the requester name row', () => {
  test('the button sits in the name row with its count; there is no separate row', async () => {
    await renderAt(FROM);
    const panel = screen.getByTestId('requester-panel');
    const button = within(panel).getByTestId('also-for-button');
    expect(button).toHaveAccessibleName('Also for: 2 people');
    expect(within(button).getByTestId('also-for-count')).toHaveTextContent('2');
    // Same row as the name and the phone chevron, before the contact list.
    const nameRow = within(panel).getByTestId('requester-toggle').parentElement;
    expect(nameRow.contains(button)).toBe(true);
    const contact = within(panel).getByRole('list', { name: 'Requester contact' });
    expect(contact.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // Visible on phones even while the contact lines are folded.
    expect(screen.getByTestId('also-for-card').className).not.toContain('max-sm:hidden');
  });

  test('a long requester name keeps its full text in a tooltip; the panel aligns to the top', async () => {
    const long = 'Alexandra Montgomery-Riveraweather';
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...BASE, requester: { ...BASE.requester, name: long } } }));
    await renderAt(FROM);
    expect(screen.getByTestId('requester-name')).toHaveAttribute('title', long);
    const panel = screen.getByTestId('requester-panel');
    expect(panel.className).toContain('lg:self-start');
    expect(panel.className).not.toContain('lg:self-center');
  });

  test('with nobody, still a focusable button that says so', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...BASE, ccEmails: [] } }));
    await renderAt(FROM);
    const button = screen.getByTestId('also-for-button');
    expect(button).toHaveAccessibleName('Also for: nobody else yet');
    expect(button).toHaveAttribute('title', 'Also for: nobody else yet');
    expect(screen.queryByTestId('also-for-count')).not.toBeInTheDocument();
  });

  test('the popover opens, saves, and Escape closes it with focus back on the button', async () => {
    await renderAt(FROM);
    const button = screen.getByTestId('also-for-button');
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Also for — additional requesters' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'add-person' }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledWith(501, expect.objectContaining({ ccEmails: ['sam@example.com', 'jo@example.com', 'new@example.com'] })));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Also for — additional requesters' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
