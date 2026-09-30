import { jest } from '@jest/globals';

/**
 * Auto-help P1 edges outside the loop itself:
 *  - the proposal store: an Auto-help suggestion is created with
 *    supersede:false and never replaces a draft that is already waiting
 *    (proposed or being sent); workflow drafts keep superseding as before
 *  - agent closing numbers: a ticket Auto-help resolved (resolved_by_kind
 *    'auto_help') is not the agent's close — it is counted on its own line
 */
const prismaMock = {
  ticketProposedReply: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: proposals } = await import('../src/services/ticketProposedReplyService.js');
const { calculateTechnicianDailyStats, calculateTechnicianWeeklyStats, calculateDailyDashboard, calculateTechnicianDetail } = await import('../src/services/statsCalculator.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketProposedReply.create.mockImplementation(async ({ data }) => ({ id: 88, ...data }));
  prismaMock.ticketProposedReply.updateMany.mockResolvedValue({ count: 1 });
});

describe('proposal store', () => {
  test('supersede:false with another Auto-help answer waiting → nothing created, nothing dismissed', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValue([{ id: 7, source: 'auto_help', status: 'proposed', bodyText: 'x' }]);
    const out = await proposals.create({ workspaceId: 1, ticketId: 5, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>x</p>', supersede: false });
    expect(out).toBeNull();
    expect(prismaMock.ticketProposedReply.create).not.toHaveBeenCalled();
    expect(prismaMock.ticketProposedReply.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.ticketProposedReply.findMany.mock.calls[0][0].where).toEqual({ ticketId: 5, status: { in: ['proposed', 'sending', 'needs_check'] } });
  });

  test('supersede:false with a workflow draft mid-send → still waits', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValue([{ id: 7, source: 'workflow', status: 'sending', bodyText: 'x' }]);
    const out = await proposals.create({ workspaceId: 1, ticketId: 5, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>x</p>', supersede: false });
    expect(out).toBeNull();
    expect(prismaMock.ticketProposedReply.updateMany).not.toHaveBeenCalled();
  });

  test('supersede:false with a workflow AI draft waiting → the draft is set aside and its text rides on the answer', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValue([{ id: 7, source: 'workflow', status: 'proposed', bodyText: null, bodyHtml: '<p>Thanks, we got your ticket.</p>' }]);
    const out = await proposals.create({ workspaceId: 1, ticketId: 5, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>x</p>', supersede: false });
    expect(out).toMatchObject({ id: 88, source: 'auto_help' });
    expect(prismaMock.ticketProposedReply.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [7] }, status: 'proposed' },
      data: expect.objectContaining({ status: 'dismissed', decidedBy: 'superseded_by_auto_help' }),
    }));
    expect(prismaMock.ticketProposedReply.create.mock.calls[0][0].data.guardSummary.workflowAck).toEqual({ text: 'Thanks, we got your ticket.', fromProposalId: 7 });
  });

  test('supersede:false with no draft → created with the run link', async () => {
    prismaMock.ticketProposedReply.findMany.mockResolvedValue([]);
    const out = await proposals.create({ workspaceId: 1, ticketId: 5, source: 'auto_help', autoHelpRunId: 901, bodyHtml: '<p>x</p>', supersede: false });
    expect(out).toMatchObject({ id: 88, source: 'auto_help', autoHelpRunId: 901 });
  });

  test('workflow drafts still supersede (unchanged behaviour)', async () => {
    await proposals.create({ workspaceId: 1, ticketId: 5, bodyHtml: '<p>x</p>' });
    // Integration W2: a workflow draft supersedes older workflow drafts only — never an Auto-help answer.
    expect(prismaMock.ticketProposedReply.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 5, status: 'proposed', source: { not: 'auto_help' } } }));
    expect(prismaMock.ticketProposedReply.create.mock.calls[0][0].data).not.toHaveProperty('autoHelpRunId');
  });
});

describe('agent closing numbers exclude Auto-help resolutions', () => {
  const now = new Date();
  const start = new Date(now.getTime() - 12 * 3600e3);
  const end = new Date(now.getTime() + 12 * 3600e3);
  const t = (id, status, extra = {}) => ({
    id, status, createdAt: new Date(now.getTime() - 3600e3), firstAssignedAt: new Date(now.getTime() - 3600e3),
    isSelfPicked: false, assignedBy: 'Coord', csatScore: null, parkedUntil: null, ...extra,
  });
  const tech = {
    id: 5, name: 'Dana', email: 'd@x', isActive: true,
    tickets: [t(1, 'Resolved'), t(2, 'Closed'), t(3, 'Resolved', { resolvedByKind: 'auto_help' }), t(4, 'Open')],
  };

  test('daily: closedToday counts the agent\'s 2, autoHelpResolvedToday the 1', () => {
    const s = calculateTechnicianDailyStats(tech, start, end, true);
    expect(s.closedToday).toBe(2);
    expect(s.autoHelpResolvedToday).toBe(1);
  });

  test('dashboard total has its own team line', () => {
    const d = calculateDailyDashboard([tech], start, end, true);
    expect(d.statistics).toMatchObject({ closedTicketsToday: 2, autoHelpResolvedToday: 1 });
  });

  test('weekly closed and technician detail counts exclude it too', () => {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday.getTime() + 7 * 86400e3 - 1);
    const w = calculateTechnicianWeeklyStats(tech, monday, sunday, 'America/Vancouver');
    expect(w.weeklyClosed).toBe(2);
    const detail = calculateTechnicianDetail(tech, start, end, true);
    expect(detail.closedTicketsOnDateCount).toBe(2);
    expect(detail.autoHelpResolvedOnDateCount).toBe(1);
  });
});
