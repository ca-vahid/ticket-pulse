/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SignaturesPanel from './SignaturesPanel';
import { settingsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getSignatures: vi.fn(),
    updateSignature: vi.fn(),
    massApplySignatures: vi.fn(),
  },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));
vi.mock('../tickets/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange({ html: e.target.value, text: e.target.value })}
    />
  ),
}));

const MEMBERS = [
  {
    technicianId: 11,
    name: 'Ana Agent',
    email: 'ana@bgc.ca',
    photoUrl: null,
    isActive: true,
    origin: 'freshservice',
    signature: { exists: true, enabled: true, html: '<p>Ana sig</p>', text: 'Ana sig', updatedAt: '2026-08-15T10:00:00Z', updatedBy: 'ana@bgc.ca' },
  },
  {
    technicianId: 12,
    name: 'Ben Local',
    email: 'ben@bgc.ca',
    photoUrl: null,
    isActive: true,
    origin: 'local',
    signature: null,
  },
  {
    technicianId: 13,
    name: 'Cleo Closed',
    email: 'cleo@bgc.ca',
    photoUrl: null,
    isActive: false,
    origin: 'freshservice',
    signature: { exists: true, enabled: false, html: '<p>Old</p>', text: 'Old', updatedAt: null, updatedBy: null },
  },
];

describe('SignaturesPanel (Settings → Signatures)', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    settingsAPI.getSignatures.mockResolvedValue({ success: true, data: { members: MEMBERS } });
    settingsAPI.updateSignature.mockResolvedValue({ success: true, data: {} });
  });

  test('renders the member table joined with signature status', async () => {
    render(<SignaturesPanel />);

    expect(await screen.findByText('Ana Agent')).toBeInTheDocument();
    expect(screen.getByText('Ben Local')).toBeInTheDocument();
    expect(screen.getByText('Cleo Closed')).toBeInTheDocument();
    // Status column: enabled / none / disabled.
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  test('per-row toggle disables an enabled signature via the admin route', async () => {
    render(<SignaturesPanel />);
    await screen.findByText('Ana Agent');

    fireEvent.click(screen.getByTitle('Disable signature'));
    await waitFor(() => {
      expect(settingsAPI.updateSignature).toHaveBeenCalledWith('ana@bgc.ca', { enabled: false });
    });
  });

  test('inline edit opens the modal and saves html + enabled for that member', async () => {
    render(<SignaturesPanel />);
    await screen.findByText('Ana Agent');

    fireEvent.click(screen.getByTitle("Edit Ben Local's signature"));
    const dialog = screen.getByRole('dialog', { name: /Ben Local/ });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Signature for Ben Local' }), {
      target: { value: '<p>Ben sig</p>' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /save signature/i }));

    await waitFor(() => {
      expect(settingsAPI.updateSignature).toHaveBeenCalledWith('ben@bgc.ca', {
        html: '<p>Ben sig</p>',
        text: '<p>Ben sig</p>',
        enabled: true,
      });
    });
  });

  test('mass-apply: preview-before-apply with variable substitution', async () => {
    settingsAPI.massApplySignatures.mockImplementation(({ preview }) => Promise.resolve({
      success: true,
      data: preview
        ? {
          preview: true,
          applied: 0,
          results: [{ technicianId: 11, name: 'Ana Agent', email: 'ana@bgc.ca', html: '<p><strong>Ana Agent</strong> · ana@bgc.ca</p>' }],
          skipped: [],
        }
        : { preview: false, applied: 1, results: [], skipped: [] },
    }));

    render(<SignaturesPanel />);
    await screen.findByText('Ana Agent');

    // Apply is locked until a preview ran for the current selection.
    expect(screen.getByRole('button', { name: /apply to selected/i })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Select Ana Agent'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Signature template' }), {
      target: { value: '<p><strong>{{name}}</strong> · {{email}}</p>' },
    });
    expect(screen.getByRole('button', { name: /apply to selected/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    const previews = await screen.findByTestId('mass-apply-previews');
    // Substituted values render per member.
    expect(within(previews).getByText(/Ana Agent · ana@bgc.ca/)).toBeInTheDocument();
    expect(settingsAPI.massApplySignatures).toHaveBeenCalledWith({
      template: '<p><strong>{{name}}</strong> · {{email}}</p>',
      technicianIds: [11],
      preview: true,
    });

    const applyBtn = screen.getByRole('button', { name: /apply to selected/i });
    expect(applyBtn).toBeEnabled();
    fireEvent.click(applyBtn);
    await waitFor(() => {
      expect(settingsAPI.massApplySignatures).toHaveBeenCalledWith(expect.objectContaining({ preview: false, technicianIds: [11] }));
    });
    expect(await screen.findByText(/applied to 1 member/i)).toBeInTheDocument();
  });

  test('inactive members cannot be selected for mass-apply', async () => {
    render(<SignaturesPanel />);
    await screen.findByText('Cleo Closed');
    expect(screen.getByLabelText('Select Cleo Closed')).toBeDisabled();
  });
});
