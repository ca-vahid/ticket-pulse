/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { formatDayTime, timeAgo } from '../components/tickets/ticketUi';

// QA 08-14 #3: Activity-tab events show the exact date+time next to the
// relative age — the "{formatDayTime(at)} · {timeAgo(at)}" convention the
// Conversation header already uses.

// Module-load safety only — HistoryEvent itself is a pure component.
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

import { HistoryEvent } from './TicketDetail';

const StubIcon = () => null;

describe('HistoryEvent timestamps (QA 08-14 #3)', () => {
  afterEach(() => cleanup());

  test('renders the absolute date+time AND the relative age', () => {
    const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    render(
      <ul>
        <HistoryEvent icon={StubIcon} tone="bg-slate-100 text-slate-500" title="Assigned to Terry" at={at} isLast />
      </ul>,
    );
    const expected = `${formatDayTime(at)} · ${timeAgo(at)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(timeAgo(at)).toBe('2h ago'); // sanity: the relative half is real
  });

  test('keeps the full toLocaleString tooltip', () => {
    const at = '2026-08-10T17:30:00Z';
    render(
      <ul>
        <HistoryEvent icon={StubIcon} tone="" title="Status changed" at={at} isLast />
      </ul>,
    );
    expect(screen.getByTitle(new Date(at).toLocaleString())).toHaveTextContent(formatDayTime(at));
  });
});
