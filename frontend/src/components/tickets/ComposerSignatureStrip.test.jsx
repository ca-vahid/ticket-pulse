/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComposerSignatureStrip, { clearSignatureStripCache, signatureHasSignOff } from './ComposerSignatureStrip';
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
    window.localStorage.clear();
  });

  test('shows the signature OPEN by default, and remembers when the agent hides it', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: enabledSignature });
    render(<ComposerSignatureStrip workspaceId={1} />);

    expect(await screen.findByText(/signature, added automatically/i)).toBeInTheDocument();
    expect(agentAPI.getMySignature).toHaveBeenCalledWith({ workspaceId: 1 });
    // Open by default (18 Sep 2026): the agent sees what goes under the reply.
    expect(screen.getByTestId('composer-signature-preview')).toBeInTheDocument();
    expect(screen.getByText('Ana Agent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide signature' }));
    expect(screen.queryByTestId('composer-signature-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show signature' })).toHaveAttribute('aria-expanded', 'false');

    // …and the choice survives a remount.
    cleanup();
    render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByText(/your signature is added automatically/i)).toBeInTheDocument();
    expect(screen.queryByTestId('composer-signature-preview')).not.toBeInTheDocument();
  });

  // QA 10-09 #4: it reads as the end of the e-mail — no box, header or well of
  // its own — and one quiet caption says it is automatic and where to change it.
  test('is a plain read-only block in the body\'s padding, with a caption linking to the profile', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: enabledSignature });
    render(<ComposerSignatureStrip workspaceId={1} />);

    const preview = await screen.findByTestId('composer-signature-preview');
    expect(preview).toHaveAttribute('role', 'group');
    expect(preview).toHaveAccessibleName(/added automatically.*not editable/i);
    expect(preview).not.toHaveAttribute('contenteditable');

    const strip = screen.getByTestId('composer-signature-strip');
    expect(strip.className).toContain('px-3');
    for (const el of [strip, preview]) expect(el.className).not.toMatch(/border|bg-|tp-light|rounded/);
    expect(strip.querySelector('.tp-light')).toBeNull();

    const change = within(screen.getByTestId('composer-signature-caption')).getByRole('link', { name: 'Change' });
    expect(change).toHaveAttribute('href', '/profile');
    expect(change).toHaveAttribute('target', '_blank');
  });

  test('signature HTML is still sanitised', async () => {
    agentAPI.getMySignature.mockResolvedValue({
      success: true,
      data: { ...enabledSignature, html: '<p onclick="x()">Ana Agent</p><script>window.__pwned = 1</script><style>p{color:red}</style>' },
    });
    render(<ComposerSignatureStrip workspaceId={1} />);
    const preview = await screen.findByTestId('composer-signature-preview');
    expect(preview).toHaveTextContent('Ana Agent');
    expect(preview.innerHTML).not.toMatch(/<script|<style|onclick/i);
  });

  test('a signature with no sign-off tells the agent to end their own message', async () => {
    agentAPI.getMySignature.mockResolvedValue({ success: true, data: enabledSignature });
    render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByTestId('composer-signature-hint')).toHaveTextContent(/no sign-off line/i);
  });

  test('a signature that opens with "Kind regards," does not', async () => {
    agentAPI.getMySignature.mockResolvedValue({
      success: true,
      data: { ...enabledSignature, html: '<p>Kind regards,</p><p>Ana Agent</p>', text: 'Kind regards,\nAna Agent' },
    });
    render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByText('Kind regards,')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-signature-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-signature-caption')).not.toHaveTextContent(/no sign-off line/i);
  });

  test('signatureHasSignOff reads text or html', () => {
    expect(signatureHasSignOff({ text: 'Best regards,\nAna' })).toBe(true);
    expect(signatureHasSignOff({ html: '<p>Thanks,</p><p>Ana</p>' })).toBe(true);
    expect(signatureHasSignOff({ text: 'Ana Agent\nIT Manager' })).toBe(false);
    expect(signatureHasSignOff({ html: '<p><strong>Bestin Thomas</strong></p>' })).toBe(false);
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
    expect(await screen.findByText(/signature, added automatically/i)).toBeInTheDocument();
    first.unmount();

    render(<ComposerSignatureStrip workspaceId={1} />);
    expect(await screen.findByText(/signature, added automatically/i)).toBeInTheDocument();
    expect(agentAPI.getMySignature).toHaveBeenCalledTimes(1);
  });
});
