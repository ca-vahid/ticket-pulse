/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Switch, SwitchCue, SwitchRow } from './switch';

// QA 11-05 #1: one switch for the whole app — one on colour, one off colour,
// one size, a real role="switch", and the label toggles it.

afterEach(cleanup);

function Controlled({ initial = false, ...rest }) {
  const [on, setOn] = useState(initial);
  return <SwitchRow label="Collapse duplicate bursts" description="Later copies are linked." checked={on} onCheckedChange={setOn} {...rest} />;
}

describe('Switch', () => {
  test('is a role="switch" button with aria-checked, the one size, the focus ring and token colours', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} aria-label="Webhook" />);
    const sw = screen.getByRole('switch', { name: 'Webhook' });
    expect(sw.tagName).toBe('BUTTON');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    for (const cls of ['h-5', 'w-9', 'tp-focus-ring', 'data-[state=checked]:bg-primary', 'data-[state=unchecked]:bg-muted-foreground', 'dark:data-[state=unchecked]:bg-muted-foreground/70']) {
      expect(sw.className).toContain(cls);
    }
    // No colour transition on the track (it would fight the light/dark swap).
    expect(sw.className).not.toMatch(/transition-colors|transition-all/);
    // The thumb glides, and stands still under the app's Motion setting.
    const thumb = sw.querySelector('span');
    expect(thumb.className).toContain('bg-card');
    expect(thumb.className).toContain('motion-off:transition-none');
  });

  test('clicking calls onCheckedChange with the next value; disabled does nothing', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked onCheckedChange={onChange} aria-label="x" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
    onChange.mockClear();
    rerender(<Switch checked onCheckedChange={onChange} aria-label="x" disabled />);
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SwitchRow', () => {
  test('the label names the switch, clicking the words toggles it, the description describes it', () => {
    render(<Controlled />);
    const sw = screen.getByRole('switch', { name: 'Collapse duplicate bursts' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription('Later copies are linked.');
    fireEvent.click(screen.getByText('Collapse duplicate bursts'));
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  test('a cue says in words what a colour used to hint at', () => {
    render(<Controlled cue={<SwitchCue>Writes to FreshService</SwitchCue>} />);
    expect(screen.getByText('Writes to FreshService')).toBeInTheDocument();
  });
});
