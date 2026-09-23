/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ResolveReasonModal from './ResolveReasonModal';
import { RESOLUTION_REASONS, ticketNeedsResolutionReason, reasonLabel } from '../../utils/resolutionReasons';

/**
 * Simorgh C4 — the resolve dialog for Security tickets. One of seven reasons,
 * a note that is optional except for "Other", and nothing sends until a reason
 * is picked.
 */
describe('ResolveReasonModal', () => {
  afterEach(() => cleanup());

  test('lists all seven reasons and cannot confirm until one is chosen', () => {
    const onConfirm = vi.fn();
    render(<ResolveReasonModal ticketRef="TP-1291" targetStatus="Resolved" onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(RESOLUTION_REASONS.length);
    const confirm = screen.getByRole('button', { name: /^Resolved$/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('picking a reason enables confirm and sends reason + trimmed note', () => {
    const onConfirm = vi.fn();
    render(<ResolveReasonModal ticketRef="TP-1291" targetStatus="Resolved" onConfirm={onConfirm} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/False positive/));
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: '  Consumer VPN on a BYOD phone. ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Resolved$/ }));
    expect(onConfirm).toHaveBeenCalledWith({ resolutionReason: 'false_positive', resolutionNote: 'Consumer VPN on a BYOD phone.', verifiedSolution: false });
  });

  test('"Other" demands a note', () => {
    const onConfirm = vi.fn();
    render(<ResolveReasonModal ticketRef="TP-1291" targetStatus="Closed" onConfirm={onConfirm} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Other/));
    const confirm = screen.getByRole('button', { name: /^Closed$/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Merged into the RTBT epic' } });
    expect(confirm).toBeEnabled();
  });

  test('Escape and the Cancel button both close without confirming', () => {
    const onClose = vi.fn(); const onConfirm = vi.fn();
    render(<ResolveReasonModal ticketRef="TP-1291" targetStatus="Resolved" onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('names the ticket and the target status in the title', () => {
    render(<ResolveReasonModal ticketRef="TP-1291" targetStatus="Closed" onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /TP-1291 being closed/ })).toBeInTheDocument();
  });
});

describe('when the dialog is demanded', () => {
  test('only for a top-level Security category, any case', () => {
    expect(ticketNeedsResolutionReason({ internalCategory: { name: 'Security' } })).toBe(true);
    expect(ticketNeedsResolutionReason({ internalCategory: { name: 'security' } })).toBe(true);
    expect(ticketNeedsResolutionReason({ internalCategory: { name: 'Software & Apps' } })).toBe(false);
    expect(ticketNeedsResolutionReason({})).toBe(false);
    expect(ticketNeedsResolutionReason(null)).toBe(false);
  });

  test('labels resolve, unknown values fall through unchanged', () => {
    expect(reasonLabel('benign_expected')).toBe('Benign / expected');
    expect(reasonLabel('something_else')).toBe('something_else');
  });
});
