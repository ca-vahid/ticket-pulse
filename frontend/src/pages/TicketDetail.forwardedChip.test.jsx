/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { formatDayTime } from '../components/tickets/ticketUi';

// MEGA 09-01 Phase FW-5 — agent-forwarded / Cc'd intake chips on the thread
// entry: the ORIGINAL sender's message shows who forwarded it, its original
// date (with the mailbox-receipt time in the tooltip), distinct from the
// outbound "Forwarded" chip.

const pending = () => new Promise(() => {});
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 5, name: 'PA' }, availableWorkspaces: [] }),
}));
vi.mock('../components/AppHeader', () => ({ default: () => null }));

import { ThreadEntry, describeFsEvent } from './TicketDetail';

const RECEIVED = '2026-09-01T17:10:00.000Z';
const ORIGINAL = '2026-08-30T09:05:00.000Z';

function entry(forwarded, over = {}) {
  return {
    id: 1,
    eventType: 'reply',
    source: 'email_inbound',
    actorName: 'Sharon Blount',
    actorEmail: 'sblount@client.example.com',
    authorType: 'requester',
    incoming: true,
    isPrivate: false,
    bodyText: 'Please see the receipt attached.',
    occurredAt: RECEIVED,
    rawPayload: forwarded ? { forwarded } : null,
    ...over,
  };
}

describe('ThreadEntry forwarded-intake chips (FW-5)', () => {
  afterEach(() => cleanup());

  test('forwarded_intake: violet "Forwarded by <agent>" chip + original date with mailbox tooltip', () => {
    render(
      <ul>
        <ThreadEntry entry={entry({
          kind: 'forwarded_intake',
          byEmail: 'akuzmychev@example.com',
          byName: 'Anton Kuzmychev',
          byTechnicianId: 7,
          receivedAt: RECEIVED,
          originalFrom: { name: 'Sharon Blount', email: 'sblount@client.example.com' },
          originalDate: ORIGINAL,
          originalSubject: 'Receipt for first aid course',
          client: 'outlook-desktop',
          sliced: true,
          parser: 'v1',
        })}
        />
      </ul>,
    );
    const chip = screen.getByTestId('forwarded-intake-chip');
    expect(chip).toHaveTextContent('Forwarded by Anton Kuzmychev');
    expect(chip.getAttribute('title')).toMatch(/Original sender: Sharon Blount <sblount@client.example.com>/);
    expect(chip.getAttribute('title')).toMatch(/Original subject: Receipt for first aid course/);
    // Original date is what the header shows; receipt time lives in the tooltip.
    const stamp = screen.getAllByTitle(/received by mailbox/i).find((el) => el.textContent.includes(formatDayTime(ORIGINAL)));
    expect(stamp).toBeDefined();
    expect(stamp.getAttribute('title')).toContain(new Date(RECEIVED).toLocaleString());
    // Not the outbound "Forwarded" chip.
    expect(screen.queryByText(/^Forwarded$/)).not.toBeInTheDocument();
  });

  test('agent_cc: "Filed by <agent> (Cc)"', () => {
    render(
      <ul>
        <ThreadEntry entry={entry({ kind: 'agent_cc', byEmail: 'mehdi@example.com', byName: 'Mehdi', receivedAt: RECEIVED })} />
      </ul>,
    );
    expect(screen.getByTestId('forwarded-intake-chip')).toHaveTextContent('Filed by Mehdi (Cc)');
  });

  test('no forwarded payload → no chip, plain received time; outbound forwards keep their own chip', () => {
    const { unmount } = render(<ul><ThreadEntry entry={entry(null)} /></ul>);
    expect(screen.queryByTestId('forwarded-intake-chip')).not.toBeInTheDocument();
    expect(screen.getByTitle(new Date(RECEIVED).toLocaleString())).toBeInTheDocument();
    unmount();
    render(<ul><ThreadEntry entry={entry(null, { eventType: 'forward', incoming: false, authorType: 'agent', actorName: 'Ada' })} /></ul>);
    expect(screen.getByText('Forwarded')).toBeInTheDocument();
    expect(screen.queryByTestId('forwarded-intake-chip')).not.toBeInTheDocument();
  });
});

// QA 11-16 #1: a forward is stored private (the requester is not on it) and
// read "Internal note" in the conversation. It is a forward.
describe('ThreadEntry — outbound forwards (QA 11-16)', () => {
  afterEach(() => cleanup());
  const forwardRow = (over = {}) => ({
    id: 4050926,
    eventType: 'forward',
    source: 'ticketpulse_user',
    actorName: 'Ada Agent',
    actorEmail: 'ada@example.com',
    authorType: 'agent',
    incoming: false,
    isPrivate: true,
    visibility: 'private',
    bodyText: 'Forwarded to ops@example.com, lead@example.com — please have a look',
    bodyHtml: null,
    emailMessageId: '<sg-1@example.com>',
    occurredAt: RECEIVED,
    rawPayload: null,
    ...over,
  });

  test('an existing forward row (private, text only) shows as Forwarded, never as an internal note', () => {
    const { container } = render(<ul><ThreadEntry entry={forwardRow()} canDelete canEdit onDelete={() => {}} onEdit={() => {}} /></ul>);
    expect(screen.getByText('Forwarded')).toBeInTheDocument();
    expect(screen.queryByText('Internal note')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Not visible to the requester')).toBeInTheDocument();
    expect(container.querySelector('[data-entry-kind="forward"]')).not.toBeNull();
    expect(screen.getByText(/Forwarded to ops@example.com, lead@example.com/)).toBeInTheDocument();
    // A forward is not a note: no note edit/delete controls.
    expect(screen.queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('a new forward keeps the note\'s link', () => {
    render(<ul><ThreadEntry entry={forwardRow({ bodyHtml: '<p>Forwarded to ops@example.com</p><p>Fill in <a href="https://forms.example.com/7">this form</a></p>' })} /></ul>);
    expect(screen.getByRole('link', { name: 'this form' })).toHaveAttribute('href', 'https://forms.example.com/7');
  });

  test('internal notes are unchanged', () => {
    const { container } = render(<ul><ThreadEntry entry={forwardRow({ eventType: 'note', bodyText: 'Checked the logs.', emailMessageId: null })} /></ul>);
    expect(screen.getByText('Internal note')).toBeInTheDocument();
    expect(container.querySelector('[data-entry-kind="note"]')).not.toBeNull();
  });
});

describe('describeFsEvent (RO-2)', () => {
  test('parses FS status / assignment / group lines', () => {
    expect(describeFsEvent({ eventType: 'status_event', content: 'Dominic Bautista set Status as Closed' })).toEqual({ kind: 'status', value: 'Closed', verb: 'Closed' });
    expect(describeFsEvent({ eventType: 'assignment_event', content: 'Kirsten Fanning set Agent as Kirsten Fanning' })).toEqual({ kind: 'assignment', value: 'Kirsten Fanning', verb: 'Assigned to Kirsten Fanning' });
    expect(describeFsEvent({ eventType: 'assignment_event', content: 'Ticket Workflow set Agent as none' }).verb).toBe('Unassigned');
    expect(describeFsEvent({ eventType: 'group_event', content: 'Ticket Workflow set Group as Accounts Payable, set Type as Incident' })).toEqual({ kind: 'group', value: 'Accounts Payable', verb: 'Group set to Accounts Payable' });
    expect(describeFsEvent({ eventType: 'activity', content: 'Ticket Workflow executed Update department' })).toBeNull();
  });
});
