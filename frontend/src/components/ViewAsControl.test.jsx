/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// View as (QA 10-08 #2): the picker sends a role for the current workspace or a
// person; the bar is on every page while a view is active and takes you back.

const auth = vi.hoisted(() => ({ user: { email: 'vahid@bgc.ca', name: 'Vahid Haeri', role: 'admin' } }));
const api = vi.hoisted(() => ({
  authAPI: {
    viewAs: vi.fn(async () => ({ success: true, authToken: 'tok-view' })),
    exitViewAs: vi.fn(async () => ({ success: true, authToken: 'tok-me' })),
  },
  workspaceAPI: {
    getMembers: vi.fn(async () => ({ data: [
      { email: 'vahid@bgc.ca', name: 'Vahid Haeri', accessRole: 'admin', isSuperAdmin: true },
      { email: 'sxu@bgc.ca', name: 'Susan Xu', accessRole: 'reviewer', isSuperAdmin: true },
      { email: 'alo@bgc.ca', name: 'Adrian Lo', accessRole: null },
    ] })),
  },
  setAuthToken: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }) }));
vi.mock('../services/api', () => api);

const { default: ViewAsBanner, ViewAsDialog } = await import('./ViewAsControl');

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { email: 'vahid@bgc.ca', name: 'Vahid Haeri', role: 'admin' };
  Object.defineProperty(window, 'location', { configurable: true, value: { assign } });
});
afterEach(() => cleanup());

describe('the picker', () => {
  test('a role: sends the role with the current workspace, stores the new token and restarts the app', async () => {
    render(<ViewAsDialog open onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'A role in IT' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText(/Read-only/));
    fireEvent.click(screen.getByRole('button', { name: /Start viewing/ }));
    await waitFor(() => expect(api.authAPI.viewAs).toHaveBeenCalledWith({ mode: 'role', role: 'readonly', workspaceId: 1 }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(api.setAuthToken).toHaveBeenCalledWith('tok-view');
  });

  test('a person: the list leaves you out, says who is a super admin, and Start waits for a choice', async () => {
    render(<ViewAsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'A person' }));
    const list = await screen.findByRole('list', { name: 'People' });
    await within(list).findByText('Susan Xu');
    expect(within(list).queryByText('Vahid Haeri')).not.toBeInTheDocument();
    expect(within(list).getByText('Super admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start viewing/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'adrian' } });
    fireEvent.click(within(list).getByText('Adrian Lo'));
    fireEvent.click(screen.getByRole('button', { name: /Start viewing/ }));
    await waitFor(() => expect(api.authAPI.viewAs).toHaveBeenCalledWith({ mode: 'person', email: 'alo@bgc.ca', name: 'Adrian Lo' }));
  });

  test('a refusal from the server is shown and the dialog stays', async () => {
    api.authAPI.viewAs.mockRejectedValueOnce({ response: { data: { message: 'You have no technician profile in IT' } } });
    render(<ViewAsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Agent/));
    fireEvent.click(screen.getByRole('button', { name: /Start viewing/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no technician profile');
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the bar', () => {
  test('nothing is shown when you are yourself', () => {
    const { container } = render(<ViewAsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  test('a role view says you stay yourself; a person view says read-only; the button takes you back', async () => {
    auth.user = { email: 'vahid@bgc.ca', role: 'viewer', viewAs: { mode: 'role', label: 'Reviewer in IT', byName: 'Vahid Haeri' } };
    const { rerender } = render(<ViewAsBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('Viewing as Reviewer in IT · what you do is recorded as you');
    auth.user = { email: 'sxu@bgc.ca', role: 'viewer', viewAs: { mode: 'person', label: 'Susan Xu', byName: 'Vahid Haeri' } };
    rerender(<ViewAsBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('Viewing as Susan Xu · read-only, nothing can be changed');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Vahid Haeri' }));
    await waitFor(() => expect(api.authAPI.exitViewAs).toHaveBeenCalled());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(api.setAuthToken).toHaveBeenCalledWith('tok-me');
  });
});
