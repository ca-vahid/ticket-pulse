import { jest } from '@jest/globals';

const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  assignmentPipelineRun: { create: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const markDuplicateMock = jest.fn().mockResolvedValue({ link: { id: 1 }, resolved: false });
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({
  default: { markDuplicate: markDuplicateMock },
}));

const { default: duplicateBurstService, normalizeSubject } = await import('../src/services/duplicateBurstService.js');

const T0 = new Date('2026-07-13T14:44:18Z');
const minutesBefore = (m) => new Date(T0.getTime() - m * 60 * 1000);

describe('normalizeSubject', () => {
  test('collapses case, punctuation, whitespace, and reply prefixes', () => {
    expect(normalizeSubject('RE:  32" Monitor!!')).toBe('32 monitor');
    expect(normalizeSubject('32  monitor')).toBe('32 monitor');
    expect(normalizeSubject(null)).toBe('');
  });
});

describe('detectBurstDuplicate', () => {
  beforeEach(() => jest.clearAllMocks());

  const self = { id: 100, requesterId: 55, subject: '32" monitor', createdAt: T0 };

  test('finds the earliest same-requester same-subject ticket in the window', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(self);
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 90, subject: '32" monitors for my workspace', createdAt: minutesBefore(2), origin: 'freshservice' },
      { id: 92, subject: 'RE: 32" MONITOR', createdAt: minutesBefore(1), origin: 'freshservice', freshserviceTicketId: 232562n },
      { id: 95, subject: '32 monitor', createdAt: minutesBefore(0.5), origin: 'freshservice' },
    ]);
    const original = await duplicateBurstService.detectBurstDuplicate(100, 1);
    // id 90 has a DIFFERENT subject; 92 is the earliest exact-normalized match.
    expect(original?.id).toBe(92);
  });

  test('returns null when nothing matches or requester unknown', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...self, requesterId: null });
    expect(await duplicateBurstService.detectBurstDuplicate(100, 1)).toBeNull();

    prismaMock.ticket.findFirst.mockResolvedValue(self);
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 90, subject: 'completely different', createdAt: minutesBefore(3) },
    ]);
    expect(await duplicateBurstService.detectBurstDuplicate(100, 1)).toBeNull();
  });

  test('too-generic subjects never match', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...self, subject: 'help' });
    expect(await duplicateBurstService.detectBurstDuplicate(100, 1)).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('dismissAsDuplicate', () => {
  beforeEach(() => jest.clearAllMocks());

  test('links duplicate and records a completed duplicate_dismissed run', async () => {
    prismaMock.assignmentPipelineRun.create.mockResolvedValue({ id: 777 });
    const original = { id: 92, freshserviceTicketId: 232562n, nativeNumber: null, origin: 'freshservice' };
    const run = await duplicateBurstService.dismissAsDuplicate(100, 1, original, 'webhook');

    expect(run.id).toBe(777);
    expect(markDuplicateMock).toHaveBeenCalledWith(100, 1, 92, expect.objectContaining({ name: expect.stringContaining('duplicate guard') }));
    expect(prismaMock.assignmentPipelineRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        decision: 'duplicate_dismissed',
        status: 'completed',
        totalTokensUsed: 0,
        recommendation: expect.objectContaining({ duplicateOfTicketId: 92 }),
      }),
      select: { id: true },
    }));
  });

  test('still records the run when the link already exists', async () => {
    markDuplicateMock.mockRejectedValueOnce(new Error('Link already exists'));
    prismaMock.assignmentPipelineRun.create.mockResolvedValue({ id: 778 });
    const run = await duplicateBurstService.dismissAsDuplicate(100, 1, { id: 92, origin: 'freshservice' }, 'poll');
    expect(run.id).toBe(778);
  });
});
