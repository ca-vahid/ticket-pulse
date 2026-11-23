/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Personal API keys (4.4.05): a reply sent with someone's own key shows the
// person as usual, plus a quiet "Sent with API key '<name>'" under the time.

const pending = () => new Promise(() => {});
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
vi.mock('../components/AppHeader', () => ({ default: () => null }));

import { ThreadEntry } from './TicketDetail';

const REPLY = {
  id: 501,
  eventType: 'reply',
  actorName: 'Dana Fox',
  actorEmail: 'dana.fox@example.com',
  authorType: 'agent',
  incoming: false,
  isPrivate: false,
  bodyText: 'Hi Eli, the laptop is ready for pickup.',
  occurredAt: '2026-11-22T10:05:00.000Z',
  rawPayload: {},
};

const renderEntry = (entry) => render(<ul><ThreadEntry entry={entry} ticketId={1234} /></ul>);

describe('ThreadEntry — sent with a personal API key', () => {
  afterEach(() => cleanup());

  test('shows the quiet marker under the time, with the person still the author', () => {
    renderEntry({ ...REPLY, rawPayload: { sentWithApiKey: { id: 7, name: 'Reply assistant' } } });
    const marker = screen.getByTestId('sent-with-api-key');
    expect(marker).toHaveTextContent('Sent with API key “Reply assistant”');
    expect(marker).toHaveClass('text-muted-foreground/75');
    expect(screen.getByText('Dana Fox')).toBeInTheDocument();
    // Directly under the entry time, in the same column.
    expect(marker.previousElementSibling).toHaveTextContent(/ago|just now/);
  });

  test('works for a private note too', () => {
    renderEntry({ ...REPLY, eventType: 'note', isPrivate: true, rawPayload: { sentWithApiKey: { id: 9, name: 'Night script' } } });
    expect(screen.getByTestId('sent-with-api-key')).toHaveTextContent('Sent with API key “Night script”');
  });

  test('no marker for in-app replies or other kinds of "via"', () => {
    renderEntry(REPLY);
    expect(screen.queryByTestId('sent-with-api-key')).not.toBeInTheDocument();
    cleanup();
    renderEntry({ ...REPLY, via: { kind: 'integration', keyName: 'Provisioning daemon' } });
    expect(screen.queryByTestId('sent-with-api-key')).not.toBeInTheDocument();
  });
});
