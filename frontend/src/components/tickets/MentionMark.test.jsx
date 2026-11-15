/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MentionMark from './MentionMark';

/** MEGA 11-14 Part H: the row's @ mark — who mentioned me and when, on hover. */

afterEach(cleanup);

const mentions = {
  unseen: 1,
  latest: [
    { by: 'Alex Rivera', at: '2026-11-13T17:14:00Z', seen: false },
    { by: 'Jordan Lee', at: '2026-11-10T22:05:00Z', seen: true },
  ],
};

test('no mention, no mark', () => {
  const { container } = render(<MentionMark mentions={null} />);
  expect(container).toBeEmptyDOMElement();
  render(<MentionMark mentions={{ unseen: 0, latest: [] }} />);
  expect(screen.queryByTestId('mention-mark')).toBeNull();
});

test('hover shows who and when (Pacific); the label says it without hovering', () => {
  render(<MentionMark mentions={mentions} />);
  const mark = screen.getByTestId('mention-mark');
  expect(mark).toHaveAttribute('data-unseen', 'true');
  expect(mark).toHaveAttribute('aria-label', expect.stringMatching(/^Mentioned you: Alex Rivera, Fri 13 Nov, 9:14 AM and 1 more · 1 not opened yet$/));
  expect(screen.queryByTestId('mention-card')).toBeNull();
  fireEvent.mouseEnter(mark);
  const card = screen.getByTestId('mention-card');
  expect(card).toHaveTextContent('Mentioned you');
  expect(card).toHaveTextContent('1 not opened yet');
  expect(card).toHaveTextContent('Alex Rivera · Fri 13 Nov, 9:14 AM');
  expect(card).toHaveTextContent('Jordan Lee · Tue 10 Nov, 2:05 PM');
  fireEvent.mouseLeave(mark);
  expect(screen.queryByTestId('mention-card')).toBeNull();
});

test('keyboard focus shows it too; a seen mention is quiet', () => {
  render(<MentionMark mentions={{ unseen: 0, latest: [{ by: 'Jordan Lee', at: '2026-11-10T22:05:00Z', seen: true }] }} />);
  const mark = screen.getByTestId('mention-mark');
  expect(mark).toHaveAttribute('data-unseen', 'false');
  fireEvent.focus(mark);
  expect(screen.getByTestId('mention-card')).toHaveTextContent('Jordan Lee');
});
