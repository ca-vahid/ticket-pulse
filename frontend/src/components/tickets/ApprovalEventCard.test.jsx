/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ApprovalEventCard, { parseApprovalSentence } from './ApprovalEventCard';

vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
afterEach(cleanup);

const SENTENCE = 'Approval APPROVED WITH CONDITION ✔ by Neville Vyland · Condition: "Name the accountable person for the generic ID." · Requested by vhaeri@bgcengineering.ca: "Hi Neville, please review and advise."';

describe('parseApprovalSentence', () => {
  test('splits the production sentence into verdict, approver, condition and the ask', () => {
    expect(parseApprovalSentence(SENTENCE)).toEqual({
      verdict: 'approved', changed: false, actorName: 'Neville Vyland', note: null,
      condition: 'Name the accountable person for the generic ID.',
      requestedBy: 'vhaeri@bgcengineering.ca', requestedByName: null,
      requestNote: 'Hi Neville, please review and advise.',
    });
  });
  test('a rejection with a note, flipped from an earlier decision', () => {
    const p = parseApprovalSentence('Approval CHANGED to REJECTED ✘ by Reza Zaim — "Desktop is powerful enough"');
    expect(p).toMatchObject({ verdict: 'rejected', changed: true, actorName: 'Reza Zaim', note: 'Desktop is powerful enough', condition: null });
  });
  test('anything else is not parsed', () => {
    expect(parseApprovalSentence('Approval requested · Security → x by Vahid')).toBeNull();
    expect(parseApprovalSentence('')).toBeNull();
  });
});

describe('ApprovalEventCard', () => {
  const entry = { bodyText: SENTENCE, actorEmail: 'nvyland@bgcengineering.ca', occurredAt: new Date().toISOString(), rawPayload: { kind: 'approval_event', event: 'approved' } };

  test('lays the verdict out as labelled blocks with the approver named, no status pill', () => {
    render(<ul><ApprovalEventCard entry={entry} meta={{ label: 'Approved' }} body={SENTENCE} /></ul>);
    expect(screen.getByText('Approved with a condition')).toBeInTheDocument();
    expect(screen.getByText('Neville Vyland')).toBeInTheDocument();
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('Name the accountable person for the generic ID.')).toBeInTheDocument();
    // The asker reads as a person, not an address.
    expect(screen.getByText('Asked by Vhaeri')).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });

  test('prefers the structured payload, including the resolved name of who asked', () => {
    const v2 = { ...entry, rawPayload: { kind: 'approval_event', v: 2, event: 'approved', parts: { verdict: 'approved', changed: false, actorName: 'Neville Vyland', note: null, condition: null, requestedBy: 'vhaeri@bgcengineering.ca', requestedByName: 'Vahid Haeri', requestNote: 'Please review.' } } };
    render(<ul><ApprovalEventCard entry={v2} meta={{ label: 'Approved' }} body="x" /></ul>);
    expect(screen.getByText('Asked by Vahid Haeri')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  // Vahid, 18 Sep 2026: soften the word a requester reads. The status VALUE stays
  // 'rejected'; only the label changes — and it must still read red, even though
  // "Not approved" contains "approv".
  test('a rejection reads "Not approved", in the red tone', () => {
    const rej = { ...entry, bodyText: 'Approval REJECTED ✘ by Reza Zaim — "Desktop is powerful enough"', rawPayload: { kind: 'approval_event', event: 'rejected' } };
    render(<ul><ApprovalEventCard entry={rej} meta={{ label: 'Not approved' }} body="x" /></ul>);
    const words = screen.getByText('Not approved');
    expect(words.className).toMatch(/text-red-/);
    expect(screen.queryByText('Rejected')).not.toBeInTheDocument();
  });

  test('an unparseable entry labelled "Not approved" still takes the red tone, not green', () => {
    const odd = { ...entry, bodyText: 'Manager declined the hardware request', rawPayload: { kind: 'approval_event', event: 'rejected' } };
    render(<ul><ApprovalEventCard entry={odd} meta={{ label: 'Not approved' }} body="Manager declined the hardware request" /></ul>);
    expect(screen.getByText('Approval · Not approved').className).toMatch(/text-red-/);
  });
});

