/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EmailHealthCard from './EmailHealthCard';
import { settingsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  settingsAPI: { getEmailHealth: vi.fn() },
}));

const downHealth = {
  status: 'down',
  lastSuccessAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  lastFailureAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  successCount24h: 4,
  failureCount24h: 6,
  hint: 'SendGrid returned 403 — check SendGrid → Settings → IP Access Management.',
  recentFailures: [
    { id: 1, createdAt: new Date().toISOString(), context: 'approval', provider: 'sendgrid', errorClass: 'ip_blocked', statusCode: 403, recipientDomain: 'bgc.ca', sanitizedMessage: 'access forbidden' },
  ],
};

describe('EmailHealthCard', () => {
  afterEach(() => cleanup());

  test('renders a failing state with hint and recent failure', async () => {
    settingsAPI.getEmailHealth.mockResolvedValue({ success: true, data: downHealth });
    render(<EmailHealthCard />);

    await waitFor(() => expect(screen.getByText('Delivery failing')).toBeInTheDocument());
    expect(screen.getByText(/IP Access Management/i)).toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    expect(screen.getByText('bgc.ca')).toBeInTheDocument();
    expect(screen.getByText(/6 failed/)).toBeInTheDocument();
  });

  test('renders a healthy state without the hint banner', async () => {
    settingsAPI.getEmailHealth.mockResolvedValue({
      success: true,
      data: { status: 'healthy', lastSuccessAt: new Date().toISOString(), lastFailureAt: null, successCount24h: 10, failureCount24h: 0, hint: null, recentFailures: [] },
    });
    render(<EmailHealthCard />);

    await waitFor(() => expect(screen.getByText('Healthy')).toBeInTheDocument());
    expect(screen.queryByText(/IP Access Management/i)).not.toBeInTheDocument();
  });

  test('shows an empty state when no sends recorded', async () => {
    settingsAPI.getEmailHealth.mockResolvedValue({
      success: true,
      data: { status: 'unknown', lastSuccessAt: null, lastFailureAt: null, successCount24h: 0, failureCount24h: 0, hint: null, recentFailures: [] },
    });
    render(<EmailHealthCard />);

    await waitFor(() => expect(screen.getByText('No recent sends')).toBeInTheDocument());
    expect(screen.getByText(/No email sends recorded yet/i)).toBeInTheDocument();
  });
});
