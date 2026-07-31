/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BackupRestorePanel from './BackupRestorePanel';
import { backupAPI } from '../../services/api';

// Real render coverage for the Backup & Restore surface: list → chips,
// empty state, and the restore wizard's manifest-driven module list plus the
// server dry-run diff. All network via mocked backupAPI (the axios
// interceptor returns response.data, so mocks resolve bodies directly).

const SNAPSHOTS = [
  {
    id: 'snap-1',
    scope: 'workspace',
    workspaceId: 1,
    tier: 'config',
    status: 'completed',
    trigger: 'manual',
    sizeBytes: 34816,
    manifest: {
      counts: { workflows: 5, noiseRules: 2, slaPolicies: 4, tickets: 120 },
      modules: { tickets: { restorable: false } },
      workspaceName: 'IT',
      appVersion: '3.0.76',
      createdAt: '2026-07-30T06:00:00Z',
    },
    createdByEmail: 'jhesaraki@bgcengineering.ca',
    createdAt: '2026-07-30T06:00:00Z',
    completedAt: '2026-07-30T06:00:12Z',
    error: null,
  },
  {
    id: 'snap-2',
    scope: 'site',
    workspaceId: null,
    tier: 'config_data',
    status: 'completed',
    trigger: 'scheduled',
    sizeBytes: 1048576,
    manifest: {
      counts: { 'ws1:workflows': 5, 'ws2:workflows': 3, 'ws2:macros': 7 },
      appVersion: '3.0.76',
      createdAt: '2026-07-29T06:00:00Z',
    },
    createdByEmail: null,
    createdAt: '2026-07-29T06:00:00Z',
    completedAt: '2026-07-29T06:01:00Z',
    error: null,
  },
];

const DRY_RUN = {
  modules: [
    {
      module: 'workflows',
      counts: { create: 2, update: 1, skip: 3, conflict: 1 },
      items: [
        { key: 'wf:after-hours-alert', action: 'create' },
        { key: 'wf:sla-breach-ladder', action: 'update' },
        { key: 'wf:noise-digest', action: 'conflict' },
      ],
    },
    { module: 'noiseRules', counts: { create: 0, update: 0, skip: 2, conflict: 0 }, items: [] },
  ],
};

vi.mock('../../services/api', () => ({
  backupAPI: {
    list: vi.fn(() => Promise.resolve({ data: [] })),
    create: vi.fn(() => Promise.resolve({ data: {} })),
    remove: vi.fn(() => Promise.resolve({})),
    dryRun: vi.fn(() => Promise.resolve({ data: { modules: [] } })),
    restore: vi.fn(() => Promise.resolve({ data: {} })),
    download: vi.fn(() => Promise.resolve()),
    downloadUrl: vi.fn((id) => `http://localhost:3000/api/backup/snapshots/${id}/download`),
    getSchedules: vi.fn(() => Promise.resolve({ data: [] })),
    saveSchedule: vi.fn(() => Promise.resolve({})),
    deleteSchedule: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    availableWorkspaces: [
      { id: 1, name: 'IT', role: 'admin' },
      { id: 2, name: 'Accounting', role: 'admin' },
    ],
  }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin', email: 'jhesaraki@bgcengineering.ca' } }),
}));

describe('BackupRestorePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupAPI.list.mockResolvedValue({ data: SNAPSHOTS });
    backupAPI.getSchedules.mockResolvedValue({ data: [] });
    backupAPI.dryRun.mockResolvedValue({ data: DRY_RUN });
  });
  afterEach(() => cleanup());

  test('renders snapshot rows with scope and tier chips', async () => {
    render(<BackupRestorePanel />);
    await waitFor(() => expect(screen.getByText('jhesaraki@bgcengineering.ca')).toBeInTheDocument());
    // Workspace snapshot: blue workspace-name chip + Config tier.
    expect(screen.getAllByText('IT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Config').length).toBeGreaterThan(0);
    // Site snapshot: violet Site chip + Config + data tier, credited to the scheduler.
    expect(screen.getAllByText('Site').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Config + data').length).toBeGreaterThan(0);
    // "By" cell credits the scheduler (also matches the Scheduled filter chip).
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThanOrEqual(2);
    // Size humanized.
    expect(screen.getByText('34 KB')).toBeInTheDocument();
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
  });

  test('empty state invites the first snapshot', async () => {
    backupAPI.list.mockResolvedValue({ data: [] });
    render(<BackupRestorePanel />);
    await waitFor(() => expect(screen.getByText(/No snapshots yet/)).toBeInTheDocument());
    expect(screen.getByText(/take one now/i)).toBeInTheDocument(); // amber "Last snapshot" card
  });

  test('restore wizard opens with module checkboxes from manifest counts', async () => {
    render(<BackupRestorePanel />);
    await waitFor(() => expect(screen.getByText('jhesaraki@bgcengineering.ca')).toBeInTheDocument());
    fireEvent.click(screen.getAllByLabelText(/^Restore snapshot/)[0]);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Manifest counts → labeled checkboxes (with item counts).
    expect(screen.getByRole('checkbox', { name: 'Mail workflows (5 items)' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Noise rules (2 items)' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'SLA policies (4 items)' })).toBeInTheDocument();
    // Data-tier module is present but export-only and disabled.
    const tickets = screen.getByRole('checkbox', { name: 'Tickets (120 items)' });
    expect(tickets).toBeDisabled();
    expect(screen.getByText('export-only')).toBeInTheDocument();
    // Merge is the default mode.
    expect(screen.getByRole('radio', { name: /Merge/ })).toBeChecked();
  });

  test('dry-run diff renders per-module counts', async () => {
    render(<BackupRestorePanel />);
    await waitFor(() => expect(screen.getByText('jhesaraki@bgcengineering.ca')).toBeInTheDocument());
    fireEvent.click(screen.getAllByLabelText(/^Restore snapshot/)[0]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mail workflows (5 items)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Noise rules (2 items)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    await waitFor(() => expect(screen.getByText('Review changes (dry run)')).toBeInTheDocument());
    expect(backupAPI.dryRun).toHaveBeenCalledWith('snap-1', expect.objectContaining({
      targetWorkspaceId: 1,
      modules: expect.arrayContaining(['workflows', 'noiseRules']),
      mode: 'merge',
    }));
    // Per-module rows with add/update/skip/conflict counts.
    expect(screen.getByText('Mail workflows')).toBeInTheDocument();
    expect(screen.getByText('Noise rules')).toBeInTheDocument();
    const workflowsRow = screen.getByText('Mail workflows').closest('button');
    expect(workflowsRow).toHaveTextContent('2add');
    expect(workflowsRow).toHaveTextContent('1update');
    expect(workflowsRow).toHaveTextContent('3skip');
    expect(workflowsRow).toHaveTextContent('1conflict');

    // Expandable item list shows mono keys with action pills.
    fireEvent.click(workflowsRow);
    expect(screen.getByText('wf:after-hours-alert')).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.getByText('Conflict')).toBeInTheDocument();
  });
});
