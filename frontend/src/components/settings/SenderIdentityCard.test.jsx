/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SenderIdentityCard from './SenderIdentityCard';
import { settingsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getSenderIdentity: vi.fn(),
    updateSenderIdentity: vi.fn(),
  },
}));

const inheritedIdentity = {
  workspaceId: 1,
  fromName: null,
  globalFromName: 'Ticket Pulse',
  effectiveFromName: 'Ticket Pulse',
  fromEmail: 'ticketpulse@bgcengineering.ca',
  mailboxAddress: null,
};

describe('SenderIdentityCard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('renders the read-only address and the inherited default as placeholder', async () => {
    settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: inheritedIdentity });
    render(<SenderIdentityCard />);

    await waitFor(() => expect(screen.getByText('Sender identity')).toBeInTheDocument());
    const addressInput = screen.getByLabelText('From address (read-only)');
    expect(addressInput).toHaveValue('ticketpulse@bgcengineering.ca');
    expect(addressInput).toHaveAttribute('readonly');
    expect(screen.getByLabelText('From display name for this workspace')).toHaveAttribute('placeholder', 'Ticket Pulse');
  });

  test('preview shows the inherited name and updates live while typing', async () => {
    settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: inheritedIdentity });
    render(<SenderIdentityCard />);
    await waitFor(() => expect(screen.getByTestId('sender-identity-preview')).toBeInTheDocument());

    const preview = screen.getByTestId('sender-identity-preview');
    expect(preview).toHaveTextContent('Ticket Pulse');
    expect(preview).toHaveTextContent('<ticketpulse@bgcengineering.ca>');

    fireEvent.change(screen.getByLabelText('From display name for this workspace'), {
      target: { value: 'Ticket Pulse IT' },
    });
    expect(preview).toHaveTextContent('Ticket Pulse IT');
    // Avatar initial follows the effective name.
    expect(preview).toHaveTextContent('T');
  });

  test('saves the override and confirms with the effective name', async () => {
    settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: inheritedIdentity });
    settingsAPI.updateSenderIdentity.mockResolvedValue({
      success: true,
      data: { ...inheritedIdentity, fromName: 'Ticket Pulse IT', effectiveFromName: 'Ticket Pulse IT' },
    });
    render(<SenderIdentityCard />);
    await waitFor(() => expect(screen.getByText('Sender identity')).toBeInTheDocument());

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('From display name for this workspace'), {
      target: { value: 'Ticket Pulse IT' },
    });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(settingsAPI.updateSenderIdentity).toHaveBeenCalledWith({ fromName: 'Ticket Pulse IT' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ticket Pulse IT'));
  });

  test('shows a save error without clearing the draft', async () => {
    settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: inheritedIdentity });
    settingsAPI.updateSenderIdentity.mockRejectedValue(new Error('From display name cannot contain angle brackets or line breaks'));
    render(<SenderIdentityCard />);
    await waitFor(() => expect(screen.getByText('Sender identity')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('From display name for this workspace'), {
      target: { value: 'Bad name' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/angle brackets/i));
    expect(screen.getByLabelText('From display name for this workspace')).toHaveValue('Bad name');
  });

  test('renders a load error state', async () => {
    settingsAPI.getSenderIdentity.mockRejectedValue(new Error('Request failed'));
    render(<SenderIdentityCard />);
    await waitFor(() => expect(screen.getByText('Request failed')).toBeInTheDocument());
  });

  // Mega 08-30 Phase SN2 — "Replies show the agent's name" toggle.
  describe('reply sender toggle', () => {
    test('defaults ON (also when the field is missing) and previews the agent name on replies', async () => {
      settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: inheritedIdentity });
      render(<SenderIdentityCard />);
      const toggle = await screen.findByRole('switch', { name: /replies show the agent's name/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      const replyPreview = screen.getByTestId('sender-identity-reply-preview');
      expect(replyPreview).toHaveTextContent('Susan Xu');
      expect(replyPreview).toHaveTextContent('<ticketpulse@bgcengineering.ca>');
      expect(screen.getByText(/Microsoft 365 mailbox sends are best-effort/i)).toBeInTheDocument();
    });

    test('flipping it PUTs only replyUsesAgentName and the preview follows', async () => {
      settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: { ...inheritedIdentity, replyUsesAgentName: true } });
      settingsAPI.updateSenderIdentity.mockResolvedValue({
        success: true,
        data: { ...inheritedIdentity, replyUsesAgentName: false },
      });
      render(<SenderIdentityCard />);
      const toggle = await screen.findByRole('switch', { name: /replies show the agent's name/i });
      fireEvent.click(toggle);

      await waitFor(() => expect(settingsAPI.updateSenderIdentity).toHaveBeenCalledWith({ replyUsesAgentName: false }));
      await waitFor(() => expect(screen.getByRole('switch', { name: /replies show the agent's name/i })).toHaveAttribute('aria-checked', 'false'));
      const replyPreview = screen.getByTestId('sender-identity-reply-preview');
      expect(replyPreview).not.toHaveTextContent('Susan Xu');
      expect(replyPreview).toHaveTextContent('Ticket Pulse');
      // The display-name draft is untouched by a toggle save.
      expect(screen.getByLabelText('From display name for this workspace')).toHaveValue('');
    });

    test('a failed flip shows an alert and keeps the previous state', async () => {
      settingsAPI.getSenderIdentity.mockResolvedValue({ success: true, data: { ...inheritedIdentity, replyUsesAgentName: true } });
      settingsAPI.updateSenderIdentity.mockRejectedValue(new Error('Admin access required'));
      render(<SenderIdentityCard />);
      const toggle = await screen.findByRole('switch', { name: /replies show the agent's name/i });
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Admin access required'));
      expect(screen.getByRole('switch', { name: /replies show the agent's name/i })).toHaveAttribute('aria-checked', 'true');
    });
  });
});
