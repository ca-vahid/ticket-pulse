/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 09-22 #7: the profile page — own photo, revert, links.

const apiMock = vi.hoisted(() => ({
  settingsAPI: { myPhoto: vi.fn(), uploadMyPhoto: vi.fn(), revertMyPhoto: vi.fn() },
}));
vi.mock('../services/api', () => apiMock);
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Susan Xu', email: 'sxu@bgcengineering.ca', role: 'admin' }, logout: vi.fn() }) }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }) }));

import ProfilePage from './ProfilePage';

const ME = { id: 42, name: 'Susan Xu', email: 'sxu@bgcengineering.ca', photoUrl: 'data:image/jpeg;base64,AAAA', photoSource: 'custom' };

const renderPage = () => render(<MemoryRouter><ProfilePage /></MemoryRouter>);

describe('ProfilePage', () => {
  beforeEach(() => {
    apiMock.settingsAPI.myPhoto.mockReset().mockResolvedValue({ data: ME });
    apiMock.settingsAPI.uploadMyPhoto.mockReset();
    apiMock.settingsAPI.revertMyPhoto.mockReset().mockResolvedValue({ data: { ...ME, photoUrl: null, photoSource: null } });
  });
  afterEach(() => cleanup());

  test('shows the person, the photo source, the change/revert actions and the settings links', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 2, name: 'Susan Xu' })).toBeInTheDocument();
    expect(screen.getByText(/Photo: uploaded here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change photo/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Mail & alerts/ })).toHaveAttribute('href', '/notifications');
    expect(screen.getByRole('link', { name: /My Skills/ })).toHaveAttribute('href', '/my-competencies');

    fireEvent.click(screen.getByRole('button', { name: /Use the directory photo/ }));
    await waitFor(() => expect(apiMock.settingsAPI.revertMyPhoto).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent('Back to the directory photo.');
    expect(screen.getByText(/Photo: none yet/)).toBeInTheDocument();
  });

  test('opens the upload dialog; an account without an agent profile gets a plain explanation', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Change photo/ }));
    expect(screen.getByRole('dialog', { name: 'Your profile photo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a photo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save photo' })).toBeDisabled(); // nothing chosen yet
    cleanup();

    apiMock.settingsAPI.myPhoto.mockRejectedValue(Object.assign(new Error('No technician profile'), { status: 404 }));
    renderPage();
    expect(await screen.findByRole('note')).toHaveTextContent('no agent profile in IT');
    expect(screen.queryByRole('button', { name: /Add a photo/ })).toBeNull();
  });
});
