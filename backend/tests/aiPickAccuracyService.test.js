import { jest } from '@jest/globals';

/**
 * Analytics → Automation Ops, "How often the AI's pick stands": the service
 * wrapper. The page gets the summary without the per-ticket rows; the CSV
 * endpoint gets the rows; the workspace's set-up travels as counts only.
 */
const prismaMock = {
  $queryRaw: jest.fn(),
  ticket: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  hrLifecycleFamilyMember: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  assignmentConfig: { findUnique: jest.fn() },
  appSettings: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Resolved', 'Closed']) },
}));

const { getAiPickAccuracy, getAiPickAccuracyExport } = await import('../src/services/analyticsService.js');

const recent = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 1, ticketId: 11, decision: 'pending_review', triggerSource: 'app_native', isRebound: false, assignedTechId: null, createdAt: recent(72), pickIds: [1, 2] },
    { id: 2, ticketId: 12, decision: 'pending_review', triggerSource: 'app_native', isRebound: false, assignedTechId: null, createdAt: recent(70), pickIds: [1, 2] },
  ]);
  prismaMock.ticket.findMany.mockResolvedValue([
    { id: 11, origin: 'ticketpulse', nativeNumber: 501, subject: 'Request for A', status: 'Closed', isNoise: false, assignedTechId: 1, assignedAt: recent(71), internalCategory: { id: 3, name: 'Proposal Setup' }, internalCategoryId: 3 },
    { id: 12, origin: 'ticketpulse', nativeNumber: 502, subject: 'Request for B', status: 'Closed', isNoise: false, assignedTechId: 3, assignedAt: recent(69), internalCategory: { id: 4, name: 'Project Setup' }, internalCategoryId: 4 },
  ]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue([{ id: 1, name: 'Ada Byron' }, { id: 2, name: 'Ben Okri' }, { id: 3, name: 'Cy Twombly' }]);
  prismaMock.assignmentConfig.findUnique.mockResolvedValue({ isEnabled: true, autoAssign: false, excludedGroupIds: [], observeOnlyGroupIds: [10, 11] });
  prismaMock.appSettings.findMany.mockResolvedValue([{ value: 'Ticket Pulse' }]);
});

describe('getAiPickAccuracy', () => {
  test('summary for a suggest-only workspace, without the per-ticket rows', async () => {
    const data = await getAiPickAccuracy(5, { range: '30d', probe: 'a' });
    expect(data.rows).toBeUndefined();
    expect(data.setup).toEqual({ enabled: true, autoAssign: false, suggestOnlyGroups: 0, shadowGroups: 2 });
    expect(data.leadMode).toBe('suggest');
    expect(data.auto).toBeNull();
    expect(data.suggest).toMatchObject({
      tickets: 2,
      firstChoice: { n: 1, of: 2, pct: null },
      inList: { n: 1, of: 2, pct: null },
      review: { of: 2, approvedAsIs: 0, changedInReview: 0, rejected: 0, notAnswered: 2 },
    });
    expect(data.suggest.overrides).toEqual([expect.objectContaining({ displayRef: 'TP-502', category: 'Project Setup', aiFirstChoice: 'Ada Byron', tookIt: 'Cy Twombly' })]);
    expect(data.metadata.range.key).toBe('30d');
    expect(data.rules).toEqual({ minRateSample: 20, openHoldHours: 24, quickChangeMinutes: 60 });
  });

  test('the CSV endpoint returns one plain row per ticket', async () => {
    const data = await getAiPickAccuracyExport(5, { range: '30d', probe: 'b' });
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ Mode: 'AI suggested', "AI's first choice": 'Ada Byron' });
    expect(Object.keys(data.rows[0])).not.toContain('score');
  });

  test('page and CSV share one computation (the SWR cache)', async () => {
    await getAiPickAccuracy(5, { range: '30d', probe: 'c' });
    await getAiPickAccuracyExport(5, { range: '30d', probe: 'c' });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('no assignment set-up row: still answers', async () => {
    prismaMock.assignmentConfig.findUnique.mockRejectedValue(new Error('missing'));
    const data = await getAiPickAccuracy(5, { range: '30d', probe: 'd' });
    expect(data.setup).toBeNull();
    expect(data.suggest.tickets).toBe(2);
  });
});
