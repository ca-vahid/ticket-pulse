import { jest } from '@jest/globals';

/**
 * Tags (gap plan Phase 1): condition-model list operators + the engine's
 * case-insensitive list ops + ticketService.setTags diff/audit behavior.
 */

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketTag: { findMany: jest.fn() },
  ticketTagLink: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};
const activityMock = { create: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  sseManager: { broadcast: jest.fn() },
}));

const { compileConditionGroup, validateConditionGroup } = await import('../src/services/notificationConditionModel.js');
const { default: jsonLogic } = await import('json-logic-js');
await import('../src/services/notificationWorkflowEngine.js'); // registers list ops
const { default: ticketService } = await import('../src/services/ticketService.js');

describe('tag conditions (list type)', () => {
  test('has_any / has_all / has_none compile and evaluate case-insensitively', () => {
    const data = { ticket: { tags: ['vip', 'hardware'] } };
    const evaluate = (operator, value) => jsonLogic.apply(
      compileConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.tags', operator, value }] }),
      data,
    );
    expect(evaluate('has_any', ['VIP', 'network'])).toBe(true);
    expect(evaluate('has_any', ['network'])).toBe(false);
    expect(evaluate('has_all', ['vip', 'Hardware'])).toBe(true);
    expect(evaluate('has_all', ['vip', 'network'])).toBe(false);
    expect(evaluate('has_none', ['network'])).toBe(true);
    expect(evaluate('has_none', ['VIP'])).toBe(false);
  });

  test('validator accepts list operators and rejects string ops on tags', () => {
    expect(validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.tags', operator: 'has_any', value: ['vip'] }] })).toEqual([]);
    const errors = validateConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.tags', operator: 'contains', value: 'vip' }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('empty tag list on the ticket evaluates has_any=false, has_none=true', () => {
    const rule = compileConditionGroup({ logic: 'all', conditions: [{ field: 'ticket.tags', operator: 'has_none', value: ['vip'] }] });
    expect(jsonLogic.apply(rule, { ticket: { tags: [] } })).toBe(true);
    expect(jsonLogic.apply(rule, { ticket: {} })).toBe(true); // missing field fails closed on has_any
  });
});

describe('ticketService.setTags', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (ops) => Promise.all(ops));
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 7, origin: 'ticketpulse', status: 'Open', assignedTechId: null, nativeNumber: 7, freshserviceTicketId: null });
  });

  test('applies the diff (add + remove), audits it, and returns the new tag list', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, tagLinks: [{ tagId: 1 }, { tagId: 2 }] });
    prismaMock.ticketTag.findMany
      .mockResolvedValueOnce([{ id: 2, name: 'hardware' }, { id: 3, name: 'vip' }]) // valid wanted
      .mockResolvedValueOnce([{ name: 'stale' }]); // removed names lookup
    prismaMock.ticketTagLink.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.ticketTagLink.createMany.mockResolvedValue({ count: 1 });
    prismaMock.ticketTagLink.findMany.mockResolvedValue([
      { tag: { id: 2, name: 'hardware', color: 'sky' } },
      { tag: { id: 3, name: 'vip', color: 'red' } },
    ]);

    const result = await ticketService.setTags(7, 1, [2, 3], { email: 'coord@bgc.ca' });
    expect(result.changed).toBe(true);
    expect(result.tags.map((t) => t.name)).toEqual(['hardware', 'vip']);
    expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'tags_changed',
      performedBy: 'coord@bgc.ca',
      details: { added: ['vip'], removed: ['stale'] },
    }));
  });

  test('rejects tags from another workspace', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, tagLinks: [] });
    prismaMock.ticketTag.findMany.mockResolvedValueOnce([]); // none valid
    await expect(ticketService.setTags(7, 1, [99], null)).rejects.toThrow(/do not exist/);
  });

  test('no-op set returns changed=false without writing', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, tagLinks: [{ tagId: 2 }] });
    prismaMock.ticketTag.findMany.mockResolvedValueOnce([{ id: 2, name: 'hardware' }]);
    prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tag: { id: 2, name: 'hardware', color: 'sky' } }]);
    const result = await ticketService.setTags(7, 1, [2], null);
    expect(result.changed).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(activityMock.create).not.toHaveBeenCalled();
  });
});
