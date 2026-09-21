/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AlertCorrelationPanel from './AlertCorrelationPanel';
import { alertCorrelationAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  alertCorrelationAPI: {
    listRules: vi.fn(), starter: vi.fn(), createRule: vi.fn(), installStarter: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(),
    preview: vi.fn(), apply: vi.fn(), suggestions: vi.fn(), activity: vi.fn(),
  },
}));

const RULE = {
  id: 1, name: 'Azure Monitor alerts (Fired / Resolved)', description: 'Pairs Fired with Resolved.', isEnabled: true,
  senderPattern: '^azure-noreply@microsoft\\.com$', firedPattern: '^Fired:(?<key>.+)', clearedPattern: '^Resolved:(?<key>.+)', followupPattern: null,
  pairWindowMinutes: 360, pairAction: 'resolve', orphanClearedAction: 'resolve', stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3,
  resolutionReason: 'benign_expected', skipAi: true, matchCount: 16,
};
const ok = (data) => Promise.resolve({ data: { success: true, data } });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  alertCorrelationAPI.listRules.mockReturnValue(ok([RULE]));
  alertCorrelationAPI.suggestions.mockReturnValue(ok([{ sender: 'noreply@site24x7.com', tickets: 121, kind: 'pair', pairsSeen: 17, sampleFired: 'HOST is Down', sampleCleared: 'HOST is Up', proposal: { name: 'x', senderPattern: 'a', firedPattern: 'b', clearedPattern: 'c', stormEnabled: true } }]));
  alertCorrelationAPI.activity.mockReturnValue(ok([]));
  alertCorrelationAPI.updateRule.mockReturnValue(ok(RULE));
  alertCorrelationAPI.createRule.mockReturnValue(ok(RULE));
});

describe('AlertCorrelationPanel', () => {
  test('lists rules with their settings and lets an admin toggle one', async () => {
    render(<AlertCorrelationPanel />);
    expect(await screen.findByText('Azure Monitor alerts (Fired / Resolved)')).toBeInTheDocument();
    expect(screen.getByText(/pair within 360 min · resolve both/)).toBeInTheDocument();
    expect(screen.getByText(/matched 16 times/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Azure Monitor alerts (Fired / Resolved)' }));
    await waitFor(() => expect(alertCorrelationAPI.updateRule).toHaveBeenCalledWith(1, { isEnabled: false }));
  });

  test('a new rule posts the form with numbers as numbers and blanks as null', async () => {
    render(<AlertCorrelationPanel />);
    await screen.findByText('Azure Monitor alerts (Fired / Resolved)');
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }));
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Cambio' } });
    fireEvent.change(screen.getByLabelText('Sender pattern'), { target: { value: '^notifications@cambioearth\\.com$' } });
    fireEvent.change(screen.getByLabelText('Fired pattern'), { target: { value: '^ON - (?<key>.+)' } });
    fireEvent.change(screen.getByLabelText('Cleared pattern'), { target: { value: '^OFF - (?<key>.+)' } });
    fireEvent.change(screen.getByLabelText('Pair window minutes'), { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }));
    await waitFor(() => expect(alertCorrelationAPI.createRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Cambio', firedPattern: '^ON - (?<key>.+)', clearedPattern: '^OFF - (?<key>.+)', followupPattern: null, pairWindowMinutes: 1440, stormMinCount: 3,
    })));
  });

  test('a test on history is a dry run whose counts are shown; apply asks first', async () => {
    alertCorrelationAPI.preview.mockReturnValue(ok({ days: 30, candidates: 40, summary: { pairs: 16, storms: 3, orphans: 1, followups: 0, unmatchedFired: 2, vetoed: 0 }, pairs: [{ firedId: 1, clearedId: 2, firedRef: '#243170', clearedRef: '#243182', gapMinutes: 15 }], storms: [], orphans: [], followups: [], unmatchedFired: [{ ref: '#243150' }], vetoed: [] }));
    alertCorrelationAPI.apply.mockReturnValue(ok({ evaluated: 19, handled: [{ id: 1, ref: '#243170', kind: 'pair', subject: 'Fired…' }], untouched: [{ ref: '#243150' }] }));
    render(<AlertCorrelationPanel />);
    await screen.findByText('Azure Monitor alerts (Fired / Resolved)');
    fireEvent.click(screen.getByRole('button', { name: /Test on history/ }));
    expect(await screen.findByTestId('alert-preview')).toHaveTextContent('16pairs');
    expect(screen.getByTestId('alert-preview')).toHaveTextContent('#243170 cleared by #243182 after 15 min');
    expect(alertCorrelationAPI.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('alert-apply'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, apply' }));
    await waitFor(() => expect(alertCorrelationAPI.apply).toHaveBeenCalledWith(30));
    expect(await screen.findByTestId('alert-apply-result')).toHaveTextContent('1 of 19 open alert tickets handled');
  });

  test('suggestions list senders with no rule', async () => {
    render(<AlertCorrelationPanel />);
    expect(await screen.findByText(/noreply@site24x7.com/)).toBeInTheDocument();
    expect(screen.getByText(/17 pairs seen/)).toBeInTheDocument();
  });
});
