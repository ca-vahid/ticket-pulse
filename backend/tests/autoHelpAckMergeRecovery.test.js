import { jest } from '@jest/globals';

/**
 * Ack merge recovery (audit nice-to-have 5, 26 Sep 2026): the "merged" mark
 * on a held "Ticket arrived" ack is retried, and a waking node reads the
 * thread for the answering run's send key before it sends the ack itself —
 * an answer that went out with the ack on top never gets a second ack.
 */
const prismaMock = {
  autoHelpPendingAck: { updateMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  autoHelpRun: { findFirst: jest.fn() },
};
const deliveryMock = {
  answerKey: (runId) => `auto-help:${runId}:answer`,
  findKeyedEntry: jest.fn(),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpDeliveryService.js', () => ({ ...deliveryMock, default: deliveryMock }));

const { default: ackMerge, MERGING_STALE_MS } = await import('../src/services/autoHelpAckMergeService.js');

const NOW = new Date('2026-09-28T17:10:00Z');
const merging = (over = {}) => ({ id: 5, ticketId: 55, status: 'merging', consumedRunId: 901, createdAt: NOW, updatedAt: NOW, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.autoHelpPendingAck.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.autoHelpRun.findFirst.mockResolvedValue({ outcomeDetail: { failedSends: [3] } });
  deliveryMock.findKeyedEntry.mockResolvedValue(null);
});

describe('takeForAnswer remembers the answering run', () => {
  test('the claim records consumed_run_id with the move to merging; giveBack clears it', async () => {
    prismaMock.autoHelpPendingAck.findMany.mockResolvedValue([{ id: 5, ackText: 'We got your ticket.' }]);
    prismaMock.autoHelpPendingAck.updateMany.mockResolvedValue({ count: 1 });
    const held = await ackMerge.takeForAnswer(55, { now: NOW, runId: 901 });
    expect(held).toEqual({ id: 5, ackText: 'We got your ticket.' });
    expect(prismaMock.autoHelpPendingAck.updateMany.mock.calls[0][0].data).toEqual({ status: 'merging', consumedRunId: 901 });
    await ackMerge.giveBack(5);
    expect(prismaMock.autoHelpPendingAck.updateMany.mock.calls[1][0]).toEqual({ where: { id: 5, status: 'merging' }, data: { status: 'pending', consumedRunId: null } });
  });
});

describe('settle() reads the thread before sending the ack', () => {
  test('the answer is on the thread (mark lost) → consumed, the node sends nothing', async () => {
    prismaMock.autoHelpPendingAck.findFirst.mockResolvedValue(merging({ updatedAt: new Date(NOW.getTime() - MERGING_STALE_MS - 1000) }));
    deliveryMock.findKeyedEntry.mockResolvedValue({ id: 77 });
    const out = await ackMerge.settle(5, { now: NOW });
    expect(out).toMatchObject({ send: false, merged: true, runId: 901, recovered: true });
    expect(deliveryMock.findKeyedEntry).toHaveBeenCalledWith(55, 'auto-help:901:answer', [3]);
    expect(prismaMock.autoHelpPendingAck.updateMany).toHaveBeenLastCalledWith({ where: { id: 5, status: 'merging' }, data: { status: 'consumed' } });
  });

  test('no answer on the thread and the merge went stale → released, the ack goes on its own (as before)', async () => {
    prismaMock.autoHelpPendingAck.findFirst.mockResolvedValue(merging({ updatedAt: new Date(NOW.getTime() - MERGING_STALE_MS - 1000) }));
    prismaMock.autoHelpPendingAck.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const out = await ackMerge.settle(5, { now: NOW });
    expect(out).toEqual({ send: true, reason: 'merge_stale' });
  });

  test('no answer yet and the send is still young → wait', async () => {
    prismaMock.autoHelpPendingAck.findFirst.mockResolvedValue(merging());
    expect(await ackMerge.settle(5, { now: NOW })).toEqual({ wait: true });
  });
});

describe('confirmMerged retries', () => {
  test('a failed mark is retried, then succeeds', async () => {
    prismaMock.autoHelpPendingAck.updateMany.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ count: 1 });
    expect(await ackMerge.confirmMerged(5, 901, { retryDelaysMs: [1, 1] })).toBe(true);
    expect(prismaMock.autoHelpPendingAck.updateMany).toHaveBeenCalledTimes(2);
  });

  test('every try fails → false (never throws); the waking node then reads the thread', async () => {
    prismaMock.autoHelpPendingAck.updateMany.mockRejectedValue(new Error('db down'));
    expect(await ackMerge.confirmMerged(5, 901, { retryDelaysMs: [1, 1] })).toBe(false);
    expect(prismaMock.autoHelpPendingAck.updateMany).toHaveBeenCalledTimes(3);
  });
});
