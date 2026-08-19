/** @vitest-environment jsdom */
// QA 08-17 #7 — Approval Categories must be fully usable by workspace
// REVIEWERS: the panel now sources member data from the reviewer-reachable
// GET /tickets/meta, a directory 403 shows an amber informational notice with
// a locked-but-usable picker (red banner = real errors only), and a
// fully-typed email can always be added via the free-text row.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getApprovalCategories: vi.fn(),
  searchDirectory: vi.fn(),
  meta: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getApprovalCategories: mocks.getApprovalCategories,
    searchDirectory: mocks.searchDirectory,
    createApprovalCategory: vi.fn(),
    updateApprovalCategory: vi.fn(),
    deleteApprovalCategory: vi.fn(),
  },
  ticketsAPI: { meta: mocks.meta },
}));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));

const { default: ApprovalCategoriesPanel } = await import('./ApprovalCategoriesPanel');

// The REAL api layer's errorInterceptor rethrows an enhanced Error with
// `.status` (never `.response`) — mock that exact shape so the panel's 403
// detection is tested against what production callers actually receive.
const forbidden = () => Object.assign(new Error('Admin access required'), { status: 403 });

const CATEGORIES = [
  { id: 1, name: 'Laptop purchase', description: 'Hardware sign-off', managerEmails: ['alice@x.io'], isActive: true },
];
const META = {
  data: {
    technicians: [
      { id: 7, name: 'Alice Approver', email: 'alice@x.io', photoUrl: null, origin: 'freshservice' },
      { id: 8, name: 'Bob Builder', email: 'bob@x.io', photoUrl: null, origin: 'local' },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApprovalCategories.mockResolvedValue({ data: CATEGORIES });
  mocks.meta.mockResolvedValue(META);
  mocks.searchDirectory.mockRejectedValue(forbidden()); // reviewer: directory locked
});

afterEach(() => cleanup());

describe('ApprovalCategoriesPanel as a reviewer (directory 403)', () => {
  test('categories render from reviewer-reachable sources — NO red banner, amber notice instead', async () => {
    render(<ApprovalCategoriesPanel />);

    expect(await screen.findByText('Laptop purchase')).toBeInTheDocument();
    // Member enrichment came from /tickets/meta, not admin-only /settings/technicians.
    expect(mocks.meta).toHaveBeenCalled();
    expect(await screen.findByText('Alice Approver')).toBeInTheDocument();

    // The directory 403 is informational (amber), never the red error banner.
    expect(await screen.findByText(/Directory search needs admin access/)).toBeInTheDocument();
    expect(screen.queryByText(/Admin access required/)).not.toBeInTheDocument();
    expect(document.querySelector('.bg-red-50')).toBeNull();
    expect(document.querySelector('.bg-amber-50')).not.toBeNull();
  });

  test('picker is greyed with a lock but stays usable: member search + free-text email add', async () => {
    render(<ApprovalCategoriesPanel />);
    await screen.findByText('Laptop purchase');

    fireEvent.click(screen.getByRole('button', { name: /New approval category/ }));
    const picker = await screen.findByPlaceholderText(/type an email address/);

    // Lock affordance with an explanatory popover.
    const lockBtn = screen.getByRole('button', { name: /Directory search unavailable/ });
    fireEvent.click(lockBtn);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/needs admin access/);

    // Member search still works while locked…
    fireEvent.change(picker, { target: { value: 'bob' } });
    fireEvent.click(await screen.findByText('Bob Builder'));
    expect(screen.getByRole('button', { name: 'Remove bob@x.io' })).toBeInTheDocument();

    // …and a fully-typed address gets the free-text "Use this email" row.
    fireEvent.change(picker, { target: { value: 'Outside.Manager@partner.io' } });
    fireEvent.click(await screen.findByText('Use this email address'));
    expect(screen.getByRole('button', { name: 'Remove outside.manager@partner.io' })).toBeInTheDocument();

    // No directory request was fired while locked (beyond the initial probe).
    const searchCalls = mocks.searchDirectory.mock.calls.filter(([q]) => (q || '').length >= 2);
    expect(searchCalls).toHaveLength(0);
  });

  test('a member-lookup failure never blanks the category list (split Promise.all)', async () => {
    mocks.meta.mockRejectedValue(forbidden());
    render(<ApprovalCategoriesPanel />);

    expect(await screen.findByText('Laptop purchase')).toBeInTheDocument();
    // Chips fall back to the raw email; still no red banner.
    const chip = await screen.findByText('alice@x.io');
    expect(chip).toBeInTheDocument();
    expect(document.querySelector('.bg-red-50')).toBeNull();
  });

  test('a real category-load failure still shows the red error banner', async () => {
    mocks.getApprovalCategories.mockRejectedValue(
      Object.assign(new Error('Database unavailable'), { status: 500 }),
    );
    render(<ApprovalCategoriesPanel />);
    const banner = await screen.findByText('Database unavailable');
    expect(banner.closest('div')).toHaveClass('bg-red-50');
  });
});

describe('ApprovalCategoriesPanel as an admin (directory available)', () => {
  test('no amber notice, no lock; directory search fires and lists results', async () => {
    mocks.searchDirectory.mockResolvedValue({
      data: [{ name: 'Dana Director', mail: 'dana@x.io', displayName: 'Dana Director', photoUrl: null }],
    });
    render(<ApprovalCategoriesPanel />);
    await screen.findByText('Laptop purchase');

    expect(screen.queryByText(/Directory search needs admin access/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Directory search unavailable/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New approval category/ }));
    const picker = screen.getByPlaceholderText(/search members or the directory/);
    fireEvent.change(picker, { target: { value: 'dana' } });
    await waitFor(() => expect(screen.getByText('Dana Director')).toBeInTheDocument(), { timeout: 2000 });
    const directoryHeading = screen.getByText('Directory');
    expect(directoryHeading).toBeInTheDocument();
    fireEvent.click(within(directoryHeading.parentElement).getByText('Dana Director'));
    expect(screen.getByRole('button', { name: 'Remove dana@x.io' })).toBeInTheDocument();
  });
});
