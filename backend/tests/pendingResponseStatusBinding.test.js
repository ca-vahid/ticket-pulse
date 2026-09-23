import {
  getStatusId,
  getStatusString,
  statusNameForFsStatus,
  transformTicket,
} from '../src/integrations/freshserviceTransformer.js';
import { setWorkspaceBindings, clearFsStatusBindings, titleCaseStatusLabel } from '../src/utils/fsStatusBindings.js';
import { latestFsFieldChanges } from '../src/utils/fsActivityChanges.js';

/**
 * Pending Response build (23 Sep 2026, plans/PENDING_RESPONSE_STATUS_SYNC.md).
 * FreshService status 6 is "Pending response" on this tenant; it synced in as
 * "Waiting on Customer" and "Pending Response" chosen in Ticket Pulse went to
 * FreshService as 3, so FreshService's pending-response rules never ran.
 */
describe('FreshService status binding', () => {
  afterEach(() => clearFsStatusBindings());

  test('status 6 reads "Pending Response", never "Waiting on Customer", even before bindings load', () => {
    expect(getStatusString(6)).toBe('Pending Response');
    expect(getStatusString(3)).toBe('Pending');
  });

  test('a bound registry name wins, by Ticket Pulse or FreshService workspace id', () => {
    setWorkspaceBindings(1, { fsWorkspaceId: 2, bindings: [{ fsId: 6, name: 'Awaiting Requester' }] });
    expect(getStatusString(6, { workspaceId: 1 })).toBe('Awaiting Requester');
    expect(statusNameForFsStatus(6, { fsWorkspaceId: 2 })).toBe('Awaiting Requester');
    expect(getStatusString(6, { workspaceId: 5 })).toBe('Pending Response');
  });

  test('unknown tenant status uses FreshService\'s own label (title case), not a silent Open', () => {
    setWorkspaceBindings(1, { fsWorkspaceId: 2, bindings: [], fsLabels: { 9: 'on hold for vendor' } });
    expect(getStatusString(9, { workspaceId: 1 })).toBe('On Hold For Vendor');
    expect(getStatusString(9, { workspaceId: 3 })).toBe('Open');
  });

  test('write-back: "Pending Response" sends 6; custom Pending-base labels still send 3', () => {
    expect(getStatusId('Pending Response', { baseStatus: 'Pending' })).toBe(6);
    expect(getStatusId('pending response', { baseStatus: 'Pending' })).toBe(6);
    expect(getStatusId('Needs Rework', { baseStatus: 'Pending' })).toBe(3);
    expect(getStatusId('Resolved')).toBe(4);
    expect(getStatusId('Mystery')).toBeNull();
  });

  test('write-back prefers the workspace binding', () => {
    setWorkspaceBindings(4, { bindings: [{ fsId: 8, name: 'Waiting on Vendor' }] });
    expect(getStatusId('Waiting on Vendor', { baseStatus: 'Pending', workspaceId: 4 })).toBe(8);
    expect(getStatusId('Waiting on Vendor', { baseStatus: 'Pending', workspaceId: 1 })).toBe(3);
  });

  test('the batch transformer maps through the FreshService workspace on the payload', () => {
    setWorkspaceBindings(1, { fsWorkspaceId: 2, bindings: [{ fsId: 6, name: 'Pending Response' }] });
    const t = transformTicket({ id: 101, subject: 'x', status: 6, workspace_id: 2, requester: {} });
    expect(t.status).toBe('Pending Response');
  });

  test('title case for auto-created rows', () => {
    expect(titleCaseStatusLabel('Pending response')).toBe('Pending Response');
  });
});

describe('latestFsFieldChanges (FreshService activity feed)', () => {
  // Real shapes from production, 23 Sep 2026 (TP-1294, TP-1514, TP-1120).
  const tp1294 = [
    { created_at: '2026-09-23T18:08:49Z', actor: { name: 'Mehdi Abbaspour', type: 'agent' }, content: ' set Status as Closed and set Group as Everyone IT', sub_contents: ['System applied Business Hours BGC Support Hours'] },
    { created_at: '2026-09-23T18:08:33Z', actor: { name: 'Mehdi Abbaspour' }, content: ' added a private note' },
    { created_at: '2026-09-11T23:39:22Z', actor: { name: 'Sam Khadem' }, content: ' set Ticket Accepted as true' },
  ];
  const tp1514 = [
    { created_at: '2026-09-23T19:46:48Z', actor: { name: 'Ticket Workflow' }, content: ' executed Ticket Deleted workflow from Orchestration Listener event', sub_contents: ['set Status as Closed', 'Workflow Ends'] },
    { created_at: '2026-09-23T19:46:47Z', actor: { name: 'Sam Khadem' }, content: ' deleted this ticket' },
  ];
  const tp1120 = [
    { created_at: '2026-08-25T22:25:36Z', actor: { name: 'Mehdi Abbaspour' }, content: ' set Status as Closed' },
    { created_at: '2026-08-17T14:30:33Z', actor: { name: 'Anton Kuzmychev' }, content: ' set Agent as Mehdi Abbaspour and set Group as Everyone IT', sub_contents: ['System set due by time as Tue, 18 Aug, 2026  1:44 PM'] },
    { created_at: '2026-08-14T23:35:35Z', actor: { name: 'Ticket Pulse' }, content: ' set Agent as Anton Kuzmychev', sub_contents: ['set Ticket Pulse Category as Cloud & Servers'] },
  ];

  test('a person closing the copy in FreshService', () => {
    const c = latestFsFieldChanges(tp1294);
    expect(c.status).toMatchObject({ value: 'Closed', actor: 'Mehdi Abbaspour' });
    expect(c.status.at.toISOString()).toBe('2026-09-23T18:08:49.000Z');
    expect(c.agent).toBeNull();
    expect(c.deletedBy).toBeNull();
  });

  test('a deleted copy is reported as deleted, with who did it', () => {
    const c = latestFsFieldChanges(tp1514);
    expect(c.deletedBy).toMatchObject({ actor: 'Sam Khadem' });
  });

  test('our own write-backs ("Ticket Pulse") are echoes, never someone else\'s change', () => {
    const c = latestFsFieldChanges(tp1120);
    expect(c.agent).toMatchObject({ value: 'Mehdi Abbaspour', actor: 'Anton Kuzmychev' });
    expect(c.status).toMatchObject({ value: 'Closed', actor: 'Mehdi Abbaspour' });
    const onlyOurs = latestFsFieldChanges([tp1120[2]]);
    expect(onlyOurs.agent).toBeNull();
  });
});
