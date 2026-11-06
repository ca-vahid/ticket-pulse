/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssignmentConfigPanel } from './AssignmentReview';
import { assignmentAPI } from '../services/api';

// Phase DB: "Collapse duplicate bursts" toggle in Assignment Behavior.
//  - renders ON by default (missing field = enabled, back-compat);
//  - reflects a stored false;
//  - toggling + Save round-trips duplicateBurstEnabled through updateConfig.

vi.mock('../services/api', () => ({
  assignmentAPI: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    emailStatus: vi.fn(),
    getGroups: vi.fn(),
    getWebhookConfig: vi.fn(),
    updateWebhookConfig: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    testWebhookConfig: vi.fn(),
    emailTest: vi.fn(),
    emailPollNow: vi.fn(),
  },
  aiProviderAPI: {},
  workspaceAPI: {},
}));

vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin' } }),
}));

vi.mock('../components/AppShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/assignment/PipelineRunDetail', () => ({ default: () => null }));
vi.mock('../components/assignment/CompetencyManager', () => ({ default: () => null }));
vi.mock('../components/assignment/CompetencyRequestsTab', () => ({ default: () => null }));
vi.mock('../components/assignment/DailyReviewManager', () => ({ default: () => null }));
vi.mock('../components/assignment/PromptManager', () => ({ default: () => null }));
vi.mock('../components/assignment/LivePipelineView', () => ({ default: () => null }));
vi.mock('../components/FilterDropdown', () => ({ default: () => null }));
vi.mock('../components/FilterBar', () => ({ default: () => null }));
vi.mock('../hooks/useFilterUrlSync', () => ({ default: () => {} }));

const BASE_CONFIG = {
  isEnabled: true,
  autoAssign: false,
  autoCloseNoise: false,
  dryRunMode: true,
  llmModel: 'claude-sonnet-5',
  maxRecommendations: 3,
  pollForUnassigned: true,
  pollMaxPerCycle: 5,
  excludedGroupIds: [],
  observeOnlyGroupIds: [],
};

function findToggleButton() {
  // QA 11-05 #1: ConfigToggle is the shared switch, labelled by its <label>.
  return screen.getByRole('switch', { name: 'Collapse duplicate bursts' });
}

describe('AssignmentConfigPanel — Collapse duplicate bursts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getConfig.mockResolvedValue({ data: { ...BASE_CONFIG } });
    assignmentAPI.emailStatus.mockResolvedValue({ data: null });
    assignmentAPI.getGroups.mockResolvedValue({ data: [] });
    assignmentAPI.getWebhookConfig.mockResolvedValue({ data: null });
    assignmentAPI.updateConfig.mockImplementation(async (cfg) => ({ data: cfg }));
  });

  afterEach(() => {
    cleanup();
  });

  test('renders in Assignment Behavior, defaulting ON when the field is missing', async () => {
    render(<AssignmentConfigPanel />);

    expect(await screen.findByText('Collapse duplicate bursts')).toBeInTheDocument();
    expect(screen.getByText(/identical subject within 15 minutes/i)).toBeInTheDocument();
    // Missing field = enabled (back-compat).
    expect(findToggleButton()).toHaveAttribute('aria-checked', 'true');
  });

  test('reflects a stored false as OFF', async () => {
    assignmentAPI.getConfig.mockResolvedValue({ data: { ...BASE_CONFIG, duplicateBurstEnabled: false } });
    render(<AssignmentConfigPanel />);

    await screen.findByText('Collapse duplicate bursts');
    expect(findToggleButton()).toHaveAttribute('aria-checked', 'false');
  });

  test('toggling off and saving sends duplicateBurstEnabled:false', async () => {
    render(<AssignmentConfigPanel />);
    await screen.findByText('Collapse duplicate bursts');

    fireEvent.click(findToggleButton());
    fireEvent.click(screen.getByText('Save Configuration'));

    await waitFor(() => expect(assignmentAPI.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ duplicateBurstEnabled: false }),
    ));
  });
});
