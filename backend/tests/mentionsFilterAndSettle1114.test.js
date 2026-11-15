import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part H — the "Mentions me" filter — and the two Ticket Pulse
 * paths of Part B that do not report through the lifecycle emitter (delete,
 * mark as noise).
 *
 * Mentions: combinable with status and search; 30 days by default, 90 days or
 * any time; "not opened yet"; the id always from the session (never the URL);
 * nobody with no agent row here can be mentioned here; the row's @ mark data
 * comes with the list in ONE query.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketMention: { findMany: jest.fn() },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  assignmentPipelineRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};
const settleForTicket = jest.fn().mockResolvedValue({ settled: 1 });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', () => ({
  default: { settleForTicket, settleOnChange: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({ id: 1 }) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), enqueueDelete: jest.fn().mockResolvedValue(null),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));

const { default: ticketService, mentionSinceDate } = await import('../src/services/ticketService.js');
const { scopeMentions } = await import('../src/utils/mentionScope.js');
const { FILTER_GROUPS } = await import('../src/services/ticketFilterReliefService.js');

const NOW = new Date('2026-11-15T18:00:00Z');
const DAY = 24 * 3600 * 1000;
const person = { name: 'Sam Ortiz', email: 'sam.ortiz@example.com' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, defaultTimezone: 'America/Vancouver' });
});

describe('the period and "not opened yet"', () => {
  test('30 days by default, 90 days when asked, no limit for "any"', () => {
    expect(mentionSinceDate(undefined, NOW).getTime()).toBe(NOW.getTime() - 30 * DAY);
    expect(mentionSinceDate('30', NOW).getTime()).toBe(NOW.getTime() - 30 * DAY);
    expect(mentionSinceDate('90', NOW).getTime()).toBe(NOW.getTime() - 90 * DAY);
    expect(mentionSinceDate('any', NOW)).toBeNull();
    expect(mentionSinceDate('365', NOW).getTime()).toBe(NOW.getTime() - 30 * DAY); // unknown → the default
  });

  test('the list query carries period and unseen', async () => {
    let where = await ticketService.buildListWhere(1, { mentionedTechnicianId: 20, mentionedSince: '90' });
    expect(where.mentions.some.technicianId).toBe(20);
    expect(Date.now() - where.mentions.some.createdAt.gte.getTime()).toBeGreaterThan(89 * DAY);
    expect(where.mentions.some.seenAt).toBeUndefined();

    where = await ticketService.buildListWhere(1, { mentionedTechnicianId: 20, mentionedSince: 'any', mentionedUnseen: '1' });
    expect(where.mentions.some).toEqual({ technicianId: 20, seenAt: null });
  });

  test('combines with a status pick and a search', async () => {
    const where = await ticketService.buildListWhere(1, { mentionedTechnicianId: 20, status: 'Open', q: 'printer' });
    expect(where.mentions.some.technicianId).toBe(20);
    expect(where.status).toEqual({ in: ['Open'] });
    expect(JSON.stringify(where.AND)).toContain('printer');
  });

  test('period and unseen alone (no mention filter) change nothing', async () => {
    const where = await ticketService.buildListWhere(1, { mentionedSince: '90', mentionedUnseen: '1' });
    expect(where.mentions).toBeUndefined();
  });
});

describe('the id comes from the session only', () => {
  const req = (technicianId) => ({ ticketActor: { technicianId } });

  test('mentioned=me becomes the signed-in agent; an id in the URL is thrown away', () => {
    expect(scopeMentions({ mentioned: 'me', mentionedTechnicianId: '77', mentionedSince: '90' }, req(20)))
      .toEqual({ mentioned: 'me', mentionedTechnicianId: 20, mentionedSince: '90' });
    expect(scopeMentions({ mentionedTechnicianId: '77' }, req(20))).toEqual({});
  });

  test('someone with no agent row in this workspace matches nothing', () => {
    expect(scopeMentions({ mentioned: 'me' }, req(null)).mentionedTechnicianId).toBe(-1);
    expect(scopeMentions({ mentioned: 'me' }, {}).mentionedTechnicianId).toBe(-1);
  });

  test('period and unseen without mentioned=me are dropped; the source is not changed', () => {
    const source = { mentionedSince: 'any', mentionedUnseen: '1', status: 'Open' };
    expect(scopeMentions(source, req(20))).toEqual({ status: 'Open' });
    expect(source).toEqual({ mentionedSince: 'any', mentionedUnseen: '1', status: 'Open' });
  });

  test('"Your filters are hiding this" knows the Mentions filter and drops all of it at once', () => {
    const group = FILTER_GROUPS.find((g) => g.key === 'mentioned');
    expect(group).toEqual({ key: 'mentioned', label: 'Mentions', apiKeys: ['mentionedTechnicianId', 'mentionedSince', 'mentionedUnseen'] });
  });
});

