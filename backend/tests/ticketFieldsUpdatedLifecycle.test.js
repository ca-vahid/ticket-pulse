import { jest } from '@jest/globals';

// MEGA 09-01 Phase TU (TU-10/TU-12) — the lifecycle side of
// ticket.fields_updated: the FS-side diff is derived only for sync sources
// (a TP-native status/assign write never diffs fields — ticketService owns
// that event), both echo guards suppress Ticket Pulse's own write-backs
// coming back through the sync, every lifecycle event now carries
// actorKind/source, and the created event carries suppressRequesterAck.

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  technician: { findUnique: jest.fn() },
  ticketActivity: { findFirst: jest.fn().mockResolvedValue(null) },
  ticketThreadEntry: { findMany: jest.fn().mockResolvedValue([]) },
  competencyCategory: { findUnique: jest.fn() },
  group: { findFirst: jest.fn(), findUnique: jest.fn() },
  requester: { findUnique: jest.fn() },
};
const engineMock = { executeForEvent: jest.fn().mockResolvedValue({ status: 'completed' }) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: engineMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  deriveTicketLifecycleEvents,
  diffTrackedFields,
  emitTicketLifecycleNotifications,
} = await import('../src/services/ticketLifecycleNotificationService.js');

const hydratedTicket = {
  id: 501, workspaceId: 1, freshserviceTicketId: BigInt(90001), subject: 'Projector flickers', descriptionText: 'flickers',
  status: 'Open', priority: 3, toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], groupId: BigInt(1000210021),
  createdAt: new Date('2026-07-06T09:00:00.000Z'),
  workspace: { name: 'IT', defaultTimezone: 'America/Vancouver' },
  requester: { id: 40, name: 'Rita', email: 'rita@example.com' },
  assignedTech: null, internalCategory: { id: 5, name: 'AV' }, internalSubcategory: null,
};

const existing = { id: 501, workspaceId: 1, assignedTechId: null, status: 'Open', priority: 2, subject: 'Projector flickers', category: 'Hardware', ccEmails: [] };
const upsertedAt = new Date('2026-07-06T10:00:00.000Z');

function contexts(type = 'ticket.fields_updated') {
  return engineMock.executeForEvent.mock.calls.map(([ctx]) => ctx).filter((ctx) => ctx.event.type === type);
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...hydratedTicket });
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
});

describe('diffTrackedFields / deriveTicketLifecycleEvents (pure)', () => {
  test('tracks the FS-editable fields, ignores keys absent from the payload, normalizes dates/cc/group', () => {
    const changes = diffTrackedFields(
      { ...existing, dueBy: new Date('2026-07-10T00:00:00Z'), groupId: BigInt(1), ccEmails: ['A@x.com'] },
      { priority: 3, dueBy: '2026-07-11T00:00:00.000Z', groupId: 2, ccEmails: ['b@x.com', 'a@x.com'], subject: 'Projector flickers' },
    );
    expect(Object.keys(changes).sort()).toEqual(['ccEmails', 'dueBy', 'groupId', 'priority']);
    expect(changes.priority).toEqual({ from: 2, to: 3 });
    expect(changes.dueBy).toEqual({ from: '2026-07-10T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' });
    expect(changes.groupId).toEqual({ from: '1', to: '2' });
    expect(changes.ccEmails).toEqual({ from: ['a@x.com'], to: ['a@x.com', 'b@x.com'] });
    // Status / assignee are never field changes here.
    expect(diffTrackedFields(existing, { status: 'Closed', assignedTechId: 9 })).toEqual({});
  });

  test('fields_updated is derived only with includeFieldDiff (default off keeps every legacy assertion intact)', () => {
    const upserted = { ...existing, priority: 3, freshserviceUpdatedAt: upsertedAt };
    expect(deriveTicketLifecycleEvents(existing, upserted).map((e) => e.type)).toEqual([]);
    const events = deriveTicketLifecycleEvents(existing, upserted, { includeFieldDiff: true });
    expect(events.map((e) => e.type)).toEqual(['ticket.fields_updated']);
    expect(events[0].extra).toEqual({
      changes: { priority: { from: 2, to: 3 } }, changedFields: ['priority'], actorKind: 'freshservice', source: 'freshservice_sync',
    });
    // Stable across a re-sync of the same FS updated_at.
    expect(events[0].dedupeStamp).toBe('fields:501:fs:2026-07-06T10:00:00.000Z:priority');
  });
});

