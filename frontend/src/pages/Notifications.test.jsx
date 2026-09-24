/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Notifications from './Notifications';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'alex@example.com', role: 'agent' }, logout: vi.fn() }),
}));

vi.mock('../components/agent/NotificationSettingsPanel', () => ({
  default: () => <div>Delivery preferences panel</div>,
}));
vi.mock('../components/agent/AgentAlertsPanel', () => ({
  default: () => <div>My alerts panel</div>,
}));
vi.mock('../components/agent/SignaturePanel', () => ({
  default: () => <div>My signature panel</div>,
}));

describe('Notifications page', () => {
  afterEach(() => cleanup());

  test('is its own page — own header, both panels, no My Competencies chrome', () => {
    render(<Notifications />, { wrapper: MemoryRouter });

    // Dedicated "Notifications" heading, not "My Competencies" (QA 07-21 #3).
    expect(screen.getAllByText('Mail & alerts').length).toBeGreaterThan(0);
    expect(screen.queryByText('My Competencies')).not.toBeInTheDocument();
    // Notifications + alerts on one page (QA 07-21 #4, #5). The signature
    // moved to the Profile page (QA 09-23 #5).
    expect(screen.getByText('Delivery preferences panel')).toBeInTheDocument();
    expect(screen.getByText('My alerts panel')).toBeInTheDocument();
    expect(screen.queryByText('My signature panel')).not.toBeInTheDocument();
  });
});
