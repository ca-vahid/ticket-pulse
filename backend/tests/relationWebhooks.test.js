import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Simorgh ask 3 (Phase B-2): relation and task webhooks, with the payload the
 * Simorgh team asked for on 19 Sep — workspace id and the ticket's externalRef
 * on every task event; assignee and completion time on the task.
 */
const dispatch = jest.fn();
const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketTask: {
    findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }), aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 0 } }),
  },
  technician: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketActivity: { create: jest.fn().mockResolvedValue({}) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ dispatchWebhookEvent: dispatch, WEBHOOK_EVENTS: [] }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { getInteractiveClient: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ticketTaskService, TASK_UPDATED_COALESCE_MS } = await import('../src/services/ticketTaskService.js');
const { taskEventPayload, ticketRef, actorRef } = await import('../src/services/relationWebhookPayload.js');

const TICKET = { id: 44797, workspaceId: 1, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 1504, subject: 'Sentinel incident', status: 'Open', externalRef: 'simorgh:sentinel:234bcf5b', assignedTechId: 7, assignedTech: { id: 7, name: 'Anton Kuzmychev', email: 'akuzmychev@x.io' } };
const SIMORGH = { role: 'api', name: 'Simorgh', email: 'apikey:tpc_890e' };
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
  prismaMock.ticketTask.findFirst.mockResolvedValue(null);
  let last = null;
  prismaMock.ticketTask.create.mockImplementation(async ({ data }) => { last = { id: 812, ...data, assignedTech: null, createdAt: new Date('2026-09-19T20:00:00Z'), updatedAt: new Date('2026-09-19T20:00:00Z') }; return last; });
  prismaMock.ticketTask.update.mockImplementation(async ({ data }) => { last = { ...last, ...data, updatedAt: new Date() }; return last; });
});

describe('payload', () => {
  test('carries workspace id, the ticket externalRef, the task assignee and completion time, and who did it', () => {
    const out = taskEventPayload(TICKET, { id: 812, title: 'Isolate', status: 'done', externalRef: 'simorgh:action:9f2c', assignedTech: { id: 7, name: 'Anton Kuzmychev', email: 'akuzmychev@x.io' }, dueAt: new Date('2026-09-19T21:00:00Z'), completedAt: new Date('2026-09-19T20:41:07Z') }, SIMORGH);
    expect(out).toEqual({
      workspaceId: 1,
      ticket: { id: 44797, ref: 'TP-1504', subject: 'Sentinel incident', status: 'Open', externalRef: 'simorgh:sentinel:234bcf5b', workspaceId: 1 },
      task: expect.objectContaining({ id: 812, status: 'done', externalRef: 'simorgh:action:9f2c', assignee: { id: 7, name: 'Anton Kuzmychev', email: 'akuzmychev@x.io' }, dueAt: '2026-09-19T21:00:00.000Z', completedAt: '2026-09-19T20:41:07.000Z' }),
      actor: { kind: 'api', name: 'Simorgh', email: null, technicianId: null },
    });
  });

  test('a person is a human actor with their address; a workflow is a workflow', () => {
    expect(actorRef({ role: 'admin', name: 'Vahid Haeri', email: 'vhaeri@x.io', technicianId: 3 })).toEqual({ kind: 'human', name: 'Vahid Haeri', email: 'vhaeri@x.io', technicianId: 3 });
    expect(actorRef({ role: 'workflow', name: 'Notification workflow' }).kind).toBe('workflow');
    expect(ticketRef(null)).toBeNull();
  });
});

describe('task events', () => {
  test('task.created fires at once with the task and the ticket', async () => {
    await ticketTaskService.create(44797, 1, { title: 'Isolate LAPTOP-4471', externalRef: 'simorgh:action:9f2c' }, SIMORGH);
    await flush();
    expect(dispatch).toHaveBeenCalledWith(1, 'task.created', expect.objectContaining({ workspaceId: 1, ticket: expect.objectContaining({ ref: 'TP-1504', externalRef: 'simorgh:sentinel:234bcf5b' }), task: expect.objectContaining({ title: 'Isolate LAPTOP-4471', externalRef: 'simorgh:action:9f2c' }) }));
  });

  test('a create-or-return hit fires nothing (nothing was created)', async () => {
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 77, title: 'Isolate', status: 'open', externalRef: 'x', assignedTech: null });
    await ticketTaskService.create(44797, 1, { title: 'Isolate', externalRef: 'x' }, SIMORGH);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('task.completed fires at once when status moves to done', async () => {
    const row = { id: 812, ticketId: 44797, title: 'Isolate', status: 'open', fsTaskId: null, assignedTechId: null, assignedTech: null };
    prismaMock.ticketTask.findFirst.mockResolvedValue(row);
    prismaMock.ticketTask.update.mockImplementation(async ({ data }) => ({ ...row, ...data, updatedAt: new Date() }));
    await ticketTaskService.update(812, 1, { status: 'done' }, { role: 'admin', name: 'Soheil Nasiri', email: 's@x.io' }, 44797);
    await flush();
    expect(dispatch).toHaveBeenCalledWith(1, 'task.completed', expect.objectContaining({ task: expect.objectContaining({ id: 812, status: 'done', completedAt: expect.any(String) }), actor: expect.objectContaining({ kind: 'human', name: 'Soheil Nasiri' }) }));
  });

  test('task.updated is coalesced: three edits inside the window → one delivery with the latest row', async () => {
    const row = { id: 812, ticketId: 44797, title: 'Isolate', status: 'open', fsTaskId: null, assignedTechId: null, assignedTech: null };
    prismaMock.ticketTask.findFirst.mockResolvedValue(row);
    prismaMock.ticketTask.update.mockImplementation(async ({ data }) => ({ ...row, ...data, updatedAt: new Date() }));
    await ticketTaskService.update(812, 1, { description: 'v1' }, SIMORGH, 44797);
    await ticketTaskService.update(812, 1, { description: 'v2' }, SIMORGH, 44797);
    await ticketTaskService.update(812, 1, { description: 'v3' }, SIMORGH, 44797);
    expect(dispatch).not.toHaveBeenCalled();
    prismaMock.ticketTask.findFirst.mockResolvedValue({ id: 812, title: 'Isolate', description: 'v3', status: 'open', assignedTech: null });
    expect(await ticketTaskService.flushTaskUpdates()).toBe(1);
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1]).toBe('task.updated');
    expect(dispatch.mock.calls[0][2].task.description).toBe('v3');
    expect(TASK_UPDATED_COALESCE_MS).toBe(60000);
  });
});
