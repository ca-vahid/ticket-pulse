/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import { agentAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  agentAPI: {
    getNotificationPreferences: vi.fn(),
    saveNotificationPreferences: vi.fn(),
    requestPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
  },
}));

const preferences = {
  id: 1,
  workspaceId: 1,
  technicianId: 17,
  threshold: 'high_urgent',
  channels: { email: false, sms: false, whatsapp: false, phone_call: false },
  entraPhone: '+16045550100',
  entraMobilePhone: '+16045550101',
  phoneOverride: '',
  effectivePhone: '+16045550101',
  phoneVerified: false,
  providerStatus: {
    email: { provider: 'sendgrid', configured: true },
    sms: { provider: 'twilio', configured: false },
    whatsapp: { provider: 'twilio', configured: false },
    phone_call: { provider: 'twilio', configured: false },
  },
};

describe('NotificationSettingsPanel', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agentAPI.getNotificationPreferences.mockResolvedValue({
      success: true,
      data: {
        technician: { id: 17, name: 'Alex Chen', email: 'alex.chen@example.com' },
        preferences,
      },
    });
    agentAPI.saveNotificationPreferences.mockResolvedValue({
      success: true,
      data: { ...preferences, threshold: 'urgent_only', channels: { ...preferences.channels, email: true } },
    });
    agentAPI.requestPhoneVerification.mockResolvedValue({ success: true, sent: false, devCode: '123456' });
    agentAPI.confirmPhoneVerification.mockResolvedValue({
      success: true,
      data: { ...preferences, phoneVerified: true, phoneVerifiedAt: '2026-05-26T16:00:00.000Z' },
    });
  });

  test('renders notification settings and saves threshold plus email opt-in', async () => {
    render(<NotificationSettingsPanel workspaceId={1} />);

    expect(await screen.findByText('Priority threshold')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /SMS/i })).toBeDisabled();

    fireEvent.click(screen.getByText('Urgent only'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Email/i }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(agentAPI.saveNotificationPreferences).toHaveBeenCalledWith({
        workspaceId: 1,
        threshold: 'urgent_only',
        channels: { email: true, sms: false, whatsapp: false, phone_call: false },
        phoneOverride: '',
      });
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('runs phone verification before enabling SMS or phone call channels', async () => {
    render(<NotificationSettingsPanel workspaceId={1} />);

    expect(await screen.findByText('Priority threshold')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send code'));

    await waitFor(() => {
      expect(agentAPI.requestPhoneVerification).toHaveBeenCalledWith({ workspaceId: 1 });
    });

    expect(await screen.findByText('Dev code: 123456')).toBeInTheDocument();
    const codeInput = await screen.findByLabelText('Verification code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      expect(agentAPI.confirmPhoneVerification).toHaveBeenCalledWith({ workspaceId: 1, code: '123456' });
    });
  });

  test('an already verified phone still gets a code box after Send code, without the panel flashing', async () => {
    const verified = { ...preferences, phoneVerified: true, phoneVerifiedAt: '2026-05-26T16:00:00.000Z' };
    agentAPI.getNotificationPreferences.mockResolvedValue({ success: true, data: { preferences: verified } });
    agentAPI.saveNotificationPreferences.mockResolvedValue({ success: true, data: verified });
    agentAPI.requestPhoneVerification.mockResolvedValue({ success: true, sent: true });
    render(<NotificationSettingsPanel workspaceId={1} />);

    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Send code'));

    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.getByText('Verification code sent')).toBeInTheDocument();
    // The quiet reload keeps the panel on screen (no spinner swap).
    expect(screen.getByText('Priority threshold')).toBeInTheDocument();
  });

  test('QA 10-28 #1: Save waits while a code is pending; cancelling the check frees it', async () => {
    const verified = { ...preferences, phoneVerified: true, phoneOverride: '+16045550101', channels: { ...preferences.channels, sms: true } };
    agentAPI.getNotificationPreferences.mockResolvedValue({ success: true, data: { preferences: verified } });
    agentAPI.saveNotificationPreferences.mockResolvedValue({ success: true, data: verified });
    agentAPI.requestPhoneVerification.mockResolvedValue({ success: true, sent: true });
    render(<NotificationSettingsPanel workspaceId={1} />);

    expect(await screen.findByText('Verified')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send code'));
    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();

    // Re-checking a verified number keeps its SMS channel on (it used to switch it off).
    expect(agentAPI.saveNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
      channels: expect.objectContaining({ sms: true }),
    }));
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();
    expect(screen.getByTestId('code-pending-note')).toHaveTextContent('already verified');

    fireEvent.click(screen.getByText('cancel the check'));
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  test('QA 10-28 #1: a new, unverified number saves with the phone channels off instead of failing', async () => {
    render(<NotificationSettingsPanel workspaceId={1} />);
    expect(await screen.findByText('Priority threshold')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Override phone'), { target: { value: '+16045550199' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(agentAPI.saveNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
        channels: { email: false, sms: false, whatsapp: false, phone_call: false },
        phoneOverride: '+16045550199',
      }));
    });
  });
});
