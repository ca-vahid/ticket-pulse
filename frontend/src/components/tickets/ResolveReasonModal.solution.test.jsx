/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ResolveReasonModal from './ResolveReasonModal';

// QA 09-22 #6: "Mark as a verified solution" rides the resolve dialog.
afterEach(cleanup);

describe('ResolveReasonModal — verified solution', () => {
  test('the checkbox is off by default and its value travels with the confirm payload', () => {
    const onConfirm = vi.fn();
    render(<ResolveReasonModal ticketRef="TP-1618" targetStatus="Resolved" onConfirm={onConfirm} onClose={() => {}} />);
    const box = screen.getByRole('checkbox', { name: /Mark as a verified solution/ });
    expect(box).not.toBeChecked();
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Replaced the SFP' } });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ resolutionNote: 'Replaced the SFP', verifiedSolution: true }));
  });
});
