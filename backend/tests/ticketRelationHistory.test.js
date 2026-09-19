import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Simorgh asks 4 + 6 (19 Sep 2026). Link and parent changes wrote NO history,
 * so GET /api/v1/tickets/{id}/activities was not a complete audit; and nothing
 * on the read shape said where a merged ticket went.
 */

const tickets = new Map();
const links = [];
let nextLinkId = 1;
const activity = { create: jest.fn(async (row) => ({ id: 1, ...row })) };

const matches = (row, where) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((clause) => matches(row, clause));
  if (k === 'ticketId_relatedTicketId_kind') return matches(row, v);
  if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
  return row[k] === v;
});
const withIncludes = (row, include) => {
  if (!row || !include) return row;
  return { ...row, ...(include.relatedTicket ? { relatedTicket: tickets.get(row.relatedTicketId) } : {}), ...(include.ticket ? { ticket: tickets.get(row.ticketId) } : {}) };
};
const prismaMock = {
  ticket: {
    findFirst: jest.fn(async ({ where }) => [...tickets.values()].find((t) => matches(t, where)) || null),
    findMany: jest.fn(async ({ where }) => [...tickets.values()].filter((t) => matches(t, where))),
  },
  ticketLink: {
    findUnique: jest.fn(async ({ where }) => links.find((l) => matches(l, where)) || null),
    findFirst: jest.fn(async ({ where, include }) => withIncludes(links.filter((l) => matches(l, where)).slice(-1)[0] || null, include)),
    findMany: jest.fn(async ({ where, include }) => links.filter((l) => matches(l, where)).map((l) => withIncludes(l, include))),
    count: jest.fn(async ({ where }) => links.filter((l) => matches(l, where)).length),
    upsert: jest.fn(async ({ where, create }) => {
      const found = links.find((l) => matches(l, where));
      if (found) return found;
      const row = { id: nextLinkId++, createdAt: new Date(), ...create };
      links.push(row);
      return row;
    }),
    delete: jest.fn(async ({ where }) => { links.splice(links.findIndex((l) => l.id === where.id), 1); }),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activity }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { getInteractiveClient: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: linkService, RELATION_ACTIVITY_TYPES } = await import('../src/services/ticketLinkService.js');

const SIMORGH = { role: 'api', name: 'Simorgh', email: 'apikey:tpc_890e' };
const HUMAN = { role: 'admin', name: 'Vahid Haeri', email: 'vhaeri@bgcengineering.ca' };
const rowsFor = (ticketId) => activity.create.mock.calls.map((c) => c[0]).filter((r) => r.ticketId === ticketId);

beforeEach(() => {
  jest.clearAllMocks();
  tickets.clear(); links.length = 0; nextLinkId = 1;
  for (const [id, n] of [[1, 1601], [2, 1602], [3, 1603]]) {
    tickets.set(id, { id, workspaceId: 1, origin: 'ticketpulse', nativeNumber: n, freshserviceTicketId: null, status: 'Open', subject: `Incident ${n}` });
  }
});

describe('parent / child', () => {
  test('setting a parent writes one row on EACH ticket, from that ticket’s side, with who and what kind of actor', async () => {
    await linkService.setParent(2, 1, { parentTicketId: 1 }, SIMORGH);
    expect(rowsFor(2)).toEqual([expect.objectContaining({
      activityType: 'parent_set', performedBy: 'Simorgh',
      details: expect.objectContaining({ otherTicketId: 1, otherRef: 'TP-1601', kind: 'parent_of', actorKind: 'api', actorEmail: 'apikey:tpc_890e' }),
    })]);
    expect(rowsFor(1)).toEqual([expect.objectContaining({ activityType: 'child_added', details: expect.objectContaining({ otherTicketId: 2, otherRef: 'TP-1602' }) })]);
  });

  test('setting the SAME parent again is a no-op and leaves no row', async () => {
    await linkService.setParent(2, 1, { parentTicketId: 1 }, SIMORGH);
    activity.create.mockClear();
    await linkService.setParent(2, 1, { parentTicketId: 1 }, SIMORGH);
    expect(activity.create).not.toHaveBeenCalled();
  });

  test('re-parenting records the removal from the old parent AND the new parent', async () => {
    await linkService.setParent(3, 1, { parentTicketId: 1 }, SIMORGH);
    activity.create.mockClear();
    await linkService.setParent(3, 1, { parentTicketId: 2 }, HUMAN);
    expect(rowsFor(3).map((r) => r.activityType)).toEqual(['parent_removed', 'parent_set']);
    expect(rowsFor(1).map((r) => r.activityType)).toEqual(['child_removed']);
    expect(rowsFor(2).map((r) => r.activityType)).toEqual(['child_added']);
    expect(rowsFor(3)[0].details).toMatchObject({ replacedBy: 'TP-1602', actorKind: 'human' });
  });

  test('removing a parent records both sides', async () => {
    await linkService.setParent(2, 1, { parentTicketId: 1 }, SIMORGH);
    activity.create.mockClear();
    await linkService.removeParent(2, 1, HUMAN);
    expect(rowsFor(2)[0]).toMatchObject({ activityType: 'parent_removed', performedBy: 'Vahid Haeri' });
    expect(rowsFor(1)[0]).toMatchObject({ activityType: 'child_removed' });
  });
});

describe('links', () => {
  test('a new link records both sides with kind and direction', async () => {
    await linkService.link(1, 1, { relatedTicketId: 2, kind: 'related_to' }, SIMORGH);
    expect(rowsFor(1)[0]).toMatchObject({ activityType: 'linked', details: expect.objectContaining({ kind: 'related_to', direction: 'out', otherRef: 'TP-1602' }) });
    expect(rowsFor(2)[0]).toMatchObject({ activityType: 'linked', details: expect.objectContaining({ kind: 'related_to', direction: 'in', otherRef: 'TP-1601' }) });
  });

  test('linking what is already linked writes nothing (the upsert is idempotent, so is the history)', async () => {
    await linkService.link(1, 1, { relatedTicketId: 2, kind: 'related_to' }, SIMORGH);
    activity.create.mockClear();
    await linkService.link(1, 1, { relatedTicketId: 2, kind: 'related_to' }, SIMORGH);
    expect(activity.create).not.toHaveBeenCalled();
  });

  test('unlinking records both sides and names the actor it was given', async () => {
    const link = await linkService.link(1, 1, { relatedTicketId: 2, kind: 'duplicate_of' }, SIMORGH);
    activity.create.mockClear();
    await linkService.unlink(2, 1, link.id, HUMAN);
    expect(rowsFor(1)[0]).toMatchObject({ activityType: 'unlinked', performedBy: 'Vahid Haeri', details: expect.objectContaining({ kind: 'duplicate_of', direction: 'out' }) });
    expect(rowsFor(2)[0]).toMatchObject({ activityType: 'unlinked', details: expect.objectContaining({ direction: 'in' }) });
  });

  test('a history failure never undoes the relation', async () => {
    activity.create.mockRejectedValue(new Error('db'));
    await expect(linkService.link(1, 1, { relatedTicketId: 2, kind: 'related_to' }, SIMORGH)).resolves.toMatchObject({ kind: 'related_to' });
    expect(links).toHaveLength(1);
  });

  test('the vocabulary is exported for the guide and the OpenAPI spec', () => {
    expect(RELATION_ACTIVITY_TYPES).toEqual(['parent_set', 'parent_removed', 'child_added', 'child_removed', 'linked', 'unlinked']);
  });
});

describe('relationsSummary — a stored reference stays resolvable', () => {
  test('a merged ticket says where it went; a child names its parent; a parent counts its children', async () => {
    links.push({ id: 90, workspaceId: 1, ticketId: 3, relatedTicketId: 1, kind: 'merged_into' });
    await linkService.setParent(2, 1, { parentTicketId: 1 }, SIMORGH);
    expect(await linkService.relationsSummary(3, 1)).toEqual({ mergedInto: { id: 1, ref: 'TP-1601', status: 'Open' }, parent: null, childCount: 0 });
    expect(await linkService.relationsSummary(2, 1)).toEqual({ mergedInto: null, parent: { id: 1, ref: 'TP-1601', status: 'Open' }, childCount: 0 });
    expect(await linkService.relationsSummary(1, 1)).toEqual({ mergedInto: null, parent: null, childCount: 1 });
  });
});
