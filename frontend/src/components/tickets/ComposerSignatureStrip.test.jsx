/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComposerSignatureStrip, { clearSignatureStripCache } from './ComposerSignatureStrip';
import { agentAPI } from '../../services/api';

// Phase D: the strip is read-only — the signature is appended server-side at
// send time and must NEVER be seeded into the editable composer area.

vi.mock('../../services/api', () => ({
  agentAPI: {
    getMySignature: vi.fn(),
  },
}));

const enabledSignature = {
  enabled: true,
  exists: true,
  html: '<p><strong>Ana Agent</strong><br>IT Service Desk</p>',
  text: 'Ana Agent\nIT Service Desk',
};

describe('ComposerSignatureStrip', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    clearSignatureStripCache();
  });

  test('renders the collapsed strip for an enabled signature and expands to a preview', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: enabledSignature });
    render(<ComposerSignatureStrip workspaceId={1} />);

    expect(await screen.findByText(/your signature will be appended/i)).toBeInTheDocument();
    expect(agentAPI.getMySignature).toHaveBeenCalledWith({ workspaceId: 1 });
    // Collapsed by default — the preview body is hidden until asked for.
    expect(screen.queryByTestId('composer-signature-preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /your signature will be appended/i }));
    expect(screen.getByTestId('composer-signature-preview')).toBeInTheDocument();
    expect(screen.getByText('Ana Agent')).toBeInTheDocument();
  });

  test('renders nothing when the signature is disabled or absent', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: { ...enabledSignature, enabled: false } });
    const { container } = render(<ComposerSignatureStrip workspaceId={1} />);
    await waitFor(() => expect(agentAPI.getMySignature).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();

    cleanup();
    clearSignatureStripCache();
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: { enabled: false, exists: false, html: '', text: '' } });
    const { container: second } = render(<ComposerSignatureStrip workspaceId={1} />);
    await waitFor(() => expect(agentAPI.getMySignature).toHaveBeenCalledTimes(2));
    expect(second).toBeEmptyDOMElement();
  });

  test('renders nothing (and survives) when the fetch fails', async () => {
    agentAPI.getMySignature.mockRejectedValue(new Error('network'));
    const { container } = render(<ComposerSignatureStrip workspaceId={1} />);
    await waitFor(() => expect(agentAPI.getMySignature).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('caches the fetch per workspace — remounting does not refetch', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: enabledSignature });
    const first = render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByText(/your signature will be appended/i)).toBeInTheDocument();
    first.unmount();

    render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByText(/your signature will be appended/i)).toBeInTheDocument();
    expect(agentAPI.getMySignature).toHaveBeenCalledTimes(1);
  });
});
