/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SignaturePanel from './SignaturePanel';
import { agentAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  agentAPI: {
    getMySignature: vi.fn(),
    saveMySignature: vi.fn(),
  },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));
// The real editor is contentEditable (no jsdom execCommand) — a textarea stub
// drives onChange with the same { html, text } contract.
vi.mock('../tickets/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange({ html: e.target.value, text: e.target.value })}
    />
  ),
}));

const stored = {
  workspaceId: 1,
  ownerEmail: 'me@bgc.ca',
  exists: true,
  enabled: true,
  html: '<p><strong>Me</strong> — IT Service Desk</p>',
  text: 'Me — IT Service Desk',
};

describe('SignaturePanel (my signature, agent portal)', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: stored });
    agentAPI.saveMySignature.mockImplementation((body) => Promise.resolve({
      success: true,
      data: { ...stored, ...body },
    }));
  });

  test('round-trip: loads the stored signature, edits, and saves with the workspace id', async () => {
    render(<SignaturePanel />);

    expect(await screen.findByText('Email signature')).toBeInTheDocument();
    expect(agentAPI.getMySignature).toHaveBeenCalledWith({ workspaceId: 1 });
    // Live preview renders the sanitized html.
    expect(screen.getByTestId('signature-preview')).toHaveTextContent('Me — IT Service Desk');

    fireEvent.change(screen.getByRole('textbox', { name: 'Signature editor' }), {
      target: { value: '<p>New sig</p>' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save signature/i }));

    await waitFor(() => {
      expect(agentAPI.saveMySignature).toHaveBeenCalledWith({
        workspaceId: 1,
        enabled: true,
        html: '<p>New sig</p>',
        text: '<p>New sig</p>',
      });
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('enable toggle rides the save payload and flags the disabled state', async () => {
    render(<SignaturePanel />);
    await screen.findByText('Email signature');

    fireEvent.click(screen.getByRole('checkbox', { name: /enabled/i }));
    expect(screen.getByText(/Disabled — your signature is kept/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save signature/i }));
    await waitFor(() => {
      expect(agentAPI.saveMySignature).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
  });

  test('surfaces load errors without crashing', async () => {
    agentAPI.getMySignature.mockRejectedValue(new Error('nope'));
    render(<SignaturePanel />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
