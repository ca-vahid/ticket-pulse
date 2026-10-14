/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RecordInConversationOption from './RecordInConversationOption';

// QA 10-13 item 14: the option on a workflow's Send e-mail step.
afterEach(cleanup);

describe('RecordInConversationOption', () => {
  test('a saved workflow without the field is off', () => {
    render(<RecordInConversationOption value={undefined} onChange={() => {}} />);
    expect(screen.getByLabelText(/Record this e-mail in the ticket.s conversation/)).not.toBeChecked();
    expect(screen.getByText(/as a reply when the requester is among the recipients, otherwise as an internal note/)).toBeInTheDocument();
    expect(screen.getByText(/Not recorded in Shadow/)).toBeInTheDocument();
  });

  test('ticking and unticking reports a plain true / false', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RecordInConversationOption value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<RecordInConversationOption value onChange={onChange} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  test('read-only editors cannot change it', () => {
    render(<RecordInConversationOption value onChange={() => {}} disabled />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});
