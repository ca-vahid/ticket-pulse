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

describe('Notifications page', () => {
  afterEach(() => cleanup());

  test('is its own page — own header, both panels, no My Competencies chrome', () => {
    render(<Notifications />, { wrapper: MemoryRouter });

    // Dedicated "Notifications" heading, not "My Competencies" (QA 07-21 #3).
    expect(screen.getAllByText('Notifications').length).toBeGreaterThan(0);
    expect(screen.queryByText('My Competencies')).not.toBeInTheDocument();
    // Both sections stacked on one page (QA 07-21 #4, #5).
    expect(screen.getByText('Delivery preferences panel')).toBeInTheDocument();
    expect(screen.getByText('My alerts panel')).toBeInTheDocument();
  });
});
