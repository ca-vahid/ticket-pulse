import { jest } from '@jest/globals';

// QA 10-13 #5 — "<Name> has submitted the survey response" is a line
// FreshService writes itself (conversation source 5, flagged incoming). On
// 13 Oct 2026 it arrived on TP-1882's FreshService copy, was stored as a
// requester reply and the "Reopen on requester reply" workflow reopened the
// closed ticket. It is a system event on both lanes: the FS-born conversation
// sync and the TP-born mirror reconciliation.

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  mirrorJob: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
};
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { ingestFreshServiceAttachment: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: { scheduleRefresh: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitTicketEventMock },
  emitTicketEvent: emitTicketEventMock,
}));

const { fsSystemConversationKind, isFsSystemConversation } = await import('../src/utils/fsSystemConversation.js');
const { transformTicketConversationEntry } = await import('../src/integrations/freshserviceTransformer.js');
const { default: threadRepo, looksLikeSurveyResponse, countsAsRealActivity } = await import('../src/services/ticketThreadRepository.js');
const { default: mirrorService } = await import('../src/services/mirrorService.js');

const flush = () => new Promise((r) => setTimeout(r, 20));

// The production payload, as FreshService returned it for #246507.
const surveyConv = (over = {}) => ({
  id: 1043273779,
  body: '<div>Daniel Israel has submitted the survey response</div>',
  body_text: 'Daniel Israel has submitted the survey response',
  source: 5,
  private: false,
  user_id: 1002095263,
  category: 'customer_response',
  incoming: true,
  cc_emails: [],
  to_emails: null,
  from_email: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  attachments: [],
  ...over,
});

const realReply = (over = {}) => ({
  id: 1043279999,
  body: '<div>Thanks, but it is still broken.</div>',
  body_text: 'Thanks, but it is still broken.',
  source: 0,
  private: false,
  user_id: 1002095263,
  incoming: true,
  from_email: 'disrael@example.com',
  created_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticketThreadEntry.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 9002, ...create }));
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
});

describe('fsSystemConversationKind', () => {
  test('the FreshService feedback source and the bare sentence are system entries', () => {
    expect(fsSystemConversationKind(surveyConv())).toBe('survey_response');
    // The sentence alone (source code missing) is enough.
    expect(fsSystemConversationKind(surveyConv({ source: 2 }))).toBe('survey_response');
    expect(fsSystemConversationKind({ body: '<div>Karen Wong has submitted the survey response.</div>' })).toBe('survey_response');
    // A stored row: body in bodyText, FreshService payload under rawPayload.
    expect(fsSystemConversationKind({ source: 'freshservice_conversation', bodyText: 'x', rawPayload: { source: 5 } })).toBe('survey_response');
  });

  test('a person who mentions the survey is still a person', () => {
    expect(isFsSystemConversation(realReply())).toBe(false);
    expect(isFsSystemConversation(realReply({
      body_text: 'Hi, Daniel has submitted the survey response already but the VPN is still down, can someone call me? Thanks, and sorry for the trouble with this one.',
    }))).toBe(false);
    expect(isFsSystemConversation(realReply({ body_text: 'I filled in the survey response and it is still broken' }))).toBe(false);
    expect(isFsSystemConversation(surveyConv({ private: true, source: 2 }))).toBe(false);
    expect(isFsSystemConversation(null)).toBe(false);
  });
});

describe('FS-born lane: conversation sync', () => {
  test('a survey line is stored as a system activity, not a customer reply', () => {
    const entry = transformTicketConversationEntry(surveyConv(), { ticketId: 62681, workspaceId: 1 });
    expect(entry).toEqual(expect.objectContaining({
      eventType: 'activity',
      authorType: 'system',
      actorName: 'FreshService',
      actorEmail: null,
      actorFreshserviceId: null,
      incoming: false,
      isPrivate: false,
      visibility: 'public',
      bodyText: 'Daniel Israel has submitted the survey response',
    }));
    expect(entry.rawPayload.tpSystemKind).toBe('survey_response');
    expect(looksLikeSurveyResponse(entry)).toBe(true);
    expect(countsAsRealActivity(entry)).toBe(false);
  });

  test('an ordinary requester reply is unchanged', () => {
    const entry = transformTicketConversationEntry(realReply(), { ticketId: 62681, workspaceId: 1 });
    expect(entry.eventType).toBe('customer_reply');
    expect(entry.incoming).toBe(true);
    expect(entry.authorType).toBeUndefined();
    expect(entry.rawPayload.tpSystemKind).toBeUndefined();
    expect(countsAsRealActivity(entry)).toBe(true);
  });

  test('bulkUpsert fires ticket.reply_received for the real reply only', async () => {
    const ctx = { ticketId: 62681, workspaceId: 1 };
    await threadRepo.bulkUpsert([
      transformTicketConversationEntry(surveyConv(), ctx),
      transformTicketConversationEntry(realReply(), ctx),
    ]);
    await flush();
    expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.reply_received', 62681, expect.objectContaining({
      dedupeStamp: 'fs-conversation:1043279999',
    }));
    // The ticket's "last real activity" moves for the reply, never for the survey line alone.
    emitTicketEventMock.mockClear();
    prismaMock.$executeRaw.mockClear();
    await threadRepo.bulkUpsert([transformTicketConversationEntry(surveyConv(), ctx)]);
    await flush();
    expect(emitTicketEventMock).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  test('a survey line that an older build stored as customer_reply still never fires', async () => {
    await threadRepo.bulkUpsert([{
      ticketId: 62681,
      workspaceId: 1,
      externalEntryId: 'fs-conversation:1',
      source: 'freshservice_conversation',
      eventType: 'customer_reply',
      incoming: true,
      isPrivate: false,
      bodyText: 'Saeid Ahadi has submitted the survey response',
      occurredAt: new Date(),
      rawPayload: { source: 5 },
    }]);
    await flush();
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });
});

describe('TP-born lane: mirror reconciliation (TP-1882)', () => {
  const ticket = {
    id: 62952,
    workspaceId: 1,
    origin: 'ticketpulse',
    nativeNumber: 1882,
    freshserviceTicketId: BigInt(246779),
    assignedTech: null,
  };

  test('the survey line on the FreshService copy is a system entry and does not reopen', async () => {
    const client = { fetchTicketConversations: jest.fn().mockResolvedValue([surveyConv()]) };
    await mirrorService._reconcileTicketAgainstFs(ticket, client);
    await flush();

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({
      externalEntryId: 'fs-conversation:1043273779',
      source: 'freshservice_reconciliation',
      eventType: 'activity',
      authorType: 'system',
      actorName: 'FreshService',
      actorFreshserviceId: null,
      incoming: false,
    }));
    expect(data.rawPayload.tpSystemKind).toBe('survey_response');
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });

  test('a real requester reply on the copy still fires the reply event once', async () => {
    const client = { fetchTicketConversations: jest.fn().mockResolvedValue([realReply()]) };
    await mirrorService._reconcileTicketAgainstFs(ticket, client);
    await flush();

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({ eventType: 'reply', authorType: 'requester', incoming: true }));
    expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.reply_received', 62952, expect.objectContaining({
      source: 'freshservice_reconciliation',
      dedupeStamp: 'fs-conversation:1043279999',
    }));
  });
});
