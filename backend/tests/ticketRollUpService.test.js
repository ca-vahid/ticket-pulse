import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Parent / child roll-up (Simorgh B8 — Vahid, 19 Sep 2026): a parent cannot
 * close while a child is open; nothing closes automatically; when the last
 * child is done the parent is marked ready, its owner is e-mailed once and
 * ticket.ready_to_close is emitted.
 */
const tickets = new Map();
const links = [];
const prismaMock = {
  ticket: {
    findFirst: jest.fn(async ({ where }) => { const t = tickets.get(where.id); return t && t.workspaceId === where.workspaceId ? { ...t, assignedTech: t.assignedTech || null } : null; }),
    update: jest.fn(async ({ where, data }) => { Object.assign(tickets.get(where.id), data); return tickets.get(where.id); }),
  },
  ticketLink: {
    findMany: jest.fn(async ({ where }) => links.filter((l) => l.workspaceId === where.workspaceId && l.ticketId === where.ticketId && l.kind === where.kind).map((l) => ({ ...l, relatedTicket: tickets.get(l.relatedTicketId) }))),
    findFirst: jest.fn(async ({ where }) => links.find((l) => l.workspaceId === where.workspaceId && l.relatedTicketId === where.relatedTicketId && l.kind === where.kind) || null),
  },
};
const activity = { create: jest.fn(async (r) => r) };
const email = { sendTransactionalEmail: jest.fn(async () => ({ sent: true })) };
const webhook = { dispatchWebhookEvent: jest.fn() };
const BASE = { Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed', 'Waiting on vendor': 'Pending', Fixed: 'Resolved' };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { baseStatusOf: jest.fn(async (ws, name) => BASE[name] ?? null) }, TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'] }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activity }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => email);
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => webhook);
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const rollUp = await import('../src/services/ticketRollUpService.js');

const OWNER = { id: 7, name: 'Anton Kuzmychev', email: 'akuzmychev@bgcengineering.ca' };
const put = (id, over = {}) => tickets.set(id, { id, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1600 + id, freshserviceTicketId: null, subject: `Story ${id}`, status: 'Open', readyToCloseAt: null, assignedTech: OWNER, ...over });
const child = (parentId, childId) => links.push({ id: links.length + 1, workspaceId: 1, ticketId: parentId, relatedTicketId: childId, kind: 'parent_of' });

beforeEach(() => {
  jest.clearAllMocks();
  tickets.clear(); links.length = 0;
  put(1); put(2, { status: 'Closed' }); put(3, { status: 'Open' }); put(4, { status: 'Fixed' });
  child(1, 2); child(1, 3);
});

describe('rule 1 — a parent cannot close over an open child', () => {
  test('409 open_children naming the open children only', async () => {
    await expect(rollUp.assertNoOpenChildren(1, 1)).rejects.toMatchObject({
      statusCode: 409, code: 'open_children',
      message: expect.stringMatching(/cannot be closed while a child ticket is still open: TP-1603/),
      details: { openChildren: [{ id: 3, ref: 'TP-1603', status: 'Open' }] },
    });
  });

  test('custom labels are judged by their BASE status', async () => {
    tickets.get(3).status = 'Waiting on vendor'; // Pending-base → still open
    await expect(rollUp.assertNoOpenChildren(1, 1)).rejects.toMatchObject({ code: 'open_children' });
    tickets.get(3).status = 'Fixed'; // Resolved-base → done
    await expect(rollUp.assertNoOpenChildren(1, 1)).resolves.toBeUndefined();
  });

  test('Deleted / Spam children never block', async () => {
    tickets.get(3).status = 'Spam';
    await expect(rollUp.assertNoOpenChildren(1, 1)).resolves.toBeUndefined();
  });

  test('a lookup failure fails OPEN — it never locks a ticket', async () => {
    prismaMock.ticketLink.findMany.mockRejectedValueOnce(new Error('db'));
    await expect(rollUp.assertNoOpenChildren(1, 1)).resolves.toBeUndefined();
  });

  test('no children → nothing to check', async () => {
    await expect(rollUp.assertNoOpenChildren(3, 1)).resolves.toBeUndefined();
  });
});

describe('rule 2 — ready to close, never closed for you', () => {
  test('last child done → parent marked, owner e-mailed once, history row, webhook; parent status untouched', async () => {
    tickets.get(3).status = 'Closed';
    const out = await rollUp.afterChildStatusChange(3, 1, { actor: { name: 'Soheil Nasiri' } });
    expect(out).toEqual({ changed: true, readyToClose: true });
    expect(tickets.get(1).readyToCloseAt).toBeInstanceOf(Date);
    expect(tickets.get(1).status).toBe('Open');
    expect(email.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(email.sendTransactionalEmail.mock.calls[0][0]).toMatchObject({ to: OWNER.email, subject: expect.stringMatching(/TP-1601 is ready to close — all 2 child tickets done/) });
    expect(activity.create.mock.calls[0][0]).toMatchObject({ ticketId: 1, activityType: 'ready_to_close', details: expect.objectContaining({ triggeredBy: 'Soheil Nasiri' }) });
    expect(webhook.dispatchWebhookEvent).toHaveBeenCalledWith(1, 'ticket.ready_to_close', expect.objectContaining({ ticket: expect.objectContaining({ ref: 'TP-1601' }), children: expect.arrayContaining([expect.objectContaining({ ref: 'TP-1603' })]) }));
  });

  test('already marked → no second e-mail', async () => {
    tickets.get(3).status = 'Closed';
    tickets.get(1).readyToCloseAt = new Date('2026-09-19T18:00:00Z');
    expect(await rollUp.afterChildStatusChange(3, 1)).toEqual({ changed: false });
    expect(email.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a child reopening clears the mark', async () => {
    tickets.get(3).status = 'Closed';
    tickets.get(1).readyToCloseAt = new Date();
    tickets.get(3).status = 'Open';
    expect(await rollUp.afterChildStatusChange(3, 1)).toEqual({ changed: true, readyToClose: false });
    expect(tickets.get(1).readyToCloseAt).toBeNull();
  });

  test('a parent that is itself closed is never "ready"', async () => {
    tickets.get(1).status = 'Closed'; tickets.get(3).status = 'Closed';
    expect(await rollUp.recomputeReadiness(1, 1)).toEqual({ changed: false });
  });

  test('a parent with no children is never "ready" (and loses a stale mark)', async () => {
    put(9, { readyToCloseAt: new Date() });
    expect(await rollUp.recomputeReadiness(9, 1)).toEqual({ changed: true, readyToClose: false });
  });

  test('a ticket with no parent → nothing happens', async () => {
    expect(await rollUp.afterChildStatusChange(1, 1)).toBeNull();
  });

  test('no owner → marked and emitted, no e-mail', async () => {
    tickets.get(1).assignedTech = null; tickets.get(3).status = 'Closed';
    expect(await rollUp.afterChildStatusChange(3, 1)).toEqual({ changed: true, readyToClose: true });
    expect(email.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(webhook.dispatchWebhookEvent).toHaveBeenCalled();
  });

  test('an e-mail failure never undoes the mark', async () => {
    email.sendTransactionalEmail.mockRejectedValue(new Error('smtp'));
    tickets.get(3).status = 'Closed';
    expect(await rollUp.afterChildStatusChange(3, 1)).toEqual({ changed: true, readyToClose: true });
    expect(tickets.get(1).readyToCloseAt).toBeInstanceOf(Date);
  });
});
