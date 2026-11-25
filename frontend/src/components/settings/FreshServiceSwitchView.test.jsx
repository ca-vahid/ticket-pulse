/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FreshServiceSwitchView, { FreshServiceModeText } from './FreshServiceSwitchView';
import { pacificWhen, shadowSentence, stepStates } from './freshserviceSwitchCopy';
import { describeAccessEvent } from './AccessHistory';

// FreshService switch (25 Nov 2026): Settings → Workspaces → a workspace.
// The view is props-in only, so every state renders without a fetch.

const NOW = new Date('2026-11-25T20:00:00Z'); // Wed 12:00 PM PT
const WS = { id: 5, name: 'Project Accounting', freshserviceWorkspaceId: '9' };

const READY_PREFLIGHT = {
  openFsBorn: 1,
  uncachedAttachments: 0,
  blockers: [],
  warnings: ['FreshService reminded requesters who went quiet.'],
  items: [
    { key: 'mail_intake', state: 'ok', text: 'Mail reaches Ticket Pulse directly: 1 mailbox connected.', link: 'ticket-mailboxes' },
    { key: 'adopt', state: 'ok', text: '1 open FreshService ticket will be adopted.' },
    { key: 'reminder_workflow', state: 'warn', text: 'FreshService reminded requesters who went quiet.', todo: 'Set up the same in', link: 'notification-workflows' },
    { key: 'attachments', state: 'warn', text: '3 FreshService attachments on imported tickets are not copied to Ticket Pulse yet.', todo: 'Run the final FreshService import before the account ends, or they go with it.' },
  ],
};
const BLOCKED_PREFLIGHT = {
  ...READY_PREFLIGHT,
  blockers: ['No mailbox is connected to Ticket Pulse, and 4 e-mails arrived through FreshService in the last 7 days.'],
  items: [{ key: 'mail_intake', state: 'block', text: 'No mailbox is connected to Ticket Pulse, and 4 e-mails arrived through FreshService in the last 7 days.', link: 'ticket-mailboxes' }],
};
const SHADOW = {
  since: '2026-11-24T17:12:00.000Z', // Tue 9:12 AM PT
  total: 214,
  counts: {
    sync: { n: 180, first: '2026-11-24T17:13:00.000Z', last: '2026-11-25T19:50:00.000Z' },
    mirror: { n: 30, first: '2026-11-24T17:20:00.000Z', last: '2026-11-25T19:40:00.000Z' },
    writeback: { n: 4, first: '2026-11-24T18:00:00.000Z', last: '2026-11-25T18:00:00.000Z' },
  },
};

const data = (over = {}) => ({
  workspace: WS, mode: 'connected', record: { mode: 'connected', changedBy: null, changedAt: null, history: [] },
  shadow: { since: null, counts: {}, total: 0 }, preflight: READY_PREFLIGHT, job: null, canWrite: true, ...over,
});

function renderView(props) {
  const onSetMode = vi.fn();
  const onStartOff = vi.fn();
  const utils = render(
    <MemoryRouter>
      <FreshServiceSwitchView now={NOW} onSetMode={onSetMode} onStartOff={onStartOff} {...props} />
    </MemoryRouter>,
  );
  return { ...utils, onSetMode, onStartOff };
}

afterEach(() => cleanup());

