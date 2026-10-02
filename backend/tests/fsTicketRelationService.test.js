import { jest } from '@jest/globals';

// 29 Sep 2026: FreshService parent / child tickets read into Ticket Pulse, and
// the live open-children check before an FS-born parent is resolved or closed.

const links = [];
let nextLinkId = 1;
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketLink: {
    findMany: jest.fn(async ({ where }) => links.filter((l) => l.ticketId === where.ticketId && l.kind === where.kind && (!where.createdBy || l.createdBy === where.createdBy))),
    findFirst: jest.fn(async ({ where }) => links.find((l) => l.relatedTicketId === where.relatedTicketId && l.kind === where.kind && (!where.createdBy || l.createdBy === where.createdBy)) || null),
    delete: jest.fn(async ({ where }) => { const i = links.findIndex((l) => l.id === where.id); if (i >= 0) links.splice(i, 1); }),
    upsert: jest.fn(async ({ create }) => { const row = { id: nextLinkId++, ...create }; links.push(row); return row; }),
  },
};
const assertNoOpenChildren = jest.fn();
const recomputeReadiness = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({ default: { assertNoOpenChildren, recomputeReadiness } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { getInteractiveClient: jest.fn() } }));
const markGoneInFreshService = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { markGoneInFreshService } }));

const svc = await import('../src/services/fsTicketRelationService.js');

const parentReply = {
  data: {
    ticket: {
      id: 241813,
      related_tickets: {
        child_ids: [241814, 241815, 241818, 299999],
        child_tickets_details: [
          { id: 241814, subject: 'Laptop', status: 'Open', agent: 'alo@x.io' },
          { id: 241815, subject: 'Phone', status: 'Pending', agent: 'm@x.io' },
          { id: 241818, subject: 'Decommission', status: 'Closed', agent: 'm@x.io' },
          { id: 299999, subject: 'Elsewhere', status: 'Resolved', agent: null },
        ],
      },
    },
  },
};
// TP ids: parent 44395, children 44390 / 44391 / 44394; #299999 is not in TP.
const tpIds = { 241813: 44395, 241814: 44390, 241815: 44391, 241818: 44394 };

beforeEach(() => {
  jest.clearAllMocks();
  links.length = 0;
  nextLinkId = 1;
  svc._resetRelationCache();
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 44395, origin: 'freshservice', freshserviceTicketId: BigInt(241813) });
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => where.freshserviceTicketId.in
    .map((b) => Number(b)).filter((fs) => tpIds[fs]).map((fs) => ({ id: tpIds[fs], freshserviceTicketId: BigInt(fs) })));
});

test('fetchFsRelations reads child ids + details, and a parent id', async () => {
  const client = { _get: jest.fn().mockResolvedValueOnce(parentReply).mockResolvedValueOnce({ data: { ticket: { related_tickets: { parent_id: 241813 } } } }) };
  const parent = await svc.fetchFsRelations(client, 241813);
  expect(client._get).toHaveBeenCalledWith('/tickets/241813?include=related_tickets');
  expect(parent.parentFsId).toBeNull();
  expect(parent.children.map((c) => [c.fsId, c.status])).toEqual([[241814, 'Open'], [241815, 'Pending'], [241818, 'Closed'], [299999, 'Resolved']]);
  const child = await svc.fetchFsRelations(client, 241818);
  expect(child).toEqual({ deleted: false, spam: false, parentFsId: 241813, children: [] });
});

test('sync links the children TP has, lists the one it does not, and marks them as FreshService links', async () => {
  const client = { _get: jest.fn().mockResolvedValue(parentReply) };
  const out = await svc.syncFsRelations(44395, 1, { client });
  expect(links.map((l) => [l.ticketId, l.relatedTicketId, l.createdBy])).toEqual([
    [44395, 44390, 'freshservice'], [44395, 44391, 'freshservice'], [44395, 44394, 'freshservice'],
  ]);
  expect(out.externalChildren.map((c) => c.fsId)).toEqual([299999]);
  expect(recomputeReadiness).toHaveBeenCalledWith(44395, 1);
});

test('a second load within minutes does not ask FreshService again', async () => {
  const client = { _get: jest.fn().mockResolvedValue(parentReply) };
  await svc.syncFsRelations(44395, 1, { client });
  await svc.syncFsRelations(44395, 1, { client });
  expect(client._get).toHaveBeenCalledTimes(1);
});

