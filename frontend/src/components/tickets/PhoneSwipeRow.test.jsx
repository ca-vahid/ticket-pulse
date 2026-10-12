/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Check } from 'lucide-react';
import PhoneSwipeRow from './PhoneSwipeRow';

describe('PhoneSwipeRow', () => {
  it('renders the card alone when there are no actions', () => {
    render(<PhoneSwipeRow actions={[]}><p>Card</p></PhoneSwipeRow>);
    expect(screen.getByText('Card')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-swipe-row')).toBeNull();
  });

  it('runs an action and closes the row', () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PhoneSwipeRow open onOpenChange={onOpenChange} actions={[{ key: 'resolve', label: 'Resolve', Icon: Check, tone: 'emerald', onClick: run }]}>
        <p>Card</p>
      </PhoneSwipeRow>,
    );
    fireEvent.click(screen.getByTestId('swipe-resolve'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a tap on an open card closes it instead of opening the ticket', () => {
    const open = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PhoneSwipeRow open onOpenChange={onOpenChange} actions={[{ key: 'select', label: 'Select', Icon: Check, onClick: () => {} }]}>
        <button type="button" onClick={open}>Subject</button>
      </PhoneSwipeRow>,
    );
    fireEvent.click(screen.getByText('Subject'));
    expect(open).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the actions out of the tab order while closed', () => {
    render(
      <PhoneSwipeRow actions={[{ key: 'mine', label: 'Mine', Icon: Check, onClick: () => {} }]}><p>Card</p></PhoneSwipeRow>,
    );
    expect(screen.getByTestId('swipe-mine')).toHaveAttribute('tabindex', '-1');
  });
});
