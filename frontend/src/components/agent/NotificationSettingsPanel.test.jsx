/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import React from 'react';
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
    const codeInput = await screen.findByPlaceholderText('Code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      expect(agentAPI.confirmPhoneVerification).toHaveBeenCalledWith({ workspaceId: 1, code: '123456' });
    });
  });
});