describe('emitTicketLifecycleNotifications — FS-side field diff (opt-in at the trigger, guarded here)', () => {
  test('a sync-observed priority change dispatches fields_updated with actorKind freshservice + the FS actor name', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ actorName: 'Sam Servicedesk', content: 'set Priority as High' }]);
    const result = await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, priority: 3, freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    expect(result.events).toEqual(['ticket.fields_updated']);
    const [ctx] = contexts();
    expect(ctx.event.extra).toEqual(expect.objectContaining({
      actorKind: 'freshservice', actorName: 'Sam Servicedesk', source: 'freshservice_sync', changedFields: ['priority'], changedCount: 1,
    }));
    expect(ctx.event.extra.changes.priority).toEqual(expect.objectContaining({ from: 2, to: 3, fromLabel: 'Medium (2)', toLabel: 'High (3)' }));
    expect(ctx.ticket.groupId).toBe('1000210021');
  });

  test('a TP-native write (status/assign paths) never derives a field diff — ticketService owns that event', async () => {
    const result = await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, priority: 3, status: 'Pending', updatedAt: upsertedAt },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
      actorKind: 'api',
    });
    expect(result.events).toEqual(['ticket.status_changed']);
    expect(contexts()).toHaveLength(0);
    // Provenance on the status event (TU-10): the caller's kind + the dispatch source.
    const [statusCtx] = contexts('ticket.status_changed');
    expect(statusCtx.event.extra).toEqual(expect.objectContaining({ from: 'Open', to: 'Pending', actorKind: 'api', source: 'ticketpulse_native' }));
  });

  test('echo guard 1: a fs_write_back audit row (≤10 min) covering the same fields suppresses the event', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ details: { changes: { priority: { from: 2, to: 3 } } } });
    const result = await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, priority: 3, freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    expect(result.status).toBe('skipped');
    expect(engineMock.executeForEvent).not.toHaveBeenCalled();
    expect(prismaMock.ticketActivity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ticketId: 501, activityType: 'fs_write_back' }),
    }));
  });

  test('echo guard 1 does not suppress a wider change (priority written back, subject changed by a human in FS)', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ details: { changes: { priority: { from: 2, to: 3 } } } });
    await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, priority: 3, subject: 'Projector flickers badly', freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    expect(contexts()).toHaveLength(1);
  });

  test('echo guard 2: "Ticket Pulse" as the FS actor drops the TP category fields; nothing left → no event', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ actorName: 'Ticket Pulse', content: 'set Ticket Pulse Category as AV' }]);
    const suppressed = await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, category: 'AV', ticketCategory: 'AV', freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    expect(suppressed.status).toBe('skipped');
    expect(contexts()).toHaveLength(0);

    // A genuine FS edit riding alongside the echo still fires — minus the echoed keys.
    await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, category: 'AV', priority: 4, freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    const [ctx] = contexts();
    expect(ctx.event.extra.changedFields).toEqual(['priority']);
  });

  test('sync passes with no field difference emit nothing (mirror sweeps / reconcile echoes are silent)', async () => {
    const result = await emitTicketLifecycleNotifications({
      existingTicket: existing,
      upsertedTicket: { ...existing, freshserviceUpdatedAt: upsertedAt },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });
    expect(result.status).toBe('skipped');
    expect(engineMock.executeForEvent).not.toHaveBeenCalled();
  });
});

describe('ticket.created with suppressRequesterAck', () => {
  test('the event still fires and carries extra.suppressRequesterAck for the engine recipient drop', async () => {
    const result = await emitTicketLifecycleNotifications({
      existingTicket: null,
      upsertedTicket: { ...existing, createdAt: new Date('2026-07-06T09:00:00.000Z'), createdVia: 'agent_cc', suppressRequesterAck: true },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    });
    expect(result.events).toEqual(['ticket.created']);
    const [ctx] = contexts('ticket.created');
    expect(ctx.event.extra).toEqual(expect.objectContaining({ suppressRequesterAck: true, actorKind: 'human', source: 'ticketpulse_native' }));
    expect(ctx.ticket.createdVia).toBe('agent_cc');
  });

  test('a normal create carries no suppression flag', async () => {
    await emitTicketLifecycleNotifications({
      existingTicket: null,
      upsertedTicket: { ...existing, createdAt: new Date('2026-07-06T09:00:00.000Z') },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    });
    const [ctx] = contexts('ticket.created');
    expect(ctx.event.extra.suppressRequesterAck).toBeUndefined();
  });
});
