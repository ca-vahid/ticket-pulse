/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyCompetencies from './MyCompetencies';
import { agentAPI } from '../services/api';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      email: 'alex.chen@example.com',
      workspaceId: 1,
      agentProfiles: [{ workspaceId: 1, workspace: { id: 1, name: 'IT' } }],
    },
    logout: vi.fn(),
  }),
}));

vi.mock('../services/api', () => ({
  agentAPI: {
    getMyCompetencies: vi.fn(),
  },
}));

vi.mock('../components/ItSummitFeedbackPanel', () => ({
  default: () => <div>Summit feedback</div>,
}));

vi.mock('../components/ItSummitCategoriesPanel', () => ({
  default: () => <div>Summit categories</div>,
}));

vi.mock('../components/agent/NotificationSettingsPanel', () => ({
  default: ({ workspaceId }) => <div>Notification settings loaded for workspace {workspaceId}</div>,
}));

vi.mock('../components/agent/AgentAlertsPanel', () => ({
  default: ({ workspaceId }) => <div>My alerts loaded for workspace {workspaceId}</div>,
}));

describe('MyCompetencies notification tab', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agentAPI.getMyCompetencies.mockResolvedValue({
      data: {
        technician: {
          id: 17,
          workspaceId: 1,
          name: 'Alex Chen',
          email: 'alex.chen@example.com',
          workspace: { id: 1, name: 'IT' },
        },
        profiles: [{ workspaceId: 1, workspace: { id: 1, name: 'IT' } }],
        technicians: [],
        categories: [],
        categoryTree: [],
        mappings: [],
        requests: [],
      },
    });
  });

  test('Notifications tab stacks preferences + my-alerts on one page', async () => {
    render(<MyCompetencies />, { wrapper: MemoryRouter });

    expect(await screen.findByRole('button', { name: /My Competencies/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));

    // Both sections render stacked (no sub-tabs) — QA 07-20 #4.
    expect(screen.getByText('Notification settings loaded for workspace 1')).toBeInTheDocument();
    expect(screen.getByText('My alerts loaded for workspace 1')).toBeInTheDocument();
  });
});
