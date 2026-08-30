import { jest } from '@jest/globals';

/**
 * Mega 08-30 Phase DR2/DR5 — the FS conversation sync lands on the row Ticket
 * Pulse wrote when the agent sent the reply (same `fs-conversation:<id>`
 * stamp since DR1) and must NOT overwrite the agent's attribution or the
 * clean body with the API-key owner ("Ticket Pulse") + signature-appended
 * copy. FS-derived metadata still refreshes.
 */

const prismaMock = {
  ticketThreadEntry: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

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

const { default: repo, preservedUpdateData, TP_AUTHORED_SOURCE } = await import('../src/services/ticketThreadRepository.js');
const { transformTicketConversationEntries } = await import('../src/integrations/freshserviceTransformer.js');

// The FS conversation for a reply Ticket Pulse posted through createReply:
// FS attributes it to the API-key owner and appends the agent signature.
const FS_CONVERSATION = {
  id: 1042916725,
  user_id: 1002090730,
  from_email: '"Ticket Pulse" <helpdesk@bgcengineering.freshservice.com>',
  to_emails: ['rita@example.com'],
  cc_emails: ['boss@example.com'],
  body: '<div>We are on it!</div><div>--<br/>Soheil Nasiri · IT</div>',
  body_text: 'We are on it!\n--\nSoheil Nasiri · IT',
  incoming: false,
  private: false,
  created_at: '2026-08-28T17:05:11Z',
  attachments: [],
};

const LOCAL_ROW = {
  id: 9001,
  ticketId: 42039,
  externalEntryId: 'fs-conversation:1042916725',
  source: 'ticketpulse_user',
  rawPayload: { to_emails: ['rita@example.com'], idempotencyKey: 'k-1', editHistory: [] },
  title: null,
};

describe('ticketThreadRepository.bulkUpsert attribution preservation (Phase DR2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticketThreadEntry.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prismaMock.ticketThreadEntry.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 5000, ...create }));
  });

  test('the transformer stamps the SAME id the live write uses (DR1 end to end)', () => {
    const [entry] = transformTicketConversationEntries([FS_CONVERSATION], { ticketId: 42039, workspaceId: 2 });
    expect(entry.externalEntryId).toBe('fs-conversation:1042916725');
    expect(entry.source).toBe('freshservice_conversation');
    expect(entry.actorName).toBe('Ticket Pulse'); // what the sync WOULD have written
  });

  test('same conversation over a TP-authored row: one row, actor stays the agent, body stays clean', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([LOCAL_ROW]);
    const entries = transformTicketConversationEntries([FS_CONVERSATION], { ticketId: 42039, workspaceId: 2 });

    const result = await repo.bulkUpsert(entries);

    expect(result.upserted).toBe(1);
    // No upsert (which would have overwritten source/actor/body) — a targeted
    // update on the existing row id instead.
    expect(prismaMock.ticketThreadEntry.upsert).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledTimes(1);
    const { where, data } = prismaMock.ticketThreadEntry.update.mock.calls[0][0];
    expect(where).toEqual({ id: 9001 });
    for (const guarded of ['source', 'actorName', 'actorEmail', 'actorFreshserviceId', 'authorType', 'bodyHtml', 'bodyText', 'content', 'eventType', 'incoming', 'isPrivate', 'visibility']) {
      expect(data).not.toHaveProperty(guarded);
    }
    // FS-derived metadata refreshes (never the API-key owner's user_id — that is attribution).
    expect(data.occurredAt).toEqual(new Date('2026-08-28T17:05:11Z'));
    expect(data.syncedAt).toBeInstanceOf(Date);
    // rawPayload merged: local keys survive, FS recipient lists win.
    expect(data.rawPayload.idempotencyKey).toBe('k-1');
    expect(data.rawPayload.editHistory).toEqual([]);
    expect(data.rawPayload.to_emails).toEqual(['rita@example.com']);
    expect(data.rawPayload.cc_emails).toEqual(['boss@example.com']);
    expect(data.rawPayload.body_text).toBe(FS_CONVERSATION.body_text);
  });

  test('a plain FS-ingested row still refreshes through the full upsert (no regression)', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { ...LOCAL_ROW, source: 'freshservice_conversation' },
    ]);
    const entries = transformTicketConversationEntries([FS_CONVERSATION], { ticketId: 42039, workspaceId: 2 });

    await repo.bulkUpsert(entries);

    expect(prismaMock.ticketThreadEntry.update).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId_externalEntryId: { ticketId: 42039, externalEntryId: 'fs-conversation:1042916725' } },
      update: expect.objectContaining({ source: 'freshservice_conversation', actorName: 'Ticket Pulse' }),
    }));
  });

  test('an unseen conversation is created as before', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    const entries = transformTicketConversationEntries([FS_CONVERSATION], { ticketId: 42039, workspaceId: 2 });

    await repo.bulkUpsert(entries);

    expect(prismaMock.ticketThreadEntry.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketThreadEntry.update).not.toHaveBeenCalled();
  });

  test('the pre-lookup selects id + source + rawPayload (the guard needs them)', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    await repo.bulkUpsert(transformTicketConversationEntries([FS_CONVERSATION], { ticketId: 42039, workspaceId: 2 }));
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, ticketId: true, externalEntryId: true, source: true, rawPayload: true },
    }));
  });

  test('preservedUpdateData never carries attribution/content keys and keeps a local title', () => {
    const data = preservedUpdateData(
      { actorFreshserviceId: BigInt(5), occurredAt: new Date('2026-08-01T00:00:00Z'), title: 'FS title', rawPayload: { cc_emails: [] } },
      { title: 'Local title', rawPayload: { subject: 'Re: hi [TP-1]' } },
    );
    expect(Object.keys(data).sort()).toEqual(['occurredAt', 'rawPayload', 'syncedAt']);
    expect(data.rawPayload).toEqual({ cc_emails: [], subject: 'Re: hi [TP-1]' });
    expect(TP_AUTHORED_SOURCE).toBe('ticketpulse_user');
  });
});
