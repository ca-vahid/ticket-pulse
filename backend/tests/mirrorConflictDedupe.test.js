import { jest } from '@jest/globals';

/**
 * MEGA 09-01 Phase TU-3c — one `mirror_conflict` row per drift signature.
 * The 3-min mirror sweep used to re-log the identical drift every pass (116
 * rows on 27 ws5 tickets); a repeat now bumps lastSeenAt/count instead.
 */

const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  ticketActivity: { findFirst: jest.fn(), update: jest.fn() },
  requester: { update: jest.fn() },
};
const activityCreateMock = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { buffersForThreadEntry: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreateMock } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => ({})) }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn() }, emitTicketEvent: jest.fn(),
}));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

const DRIFT = ['status (FS 4 vs TP 2)', 'assignee (FS 12345 vs TP none)'];

describe('mirrorService._recordMirrorConflict (TU-3c)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('first sighting inserts a row stamped kind=mirror with count=1', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue(null);

    const result = await mirrorService._recordMirrorConflict(501, { drift: DRIFT, fsId: 90001 });

    expect(result).toEqual({ deduped: false });
    expect(activityCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      activityType: 'mirror_conflict',
      performedBy: 'Mirror reconciliation',
      details: expect.objectContaining({ drift: DRIFT, freshserviceTicketId: 90001, actorKind: 'mirror', count: 1 }),
    }));
    expect(prismaMock.ticketActivity.update).not.toHaveBeenCalled();
  });

  test('the same drift again bumps lastSeenAt/count on the latest row — no new row', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({
      id: 77,
      details: { drift: [...DRIFT], freshserviceTicketId: 90001, actorKind: 'mirror', count: 3, firstSeenAt: '2026-09-01T03:50:00.000Z' },
    });

    const result = await mirrorService._recordMirrorConflict(501, { drift: DRIFT, fsId: 90001 });

    expect(result).toEqual({ deduped: true, id: 77 });
    expect(activityCreateMock).not.toHaveBeenCalled();
    expect(prismaMock.ticketActivity.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 77 },
      data: { details: expect.objectContaining({ drift: DRIFT, count: 4, firstSeenAt: '2026-09-01T03:50:00.000Z', lastSeenAt: expect.any(String) }) },
    }));
  });

  test('a DIFFERENT drift signature gets its own row', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ id: 77, details: { drift: ['status (FS 4 vs TP 2)'], count: 2 } });

    await mirrorService._recordMirrorConflict(501, { drift: DRIFT, fsId: 90001 });

    expect(prismaMock.ticketActivity.update).not.toHaveBeenCalled();
    expect(activityCreateMock).toHaveBeenCalledTimes(1);
  });

  test('a lookup failure falls back to a fresh row (never loses the signal)', async () => {
    prismaMock.ticketActivity.findFirst.mockRejectedValue(new Error('db down'));
    await mirrorService._recordMirrorConflict(501, { drift: DRIFT, fsId: 90001 });
    expect(activityCreateMock).toHaveBeenCalledTimes(1);
  });
});
