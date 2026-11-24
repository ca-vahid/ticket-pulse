/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TicketHistoryTimeline from './TicketHistoryTimeline';
import PriorityReasonLine from './PriorityReasonLine';
import { buildHistoryItems } from '../../utils/ticketHistory';
import { priorityChangeLine, priorityReasonText, pacificWhen } from '../../utils/priorityReason';

// QA 11-23 #2: B1's priority_changed rows on the Activity tab, and the quiet
// "Why this priority" line on the ticket.

afterEach(cleanup);

// 10:17 AM Pacific on Mon 23 Nov 2026 (PST, UTC-8).
const AT = '2026-11-23T18:17:00Z';
const row = (id, details, extra = {}) => ({ id, activityType: 'priority_changed', performedBy: details.actorName || 'Ticket Pulse', performedAt: AT, details, ...extra });

describe('priorityChangeLine: one sentence per source', () => {
  test.each([
    [{ from: 2, to: 4, source: 'requester_link', actorKind: 'human', actorName: 'Dana Fox' }, 'Dana Fox', 'raised the priority to Urgent from their status link'],
    [{ from: 2, to: 3, source: 'agent', actorKind: 'human', actorName: 'Eli Park' }, 'Eli Park', 'changed the priority from Medium to High'],
    [{ from: null, to: 3, source: 'ai_assessment', actorKind: 'ai', actorName: 'Ticket Pulse AI' }, 'Ticket Pulse AI', 'set the priority to High'],
    [{ from: 2, to: 3, source: 'repeat_report', actorKind: 'system' }, 'Ticket Pulse', 'raised the priority to High: same problem reported again today'],
    [{ from: 'Low', to: 'Medium', source: 'personal_key', actorKind: 'personal_key', actorName: 'Priya Nair' }, 'Priya Nair', 'changed the priority from Low to Medium with their API key'],
    [{ from: 1, to: 2, source: 'api', actorKind: 'api', actorName: 'Power Apps' }, 'Power Apps', 'changed the priority from Low to Medium through the API'],
    [{ from: 3, to: 2, source: 'sync', actorKind: 'freshservice_sync', actorName: 'Sam Okafor' }, 'Sam Okafor', 'changed the priority from High to Medium in FreshService'],
    [{ from: 2, to: 3, source: 'workflow', actorKind: 'workflow', actorName: 'VIP escalation' }, 'Workflow', 'changed the priority from Medium to High'],
  ])('%o', (details, actor, verb) => {
    const line = priorityChangeLine(details);
    expect(line.actor).toBe(actor);
    expect(line.verb).toBe(verb);
  });

  test('stand-in names are not printed as people', () => {
    expect(priorityChangeLine({ from: 2, to: 3, source: 'sync', actorName: 'FreshService' })).toMatchObject({ actor: 'FreshService', machine: true });
    expect(priorityChangeLine({ from: 2, to: 4, source: 'requester_link', actorName: 'Requester' }, 'Requester').actor).toBe('The requester');
    expect(priorityChangeLine({ from: 2, to: 3, source: 'workflow', actorName: 'Workflow' }).workflowName).toBeNull();
    expect(priorityReasonText({ level: 4, source: 'requester_link', actorName: 'Requester', at: null, note: null }, 4).who).toBe('The requester raised it from their status link');
  });

  test('the times are Pacific', () => {
    expect(pacificWhen(AT, Date.parse(AT))).toBe('today, 10:17 AM');
    expect(pacificWhen(AT, Date.parse('2026-11-25T18:00:00Z'))).toBe('Mon 23 Nov, 10:17 AM');
  });
});

