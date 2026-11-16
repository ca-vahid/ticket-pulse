import { jest } from '@jest/globals';

/**
 * A FreshService copy someone marked Spam (16 Nov 2026). FreshService refuses
 * every PUT on it (405 "PUT method is not allowed"), and the latest-change-wins
 * pass kept re-queueing the Ticket Pulse values to it every hour, each job
 * retrying until dead: about 28 errors an hour on four Accounting tickets.
 */
const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn(), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticketActivity: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  technician: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn().mockResolvedValue({ id: 2, isActive: true }) },
};
const changeStatus = jest.fn();
const assignTicket = jest.fn();
const deleteTicket = jest.fn();

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

const { default: mirrorService, isPutRefused, terminalMirrorError } = await import('../src/services/mirrorService.js');

const TICKET = {
  id: 70001, workspaceId: 2, nativeNumber: 9001, origin: 'ticketpulse', status: 'Closed',
  freshserviceTicketId: 250001, mirrorState: 'mirrored', createdAt: new Date('2026-11-10T17:00:00Z'),
  assignedTech: { freshserviceId: 1000000001n, name: 'Alex Rivera' },
};
const PUT_REFUSED = Object.assign(new Error('PUT method is not allowed. It should be one of these method(s): GET'), { freshserviceStatus: 405 });

describe('a FreshService copy in Spam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mirrorService._latestWinsRepushAt = new Map();
  });

  test('latest change wins leaves a Spam copy alone: nothing adopted, nothing re-queued', async () => {
    const enqueue = jest.spyOn(mirrorService, 'enqueueFieldSync').mockResolvedValue({});
    const client = { fetchTicketActivities: jest.fn().mockResolvedValue([]) };
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 2, spam: true, responder_id: null }, client, { statusDrift: true, assigneeDrift: true });

    expect(out).toEqual({ status: true, agent: true, notes: ['FS copy is in Spam; left alone'] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(changeStatus).not.toHaveBeenCalled();
    expect(assignTicket).not.toHaveBeenCalled();
    expect(deleteTicket).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  test('a copy that is not in Spam still gets the Ticket Pulse values re-queued', async () => {
    const enqueue = jest.spyOn(mirrorService, 'enqueueFieldSync').mockResolvedValue({});
    const client = { fetchTicketActivities: jest.fn().mockResolvedValue([]) };
    const out = await mirrorService._applyLatestChangeWins(TICKET, { status: 2, spam: false }, client, { statusDrift: true, assigneeDrift: false });

    expect(out.status).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(2, 70001);
    enqueue.mockRestore();
  });
});

describe('a 405 "PUT method is not allowed" ends the field sync job at once', () => {
  beforeEach(() => jest.clearAllMocks());

  test('isPutRefused reads the status or the message', () => {
    expect(isPutRefused(PUT_REFUSED)).toBe(true);
    expect(isPutRefused(new Error('PUT method is not allowed. It should be one of these method(s): GET'))).toBe(true);
    expect(isPutRefused(Object.assign(new Error('Validation failed'), { freshserviceStatus: 400 }))).toBe(false);
  });

  test('the field sync throws a terminal error on a 405', async () => {
    jest.spyOn(mirrorService, '_loadTicket').mockResolvedValue({ ...TICKET, subject: 'Invoice question', priority: 2, requester: { email: 'alex@example.com' } });
    jest.spyOn(mirrorService, '_skillCustomFields').mockResolvedValue(null);
    jest.spyOn(mirrorService, '_fsStatusCode').mockResolvedValue(5);
    const client = { updateTicket: jest.fn().mockRejectedValue(PUT_REFUSED) };

    await expect(mirrorService._mirrorFields({ id: 1, ticketId: 70001, workspaceId: 2, kind: 'update_fields', attempts: 0 }, client))
      .rejects.toMatchObject({ terminal: true, message: expect.stringMatching(/#250001 refuses updates/) });
    expect(client.updateTicket).toHaveBeenCalledTimes(1);
  });

  test('a terminal failure marks the job dead on its first attempt', async () => {
    await mirrorService._markFailed({ id: 9, kind: 'update_fields', ticketId: 70001, attempts: 0 }, 'refused', { terminal: true });
    expect(prismaMock.mirrorJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'dead', attempts: 1 }) }));
  });

  test('an ordinary failure still retries', async () => {
    await mirrorService._markFailed({ id: 10, kind: 'update_fields', ticketId: 70001, attempts: 0 }, 'timeout');
    expect(prismaMock.mirrorJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed', attempts: 1 }) }));
  });

  test('_executeJob passes the terminal flag through', async () => {
    jest.spyOn(mirrorService, '_workspaceActive').mockResolvedValue(true);
    jest.spyOn(mirrorService, '_getClient').mockResolvedValue({});
    jest.spyOn(mirrorService, '_mirrorFields').mockRejectedValue(terminalMirrorError('refused'));
    const markFailed = jest.spyOn(mirrorService, '_markFailed').mockResolvedValue();
    await mirrorService._executeJob({ id: 11, kind: 'update_fields', ticketId: 70001, workspaceId: 2, attempts: 0 });
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'refused', { softRetry: false, terminal: true });
    markFailed.mockRestore();
  });
});
