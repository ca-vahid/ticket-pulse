/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ApprovalEventCard, { parseApprovalRequest } from './ApprovalEventCard';
import { cleanNoteText } from '../../utils/noteText';

vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
afterEach(cleanup);

// 23 Sep 2026 (TP-1567): the request note was one run-on sentence with raw
// "&nbsp;" entities in it. It reads as who / what / to whom + the note now.
const NOTE = 'can Reza pick the computer from our storage? we have bunch of good laptops in Our storage -&nbsp; instead of ordering Yoga PRo 9 16 AH10 for James Leblond,&nbsp; for 1 person specially - what is so special about James Leblond?&nbsp;';
const SENTENCE = `Approval requested · New Computer Upgrade → vhaeri@bgcengineering.ca, rzaim@bgcengineering.ca by Gaby Tonnova — "${NOTE}"`;

describe('cleanNoteText', () => {
  test('decodes entities (also double-escaped), turns nbsp into spaces and tidies the spacing', () => {
    expect(cleanNoteText(NOTE)).toBe('can Reza pick the computer from our storage? we have bunch of good laptops in Our storage - instead of ordering Yoga PRo 9 16 AH10 for James Leblond, for 1 person specially - what is so special about James Leblond?');
    expect(cleanNoteText('a &amp;nbsp; b &lt;ok&gt; &#39;x&#39;')).toBe("a b <ok> 'x'");
    expect(cleanNoteText('line one\n\n\n\nline two')).toBe('line one\n\nline two');
    expect(cleanNoteText(null)).toBe('');
  });
});

describe('approval request card', () => {
  const entry = {
    bodyText: SENTENCE, actorName: 'Gaby Tonnova', actorEmail: 'gtonnova@bgcengineering.ca', authorType: 'system', occurredAt: new Date().toISOString(),
    rawPayload: { kind: 'approval_event', v: 1, event: 'requested', category: 'New Computer Upgrade', approvers: ['vhaeri@bgcengineering.ca', 'rzaim@bgcengineering.ca'], note: NOTE },
  };

  test('parses the payload (and the legacy sentence) into who / what / to whom / note', () => {
    const fromPayload = parseApprovalRequest(entry);
    expect(fromPayload).toEqual(expect.objectContaining({ category: 'New Computer Upgrade', requesterName: 'Gaby Tonnova' }));
    expect(fromPayload.note).not.toMatch(/&nbsp;/);
    const fromSentence = parseApprovalRequest({ bodyText: SENTENCE });
    expect(fromSentence.approvers).toEqual(['vhaeri@bgcengineering.ca', 'rzaim@bgcengineering.ca']);
    expect(fromSentence.note).toMatch(/^can Reza pick the computer/);
    expect(fromSentence.note).not.toMatch(/&nbsp;|"$/);
  });

  test('renders the requester, the category, the approvers by name and the note as its own block', () => {
    const names = { 'vhaeri@bgcengineering.ca': 'Vahid Haeri', 'rzaim@bgcengineering.ca': 'Reza Zaim' };
    render(<ul><ApprovalEventCard entry={entry} meta={{ label: 'Requested' }} body={SENTENCE} nameForEmail={(e) => names[e]} /></ul>);
    expect(screen.getByTestId('approval-request-card')).toBeInTheDocument();
    expect(screen.getByText('Gaby Tonnova')).toBeInTheDocument();
    expect(screen.getByText('asked for approval')).toBeInTheDocument();
    expect(screen.getByText('New Computer Upgrade')).toBeInTheDocument();
    expect(screen.getByText('· to Vahid Haeri, Reza Zaim')).toBeInTheDocument();
    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText(/what is so special about James Leblond\?$/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/&nbsp;|vhaeri@/);
  });
});
