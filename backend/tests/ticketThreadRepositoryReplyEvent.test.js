import { jest } from '@jest/globals';

/**
 * MEGA 09-01 Phase RO-3 — FS-born requester replies arrive ONLY through
 * ticketThreadRepository.bulkUpsert, so that is where `ticket.reply_received`
 * fires for them: once per NEW customer_reply, never for a re-synced row, a
 * private entry, a CSAT survey response, or an agent replying from Outlook.
 */

const prismaMock = {
  ticketThreadEntry: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  technician: { findMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
};
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { ingestFreshServiceAttachment: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({
  default: { scheduleRefresh: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitTicketEventMock },
  emitTicketEvent: emitTicketEventMock,
}));

const { default: repo, looksLikeSurveyResponse } = await import('../src/services/ticketThreadRepository.js');

const flush = () => new Promise((r) => setTimeout(r, 15));

function customerReply(over = {}) {
  return {
    ticketId: 39618,
    workspaceId: 2,
    externalEntryId: 'fs-activity:2862800',
    source: 'freshservice_activity',
    eventType: 'customer_reply',
    actorName: '1800 Recevables',
    actorEmail: 'ar@vendor.example.com',
    actorFreshserviceId: BigInt(555),
    incoming: true,
    isPrivate: false,
    visibility: 'customer',
    bodyText: 'please see attached',
    occurredAt: new Date(),
    ...over,
  };
}

describe('bulkUpsert → ticket.reply_received for FS-born requester replies (RO-3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 9001, ...create }));
    prismaMock.technician.findMany.mockResolvedValue([]);
  });

  test('a NEW customer reply emits exactly once, stamped with its externalEntryId', async () => {
    await repo.bulkUpsert([customerReply()]);
    await flush();

    expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.reply_received', 39618, expect.objectContaining({
      source: 'freshservice_sync',
      dedupeStamp: 'fs-activity:2862800',
      extra: expect.objectContaining({
        externalEntryId: 'fs-activity:2862800',
        fromEmail: 'ar@vendor.example.com',
        via: 'freshservice',
        senderIsAgent: false,
        isSurveyResponse: false,
      }),
    }));
  });

  test('a re-synced (already stored) reply does NOT fire again', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { id: 1, ticketId: 39618, externalEntryId: 'fs-activity:2862800', source: 'freshservice_activity', rawPayload: null },
    ]);
    await repo.bulkUpsert([customerReply()]);
    await flush();
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });

  test('private entries, agent replies, survey responses and stale history stay silent', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'kfanning@example.com', freshserviceId: BigInt(777) }]);
    await repo.bulkUpsert([
      customerReply({ externalEntryId: 'fs-activity:1', isPrivate: true, visibility: 'private' }),
      customerReply({ externalEntryId: 'fs-activity:2', eventType: 'public_reply', incoming: false }),
      customerReply({ externalEntryId: 'fs-activity:3', actorEmail: 'KFanning@example.com', actorFreshserviceId: null }),
      customerReply({ externalEntryId: 'fs-activity:4', actorEmail: 'other@example.com', actorFreshserviceId: BigInt(777) }),
      customerReply({ externalEntryId: 'fs-activity:5', bodyText: 'Customer satisfaction survey: How would you rate the support you received?' }),
      customerReply({ externalEntryId: 'fs-activity:6', occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }),
    ]);
    await flush();
    expect(emitTicketEventMock).not.toHaveBeenCalled();
    // The technician lookup was scoped to the batch's workspace + senders.
    expect(prismaMock.technician.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: { in: [2] } }),
    }));
  });

  test('a lifecycle dispatch failure never fails the sync write', async () => {
    emitTicketEventMock.mockRejectedValueOnce(new Error('engine down'));
    const result = await repo.bulkUpsert([customerReply()]);
    await flush();
    expect(result.upserted).toBe(1);
  });
});

describe('looksLikeSurveyResponse', () => {
  test('flags FS survey payloads and survey text, not ordinary replies', () => {
    expect(looksLikeSurveyResponse({ rawPayload: { survey_result: { rating: 103 } } })).toBe(true);
    expect(looksLikeSurveyResponse({ bodyText: 'Survey response: Very satisfied' })).toBe(true);
    expect(looksLikeSurveyResponse({ bodyText: 'please see attached — second invoice' })).toBe(false);
    expect(looksLikeSurveyResponse(null)).toBe(false);
  });
});