describe('the row\'s @ mark: who mentioned me and when, with the list', () => {
  test('one query for the whole page; newest three per ticket; unseen counted', async () => {
    const at = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
    prismaMock.ticketMention.findMany.mockResolvedValue([
      { ticketId: 1, mentionedByName: 'Alex Rivera', createdAt: at(1), seenAt: null },
      { ticketId: 1, mentionedByName: 'Jordan Lee', createdAt: at(2), seenAt: at(1) },
      { ticketId: 2, mentionedByName: 'Alex Rivera', createdAt: at(3), seenAt: at(2) },
      { ticketId: 1, mentionedByName: 'Jordan Lee', createdAt: at(4), seenAt: null },
      { ticketId: 1, mentionedByName: 'Alex Rivera', createdAt: at(5), seenAt: at(4) },
    ]);
    const since = mentionSinceDate(null, NOW);
    const map = await ticketService._mentionsOfMeByTicket([1, 2, 3], 1, 20, since);
    expect(prismaMock.ticketMention.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketMention.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: 1, technicianId: 20, ticketId: { in: [1, 2, 3] }, createdAt: { gte: since },
    });
    expect(map.get(1).unseen).toBe(2);
    expect(map.get(1).latest).toEqual([
      { by: 'Alex Rivera', at: at(1), seen: false },
      { by: 'Jordan Lee', at: at(2), seen: true },
      { by: 'Jordan Lee', at: at(4), seen: false },
    ]);
    expect(map.get(2)).toEqual({ unseen: 0, latest: [{ by: 'Alex Rivera', at: at(3), seen: true }] });
    expect(map.has(3)).toBe(false);
  });

  test('no agent row here, or an empty page: no query at all', async () => {
    expect((await ticketService._mentionsOfMeByTicket([1, 2], 1, null)).size).toBe(0);
    expect((await ticketService._mentionsOfMeByTicket([], 1, 20)).size).toBe(0);
    expect(prismaMock.ticketMention.findMany).not.toHaveBeenCalled();
  });

  test('a failed read degrades to no marks', async () => {
    prismaMock.ticketMention.findMany.mockRejectedValue(new Error('relation "ticket_mentions" does not exist'));
    expect((await ticketService._mentionsOfMeByTicket([1], 1, 20)).size).toBe(0);
  });
});

describe('Part B: Ticket Pulse paths outside the lifecycle emitter', () => {
  const tpTicket = { id: 900, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 12, status: 'Open', assignedTechId: null, freshserviceTicketId: null, isNoise: false };

  test('deleting a Ticket Pulse ticket settles its open reviews, naming the person', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket);
    prismaMock.ticket.update.mockResolvedValue({ ...tpTicket, status: 'Deleted' });
    await ticketService.deleteTicket(900, 1, person);
    expect(settleForTicket).toHaveBeenCalledWith(expect.objectContaining({ id: 900, status: 'Deleted' }), { actor: person, source: 'ticketpulse_native', noise: false });
  });

  test('marking a ticket as noise by hand settles; clearing the flag does not', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket, origin: 'freshservice' });
    prismaMock.ticket.update.mockResolvedValue({ ...tpTicket, origin: 'freshservice', isNoise: true });
    await ticketService.setNoise(900, 1, { noise: true }, person);
    expect(settleForTicket).toHaveBeenCalledWith(expect.objectContaining({ id: 900 }), { actor: person, source: 'ticketpulse_native', noise: true });

    settleForTicket.mockClear();
    prismaMock.ticket.update.mockResolvedValue({ ...tpTicket, origin: 'freshservice', isNoise: false });
    await ticketService.setNoise(900, 1, { noise: false }, person);
    expect(settleForTicket).not.toHaveBeenCalled();
  });
});
