/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AiProviderSettingsPanel } from './AssignmentReview';
import { aiProviderAPI } from '../services/api';

vi.mock('../services/api', () => ({
  aiProviderAPI: {
    getModels: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getHealth: vi.fn(),
    testProvider: vi.fn(),
  },
  assignmentAPI: {},
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

describe('AiProviderSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiProviderAPI.getModels.mockResolvedValue({
      data: {
        models: [
          { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', operations: ['assignment_pipeline'] },
          { provider: 'anthropic', model: 'claude-opus-4-7', label: 'Claude Opus 4.7 (Expensive)', operations: ['assignment_pipeline'] },
          { provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5', operations: ['assignment_pipeline'] },
        ],
      },
    });
    aiProviderAPI.getSettings.mockResolvedValue({
      data: [{
        operation: 'assignment_pipeline',
        primaryProvider: 'anthropic',
        primaryModel: 'claude-sonnet-4-6',
        fallbackProvider: 'openai',
        fallbackModel: 'gpt-5.5',
        autoFallbackEnabled: true,
      }],
    });
    aiProviderAPI.getHealth.mockResolvedValue({
      data: {
        anthropic: { status: 'healthy' },
        openai: { status: 'unknown' },
      },
    });
    aiProviderAPI.updateSettings.mockResolvedValue({
      data: [{
        operation: 'assignment_pipeline',
        primaryProvider: 'openai',
        primaryModel: 'gpt-5.5',
        fallbackProvider: 'anthropic',
        fallbackModel: 'claude-sonnet-4-6',
        autoFallbackEnabled: true,
      }],
    });
  });

  afterEach(() => {
    cleanup();
  });

  test('loads provider settings and saves provider/model changes', async () => {
    const onAssignmentModelChange = vi.fn();
    render(<AiProviderSettingsPanel onAssignmentModelChange={onAssignmentModelChange} />);

    expect(await screen.findByText('Operation')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4.7 (Expensive)')).toBeInTheDocument();
    expect(screen.getAllByText('healthy')[0]).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('OpenAI')[0]);
    fireEvent.click(screen.getByText('Save Provider'));

    await waitFor(() => expect(aiProviderAPI.updateSettings).toHaveBeenCalledWith([
      expect.objectContaining({
        operation: 'assignment_pipeline',
        primaryProvider: 'openai',
        primaryModel: 'gpt-5.5',
      }),
    ]));
    expect(onAssignmentModelChange).toHaveBeenCalledWith('gpt-5.5');
  });
});
