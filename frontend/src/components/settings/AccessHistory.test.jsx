/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AccessHistory, { describeAccessEvent, credentialDetail } from './AccessHistory';
import { workspaceAPI } from '../../services/api';

vi.mock('../../services/api', () => ({ workspaceAPI: { getAccessHistory: vi.fn() } }));

afterEach(cleanup);

const ROWS = [
  { id: 3, action: 'role_changed', actorEmail: 'sxu@bgc.ca', targetEmail: 'mshahidullah@bgc.ca', oldValue: 'admin', newValue: 'reviewer', createdAt: '2026-11-18T22:13:55Z' },
  { id: 2, action: 'api_key_created', actorEmail: 'mshahidullah@bgc.ca', targetLabel: 'Mo_TicketPulse_API', details: { kind: 'api_key', scopes: ['tickets:read', 'tickets:write'], ipAllowlist: [], prefix: 'tp_live_1tUh' }, createdAt: '2026-11-18T20:54:54Z' },
  { id: 1, action: 'role_changed', actorEmail: 'sxu@bgc.ca', targetEmail: 'mshahidullah@bgc.ca', oldValue: 'reviewer', newValue: 'admin', createdAt: '2026-11-18T20:33:31Z' },
];

describe('describeAccessEvent', () => {
  test('reads as plain sentences', () => {
    expect(describeAccessEvent(ROWS[2])).toBe('sxu changed mshahidullah@bgc.ca from Reviewer to Admin');
    expect(describeAccessEvent(ROWS[1])).toBe('mshahidullah created API key "Mo_TicketPulse_API"');
    expect(describeAccessEvent({ action: 'access_revoked', actorEmail: 'v@x', targetEmail: 'a@x', oldValue: 'reviewer' })).toBe("v removed a@x's access (was Reviewer)");
    expect(describeAccessEvent({ action: 'admin_list_changed', actorEmail: 'v@x', details: { added: ['n@x'], removed: [] } })).toBe('v changed the super admin list: added n@x');
    expect(describeAccessEvent({ action: 'oauth_client_enabled', actorEmail: 'v@x', targetLabel: 'Simorgh' })).toBe('v switched back on OAuth client "Simorgh"');
  });

  test('credential detail shows access and a missing IP lock', () => {
    expect(credentialDetail(ROWS[1])).toBe('tickets:read, tickets:write · no IP lock · tp_live_1tUh');
    expect(credentialDetail({ action: 'api_key_updated', details: { kind: 'api_key', changed: { isEnabled: { from: true, to: false } } } })).toBe('switched off');
  });
});

describe('AccessHistory', () => {
  test('lists the events newest first', async () => {
    workspaceAPI.getAccessHistory.mockResolvedValue({ data: { items: ROWS, nextBefore: null } });
    render(<AccessHistory workspaceId={1} />);
    expect(await screen.findByText('sxu changed mshahidullah@bgc.ca from Admin to Reviewer')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent('Mo_TicketPulse_API');
    expect(workspaceAPI.getAccessHistory).toHaveBeenCalledWith(1, expect.objectContaining({ limit: 50 }));
  });

  test('says when nothing is recorded yet', async () => {
    workspaceAPI.getAccessHistory.mockResolvedValue({ data: { items: [], nextBefore: null } });
    render(<AccessHistory workspaceId={1} />);
    expect(await screen.findByText(/Recording started on 20 Nov 2026/)).toBeInTheDocument();
  });
});
