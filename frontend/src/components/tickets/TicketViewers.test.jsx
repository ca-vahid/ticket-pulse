/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import TicketViewers, { CHANGE_MS, LEFT_MS, hereLine, leftLine } from './TicketViewers';

const SAM = { email: 'sam@example.com', name: 'Sam Ortiz', composing: null };
const KIM = { email: 'kim@example.com', name: 'Kim Lee', composing: null };
const ALEX = { email: 'alex@example.com', name: 'Alex Rivera', composing: null };
const JO = { email: 'jo@example.com', name: 'Jo Park', composing: null };

const line = () => screen.getByTestId('ticket-viewers-line').textContent;
const live = () => screen.getByTestId('ticket-viewers-live').textContent;
const eye = () => screen.getByTestId('ticket-viewers').querySelector('svg');

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.dataset.motion = 'full';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe('TicketViewers — who else is on this ticket', () => {
  test('words for 1, 2 and 4 people', () => {
    expect(hereLine([SAM])).toBe('Sam Ortiz is here');
    expect(hereLine([SAM, KIM])).toBe('Sam and Kim are here');
    expect(hereLine([SAM, KIM, ALEX, JO])).toBe('Sam and 3 others are here');
    expect(leftLine([SAM])).toBe('Sam Ortiz left');
    expect(leftLine([SAM, KIM])).toBe('Sam and Kim left');
    expect(leftLine([SAM, KIM, ALEX])).toBe('3 people left');
  });

  test('shows the count inside the eye and the name beside it (1, 2, 4 people)', () => {
    const { rerender } = render(<TicketViewers viewers={[SAM]} />);
    expect(screen.getByTestId('ticket-viewers').dataset.count).toBe('1');
    expect(eye().textContent).toBe('1');
    expect(line()).toBe('Sam Ortiz is here');

    act(() => { vi.advanceTimersByTime(1000); });
    rerender(<TicketViewers viewers={[SAM, KIM]} />);
    expect(eye().textContent).toBe('2');
    // The latest arrival leads.
    expect(line()).toBe('Kim and Sam are here');

    rerender(<TicketViewers viewers={[SAM, KIM, ALEX, JO]} />);
    expect(eye().textContent).toBe('4');
    expect(line()).toMatch(/^\w+ and 3 others are here$/);
  });

  test('is hidden when nobody else is here (the live region stays for announcements)', () => {
    render(<TicketViewers viewers={[]} />);
    expect(screen.queryByTestId('ticket-viewers')).toBeNull();
    expect(live()).toBe('');
  });

  test('arrival: the eye opens once, the count bumps, then it settles', () => {
    const { rerender } = render(<TicketViewers viewers={[]} />);
    act(() => { vi.advanceTimersByTime(5000); });
    rerender(<TicketViewers viewers={[SAM]} />);
    const box = screen.getByTestId('ticket-viewers');
    expect(box.dataset.change).toBe('arrive');
    expect(eye().getAttribute('class')).toContain('tp-eye-anim-open');
    expect(live()).toBe('Sam Ortiz opened this ticket.');
    act(() => { vi.advanceTimersByTime(CHANGE_MS); });
    expect(screen.getByTestId('ticket-viewers').dataset.change).toBeUndefined();
    expect(eye().getAttribute('class')).not.toContain('tp-eye-anim');
  });

  test('people already here when the page opens read as "also on this ticket"', () => {
    render(<TicketViewers viewers={[SAM, KIM]} />);
    expect(live()).toBe('Sam Ortiz and Kim Lee are also on this ticket.');
  });

  test('departure: the eye closes, "Sam Ortiz left" shows for a few seconds, then it settles', () => {
    const { rerender } = render(<TicketViewers viewers={[SAM, KIM]} />);
    act(() => { vi.advanceTimersByTime(CHANGE_MS); });
    rerender(<TicketViewers viewers={[KIM]} />);
    expect(screen.getByTestId('ticket-viewers').dataset.state).toBe('left');
    expect(line()).toBe('Sam Ortiz left');
    expect(eye().getAttribute('class')).toContain('tp-eye-anim-blink');
    expect(eye().textContent).toBe('1');
    expect(live()).toBe('Sam Ortiz left.');
    act(() => { vi.advanceTimersByTime(LEFT_MS); });
    expect(line()).toBe('Kim Lee is here');
  });

  test('the last person leaving shuts the eye, then the mark goes away', () => {
    const { rerender } = render(<TicketViewers viewers={[SAM]} />);
    act(() => { vi.advanceTimersByTime(CHANGE_MS); });
    rerender(<TicketViewers viewers={[]} />);
    expect(line()).toBe('Sam Ortiz left');
    expect(eye().dataset.eye).toBe('closed');
    expect(eye().getAttribute('class')).toContain('tp-eye-anim-shut');
    expect(screen.queryByTestId('ticket-viewers-button')).toBeNull();
    act(() => { vi.advanceTimersByTime(LEFT_MS); });
    expect(screen.queryByTestId('ticket-viewers')).toBeNull();
    expect(live()).toBe('Sam Ortiz left.');
  });

  test('motion off (app setting): no eye move, a brief flash on the name line instead', () => {
    document.documentElement.dataset.motion = 'reduce';
    const { rerender } = render(<TicketViewers viewers={[]} />);
    act(() => { vi.advanceTimersByTime(5000); });
    rerender(<TicketViewers viewers={[SAM]} />);
    const box = screen.getByTestId('ticket-viewers');
    expect(box.className).toContain('tp-viewers-flash');
    expect(eye().getAttribute('class')).not.toContain('tp-eye-anim');
    act(() => { vi.advanceTimersByTime(CHANGE_MS); });
    expect(screen.getByTestId('ticket-viewers').className).not.toContain('tp-viewers-flash');
  });

  test('a heartbeat with the same people is not a change', () => {
    const { rerender } = render(<TicketViewers viewers={[SAM]} />);
    act(() => { vi.advanceTimersByTime(CHANGE_MS); });
    rerender(<TicketViewers viewers={[{ ...SAM }]} />);
    expect(screen.getByTestId('ticket-viewers').dataset.change).toBeUndefined();
  });

  test('a click opens the list: everyone, how long, and a pen for whoever is writing', () => {
    const { rerender } = render(<TicketViewers viewers={[SAM]} />);
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    rerender(<TicketViewers viewers={[SAM, { ...KIM, composing: 'reply' }, ALEX]} />);
    // The writer leads the line and gets the pen line.
    expect(line()).toBe('Kim and 2 others are here');
    expect(screen.getByTestId('ticket-viewers-writing').textContent).toBe('Kim is writing a reply');

    const button = screen.getByTestId('ticket-viewers-button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const rows = screen.getAllByTestId('ticket-viewer');
    expect(rows.map((r) => r.querySelector('.font-medium').textContent)).toEqual(['Kim Lee', 'Alex Rivera', 'Sam Ortiz']);
    expect(rows[0].querySelector('[data-testid="ticket-viewer-writing"]').textContent).toBe('Writing a reply');
    expect(rows[1].querySelector('[data-testid="ticket-viewer-writing"]')).toBeNull();
    expect(rows[1].textContent).toContain('Arrived just now');
    expect(rows[2].textContent).toContain('Here when you opened it');

    // Escape closes it; a second click on a pinned list closes it too.
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByTestId('ticket-viewers-list')).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByTestId('ticket-viewers-list')).toBeNull();
  });

  test('keyboard focus opens the list too', () => {
    render(<TicketViewers viewers={[SAM]} />);
    fireEvent.focus(screen.getByTestId('ticket-viewers-button'));
    expect(screen.getByTestId('ticket-viewers-list')).toBeTruthy();
  });

  test('shows 9+ in the eye for ten or more people', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ email: `p${i}@example.com`, name: `Person ${i}` }));
    render(<TicketViewers viewers={many} />);
    expect(eye().textContent).toBe('9+');
  });
});
