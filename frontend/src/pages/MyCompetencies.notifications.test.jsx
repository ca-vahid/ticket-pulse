/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  test('loads the self-service Notifications tab beside competencies', async () => {
    render(<MyCompetencies />);

    expect(await screen.findByRole('button', { name: /My Competencies/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));

    expect(screen.getByText('Notification settings loaded for workspace 1')).toBeInTheDocument();
  });
});