test('a child dropped in FreshService loses its FreshService link; a Ticket Pulse link stays', async () => {
  links.push({ id: 90, workspaceId: 1, ticketId: 44395, relatedTicketId: 50000, kind: 'parent_of', createdBy: 'freshservice' });
  links.push({ id: 91, workspaceId: 1, ticketId: 44395, relatedTicketId: 50001, kind: 'parent_of', createdBy: 'agent@x.io' });
  nextLinkId = 100;
  const client = { _get: jest.fn().mockResolvedValue(parentReply) };
  await svc.syncFsRelations(44395, 1, { client });
  expect(links.find((l) => l.id === 90)).toBeUndefined();
  expect(links.find((l) => l.id === 91)).toBeDefined();
});

test('a parent an agent set in Ticket Pulse is not replaced by FreshService', async () => {
  links.push({ id: 5, workspaceId: 1, ticketId: 70000, relatedTicketId: 44390, kind: 'parent_of', createdBy: 'agent@x.io' });
  nextLinkId = 100;
  const client = { _get: jest.fn().mockResolvedValue(parentReply) };
  await svc.syncFsRelations(44395, 1, { client });
  expect(links.filter((l) => l.relatedTicketId === 44390).map((l) => l.ticketId)).toEqual([70000]);
});

test('TP-born tickets are skipped', async () => {
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 5, origin: 'ticketpulse', freshserviceTicketId: BigInt(1) });
  const client = { _get: jest.fn() };
  expect(await svc.syncFsRelations(5, 1, { client })).toBeNull();
  expect(client._get).not.toHaveBeenCalled();
});

describe('assertNoOpenFsChildren', () => {
  test('open FreshService children refuse the close, naming each with its status', async () => {
    const client = { _get: jest.fn().mockResolvedValue(parentReply) };
    await expect(svc.assertNoOpenFsChildren({ id: 44395 }, 1, client))
      .rejects.toMatchObject({ code: 'open_children', message: expect.stringContaining('#241814 (Open), #241815 (Pending)') });
  });

  test('always asks FreshService live, even right after a cached load', async () => {
    const client = { _get: jest.fn().mockResolvedValue(parentReply) };
    await svc.syncFsRelations(44395, 1, { client });
    await svc.assertNoOpenFsChildren({ id: 44395 }, 1, client).catch(() => {});
    expect(client._get).toHaveBeenCalledTimes(2);
  });

  test('all children closed or resolved: no refusal', async () => {
    const closed = { data: { ticket: { related_tickets: { child_ids: [241818], child_tickets_details: [{ id: 241818, status: 'Closed' }] } } } };
    const client = { _get: jest.fn().mockResolvedValue(closed) };
    await expect(svc.assertNoOpenFsChildren({ id: 44395 }, 1, client)).resolves.toBeUndefined();
  });

  test('FreshService unreachable: falls back to the links Ticket Pulse already has', async () => {
    const client = { _get: jest.fn().mockRejectedValue(new Error('FS 503')) };
    await svc.assertNoOpenFsChildren({ id: 44395 }, 1, client);
    expect(assertNoOpenChildren).toHaveBeenCalledWith(44395, 1);
  });
});

// 2 Oct 2026: tickets trashed in FreshService lingered up to an hour; opening
// one now marks it straight away from the same read.
describe('opening a ticket FreshService has trashed', () => {
  test('deleted in FreshService → marked deleted in Ticket Pulse', async () => {
    svc._resetRelationCache();
    markGoneInFreshService.mockClear();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 6369, origin: 'freshservice', freshserviceTicketId: 184319n });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    const client = { _get: jest.fn().mockResolvedValue({ data: { ticket: { deleted: true, related_tickets: {} } } }) };
    await svc.syncFsRelations(6369, 1, { client, force: true });
    expect(markGoneInFreshService).toHaveBeenCalledWith(6369, 1, { spam: false });
  });

  test('a live ticket is left alone', async () => {
    svc._resetRelationCache();
    markGoneInFreshService.mockClear();
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 6370, origin: 'freshservice', freshserviceTicketId: 184320n });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    const client = { _get: jest.fn().mockResolvedValue({ data: { ticket: { deleted: false, related_tickets: {} } } }) };
    await svc.syncFsRelations(6370, 1, { client, force: true });
    expect(markGoneInFreshService).not.toHaveBeenCalled();
  });
});
