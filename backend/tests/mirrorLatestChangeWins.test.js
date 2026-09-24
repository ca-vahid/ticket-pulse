import { jest } from '@jest/globals';

/**
 * Latest change wins (Vahid, 23 Sep 2026, plans/PENDING_RESPONSE_STATUS_SYNC.md):
 * a Ticket Pulse ticket whose FreshService copy was closed or reassigned in
 * FreshService AFTER Ticket Pulse's own last change takes that change. It
 * used to be ignored and logged as a "mirror conflict" (TP-1294 stayed Open
 * after Mehdi closed it in FreshService).
 */
const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticketActivity: { findFirst: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn() },
};
const changeStatus = jest.fn().mockResolvedValue({ changed: true });
const assignTicket = jest.fn().mockResolvedValue({ changed: true });
const deleteTicket = jest.fn().mockResolvedValue({ deleted: true });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { buffersForThreadEntry: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => ({})) }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn() }, emitTicketEvent: jest.fn(),
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { changeStatus, assignTicket, deleteTicket } }));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

const TICKET = {
  id: 44444, workspaceId: 1, nativeNumber: 1294, origin: 'ticketpulse', status: 'Open',
  freshserviceTicketId: 241865, mirrorState: 'mirrored', createdAt: new Date('2026-09-11T23:34:00Z'),
  assignedTech: { freshserviceId: 1000530661n, name: 'Mehdi Abbaspour' },
};
const closedByMehdi = [
  { created_at: '2026-09-23T18:08:49Z', actor: { name: 'Mehdi Abbaspour', type: 'agent' }, content: ' set Status as Closed and set Group as Everyone IT' },
];
const clientWith = (activities) => ({ fetchTicketActivities: jest.fn().mockResolvedValue(activities) });

describe('mirrorService._applyLatestChangeWins', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticketActivity.findFirst.mockResolvedValue(null); // no TP status change since creation
    mirrorService._latestWinsRepushAt = new Map();
  });

  test('a close made in FreshService after Ticket Pulse\'s last change is adopted, attributed, not written back', async () => {
    const client = clientWith(closedByMehdi);
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 5 }, client, { statusDrift: true, assigneeDrift: false });

    expect(out.status).toBe(true);
    expect(changeStatus).toHaveBeenCalledWith(44444, 1, 'Closed', expect.objectContaining({ name: 'Mehdi Abbaspour (in FreshService)' }), { fromFreshService: true });
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
  });

  test('Ticket Pulse changed it later: Ticket Pulse keeps its value and re-queues it to the copy', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ performedAt: new Date('2026-09-23T19:00:00Z') });
    const enqueue = jest.spyOn(mirrorService, 'enqueueFieldSync').mockResolvedValue({});
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 5 }, clientWith(closedByMehdi), { statusDrift: true, assigneeDrift: false });

    expect(out.status).toBe(false);
    expect(changeStatus).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(1, 44444);
    enqueue.mockRestore();
  });

  test('our own write-back echo ("Ticket Pulse" actor) is never adopted', async () => {
    const echo = [{ created_at: '2026-09-23T18:08:49Z', actor: { name: 'Ticket Pulse' }, content: ' set Status as Closed' }];
    jest.spyOn(mirrorService, 'enqueueFieldSync').mockResolvedValue({});
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 5 }, clientWith(echo), { statusDrift: true, assigneeDrift: false });
    expect(out.status).toBe(false);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  test('a DELETED FreshService copy deletes the Ticket Pulse ticket too (soft delete, attributed, no echo)', async () => {
    const deleted = [
      { created_at: '2026-09-23T19:46:48Z', actor: { name: 'Ticket Workflow' }, content: ' executed Ticket Deleted workflow', sub_contents: ['set Status as Closed'] },
      { created_at: '2026-09-23T19:46:47Z', actor: { name: 'Sam Khadem' }, content: ' deleted this ticket' },
    ];
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 5, deleted: true }, clientWith(deleted), { statusDrift: true, assigneeDrift: false });
    expect(out.status).toBe(true);
    expect(deleteTicket).toHaveBeenCalledWith(44444, 1, expect.objectContaining({ name: 'Sam Khadem (in FreshService)' }), { fromFreshService: true });
    expect(changeStatus).not.toHaveBeenCalled();
  });

  test('a Ticket Pulse change still queued for FreshService wins without asking FreshService', async () => {
    const client = clientWith(closedByMehdi);
    const out = await mirrorService._applyLatestChangeWins({ ...TICKET, mirrorState: 'pending' }, { status: 5 }, client, { statusDrift: true, assigneeDrift: false });
    expect(out.status).toBe(false);
    expect(client.fetchTicketActivities).not.toHaveBeenCalled();
  });

  test('an agent change in FreshService is adopted when the agent is a technician here', async () => {
    const reassigned = [{ created_at: '2026-09-23T18:00:00Z', actor: { name: 'Anton Kuzmychev', type: 'agent' }, content: ' set Agent as Gaby Tonnova' }];
    prismaMock.technician.findFirst.mockResolvedValue({ id: 38, name: 'Gaby Tonnova' });
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 2, responder_id: 1000999 }, clientWith(reassigned), { statusDrift: false, assigneeDrift: true });
    expect(out.agent).toBe(true);
    expect(assignTicket).toHaveBeenCalledWith(44444, 1, 38, expect.objectContaining({ name: 'Anton Kuzmychev (in FreshService)' }), { fromFreshService: true });
  });

  test('Deleted/Spam Ticket Pulse tickets are never revived', async () => {
    const client = clientWith(closedByMehdi);
    const out = await mirrorService._applyLatestChangeWins({ ...TICKET, status: 'Deleted' }, { status: 2 }, client, { statusDrift: true, assigneeDrift: false });
    expect(out).toEqual({ status: false, agent: false, notes: [] });
    expect(client.fetchTicketActivities).not.toHaveBeenCalled();
  });
});

