/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MembersPanel from './MembersPanel';

// Real render coverage for the table rebuild (QA 07-29): the panel must mount,
// resolve data, and actually run the TanStack table path — filters, search,
// sorting. Mount-time bugs (declaration order, bad column defs) only surface
// by rendering.
const MEMBERS = [
  { id: 1, name: 'Adrian Lo', email: 'alo@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice' },
  { id: 2, name: 'Bryan Baker', email: 'bbaker@bgcengineering.ca', location: 'Canada', isActive: false, origin: 'freshservice' },
  { id: 3, name: 'Syd Nezamian', email: 'snezamian@bgcengineering.ca', location: '', isActive: false, origin: 'local' },
  { id: 4, name: 'Gaby Tonnova', email: 'gtonnova@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice', routingGuidance: 'Phones go to Gaby' },
];

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getTechnicians: vi.fn(() => Promise.resolve({ data: MEMBERS })),
    searchDirectory: vi.fn(() => Promise.resolve({ data: [] })),
    updateTechnician: vi.fn(() => Promise.resolve({})),
    setTechnicianActive: vi.fn(() => Promise.resolve({})),
    createLocalAgent: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' } }),
}));

describe('MembersPanel (table rebuild)', () => {
  afterEach(() => cleanup());

  test('defaults to Active filter — disabled members hidden, counts on chips', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    // Active members visible, disabled hidden by default (the big declutter).
    expect(screen.getByText('Gaby Tonnova')).toBeInTheDocument();
    expect(screen.queryByText('Bryan Baker')).not.toBeInTheDocument();
    expect(screen.queryByText('Syd Nezamian')).not.toBeInTheDocument();
    // Chips carry live counts: Active 2, Disabled 2, Local 1, All 4.
    expect(screen.getByRole('button', { name: /Active 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disabled 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Local 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All 4/ })).toBeInTheDocument();
  });

  test('All filter shows disabled rows with a quiet pill (no red badge)', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /All 4/ }));
    expect(screen.getByText('Bryan Baker')).toBeInTheDocument();
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  test('search narrows by name/email/location', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /All 4/ }));
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'syd' } });
    expect(screen.getByText('Syd Nezamian')).toBeInTheDocument();
    expect(screen.queryByText('Adrian Lo')).not.toBeInTheDocument();
  });

  test('sorting by Member toggles without crashing', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Member/ }));
    expect(screen.getByText('Adrian Lo')).toBeInTheDocument();
  });
});
