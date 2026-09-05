/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NoiseRulesPanel, { SenderConditionFields, NoiseActivityPanel } from './NoiseRulesPanel';
import { noiseRulesAPI } from '../services/api';

vi.mock('../services/api', () => ({
  noiseRulesAPI: {
    activity: vi.fn(),
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
    noiseRulesAPI.activity.mockResolvedValue({ data: { days: 30, heldForReview: [], autoClosed: [], counts: { heldForReview: 0, autoClosed: 0 } } });
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

// QA 09-04: sender conditions on a rule, and the activity panel that makes a
// wrong auto-close visible instead of silent. Tested as components — driving the
// whole panel would test the surrounding form, not these.
describe('SenderConditionFields (QA 09-04)', () => {
  afterEach(cleanup);

  test('reports a sender pattern and the "close even from people" switch to its owner', () => {
    const onChange = vi.fn();
    render(<SenderConditionFields idPrefix="t" senderPattern="" autoCloseFromPeople={false} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. noreply@|^postmaster@'), { target: { value: '^postmaster@' } });
    expect(onChange).toHaveBeenCalledWith({ senderPattern: '^postmaster@' });

    fireEvent.click(screen.getByLabelText(/Close these even when a person sent them/i));
    expect(onChange).toHaveBeenCalledWith({ autoCloseFromPeople: true });
  });

  test('says plainly that forwards are left alone by default', () => {
    render(<SenderConditionFields idPrefix="t" onChange={() => {}} />);
    expect(screen.getByText(/forwarded by a colleague is left in the queue/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});

describe('NoiseActivityPanel (QA 09-04)', () => {
  afterEach(cleanup);

  const ACTIVITY = {
    days: 30,
    counts: { heldForReview: 1, autoClosed: 1 },
    heldForReview: [{ id: 1, ref: '#240367', subject: 'FW: Your archive mailbox is almost full.', rule: 'Mailbox Full / Archive Warnings', reason: 'forwarded_by_person', requesterName: 'Rod Kostaschuk', requesterEmail: 'rk@bgcengineering.ca' }],
    autoClosed: [{ id: 2, ref: '#240001', subject: '[BGC-VAN-LIDAR1] Volume degraded', rule: 'Synology NAS Alerts', reason: null, requesterName: null, requesterEmail: 'bgc-van-lidar1@bgcengineering.ca' }],
  };

  test('shows what was held back, who sent it and why', () => {
    render(<NoiseActivityPanel activity={ACTIVITY} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText(/FW: Your archive mailbox is almost full\./)).toBeInTheDocument();
    expect(screen.getByText(/Rod Kostaschuk/)).toBeInTheDocument();
    expect(screen.getByText(/forwarded by a person/)).toBeInTheDocument();
    expect(screen.getByText(/last 30 days/)).toBeInTheDocument();
  });

  test('the auto-closed half is one click away', () => {
    render(<NoiseActivityPanel activity={ACTIVITY} isLoading={false} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Auto-closed \(1\)/ }));
    expect(screen.getByText(/Volume degraded/)).toBeInTheDocument();
    expect(screen.queryByText(/archive mailbox/)).toBeNull();
  });

  test('an empty window says so instead of showing a blank box', () => {
    render(<NoiseActivityPanel activity={{ days: 30, counts: { heldForReview: 0, autoClosed: 0 }, heldForReview: [], autoClosed: [] }} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText(/every rule match in this window came from an automated sender/i)).toBeInTheDocument();
  });
});