describe('words', () => {
  test('Pacific times and the Shadow sentence in plain words', () => {
    expect(pacificWhen('2026-11-24T17:12:00.000Z', NOW)).toBe('Tue 9:12 AM');
    expect(pacificWhen('2026-11-10T17:12:00.000Z', NOW)).toBe('Tue 10 Nov, 9:12 AM');
    expect(shadowSentence(SHADOW, NOW)).toBe('In Shadow since Tue 9:12 AM: 214 FreshService calls Off would stop — sync 180, copies 30, write-backs 4.');
    expect(shadowSentence({ since: SHADOW.since, counts: {} }, NOW)).toBe('Nothing has called FreshService since Tue 9:12 AM.');
  });

  test('steps follow the job', () => {
    expect(stepStates({ state: 'running', step: 'adopt' })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(stepStates({ state: 'failed', step: 'adopt' })).toEqual(['done', 'failed', 'todo', 'todo']);
    expect(stepStates({ state: 'done', step: 'done' })).toEqual(['done', 'done', 'done', 'done']);
  });

  test('Access history reads the two new events', () => {
    expect(describeAccessEvent({ action: 'freshservice_mode_changed', actorEmail: 'root@example.com', oldValue: 'connected', newValue: 'shadow' }))
      .toBe('root set FreshService to Shadow (was Connected)');
    expect(describeAccessEvent({ action: 'freshservice_tickets_adopted', actorEmail: 'root@example.com', newValue: '55' }))
      .toBe('root adopted 55 open FreshService tickets while switching FreshService off');
    expect(describeAccessEvent({ action: 'freshservice_tickets_adopted', actorEmail: 'root@example.com', newValue: '3', details: { adopted: 3, failed: 1, switchedOff: false } }))
      .toBe('root adopted 3 open FreshService tickets while switching FreshService off; 1 could not be adopted (FreshService stayed on)');
  });
});

describe('row text', () => {
  test('quiet coloured text with a dot, not a pill', () => {
    render(<FreshServiceModeText mode="shadow" />);
    const el = screen.getByTestId('fs-mode-text');
    expect(el).toHaveTextContent('FreshService: Shadow');
    expect(el.querySelector('.rounded-full')).toHaveClass('h-2', 'w-2');
  });
});

describe('panel states', () => {
  test('connected: the picker, the preflight checklist, no Off flow until Off is chosen', () => {
    const { onSetMode } = renderView({ data: data() });
    expect(screen.getByRole('radio', { name: /connected/i })).toBeChecked();
    const list = screen.getByTestId('fs-preflight');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getAllByText('OK')).toHaveLength(2);
    expect(within(list).getAllByText('Check this')).toHaveLength(2);
    expect(within(list).getByRole('link', { name: 'Mail Workflows' })).toHaveAttribute('href', '/settings#notification-workflows');
    expect(screen.queryByTestId('fs-off-flow')).not.toBeInTheDocument();

    // Off never flips straight away: it opens the guided flow.
    fireEvent.click(screen.getByRole('radio', { name: /^off/i }));
    expect(onSetMode).not.toHaveBeenCalled();
    expect(screen.getByTestId('fs-off-flow')).toBeInTheDocument();
  });

  test('"Check this" items say what to do, the linked ones ending on the link', () => {
    renderView({ data: data() });
    const items = within(screen.getByTestId('fs-preflight')).getAllByRole('listitem');
    const reminder = items.find((li) => li.textContent.includes('reminded requesters'));
    expect(reminder).toHaveTextContent('Check this FreshService reminded requesters who went quiet. Set up the same in Mail Workflows.');
    expect(within(reminder).getByRole('link', { name: 'Mail Workflows' })).toHaveAttribute('href', '/settings#notification-workflows');
    const attachments = items.find((li) => li.textContent.includes('attachments'));
    expect(attachments).toHaveTextContent('Run the final FreshService import before the account ends, or they go with it.');
    expect(within(attachments).queryByRole('link')).toBeNull();
  });

  test('who changed it is a name (record and history), the e-mail local part only when unknown', () => {
    renderView({ data: data({ mode: 'shadow', shadow: SHADOW, record: {
      mode: 'shadow', changedBy: 'morgan.reyes@example.com', changedByName: 'Morgan Reyes', changedAt: SHADOW.since,
      history: [
        { from: 'connected', to: 'shadow', by: 'morgan.reyes@example.com', byName: 'Morgan Reyes', at: SHADOW.since },
        { from: 'shadow', to: 'connected', by: 'stranger@example.com', byName: null, at: '2026-11-23T17:12:00.000Z' },
      ],
    } }) });
    expect(screen.getByText(/since Tue 9:12 AM by Morgan Reyes/)).toBeInTheDocument();
    expect(screen.queryByText(/morgan\.reyes/)).toBeNull();
    fireEvent.click(screen.getByText(/Changes \(2\)/));
    expect(screen.getByText('by Morgan Reyes')).toBeInTheDocument();
    expect(screen.getByText('by stranger')).toBeInTheDocument();
  });

  test('choosing Shadow sets it at once', () => {
    const { onSetMode } = renderView({ data: data() });
    fireEvent.click(screen.getByRole('radio', { name: /shadow/i }));
    expect(onSetMode).toHaveBeenCalledWith('shadow');
  });

  test('shadow with counts: the sentence and the per-purpose list with first and last seen', () => {
    renderView({ data: data({ mode: 'shadow', shadow: SHADOW, record: { mode: 'shadow', changedBy: 'root@example.com', changedAt: SHADOW.since, history: [{ from: 'connected', to: 'shadow', by: 'root@example.com', at: SHADOW.since }] } }) });
    expect(screen.getByRole('radio', { name: /shadow/i })).toBeChecked();
    expect(screen.getByTestId('fs-shadow-sentence')).toHaveTextContent('In Shadow since Tue 9:12 AM: 214 FreshService calls Off would stop — sync 180, copies 30, write-backs 4.');
    const rows = within(screen.getByTestId('fs-shadow-rows')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ticket sync');
    expect(rows[0]).toHaveTextContent('180');
    expect(rows[0]).toHaveTextContent('first Tue 9:13 AM · last Wed 11:50 AM');
    expect(rows[1]).toHaveTextContent('Copies to FreshService');
    expect(screen.getByText(/since Tue 9:12 AM by root/)).toBeInTheDocument();
  });

  test('shadow, quiet: says nothing has called FreshService', () => {
    renderView({ data: data({ mode: 'shadow', shadow: { since: SHADOW.since, counts: {}, total: 0 } }) });
    expect(screen.getByTestId('fs-shadow-sentence')).toHaveTextContent('Nothing has called FreshService since Tue 9:12 AM.');
  });

  test('off: says adopted tickets stay Ticket Pulse tickets; no preflight', () => {
    renderView({ data: data({ mode: 'off', preflight: null, record: { mode: 'off', changedBy: 'root@example.com', changedAt: '2026-11-25T18:00:00.000Z', adoptedCount: 1, history: [] }, job: { state: 'done', step: 'done', total: 1, adopted: 1, failed: [] } }) });
    expect(screen.getByRole('radio', { name: /^off/i })).toBeChecked();
    expect(screen.getByTestId('fs-off-note')).toHaveTextContent('Adopted tickets stay Ticket Pulse tickets.');
    expect(screen.queryByTestId('fs-preflight')).not.toBeInTheDocument();
    expect(screen.getByTestId('fs-off-outcome')).toHaveTextContent('FreshService is off for Project Accounting. 1 ticket was adopted and is a Ticket Pulse ticket now.');
  });

  test('never connected: muted text, no picker', () => {
    renderView({ data: { workspace: { id: 10, name: 'Facilities' }, mode: 'never_connected', record: null, shadow: null, preflight: null, job: null, canWrite: false } });
    expect(screen.getByTestId('fs-never-connected')).toHaveTextContent('Never connected to FreshService — nothing to switch.');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  test('a workspace admin sees it read-only', () => {
    renderView({ data: data({ canWrite: false }) });
    expect(screen.getByRole('radio', { name: /shadow/i })).toBeDisabled();
    expect(screen.getByText('Only super admins change this.')).toBeInTheDocument();
  });
});

describe('Off flow', () => {
  const openOff = (d) => {
    const utils = renderView({ data: d });
    fireEvent.click(screen.getByRole('radio', { name: /^off/i }));
    return utils;
  };

  test('the typed name enables the button that names the act and the workspace', () => {
    const { onStartOff } = openOff(data());
    const button = screen.getByRole('button', { name: 'Turn FreshService off for Project Accounting' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type Project Accounting to confirm/), { target: { value: 'project accountin' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type Project Accounting to confirm/), { target: { value: ' Project Accounting ' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStartOff).toHaveBeenCalledWith('Project Accounting');
  });

  test('blocked: the blocker in red and the button stays disabled', () => {
    openOff(data({ preflight: BLOCKED_PREFLIGHT }));
    expect(screen.getByTestId('fs-preflight').querySelector('[data-state="block"]')).toHaveTextContent('Blocks Off');
    expect(screen.getByTestId('fs-off-blocked')).toHaveTextContent('No mailbox is connected');
    fireEvent.change(screen.getByLabelText(/Type Project Accounting to confirm/), { target: { value: 'Project Accounting' } });
    expect(screen.getByRole('button', { name: /Turn FreshService off/ })).toBeDisabled();
  });

  test('running: numbered steps with a running count; no form', () => {
    renderView({ data: data({ job: { state: 'running', step: 'adopt', total: 55, done: 12, adopted: 12, failed: [] } }) });
    const progress = screen.getByTestId('fs-off-progress');
    expect(progress.querySelector('[data-step="check"]')).toHaveAttribute('data-step-state', 'done');
    expect(progress.querySelector('[data-step="adopt"]')).toHaveTextContent('Adopt 55 tickets');
    expect(progress.querySelector('[data-step="adopt"]')).toHaveAttribute('data-step-state', 'current');
    expect(screen.getByTestId('fs-off-count')).toHaveTextContent('Adopted 12 of 55');
    expect(screen.queryByRole('button', { name: /Turn FreshService off/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /shadow/i })).toBeDisabled();
  });

  test('failed after adopting some: says what happened, with references, and offers to try again', () => {
    const error = '1 ticket could not be adopted (#900077). 1 ticket was adopted; FreshService is still on. Try again to finish.';
    renderView({ data: data({ job: { state: 'failed', step: 'adopt', total: 2, adopted: 1, failedCount: 1, failed: [{ ref: '#900077' }], error } }) });
    expect(screen.getByTestId('fs-off-outcome')).toHaveTextContent(error);
    expect(screen.queryByText(/store refused|Ticket 77/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again: turn FreshService off for Project Accounting' })).toBeInTheDocument();
  });

  test('failed with no stored sentence still says how many were adopted', () => {
    renderView({ data: data({ job: { state: 'failed', step: 'adopt', total: 4, adopted: 3, failed: [] } }) });
    expect(screen.getByTestId('fs-off-outcome')).toHaveTextContent('The switch did not finish. 3 tickets were adopted; FreshService is still on. Try again to finish.');
  });

  test('done with late tickets that could not be adopted: the outcome and a note naming them', () => {
    renderView({ data: data({ mode: 'off', preflight: null, record: { mode: 'off', history: [] }, job: { state: 'done', step: 'done', total: 3, adopted: 2, failed: [], note: '1 ticket that arrived during the switch could not be adopted (#900008); open it and choose Adopt to edit.' } }) });
    expect(screen.getByTestId('fs-off-outcome')).toHaveTextContent('2 tickets were adopted');
    expect(screen.getByTestId('fs-off-note-late')).toHaveTextContent('#900008');
  });

  test('the Off button uses the destructive token; the copy names who can adopt', () => {
    openOff(data());
    expect(screen.getByRole('button', { name: /Turn FreshService off/ })).toHaveClass('bg-destructive');
    expect(screen.getByTestId('fs-off-flow')).toHaveTextContent('Agents and admins can adopt one to edit it.');
    expect(screen.getByTestId('fs-off-flow')).toHaveTextContent('won’t be copied to it, and edits made while off aren’t sent back');
  });
});

describe('Back on from Off', () => {
  const OFF = () => data({ mode: 'off', preflight: null, record: { mode: 'off', history: [] } });

  test('asks once, says what it will not do, then sets the mode', () => {
    const { onSetMode } = renderView({ data: OFF() });
    fireEvent.click(screen.getByRole('radio', { name: /connected/i }));
    expect(onSetMode).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('fs-back-on-confirm');
    expect(confirm).toHaveTextContent('Turn FreshService back on for Project Accounting? Sync and waiting copies restart. Tickets and messages created while FreshService was off won’t be copied to it, and edits made while off aren’t sent back. Adopted tickets stay Ticket Pulse tickets.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn it back on (Connected)' }));
    expect(onSetMode).toHaveBeenCalledWith('connected');
  });

  test('Cancel keeps it off', () => {
    const { onSetMode } = renderView({ data: OFF() });
    fireEvent.click(screen.getByRole('radio', { name: /shadow/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSetMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fs-back-on-confirm')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^off/i })).toBeChecked();
  });

  test('the Off panel says what switching back on does not do', () => {
    renderView({ data: OFF() });
    expect(screen.getByTestId('fs-off-note')).toHaveTextContent('Tickets and messages created while FreshService was off won’t be copied to it');
  });
});