describe('mirrorService._reconcileTicketAgainstFs — compares the ticket as it is now', () => {
  test('a change made while the pass waited in the queue is not a conflict (TP-1621)', async () => {
    jest.clearAllMocks();
    // Pass loaded the ticket as Open; Power Apps closed it before the FS read came back.
    prismaMock.ticket.findUnique.mockResolvedValue({ status: 'Closed', assignedTechId: 7, assignedTech: TICKET.assignedTech });
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    const recordConflict = jest.spyOn(mirrorService, '_recordMirrorConflict').mockResolvedValue();
    const latestWins = jest.spyOn(mirrorService, '_applyLatestChangeWins');
    jest.spyOn(mirrorService, '_fsStatusCode').mockImplementation(async (t) => (t.status === 'Closed' ? 5 : 2));
    const client = {
      fetchTicketSafe: jest.fn().mockResolvedValue({ id: 241865, status: 5, responder_id: 1000530661 }),
      fetchTicket: jest.fn().mockResolvedValue({ id: 241865, status: 5, responder_id: 1000530661 }),
      fetchTicketConversations: jest.fn().mockResolvedValue([]),
      fetchTicketActivities: jest.fn().mockResolvedValue([]),
    };

    const out = await mirrorService._reconcileTicketAgainstFs({ ...TICKET, status: 'Open' }, client);

    expect(out.conflicts).toBe(0);
    expect(recordConflict).not.toHaveBeenCalled();
    expect(latestWins).not.toHaveBeenCalled();
    recordConflict.mockRestore();
    latestWins.mockRestore();
    mirrorService._fsStatusCode.mockRestore();
  });
});

describe('mirrorService._reconcileTicketAgainstFs — our write still queued', () => {
  test('the copy lagging behind a queued Ticket Pulse change is not a conflict (TP-1547)', async () => {
    jest.clearAllMocks();
    prismaMock.ticket.findUnique.mockResolvedValue({ status: 'Pending', mirrorState: 'pending', assignedTechId: 7, assignedTech: TICKET.assignedTech });
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    const recordConflict = jest.spyOn(mirrorService, '_recordMirrorConflict').mockResolvedValue();
    const latestWins = jest.spyOn(mirrorService, '_applyLatestChangeWins');
    jest.spyOn(mirrorService, '_fsStatusCode').mockImplementation(async (t) => (t.status === 'Pending' ? 3 : 2));
    const client = {
      fetchTicketSafe: jest.fn().mockResolvedValue({ id: 241865, status: 2, responder_id: 1000530661 }),
      fetchTicketConversations: jest.fn().mockResolvedValue([]),
    };

    const out = await mirrorService._reconcileTicketAgainstFs({ ...TICKET, status: 'Open', mirrorState: 'mirrored' }, client);

    expect(out.conflicts).toBe(0);
    expect(recordConflict).not.toHaveBeenCalled();
    expect(latestWins).not.toHaveBeenCalled();
    recordConflict.mockRestore();
    latestWins.mockRestore();
    mirrorService._fsStatusCode.mockRestore();
  });
});

describe('mirrorService.reconcile — recently closed tickets rotate', () => {
  test('each pass takes the NEXT slice, so every recently closed ticket is reached (TP-1597 was 15th of 23)', async () => {
    jest.clearAllMocks();
    mirrorService._recentClosedOffset = new Map();
    jest.spyOn(mirrorService, '_getClient').mockResolvedValue({});
    const seen = jest.spyOn(mirrorService, '_reconcileTicketAgainstFs').mockResolvedValue({ imported: 0, conflicts: 0 });
    const closed = Array.from({ length: 23 }, (_, i) => ({ id: 1000 + i }));
    prismaMock.ticket.findMany.mockImplementation(async ({ where, skip = 0, take }) => (
      where.status?.in?.includes('Closed') ? closed.slice(skip, skip + take) : []
    ));
    const reached = new Set();
    for (let pass = 0; pass < 3; pass++) {
      seen.mockClear();
      await mirrorService.reconcile(1, { activeOnly: true, limit: 30 });
      for (const [t] of seen.mock.calls) reached.add(t.id);
    }
    expect(reached.size).toBe(23);
    expect(mirrorService._recentClosedOffset.get(1)).toBe(0); // wrapped round after the short last slice
  });
});
