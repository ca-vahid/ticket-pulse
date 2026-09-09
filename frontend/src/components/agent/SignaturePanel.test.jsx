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
        spacing: 'tight',
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

  // QA 09-08: a pasted Outlook signature loses its margins on the way in, so
  // every mail client re-adds its own paragraph spacing and the signature goes
  // out looser than the same one from FreshService. Spacing is now explicit.
  test('defaults to tight and sends the choice with the save', async () => {
    render(<SignaturePanel />);
    await screen.findByText('Email signature');

    const tight = screen.getByRole('radio', { name: 'Tight' });
    expect(tight).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('signature-preview')).toHaveAttribute('data-spacing', 'tight');

    fireEvent.click(screen.getByRole('radio', { name: 'Relaxed' }));
    expect(screen.getByRole('radio', { name: 'Relaxed' })).toHaveAttribute('aria-checked', 'true');
    expect(tight).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: /save signature/i }));
    await waitFor(() => {
      expect(agentAPI.saveMySignature).toHaveBeenCalledWith(expect.objectContaining({ spacing: 'relaxed' }));
    });
  });

  test('the preview class follows the choice, so what you see is what is sent', async () => {
    render(<SignaturePanel />);
    await screen.findByText('Email signature');

    const preview = screen.getByTestId('signature-preview');
    expect(preview.className).toContain('tp-sig-tight');

    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }));
    expect(preview.className).toContain('tp-sig-normal');
    expect(preview.className).not.toContain('tp-sig-tight ');
  });

  test('a stored spacing preference is loaded, not reset to the default', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: { ...stored, spacing: 'normal' } });
    render(<SignaturePanel />);
    await screen.findByText('Email signature');
    expect(screen.getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
  });

  test('surfaces load errors without crashing', async () => {
    agentAPI.getMySignature.mockRejectedValue(new Error('nope'));
    render(<SignaturePanel />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
