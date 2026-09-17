import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 17 Sep 2026: FreshService LIST payloads carry no approval_status (verified on 60
 * tickets / 39 service requests); only the single-ticket VIEW does. The verdict and
 * the hand-out check therefore refresh the tickets they judge from the view.
 */
const update = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: { ticket: { update } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { refreshFsApprovalStatus, refreshFsApprovalStatuses, resetFsApprovalRefreshCache } = await import('../src/services/fsApprovalRefreshService.js');

const ticket = (over = {}) => ({ id: 1, workspaceId: 1, freshserviceTicketId: 219171n, fsApprovalStatus: null, fsApprovalStatusName: null, ...over });
const clientReturning = (view) => ({ fetchTicket: jest.fn(async () => view) });

beforeEach(() => { update.mockClear(); resetFsApprovalRefreshCache(); });

describe('refreshFsApprovalStatus', () => {
  test('reads the view, persists and mutates when FreshService has an approval', async () => {
    const t = ticket();
    const client = clientReturning({ id: 219171, approval_status: 1, approval_status_name: 'Approved' });
    const out = await refreshFsApprovalStatus(t, { client });
    expect(out).toEqual({ fsApprovalStatus: 1, fsApprovalStatusName: 'Approved' });
    expect(t.fsApprovalStatusName).toBe('Approved');
    expect(update).toHaveBeenCalledWith({ where: { id: 1 }, data: { fsApprovalStatus: 1, fsApprovalStatusName: 'Approved' } });
  });

  test('an incident (no approval_status on the view) changes nothing and persists nothing', async () => {
    const t = ticket();
    await refreshFsApprovalStatus(t, { client: clientReturning({ id: 5, type: 'Incident' }) });
    expect(t.fsApprovalStatusName).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  test('APPROVED is final — never re-fetched', async () => {
    const client = clientReturning({ approval_status: 2, approval_status_name: 'Rejected' });
    const t = ticket({ fsApprovalStatus: 1, fsApprovalStatusName: 'Approved' });
    await refreshFsApprovalStatus(t, { client });
    expect(client.fetchTicket).not.toHaveBeenCalled();
    expect(t.fsApprovalStatusName).toBe('Approved');
  });

  test('a second lookup inside five minutes does not hit FreshService again', async () => {
    const client = clientReturning({ approval_status: 0, approval_status_name: 'Requested' });
    const t = ticket();
    await refreshFsApprovalStatus(t, { client, now: 1_000_000 });
    await refreshFsApprovalStatus(t, { client, now: 1_000_000 + 60_000 });
    expect(client.fetchTicket).toHaveBeenCalledTimes(1);
    await refreshFsApprovalStatus(t, { client, now: 1_000_000 + 6 * 60_000 });
    expect(client.fetchTicket).toHaveBeenCalledTimes(2);
  });

  test('a FreshService failure keeps the stored value and never throws', async () => {
    const t = ticket({ fsApprovalStatus: 0, fsApprovalStatusName: 'Requested' });
    const client = { fetchTicket: jest.fn(async () => { throw new Error('429'); }) };
    const out = await refreshFsApprovalStatus(t, { client });
    expect(out).toEqual({ fsApprovalStatus: 0, fsApprovalStatusName: 'Requested' });
    expect(update).not.toHaveBeenCalled();
  });

  test('tickets without a FreshService id are skipped; batches refresh at most five', async () => {
    const client = clientReturning({ approval_status: 1, approval_status_name: 'Approved' });
    const tp = ticket({ id: 9, freshserviceTicketId: null });
    await refreshFsApprovalStatus(tp, { client });
    expect(client.fetchTicket).not.toHaveBeenCalled();
    const many = Array.from({ length: 7 }, (_, i) => ticket({ id: 100 + i, freshserviceTicketId: BigInt(1000 + i) }));
    await refreshFsApprovalStatuses(many, { client });
    expect(client.fetchTicket).toHaveBeenCalledTimes(5);
  });
});