describe('priority_changed on the Activity tab', () => {
  test('the requester raise reads as one sentence under their name, with their note in the details', () => {
    const items = buildHistoryItems({ activities: [row(1, { from: 2, to: 4, source: 'requester_link', actorKind: 'human', actorName: 'Dana Fox', note: 'The whole floor is down' })] });
    const [item] = items;
    expect(item).toMatchObject({ event: 'priority', actor: 'Dana Fox', actorType: 'person', machine: false, from: null, to: null, priorityFrom: 'Medium', priorityTo: 'Urgent' });

    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    const r = screen.getByTestId('history-row');
    expect(r).toHaveTextContent('10:17 AM');
    expect(r).toHaveTextContent('Dana Fox');
    expect(within(r).getByText('raised the priority to Urgent from their status link')).toBeInTheDocument();
    // No second "Medium → Urgent" after the sentence.
    expect(within(r).queryByTestId('history-transition')).toBeNull();
    // Up arrow, labelled for screen readers.
    expect(within(r).getByText('Priority raised')).toBeInTheDocument();
    // A short note rides on the line; the details carry the Pacific time.
    expect(r).toHaveTextContent('· The whole floor is down');
    fireEvent.click(within(r).getByRole('button'));
    expect(screen.getByTestId('history-details')).toHaveTextContent(/Mon 23 Nov( 2026)?, 10:17 AM/);
  });

  test('AI and repeat-report rows stay visible with machine activity hidden', () => {
    const items = buildHistoryItems({
      activities: [
        row(1, { from: null, to: 3, source: 'ai_assessment', actorKind: 'ai' }),
        { ...row(2, { from: 3, to: 4, source: 'repeat_report', actorKind: 'system', note: 'Same problem as TP-1040' }), performedAt: '2026-11-23T19:00:00Z' },
      ],
    });
    render(<TicketHistoryTimeline items={items} hideMachine onToggleMachine={() => {}} hiddenMachineCount={0} />);
    expect(screen.getByText('set the priority to High')).toBeInTheDocument();
    expect(screen.getByText('raised the priority to Urgent: same problem reported again today')).toBeInTheDocument();
  });

  test('a write-back row with priorityLogged drops its priority part (and the row when nothing else is left)', () => {
    const items = buildHistoryItems({
      activities: [
        row(1, { from: 2, to: 3, source: 'agent', actorKind: 'human', actorName: 'Eli Park' }),
        { id: 2, activityType: 'fs_write_back', performedBy: 'Eli Park', performedAt: '2026-11-23T19:30:00Z', details: { priorityLogged: true, changes: { priority: { from: 'Medium', to: 'High' } } } },
        { id: 3, activityType: 'fs_write_back', performedBy: 'Eli Park', performedAt: '2026-11-23T20:30:00Z', details: { priorityLogged: true, changes: { priority: { from: 'High', to: 'Urgent' }, status: { from: 'Open', to: 'Pending' } } } },
      ],
    });
    expect(items.filter((i) => i.event === 'priority')).toHaveLength(1);
    expect(items.find((i) => i.key === 'a-2')).toBeUndefined();
    expect(items.find((i) => i.key === 'a-3')).toMatchObject({ event: 'status', from: 'Open', to: 'Pending' });
  });

  test('the stock requester-link note is not repeated under the sentence', () => {
    const line = priorityChangeLine({ from: 2, to: 4, source: 'requester_link', actorName: 'Dana Fox', note: 'Raised the priority to Urgent from their status link.' });
    expect(line.detail).toBeNull();
    expect(priorityChangeLine({ from: 2, to: 4, source: 'requester_link', actorName: 'Dana Fox', note: 'Asked for urgent after-hours help from their status link.' }).detail)
      .toBe('Asked for urgent after-hours help from their status link.');
    expect(priorityReasonText({ level: 4, source: 'requester_link', actorName: 'Dana Fox', note: 'Raised the priority to Urgent from their status link.' }, 4).note).toBeNull();
  });

  test('the FreshService feed line and the write-back row of the same change fold into the sentence', () => {
    const items = buildHistoryItems({
      activities: [
        row(1, { from: 2, to: 3, source: 'agent', actorKind: 'human', actorName: 'Eli Park' }),
        { id: 2, activityType: 'fs_write_back', performedBy: 'Eli Park', performedAt: AT, details: { changes: { priority: { from: 'Medium', to: 'High' } } } },
      ],
      thread: [{ id: 'f1', source: 'freshservice_activity', eventType: 'activity', actorName: 'Ticket Pulse', content: 'set Priority as High', occurredAt: AT }],
    });
    expect(items.filter((i) => i.event === 'priority')).toHaveLength(1);
    expect(items[0].verb).toBe('changed the priority from Medium to High');
  });
});

describe('Why this priority', () => {
  const now = Date.parse(AT);

  test('who, when and the note', () => {
    expect(priorityReasonText({ level: 4, source: 'requester_link', actorName: 'Dana Fox', at: AT, note: 'The whole floor is down' }, 4, now))
      .toEqual({ who: 'Dana Fox raised it from their status link', when: 'today, 10:17 AM', note: 'The whole floor is down' });
    expect(priorityReasonText({ level: 'High', source: 'ai_assessment', at: AT, note: 'Several people cannot print' }, 3, now).who).toBe('The AI set it');
  });

  test('hidden when the reason is null, or explains a level the ticket no longer has', () => {
    expect(priorityReasonText(null, 3)).toBeNull();
    expect(priorityReasonText({ level: 4, source: 'agent', actorName: 'Eli Park', at: AT }, 2)).toBeNull();
  });

  test('renders as plain text near the priority', () => {
    const { container, rerender } = render(<PriorityReasonLine reason={{ level: 4, source: 'requester_link', actorName: 'Dana Fox', at: AT, note: 'The whole floor is down' }} priority={4} />);
    const line = screen.getByTestId('priority-reason');
    expect(line).toHaveTextContent('Why this priority: Dana Fox raised it from their status link ·');
    expect(line).toHaveTextContent('10:17 AM');
    expect(line).toHaveTextContent('“The whole floor is down”');
    rerender(<PriorityReasonLine reason={null} priority={4} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('polish 11-24: a short note reads in full, with no More button', () => {
    render(<PriorityReasonLine reason={{ level: 4, source: 'requester_link', actorName: 'Dana Fox', at: AT, note: 'The whole floor is down' }} priority={4} />);
    const note = screen.getByTestId('priority-reason-note');
    expect(note).not.toHaveClass('line-clamp-2');
    expect(note).toHaveClass('block');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('polish 11-24: a long AI rationale is held to two lines; More / Less is a keyboard button', () => {
    const rationale = 'Several people on the second floor cannot print to the shared printer, and the request mentions a payroll deadline this afternoon. '
      + 'The printer is the only one on that floor, so the impact is wider than one person, and the deadline makes it time sensitive.';
    render(<PriorityReasonLine reason={{ level: 'High', source: 'ai_assessment', at: AT, note: rationale }} priority={3} />);
    const note = screen.getByTestId('priority-reason-note');
    expect(note).toHaveClass('line-clamp-2');
    expect(note).not.toHaveClass('block');
    // The whole text is there for screen readers and search, only clamped visually.
    expect(note).toHaveTextContent(rationale);

    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('type', 'button');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', note.id);
    expect(more).toHaveClass('tp-focus-ring');
    more.focus();
    expect(more).toHaveFocus();
    fireEvent.click(more);

    const less = screen.getByRole('button', { name: 'Less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(less).toHaveFocus();
    expect(note).not.toHaveClass('line-clamp-2');
    fireEvent.click(less);
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    expect(note).toHaveClass('line-clamp-2');
  });
});
