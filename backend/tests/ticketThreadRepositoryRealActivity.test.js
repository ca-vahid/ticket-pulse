import { jest } from '@jest/globals';

/**
 * 30 Sep 2026 — the Updated sort (last_real_activity_at) put week-old tickets
 * on top: FS automation lines ("Ticket Workflow executed …", "Supervisor
 * executed the rule Set Resolved Tickets to Closed") and FS's echo of Ticket
 * Pulse's own changes counted as activity. Only people's work counts now.
 */

const prismaMock = {
  ticketThreadEntry: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({ id: 1 }),
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

const { default: repo, countsAsRealActivity } = await import('../src/services/ticketThreadRepository.js');

const activity = (actorName, bodyText) => ({ source: 'freshservice_activity', eventType: 'activity', actorName, bodyText });

describe('countsAsRealActivity', () => {
  test('FS automations and Ticket Pulse echoes do not count', () => {
    expect(countsAsRealActivity(activity('Ticket Workflow', ' executed Ticket Accepted workflow from Ticket is accepted event'))).toBe(false);
    expect(countsAsRealActivity(activity('Supervisor', ' executed the rule Set Resolved Tickets to Closed (Supervisor)'))).toBe(false);
    expect(countsAsRealActivity(activity('Ticket Pulse', ' set Status as Closed'))).toBe(false);
    expect(countsAsRealActivity(activity('Someone New', ' executed Ticket Closed (06-13) workflow'))).toBe(false);
  });
  test("people's work counts: agent activity lines, replies, notes, survey answers", () => {
    expect(countsAsRealActivity(activity('Adrian Lo', ' set Status as Pending'))).toBe(true);
    expect(countsAsRealActivity(activity('Anton Kuzmychev', ' added a private note'))).toBe(true);
    expect(countsAsRealActivity({ source: 'freshservice_conversation', eventType: 'customer_reply', bodyText: 'Thanks!' })).toBe(true);
    expect(countsAsRealActivity({ source: 'ticketpulse_user', eventType: 'note', actorName: 'Ticket Pulse', bodyText: 'x' })).toBe(true);
  });
});

describe('bulkUpsert keeps automation out of last_real_activity_at', () => {
  beforeEach(() => prismaMock.$executeRaw.mockClear());
  const at = '2026-09-30T03:34:05.000Z';
  test('an automation-only batch never bumps the timestamp', async () => {
    await repo.bulkUpsert([{ ticketId: 7, externalEntryId: 'a1', occurredAt: at, ...activity('Supervisor', ' executed the rule Set Resolved Tickets to Closed (Supervisor)') }]);
    const bumps = prismaMock.$executeRaw.mock.calls.filter((c) => String(c[0]?.join?.('') || '').includes('last_real_activity_at'));
    expect(bumps).toHaveLength(0);
  });
  test("an agent's line still bumps it", async () => {
    await repo.bulkUpsert([{ ticketId: 7, externalEntryId: 'a2', occurredAt: at, ...activity('Adrian Lo', ' set Status as Pending') }]);
    const bumps = prismaMock.$executeRaw.mock.calls.filter((c) => String(c[0]?.join?.('') || '').includes('last_real_activity_at'));
    expect(bumps).toHaveLength(1);
  });
});
