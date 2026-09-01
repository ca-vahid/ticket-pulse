/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NoiseRulesPanel from './NoiseRulesPanel';
import { noiseRulesAPI } from '../services/api';

vi.mock('../services/api', () => ({
  noiseRulesAPI: {
    getAll: vi.fn(),
    getStats: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    test: vi.fn(),
    backfill: vi.fn(),
  },
}));

const RULES = [
  {
    id: 1,
    name: 'Shipping-room guard',
    pattern: '(package|shipping room|courier)',
    category: 'custom',
    mode: 'never_noise',
    isEnabled: true,
    matchCount: 0,
  },
  {
    id: 2,
    name: 'Server alerts',
    pattern: '^Alert:',
    category: 'monitoring',
    mode: 'noise',
    isEnabled: true,
    matchCount: 12,
  },
];

const STATS = { totalTickets: 1000, actionableTickets: 800, noiseTickets: 200, noisePercentage: 20 };

describe('NoiseRulesPanel rule modes (NT-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noiseRulesAPI.getAll.mockResolvedValue({ data: RULES });
    noiseRulesAPI.getStats.mockResolvedValue({ data: STATS });
    noiseRulesAPI.create.mockResolvedValue({ data: {} });
    noiseRulesAPI.update.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    cleanup();
  });

  test('shows the Never noise badge only on never_noise rules', async () => {
    render(<NoiseRulesPanel />);

    expect(await screen.findByText('Shipping-room guard')).toBeInTheDocument();
    expect(screen.getByText('Server alerts')).toBeInTheDocument();
    // Exactly one badge — the veto rule's.
    expect(screen.getAllByText('Never noise')).toHaveLength(1);
    expect(
      screen.getByTitle(/can never be auto-dismissed as noise, no matter what the AI decides/),
    ).toBeInTheDocument();
  });

  test('creating a rule round-trips the selected never_noise mode', async () => {
    render(<NoiseRulesPanel />);
    await screen.findByText('Shipping-room guard');

    fireEvent.click(screen.getByRole('button', { name: /Add Rule/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., My Custom Alert'), {
      target: { value: 'Mailroom protection' },
    });
    fireEvent.change(screen.getByPlaceholderText('^Alert: .+ from server'), {
      target: { value: '(mailroom|FedEx|UPS)' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Never noise' }));
    // Plain-language help copy for the veto mode is visible once selected.
    expect(
      screen.getByText('Tickets matching this can never be auto-dismissed as noise, no matter what the AI decides.'),
    ).toBeInTheDocument();
    // Dedup window does not apply to veto rules — the field disappears.
    expect(screen.queryByPlaceholderText('Leave empty = always noise')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create Rule/ }));

    await waitFor(() => expect(noiseRulesAPI.create).toHaveBeenCalledTimes(1));
    expect(noiseRulesAPI.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Mailroom protection',
      pattern: '(mailroom|FedEx|UPS)',
      mode: 'never_noise',
      dedupWindowDays: null,
    }));
  });

  test('editing a rule round-trips a mode change to never_noise', async () => {
    render(<NoiseRulesPanel />);
    await screen.findByText('Server alerts');

    fireEvent.click(screen.getByRole('button', { name: 'Edit rule Server alerts' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Never noise' }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(noiseRulesAPI.update).toHaveBeenCalledTimes(1));
    expect(noiseRulesAPI.update).toHaveBeenCalledWith(2, expect.objectContaining({
      mode: 'never_noise',
      dedupWindowDays: null,
    }));
  });

  test('default mode stays noise when the selector is untouched', async () => {
    render(<NoiseRulesPanel />);
    await screen.findByText('Shipping-room guard');

    fireEvent.click(screen.getByRole('button', { name: /Add Rule/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., My Custom Alert'), {
      target: { value: 'Plain noise rule' },
    });
    fireEvent.change(screen.getByPlaceholderText('^Alert: .+ from server'), {
      target: { value: '^Backup completed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/ }));

    await waitFor(() => expect(noiseRulesAPI.create).toHaveBeenCalledTimes(1));
    expect(noiseRulesAPI.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'noise' }));
  });
});
