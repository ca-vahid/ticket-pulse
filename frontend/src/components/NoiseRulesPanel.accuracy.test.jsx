/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NoiseAccuracyPanel, NoiseGuidancePanel } from './NoiseRulesPanel';

vi.mock('../services/api', () => ({ noiseRulesAPI: {} }));

afterEach(cleanup);

// Shaped from the real ws2 (Accounting) figures: 1,535 verdicts, 844 tickets a
// person was assigned anyway, and the isNoise signal EXCLUDED because that
// workspace does not auto-close so the flag is never written.
const accountingReality = {
  workspaceId: 2,
  days: 180,
  total: 1535,
  byAi: 1535,
  byRule: 0,
  overridden: 844,
  upheld: 691,
  accuracy: 45,
  autoCloseNoise: false,
  signals: {
    assigned: { count: 844, counted: true },
    agentReplied: { count: 0, counted: true },
    noiseCleared: { count: 1324, counted: false },
    stillOpen: { count: 174, counted: false },
  },
  samples: [
    { ticketId: 1, ref: '#241020', subject: 'Your TELUS Business payment authorization', status: 'Closed', assignedTo: 'Kelly Sawatsky', noiseCleared: true },
  ],
};

describe('NoiseAccuracyPanel (QA 09-05 option 4)', () => {
  test('shows the headline numbers a team can act on', () => {
    render(<NoiseAccuracyPanel accuracy={accountingReality} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByTestId('noise-accuracy')).toBeInTheDocument();
    expect(screen.getByText('1535')).toBeInTheDocument();
    // 844 appears twice by design: the headline tile and the signal breakdown.
    expect(screen.getAllByText('844').length).toBe(2);
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  test('an excluded signal is shown and LABELLED, not hidden', () => {
    // The isNoise count is real but meaningless where nothing auto-closes.
    // Hiding it would look like the panel was missing data; counting it scored
    // Accounting at 3.8% on the first cut of this query. So: show and label.
    render(<NoiseAccuracyPanel accuracy={accountingReality} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText('1324')).toBeInTheDocument();
    expect(screen.getAllByText('not counted').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/does not auto-close/i)).toBeInTheDocument();
  });

  test('states plainly that these are signals, not confirmed mistakes', () => {
    render(<NoiseAccuracyPanel accuracy={accountingReality} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText(/signals, not confirmed mistakes/i)).toBeInTheDocument();
  });

  test('sample tickets are behind a toggle so the panel stays scannable', () => {
    render(<NoiseAccuracyPanel accuracy={accountingReality} isLoading={false} onRefresh={() => {}} />);
    expect(screen.queryByText(/TELUS Business payment/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show 1 recent/i }));
    expect(screen.getByText(/TELUS Business payment/)).toBeInTheDocument();
    expect(screen.getByText(/Kelly Sawatsky/)).toBeInTheDocument();
  });

  test('an empty window scores nothing rather than claiming 100%', () => {
    render(<NoiseAccuracyPanel
      accuracy={{ ...accountingReality, total: 0, overridden: 0, upheld: 0, accuracy: null, samples: [] }}
      isLoading={false}
      onRefresh={() => {}}
    />);
    expect(screen.getByText(/nothing to score/i)).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  test('renders nothing at all when the endpoint gave us nothing', () => {
    const { container } = render(<NoiseAccuracyPanel accuracy={null} isLoading={false} onRefresh={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('NoiseGuidancePanel (QA 09-05 option 2)', () => {
  test('save is disabled until something changes, then sends the draft', () => {
    const onSave = vi.fn();
    render(<NoiseGuidancePanel value="" onSave={onSave} isSaving={false} />);
    const save = screen.getByRole('button', { name: /Save guidance/i });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Workspace noise guidance'), { target: { value: 'Invoices are work.' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith('Invoices are work.');
  });

  test('the Accounts Payable template says the robots are the customers', () => {
    render(<NoiseGuidancePanel value="" onSave={() => {}} isSaving={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Accounts Payable wording/i }));
    const box = screen.getByLabelText('Workspace noise guidance');
    expect(box.value).toMatch(/CUSTOMERS here, not noise/);
    expect(box.value).toMatch(/Invoices, statements, remittance advice/);
    expect(box.value).toMatch(/Marketing, newsletters/);
    // The dual-purpose sender problem (Starlink) gets an explicit instruction.
    expect(box.value).toMatch(/judge the message, not the sender/);
  });

  test('clearing sends an empty string, which reverts to the built-in guidance', () => {
    const onSave = vi.fn();
    render(<NoiseGuidancePanel value="Something" onSave={onSave} isSaving={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^Clear$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save guidance/i }));
    expect(onSave).toHaveBeenCalledWith('');
  });

  test('a stored value loads into the editor', () => {
    render(<NoiseGuidancePanel value="Our own wording" onSave={() => {}} isSaving={false} />);
    expect(screen.getByLabelText('Workspace noise guidance')).toHaveValue('Our own wording');
  });
});
