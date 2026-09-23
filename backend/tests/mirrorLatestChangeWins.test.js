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
