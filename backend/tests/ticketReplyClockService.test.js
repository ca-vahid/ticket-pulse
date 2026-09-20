import { jest } from '@jest/globals';

/**
 * QA 09-18 #5 — reply clocks derived from the conversation: who spoke last,
 * when the requester last wrote, when an agent last replied.
 */
const queryRaw = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: { $queryRaw: queryRaw } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const svc = await import('../src/services/ticketReplyClockService.js');

const t = (iso) => new Date(iso);

beforeEach(() => { queryRaw.mockReset(); });

describe('replyClocksFor', () => {
  test('reads the newest requester and agent messages per ticket from a newest-first stream', async () => {
    queryRaw.mockResolvedValue([
      // ticket 1: agent replied last, requester wrote before that
      { ticket_id: 1, id: 30, incoming: false, author_type: 'agent', occurred_at: t('2026-09-18T10:00:00Z') },
      { ticket_id: 1, id: 20, incoming: true, author_type: null, occurred_at: t('2026-09-17T10:00:00Z') },
      { ticket_id: 1, id: 10, incoming: false, author_type: 'agent', occurred_at: t('2026-09-16T10:00:00Z') },
      // ticket 2: requester spoke last
      { ticket_id: 2, id: 41, incoming: null, author_type: 'requester', occurred_at: t('2026-09-18T12:00:00Z') },
      { ticket_id: 2, id: 40, incoming: false, author_type: 'agent', occurred_at: t('2026-09-18T11:00:00Z') },
    ]);
    const clocks = await svc.replyClocksFor([1, 2, 3, 3, 'x']);
    expect(clocks.get(1)).toEqual({ lastRequesterReplyAt: t('2026-09-17T10:00:00Z'), lastAgentReplyAt: t('2026-09-18T10:00:00Z'), lastAgentEntryId: 30, latestIsAgent: true });
    expect(clocks.get(2)).toEqual({ lastRequesterReplyAt: t('2026-09-18T12:00:00Z'), lastAgentReplyAt: t('2026-09-18T11:00:00Z'), lastAgentEntryId: 40, latestIsAgent: false });
    expect(clocks.has(3)).toBe(false);
  });

  test('an empty id list never queries; a failed query yields an empty map', async () => {
    expect((await svc.replyClocksFor([])).size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
    queryRaw.mockRejectedValue(new Error('boom'));
    expect((await svc.replyClocksFor([1])).size).toBe(0);
  });
});

describe('replyClockMinutes + minutesSince', () => {
  test('minutes since each clock, null when it never happened', async () => {
    const now = t('2026-09-18T12:00:00Z').getTime();
    queryRaw.mockResolvedValue([{ ticket_id: 5, id: 1, incoming: false, author_type: 'agent', occurred_at: t('2026-09-18T09:00:00Z') }]);
    expect(await svc.replyClockMinutes(5, now)).toEqual({ lastRequesterReplyMinutes: null, lastAgentReplyMinutes: 180 });
    expect(svc.minutesSince(null)).toBeNull();
    expect(svc.minutesSince('not a date')).toBeNull();
  });
});

describe('requesterSilentCandidates', () => {
  test('maps rows and refuses to run without statuses or a cutoff', async () => {
    expect(await svc.requesterSilentCandidates(1, { statuses: [], cutoff: new Date() })).toEqual([]);
    expect(await svc.requesterSilentCandidates(1, { statuses: ['Pending'], cutoff: 'nope' })).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
    queryRaw.mockResolvedValue([{ ticket_id: 9, entry_id: 77, occurred_at: t('2026-09-15T10:00:00Z') }]);
    const rows = await svc.requesterSilentCandidates(1, { statuses: ['Pending Response'], cutoff: t('2026-09-18T10:00:00Z') });
    expect(rows).toEqual([{ ticketId: 9, lastAgentEntryId: 77, lastAgentReplyAt: t('2026-09-15T10:00:00Z') }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
