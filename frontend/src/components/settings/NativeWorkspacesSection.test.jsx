/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const refreshWorkspaces = vi.fn().mockResolvedValue([]);
const switchWorkspace = vi.fn();

vi.mock('../../services/api', () => ({
  workspaceAPI: { getAll: vi.fn(), createNative: vi.fn() },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ refreshWorkspaces, switchWorkspace }),
}));

import { workspaceAPI } from '../../services/api';
import NativeWorkspacesSection, { previewSlug } from './NativeWorkspacesSection';
import { describeAccessEvent } from './AccessHistory';

/**
 * Settings → Workspaces → Ticket Pulse workspaces (QA 11-24 #4): super admins
 * create a workspace with no FreshService link; everyone else only sees the list.
 */
describe('NativeWorkspacesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceAPI.getAll.mockResolvedValue({ data: [
      { id: 1, name: 'IT', slug: 'it', freshserviceWorkspaceId: '1000208182' },
      { id: 12, name: 'Facilities', slug: 'facilities', linkName: 'fac', freshserviceWorkspaceId: '0', defaultTimezone: 'America/Edmonton' },
    ] });
  });
  afterEach(cleanup);

  it('lists only workspaces with no FreshService link, and has no create button without the super admin role', async () => {
    render(<NativeWorkspacesSection canCreate={false} />);
    expect(await screen.findByText('Facilities')).toBeInTheDocument();
    expect(screen.queryByText('IT')).not.toBeInTheDocument();
    expect(screen.getByText('Ticket links: /fac/TP-…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New workspace/ })).not.toBeInTheDocument();
  });

  it('a super admin creates one; the picker list is refreshed', async () => {
    workspaceAPI.createNative.mockResolvedValue({ data: { id: 13, name: 'Health & Safety', slug: 'health-and-safety', linkName: 'health-and-safety' } });
    render(<NativeWorkspacesSection canCreate />);
    fireEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Health & Safety' } });
    expect(screen.getByText(/Short name: \/health-and-safety/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Internal e-mail domains/), { target: { value: 'example.com, example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Create workspace/ }));
    await waitFor(() => expect(workspaceAPI.createNative).toHaveBeenCalledWith({
      name: 'Health & Safety', defaultTimezone: 'America/Vancouver', internalDomains: ['example.com', 'example.org'],
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('“Health & Safety” is ready');
    expect(refreshWorkspaces).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(switchWorkspace).toHaveBeenCalledWith(13);
  });

  it('shows the server refusal', async () => {
    workspaceAPI.createNative.mockRejectedValue({ response: { data: { message: 'A workspace called "IT" already exists' } } });
    render(<NativeWorkspacesSection canCreate />);
    fireEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'IT' } });
    fireEvent.click(screen.getByRole('button', { name: /Create workspace/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
  });

  it('previewSlug mirrors the server rule', () => {
    expect(previewSlug('Health & Safety (West)')).toBe('health-and-safety-west');
  });

  it('Access history reads the new event', () => {
    expect(describeAccessEvent({ action: 'workspace_created', actorEmail: 'root@example.com', targetLabel: 'Facilities' }))
      .toBe('root created the workspace "Facilities"');
  });
});
