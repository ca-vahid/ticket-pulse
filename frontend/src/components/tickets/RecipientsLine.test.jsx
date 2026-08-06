/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RecipientsLine, { normalizeRecipients, seedReplyCc } from './RecipientsLine';

// QA 08-05 #3 — Cc visibility: the quiet To/Cc line shared by the ticket
// description card, thread-entry headers and the peek preview.

afterEach(() => cleanup());

describe('normalizeRecipients', () => {
  test('drops non-addresses and dedupes case-insensitively, keeping first spelling', () => {
    expect(normalizeRecipients(['Boss@Example.com', 'boss@example.com', 'nope', '', null, 'peer@example.com']))
      .toEqual(['Boss@Example.com', 'peer@example.com']);
  });

  test('tolerates non-array input', () => {
    expect(normalizeRecipients(null)).toEqual([]);
    expect(normalizeRecipients('boss@example.com')).toEqual([]);
  });

  test('reduces RFC "Name <email>" forms to the bare address', () => {
    expect(normalizeRecipients(['IT Helpdesk <it@bgcengineering.ca>', 'it@bgcengineering.ca']))
      .toEqual(['it@bgcengineering.ca']);
  });
});

describe('seedReplyCc', () => {
  test('prefers replyCcEmails over ccEmails', () => {
    expect(seedReplyCc({ replyCcEmails: ['A@x.com'], ccEmails: ['b@y.com'] })).toEqual(['a@x.com']);
  });

  test('falls back to ccEmails, lowercased and deduped', () => {
    expect(seedReplyCc({ replyCcEmails: [], ccEmails: ['Boss@Example.com', 'boss@example.com'] }))
      .toEqual(['boss@example.com']);
  });

  test('caps at the server limit of 10', () => {
    const many = Array.from({ length: 14 }, (_, i) => `cc${i}@example.com`);
    expect(seedReplyCc({ ccEmails: many })).toHaveLength(10);
  });

  test('empty ticket seeds nothing', () => {
    expect(seedReplyCc(null)).toEqual([]);
    expect(seedReplyCc({})).toEqual([]);
  });
});

describe('RecipientsLine', () => {
  test('renders nothing when both lists are empty', () => {
    const { container } = render(<RecipientsLine to={[]} cc={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows To and Cc labels with the addresses', () => {
    render(<RecipientsLine to={['it@bgc.ca']} cc={['a@x.com', 'b@y.com']} />);
    expect(screen.getByText('To:')).toBeInTheDocument();
    expect(screen.getByText('Cc:')).toBeInTheDocument();
    expect(screen.getByText(/it@bgc\.ca/)).toBeInTheDocument();
    expect(screen.getByText(/a@x\.com, b@y\.com/)).toBeInTheDocument();
  });

  test('truncates long lists to 2 visible and expands/collapses on click', () => {
    render(<RecipientsLine cc={['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com']} />);

    // Only the first two visible, the rest behind "+2 more".
    expect(screen.getByText(/a@x\.com, b@y\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/c@z\.com/)).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '+2 more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText(/a@x\.com, b@y\.com, c@z\.com, d@w\.com/)).toBeInTheDocument();
    const less = screen.getByRole('button', { name: 'show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(less);
    expect(screen.queryByText(/c@z\.com/)).not.toBeInTheDocument();
  });

  test('counts hidden addresses across BOTH lists in one +N control', () => {
    render(
      <RecipientsLine
        to={['t1@x.com', 't2@x.com', 't3@x.com']}
        cc={['c1@x.com', 'c2@x.com', 'c3@x.com', 'c4@x.com']}
      />,
    );
    expect(screen.getByRole('button', { name: '+3 more' })).toBeInTheDocument();
  });

  test('no expand control when everything already fits', () => {
    render(<RecipientsLine cc={['a@x.com', 'b@y.com']} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
