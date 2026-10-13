import { jest } from '@jest/globals';
import fs from 'node:fs';

/**
 * 13 Oct 2026. Vahid's rule (8 Oct): onboarding / offboarding work that is weeks
 * away sleeps with NO owner, and the owner is chosen when it wakes. The missed-
 * ticket safety net saw "unassigned, Pending, no run, fifteen minutes old" and
 * queued an AI run, which gave nine sleeping children an owner (TP-1855 to
 * TP-1858 on 8 Oct, TP-1930 to TP-1934 today). A hand-back did the same.
 */
const prismaMock = {
  ticketPark: { findFirst: jest.fn() },
  ticket: { findUnique: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const repoMock = { getOpenPipelineRun: jest.fn(), getConfig: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: repoMock }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketPark.findFirst.mockResolvedValue(null);
});

describe('a ticket asleep until its onboarding / offboarding date', () => {
  test('an automatic trigger does not run it, and reads nothing else', async () => {
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 7 });
    for (const trigger of ['poll', 'webhook', 'app_native', 'rebound', 'priority_changed']) {
      const events = [];
      const out = await pipeline.runPipeline(63084, 1, trigger, (e) => events.push(e.type), null, trigger === 'rebound' ? { reboundFrom: { previousTechId: 5 } } : {});
      expect(out).toEqual({ skipped: true, reason: 'asleep_until_needed' });
      expect(events).toEqual(['complete']);
    }
    expect(prismaMock.ticketPark.findFirst).toHaveBeenCalledWith({ where: { ticketId: 63084, endedAt: null, source: 'suggested_hr' }, select: { id: true } });
    expect(repoMock.getOpenPipelineRun).not.toHaveBeenCalled();
    expect(repoMock.getConfig).not.toHaveBeenCalled();
  });

  test('a person can still run it by hand; an ordinary park (an agent\'s, Auto-help\'s) does not stop a run', async () => {
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 7 });
    repoMock.getOpenPipelineRun.mockResolvedValue(null);
    repoMock.getConfig.mockResolvedValue({ isEnabled: false });
    expect(await pipeline.runPipeline(63084, 1, 'manual')).toEqual({ skipped: true, reason: 'assignment_not_enabled' });
    expect(prismaMock.ticketPark.findFirst).not.toHaveBeenCalled();

    // Only the onboarding engine's parks count: the query asks for source 'suggested_hr', so any other park finds nothing.
    prismaMock.ticketPark.findFirst.mockResolvedValue(null);
    expect(await pipeline.runPipeline(500, 1, 'poll')).toEqual({ skipped: true, reason: 'assignment_not_enabled' });
  });

  test('a run queued before the ticket went to sleep is dropped when its turn comes', async () => {
    const run = { id: 9, ticketId: 63084, createdAt: new Date(), triggerSource: 'poll', ticket: { id: 63084, workspaceId: 1, origin: 'ticketpulse', status: 'Pending', assignedTechId: null } };
    pipeline._customTerminalNames = async () => [];
    pipeline._ticketOrigin = async () => 'ticketpulse';
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 7 });
    expect(await pipeline.validateQueuedRun(run)).toEqual({ valid: false, reason: 'Asleep until its onboarding / offboarding date: the owner is chosen when it wakes' });
    prismaMock.ticketPark.findFirst.mockResolvedValue(null);
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
    expect(await pipeline.validateQueuedRun(run)).toEqual({ valid: true });
  });

  test('a park table that cannot be read never blocks a run', async () => {
    prismaMock.ticketPark.findFirst.mockRejectedValue(new Error('relation does not exist'));
    expect(await pipeline._asleepForOnboarding(1)).toBe(false);
  });

  test('the missed-ticket safety net leaves them out of both of its queries', () => {
    const src = fs.readFileSync(new URL('../src/services/assignmentPipelineService.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async _queueMissedTickets('), src.indexOf('const toQueue = ['));
    const guard = "AND NOT EXISTS (SELECT 1 FROM ticket_parks p WHERE p.ticket_id = t.id AND p.ended_at IS NULL AND p.source = 'suggested_hr')";
    expect(body.split(guard)).toHaveLength(3);
  });
});
