import { jest } from '@jest/globals';

/** Custom agent alerts (QA feedback) — matching, dedup, quiet hours. */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  agentAlertSubscription: { findMany: jest.fn() },
  agentAlertEvent: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({ resolveAgentTechnician: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: agentAlertService } = await import('../src/services/agentAlertService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.agentAlertEvent.createMany.mockResolvedValue({ count: 1 });
});

describe('agentAlertService.evaluate — matching', () => {
  // Ticket in category 10 (sub 20), tag 5, priority 3 (High).
  const TICKET = {
    id: 100, workspaceId: 1, priority: 3,
    internalCategoryId: 10, internalSubcategoryId: 20,
    tagLinks: [{ tagId: 5 }],
  };

  test('buffers events only for subscriptions whose scope matches', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([
      { id: 1, technicianId: 11, categoryId: 10, tagId: null, priorityMin: null },   // matches (top category)
      { id: 2, technicianId: 12, categoryId: 20, tagId: null, priorityMin: null },   // matches (subcategory)
      { id: 3, technicianId: 13, categoryId: 99, tagId: null, priorityMin: null },   // NO — different category
      { id: 4, technicianId: 14, categoryId: null, tagId: 5, priorityMin: null },    // matches (tag)
      { id: 5, technicianId: 15, categoryId: null, tagId: 7, priorityMin: null },    // NO — different tag
      { id: 6, technicianId: 16, categoryId: 10, tagId: null, priorityMin: 4 },      // NO — needs Urgent, ticket is High
      { id: 7, technicianId: 17, categoryId: 10, tagId: 5, priorityMin: 3 },         // matches (cat AND tag AND High+)
    ]);

    await agentAlertService.evaluate('created', 100);

    expect(prismaMock.agentAlertEvent.createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = prismaMock.agentAlertEvent.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true); // dedup guard
    expect(data.map((d) => d.subscriptionId).sort()).toEqual([1, 2, 4, 7]);
    expect(data.every((d) => d.trigger === 'created' && d.priority === 3)).toBe(true);
  });

  test('only queries subscriptions with the matching trigger flag on', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([]);
    await agentAlertService.evaluate('priority_raised', 100);
    expect(prismaMock.agentAlertSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 1, isActive: true, onPriorityRaised: true }),
    }));
  });

  test('no matches → no buffer write', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([{ id: 9, technicianId: 1, categoryId: 999, tagId: null, priorityMin: null }]);
    await agentAlertService.evaluate('created', 100);
    expect(prismaMock.agentAlertEvent.createMany).not.toHaveBeenCalled();
  });

  test('unknown trigger and missing ticket are no-ops (never throw)', async () => {
    await expect(agentAlertService.evaluate('bogus', 100)).resolves.toBeUndefined();
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    await expect(agentAlertService.evaluate('created', 404)).resolves.toBeUndefined();
    expect(prismaMock.agentAlertEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('agentAlertService quiet hours', () => {
  const svc = agentAlertService;
  test('daytime window: inside vs outside', () => {
    const pref = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    // Use a fixed formatter by stubbing Date via the service helper directly.
    // 02:00 local is inside a 22:00→07:00 wrap window; 12:00 is outside.
    const at = (hhmm) => {
      const orig = Intl.DateTimeFormat;
      // eslint-disable-next-line no-global-assign
      Intl.DateTimeFormat = function () { return { format: () => hhmm }; };
      const r = svc._inQuietHours(pref, 'America/Los_Angeles');
      Intl.DateTimeFormat = orig;
      return r;
    };
    expect(at('02:00')).toBe(true);
    expect(at('23:30')).toBe(true);
    expect(at('12:00')).toBe(false);
    expect(at('07:00')).toBe(false); // end is exclusive
  });

  test('disabled or incomplete window → never quiet', () => {
    expect(svc._inQuietHours({ quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00' })).toBe(false);
    expect(svc._inQuietHours({ quietHoursEnabled: true, quietHoursStart: null, quietHoursEnd: '07:00' })).toBe(false);
    expect(svc._inQuietHours(null)).toBe(false);
  });
});
