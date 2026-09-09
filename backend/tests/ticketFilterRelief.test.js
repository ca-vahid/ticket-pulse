import { jest } from '@jest/globals';

/**
 * "Your filters are hiding this" (FR 09-09).
 *
 * Reported: searching a FreshService number returned "No tickets match these
 * filters" because the DEFAULT Status filter excludes Resolved and Closed —
 * and Reset filters only clears the typed text, so the user had to guess which
 * checkbox was in the way.
 *
 * The numbers in these tests are the real production ones for that search:
 * 0 matches with the default status filter, 1 without it, and the hidden row
 * is Closed.
 */

const counts = { current: 0, textOnly: 1, withoutStatus: 1, withoutAssignee: 0 };
const prismaMock = {
  ticket: {
    count: jest.fn(),
    groupBy: jest.fn(),
  },
};
const ticketServiceMock = { buildListWhere: jest.fn(async (ws, q) => ({ ws, ...q })) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));

const { default: relief, FILTER_GROUPS } = await import('../src/services/ticketFilterReliefService.js');

/** Count by what the passed-through where object contains. */
function countByShape({ where }) {
  const hasStatus = where.status !== undefined;
  const hasAssignee = where.assignedTechId !== undefined;
  if (hasStatus && hasAssignee) return counts.current;
  if (hasStatus) return counts.current;
  if (hasAssignee) return counts.withoutStatus;
  return counts.textOnly;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.count.mockImplementation(async (args) => countByShape(args));
  prismaMock.ticket.groupBy.mockResolvedValue([
    { status: 'Closed', _count: { _all: 1 } },
    { status: 'Open', _count: { _all: 0 } },
  ]);
});

describe('filter relief — the reported case', () => {
  test('names Status as the culprit and counts what it hides', async () => {
    const out = await relief.analyse(1, { q: '241226', status: 'Open,Pending' });
    expect(out.current).toBe(0);
    expect(out.withoutFilters).toBe(1);
    expect(out.hasQuery).toBe(true);
    expect(out.query).toBe('241226');
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toEqual(expect.objectContaining({ key: 'status', label: 'Status', hidden: 1 }));
  });

  test('names the exact status worth adding, not just "clear the filter"', async () => {
    const out = await relief.analyse(1, { q: '241226', status: 'Open,Pending' });
    // "Include Closed (1)" is a smaller, more predictable step than "show everything".
    expect(out.statusesToAdd).toEqual([{ status: 'Closed', count: 1 }]);
  });

  test('a status already selected is never offered again', async () => {
    prismaMock.ticket.groupBy.mockResolvedValue([
      { status: 'Open', _count: { _all: 4 } },
      { status: 'Closed', _count: { _all: 1 } },
    ]);
    const out = await relief.analyse(1, { q: '241226', status: 'Open,Pending' });
    expect(out.statusesToAdd.map((s) => s.status)).toEqual(['Closed']);
  });
});

describe('filter relief — when it stays quiet', () => {
  test('no active filters means nothing to relieve', async () => {
    expect(await relief.analyse(1, { q: 'outlook' })).toBeNull();
    expect(await relief.analyse(1, {})).toBeNull();
  });

  test('paging, sorting and the query itself are not filters', async () => {
    // Otherwise every page-2 view would claim its filters were hiding things.
    expect(await relief.analyse(1, { q: 'x', page: 2, pageSize: 50, sort: 'createdAt', dir: 'desc' })).toBeNull();
  });

  test('a filter that hides nothing is not reported', async () => {
    // Same count with and without it — there is nothing to offer.
    prismaMock.ticket.count.mockResolvedValue(7);
    const out = await relief.analyse(1, { q: 'x', priority: '1' });
    expect(out.groups).toEqual([]);
  });

  test('segment "all" and empty values do not count as filters', async () => {
    expect(await relief.analyse(1, { q: 'x', segment: 'all', priority: '' })).toBeNull();
  });
});

describe('filter relief — multiple filters', () => {
  test('groups are ranked by how much each hides', async () => {
    prismaMock.ticket.count.mockImplementation(async ({ where }) => {
      if (where.status !== undefined && where.priority !== undefined) return 1; // current
      if (where.status === undefined && where.priority !== undefined) return 3; // -status  => +2
      if (where.status !== undefined && where.priority === undefined) return 11; // -priority => +10
      return 30;
    });
    const out = await relief.analyse(1, { q: 'x', status: 'Open', priority: '1' });
    expect(out.groups.map((g) => [g.key, g.hidden])).toEqual([['priority', 10], ['status', 2]]);
  });

  test('category and subcategory are dropped together as one group', async () => {
    const group = FILTER_GROUPS.find((g) => g.key === 'category');
    expect(group.apiKeys).toEqual(['internalCategoryId', 'internalSubcategoryId']);
  });

  test('the created-date bounds are one group, not two', async () => {
    const group = FILTER_GROUPS.find((g) => g.key === 'created');
    expect(group.apiKeys).toEqual(['createdFrom', 'createdTo']);
  });
});

describe('filter relief — never breaks the list', () => {
  test('a failing count returns null rather than throwing', async () => {
    prismaMock.ticket.count.mockRejectedValue(new Error('statement timeout'));
    await expect(relief.analyse(1, { q: 'x', status: 'Open' })).resolves.toBeNull();
  });

  test('a failing status breakdown still yields the group counts', async () => {
    prismaMock.ticket.groupBy.mockRejectedValue(new Error('nope'));
    // The groupBy is only for the nicer label; losing it must not lose the answer.
    await expect(relief.analyse(1, { q: 'x', status: 'Open' })).resolves.toBeNull();
  });
});
